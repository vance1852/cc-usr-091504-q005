import type { DB } from '../db.js';
import { withImmediate } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';

/**
 * Voucher identity = voucher number + normalized summary. Whitespace and
 * punctuation are stripped so "NO.001 材料款" and "no001材料款" collide.
 */
export function normalizeKey(voucherNo: string, summary: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');
  return `${norm(voucherNo)}::${norm(summary)}`;
}

export interface VoucherInput {
  voucherNo: string;
  summary: string;
  amountCents: number; // face amount of the invoice
}

export interface VoucherRegisterResult {
  voucherId: number;
  status: 'active' | 'under_review' | 'invalid_duplicate';
  duplicateReviewId: number | null;
}

/**
 * Register a voucher while attaching it (with `shareCents`) to a request.
 * A matching existing voucher does NOT delete or reject anything: the new
 * voucher is parked as under_review and a reconciliation row is opened.
 * Must run inside an IMMEDIATE transaction together with the caller's writes.
 */
export function registerVoucherForRequest(
  db: DB,
  input: VoucherInput,
  shareCents: number,
  requestId: number,
  actorId: number,
): VoucherRegisterResult {
  if (!input.voucherNo.trim() || !input.summary.trim()) {
    throw badRequest('E_VOUCHER_FIELD', 'voucher_no and summary are required');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw badRequest('E_VOUCHER_AMOUNT', 'voucher amount must be positive integer cents');
  }
  if (!Number.isInteger(shareCents) || shareCents <= 0 || shareCents > input.amountCents) {
    throw badRequest(
      'E_SHARE_INVALID',
      `allocation share ${shareCents} must be within voucher face amount ${input.amountCents}`,
    );
  }

  const key = normalizeKey(input.voucherNo, input.summary);
  const existing = db
    .prepare(
      `SELECT id, status FROM vouchers
       WHERE norm_key = ? AND status != 'invalid_duplicate'
       ORDER BY id LIMIT 1`,
    )
    .get(key) as { id: number; status: string } | undefined;

  let status: VoucherRegisterResult['status'] = 'active';
  let duplicateOf: number | null = null;
  let duplicateReviewId: number | null = null;

  if (existing) {
    // A matching invoice is ALWAYS parked for reconciliation first — even
    // when the combined shares would exceed the face amount. The face-amount
    // invariant is enforced when the reviewer clears it (merge); an
    // over-claiming clearance is rejected and the voucher stays under review
    // (and therefore unpayable) until corrected or confirmed duplicate.
    status = 'under_review';
    duplicateOf = existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO vouchers (voucher_no, summary, norm_key, amount_cents, status, duplicate_of, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.voucherNo.trim(),
      input.summary.trim(),
      key,
      input.amountCents,
      status,
      duplicateOf,
      actorId,
    );
  const voucherId = Number(info.lastInsertRowid);

  if (existing) {
    const reviewInfo = db
      .prepare(
        `INSERT INTO duplicate_reviews (new_voucher_id, existing_voucher_id)
         VALUES (?, ?)`,
      )
      .run(voucherId, existing.id);
    duplicateReviewId = Number(reviewInfo.lastInsertRowid);
  }

  addAllocation(db, voucherId, requestId, shareCents, actorId);
  return { voucherId, status, duplicateReviewId };
}

/**
 * Add an allocation and enforce the split-invoice invariant: the shares cut
 * from one voucher must never exceed its face amount (two groups may share a
 * legitimate invoice, but never claim more than it totals).
 */
export function addAllocation(
  db: DB,
  voucherId: number,
  requestId: number,
  shareCents: number,
  actorId: number,
): number {
  const v = db.prepare('SELECT amount_cents FROM vouchers WHERE id = ?').get(voucherId) as
    | { amount_cents: number }
    | undefined;
  if (!v) throw notFound('voucher');

  const otherShares = db
    .prepare(
      `SELECT COALESCE(SUM(share_cents),0) AS s
       FROM voucher_allocations
       WHERE voucher_id = ? AND request_id != ?`,
    )
    .get(voucherId, requestId) as { s: number };

  // Upsert replaces this request's own row, so the new voucher total is the
  // other groups' shares plus the incoming share.
  if (otherShares.s + shareCents > v.amount_cents) {
    throw conflict(
      'E_ALLOCATION_EXCEEDS_VOUCHER',
      `voucher ${voucherId} face amount ${v.amount_cents} exceeded: other groups already hold ${otherShares.s}, new share ${shareCents}`,
      { voucherId, face_cents: v.amount_cents, other_shares_cents: otherShares.s, share_cents: shareCents },
    );
  }

  const info = db
    .prepare(
      `INSERT INTO voucher_allocations (voucher_id, request_id, share_cents, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(voucher_id, request_id) DO UPDATE SET share_cents = excluded.share_cents`,
    )
    .run(voucherId, requestId, shareCents, actorId);
  return Number(info.lastInsertRowid);
}

/**
 * Replace the full voucher set of a request (used to rework evidence after a
 * duplicate is confirmed). Only allowed before money moved.
 */
export function replaceRequestAllocations(
  db: DB,
  requestId: number,
  items: Array<VoucherInput & { shareCents: number }>,
  actorId: number,
): Array<{ voucherId: number; status: string; duplicateReviewId: number | null }> {
  const results: Array<{ voucherId: number; status: string; duplicateReviewId: number | null }> = [];
  db.prepare('DELETE FROM voucher_allocations WHERE request_id = ?').run(requestId);
  for (const item of items) {
    const r = registerVoucherForRequest(
      db,
      { voucherNo: item.voucherNo, summary: item.summary, amountCents: item.amountCents },
      item.shareCents,
      requestId,
      actorId,
    );
    results.push(r);
  }
  return results;
}

export function requestAllocationTotal(db: DB, requestId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(share_cents),0) AS s FROM voucher_allocations WHERE request_id = ?')
    .get(requestId) as { s: number };
  return row.s;
}

