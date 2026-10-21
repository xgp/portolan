/**
 * FTS5 index maintenance (SPEC.md §9, §46).
 *
 * Index writes always happen inside the caller's import transaction so that a failed
 * import can never leave the index describing a version that was rolled back.
 */
import type { Database } from '../database.js';
import {
  apiEnrichmentText,
  EnrichmentRepository,
  operationContentHash,
  operationEnrichmentText,
} from './enrichments.js';
import type { ApiRecord, ApiVersionRecord, OperationRecord } from './types.js';

export interface ApiIndexInput {
  api: ApiRecord;
  version: ApiVersionRecord;
}

/**
 * Text a coding agent generated for an API or operation (docs/DEVIATIONS.md D24) is
 * appended to the description and parameter columns. It only ever widens what a query
 * can match; the document itself, and what inspect_api reports as its descriptions, are
 * unchanged.
 */
export class SearchIndexRepository {
  private readonly enrichments: EnrichmentRepository;

  constructor(private readonly db: Database) {
    this.enrichments = new EnrichmentRepository(db);
  }

  reindexApi({ api, version }: ApiIndexInput): void {
    const enrichment = this.enrichments.get(api.id, 'api', version.specHash);
    this.db.prepare('DELETE FROM api_fts WHERE api_id = ?').run(api.id);
    this.db
      .prepare(
        `INSERT INTO api_fts (api_id, name, aliases, description, tags, title, spec_description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        api.id,
        // The id itself is a strong signal ("keycloak"), so it joins the name column.
        `${api.id} ${api.name}`,
        api.aliases.join(' '),
        joinText(api.description, enrichment && apiEnrichmentText(enrichment.payloadJson)),
        api.tags.join(' '),
        version.infoTitle ?? '',
        version.infoDescription ?? '',
      );
  }

  reindexOperations(apiId: string, operations: readonly OperationRecord[]): void {
    this.db.prepare('DELETE FROM operation_fts WHERE api_id = ?').run(apiId);
    const enrichments = this.enrichments.mapForApi(apiId, 'operation');
    const stmt = this.db.prepare(
      `INSERT INTO operation_fts
         (operation_row_id, api_id, canonical_id, source_operation_id, summary, tags,
          path, method, description, parameters, schema_names)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const op of operations) {
      const enrichment = enrichments.get(operationContentHash(op.operationJson));
      const generated = enrichment ? operationEnrichmentText(enrichment.payloadJson) : undefined;
      stmt.run(
        op.id,
        apiId,
        // `users.update` and `UsersResource_updateUser` only tokenize usefully once split.
        splitIdentifier(op.canonicalId),
        op.sourceOperationId ? splitIdentifier(op.sourceOperationId) : '',
        op.summary ?? '',
        op.tags.join(' '),
        splitPath(op.path),
        op.method,
        joinText(op.description, generated?.description),
        joinText(op.paramText, generated?.parameters),
        op.schemaText ?? '',
      );
    }
  }

  removeApi(apiId: string): void {
    this.db.prepare('DELETE FROM api_fts WHERE api_id = ?').run(apiId);
    this.db.prepare('DELETE FROM operation_fts WHERE api_id = ?').run(apiId);
  }
}

function joinText(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Split an identifier into searchable words while keeping the original intact, so both
 * `UsersResource_updateUser` and `update user` match.
 */
export function splitIdentifier(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return [identifier, ...words].join(' ');
}

/** `/admin/realms/{realm}/users/{user-id}` -> `admin realms realm users user id`. */
export function splitPath(path: string): string {
  const words = path
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .flatMap((segment) => {
      const split = segment
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/\s+/)
        .filter(Boolean);
      return split.length > 1 ? [segment, ...split] : [segment];
    });
  return [path, ...words].join(' ');
}
