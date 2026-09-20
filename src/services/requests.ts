import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import { withImmediate } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  addAllocation,
  assertVouchersPayable,
  registerVoucherForRequest,
  replaceRequestAllocations,
  requestAllocationTotal,
  type VoucherInput,
} from './vouchers.js';
import { assertCapacity, getBalances, postEntry } from './budget.js';
import { getUser, isAdvisorOf } from './org.js';

export interface RequestRow {
  id: number;
  code: string;
  club_id: number;
  semester_id: number;
  activity_id: number;
  applicant_id: number;
  title: string;
  amount_cents: number;
  status: string;
}

const STATUS = {
  draft: 'draft',
  submitted: 'submitted',
  approved: 'approved', // advisor confirmed authenticity, awaiting finance
  paid: 'paid',
  rejected: 'rejected',
  released: 'released', // reservation released (advisor/finance reject or cancel)
  refunded: 'refunded',
} as const;

function getRequest(db: DB, id: number): RequestRow {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as
    | RequestRow
    | undefined;
  if (!row) throw notFound('request');
  return row;
}

function logApproval(
  db: DB,
  requestId: number,
  action:
    | 'submit'
    | 'advisor_approve'
    | 'advisor_reject'
    | 'finance_pay'
    | 'finance_reject'
    | 'release'
    | 'refund_request'
    | 'refund_approve'
    | 'refund_reject',
  actorId: number,
  comment?: string | null,
): void {
  db.prepare(
    `INSERT INTO approvals (request_id, action, actor_id, comment) VALUES (?, ?, ?, ?)`,
  ).run(requestId, action, actorId, comment ?? null);
}

function assertNotApplicant(actorId: number, req: RequestRow): void {
  if (actorId === req.applicant_id) {
    throw forbidden(
      'E_SELF_APPROVAL',
      'the applicant cannot approve their own expenditure',
    );
  }
}

// ---------- draft lifecycle (student leaders, own club only) ----------

