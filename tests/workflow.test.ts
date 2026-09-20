import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db/db.js';
import { createWorld, makeBudget, makeActivity, type World } from './helpers/world.js';
import * as Requests from '../src/services/requests.js';
import * as Vouchers from '../src/services/vouchers.js';
import { getBudgetBalance, getActivityBalance, drillDown } from '../src/services/ledger.js';
import { verifyApprovalChain } from '../src/services/approvals.js';
import { AppError } from '../src/domain/errors.js';
import { yuanToCents } from '../src/domain/money.js';
import { startPayWorker, startSubmitWorker } from './helpers/payWorker.js';

let db: DB;
let dbFile: string;
let w: World;
let budget: any;
let activity: any;

function expectError(fn: () => unknown, code?: string) {
  try {
    fn();
    throw new Error('预期抛错但未抛错');
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    if (code) expect((e as AppError).code).toBe(code);
  }
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'fin-'));
  dbFile = join(dir, 'test.sqlite');
  db = openDb(dbFile);
  w = createWorld(db);
  budget = makeBudget(w, w.clubA, w.term, 1000);
  activity = makeActivity(w, budget, '科技节展台', 800);
});

function fullFlow(amountYuan = 100) {
  const draft = Requests.createDraft(db, {
    activityId: activity.id,
    actor: w.leaderA,
    title: '展台材料',
    amountCents: yuanToCents(String(amountYuan)),
  });
  Requests.submit(db, draft.id, w.leaderA);
  Requests.advisorReview(db, draft.id, w.advisorA, 'approve', '活动真实');
  return draft;
}

describe('角色与权限', () => {
  it('学生负责人只能提交本社团草稿', () => {
    // 其他社团负责人不能提交
    expectError(
      () =>
        Requests.createDraft(db, {
          activityId: activity.id,
          actor: w.leaderB,
          title: '混进来的申请',
          amountCents: 100,
        }),
      'FORBIDDEN',
    );
    // 指导老师/财务不能替学生起草
    expectError(
      () =>
        Requests.createDraft(db, {
          activityId: activity.id,
          actor: w.finance,
          title: '财务起草',
          amountCents: 100,
        }),
      'FORBIDDEN',
    );
  });

  it('只有本社团指导老师能确认真实性，财务无权审核', () => {
    const draft = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '待审', amountCents: 2000 });
    Requests.submit(db, draft.id, w.leaderA);
    expectError(() => Requests.advisorReview(db, draft.id, w.finance, 'approve'), 'FORBIDDEN');
    // 外社团指导老师也不行
    db.prepare("INSERT INTO users (id,name,role,club_id,created_at) VALUES ('u_advb','外社指导','advisor',?,?)")
      .run(w.clubB.id, new Date().toISOString());
    expectError(
      () => Requests.advisorReview(db, draft.id, { id: 'u_advb', role: 'advisor' }, 'approve'),
      'FORBIDDEN',
    );
    // 本社团指导老师通过
    Requests.advisorReview(db, draft.id, w.advisorA, 'approve');
    expect(Requests.getRequest(db, draft.id).status).toBe('approved');
  });

  it('申请人不能审批自己的支出；非财务不能批准支付', () => {
    // 构造申请人即指导老师本人的申请（直接改库模拟历史数据）
    const own = Requests.createDraft(db, {
      activityId: activity.id,
      actor: w.leaderA,
      title: '老师自己的支出',
      amountCents: 100,
    });
    db.prepare('UPDATE requests SET applicant_id = ? WHERE id = ?').run(w.advisorA.id, own.id);
    db.prepare("UPDATE requests SET status = 'submitted', submitted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), own.id);
    expectError(() => Requests.advisorReview(db, own.id, w.advisorA, 'approve'), 'FORBIDDEN');

    // 非 finance 不能支付
    const d = fullFlow(80);
    expectError(() => Requests.financePay(db, d.id, w.leaderA, { eventId: 'e1' }), 'FORBIDDEN');
    expectError(() => Requests.financePay(db, d.id, w.advisorA, { eventId: 'e2' }), 'FORBIDDEN');
    // 财务本人若是申请人也不能支付
    db.prepare('UPDATE requests SET applicant_id = ? WHERE id = ?').run(w.finance.id, d.id);
    expectError(() => Requests.financePay(db, d.id, w.finance, { eventId: 'e3' }), 'FORBIDDEN');
  });
});

