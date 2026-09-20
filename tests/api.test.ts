import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db/db.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { createWorld, makeBudget, makeActivity, type World } from './helpers/world.js';
import * as Catalog from '../src/services/catalog.js';
import { yuanToCents } from '../src/domain/money.js';

let app: FastifyInstance;
let db: DB;
let w: World;
let budget: any;
let activity: any;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'fin-api-'));
  db = openDb(join(dir, 'test.sqlite'));
  w = createWorld(db);
  budget = makeBudget(w, w.clubA, w.term, 500);
  activity = makeActivity(w, budget, '科技节', 400);
  app = buildApp(db);
});

function as(userId?: string) {
  return { 'x-user-id': userId ?? w.leaderA.id };
}

describe('HTTP API 端到端', () => {
  it('完整核销链路：起草→占用→真实性审核→支付→取消→退款→下钻', async () => {
    // 起草
    const create = await app.inject({
      method: 'POST', url: '/requests', headers: as(),
      payload: { activityId: activity.id, title: '展板制作', amountYuan: '300.00' },
    });
    expect(create.statusCode).toBe(200);
    const req = create.json();

    // 未带头 -> 401
    expect((await app.inject({ method: 'POST', url: `/requests/${req.id}/submit`, payload: {} })).statusCode).toBe(401);

    // 提交占用
    expect((await app.inject({ method: 'POST', url: `/requests/${req.id}/submit`, headers: as() })).statusCode).toBe(200);
    let bal = (await app.inject({ url: `/budgets/${budget.id}/balance`, headers: as(w.finance.id) })).json();
    expect(bal.reservedCents).toBe(30000);
    expect(bal.availableCents).toBe(20000);

    // 外社团学生不能审核
    expect((await app.inject({
      method: 'POST', url: `/requests/${req.id}/advisor-review`,
      headers: as(w.leaderB.id), payload: { decision: 'approve' },
    })).statusCode).toBe(403);

    // 指导老师确认真实性
    expect((await app.inject({
      method: 'POST', url: `/requests/${req.id}/advisor-review`,
      headers: as(w.advisorA.id), payload: { decision: 'approve', comment: '活动属实' },
    })).statusCode).toBe(200);

    // 学生不能支付
    expect((await app.inject({
      method: 'POST', url: `/requests/${req.id}/pay`,
      headers: as(), payload: { eventId: 'http-pay-1' },
    })).statusCode).toBe(403);

    // 财务支付
    const pay = await app.inject({
      method: 'POST', url: `/requests/${req.id}/pay`,
      headers: as(w.finance.id), payload: { eventId: 'http-pay-1' },
    });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().idempotent).toBe(false);

    // 重复回调 / 重复支付：幂等
    const payAgain = await app.inject({
      method: 'POST', url: `/requests/${req.id}/pay`,
      headers: as(w.finance.id), payload: { eventId: 'http-pay-1' },
    });
    expect(payAgain.json().idempotent).toBe(true);

    // 取消活动
    await app.inject({
      method: 'POST', url: `/activities/${activity.id}/cancel`,
      headers: as(w.finance.id), payload: { reason: '科技节停办' },
    });

    // 发起并批准退款
    const refund = await app.inject({
      method: 'POST', url: `/requests/${req.id}/refunds`,
      headers: as(), payload: { amountYuan: '300.00', reason: '活动取消全额退回' },
    });
    expect(refund.statusCode).toBe(200);
    const decision = await app.inject({
      method: 'POST', url: `/refunds/${refund.json().id}/decision`,
      headers: as(w.finance.id), payload: { decision: 'approve', eventId: 'http-ref-1' },
    });
    expect(decision.statusCode).toBe(200);

    bal = (await app.inject({ url: `/budgets/${budget.id}/balance`, headers: as(w.finance.id) })).json();
    expect(bal.paidCents).toBe(30000);
    expect(bal.refundedCents).toBe(30000);
    expect(bal.availableCents).toBe(50000);

    // 下钻
    const drill = (await app.inject({ url: `/budgets/${budget.id}/drilldown`, headers: as(w.finance.id) })).json();
    expect(drill.requests).toHaveLength(1);
    expect(drill.requests[0].refunds).toHaveLength(1);
    const types = drill.ledger.map((l: any) => l.entry_type).sort();
    expect(types).toEqual(['pay', 'refund', 'reserve']);

    // 审批链完好
    const chain = (await app.inject({ url: "/audit/approval-chain", headers: as(w.finance.id) })).json();
    expect(chain.ok).toBe(true);
  });

  it('超额占用返回 409，预算余额不被破坏', async () => {
    const res = await app.inject({
      method: 'POST', url: '/requests', headers: as(),
      payload: { activityId: activity.id, title: '超额', amountYuan: '600' },
    });
    const rid = res.json().id;
    const submit = await app.inject({ method: 'POST', url: `/requests/${rid}/submit`, headers: as() });
    expect(submit.statusCode).toBe(409);
    expect(submit.json().error).toBe('ACTIVITY_QUOTA_EXCEEDED');
    const bal = (await app.inject({ url: `/budgets/${budget.id}/balance`, headers: as(w.finance.id) })).json();
    expect(bal.reservedCents).toBe(0);
  });

  it('拆分发票触发疑似重复 -> 核对单确认 -> 财务支付被阻断直到核对', async () => {
    // 两个申请
    const r1 = (await app.inject({
      method: 'POST', url: '/requests', headers: as(),
      payload: { activityId: activity.id, title: '甲组展板', amountYuan: '100' },
    })).json();
    const r2 = (await app.inject({
      method: 'POST', url: '/requests', headers: as(w.leaderA2.id),
      payload: { activityId: activity.id, title: '乙组展板', amountYuan: '100' },
    })).json();
    for (const [rid, actor] of [[r1.id, w.leaderA.id], [r2.id, w.leaderA2.id]] as const) {
      await app.inject({ method: 'POST', url: `/requests/${rid}/submit`, headers: as(actor) });
      await app.inject({ method: 'POST', url: `/requests/${rid}/advisor-review`, headers: as(w.advisorA.id), payload: { decision: 'approve' } });
    }

    // 同一发票号+摘要分别引用
    await app.inject({
      method: 'POST', url: '/vouchers', headers: as(),
      payload: { voucherNo: 'FP-666', summary: '喷绘展板', amountYuan: '100', allocations: [{ requestId: r1.id, amountYuan: '100' }] },
    });
    const v2 = await app.inject({
      method: 'POST', url: '/vouchers', headers: as(w.leaderA2.id),
      payload: { voucherNo: 'FP-666', summary: '喷绘展板', amountYuan: '100', allocations: [{ requestId: r2.id, amountYuan: '100' }] },
    });
    const groupId = v2.json().duplicateGroup.groupId;
    expect(groupId).toBeTruthy();

    // 未核对不能支付
    const blocked = await app.inject({
      method: 'POST', url: `/requests/${r1.id}/pay`, headers: as(w.finance.id), payload: { eventId: 'b1' },
    });
    expect(blocked.statusCode).toBe(409);

    // 误报解除后可以支付
    await app.inject({
      method: 'POST', url: `/duplicate-groups/${groupId}/resolve`,
      headers: as(w.finance.id), payload: { resolution: 'cleared', note: '两联各一张' },
    });
    const ok = await app.inject({
      method: 'POST', url: `/requests/${r1.id}/pay`, headers: as(w.finance.id), payload: { eventId: 'b2' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('跨学期结转 API', async () => {
    Catalog.createBudget(db, { clubId: w.clubA.id, termId: w.termNext.id, amountCents: yuanToCents('100'), createdBy: w.finance.id });
    const res = await app.inject({
      method: 'POST', url: '/budgets/carry-over', headers: as(w.finance.id),
      payload: { clubId: w.clubA.id, fromTermId: w.term.id, toTermId: w.termNext.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().carriedCents).toBe(50000);
  });
});
