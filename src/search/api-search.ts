/** API-level capability search (SPEC.md §17). */
import type { Database } from '../storage/database.js';
import type { ApiSearchResult } from '../services/types.js';
import { prepareQuery } from './query.js';
import { matchedTerms, normalizeScore, termCoverageBonus } from './ranking.js';

/**
 * Column weights for `api_fts`, in table order. The first column is UNINDEXED and can
 * never match, so its weight is irrelevant but must be supplied.
 *
 * SPEC.md §46: name/id highest, then aliases and the OpenAPI title, then tags and
 * description.
 */
const API_WEIGHTS = [0, 10, 8, 3, 5, 6, 2];

interface ApiRow {
  api_id: string;
  name: string;
  description: string | null;
  aliases_json: string;
  tags_json: string;
  title: string | null;
  spec_description: string | null;
  relevance: number;
}

export function searchApis(db: Database, query: string, limit: number): ApiSearchResult[] {
  const prepared = prepareQuery(query);
  if (!prepared.match) return [];

  // Over-fetch so the term-coverage re-rank has candidates to reorder.
  const candidateLimit = Math.min(Math.max(limit * 4, 20), 200);

  const rows = db
    .prepare(
      `SELECT
         f.api_id           AS api_id,
         a.name             AS name,
         a.description      AS description,
         a.aliases_json     AS aliases_json,
         a.tags_json        AS tags_json,
         v.info_title       AS title,
         v.info_description AS spec_description,
         -bm25(api_fts, ${API_WEIGHTS.join(', ')}) AS relevance
       FROM api_fts f
       JOIN apis a ON a.id = f.api_id
       LEFT JOIN api_versions v ON v.id = a.current_version_id
       WHERE api_fts MATCH ?
       ORDER BY relevance DESC
       LIMIT ?`,
    )
    .all(prepared.match, candidateLimit) as unknown as ApiRow[];

  const scored = rows.map((row) => {
    const fields = [
      row.api_id,
      row.name,
      row.description,
      row.title,
      row.spec_description,
      (JSON.parse(row.aliases_json || '[]') as string[]).join(' '),
      (JSON.parse(row.tags_json || '[]') as string[]).join(' '),
    ];
    const relevance = row.relevance + termCoverageBonus(fields, prepared.terms);
    return {
      api_id: row.api_id,
      name: row.name,
      description: row.description,
      score: normalizeScore(relevance),
      matched: matchedTerms(fields, [...prepared.terms, ...prepared.expansions]),
      relevance,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance || a.api_id.localeCompare(b.api_id));
  return scored.slice(0, limit).map(({ relevance: _relevance, ...rest }) => rest);
}
