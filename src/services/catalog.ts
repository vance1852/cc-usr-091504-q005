import type { DB } from '../db/db.js';
import { id, nowIso, withTransaction } from '../db/db.js';
import { Errors } from '../domain/errors.js';
import { getBudgetBalance } from './ledger.js';

export function createUser(
  db: DB,
  u: { id?: string; name: string; role: 'student_leader' | 'advisor' | 'finance'; clubId?: string | null },
) {
  const userId = u.id ?? id('usr');
  db.prepare(
    `INSERT INTO users (id, name, role, club_id, created_at) VALUES (?,?,?,?,?)`,
  ).run(userId, u.name, u.role, u.clubId ?? null, nowIso());
  return getUser(db, userId);
}

export function getUser(db: DB, userId: string) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!u) throw Errors.notFound('用户');
  return u;
}

export function createClub(db: DB, name: string, advisorUserId?: string) {
  const clubId = id('clb');
  db.prepare('INSERT INTO clubs (id, name, advisor_user_id, created_at) VALUES (?,?,?,?)')
    .run(clubId, name, advisorUserId ?? null, nowIso());
  if (advisorUserId) {
    db.prepare('UPDATE users SET club_id = ? WHERE id = ?').run(clubId, advisorUserId);
  }
  return db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId) as any;
}

export function createTerm(
  db: DB,
  t: { id?: string; name: string; seq: number; startDate?: string; endDate?: string },
) {
  const termId = t.id ?? id('trm');
  db.prepare('INSERT INTO terms (id, name, start_date, end_date, seq) VALUES (?,?,?,?,?)')
    .run(termId, t.name, t.startDate ?? null, t.endDate ?? null, t.seq);
  return db.prepare('SELECT * FROM terms WHERE id = ?').get(termId) as any;
}

export function createBudget(
  db: DB,
  input: { clubId: string; termId: string; amountCents: number; createdBy: string },
) {
  if (input.amountCents < 0) throw Errors.validation('预算金额不能为负');
  const budgetId = id('bdg');
  db.prepare(
    `INSERT INTO budgets (id, club_id, term_id, amount_cents, created_by, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(budgetId, input.clubId, input.termId, input.amountCents, input.createdBy, nowIso());
  return db.prepare('SELECT * FROM budgets WHERE id = ?').get(budgetId) as any;
}

export function findBudget(db: DB, clubId: string, termId: string) {
  return db
    .prepare('SELECT * FROM budgets WHERE club_id = ? AND term_id = ?')
    .get(clubId, termId) as any;
}

export function createActivity(
  db: DB,
  input: { budgetId: string; name: string; quotaCents: number; createdBy: string },
) {
  if (input.quotaCents < 0) throw Errors.validation('活动额度不能为负');
  const balance = getBudgetBalance(db, input.budgetId);
  if (input.quotaCents > balance.newBudgetCents + balance.carryInCents) {
    throw Errors.conflict(
      'QUOTA_EXCEEDS_BUDGET',
      '活动额度不能超过学期预算总额',
    );
  }
  const activityId = id('act');
  db.prepare(
    `INSERT INTO activities (id, budget_id, name, quota_cents, status, created_by, created_at)
     VALUES (?,?,?,?,'active',?,?)`,
  ).run(activityId, input.budgetId, input.name, input.quotaCents, input.createdBy, nowIso());
  return db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId) as any;
}

export function getActivityContext(db: DB, activityId: string) {
  const row = db
    .prepare(
      `SELECT a.*, b.club_id, b.term_id, c.advisor_user_id
       FROM activities a
       JOIN budgets b ON b.id = a.budget_id
       JOIN clubs c ON c.id = b.club_id
       WHERE a.id = ?`,
    )
    .get(activityId) as any;
  if (!row) throw Errors.notFound('活动');
  return row;
}

/**
 * 跨学期结转：把上学期预算的可用余额结到下学期。
 * 要求上期无未完成占用（申请均已支付/释放/退款结清）。
 * 幂等：同一预算只能结转一次。
 */
export function carryOver(
  db: DB,
  input: { clubId: string; fromTermId: string; toTermId: string },
) {
  return withTransaction(db, () => {
    const from = findBudget(db, input.clubId, input.fromTermId);
    const to = findBudget(db, input.clubId, input.toTermId);
    if (!from || !to) throw Errors.notFound('学期预算');

    const balance = getBudgetBalance(db, from.id);
    if (balance.reservedCents !== 0) {
      throw Errors.state('上学期仍有未结清的占用金额，不能结转');
    }
    if (balance.availableCents < 0) {
      throw Errors.state('上学期预算超支，不能结转');
    }

    // 幂等：同一来源预算已结转则直接返回现状
    const existing = db
      .prepare('SELECT id FROM ledger_entries WHERE idempotency_key = ?')
      .get(`carry:out:${from.id}`);
    if (existing) {
      return {
        carriedCents: balance.carryOutCents,
        idempotent: true,
        fromBudgetId: from.id,
        toBudgetId: to.id,
        fromBalance: getBudgetBalance(db, from.id),
        toBalance: getBudgetBalance(db, to.id),
      };
    }

    const amount = balance.availableCents;

    db.prepare(
      `INSERT INTO ledger_entries
       (id, budget_id, entry_type, carry_delta, idempotency_key, ref_label, created_at)
       VALUES (?,?, 'carry_out', ?, ?, ?, ?)`,
    ).run(id('le'), from.id, -amount, `carry:out:${from.id}`, `结转至学期 ${input.toTermId}`, nowIso());

    db.prepare(
      `INSERT INTO ledger_entries
       (id, budget_id, entry_type, carry_delta, idempotency_key, ref_label, created_at)
       VALUES (?,?, 'carry_in', ?, ?, ?, ?)`,
    ).run(id('le'), to.id, amount, `carry:in:${to.id}:${from.id}`, `学期 ${input.fromTermId} 结转入`, nowIso());

    return {
      carriedCents: amount,
      fromBudgetId: from.id,
      toBudgetId: to.id,
      fromBalance: getBudgetBalance(db, from.id),
      toBalance: getBudgetBalance(db, to.id),
    };
  });
}
