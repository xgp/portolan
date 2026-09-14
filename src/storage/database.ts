/**
 * SQLite access (SPEC.md §8).
 *
 * Uses Node's built-in `node:sqlite` (see docs/DEVIATIONS.md D1): synchronous, FTS5 and
 * bm25() included, no native build step.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expandPath } from '../config/config.js';
import { PortolanError } from '../errors/errors.js';
import { MIGRATIONS } from './migrations/index.js';

export type Database = DatabaseSync;

export interface OpenDatabaseOptions {
  /** `:memory:` is accepted verbatim; everything else is `~`-expanded and created. */
  path: string;
}

export function openDatabase({ path }: OpenDatabaseOptions): Database {
  const location = path === ':memory:' ? path : expandPath(path);
  if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });

  const db = new DatabaseSync(location);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  assertFts5(db);
  migrate(db);
  return db;
}

/** FTS5 is a hard requirement (SPEC.md §6). Fail loudly at open time, not at query time. */
export function assertFts5(db: Database): void {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __fts5_probe USING fts5(x)');
    db.exec('DROP TABLE IF EXISTS __fts5_probe');
  } catch (cause) {
    throw new PortolanError(
      'INTERNAL_ERROR',
      'This SQLite build does not support FTS5, which Portolan requires for search.',
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export function migrate(db: Database): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const applied = row?.user_version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new PortolanError(
        'INTERNAL_ERROR',
        `Migration ${migration.version} (${migration.name}) failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE`/`COMMIT`, rolling back on any throw.
 * SPEC.md §10 requires imports to be atomic; this is how.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
