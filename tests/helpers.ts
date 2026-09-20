import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import * as org from '../src/services/org.js';

export interface Seeded {
  db: DB;
  semester: number;
  club: number;
  otherClub: number;
  leader: number;
  otherLeader: number;
  advisor: number;
  finance: number;
  /** convenience: a finance user who is also never an applicant */
}

/** Fresh in-memory world: two clubs, leaders, an advisor and finance. */
export function seedWorld(): Seeded {
  const db = openDb(':memory:');
  const club = org.createClub(db, '机器人社');
  const otherClub = org.createClub(db, '辩论社');
  const leader = org.createUser(db, '张社长', 'student_leader', club);
  const otherLeader = org.createUser(db, '李社长', 'student_leader', otherClub);
  const advisor = org.createUser(db, '王老师', 'advisor');
  org.addAdvisor(db, club, advisor);
  const finance = org.createUser(db, '赵财务', 'finance');
  const semester = org.createSemester(db, '2026春');
  return { db, semester, club, otherClub, leader, otherLeader, advisor, finance };
}

export function tempDbFile(): string {
  return join(tmpdir(), `club-funds-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

/** Catch helper for assertion style. */
export async function expectThrow<T>(p: Promise<T> | (() => T)): Promise<unknown> {
  try {
    const r = typeof p === 'function' ? (p as () => T)() : await p;
    throw new Error(`expected an error but got ${JSON.stringify(r)}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('expected an error')) throw err;
    return err;
  }
}

/** assert.throws predicate matching the stable machine code on AppError. */
export function errCode(code: string): (err: unknown) => boolean {
  return (err: unknown) => (err as { code?: string })?.code === code;
}
