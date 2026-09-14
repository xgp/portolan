/** Persistence for `operations` (SPEC.md §8, §14). */
import type { Database } from '../database.js';
import type { OperationRecord } from './types.js';

type Row = Record<string, unknown>;

function toOperation(row: Row): OperationRecord {
  return {
    id: row.id as string,
    apiVersionId: row.api_version_id as string,
    canonicalId: row.canonical_id as string,
    sourceOperationId: (row.source_operation_id as string | null) ?? null,
    method: row.method as string,
    path: row.path as string,
    summary: (row.summary as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    tags: JSON.parse((row.tags_json as string) || '[]') as string[],
    deprecated: Boolean(row.deprecated),
    searchText: (row.search_text as string | null) ?? null,
    paramText: (row.param_text as string | null) ?? null,
    schemaText: (row.schema_text as string | null) ?? null,
    operationJson: row.operation_json as string,
  };
}

export class OperationRepository {
  constructor(private readonly db: Database) {}

  insertMany(operations: readonly OperationRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO operations
         (id, api_version_id, canonical_id, source_operation_id, method, path,
          summary, description, tags_json, deprecated, search_text, param_text,
          schema_text, operation_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const op of operations) {
      stmt.run(
        op.id,
        op.apiVersionId,
        op.canonicalId,
        op.sourceOperationId,
        op.method,
        op.path,
        op.summary,
        op.description,
        JSON.stringify(op.tags),
        op.deprecated ? 1 : 0,
        op.searchText,
        op.paramText,
        op.schemaText,
        op.operationJson,
      );
    }
  }

  countForVersion(apiVersionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM operations WHERE api_version_id = ?')
      .get(apiVersionId) as { n: number };
    return row.n;
  }

  listForVersion(apiVersionId: string): OperationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM operations WHERE api_version_id = ? ORDER BY path, method')
      .all(apiVersionId) as Row[];
    return rows.map(toOperation);
  }

  /**
   * Resolve an operation by canonical id, falling back to the source `operationId`
   * and to the `method:path` form so an agent that saw any of the three can call it.
   */
  findByIdentifier(apiVersionId: string, identifier: string): OperationRecord | null {
    const byCanonical = this.db
      .prepare('SELECT * FROM operations WHERE api_version_id = ? AND canonical_id = ?')
      .get(apiVersionId, identifier) as Row | undefined;
    if (byCanonical) return toOperation(byCanonical);

    const bySource = this.db
      .prepare(
        'SELECT * FROM operations WHERE api_version_id = ? AND source_operation_id = ? LIMIT 2',
      )
      .all(apiVersionId, identifier) as Row[];
    // Only accept the alias when it is unambiguous (SPEC.md §14).
    if (bySource.length === 1 && bySource[0]) return toOperation(bySource[0]);

    const match = /^([a-zA-Z]+):(.+)$/.exec(identifier);
    if (match?.[1] && match[2]) {
      const byMethodPath = this.db
        .prepare('SELECT * FROM operations WHERE api_version_id = ? AND method = ? AND path = ?')
        .get(apiVersionId, match[1].toUpperCase(), match[2]) as Row | undefined;
      if (byMethodPath) return toOperation(byMethodPath);
    }
    return null;
  }

  /** Cheap "did you mean" list for OPERATION_NOT_FOUND details (SPEC.md §25). */
  suggestIdentifiers(apiVersionId: string, limit = 5): string[] {
    const rows = this.db
      .prepare(
        'SELECT canonical_id FROM operations WHERE api_version_id = ? ORDER BY canonical_id LIMIT ?',
      )
      .all(apiVersionId, limit) as { canonical_id: string }[];
    return rows.map((r) => r.canonical_id);
  }
}
