import type { DB } from '../db.js';

export interface User {
  id: number;
  name: string;
  role: 'student_leader' | 'advisor' | 'finance';
  club_id: number | null;
}

export function getUser(db: DB, userId: number): User {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
    | User
    | undefined;
  if (!row) throw new Error(`user ${userId} not found`);
  return row;
}

export function createClub(db: DB, name: string): number {
  const info = db.prepare('INSERT INTO clubs (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

export function createUser(
  db: DB,
  name: string,
  role: User['role'],
  clubId: number | null = null,
): number {
  if (role === 'student_leader' && clubId == null) {
    throw new Error('student leader must belong to a club');
  }
  const info = db
    .prepare('INSERT INTO users (name, role, club_id) VALUES (?, ?, ?)')
    .run(name, role, clubId);
  return Number(info.lastInsertRowid);
}

export function addAdvisor(db: DB, clubId: number, userId: number): void {
  db.prepare('INSERT OR IGNORE INTO club_advisors (club_id, user_id) VALUES (?, ?)').run(
    clubId,
    userId,
  );
}

export function isAdvisorOf(db: DB, userId: number, clubId: number): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM club_advisors WHERE club_id = ? AND user_id = ?')
      .get(clubId, userId),
  );
}

export function createSemester(db: DB, name: string): number {
  const info = db.prepare('INSERT INTO semesters (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

export function createBudget(
  db: DB,
  semesterId: number,
  clubId: number,
  amountCents: number,
  actorId: number | null,
  source: 'initial' | 'carryover' = 'initial',
  fromSemesterId: number | null = null,
): number {
  const info = db
    .prepare(
      `INSERT INTO budgets (semester_id, club_id, amount_cents, source, from_semester_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(semesterId, clubId, amountCents, source, fromSemesterId, actorId);
  return Number(info.lastInsertRowid);
}

export function createActivity(
  db: DB,
  clubId: number,
  semesterId: number,
  name: string,
  quotaCents: number,
  actorId: number,
): number {
  const info = db
    .prepare(
      `INSERT INTO activities (club_id, semester_id, name, quota_cents, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(clubId, semesterId, name, quotaCents, actorId);
  return Number(info.lastInsertRowid);
}

export function assertSemesterOpen(db: DB, semesterId: number): void {
  const row = db.prepare('SELECT status FROM semesters WHERE id = ?').get(semesterId) as
    | { status: string }
    | undefined;
  if (!row) throw new Error(`semester ${semesterId} not found`);
  if (row.status !== 'open') throw new Error('semester is closed');
}
