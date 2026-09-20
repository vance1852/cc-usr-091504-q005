import type { DB } from '../db/db.js';
import { id, nowIso } from '../db/db.js';

export interface LedgerEntryInput {
  budgetId: string;
  activityId?: string | null;
  requestId?: string | null;
  refundId?: string | null;
  entryType:
    | 'reserve'
    | 'release'
    | 'pay'
    | 'refund'
    | 'carry_out'
    | 'carry_in';
  reserveDelta?: number;
  payDelta?: number;
  refundDelta?: number;
  carryDelta?: number;
  idempotencyKey: string;
  refLabel?: string;
}

/** 追加一条分类账流水。幂等键冲突时静默跳过（重复回调/重复审批安全） */
export function appendLedger(db: DB, e: LedgerEntryInput): boolean {
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO ledger_entries
       (id, budget_id, activity_id, request_id, refund_id, entry_type,
        reserve_delta, pay_delta, refund_delta, carry_delta,
        idempotency_key, ref_label, created_at)
       VALUES (@id,@budget_id,@activity_id,@request_id,@refund_id,@entry_type,
        @reserve_delta,@pay_delta,@refund_delta,@carry_delta,
        @idempotency_key,@ref_label,@created_at)`,
    )
    .run({
      id: id('le'),
      budget_id: e.budgetId,
      activity_id: e.activityId ?? null,
      request_id: e.requestId ?? null,
      refund_id: e.refundId ?? null,
      entry_type: e.entryType,
      reserve_delta: e.reserveDelta ?? 0,
      pay_delta: e.payDelta ?? 0,
      refund_delta: e.refundDelta ?? 0,
      carry_delta: e.carryDelta ?? 0,
      idempotency_key: e.idempotencyKey,
      ref_label: e.refLabel ?? null,
      created_at: nowIso(),
    });
  return inserted.changes === 1;
}

export interface BudgetBalance {
  budgetId: string;
  clubId: string;
  termId: string;
  newBudgetCents: number;      // 本学期新拨
  carryInCents: number;        // 上学期结转
  carryOutCents: number;       // 结转出（正数表示已转出）
  reservedCents: number;       // 当前占用合计
  paidCents: number;           // 累计实际支付
  refundedCents: number;       // 累计退款到账
  availableCents: number;      // 可用余额
  spentCents: number;          // 净支出 = 支付 - 退款
}

/**
 * 预算余额（分桶口径）：
 *   总预算  = 新拨 + 结转入
 *   可用    = 总预算 - 占用 - 净支出
 *   占用    = Σ reserve_delta（reserve 为正，release/pay 转结为负）
 * 支付时等额冲减占用，故同一笔钱不会同时在占用与支出两桶。
 */
export function getBudgetBalance(db: DB, budgetId: string): BudgetBalance {
  const budget = db
    .prepare('SELECT id, club_id, term_id, amount_cents FROM budgets WHERE id = ?')
    .get(budgetId) as
    | { id: string; club_id: string; term_id: string; amount_cents: number }
    | undefined;
  if (!budget) throw new Error(`预算不存在: ${budgetId}`);

  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(reserve_delta),0) AS reserved,
         COALESCE(SUM(pay_delta),0)     AS paid,
         COALESCE(SUM(refund_delta),0)  AS refunded,
         COALESCE(SUM(CASE WHEN carry_delta > 0 THEN carry_delta ELSE 0 END),0) AS carry_in,
         COALESCE(SUM(CASE WHEN carry_delta < 0 THEN -carry_delta ELSE 0 END),0) AS carry_out
       FROM ledger_entries WHERE budget_id = ?`,
    )
    .get(budgetId) as {
    reserved: number;
    paid: number;
    refunded: number;
    carry_in: number;
    carry_out: number;
  };

  const netBudget = budget.amount_cents + agg.carry_in - agg.carry_out;
  const spent = agg.paid - agg.refunded;
  return {
    budgetId,
    clubId: budget.club_id,
    termId: budget.term_id,
    newBudgetCents: budget.amount_cents,
    carryInCents: agg.carry_in,
    carryOutCents: agg.carry_out,
    reservedCents: agg.reserved,
    paidCents: agg.paid,
    refundedCents: agg.refunded,
    spentCents: spent,
    availableCents: netBudget - agg.reserved - spent,
  };
}

export interface ActivityBalance {
  activityId: string;
  quotaCents: number;
  reservedCents: number;
  paidCents: number;
  refundedCents: number;
  availableCents: number;
}

/** 活动额度余额（并发审批时的超额检查口径） */
export function getActivityBalance(db: DB, activityId: string): ActivityBalance {
  const act = db
    .prepare('SELECT id, quota_cents, status FROM activities WHERE id = ?')
    .get(activityId) as
    | { id: string; quota_cents: number; status: string }
    | undefined;
  if (!act) throw new Error(`活动不存在: ${activityId}`);

  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(reserve_delta),0) AS reserved,
         COALESCE(SUM(pay_delta),0)     AS paid,
         COALESCE(SUM(refund_delta),0)  AS refunded
       FROM ledger_entries WHERE activity_id = ?`,
    )
    .get(activityId) as { reserved: number; paid: number; refunded: number };

  return {
    activityId,
    quotaCents: act.quota_cents,
    reservedCents: agg.reserved,
    paidCents: agg.paid,
    refundedCents: agg.refunded,
    availableCents: act.quota_cents - agg.reserved - (agg.paid - agg.refunded),
  };
}

/**
 * 余额下钻：返回构成预算余额的全部申请、凭证、退款与逐条流水。
 * 任一数字都能顺着 ledger -> request -> voucher / refund 追溯到业务依据。
 */
export function drillDown(db: DB, budgetId: string) {
  const balance = getBudgetBalance(db, budgetId);

  const rows = db
    .prepare(
      `SELECT le.*, r.request_no, r.title AS request_title, r.status AS request_status
       FROM ledger_entries le
       LEFT JOIN requests r ON r.id = le.request_id
       WHERE le.budget_id = ?
       ORDER BY le.created_at, le.id`,
    )
    .all(budgetId) as any[];

  const requestIds = [
    ...new Set(rows.map((r) => r.request_id).filter(Boolean) as string[]),
  ];

  const requests = requestIds.map((rid) => {
    const req = db
      .prepare(
        `SELECT r.*, a.name AS activity_name, a.budget_id
         FROM requests r JOIN activities a ON a.id = r.activity_id
         WHERE r.id = ?`,
      )
      .get(rid) as any;
    const vouchers = db
      .prepare(
        `SELECT va.id AS allocation_id, va.amount_cents AS allocated_cents,
                va.dup_status, va.dup_group_id,
                v.id AS voucher_id, v.voucher_no, v.summary, v.vendor,
                v.amount_cents AS voucher_amount_cents
         FROM voucher_allocations va JOIN vouchers v ON v.id = va.voucher_id
         WHERE va.request_id = ?`,
      )
      .all(rid) as any[];
    const refunds = db
      .prepare(
        `SELECT id, parent_refund_id, seq, amount_cents, reason, status,
                event_id, created_at, decided_at
         FROM refunds WHERE request_id = ? ORDER BY seq`,
      )
      .all(rid) as any[];
    const payment = db
      .prepare(
        `SELECT id, amount_cents, event_id, paid_at FROM payments WHERE request_id = ?`,
      )
      .get(rid) as any;
    return { ...req, payment, vouchers, refunds };
  });

  return { balance, ledger: rows, requests };
}
