import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedWorld, errCode } from './helpers.js';
import * as org from '../src/services/org.js';
import {
  attachVoucher,
  cancelActivity,
  createDraft,
  financePay,
  financeReject,
  getRequestView,
  advisorReview,
  submitRequest,
} from '../src/services/requests.js';
import { approveRefund, rejectRefund, requestRefund } from '../src/services/refunds.js';
import { getBalances } from '../src/services/budget.js';

function draft(s: ReturnType<typeof seedWorld>, amountCents: number, activityId?: number) {
  const aid = activityId ?? org.createActivity(s.db, s.club, s.semester, '科技节', 1000000, s.leader);
  const id = createDraft(s.db, s.leader, { activityId: aid, title: '预支', amountCents });
  attachVoucher(s.db, s.leader, id, {
    voucherNo: `INV-${id}`, summary: '材料', amountCents, shareCents: amountCents,
  });
  return id;
}

test('happy path: reserve -> advisor confirms -> finance pays; buckets computed separately', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const id = draft(s, 30000);

  submitRequest(s.db, s.leader, id);
  let b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.deepEqual(
    { reserved: b.reserved_cents, paid: b.paid_cents, refunded: b.refunded_cents, available: b.available_cents },
    { reserved: 30000, paid: 0, refunded: 0, available: 70000 },
  );

  advisorReview(s.db, s.advisor, id, 'approve', '活动属实');
  financePay(s.db, s.finance, id);
  b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.deepEqual(
    { reserved: b.reserved_cents, paid: b.paid_cents, refunded: b.refunded_cents, available: b.available_cents },
    { reserved: 0, paid: 30000, refunded: 0, available: 70000 },
  );
});

test('applicant cannot approve their own expenditure', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const id = draft(s, 10000);
  submitRequest(s.db, s.leader, id);
  // The leader is also recorded as an advisor of their own club here; still forbidden.
  org.addAdvisor(s.db, s.club, s.leader);
  assert.throws(() => advisorReview(s.db, s.leader, id, 'approve'), errCode('E_SELF_APPROVAL'));
  assert.throws(() => financePay(s.db, s.leader, id), errCode('E_SELF_APPROVAL'));
});

test('leader can only draft for own club; advisor must advise the club', () => {
  const s = seedWorld();
  const foreign = org.createActivity(s.db, s.otherClub, s.semester, '辩论赛', 10000, s.otherLeader);
  assert.throws(
    () => createDraft(s.db, s.leader, { activityId: foreign, title: 'x', amountCents: 1000 }),
    errCode('E_OTHER_CLUB'),
  );
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const id = draft(s, 10000);
  submitRequest(s.db, s.leader, id);
  // other club's advisor cannot confirm
  const otherAdvisor = org.createUser(s.db, '钱老师', 'advisor');
  org.addAdvisor(s.db, s.otherClub, otherAdvisor);
  assert.throws(() => advisorReview(s.db, otherAdvisor, id, 'approve'), errCode('E_NOT_ADVISOR'));
  // finance role cannot do advisor review
  assert.throws(() => advisorReview(s.db, s.finance, id, 'approve'), errCode('E_NOT_ADVISOR'));
});

test('advisor reject releases reservation', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const id = draft(s, 30000);
  submitRequest(s.db, s.leader, id);
  advisorReview(s.db, s.advisor, id, 'reject', '凭证有疑');
  const b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.equal(b.reserved_cents, 0);
  assert.equal(b.available_cents, 100000);
  assert.equal(getRequestView(s.db, id).status, 'rejected');
});

test('cannot submit without evidence matching request amount', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const activity = org.createActivity(s.db, s.club, s.semester, '科技节', 50000, s.leader);
  const id = createDraft(s.db, s.leader, { activityId: activity, title: '预支', amountCents: 30000 });
  attachVoucher(s.db, s.leader, id, {
    voucherNo: 'INV-x', summary: '材料', amountCents: 30000, shareCents: 20000,
  });
  assert.throws(() => submitRequest(s.db, s.leader, id), errCode('E_EVIDENCE_MISMATCH'));
});

test('budget overrun is refused at submission; quota overrun refused too', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 50000, s.finance);
  const id = draft(s, 60000);
  assert.throws(() => submitRequest(s.db, s.leader, id), errCode('E_BUDGET_EXCEEDED'));

  const activity = org.createActivity(s.db, s.club, s.semester, '小活动', 5000, s.leader);
  const id2 = createDraft(s.db, s.leader, { activityId: activity, title: '预支', amountCents: 6000 });
  attachVoucher(s.db, s.leader, id2, {
    voucherNo: 'INV-y', summary: '材料', amountCents: 6000, shareCents: 6000,
  });
  assert.throws(() => submitRequest(s.db, s.leader, id2), errCode('E_QUOTA_EXCEEDED'));
});

