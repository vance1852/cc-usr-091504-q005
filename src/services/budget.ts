import type { DB } from '../db.js';
import { AppError } from '../errors.js';

export interface Scope {
  semesterId: number;
  clubId: number;
  activityId?: number;
}

export interface Balances {
  budget_total_cents: number;
  reserved_cents: number;   // held by submitted/approved, not yet paid
  paid_cents: number;       // gross amount ever paid
  refunded_cents: number;   // amount that came back (paid stays visible)
  net_paid_cents: number;   // paid - refunded
  available_cents: number;  // still spendable: total - reserved - net paid
  activity_quota_cents: number | null;
}

const sumLedger = (
  db: DB,
  scope: Scope,
): { reserve: number; paid: number; refund: number } => {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(reserve_cents),0) AS reserve,
         COALESCE(SUM(paid_cents),0)    AS paid,
         COALESCE(SUM(refund_cents),0)  AS refund
       FROM budget_entries
       WHERE semester_id = @semesterId AND club_id = @clubId
         AND (@activityId IS NULL OR activity_id = @activityId)`,
    )
    .get({
      semesterId: scope.semesterId,
      clubId: scope.clubId,
      activityId: scope.activityId ?? null,
    }) as { reserve: number; paid: number; refund: number };
  return row;
};

export function getBalances(db: DB, scope: Scope): Balances {
  const budgetRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents),0) AS total
       FROM budgets
       WHERE semester_id = ? AND club_id = ?`,
    )
    .get(scope.semesterId, scope.clubId) as { total: number };

  const { reserve, paid, refund } = sumLedger(db, scope);
  const netPaid = paid - refund;

  let quota: number | null = null;
  if (scope.activityId != null) {
    const a = db
      .prepare('SELECT quota_cents, status FROM activities WHERE id = ?')
      .get(scope.activityId) as { quota_cents: number; status: string } | undefined;
    quota = a ? a.quota_cents : null;
  }

  return {
    budget_total_cents: budgetRow.total,
    reserved_cents: reserve,
    paid_cents: paid,
    refunded_cents: refund,
    net_paid_cents: netPaid,
    available_cents: budgetRow.total - reserve - netPaid,
    activity_quota_cents: quota,
  };
}

/**
 * Capacity check. Must be called INSIDE a BEGIN IMMEDIATE transaction so the
 * SUM it reads and the ledger insert that follows cannot interleave with a
 * concurrent approval.
 *
 * The semester/club BUDGET is one shared pool across all activities, so its
 * available balance is computed at club scope (no activity filter). The
 * ACTIVITY QUOTA is per activity, so that check uses the activity-scoped
 * balance. Mixing the two — e.g. filtering the club-budget sum by one
 * activity — lets requests on different activities each see an empty pool
 * and overcommit the club budget.
 */
export function assertCapacity(
  db: DB,
  scope: { semesterId: number; clubId: number; activityId: number },
  extraCents: number,
): void {
  const club = getBalances(db, { semesterId: scope.semesterId, clubId: scope.clubId });
  if (club.available_cents < extraCents) {
    throw new AppError(
      409,
      'E_BUDGET_EXCEEDED',
      `semester/club budget exceeded: need ${extraCents}, available ${club.available_cents}`,
      { scope, balances: club },
    );
  }
  const activity = getBalances(db, scope);
  if (activity.activity_quota_cents != null) {
    const held = activity.reserved_cents + activity.net_paid_cents;
    if (held + extraCents > activity.activity_quota_cents) {
      throw new AppError(
        409,
        'E_QUOTA_EXCEEDED',
        `activity quota exceeded: held ${held} + need ${extraCents} > quota ${activity.activity_quota_cents}`,
        { scope, balances: activity },
      );
    }
  }
}

export interface LedgerEntry {
  kind: 'reserve' | 'release' | 'pay' | 'refund';
  reserve_cents?: number;
  paid_cents?: number;
  refund_cents?: number;
  request_id?: number | null;
  refund_id?: number | null;
  actor_id?: number | null;
  note?: string | null;
  idempotency_key?: string | null;
}

/** Insert one signed ledger movement. Amounts in non-bucket columns are signed. */
export function postEntry(db: DB, scope: Scope, e: LedgerEntry): number {
  const info = db
    .prepare(
      `INSERT INTO budget_entries
         (semester_id, club_id, activity_id, request_id, refund_id,
          kind, reserve_cents, paid_cents, refund_cents, actor_id, note, idempotency_key)
       VALUES
         (@semesterId, @clubId, @activityId, @request_id, @refund_id,
          @kind, @reserve_cents, @paid_cents, @refund_cents, @actor_id, @note, @idempotency_key)`,
    )
    .run({
      semesterId: scope.semesterId,
      clubId: scope.clubId,
      activityId: scope.activityId ?? null,
      request_id: e.request_id ?? null,
      refund_id: e.refund_id ?? null,
      kind: e.kind,
      reserve_cents: e.reserve_cents ?? 0,
      paid_cents: e.paid_cents ?? 0,
      refund_cents: e.refund_cents ?? 0,
      actor_id: e.actor_id ?? null,
      note: e.note ?? null,
      idempotency_key: e.idempotency_key ?? null,
    });
  return Number(info.lastInsertRowid);
}

/**
 * Full drill-down: every ledger movement that makes up a balance, enriched
 * with the request code and the vouchers/refunds behind it.
 */
export function drilldown(db: DB, scope: Scope) {
  const entries = db
    .prepare(
      `SELECT e.*, r.code AS request_code, r.title AS request_title,
              rf.amount_cents AS refund_amount_cents, rf.status AS refund_status,
              rf.parent_refund_id
       FROM budget_entries e
       LEFT JOIN requests r ON r.id = e.request_id
       LEFT JOIN refunds rf ON rf.id = e.refund_id
       WHERE e.semester_id = @semesterId AND e.club_id = @clubId
         AND (@activityId IS NULL OR e.activity_id = @activityId)
       ORDER BY e.id`,
    )
    .all({
      semesterId: scope.semesterId,
      clubId: scope.clubId,
      activityId: scope.activityId ?? null,
    });

  const requestIds = [...new Set(entries.map((x: any) => x.request_id).filter(Boolean))];
  const vouchers =
    requestIds.length === 0
      ? []
      : db
          .prepare(
            `SELECT va.request_id, va.share_cents, v.id AS voucher_id, v.voucher_no,
                    v.summary, v.amount_cents AS voucher_amount_cents, v.status
             FROM voucher_allocations va
             JOIN vouchers v ON v.id = va.voucher_id
             WHERE va.request_id IN (${requestIds.map(() => '?').join(',')})
             ORDER BY v.id`,
          )
          .all(...requestIds);

  return {
    scope,
    balances: getBalances(db, scope),
    entries: entries.map((e: any) => ({
      ...e,
      vouchers: vouchers.filter((v: any) => v.request_id === e.request_id),
    })),
  };
}
