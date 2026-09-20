import type { DB } from '../db/db.js';
import { id, nowIso, withTransaction } from '../db/db.js';
import { Errors } from '../domain/errors.js';
import {
  appendApproval,
  listApprovals,
} from './approvals.js';
import {
  appendLedger,
  getActivityBalance,
  getBudgetBalance,
} from './ledger.js';
import { getActivityContext } from './catalog.js';

interface Actor {
  id: string;
  role: 'student_leader' | 'advisor' | 'finance';
  clubId?: string | null;
}

/** 兼容直接传入的数据库用户行（club_id 蛇形命名） */
function actorClubId(actor: Actor | { club_id?: string | null }): string | null | undefined {
  const a = actor as Actor & { club_id?: string | null };
  return a.clubId ?? a.club_id ?? null;
}

function assert(cond: unknown, code: string, msg: string): asserts cond {
  if (!cond) throw Errors.conflict(code, msg);
}

function genRequestNo(db: DB): string {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE strftime('%Y-%m', created_at) = ?")
    .get(new Date().toISOString().slice(0, 7)) as { n: number };
  return `REQ-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(row.n + 1).padStart(4, '0')}`;
}

/** 学生负责人只能为本社团创建草稿 */
export function createDraft(
  db: DB,
  input: { activityId: string; actor: Actor; title: string; amountCents: number },
) {
  const ctx = getActivityContext(db, input.activityId);
  if (input.actor.role !== 'student_leader') {
    throw Errors.forbidden('只有学生负责人可以提交预支申请草稿');
  }
  if (actorClubId(input.actor) !== ctx.club_id) {
    throw Errors.forbidden('学生负责人只能提交本社团的申请');
  }
  if (input.amountCents <= 0) throw Errors.validation('申请金额必须为正');

  const requestId = id('req');
  const requestNo = genRequestNo(db);
  db.prepare(
    `INSERT INTO requests
     (id, request_no, activity_id, applicant_id, title, amount_cents, status, version, created_at)
     VALUES (?,?,?,?,?,?,'draft',0,?)`,
  ).run(requestId, requestNo, input.activityId, input.actor.id, input.title, input.amountCents, nowIso());
  appendApproval(db, {
    requestId,
    action: 'create_draft',
    actorId: input.actor.id,
  });
  return getRequest(db, requestId);
}

/** 草稿或被退回的申请可以修改金额 */
export function editDraft(
  db: DB,
  requestId: string,
  actor: Actor,
  patch: { title?: string; amountCents?: number },
) {
  const req = getRequestRow(db, requestId);
  if (req.applicant_id !== actor.id) throw Errors.forbidden('只能修改自己的申请');
  if (!['draft', 'returned'].includes(req.status)) {
    throw Errors.state('只有草稿或被退回的申请可以修改');
  }
  if (patch.amountCents !== undefined && patch.amountCents <= 0) {
    throw Errors.validation('申请金额必须为正');
  }
  db.prepare('UPDATE requests SET title = COALESCE(?, title), amount_cents = COALESCE(?, amount_cents) WHERE id = ?')
    .run(patch.title ?? null, patch.amountCents ?? null, requestId);
  return getRequest(db, requestId);
}

/**
 * 提交申请：占用活动额度与学期预算。
 * 立即事务 + 实时余额校验，并发提交不会超额占用。
 */
export function submit(db: DB, requestId: string, actor: Actor, comment?: string) {
  return withTransaction(db, () => {
    const req = getRequestRow(db, requestId);
    if (req.applicant_id !== actor.id) throw Errors.forbidden('只能提交自己的申请');
    if (!['draft', 'returned'].includes(req.status)) {
      throw Errors.state(`申请当前状态为 ${req.status}，不能提交`);
    }
    const ctx = getActivityContext(db, req.activity_id);
    if (ctx.status === 'cancelled') throw Errors.state('活动已取消，不能提交申请');

    const actBal = getActivityBalance(db, req.activity_id);
    assert(
      actBal.availableCents >= req.amount_cents,
      'ACTIVITY_QUOTA_EXCEEDED',
      `活动额度不足：可用 ${actBal.availableCents} 分，申请 ${req.amount_cents} 分`,
    );
    const budBal = getBudgetBalance(db, ctx.budget_id);
    assert(
      budBal.availableCents >= req.amount_cents,
      'BUDGET_EXCEEDED',
      `学期预算不足：可用 ${budBal.availableCents} 分，申请 ${req.amount_cents} 分`,
    );

    const ok = appendLedger(db, {
      budgetId: ctx.budget_id,
      activityId: req.activity_id,
      requestId: req.id,
      entryType: 'reserve',
      reserveDelta: req.amount_cents,
      idempotencyKey: `reserve:${req.id}:v${req.version}`,
      refLabel: `${req.request_no} 提交占用`,
    });
    assert(ok, 'ALREADY_RESERVED', '该申请已完成占用，请勿重复提交');

    db.prepare(
      `UPDATE requests SET status = 'submitted', submitted_at = ?, version = version + 1 WHERE id = ?`,
    ).run(nowIso(), requestId);
    appendApproval(db, { requestId, action: 'submit', actorId: actor.id, comment });
    return getRequest(db, requestId);
  });
}