test('cancel activity: unpaid requests auto-release; paid requests stay for refund chain', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 200000, s.finance);
  const activity = org.createActivity(s.db, s.club, s.semester, '科技节', 200000, s.leader);
  const unpaid = draft(s, 40000, activity);
  const paid = draft(s, 70000, activity);
  submitRequest(s.db, s.leader, unpaid);
  submitRequest(s.db, s.leader, paid);
  advisorReview(s.db, s.advisor, unpaid, 'approve');
  advisorReview(s.db, s.advisor, paid, 'approve');
  financePay(s.db, s.finance, paid);

  const out = cancelActivity(s.db, s.finance, activity, '活动取消');
  assert.deepEqual(out.released.sort((a, b2) => a - b2), [unpaid]);
  assert.deepEqual(out.left_paid, [paid]);

  const b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.equal(b.reserved_cents, 0);
  assert.equal(b.paid_cents, 70000);
  assert.equal(b.available_cents, 130000); // 200000 - 70000 net paid
  assert.equal(getRequestView(s.db, unpaid).status, 'released');
  assert.equal(getRequestView(s.db, paid).status, 'paid');
});

test('refund chain: partial refunds then full; only finance approves; buckets update', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const id = draft(s, 60000);
  submitRequest(s.db, s.leader, id);
  advisorReview(s.db, s.advisor, id, 'approve');
  financePay(s.db, s.finance, id);

  // applicant cannot approve their own refund either
  const rid = requestRefund(s.db, s.leader, id, 20000, '部分材料取消');
  assert.throws(() => approveRefund(s.db, s.leader, rid), errCode('E_SELF_APPROVAL'));

  const r1 = approveRefund(s.db, s.finance, rid, 'cb-1');
  assert.equal(r1.request_status, 'paid'); // still partially paid
  let b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.equal(b.paid_cents, 60000);        // gross paid stays visible
  assert.equal(b.refunded_cents, 20000);
  assert.equal(b.net_paid_cents, 40000);
  assert.equal(b.available_cents, 60000);  // refunded money is spendable again

  // Second refund links to the first (the chain).
  const rid2 = requestRefund(s.db, s.leader, id, 40000, '尾款退回', rid);
  const r2 = approveRefund(s.db, s.finance, rid2, 'cb-2');
  assert.equal(r2.request_status, 'refunded');
  b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.equal(b.refunded_cents, 60000);
  assert.equal(b.net_paid_cents, 0);
  assert.equal(b.available_cents, 100000);
  const view = getRequestView(s.db, id) as any;
  assert.equal(view.refunds[1].parent_refund_id, rid);
  // approvals trail contains every step
  const actions = view.approvals.map((a: any) => a.action);
  assert.deepEqual(actions, [
    'submit', 'advisor_approve', 'finance_pay',
    'refund_request', 'refund_approve', 'refund_request', 'refund_approve',
  ]);
});

test('refund cannot exceed paid amount; rejected refund changes nothing', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const id = draft(s, 30000);
  submitRequest(s.db, s.leader, id);
  advisorReview(s.db, s.advisor, id, 'approve');
  financePay(s.db, s.finance, id);
  const rid = requestRefund(s.db, s.leader, id, 30000, '全额退');
  rejectRefund(s.db, s.finance, rid, '活动照常');
  const b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.equal(b.refunded_cents, 0);
  // A new refund request of the full amount is still possible after rejection.
  const rid2 = requestRefund(s.db, s.leader, id, 30000, '确实取消了');
  approveRefund(s.db, s.finance, rid2);
  // Any further filing beyond the paid total is refused immediately.
  assert.throws(
    () => requestRefund(s.db, s.leader, id, 1, '多退一分'),
    errCode('E_REFUND_EXCEEDS_PAID'),
  );
});

test('finance rejection before payment releases the hold', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 100000, s.finance);
  const id = draft(s, 40000);
  submitRequest(s.db, s.leader, id);
  advisorReview(s.db, s.advisor, id, 'approve');
  financeReject(s.db, s.finance, id, '账户信息有误');
  const b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.equal(b.reserved_cents, 0);
  assert.equal(b.available_cents, 100000);
});
