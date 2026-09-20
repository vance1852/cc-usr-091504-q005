import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db/db.js';
import { createWorld, makeBudget, makeActivity, type World } from './helpers/world.js';
import * as Catalog from '../src/services/catalog.js';
import * as Requests from '../src/services/requests.js';
import { getBudgetBalance, drillDown } from '../src/services/ledger.js';
import { AppError } from '../src/domain/errors.js';

let db: DB;
let w: World;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'fin-'));
  db = openDb(join(dir, 'test.sqlite'));
  w = createWorld(db);
});

describe('跨学期结转', () => {
  it('上学期可用余额（新拨-净支出）结转到下学期，且结转幂等', () => {
    const spring = makeBudget(w, w.clubA, w.term, 1000);
    const act = makeActivity(w, spring, '春季活动', 1000);

    // 支付 300、退款 50 -> 净支出 250；占用必须全部结清
    const draft = Requests.createDraft(db, { activityId: act.id, actor: w.leaderA, title: '材料', amountCents: 30000 });
    Requests.submit(db, draft.id, w.leaderA);
    Requests.advisorReview(db, draft.id, w.advisorA, 'approve');
    Requests.financePay(db, draft.id, w.finance, { eventId: 'p1' });
    const rf = Requests.requestRefund(db, draft.id, w.leaderA, { amountCents: 5000, reason: '部分退回' });
    Requests.decideRefund(db, rf.id, w.finance, 'approve', { eventId: 'r1' });

    const fall = makeBudget(w, w.clubA, w.termNext, 800);

    const result = Catalog.carryOver(db, { clubId: w.clubA.id, fromTermId: w.term.id, toTermId: w.termNext.id });
    expect(result.carriedCents).toBe(75000); // 1000 - 250

    const sb = getBudgetBalance(db, spring.id);
    expect(sb.availableCents).toBe(0);
    expect(sb.carryOutCents).toBe(75000);

    const fb = getBudgetBalance(db, fall.id);
    expect(fb.carryInCents).toBe(75000);
    expect(fb.availableCents).toBe(155000); // 新拨 800 + 结转 750

    // 重复结转幂等：不产生第二条流水
    Catalog.carryOver(db, { clubId: w.clubA.id, fromTermId: w.term.id, toTermId: w.termNext.id });
    const fb2 = getBudgetBalance(db, fall.id);
    expect(fb2.carryInCents).toBe(75000);
    expect(fb2.availableCents).toBe(155000);
  });

  it('有未结清占用时不能结转', () => {
    const spring = makeBudget(w, w.clubA, w.term, 1000);
    const act = makeActivity(w, spring, '春季活动', 1000);
    makeBudget(w, w.clubA, w.termNext, 500);

    const draft = Requests.createDraft(db, { activityId: act.id, actor: w.leaderA, title: '悬而未决', amountCents: 10000 });
    Requests.submit(db, draft.id, w.leaderA);

    try {
      Catalog.carryOver(db, { clubId: w.clubA.id, fromTermId: w.term.id, toTermId: w.termNext.id });
      throw new Error('应当拒绝结转');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('INVALID_STATE');
    }
  });

  it('结转金额在下学期可继续用于占用与支付，并能下钻到来源', () => {
    const spring = makeBudget(w, w.clubA, w.term, 1000);
    const actS = makeActivity(w, spring, '春', 1000);
    const draft = Requests.createDraft(db, { activityId: actS.id, actor: w.leaderA, title: 'x', amountCents: 40000 });
    Requests.submit(db, draft.id, w.leaderA);
    Requests.advisorReview(db, draft.id, w.advisorA, 'approve');
    Requests.financePay(db, draft.id, w.finance, { eventId: 'p' });

    const fall = makeBudget(w, w.clubA, w.termNext, 0);
    Catalog.carryOver(db, { clubId: w.clubA.id, fromTermId: w.term.id, toTermId: w.termNext.id });

    const actF = makeActivity(w, fall, '秋', 600);
    const d2 = Requests.createDraft(db, { activityId: actF.id, actor: w.leaderA, title: '秋季材料', amountCents: 60000 });
    Requests.submit(db, d2.id, w.leaderA);
    Requests.advisorReview(db, d2.id, w.advisorA, 'approve');
    Requests.financePay(db, d2.id, w.finance, { eventId: 'p2' });

    const fb = getBudgetBalance(db, fall.id);
    expect(fb.availableCents).toBe(0); // 600 结转 - 600 支付

    const d = drillDown(db, fall.id);
    const carryIns = d.ledger.filter((l: any) => l.entry_type === 'carry_in');
    expect(carryIns).toHaveLength(1);
    expect(carryIns[0].carry_delta).toBe(60000);
  });
});