describe('占用 / 支付 / 退回分桶', () => {
  it('提交占用、支付转支出、退款恢复余额，三桶金额分别正确', () => {
    const draft = fullFlow(300);
    let b = getBudgetBalance(db, budget.id);
    expect(b.reservedCents).toBe(30000);
    expect(b.paidCents).toBe(0);
    expect(b.availableCents).toBe(100000 - 30000);

    Requests.financePay(db, draft.id, w.finance, { eventId: 'evt-pay-1' });
    b = getBudgetBalance(db, budget.id);
    expect(b.reservedCents).toBe(0);
    expect(b.paidCents).toBe(30000);
    expect(b.spentCents).toBe(30000);
    expect(b.availableCents).toBe(70000);

    // 活动取消 -> 退款
    Requests.cancelActivity(db, activity.id, w.advisorA, '科技节取消');
    Requests.requestRefund(db, draft.id, w.leaderA, { amountCents: 10000, reason: '部分材料可退' });
    const r2 = Requests.requestRefund(db, draft.id, w.finance, { amountCents: 20000, reason: '余款退回' });
    Requests.decideRefund(db, r2.id, w.finance, 'approve', { eventId: 'evt-ref-2' });
    // 第一笔还没批，余额只恢复 200
    b = getBudgetBalance(db, budget.id);
    expect(b.refundedCents).toBe(20000);
    expect(b.availableCents).toBe(90000);

    const refunds = db.prepare('SELECT * FROM refunds WHERE request_id = ? ORDER BY seq').all(draft.id) as any[];
    Requests.decideRefund(db, refunds[0].id, w.finance, 'approve', { eventId: 'evt-ref-1' });
    b = getBudgetBalance(db, budget.id);
    expect(b.refundedCents).toBe(30000);
    expect(b.spentCents).toBe(0);
    expect(b.availableCents).toBe(100000);
  });

  it('退款累计不得超过支付额', () => {
    const draft = fullFlow(100);
    Requests.financePay(db, draft.id, w.finance, { eventId: 'p' });
    Requests.requestRefund(db, draft.id, w.leaderA, { amountCents: 6000, reason: '退一' });
    expectError(
      () => Requests.requestRefund(db, draft.id, w.leaderA, { amountCents: 5000, reason: '退二超额' }),
      'REFUND_EXCEEDS_PAYMENT',
    );
  });

  it('审核驳回释放占用', () => {
    const draft = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '待驳回', amountCents: 12345 });
    Requests.submit(db, draft.id, w.leaderA);
    expect(getActivityBalance(db, activity.id).reservedCents).toBe(12345);
    Requests.advisorReview(db, draft.id, w.advisorA, 'reject', '材料不全');
    const b = getBudgetBalance(db, budget.id);
    expect(b.reservedCents).toBe(0);
    expect(b.availableCents).toBe(100000);
  });
});

describe('活动取消', () => {
  it('未支付申请自动释放占用；已支付进入退款链', () => {
    const unpaid = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '未付', amountCents: 20000 });
    Requests.submit(db, unpaid.id, w.leaderA);
    Requests.advisorReview(db, unpaid.id, w.advisorA, 'approve');

    const paid = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '已付', amountCents: 30000 });
    Requests.submit(db, paid.id, w.leaderA);
    Requests.advisorReview(db, paid.id, w.advisorA, 'approve');
    Requests.financePay(db, paid.id, w.finance, { eventId: 'pp' });

    const result = Requests.cancelActivity(db, activity.id, w.advisorA, '活动取消');
    expect(result).toEqual({ released: 1, refundDue: 1 });

    const b = getBudgetBalance(db, budget.id);
    expect(b.reservedCents).toBe(0);
    expect(b.paidCents).toBe(30000); // 已支付不抹除

    expect(Requests.getRequest(db, unpaid.id).status).toBe('released');
    expect(Requests.getRequest(db, paid.id).status).toBe('refunding');

    // 取消后不能再提交新申请
    const d3 = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '取消后', amountCents: 100 });
    expectError(() => Requests.submit(db, d3.id, w.leaderA), 'INVALID_STATE');
  });
});

