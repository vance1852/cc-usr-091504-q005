import type { DB } from '../db.js';
import { withImmediate } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { postEntry } from './budget.js';
import { getUser } from './org.js';
import type { RequestRow } from './requests.js';

interface RefundRow {
  id: number;
  request_id: number;
  parent_refund_id: number | null;
  amount_cents: number;
  status: string;
  requested_by: number;
}

function paidRequest(db: DB, requestId: number): RequestRow {
  const req = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId) as
    | RequestRow
    | undefined;
  if (!req) throw notFound('request');
  if (req.status !== 'paid' && req.status !== 'refunded') {
    throw conflict('E_NOT_PAID', `only paid requests can be refunded (status ${req.status})`);
  }
  return req;
}

function approvedRefundTotal(db: DB, requestId: number, excludeRefundId?: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds
       WHERE request_id = ? AND status = 'approved' AND (@x IS NULL OR id != @x)`,
    )
    .get(requestId, { x: excludeRefundId ?? null }) as { s: number };
  return row.s;
}

/**
 * Open a refund against a paid request. Partial refunds are allowed and form
 * a chain (parent_refund_id) so every return is traceable back to the
 * payment. A student leader of the owning club (or finance) may file one.
 */
export function requestRefund(
  db: DB,
  actorId: number,
  requestId: number,
  amountCents: number,
  reason: string | undefined,
  parentRefundId?: number | null,
): number {
  const actor = getUser(db, actorId);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw badRequest('E_AMOUNT', 'refund amount must be positive integer cents');
  }
  return withImmediate(db, () => {
    const req = paidRequest(db, requestId);
    if (
      !(actor.role === 'finance' || (actor.role === 'student_leader' && actor.club_id === req.club_id))
    ) {
      throw forbidden('E_REFUND_REQUESTER', 'only the owning club leader or finance can file a refund');
    }
    if (parentRefundId != null) {
      const parent = db.prepare('SELECT * FROM refunds WHERE id = ?').get(parentRefundId) as
        | RefundRow
        | undefined;
      if (!parent || parent.request_id !== requestId) {
        throw badRequest('E_PARENT_REFUND', 'parent refund must belong to the same request');
      }
    }
    const alreadyRefunded = approvedRefundTotal(db, requestId);
    // Pending requests are not counted: finance may receive more filings than
    // the paid amount and reject the excess; approval is the hard checkpoint.
    if (alreadyRefunded + amountCents > req.amount_cents) {
      throw conflict(
        'E_REFUND_EXCEEDS_PAID',
        `this refund alone would exceed paid: already refunded ${alreadyRefunded}, filed ${amountCents}, paid ${req.amount_cents}`,
      );
    }

    const info = db
      .prepare(
        `INSERT INTO refunds (request_id, parent_refund_id, amount_cents, reason, requested_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(requestId, parentRefundId ?? null, amountCents, reason ?? null, actorId);
    const refundId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO approvals (request_id, action, actor_id, comment)
       VALUES (?, 'refund_request', ?, ?)`,
    ).run(requestId, actorId, `refund#${refundId} ${reason ?? ''}`);
    return refundId;
  });
}

export interface RefundApprovalResult {
  refundId: number;
  requestId: number;
  status: string;
  refunded_cents: number;
  request_status: string;
}

/** Finance approves a refund. Idempotent: a replayed callback changes nothing. */
export function approveRefund(
  db: DB,
  actorId: number,
  refundId: number,
  idempotencyKey?: string,
): RefundApprovalResult {
  const actor = getUser(db, actorId);
  return withImmediate(db, (): RefundApprovalResult => {
    if (idempotencyKey) {
      const replay = takeReplay(db, idempotencyKey);
      if (replay) return replay as RefundApprovalResult;
    }
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as
      | RefundRow
      | undefined;
    if (!refund) throw notFound('refund');
    if (refund.status !== 'requested') {
      throw conflict('E_REFUND_NOT_OPEN', `refund is ${refund.status}`);
    }
    const req = paidRequest(db, refund.request_id);
    if (actorId === refund.requested_by || actorId === req.applicant_id) {
      throw forbidden('E_SELF_APPROVAL', 'the requester/applicant cannot approve the refund');
    }
    if (actor.role !== 'finance') {
      throw forbidden('E_NOT_FINANCE', 'only finance can approve refunds');
    }
    const already = approvedRefundTotal(db, req.id);
    if (already + refund.amount_cents > req.amount_cents) {
      throw conflict('E_REFUND_EXCEEDS_PAID', 'refund would exceed the paid amount');
    }

    postEntry(
      db,
      { semesterId: req.semester_id, clubId: req.club_id, activityId: req.activity_id },
      {
        kind: 'refund',
        refund_cents: refund.amount_cents,
        request_id: req.id,
        refund_id: refund.id,
        actor_id: actorId,
        idempotency_key: idempotencyKey ? `refund:${idempotencyKey}` : null,
      },
    );
    db.prepare(
      `UPDATE refunds SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?`,
    ).run(actorId, refundId);
    db.prepare(
      `INSERT INTO approvals (request_id, action, actor_id, comment)
       VALUES (?, 'refund_approve', ?, ?)`,
    ).run(req.id, actorId, `refund#${refundId}`);

    const totalRefunded = already + refund.amount_cents;
    let requestStatus = req.status;
    if (totalRefunded === req.amount_cents) {
      requestStatus = 'refunded';
      db.prepare(`UPDATE requests SET status = 'refunded' WHERE id = ?`).run(req.id);
    }
    const result: RefundApprovalResult = {
      refundId,
      requestId: req.id,
      status: 'approved',
      refunded_cents: totalRefunded,
      request_status: requestStatus,
    };
    if (idempotencyKey) storeReplay(db, idempotencyKey, refundId, result);
    return result;
  });
}

export function rejectRefund(db: DB, actorId: number, refundId: number, comment?: string): void {
  const actor = getUser(db, actorId);
  withImmediate(db, () => {
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as
      | RefundRow
      | undefined;
    if (!refund) throw notFound('refund');
    if (refund.status !== 'requested') {
      throw conflict('E_REFUND_NOT_OPEN', `refund is ${refund.status}`);
    }
    if (actor.role !== 'finance') throw forbidden('E_NOT_FINANCE', 'only finance can reject refunds');
    if (actorId === refund.requested_by) {
      throw forbidden('E_SELF_APPROVAL', 'the requester cannot approve/reject their own refund');
    }
    db.prepare(`UPDATE refunds SET status = 'rejected' WHERE id = ?`).run(refundId);
    db.prepare(
      `INSERT INTO approvals (request_id, action, actor_id, comment)
       VALUES (?, 'refund_reject', ?, ?)`,
    ).run(refund.request_id, actorId, comment ?? `refund#${refundId}`);
  });
}

// ---------- idempotent callback store ----------

function takeReplay(db: DB, key: string): unknown | null {
  const row = db
    .prepare('SELECT result_json FROM idempotent_ops WHERE idempotency_key = ? AND scope = ?')
    .get(`refund:${key}`, 'refund') as { result_json: string } | undefined;
  return row ? JSON.parse(row.result_json) : null;
}

function storeReplay(db: DB, key: string, refId: number, result: unknown): void {
  db.prepare(
    `INSERT OR IGNORE INTO idempotent_ops (idempotency_key, scope, ref_id, result_json)
     VALUES (?, 'refund', ?, ?)`,
  ).run(`refund:${key}`, refId, JSON.stringify(result));
}
