import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';

// End-to-end through the Fastify routes: the exact scenario from the brief —
// one material invoice cited twice, an advance that must be returned after
// the activity is cancelled, and a fully traceable budget balance.
test('HTTP end-to-end: duplicate invoice review + cancelled activity + refund chain', async () => {
  const app = buildApp({ db: openDb(':memory:') });
  after(async () => app.close());

  type InjectReply = { statusCode: number; json: <T = any>() => T };
  const post = (url: string, body: unknown, userId?: number) =>
    app.inject({
      method: 'POST',
      url,
      payload: body as any,
      headers: userId ? { 'x-user-id': String(userId) } : {},
    }) as unknown as Promise<InjectReply>;
  const get = (url: string, userId: number) =>
    app.inject({ method: 'GET', url, headers: { 'x-user-id': String(userId) } }) as unknown as Promise<InjectReply>;

  // ---- setup ----
  const club = (await post('/admin/clubs', { name: '机器人社' })).json<{ id: number }>();
  const leader = (await post('/admin/users', { name: '张社长', role: 'student_leader', club_id: club.id })).json<{ id: number }>();
  const advisor = (await post('/admin/users', { name: '王老师', role: 'advisor' })).json<{ id: number }>();
  await post('/admin/advisors', { club_id: club.id, user_id: advisor.id });
  const finance = (await post('/admin/users', { name: '赵财务', role: 'finance' })).json<{ id: number }>();
  const semester = (await post('/admin/semesters', { name: '2026春' })).json<{ id: number }>();
  await post('/admin/budgets', { semester_id: semester.id, club_id: club.id, amount_cents: 100000, created_by: finance.id });
  const activity = (await post('/admin/activities', {
    club_id: club.id, semester_id: semester.id, name: '科技节', quota_cents: 100000, created_by: leader.id,
  })).json<{ id: number }>();

  // request A pays 60.00 of a 100.00 shared material invoice
  const rA = (await post('/requests', { activity_id: activity.id, title: '结构组材料', amount_cents: 6000 }, leader.id)).json<{ id: number }>();
  const va = await post(`/requests/${rA.id}/vouchers`, {
    voucher_no: 'INV-007', summary: '材料费', amount_cents: 10000, share_cents: 6000,
  }, leader.id);
  assert.equal(va.statusCode, 200);
  assert.equal(va.json().status, 'active');
  await post(`/requests/${rA.id}/submit`, {}, leader.id);
  await post(`/requests/${rA.id}/advisor-review`, { decision: 'approve', comment: '属实' }, advisor.id);
  await post(`/requests/${rA.id}/pay`, { idempotency_key: 'pay-A' }, finance.id);

  // request B cites the SAME invoice — parked for reconciliation, not deleted
  const rB = (await post('/requests', { activity_id: activity.id, title: '电控组材料', amount_cents: 4000 }, leader.id)).json<{ id: number }>();
  const vb = await post(`/requests/${rB.id}/vouchers`, {
    voucher_no: 'INV-007', summary: '材料费', amount_cents: 10000, share_cents: 4000,
  }, leader.id);
  assert.equal(vb.json().status, 'under_review');

  // reviewer clears it (legitimate 60/40 split) then B flows through
  const reviews = (await get('/reviews', finance.id)).json<any[]>();
  assert.equal(reviews.length, 1);
  const resolve = await post(`/reviews/${reviews[0].id}/resolve`, { resolution: 'cleared', note: '两组合用' }, finance.id);
  assert.equal(resolve.statusCode, 200);
  await post(`/requests/${rB.id}/submit`, {}, leader.id);
  await post(`/requests/${rB.id}/advisor-review`, { decision: 'approve' }, advisor.id);
  await post(`/requests/${rB.id}/pay`, { idempotency_key: 'pay-B' }, finance.id);

  // replayed payment callback is idempotent: still one ledger pay-entry for B
  const replay = await post(`/requests/${rB.id}/pay`, { idempotency_key: 'pay-B' }, finance.id);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().paid_cents, 4000);

  // ---- activity cancelled: both were already paid, so refunds handle it ----
  const cancel = await post(`/activities/${activity.id}/cancel`, { reason: '活动取消' }, finance.id);
  assert.deepEqual(cancel.json().released, []);
  assert.deepEqual(cancel.json().left_paid.sort(), [rA.id, rB.id].sort());

  // leader requests refunds; finance approves (can't approve own).
  // A comes back in two partial refunds forming an intra-request chain.
  const rfA1 = (await post(`/requests/${rA.id}/refunds`, { amount_cents: 3000, reason: '部分材料取消' }, leader.id)).json<{ id: number }>();
  const selfApprove = await post(`/refunds/${rfA1.id}/approve`, {}, leader.id);
  assert.equal(selfApprove.statusCode, 403);
  assert.equal(selfApprove.json().error, 'E_SELF_APPROVAL');
  await post(`/refunds/${rfA1.id}/approve`, { idempotency_key: 'rf-A1' }, finance.id);
  // duplicate refund callback returns the same stored result
  const rfReplay = await post(`/refunds/${rfA1.id}/approve`, { idempotency_key: 'rf-A1' }, finance.id);
  assert.equal(rfReplay.json().refunded_cents, 3000);

  const rfA2 = (await post(`/requests/${rA.id}/refunds`, { amount_cents: 3000, reason: '尾款退回', parent_refund_id: rfA1.id }, leader.id)).json<{ id: number }>();
  await post(`/refunds/${rfA2.id}/approve`, { idempotency_key: 'rf-A2' }, finance.id);

  const rfB = (await post(`/requests/${rB.id}/refunds`, { amount_cents: 4000, reason: '取消退回' }, leader.id)).json<{ id: number }>();
  await post(`/refunds/${rfB.id}/approve`, { idempotency_key: 'rf-B' }, finance.id);

  // ---- final balance: fully gross-paid then fully refunded; nothing spent ----
  const balances = (await get(
    `/budgets?semester_id=${semester.id}&club_id=${club.id}`, finance.id,
  )).json<any>();
  assert.equal(balances.balances.paid_cents, 10000);      // gross payments stay visible
  assert.equal(balances.balances.refunded_cents, 10000);
  assert.equal(balances.balances.net_paid_cents, 0);
  assert.equal(balances.balances.available_cents, 100000);

  // ---- drill-down reaches every request, voucher and refund ----
  const dd = (await get(
    `/budgets/drilldown?semester_id=${semester.id}&club_id=${club.id}&activity_id=${activity.id}`, finance.id,
  )).json<any>();
  const kinds = dd.entries.map((e: any) => e.kind);
  assert.deepEqual(kinds, ['reserve', 'pay', 'reserve', 'pay', 'refund', 'refund', 'refund']);
  const payVoucherNos = dd.entries
    .filter((e: any) => e.kind === 'pay')
    .flatMap((e: any) => e.vouchers.map((v: any) => v.voucher_no));
  // B's allocation was folded into the single physical invoice on clearance
  assert.deepEqual([...new Set(payVoucherNos)], ['INV-007']);
  // the second A refund is linked to the first (traceable chain)
  const refundEntries = dd.entries.filter((e: any) => e.kind === 'refund');
  assert.ok(refundEntries.some((e: any) => e.parent_refund_id != null), 'a refund should have a parent link');
});

test('HTTP: missing auth header is rejected', async () => {
  const app = buildApp({ db: openDb(':memory:') });
  after(async () => app.close());
  const res = await app.inject({ method: 'GET', url: '/budgets?semester_id=1&club_id=1' });
  assert.equal(res.statusCode, 401);
});
