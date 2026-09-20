import type { DB } from '../../src/db/db.js';
import * as Catalog from '../../src/services/catalog.js';
import { yuanToCents } from '../../src/domain/money.js';

export interface World {
  db: DB;
  clubA: any;
  clubB: any;
  leaderA: any;
  leaderA2: any;
  advisorA: any;
  leaderB: any;
  finance: any;
  term: any;
  termNext: any;
}

/** 构造标准测试世界：两个社团、学生负责人、指导老师、财务、学期 */
export function createWorld(db: DB, budgetYuan = 1000): World {
  const finance = Catalog.createUser(db, { id: 'u_fin', name: '财务小王', role: 'finance' });
  const advisorA = Catalog.createUser(db, { id: 'u_adv', name: '张指导', role: 'advisor' });
  const clubA = Catalog.createClub(db, '机器人社', advisorA.id);
  const leaderA = Catalog.createUser(db, { id: 'u_lead', name: '李负责人', role: 'student_leader', clubId: clubA.id });
  const leaderA2 = Catalog.createUser(db, { id: 'u_lead2', name: '王负责人', role: 'student_leader', clubId: clubA.id });

  const clubB = Catalog.createClub(db, '天文社');
  const leaderB = Catalog.createUser(db, { id: 'u_leadb', name: '赵负责人', role: 'student_leader', clubId: clubB.id });
  db.prepare('UPDATE users SET club_id = ? WHERE id = ?').run(clubA.id, advisorA.id);

  const term = Catalog.createTerm(db, { id: 't_2026s', name: '2026春季学期', seq: 1 });
  const termNext = Catalog.createTerm(db, { id: 't_2026f', name: '2026秋季学期', seq: 2 });

  return { db, clubA, clubB, leaderA, leaderA2, advisorA, leaderB, finance, term, termNext };
}

export function makeBudget(world: World, club: any, term: any, yuan: number): any {
  return Catalog.createBudget(world.db, {
    clubId: club.id,
    termId: term.id,
    amountCents: yuanToCents(String(yuan)),
    createdBy: world.finance.id,
  });
}

export function makeActivity(world: World, budget: any, name: string, quotaYuan: number): any {
  return Catalog.createActivity(world.db, {
    budgetId: budget.id,
    name,
    quotaCents: yuanToCents(String(quotaYuan)),
    createdBy: world.finance.id,
  });
}
