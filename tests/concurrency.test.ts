import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import * as org from '../src/services/org.js';
import {
  attachVoucher,
  createDraft,
  submitRequest,
  advisorReview,
  financePay,
} from '../src/services/requests.js';
import { requestRefund } from '../src/services/refunds.js';
import { getBalances } from '../src/services/budget.js';
import { runWorkers } from './concurrent-worker.js';
import { tempDbFile } from './helpers.js';

function world(file: string) {
  const db = openDb(file);
  const club = org.createClub(db, '机器人社');
  const leader = org.createUser(db, '张社长', 'student_leader', club);
  const advisor = org.createUser(db, '王老师', 'advisor');
  org.addAdvisor(db, club, advisor);
  const finance = org.createUser(db, '赵财务', 'finance');
  const semester = org.createSemester(db, '2026春');
  return { db, club, leader, advisor, finance, semester };
}

function readyDraft(db: any, w: ReturnType<typeof world>, amountCents: number, quota = 1000000) {
  const activity = org.createActivity(db, w.club, w.semester, '科技节', quota, w.leader);
  const id = createDraft(db, w.leader, { activityId: activity, title: '预支', amountCents });
  attachVoucher(db, w.leader, id, {
    voucherNo: `INV-${id}-${Math.random()}`, summary: '材料', amountCents, shareCents: amountCents,
  });
  return id;
}

test('concurrent submissions never overcommit the semester budget', async () => {
  const file = tempDbFile();
  const w = world(file);
  org.createBudget(w.db, w.semester, w.club, 100000, w.finance);
  // Two drafts of 600.00 each against a 1000.00 budget: only one may win.
  const r1 = readyDraft(w.db, w, 60000);
  const r2 = readyDraft(w.db, w, 60000);

  const outcomes = await runWorkers(file, [
    { op: 'submit', payload: { actorId: w.leader, requestId: r1 } },
    { op: 'submit', payload: { actorId: w.leader, requestId: r2 } },
  ]);
  const wins = outcomes.filter((o) => o.ok);
  const fails = outcomes.filter((o) => !o.ok);
  assert.equal(wins.length, 1);
  assert.equal(fails.length, 1);
  assert.equal(fails[0].code, 'E_BUDGET_EXCEEDED');

  const b = getBalances(w.db, { semesterId: w.semester, clubId: w.club });
  assert.equal(b.reserved_cents, 60000);
  assert.equal(b.available_cents, 40000);
});

test('concurrent finance approvals of two approved requests still respect budget', async () => {
  // Budget reduced via refunds is not needed here; the pay-time guard plus the
  // release race: one request is paid while another is cancelled concurrently.
  const file = tempDbFile();
  const w = world(file);
  org.createBudget(w.db, w.semester, w.club, 100000, w.finance);
  const r1 = readyDraft(w.db, w, 60000);
  const r2 = readyDraft(w.db, w, 40000);
  submitRequest(w.db, w.leader, r1);
  submitRequest(w.db, w.leader, r2);
  advisorReview(w.db, w.advisor, r1, 'approve');
  advisorReview(w.db, w.advisor, r2, 'approve');

  const outcomes = await runWorkers(file, [
    { op: 'pay', payload: { actorId: w.finance, requestId: r1, idemKey: 'K1' } },
    { op: 'pay', payload: { actorId: w.finance, requestId: r2, idemKey: 'K2' } },
  ]);
  assert.equal(outcomes.filter((o) => o.ok).length, 2);
  const b = getBalances(w.db, { semesterId: w.semester, clubId: w.club });
  assert.equal(b.paid_cents, 100000);
  assert.equal(b.net_paid_cents, 100000);
  assert.equal(b.available_cents, 0);
});

test('duplicate payment callback (same idempotency key) posts exactly one ledger entry', async () => {
  const file = tempDbFile();
  const w = world(file);
  org.createBudget(w.db, w.semester, w.club, 100000, w.finance);
  const r1 = readyDraft(w.db, w, 60000);
  submitRequest(w.db, w.leader, r1);
  advisorReview(w.db, w.advisor, r1, 'approve');

  const outcomes = await runWorkers(file, [
    { op: 'paySameKey', payload: { actorId: w.finance, requestId: r1 } },
    { op: 'paySameKey', payload: { actorId: w.finance, requestId: r1 } },
    { op: 'paySameKey', payload: { actorId: w.finance, requestId: r1 } },
  ]);
  // Every caller gets a success response (replayed), but money moved once.
  assert.equal(outcomes.filter((o) => o.ok).length, 3);
  const payEntries = w.db
    .prepare(`SELECT COUNT(*) AS n FROM budget_entries WHERE kind = 'pay'`)
    .get() as { n: number };
  assert.equal(payEntries.n, 1);
  const b = getBalances(w.db, { semesterId: w.semester, clubId: w.club });
  assert.equal(b.paid_cents, 60000);
});

test('concurrent refund approvals cannot exceed the paid amount', async () => {
  const file = tempDbFile();
  const w = world(file);
  org.createBudget(w.db, w.semester, w.club, 100000, w.finance);
  const r1 = readyDraft(w.db, w, 100000);
  submitRequest(w.db, w.leader, r1);
  advisorReview(w.db, w.advisor, r1, 'approve');
  financePay(w.db, w.finance, r1);
  // Two full-refund filings race to approval; at most one may pass.
  const f1 = requestRefund(w.db, w.leader, r1, 100000, '取消');
  const f2 = requestRefund(w.db, w.leader, r1, 100000, '又一单取消');

  const outcomes = await runWorkers(file, [
    { op: 'refund', payload: { actorId: w.finance, refundId: f1, idemKey: 'R1' } },
    { op: 'refund', payload: { actorId: w.finance, refundId: f2, idemKey: 'R2' } },
  ]);
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  assert.equal(outcomes.find((o) => !o.ok)!.code, 'E_REFUND_EXCEEDS_PAID');
  const b = getBalances(w.db, { semesterId: w.semester, clubId: w.club });
  assert.equal(b.refunded_cents, 100000);
  assert.equal(b.net_paid_cents, 0);
});
