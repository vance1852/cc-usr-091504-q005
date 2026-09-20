import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedWorld, errCode } from './helpers.js';
import * as org from '../src/services/org.js';
import {
  attachVoucher,
  createDraft,
  submitRequest,
  advisorReview,
  financePay,
  getRequestView,
} from '../src/services/requests.js';
import { getBalances, drilldown } from '../src/services/budget.js';
import { listOpenReviews, resolveDuplicateReview } from '../src/services/vouchers.js';

/**
 * One material invoice (face 100.00 yuan) is referenced by TWO groups that
 * genuinely shared the purchase: each claims a 50.00 allocation. That is a
 * legal split, not a duplicate.
 */
test('split invoice: two groups share one voucher within face amount', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 50000, s.finance);
  const a1 = org.createActivity(s.db, s.club, s.semester, '结构组', 20000, s.leader);
  const a2 = org.createActivity(s.db, s.club, s.semester, '电控组', 20000, s.leader);

  const r1 = createDraft(s.db, s.leader, { activityId: a1, title: '板材', amountCents: 5000 });
  attachVoucher(s.db, s.leader, r1, {
    voucherNo: 'INV-2026-007', summary: '材料费', amountCents: 10000, shareCents: 5000,
  });
  submitRequest(s.db, s.leader, r1);
  advisorReview(s.db, s.advisor, r1, 'approve');
  financePay(s.db, s.finance, r1);

  const r2 = createDraft(s.db, s.leader, { activityId: a2, title: '线材', amountCents: 5000 });
  // Same invoice again — second half. Same voucher_no + summary parks it.
  const result = attachVoucher(s.db, s.leader, r2, {
    voucherNo: 'INV-2026-007', summary: '材料费', amountCents: 10000, shareCents: 5000,
  });
  assert.equal(result.status, 'under_review');
  assert.ok(result.duplicateReviewId);
  // Nothing was deleted: both vouchers remain in the database.
  const v1 = getRequestView(s.db, r1);
  const v2 = getRequestView(s.db, r2);
  assert.equal(v1.vouchers.length, 1);
  assert.equal(v2.vouchers.length, 1);

  // Advisor verifies the purchase really was shared -> clears the alert.
  const reviews = listOpenReviews(s.db) as any[];
  assert.equal(reviews.length, 1);
  resolveDuplicateReview(s.db, reviews[0].id, 'cleared', s.finance, '两组合用一张发票各50元');
  submitRequest(s.db, s.leader, r2);
  advisorReview(s.db, s.advisor, r2, 'approve');
  financePay(s.db, s.finance, r2);

  const b = getBalances(s.db, { semesterId: s.semester, clubId: s.club });
  assert.equal(b.paid_cents, 10000);
  assert.equal(b.available_cents, 40000);

  // Drill-down shows both requests behind the same invoice.
  const d = drilldown(s.db, { semesterId: s.semester, clubId: s.club });
  const requestCodes = new Set(d.entries.filter((e: any) => e.kind === 'pay').map((e: any) => e.request_code));
  assert.equal(requestCodes.size, 2);
});

test('confirmed duplicate: later voucher flagged invalid_duplicate but retained', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 50000, s.finance);
  const a = org.createActivity(s.db, s.club, s.semester, '甲组', 20000, s.leader);
  const r1 = createDraft(s.db, s.leader, { activityId: a, title: '材料', amountCents: 8000 });
  attachVoucher(s.db, s.leader, r1, {
    voucherNo: 'INV-01', summary: '材料款', amountCents: 8000, shareCents: 8000,
  });
  submitRequest(s.db, s.leader, r1);
  advisorReview(s.db, s.advisor, r1, 'approve');
  financePay(s.db, s.finance, r1);

  const r2 = createDraft(s.db, s.leader, { activityId: a, title: '材料(重复报销)', amountCents: 8000 });
  attachVoucher(s.db, s.leader, r2, {
    voucherNo: 'INV-01', summary: '材料款', amountCents: 8000, shareCents: 8000,
  });
  const [review] = listOpenReviews(s.db) as any[];
  resolveDuplicateReview(s.db, review.id, 'confirmed_duplicate', s.finance, '同票同人重复');

  // The later voucher still exists (audit trail) but blocks payment.
  const view = getRequestView(s.db, r2) as any;
  assert.equal(view.vouchers[0].status, 'invalid_duplicate');
  submitRequest(s.db, s.leader, r2);
  advisorReview(s.db, s.advisor, r2, 'approve');
  assert.throws(
    () => financePay(s.db, s.finance, r2),
    errCode('E_VOUCHERS_NOT_PAYABLE'),
  );
  // Closed review cannot be rewritten.
  assert.throws(
    () => resolveDuplicateReview(s.db, review.id, 'cleared', s.finance, 'try again'),
    errCode('E_REVIEW_CLOSED'),
  );
});

test('allocation cannot exceed voucher face amount: parked, clearance refused until fixed', () => {
  const s = seedWorld();
  org.createBudget(s.db, s.semester, s.club, 50000, s.finance);
  const a = org.createActivity(s.db, s.club, s.semester, '组', 20000, s.leader);
  const r1 = createDraft(s.db, s.leader, { activityId: a, title: 'x', amountCents: 8000 });
  attachVoucher(s.db, s.leader, r1, {
    voucherNo: 'INV-9', summary: '材料', amountCents: 10000, shareCents: 8000,
  });
  submitRequest(s.db, s.leader, r1);
  advisorReview(s.db, s.advisor, r1, 'approve');
  financePay(s.db, s.finance, r1);

  const r2 = createDraft(s.db, s.leader, { activityId: a, title: 'y', amountCents: 9000 });
  // Same invoice cited by a second group for 90.00 after 80.00 of a 100.00
  // invoice: nothing is deleted — it goes to the reconciliation queue.
  const parked = attachVoucher(s.db, s.leader, r2, {
    voucherNo: 'INV-9', summary: '材料', amountCents: 10000, shareCents: 9000,
  });
  assert.equal(parked.status, 'under_review');

  // Trying to clear it as a legitimate shared invoice violates the face
  // amount: 8000 + 9000 > 10000. The review stays open.
  const [review] = listOpenReviews(s.db) as any[];
  assert.throws(
    () => resolveDuplicateReview(s.db, review.id, 'cleared', s.finance, '合用'),
    errCode('E_ALLOCATION_EXCEEDS_VOUCHER'),
  );
  // Still open (the failed clearance rolled back) and blocks payment.
  const stillOpen = listOpenReviews(s.db) as any[];
  assert.equal(stillOpen.length, 1);

  // Confirming it as a real duplicate is the correct resolution.
  resolveDuplicateReview(s.db, review.id, 'confirmed_duplicate', s.finance, '重复报销');
});
