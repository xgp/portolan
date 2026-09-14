/** Persistence for `apis` and `api_versions` (SPEC.md §8, §43, §44). */
import type { Database } from '../database.js';
import { nowIso } from '../database.js';
import type { ApiRecord, ApiVersionRecord } from './types.js';

type Row = Record<string, unknown>;

function toApi(row: Row): ApiRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    aliases: JSON.parse((row.aliases_json as string) || '[]') as string[],
    tags: JSON.parse((row.tags_json as string) || '[]') as string[],
    currentVersionId: (row.current_version_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toVersion(row: Row): ApiVersionRecord {
  return {
    id: row.id as string,
    apiId: row.api_id as string,
    openapiVersion: (row.openapi_version as string | null) ?? null,
    infoVersion: (row.info_version as string | null) ?? null,
    infoTitle: (row.info_title as string | null) ?? null,
    infoDescription: (row.info_description as string | null) ?? null,
    specHash: row.spec_hash as string,
    specJson: row.spec_json as string,
    sourceType: (row.source_type as 'url' | 'content' | null) ?? null,
    sourceUri: (row.source_uri as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export class ApiRepository {
  constructor(private readonly db: Database) {}

  get(apiId: string): ApiRecord | null {
    const row = this.db.prepare('SELECT * FROM apis WHERE id = ?').get(apiId) as Row | undefined;
    return row ? toApi(row) : null;
  }

  list(): ApiRecord[] {
    const rows = this.db.prepare('SELECT * FROM apis ORDER BY id').all() as Row[];
    return rows.map(toApi);
  }

  upsert(input: {
    id: string;
    name: string;
    description: string | null;
    aliases: string[];
    tags: string[];
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO apis (id, name, description, aliases_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           aliases_json = excluded.aliases_json,
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.description,
        JSON.stringify(input.aliases),
        JSON.stringify(input.tags),
        now,
        now,
      );
  }

  setCurrentVersion(apiId: string, versionId: string): void {
    this.db
      .prepare('UPDATE apis SET current_version_id = ?, updated_at = ? WHERE id = ?')
      .run(versionId, nowIso(), apiId);
  }

  /** SPEC.md §44: an identical specification must not create a new version. */
  findVersionByHash(apiId: string, specHash: string): ApiVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM api_versions WHERE api_id = ? AND spec_hash = ?')
      .get(apiId, specHash) as Row | undefined;
    return row ? toVersion(row) : null;
  }

  getVersion(versionId: string): ApiVersionRecord | null {
    const row = this.db.prepare('SELECT * FROM api_versions WHERE id = ?').get(versionId) as
      Row | undefined;
    return row ? toVersion(row) : null;
  }

  /** The version `find_api`/`search_api`/`call_api` operate on (SPEC.md §43). */
  getCurrentVersion(apiId: string): ApiVersionRecord | null {
    const row = this.db
      .prepare(
        `SELECT v.* FROM api_versions v
         JOIN apis a ON a.current_version_id = v.id
         WHERE a.id = ?`,
      )
      .get(apiId) as Row | undefined;
    return row ? toVersion(row) : null;
  }

  listVersions(apiId: string): ApiVersionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_versions WHERE api_id = ? ORDER BY created_at DESC')
      .all(apiId) as Row[];
    return rows.map(toVersion);
  }

  insertVersion(
    version: Omit<ApiVersionRecord, 'createdAt'> & { createdAt?: string },
  ): ApiVersionRecord {
    const createdAt = version.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO api_versions
           (id, api_id, openapi_version, info_version, info_title, info_description,
            spec_hash, spec_json, source_type, source_uri, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.apiId,
        version.openapiVersion,
        version.infoVersion,
        version.infoTitle,
        version.infoDescription,
        version.specHash,
        version.specJson,
        version.sourceType,
        version.sourceUri,
        createdAt,
      );
    return { ...version, createdAt };
  }
}
