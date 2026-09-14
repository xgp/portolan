/** Persistence for `environments` (SPEC.md §8, §28). */
import { createHash } from 'node:crypto';
import type { Database } from '../database.js';
import { nowIso } from '../database.js';
import type { EnvironmentRecord, EnvironmentSource } from './types.js';

type Row = Record<string, unknown>;

function toEnvironment(row: Row): EnvironmentRecord {
  return {
    id: row.id as string,
    apiId: row.api_id as string,
    name: row.name as string,
    baseUrl: row.base_url as string,
    authProfile: (row.auth_profile as string | null) ?? null,
    isDefault: Boolean(row.is_default),
    allowMutations: Boolean(row.allow_mutations),
    source: row.source as EnvironmentSource,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Deterministic id; length-prefixed so no api id / name pair can collide with another. */
export function environmentId(apiId: string, name: string): string {
  return createHash('sha256').update(`${apiId.length}:${apiId}:${name}`).digest('hex').slice(0, 32);
}

export class EnvironmentRepository {
  constructor(private readonly db: Database) {}

  list(apiId: string): EnvironmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM environments WHERE api_id = ? ORDER BY is_default DESC, name')
      .all(apiId) as Row[];
    return rows.map(toEnvironment);
  }

  get(apiId: string, name: string): EnvironmentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM environments WHERE api_id = ? AND name = ?')
      .get(apiId, name) as Row | undefined;
    return row ? toEnvironment(row) : null;
  }

  getDefault(apiId: string): EnvironmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM environments WHERE api_id = ?
         ORDER BY is_default DESC, (name = 'default') DESC, name LIMIT 1`,
      )
      .get(apiId) as Row | undefined;
    return row ? toEnvironment(row) : null;
  }

  upsert(env: Omit<EnvironmentRecord, 'id' | 'createdAt' | 'updatedAt'>): EnvironmentRecord {
    const now = nowIso();
    const id = environmentId(env.apiId, env.name);
    this.db
      .prepare(
        `INSERT INTO environments
           (id, api_id, name, base_url, auth_profile, is_default, allow_mutations, source,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(api_id, name) DO UPDATE SET
           base_url = excluded.base_url,
           auth_profile = excluded.auth_profile,
           is_default = excluded.is_default,
           allow_mutations = excluded.allow_mutations,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        env.apiId,
        env.name,
        env.baseUrl,
        env.authProfile,
        env.isDefault ? 1 : 0,
        env.allowMutations ? 1 : 0,
        env.source,
        now,
        now,
      );
    return { ...env, id, createdAt: now, updatedAt: now };
  }

  /**
   * Create an environment only if none with that name exists. Environments derived from
   * an imported specification must never overwrite a configured one
   * (docs/DEVIATIONS.md D6).
   */
  insertIfAbsent(env: Omit<EnvironmentRecord, 'id' | 'createdAt' | 'updatedAt'>): boolean {
    if (this.get(env.apiId, env.name)) return false;
    this.upsert(env);
    return true;
  }

  /**
   * Clear the default flag on environments Portolan derived itself. Called when
   * configuration defines a default for the API: configured values are authoritative
   * (SPEC.md §28), so a specification-derived environment must not stay the default.
   */
  clearDerivedDefaults(apiId: string): void {
    this.db
      .prepare(
        "UPDATE environments SET is_default = 0, updated_at = ? WHERE api_id = ? AND source != 'config'",
      )
      .run(nowIso(), apiId);
  }

  /** Remove environments that came from config but are no longer configured. */
  deleteConfigEnvironmentsNotIn(apiId: string, keepNames: readonly string[]): void {
    for (const env of this.list(apiId)) {
      if (env.source === 'config' && !keepNames.includes(env.name)) {
        this.db.prepare('DELETE FROM environments WHERE id = ?').run(env.id);
      }
    }
  }
}