/** 指导老师确认活动真实性（不能审批自己的支出） */
export function advisorReview(
  db: DB,
  requestId: string,
  actor: Actor,
  decision: 'approve' | 'reject',
  comment?: string,
) {
  return withTransaction(db, () => {
    const req = getRequestRow(db, requestId);
    const ctx = getActivityContext(db, req.activity_id);
    if (actor.role !== 'advisor' || actor.id !== ctx.advisor_user_id) {
      throw Errors.forbidden('只有该社团的指导老师可以审核活动真实性');
    }
    if (req.applicant_id === actor.id) {
      throw Errors.forbidden('申请人不能审批自己的支出');
    }
    if (req.status !== 'submitted') {
      throw Errors.state(`申请当前状态为 ${req.status}，不能审核`);
    }

    if (decision === 'reject') {
      db.prepare("UPDATE requests SET status = 'rejected', version = version + 1 WHERE id = ?").run(requestId);
      appendLedger(db, {
        budgetId: ctx.budget_id,
        activityId: req.activity_id,
        requestId: req.id,
        entryType: 'release',
        reserveDelta: -req.amount_cents,
        idempotencyKey: `release:reject:${req.id}`,
        refLabel: `${req.request_no} 审核驳回释放`,
      });
      appendApproval(db, { requestId, action: 'advisor_reject', actorId: actor.id, comment });
    } else {
      db.prepare("UPDATE requests SET status = 'approved', version = version + 1 WHERE id = ?").run(requestId);
      appendApproval(db, { requestId, action: 'advisor_approve', actorId: actor.id, comment });
    }
    return getRequest(db, requestId);
  });
}

/**
 * 财务批准支付：
 *  - 仅 finance 角色；审批人不得是申请人；
 *  - 支付前再次校验活动额度/预算（advisor 与 finance 之间可能有其他支付发生）；
 *  - 疑似重复凭证未核对清楚前不得付款；
 *  - 乐观锁 + 立即事务，并发支付只有一个成功，且不会超额；
 *  - event_id 幂等：支付渠道重复回调不会重复出账。
 */
