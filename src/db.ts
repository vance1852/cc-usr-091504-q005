import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------- organization ----------
CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student_leader','advisor','finance')),
  club_id INTEGER REFERENCES clubs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An advisor may advise several clubs; a club may have several advisors.
CREATE TABLE IF NOT EXISTS club_advisors (
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE IF NOT EXISTS semesters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Budgets are append-friendly: an 'initial' budget per club per semester,
-- plus 'carryover' rows produced when a previous semester is settled.
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  source TEXT NOT NULL DEFAULT 'initial' CHECK (source IN ('initial','carryover')),
  from_semester_id INTEGER REFERENCES semesters(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  name TEXT NOT NULL,
  quota_cents INTEGER NOT NULL CHECK (quota_cents > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- prepayment / advance requests ----------
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft','submitted','approved','paid','rejected','released','refunded'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  advisor_at TEXT,
  paid_at TEXT,
  released_at TEXT
);

-- Append-only audit trail. Triggers below physically forbid rewriting history.
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  action TEXT NOT NULL CHECK (action IN (
    'submit','advisor_approve','advisor_reject',
    'finance_pay','finance_reject','release',
    'refund_request','refund_approve','refund_reject'
  )),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS approvals_no_update
BEFORE UPDATE ON approvals BEGIN
  SELECT RAISE(ABORT, 'approvals are append-only');
END;
CREATE TRIGGER IF NOT EXISTS approvals_no_delete
BEFORE DELETE ON approvals BEGIN
  SELECT RAISE(ABORT, 'approvals are append-only');
END;

-- ---------- original vouchers & allocation splits ----------
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY,
  voucher_no TEXT NOT NULL,
  summary TEXT NOT NULL,
  norm_key TEXT NOT NULL,             -- dedup identity
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','under_review','invalid_duplicate','merged')),
  duplicate_of INTEGER REFERENCES vouchers(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vouchers_key ON vouchers(norm_key);

-- A legitimate split invoice = ONE voucher, several allocations whose
-- shares never sum past the face amount.
CREATE TABLE IF NOT EXISTS voucher_allocations (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  request_id INTEGER NOT NULL REFERENCES requests(id),
  share_cents INTEGER NOT NULL CHECK (share_cents > 0),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (voucher_id, request_id)
);

-- Suspected duplicates wait here for reconciliation; rows are never deleted.
CREATE TABLE IF NOT EXISTS duplicate_reviews (
  id INTEGER PRIMARY KEY,
  new_voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  existing_voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','cleared','confirmed_duplicate')),
  resolver_id INTEGER REFERENCES users(id),
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- ---------- refunds (chain) ----------
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  parent_refund_id INTEGER REFERENCES refunds(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','approved','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);

-- ---------- budget ledger (the traceable spine) ----------
-- Every movement is signed cents in the relevant bucket:
--   reserve : reserve_cents  +amount      (submission holds budget)
--   release : reserve_cents  -amount      (reject / cancel before payment)
--   pay     : reserve_cents  -amount, paid_cents +amount
--   refund  : refund_cents   +amount      (gross paid stays visible forever)
CREATE TABLE IF NOT EXISTS budget_entries (
  id INTEGER PRIMARY KEY,
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  request_id INTEGER REFERENCES requests(id),
  refund_id INTEGER REFERENCES refunds(id),
  kind TEXT NOT NULL CHECK (kind IN ('reserve','release','pay','refund')),
  reserve_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  actor_id INTEGER REFERENCES users(id),
  note TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_budget_entries_idem
  ON budget_entries(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budget_entries_scope
  ON budget_entries(semester_id, club_id, activity_id);

CREATE TABLE IF NOT EXISTS carryovers (
  id INTEGER PRIMARY KEY,
  from_semester_id INTEGER NOT NULL REFERENCES semesters(id),
  to_semester_id INTEGER NOT NULL REFERENCES semesters(id),
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  budget_id INTEGER REFERENCES budgets(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_semester_id, to_semester_id, club_id)
);

-- Stored results of idempotent finance callbacks (payments / refunds).
CREATE TABLE IF NOT EXISTS idempotent_ops (
  idempotency_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(filename: string): DB {
  if (filename !== ':memory:' && filename !== '') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/**
 * Run `fn` in a BEGIN IMMEDIATE transaction. The write lock is taken up
 * front, so two concurrent approvals serialize and the second one rechecks
 * balances against committed data instead of overcommitting.
 */
export function withImmediate<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