describe('拆分发票与疑似重复', () => {
  it('一张发票拆分给同一申请的多行，金额守恒', () => {
    const draft = fullFlow(400);
    const res = Vouchers.createVoucher(
      db,
      { voucherNo: 'INV-001', summary: '电子元件一批', vendor: '华强电子', amountCents: 40000, createdBy: w.leaderA.id },
      [
        { requestId: draft.id, amountCents: 15000 },
        { requestId: draft.id, amountCents: 25000 },
      ],
    );
    expect(res.duplicateGroup.suspected).toBe(false);
  });

  it('分摊之和不得超过发票金额', () => {
    const draft = fullFlow(400);
    expectError(
      () =>
        Vouchers.createVoucher(
          db,
          { voucherNo: 'INV-X', summary: '超摊', amountCents: 10000, createdBy: w.leaderA.id },
          [
            { requestId: draft.id, amountCents: 6000 },
            { requestId: draft.id, amountCents: 6000 },
          ],
        ),
      'ALLOCATION_EXCEEDS_VOUCHER',
    );
  });

  it('同一张发票被两个小组引用：进入核对单而非删除；确认重复后未支付申请退回并释放占用', () => {
    // 小组一：已走到 approved
    const g1 = fullFlow(120);
    // 小组二：同社团另一负责人
    const g2 = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA2, title: '同票引用', amountCents: 12000 });
    Requests.submit(db, g2.id, w.leaderA2);
    Requests.advisorReview(db, g2.id, w.advisorA, 'approve');

    Vouchers.createVoucher(
      db,
      { voucherNo: 'INV-DUP-88', summary: '3D打印材料', vendor: '打印店', amountCents: 12000, createdBy: w.leaderA.id },
      [{ requestId: g1.id, amountCents: 12000 }],
    );
    const r2 = Vouchers.createVoucher(
      db,
      { voucherNo: 'inv dup 88', summary: '3D 打印 材料', vendor: '打印店', amountCents: 12000, createdBy: w.leaderA2.id },
      [{ requestId: g2.id, amountCents: 12000 }],
    );
    expect(r2.duplicateGroup.suspected).toBe(true);

    const groups = Vouchers.listDuplicateGroups(db, 'open');
    expect(groups).toHaveLength(1);
    expect(groups[0].allocations).toHaveLength(2);

    // 疑似未核对前不能支付
    expectError(() => Requests.financePay(db, g1.id, w.finance, { eventId: 'e-g1' }), 'INVALID_STATE');

    const before = getBudgetBalance(db, budget.id);
    Vouchers.resolveDuplicateGroup(db, groups[0].id, {
      resolution: 'confirmed',
      resolvedBy: w.finance.id,
      note: '两小组重复报销同一张发票',
    });
    const after = getBudgetBalance(db, budget.id);
    // 两笔 approved 各占 120，确认后都释放
    expect(after.reservedCents - before.reservedCents).toBe(-24000);
    expect(Requests.getRequest(db, g1.id).status).toBe('returned');
    expect(Requests.getRequest(db, g2.id).status).toBe('returned');

    // 退回的申请修改后可以重新提交：先摘掉误挂发票、换新凭证，避免再次成组
    const badAlloc = Requests.getRequest(db, g1.id).vouchers[0].allocation_id;
    Vouchers.removeAllocation(db, badAlloc);
    Vouchers.createVoucher(
      db,
      { voucherNo: 'INV-NEW-1', summary: '甲组自有材料', amountCents: 5000, createdBy: w.leaderA.id },
      [{ requestId: g1.id, amountCents: 5000 }],
    );
    expect(Vouchers.listDuplicateGroups(db, 'open')).toHaveLength(0);
    Requests.editDraft(db, g1.id, w.leaderA, { amountCents: 5000 });
    Requests.submit(db, g1.id, w.leaderA);
    Requests.advisorReview(db, g1.id, w.advisorA, 'approve');
    expect(Requests.financePay(db, g1.id, w.finance, { eventId: 'e-g1-new' }).idempotent).toBe(false);
    // 原始重复发票仍然留档，没有被删除
    const kept = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE fingerprint LIKE ?').get('INVDUP88#%') as any;
    expect(kept.n).toBe(2);
  });

  it('核对为误报（cleared）时申请照常支付', () => {
    const g1 = fullFlow(90);
    const g2 = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA2, title: '另一组', amountCents: 9000 });
    Requests.submit(db, g2.id, w.leaderA2);
    Requests.advisorReview(db, g2.id, w.advisorA, 'approve');
    Vouchers.createVoucher(db, { voucherNo: 'SAME-NO', summary: '纸张', amountCents: 9000, createdBy: w.leaderA.id }, [{ requestId: g1.id, amountCents: 9000 }]);
    const r = Vouchers.createVoucher(db, { voucherNo: 'SAME-NO', summary: '纸张', amountCents: 9000, createdBy: w.leaderA2.id }, [{ requestId: g2.id, amountCents: 9000 }]);
    Vouchers.resolveDuplicateGroup(db, r.duplicateGroup.groupId!, { resolution: 'cleared', resolvedBy: w.finance.id, note: '连号两本各开一张' });
    expect(Requests.financePay(db, g1.id, w.finance, { eventId: 'ok1' }).idempotent).toBe(false);
    expect(Requests.financePay(db, g2.id, w.finance, { eventId: 'ok2' }).idempotent).toBe(false);
  });
});

