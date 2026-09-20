import type { DB } from '../db.js';
import { withImmediate } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { getBalances, postEntry } from './budget.js';
import { createBudget } from './org.js';

export interface ClubCarryover {
  clubId: number;
  budget_total_cents: number;
  net_paid_cents: number;
  carryover_cents: number;
  newBudgetRowId: number;
}

/**
 * Settle a semester: for every club that still holds money there, the unused
 * amount (budget - net paid; refunds already flow back into available) is
 * carried into the target semester as a 'carryover' budget row.
 *
 * Closing is refused while any request still holds a reservation — the
 * activity must first be paid, rejected or cancelled.
 */
export function closeSemester(
  db: DB,
  fromSemesterId: number,
  toSemesterId: number,
  actorId: number,
): ClubCarryover[] {
  return withImmediate(db, () => {
    const from = db.prepare('SELECT * FROM semesters WHERE id = ?').get(fromSemesterId) as
      | { status: string }
      | undefined;
    if (!from) throw notFound('source semester');
    const to = db.prepare('SELECT id, status FROM semesters WHERE id = ?').get(toSemesterId) as
      | { status: string }
      | undefined;
    if (!to) throw notFound('target semester');
    if (to.status !== 'open') throw conflict('E_TARGET_CLOSED', 'target semester must be open');

    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM requests
         WHERE semester_id = ? AND status IN ('submitted','approved')`,
      )
      .get(fromSemesterId) as { n: number };
    if (pending.n > 0) {
      throw conflict(
        'E_OPEN_RESERVATIONS',
        `cannot close: ${pending.n} request(s) still reserve budget; pay, reject or cancel them first`,
      );
    }

    const clubs = db
      .prepare(
        `SELECT DISTINCT club_id FROM budgets WHERE semester_id = ?
         UNION
         SELECT DISTINCT club_id FROM budget_entries WHERE semester_id = ?`,
      )
      .all(fromSemesterId, fromSemesterId) as Array<{ club_id: number }>;

    const results: ClubCarryover[] = [];
    for (const { club_id: clubId } of clubs) {
      const b = getBalances(db, { semesterId: fromSemesterId, clubId });
      if (b.reserved_cents !== 0) {
        throw conflict('E_OPEN_RESERVATIONS', `club ${clubId} still reserves ${b.reserved_cents}`);
      }
      const carry = b.budget_total_cents - b.net_paid_cents;
      if (carry < 0) {
        // Overspend is impossible while capacity checks hold, but stay explicit.
        throw conflict('E_OVERSPENT', `club ${clubId} spent ${-carry} beyond budget`);
      }
      if (carry === 0) {
        results.push({
          clubId,
          budget_total_cents: b.budget_total_cents,
          net_paid_cents: b.net_paid_cents,
          carryover_cents: 0,
          newBudgetRowId: 0,
        });
        continue;
      }

      const already = db
        .prepare(
          `SELECT id FROM carryovers
           WHERE from_semester_id = ? AND to_semester_id = ? AND club_id = ?`,
        )
        .get(fromSemesterId, toSemesterId, clubId);
      if (already) {
        throw conflict('E_ALREADY_CARRIED', `club ${clubId} was already carried between these semesters`);
      }

      const budgetId = createBudget(
        db,
        toSemesterId,
        clubId,
        carry,
        actorId,
        'carryover',
        fromSemesterId,
      );
      db.prepare(
        `INSERT INTO carryovers
           (from_semester_id, to_semester_id, club_id, amount_cents, budget_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(fromSemesterId, toSemesterId, clubId, carry, budgetId, actorId);
      results.push({
        clubId,
        budget_total_cents: b.budget_total_cents,
        net_paid_cents: b.net_paid_cents,
        carryover_cents: carry,
        newBudgetRowId: budgetId,
      });
    }

    db.prepare(`UPDATE semesters SET status = 'closed' WHERE id = ?`).run(fromSemesterId);
    return results;
  });
}
