/** Persistence for `enrichments` (docs/DEVIATIONS.md D24). */
import { createHash } from 'node:crypto';
import type { Database } from '../database.js';
import { nowIso } from '../database.js';
import type {
  ApiEnrichmentPayload,
  EnrichmentRecord,
  EnrichmentTarget,
  OperationEnrichmentPayload,
} from './types.js';

/** The key an operation's enrichment is stored under: a hash of what the agent saw. */
export function operationContentHash(operationJson: string): string {
  return createHash('sha256').update(operationJson).digest('hex');
}

/** Generated text, split the way the FTS columns are, for the search index. */
export function operationEnrichmentText(payloadJson: string): {
  description: string;
  parameters: string;
} {
  const payload = JSON.parse(payloadJson) as OperationEnrichmentPayload;
  return {
    description: payload.description ?? '',
    parameters: [
      ...Object.values(payload.parameters ?? {}),
      ...Object.values(payload.fields ?? {}),
    ].join(' '),
  };
}

export function apiEnrichmentText(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as ApiEnrichmentPayload;
  return [payload.description ?? '', ...(payload.keywords ?? [])].join(' ');
}

type Row = Record<string, unknown>;

function toEnrichment(row: Row): EnrichmentRecord {
  return {
    apiId: row.api_id as string,
    target: row.target as EnrichmentTarget,
    contentHash: row.content_hash as string,
    canonicalId: (row.canonical_id as string | null) ?? null,
    payloadJson: row.payload_json as string,
    agent: row.agent as string,
    createdAt: row.created_at as string,
  };
}

export class EnrichmentRepository {
  constructor(private readonly db: Database) {}

  upsert(record: Omit<EnrichmentRecord, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO enrichments
           (api_id, target, content_hash, canonical_id, payload_json, agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (api_id, target, content_hash) DO UPDATE SET
           canonical_id = excluded.canonical_id,
           payload_json = excluded.payload_json,
           agent = excluded.agent,
           created_at = excluded.created_at`,
      )
      .run(
        record.apiId,
        record.target,
        record.contentHash,
        record.canonicalId,
        record.payloadJson,
        record.agent,
        nowIso(),
      );
  }

  get(apiId: string, target: EnrichmentTarget, contentHash: string): EnrichmentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM enrichments WHERE api_id = ? AND target = ? AND content_hash = ?')
      .get(apiId, target, contentHash) as Row | undefined;
    return row ? toEnrichment(row) : null;
  }

  /** Content hash → record, for every enrichment of `target` an API has. */
  mapForApi(apiId: string, target: EnrichmentTarget): Map<string, EnrichmentRecord> {
    const rows = this.db
      .prepare('SELECT * FROM enrichments WHERE api_id = ? AND target = ?')
      .all(apiId, target) as Row[];
    return new Map(rows.map((row) => [row.content_hash as string, toEnrichment(row)]));
  }
}