describe('并发审批防超额', () => {
  it('并发提交占用总额不得超过活动额度', () => {
    // 活动额度 300，两笔 200 并发提交，只允许一笔
    const a = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '甲', amountCents: 20000 });
    const b = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA2, title: '乙', amountCents: 20000 });
    // 额度调小到 300
    db.prepare('UPDATE activities SET quota_cents = 30000 WHERE id = ?').run(activity.id);

    const results = [a.id, b.id].map((rid) => {
      try {
        Requests.submit(db, rid, rid === a.id ? w.leaderA : w.leaderA2);
        return 'ok';
      } catch (e) {
        return (e as AppError).code;
      }
    });
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results).toContain('ACTIVITY_QUOTA_EXCEEDED');
    expect(getActivityBalance(db, activity.id).reservedCents).toBe(20000);
  });

  it('跨独立连接并发提交：立即事务串行化，占用绝不超过活动额度', async () => {
    const a = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '甲', amountCents: 20000 });
    const b = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA2, title: '乙', amountCents: 20000 });
    db.prepare('UPDATE activities SET quota_cents = 30000 WHERE id = ?').run(activity.id);

    // 独立连接（另一进程）与本连接同时提交
    const workerP = startSubmitWorker(dbFile, a.id, { id: w.leaderA.id, role: 'student_leader', club_id: w.clubA.id });
    let local: any;
    try {
      Requests.submit(db, b.id, w.leaderA2);
      local = 'ok';
    } catch (e) {
      local = (e as AppError).code;
    }
    const worker = await workerP;
    const workerOutcome = worker.ok ? 'ok' : worker.code;

    expect([local, workerOutcome].filter((o) => o === 'ok')).toHaveLength(1);
    const bal = getActivityBalance(db, activity.id);
    expect(bal.reservedCents).toBe(20000);
    expect(bal.availableCents).toBe(10000);
  });

  it('真正并发（独立连接）支付同一申请：只有一个成功，绝不重复出账', async () => {
    const draft = fullFlow(100);
    // 另一个「进程」用独立连接同时支付同一个 approved 申请
    const workerPromise = startPayWorker(
      dbFile,
      draft.id,
      { id: 'u_fin', role: 'finance' },
      'evt-worker-1',
    );
    let localResult: any;
    try {
      localResult = Requests.financePay(db, draft.id, w.finance, { eventId: 'evt-local-1' });
    } catch (e) {
      localResult = { failed: (e as AppError).code };
    }
    const workerResult = await workerPromise;

    const outcomes = [workerResult, localResult].map((r) =>
      r.failed ?? (r.ok === false ? r.code : r.idempotent === false ? 'paid' : r.idempotent),
    );
    // 恰好一个 paid
    expect(outcomes.filter((o) => o === 'paid')).toHaveLength(1);
    // 另一个必然是冲突（状态已变或并发更新），绝不能再付一次
    expect(outcomes.find((o) => o !== 'paid')).toMatch(/INVALID_STATE|CONCURRENT_UPDATE/);
    expect(getBudgetBalance(db, budget.id).paidCents).toBe(10000);
  });
});

