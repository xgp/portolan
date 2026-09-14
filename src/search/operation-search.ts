/** Operation-level capability search within one API (SPEC.md §18, §46, §47). */
import type { Database } from '../storage/database.js';
import type { OperationSearchResult } from '../services/types.js';
import { prepareQuery } from './query.js';
import { normalizeScore, termCoverageBonus } from './ranking.js';

/**
 * Column weights for `operation_fts`, in table order:
 *   operation_row_id, api_id, canonical_id, source_operation_id, summary, tags,
 *   path, method, description, parameters, schema_names
 *
 * SPEC.md §46 weighting: operationId and summary high, tags high, path medium-high,
 * description medium, parameters medium, schema names lower.
 */
const OPERATION_WEIGHTS = [0, 0, 10, 8, 10, 6, 4, 0, 2, 1.5, 0.5];

interface OperationRow {
  operation_row_id: string;
  canonical_id: string;
  source_operation_id: string | null;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  tags_json: string;
  deprecated: number;
  relevance: number;
}

export interface OperationSearchFilters {
  tags?: string[];
  methods?: string[];
}

export function searchOperations(
  db: Database,
  apiId: string,
  query: string,
  limit: number,
  filters: OperationSearchFilters = {},
): OperationSearchResult[] {
  const prepared = prepareQuery(query);
  if (!prepared.match) return [];

  const candidateLimit = Math.min(Math.max(limit * 6, 40), 400);

  // The join to `operations` via `apis.current_version_id` is what keeps historical
  // versions out of search results (SPEC.md §43).
  const params: unknown[] = [prepared.match, apiId];
  let methodClause = '';
  if (filters.methods && filters.methods.length > 0) {
    const placeholders = filters.methods.map(() => '?').join(', ');
    methodClause = ` AND o.method IN (${placeholders})`;
    params.push(...filters.methods.map((m) => m.toUpperCase()));
  }
  params.push(candidateLimit);

  const rows = db
    .prepare(
      `SELECT
         o.id                  AS operation_row_id,
         o.canonical_id        AS canonical_id,
         o.source_operation_id AS source_operation_id,
         o.method              AS method,
         o.path                AS path,
         o.summary             AS summary,
         o.description         AS description,
         o.tags_json           AS tags_json,
         o.deprecated          AS deprecated,
         -bm25(operation_fts, ${OPERATION_WEIGHTS.join(', ')}) AS relevance
       FROM operation_fts f
       JOIN operations o ON o.id = f.operation_row_id
       JOIN apis a ON a.id = f.api_id AND a.current_version_id = o.api_version_id
       WHERE operation_fts MATCH ?
         AND f.api_id = ?${methodClause}
       ORDER BY relevance DESC
       LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as OperationRow[];

  const wantedTags = filters.tags?.map((t) => t.toLowerCase());

  const scored = rows
    .map((row) => {
      const tags = JSON.parse(row.tags_json || '[]') as string[];
      const fields = [
        row.canonical_id,
        row.source_operation_id,
        row.summary,
        row.path,
        tags.join(' '),
      ];
      let relevance = row.relevance + termCoverageBonus(fields, prepared.terms);
      // A deprecated operation is a worse answer than an equivalent live one.
      if (row.deprecated) relevance -= 2;
      return {
        operation_id: row.canonical_id,
        method: row.method,
        path: row.path,
        summary: row.summary,
        tags,
        deprecated: Boolean(row.deprecated),
        score: 0,
        relevance,
      };
    })
    .filter((row) =>
      wantedTags && wantedTags.length > 0
        ? row.tags.some((tag) => wantedTags.includes(tag.toLowerCase()))
        : true,
    );

  scored.sort((a, b) => b.relevance - a.relevance || a.operation_id.localeCompare(b.operation_id));
  return scored.slice(0, limit).map(({ relevance, ...rest }) => ({
    ...rest,
    score: normalizeScore(relevance),
  }));
}