/** Finance must not pay while evidence is disputed or invalid. */
export function assertVouchersPayable(db: DB, requestId: number): void {
  const rows = db
    .prepare(
      `SELECT v.id, v.status
       FROM voucher_allocations va JOIN vouchers v ON v.id = va.voucher_id
       WHERE va.request_id = ?`,
    )
    .all(requestId) as Array<{ id: number; status: string }>;
  const blocked = rows.filter((r) => r.status !== 'active');
  if (blocked.length > 0) {
    throw conflict(
      'E_VOUCHERS_NOT_PAYABLE',
      `request has vouchers awaiting duplicate reconciliation: ${blocked.map((b) => `#${b.id}(${b.status})`).join(', ')}`,
      { blocked },
    );
  }
}

export function resolveDuplicateReview(
  db: DB,
  reviewId: number,
  resolution: 'cleared' | 'confirmed_duplicate',
  resolverId: number,
  note: string | undefined,
): void {
  withImmediate(db, () => {
  const review = db.prepare('SELECT * FROM duplicate_reviews WHERE id = ?').get(reviewId) as
    | any
    | undefined;
  if (!review) throw notFound('duplicate review');
  if (review.status !== 'open') {
    throw conflict('E_REVIEW_CLOSED', `review already resolved as ${review.status}`);
  }
  if (resolution === 'confirmed_duplicate') {
    // The later voucher is marked invalid but KEPT for the audit trail.
    db.prepare(`UPDATE vouchers SET status = 'invalid_duplicate' WHERE id = ?`).run(
      review.new_voucher_id,
    );
  } else {
    // Legitimate shared invoice: fold the later voucher's allocations into
    // the original physical voucher so the face-amount invariant spans BOTH
    // groups, then retire the duplicate row as 'merged' (never deleted).
    const newAllocs = db
      .prepare('SELECT request_id, share_cents, created_by FROM voucher_allocations WHERE voucher_id = ?')
      .all(review.new_voucher_id) as Array<{ request_id: number; share_cents: number; created_by: number }>;
    for (const a of newAllocs) {
      addAllocation(db, review.existing_voucher_id, a.request_id, a.share_cents, resolverId);
    }
    db.prepare('DELETE FROM voucher_allocations WHERE voucher_id = ?').run(review.new_voucher_id);
    db.prepare(
      `UPDATE vouchers SET status = 'merged', duplicate_of = ? WHERE id = ?`,
    ).run(review.existing_voucher_id, review.new_voucher_id);
  }
  db.prepare(
    `UPDATE duplicate_reviews
     SET status = ?, resolver_id = ?, resolution_note = ?, resolved_at = datetime('now')
     WHERE id = ?`,
  ).run(resolution, resolverId, note ?? null, reviewId);
  });
}

export function listOpenReviews(db: DB) {
  return db
    .prepare(
      `SELECT dr.*,
              v1.voucher_no AS new_voucher_no, v1.summary AS new_summary,
              v1.amount_cents AS new_amount_cents,
              v2.voucher_no AS existing_voucher_no, v2.summary AS existing_summary
       FROM duplicate_reviews dr
       JOIN vouchers v1 ON v1.id = dr.new_voucher_id
       JOIN vouchers v2 ON v2.id = dr.existing_voucher_id
       WHERE dr.status = 'open'
       ORDER BY dr.id`,
    )
    .all();
}