describe('重复回调幂等', () => {
  it('支付渠道重复回调不会重复出账', () => {
    const draft = fullFlow(100);
    const first = Requests.financePay(db, draft.id, w.finance, { eventId: 'cb-1' });
    expect(first.idempotent).toBe(false);
    const again = Requests.financePay(db, draft.id, w.finance, { eventId: 'cb-1' });
    expect(again.idempotent).toBe(true);
    expect(getBudgetBalance(db, budget.id).paidCents).toBe(10000);

    // 异步重复回调：登记 processed=0，业务忽略
    const cb = Requests.paymentCallback(db, 'cb-1', draft.request_no, { x: 1 });
    expect(cb.duplicate).toBe(true);
    const ignored = db.prepare('SELECT COUNT(*) AS n FROM payment_callbacks WHERE event_id = ? AND processed = 0').get('cb-1') as any;
    expect(ignored.n).toBe(1);
  });
});

describe('历史不可改写', () => {
  it('审批/分类账禁止 UPDATE 与 DELETE，哈希链可校验', () => {
    const draft = fullFlow(50);
    expect(() => db.prepare('UPDATE approvals SET comment = ? WHERE request_id = ?').run('篡改', draft.id)).toThrow();
    expect(() => db.prepare("DELETE FROM approvals WHERE request_id = ?").run(draft.id)).toThrow();
    const le = db.prepare('SELECT id FROM ledger_entries LIMIT 1').get() as any;
    expect(() => db.prepare('UPDATE ledger_entries SET reserve_delta = 1 WHERE id = ?').run(le.id)).toThrow();
    expect(() => db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(le.id)).toThrow();
    expect(verifyApprovalChain(db).ok).toBe(true);
  });
});

describe('余额下钻', () => {
  it('任一余额都能追溯到申请、凭证、退款与流水', () => {
    const draft = fullLoad(db, w, activity);
    Requests.financePay(db, draft.id, w.finance, { eventId: 'drill-pay' });
    Requests.cancelActivity(db, activity.id, w.finance, '取消');
    const rf = Requests.requestRefund(db, draft.id, w.leaderA, { amountCents: 7777, reason: '部分退款' });
    Requests.decideRefund(db, rf.id, w.finance, 'approve', { eventId: 'drill-ref' });

    const d = drillDown(db, budget.id);
    expect(d.balance.paidCents).toBe(50000);
    expect(d.balance.refundedCents).toBe(7777);
    const req = d.requests.find((r: any) => r.id === draft.id)!;
    expect(req.vouchers).toHaveLength(2);
    expect(req.refunds).toHaveLength(1);
    expect(req.payment.event_id).toBe('drill-pay');
    // 流水类型完整：reserve/pay/refund
    const types = new Set(d.ledger.map((l: any) => l.entry_type));
    expect(types).toEqual(new Set(['reserve', 'pay', 'refund']));
  });
});

function fullLoad(_db: DB, _w: World, _act: any) {
  const draft = Requests.createDraft(db, { activityId: activity.id, actor: w.leaderA, title: '可追溯申请', amountCents: 50000 });
  Requests.submit(db, draft.id, w.leaderA);
  Requests.advisorReview(db, draft.id, w.advisorA, 'approve');
  Vouchers.createVoucher(db, { voucherNo: 'D-1', summary: '主板', amountCents: 30000, createdBy: w.leaderA.id }, [{ requestId: draft.id, amountCents: 30000 }]);
  Vouchers.createVoucher(db, { voucherNo: 'D-2', summary: '线材', amountCents: 20000, createdBy: w.leaderA.id }, [{ requestId: draft.id, amountCents: 20000 }]);
  return draft;
}
