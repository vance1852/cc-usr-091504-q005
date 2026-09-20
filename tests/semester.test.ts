import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedWorld } from './helpers.js';
import { errCode } from './helpers.js';
import * as org from '../src/services/org.js';
import {
  attachVoucher,
  cancelActivity,
  createDraft,
  advisorReview,
  financePay,
  submitRequest,
} from '../src/services/requests.js';
import { approveRefund, requestRefund } from '../src/services/refunds.js';
import { drilldown, getBalances } from '../src/services/budget.js';
import { closeSemester } from '../src/services/semester.js';

function paidRequest(s: ReturnType<typeof seedWorld>, amount: number, activity?: number) {
  const aid = activity ?? org.createActivity(s.db, s.club, s.semester, '科技节', 1000000, s.leader);
  const id = createDraft(s.db, s.leader, { activityId: aid, title: '预支', amountCents: amount });
  attachVoucher(s.db, s.leader, id, {
    voucherNo: `INV-${id}`, summary: '材料', amountCents: amount, shareCents: amount,
  });
  submitRequest(s.db, s.leader, id);
  advisorReview(s.db, s.advisor, id, 'approve');
  financePay(s.db, s.finance, id);
  return { activity: aid, request: id };
}

test('carryover: unused budget moves to the new semester as a carryover row', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  paidRequest(s, 30000);

  const next = org.createSemester(s.db, '2026秋');
  const result = closeSemester(s.db, s.semester, next, s.finance);
  const clubRow = result.find((r) => r.clubId === s.club)!;
  assert.equal(clubRow.carryover_cents, 70000); // 1000 - 300 paid

  // New semester available balance is exactly the carry; old semester closed.
  const b = getBalances(s.db, { semesterId: next, clubId: s.club });
  assert.equal(b.budget_total_cents, 70000);
  assert.equal(b.available_cents, 70000);
  const old = s.db.prepare('SELECT status FROM semesters WHERE id = ?').get(s.semester) as { status: string };
  assert.equal(old.status, 'closed');

  // The carryover budget row remembers its origin semester (traceability).
  const row = s.db
    .prepare(`SELECT * FROM budgets WHERE id = ?`)
    .get(clubRow.newBudgetRowId) as any;
  assert.equal(row.source, 'carryover');
  assert.equal(row.from_semester_id, s.semester);
});

test('refunded money counts as available again when settling the semester', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const { request } = paidRequest(s, 60000);
  const rid = requestRefund(s.db, s.leader, request, 20000, '部分取消');
  approveRefund(s.db, s.finance, rid);

  const next = org.createSemester(s.db, '2026秋');
  const result = closeSemester(s.db, s.semester, next, s.finance);
  // net paid = 60000 - 20000 = 40000 -> carry 60000
  assert.equal(result.find((r) => r.clubId === s.club)!.carryover_cents, 60000);
});

test('cannot close a semester while requests still reserve budget', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const activity = org.createActivity(s.db, s.club, s.semester, '科技节', 1000000, s.leader);
  const id = createDraft(s.db, s.leader, { activityId: activity, title: '预支', amountCents: 10000 });
  attachVoucher(s.db, s.leader, id, {
    voucherNo: 'INV-z', summary: '材料', amountCents: 10000, shareCents: 10000,
  });
  submitRequest(s.db, s.leader, id);
  const next = org.createSemester(s.db, '2026秋');
  assert.throws(() => closeSemester(s.db, s.semester, next, s.finance), errCode('E_OPEN_RESERVATIONS'));

  // Cancelling the activity frees the hold and settlement proceeds.
  cancelActivity(s.db, s.finance, activity, '取消');
  const result = closeSemester(s.db, s.semester, next, s.finance);
  assert.equal(result.find((r) => r.clubId === s.club)!.carryover_cents, 100000);
});

test('drill-down: a balance decomposes into reserves, payments, requests, vouchers and refunds', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const { activity, request } = paidRequest(s, 70000);
  const rid = requestRefund(s.db, s.leader, request, 25000, '退款');
  approveRefund(s.db, s.finance, rid);

  const d = drilldown(s.db, {
    semesterId: s.semester, clubId: s.club, activityId: activity,
  });
  const kinds = d.entries.map((e: any) => e.kind);
  assert.deepEqual(kinds, ['reserve', 'pay', 'refund']);

  const payEntry = d.entries.find((e: any) => e.kind === 'pay');
  assert.equal(payEntry.request_code.startsWith('REQ-'), true);
  assert.equal(payEntry.vouchers.length, 1);
  assert.equal(payEntry.vouchers[0].voucher_no, `INV-${request}`);
  assert.equal(payEntry.vouchers[0].share_cents, 70000);

  const refundEntry = d.entries.find((e: any) => e.kind === 'refund');
  assert.equal(refundEntry.refund_amount_cents, 25000);
  assert.equal(refundEntry.refund_status, 'approved');

  assert.deepEqual(
    {
      total: d.balances.budget_total_cents,
      paid: d.balances.paid_cents,
      refunded: d.balances.refunded_cents,
      available: d.balances.available_cents,
    },
    { total: 100000, paid: 70000, refunded: 25000, available: 55000 },
  );
});

test('approval history is append-only at the database level', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const { request } = paidRequest(s, 10000);
  const before = (s.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE request_id = ?').get(request) as { n: number }).n;
  assert.ok(before >= 3);
  assert.throws(
    () => s.db.prepare('UPDATE approvals SET comment = ? WHERE request_id = ?').run('篡改', request),
    /append-only/,
  );
  assert.throws(
    () => s.db.prepare('DELETE FROM approvals WHERE request_id = ?').run(request),
    /append-only/,
  );
});
