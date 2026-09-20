import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 8000');
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export type DB = Database.Database;

/** 在事务内执行 fn；SQLite 的立即事务串行化写入，天然防并发超额 */
export function withTransaction<T>(db: DB, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx.immediate();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