export function financePay(
  db: DB,
  requestId: string,
  actor: Actor,
  opts: { eventId: string; comment?: string; external?: boolean },
) {
  if (actor.role !== 'finance') throw Errors.forbidden('只有财务人员可以批准支付');

  return withTransaction(db, () => {
    // 已处理过的事件号幂等返回；processed=0 的早到回调不阻止正式支付
    const cb = db
      .prepare('SELECT processed FROM payment_callbacks WHERE event_id = ? AND processed = 1 LIMIT 1')
      .get(opts.eventId) as { processed: number } | undefined;
    if (cb) {
      return { idempotent: true as const, request: getRequest(db, requestId), processed: true };
    }

    const req = getRequestRow(db, requestId);
    if (req.applicant_id === actor.id) {
      throw Errors.forbidden('申请人不能审批自己的支出');
    }
    if (req.status !== 'approved') {
      throw Errors.state(`申请当前状态为 ${req.status}，只有已通过指导老师审核的申请才能支付`);
    }
    const ctx = getActivityContext(db, req.activity_id);

    const suspected = db
      .prepare(
        `SELECT COUNT(*) AS n FROM voucher_allocations
         WHERE request_id = ? AND dup_status = 'suspected'`,
      )
      .get(requestId) as { n: number };
    if (suspected.n > 0) {
      throw Errors.state('存在尚未核对清楚的疑似重复凭证，暂不能支付');
    }

    const actBal = getActivityBalance(db, req.activity_id);
    assert(
      actBal.availableCents + actBal.reservedCents >= req.amount_cents,
      'ACTIVITY_QUOTA_EXCEEDED',
      '支付后将超过活动额度',
    );
    const budBal = getBudgetBalance(db, ctx.budget_id);
    assert(
      budBal.availableCents + budBal.reservedCents >= req.amount_cents,
      'BUDGET_EXCEEDED',
      '支付后将超过学期预算',
    );

    // 乐观锁：并发第二个支付在此拿到 0 行
    const upd = db
      .prepare(
        `UPDATE requests SET status = 'paid', paid_at = ?, version = version + 1
         WHERE id = ? AND status = 'approved' AND version = ?`,
      )
      .run(nowIso(), requestId, req.version);
    assert(upd.changes === 1, 'CONCURRENT_UPDATE', '申请状态已被并发审批改变，请刷新后重试');

    const ledgerOk = appendLedger(db, {
      budgetId: ctx.budget_id,
      activityId: req.activity_id,
      requestId: req.id,
      entryType: 'pay',
      reserveDelta: -req.amount_cents, // 占用转支出
      payDelta: req.amount_cents,
      idempotencyKey: `pay:${req.id}`,
      refLabel: `${req.request_no} 支付`,
    });
    assert(ledgerOk, 'ALREADY_PAID', '该申请已支付，不能重复支付');

    db.prepare(
      `INSERT INTO payments (id, request_id, amount_cents, event_id, paid_by, paid_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(id('pay'), requestId, req.amount_cents, opts.eventId, actor.id, nowIso());

    db.prepare(
      `INSERT INTO payment_callbacks (id, event_id, request_no, payload, processed, received_at)
       VALUES (?,?,?,?,1,?)`,
    ).run(id('pcb'), opts.eventId, req.request_no, JSON.stringify({ requestId, amountCents: req.amount_cents, external: !!opts.external }), nowIso());

    appendApproval(db, { requestId, action: 'finance_pay', actorId: actor.id, comment: opts.comment });
    return { idempotent: false as const, request: getRequest(db, requestId), processed: true };
  });
}

/**
 * 支付渠道异步回调：已处理过的事件号只追加一条 processed=0 的流水，
 * 业务上直接忽略（重复回调测试核心）。
 */
export function paymentCallback(
  db: DB,
  eventId: string,
  requestNo: string,
  payload: unknown,
) {
  return withTransaction(db, () => {
    const first = db
      .prepare('SELECT id FROM payment_callbacks WHERE event_id = ? AND processed = 1 LIMIT 1')
      .get(eventId);
    db.prepare(
      `INSERT INTO payment_callbacks (id, event_id, request_no, payload, processed, received_at)
       VALUES (?,?,?,?,0,?)`,
    ).run(id('pcb'), eventId, requestNo, JSON.stringify(payload), nowIso());
    if (first) return { duplicate: true as const, firstProcessed: true };
    // 早于财务批准到达的回调：只登记留痕，不自动付款
    return { duplicate: false as const, firstProcessed: false };
  });
}

/**
 * 活动取消：
 *  - 未支付申请（submitted/approved）自动释放占用；
 *  - 已支付申请转入 refunding，已付款只能走退款链；
 *  - 草稿/驳回/退回保持原状，占用本来就为 0。
 */
export function cancelActivity(db: DB, activityId: string, actor: Actor, reason: string) {
  return withTransaction(db, () => {
    const ctx = getActivityContext(db, activityId);
    if (
      actor.role !== 'finance' &&
      !(actor.role === 'advisor' && actor.id === ctx.advisor_user_id) &&
      !(actor.role === 'student_leader' && actorClubId(actor) === ctx.club_id)
    ) {
      throw Errors.forbidden('无权取消该活动');
    }
    if (ctx.status === 'cancelled') throw Errors.state('活动已经处于取消状态');
    db.prepare("UPDATE activities SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
      .run(nowIso(), activityId);

    const pending = db
      .prepare("SELECT * FROM requests WHERE activity_id = ? AND status IN ('submitted','approved')")
      .all(activityId) as any[];
    for (const req of pending) {
      const ok = appendLedger(db, {
        budgetId: ctx.budget_id,
        activityId,
        requestId: req.id,
        entryType: 'release',
        reserveDelta: -req.amount_cents,
        idempotencyKey: `release:cancel:${req.id}`,
        refLabel: `${req.request_no} 活动取消释放占用`,
      });
      if (ok) {
        db.prepare("UPDATE requests SET status = 'released', version = version + 1 WHERE id = ?").run(req.id);
        appendApproval(db, {
          requestId: req.id,
          action: 'activity_cancelled_release',
          actorId: actor.id,
          comment: reason,
        });
      }
    }

    const paid = db
      .prepare("SELECT * FROM requests WHERE activity_id = ? AND status = 'paid'")
      .all(activityId) as any[];
    for (const req of paid) {
      db.prepare("UPDATE requests SET status = 'refunding', version = version + 1 WHERE id = ?").run(req.id);
      appendApproval(db, {
        requestId: req.id,
        action: 'activity_cancelled_refund_due',
        actorId: actor.id,
        comment: `活动取消，已付款项进入退款链：${reason}`,
      });
    }
    return { released: pending.length, refundDue: paid.length };
  });
}

/** 发起退款（申请人或财务均可发起；部分退款可多次发起，形成退款链） */
export function requestRefund(
  db: DB,
  requestId: string,
  actor: Actor,
  input: { amountCents: number; reason: string },
) {
  return withTransaction(db, () => {
    const req = getRequestRow(db, requestId);
    if (!['paid', 'refunding'].includes(req.status)) {
      throw Errors.state('只有已支付的申请可以发起退款');
    }
    if (input.amountCents <= 0) throw Errors.validation('退款金额必须为正');

    const paid = db
      .prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE request_id = ?')
      .get(requestId) as { s: number };
    const refunded = db
      .prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE request_id = ? AND status = 'approved'")
      .get(requestId) as { s: number };
    const pending = db
      .prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE request_id = ? AND status = 'requested'")
      .get(requestId) as { s: number };
    if (refunded.s + pending.s + input.amountCents > paid.s) {
      throw Errors.conflict('REFUND_EXCEEDS_PAYMENT', '累计退款（含待批）不能超过已支付金额');
    }

    const tail = db
      .prepare('SELECT id, seq FROM refunds WHERE request_id = ? ORDER BY seq DESC LIMIT 1')
      .get(requestId) as { id: string; seq: number } | undefined;
    const seq = (tail?.seq ?? 0) + 1;
    const refundId = id('rfd');
    db.prepare(
      `INSERT INTO refunds
       (id, request_id, parent_refund_id, seq, amount_cents, reason, status, requested_by, created_at)
       VALUES (?,?,?,?,?,?,'requested',?,?)`,
    ).run(refundId, requestId, tail?.id ?? null, seq, input.amountCents, input.reason, actor.id, nowIso());

    if (req.status === 'paid') {
      db.prepare("UPDATE requests SET status = 'refunding', version = version + 1 WHERE id = ?").run(requestId);
    }
    appendApproval(db, { requestId, refundId, action: 'refund_requested', actorId: actor.id, comment: input.reason });
    return getRefund(db, refundId);
  });
}

/** 财务批准/驳回退款；退款到账事件号幂等 */
export function decideRefund(
  db: DB,
  refundId: string,
  actor: Actor,
  decision: 'approve' | 'reject',
  opts: { eventId?: string; comment?: string },
) {
  if (actor.role !== 'finance') throw Errors.forbidden('只有财务人员可以批准退款');
  return withTransaction(db, () => {
    const refund = getRefund(db, refundId);
    if (refund.status !== 'requested') throw Errors.state('该退款已处理，不能重复审批');
    const req = getRequestRow(db, refund.request_id);
    if (req.applicant_id === actor.id) {
      throw Errors.forbidden('申请人不能审批自己的支出');
    }

    if (decision === 'reject') {
      db.prepare("UPDATE refunds SET status = 'rejected', approved_by = NULL, decided_at = ? WHERE id = ?")
        .run(nowIso(), refundId);
      appendApproval(db, { requestId: req.id, refundId, action: 'refund_reject', actorId: actor.id, comment: opts.comment });
      return getRefund(db, refundId);
    }

    if (opts.eventId) {
      const dup = db.prepare('SELECT 1 FROM refunds WHERE event_id = ? AND id <> ?').get(opts.eventId, refundId);
      if (dup) throw Errors.conflict('REFUND_EVENT_DUP', '退款到账事件号重复');
    }

    // 乐观锁 + 累计校验，并发批退款不会超过支付额
    const upd = db
      .prepare("UPDATE refunds SET status = 'approved', approved_by = ?, event_id = ?, decided_at = ? WHERE id = ? AND status = 'requested'")
      .run(actor.id, opts.eventId ?? null, nowIso(), refundId);
    assert(upd.changes === 1, 'CONCURRENT_UPDATE', '退款状态已被并发改变');

    const paid = db
      .prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE request_id = ?')
      .get(req.id) as { s: number };
    const refunded = db
      .prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE request_id = ? AND status = 'approved'")
      .get(req.id) as { s: number };
    if (refunded.s > paid.s) {
      throw Errors.conflict('REFUND_EXCEEDS_PAYMENT', '累计退款超过已支付金额');
    }

    const ctx = getActivityContext(db, req.activity_id);
    const ok = appendLedger(db, {
      budgetId: ctx.budget_id,
      activityId: req.activity_id,
      requestId: req.id,
      refundId,
      entryType: 'refund',
      refundDelta: refund.amount_cents,
      idempotencyKey: `refund:${refundId}`,
      refLabel: `${req.request_no} 退款#${refund.seq}`,
    });
    assert(ok, 'ALREADY_REFUNDED', '该退款已记账');

    appendApproval(db, { requestId: req.id, refundId, action: 'refund_approve', actorId: actor.id, comment: opts.comment });
    return getRefund(db, refundId);
  });
}