export function createDraft(
  db: DB,
  actorId: number,
  params: {
    activityId: number;
    title: string;
    amountCents: number;
  },
): number {
  const actor = getUser(db, actorId);
  if (actor.role !== 'student_leader') {
    throw forbidden('E_NOT_LEADER', 'only a student leader can create requests');
  }
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw badRequest('E_AMOUNT', 'amount must be positive integer cents');
  }
  const activity = db
    .prepare('SELECT * FROM activities WHERE id = ?')
    .get(params.activityId) as { club_id: number; semester_id: number; status: string } | undefined;
  if (!activity) throw notFound('activity');
  if (activity.club_id !== actor.club_id) {
    throw forbidden('E_OTHER_CLUB', 'a leader can only draft requests for their own club');
  }
  if (activity.status !== 'active') {
    throw conflict('E_ACTIVITY_INACTIVE', 'cannot create a request for a cancelled activity');
  }

  const code = `REQ-${randomUUID().slice(0, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO requests
         (code, club_id, semester_id, activity_id, applicant_id, title, amount_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
    )
    .run(
      code,
      activity.club_id,
      activity.semester_id,
      params.activityId,
      actorId,
      params.title,
      params.amountCents,
    );
  return Number(info.lastInsertRowid);
}

/** Attach evidence while drafting. A duplicate voucher is parked, never deleted. */
export function attachVoucher(
  db: DB,
  actorId: number,
  requestId: number,
  voucher: VoucherInput & { shareCents: number },
) {
  const actor = getUser(db, actorId);
  const req = getRequest(db, requestId);
  if (actor.role !== 'student_leader' || actor.club_id !== req.club_id) {
    throw forbidden('E_NOT_CLUB_LEADER', 'only a leader of the owning club can attach vouchers');
  }
  if (req.status !== STATUS.draft) {
    throw conflict('E_NOT_DRAFT', 'vouchers can only be attached while the request is a draft');
  }
  return withImmediate(db, () =>
    registerVoucherForRequest(
      db,
      { voucherNo: voucher.voucherNo, summary: voucher.summary, amountCents: voucher.amountCents },
      voucher.shareCents,
      requestId,
      actorId,
    ),
  );
}

/** Replace the whole evidence set (e.g. after a duplicate was confirmed). */
export function reworkEvidence(
  db: DB,
  actorId: number,
  requestId: number,
  items: Array<VoucherInput & { shareCents: number }>,
) {
  const actor = getUser(db, actorId);
  const req = getRequest(db, requestId);
  if (actor.role !== 'student_leader' || actor.club_id !== req.club_id) {
    throw forbidden('E_NOT_CLUB_LEADER', 'only a leader of the owning club can rework evidence');
  }
  if (![STATUS.draft, STATUS.rejected].includes(req.status as any)) {
    throw conflict(
      'E_NOT_REWORKABLE',
      'evidence can only be reworked on draft or rejected requests',
    );
  }
  if (req.status === STATUS.rejected) {
    db.prepare(`UPDATE requests SET status = 'draft' WHERE id = ?`).run(requestId);
  }
  return withImmediate(db, () => replaceRequestAllocations(db, requestId, items, actorId));
}

// ---------- submission reserves budget ----------

export function submitRequest(db: DB, actorId: number, requestId: number): void {
  const actor = getUser(db, actorId);
  withImmediate(db, () => {
    const req = getRequest(db, requestId);
    if (actor.role !== 'student_leader' || actor.club_id !== req.club_id) {
      throw forbidden('E_NOT_CLUB_LEADER', 'only the owning club leader can submit');
    }
    if (req.status !== STATUS.draft) {
      throw conflict('E_NOT_DRAFT', `cannot submit from status ${req.status}`);
    }
    const activity = db
      .prepare('SELECT status FROM activities WHERE id = ?')
      .get(req.activity_id) as { status: string };
    if (activity.status !== 'active') {
      throw conflict('E_ACTIVITY_CANCELLED', 'activity was cancelled');
    }
    const evidence = requestAllocationTotal(db, requestId);
    if (evidence !== req.amount_cents) {
      throw badRequest(
        'E_EVIDENCE_MISMATCH',
        `voucher allocations total ${evidence} must equal request amount ${req.amount_cents}`,
        { evidence_cents: evidence, request_cents: req.amount_cents },
      );
    }
    assertCapacity(
      db,
      { semesterId: req.semester_id, clubId: req.club_id, activityId: req.activity_id },
      req.amount_cents,
    );
    postEntry(
      db,
      { semesterId: req.semester_id, clubId: req.club_id, activityId: req.activity_id },
      {
        kind: 'reserve',
        reserve_cents: req.amount_cents,
        request_id: req.id,
        actor_id: actorId,
      },
    );
    db.prepare(
      `UPDATE requests SET status = 'submitted', submitted_at = datetime('now') WHERE id = ?`,
    ).run(requestId);
    logApproval(db, requestId, 'submit', actorId);
  });
}

// ---------- advisor: confirm activity authenticity ----------

export function advisorReview(
  db: DB,
  actorId: number,
  requestId: number,
  decision: 'approve' | 'reject',
  comment?: string,
): void {
  const actor = getUser(db, actorId);
  withImmediate(db, () => {
    const req = getRequest(db, requestId);
    assertNotApplicant(actorId, req);
    if (actor.role !== 'advisor' || !isAdvisorOf(db, actorId, req.club_id)) {
      throw forbidden('E_NOT_ADVISOR', 'only an advisor of this club can confirm authenticity');
    }
    if (req.status !== STATUS.submitted) {
      throw conflict('E_NOT_SUBMITTED', `cannot review from status ${req.status}`);
    }
    if (decision === 'approve') {
      db.prepare(`UPDATE requests SET status = 'approved', advisor_at = datetime('now') WHERE id = ?`).run(
        requestId,
      );
      logApproval(db, requestId, 'advisor_approve', actorId, comment);
    } else {
      releaseReservation(db, req, actorId, 'advisor_reject', comment);
    }
  });
}

function releaseReservation(
  db: DB,
  req: RequestRow,
  actorId: number,
  action: 'advisor_reject' | 'finance_reject' | 'release',
  comment?: string | null,
): void {
  postEntry(
    db,
    { semesterId: req.semester_id, clubId: req.club_id, activityId: req.activity_id },
    {
      kind: 'release',
      reserve_cents: -req.amount_cents,
      request_id: req.id,
      actor_id: actorId,
      note: action,
    },
  );
  const target = action === 'release' ? 'released' : 'rejected';
  db.prepare(`UPDATE requests SET status = ?, released_at = datetime('now') WHERE id = ?`).run(
    target,
    req.id,
  );
  logApproval(db, req.id, action, actorId, comment);
}

// ---------- finance: payment (idempotent callback) ----------

export interface PayResult {
  requestId: number;
  code: string;
  status: string;
  paid_cents: number;
}

export function financePay(
  db: DB,
  actorId: number,
  requestId: number,
  idempotencyKey?: string,
): PayResult {
  const actor = getUser(db, actorId);
  return withImmediate(db, (): PayResult => {
    // Inside the write lock: a racing duplicate callback either sees this
    // stored outcome (replay) or waits for the lock and then sees it — it can
    // never post a second payment.
    if (idempotencyKey) {
      const replay = takeReplay(db, 'pay', idempotencyKey);
      if (replay) return replay as PayResult;
    }
    const req = getRequest(db, requestId);
    // Self-approval is checked before the role test so a user wearing two
    // hats can never clear their own expenditure.
    assertNotApplicant(actorId, req);
    if (actor.role !== 'finance') {
      throw forbidden('E_NOT_FINANCE', 'only finance can approve payment');
    }
    if (req.status !== STATUS.approved) {
      throw conflict('E_NOT_APPROVED', `cannot pay from status ${req.status}`);
    }
    assertVouchersPayable(db, requestId);

    // Re-check capacity under the write lock at CLUB scope: the semester/club
    // budget is one shared pool across activities, so the net-paid guard and
    // the reservation check must not be filtered by activity.
    const b = getBalances(db, {
      semesterId: req.semester_id,
      clubId: req.club_id,
    });
    if (b.reserved_cents < req.amount_cents) {
      throw conflict(
        'E_RESERVATION_LOST',
        `reserved ${b.reserved_cents} < payable ${req.amount_cents}`,
      );
    }
    // Defence in depth (e.g. budget was reduced after approval): cumulative
    // net payment must never pass the total semester/club budget.
    if (b.budget_total_cents - b.net_paid_cents < req.amount_cents) {
      throw conflict(
        'E_BUDGET_EXCEEDED',
        `payment would exceed budget: net paid ${b.net_paid_cents} + ${req.amount_cents} > total ${b.budget_total_cents}`,
      );
    }

    const scope = { semesterId: req.semester_id, clubId: req.club_id, activityId: req.activity_id };
    postEntry(db, scope, {
      kind: 'pay',
      reserve_cents: -req.amount_cents,
      paid_cents: req.amount_cents,
      request_id: req.id,
      actor_id: actorId,
      idempotency_key: idempotencyKey ? `pay:${idempotencyKey}` : null,
    });
    db.prepare(
      `UPDATE requests SET status = 'paid', paid_at = datetime('now') WHERE id = ?`,
    ).run(requestId);
    logApproval(db, requestId, 'finance_pay', actorId);
    const result: PayResult = {
      requestId,
      code: req.code,
      status: 'paid',
      paid_cents: req.amount_cents,
    };
    if (idempotencyKey) storeReplay(db, 'pay', idempotencyKey, requestId, result);
    return result;
  });
}

export function financeReject(
  db: DB,
  actorId: number,
  requestId: number,
  comment?: string,
): void {
  const actor = getUser(db, actorId);
  withImmediate(db, () => {
    const req = getRequest(db, requestId);
    if (actor.role !== 'finance') throw forbidden('E_NOT_FINANCE', 'only finance can reject');
    assertNotApplicant(actorId, req);
    if (req.status !== STATUS.approved) {
      throw conflict('E_NOT_APPROVED', `cannot reject from status ${req.status}`);
    }
    releaseReservation(db, req, actorId, 'finance_reject', comment);
  });
}

// ---------- activity cancellation ----------
// Unpaid requests release their reservation automatically; paid ones stay
// paid and must come back through the refund chain.

export function cancelActivity(
  db: DB,
  actorId: number,
  activityId: number,
  reason?: string,
): { released: number[]; left_paid: number[] } {
  return withImmediate(db, () => {
    const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId) as
      | { status: string; club_id: number }
      | undefined;
    if (!activity) throw notFound('activity');
    if (activity.status === 'cancelled') {
      throw conflict('E_ALREADY_CANCELLED', 'activity is already cancelled');
    }
    db.prepare(
      `UPDATE activities SET status = 'cancelled', cancel_reason = ?, cancelled_at = datetime('now') WHERE id = ?`,
    ).run(reason ?? null, activityId);

    const pending = db
      .prepare(
        `SELECT * FROM requests
         WHERE activity_id = ? AND status IN ('submitted','approved')`,
      )
      .all(activityId) as RequestRow[];
    const released: number[] = [];
    for (const req of pending) {
      releaseReservation(db, req, actorId, 'release', 'activity cancelled');
      released.push(req.id);
    }
    const leftPaid = db
      .prepare(`SELECT id FROM requests WHERE activity_id = ? AND status = 'paid'`)
      .all(activityId)
      .map((r: any) => r.id as number);
    return { released, left_paid: leftPaid };
  });
}

// ---------- idempotent callback store ----------

function takeReplay(db: DB, scope: string, key: string): unknown | null {
  const row = db
    .prepare('SELECT result_json FROM idempotent_ops WHERE idempotency_key = ? AND scope = ?')
    .get(`${scope}:${key}`, scope) as { result_json: string } | undefined;
  return row ? JSON.parse(row.result_json) : null;
}

function storeReplay(db: DB, scope: string, key: string, refId: number, result: unknown): void {
  db.prepare(
    `INSERT OR IGNORE INTO idempotent_ops (idempotency_key, scope, ref_id, result_json)
     VALUES (?, ?, ?, ?)`,
  ).run(`${scope}:${key}`, scope, refId, JSON.stringify(result));
}

// ---------- reads ----------

export function getRequestView(db: DB, id: number) {
  const req = getRequest(db, id);
  const approvals = db
    .prepare(
      `SELECT a.*, u.name AS actor_name, u.role AS actor_role
       FROM approvals a JOIN users u ON u.id = a.actor_id
       WHERE a.request_id = ? ORDER BY a.id`,
    )
    .all(id);
  const vouchers = db
    .prepare(
      `SELECT v.id AS voucher_id, v.voucher_no, v.summary, v.amount_cents AS face_cents,
              v.status, va.share_cents
       FROM voucher_allocations va JOIN vouchers v ON v.id = va.voucher_id
       WHERE va.request_id = ? ORDER BY v.id`,
    )
    .all(id);
  const refunds = db
    .prepare('SELECT * FROM refunds WHERE request_id = ? ORDER BY id')
    .all(id);
  return { ...req, approvals, vouchers, refunds };
}