// ---------- 查询 ----------

function getRequestRow(db: DB, requestId: string) {
  const req = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId) as any;
  if (!req) throw Errors.notFound('申请');
  return req;
}

function getRefund(db: DB, refundId: string) {
  const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as any;
  if (!r) throw Errors.notFound('退款单');
  return r;
}

export function getRequest(db: DB, requestId: string) {
  const req = getRequestRow(db, requestId);
  const ctx = getActivityContext(db, req.activity_id);
  const sums = db
    .prepare(
      `SELECT COALESCE(SUM(reserve_delta),0) AS reserved,
              COALESCE(SUM(pay_delta),0) AS paid,
              COALESCE(SUM(refund_delta),0) AS refunded
       FROM ledger_entries WHERE request_id = ?`,
    )
    .get(requestId) as { reserved: number; paid: number; refunded: number };
  const vouchers = db
    .prepare(
      `SELECT va.id AS allocation_id, va.amount_cents AS allocated_cents, va.dup_status, va.dup_group_id,
              v.id AS voucher_id, v.voucher_no, v.summary, v.vendor, v.amount_cents AS voucher_amount_cents
       FROM voucher_allocations va JOIN vouchers v ON v.id = va.voucher_id
       WHERE va.request_id = ?`,
    )
    .all(requestId) as any[];
  const refunds = db
    .prepare('SELECT * FROM refunds WHERE request_id = ? ORDER BY seq')
    .all(requestId);
  const payment = db.prepare('SELECT * FROM payments WHERE request_id = ?').get(requestId);
  return {
    ...req,
    budgetId: ctx.budget_id,
    reservedCents: sums.reserved,
    paidCents: sums.paid,
    refundedCents: sums.refunded,
    fullyRefunded: sums.paid > 0 && sums.refunded >= sums.paid,
    vouchers,
    refunds,
    payment,
    approvals: listApprovals(db, requestId),
  };
}

export function listRequests(db: DB, filter?: { activityId?: string; status?: string; clubId?: string }) {
  const where: string[] = [];
  const params: any[] = [];
  if (filter?.activityId) { where.push('r.activity_id = ?'); params.push(filter.activityId); }
  if (filter?.status) { where.push('r.status = ?'); params.push(filter.status); }
  if (filter?.clubId) { where.push('b.club_id = ?'); params.push(filter.clubId); }
  const sql = `
    SELECT r.* FROM requests r
    JOIN activities a ON a.id = r.activity_id
    JOIN budgets b ON b.id = a.budget_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.created_at`;
  return db.prepare(sql).all(...params);
}
