# How search works

Portolan's search layer answers two questions, both from natural language:

1. *Which registered API can do this?* — `find_api`
2. *Which operation in that API does it?* — `search_api`

It uses SQLite FTS5 with BM25 ranking. No embeddings, no external service — SPEC.md §60
rules them out for the MVP, and FTS keeps Portolan to a single file on disk.

## The index

Two FTS5 tables, both using the `porter unicode61` tokenizer so that `disable`,
`disabled` and `disabling` share a stem.

`api_fts` indexes the API id and name, aliases, description, tags, and the OpenAPI title
and description.

`operation_fts` indexes the canonical operation id, the source `operationId`, summary,
tags, path, description, parameter names and descriptions, and request/response property
and schema names.

Identifiers and paths are split before indexing, and the original is kept alongside the
split form: `UsersResource_updateUser` is indexed as
`UsersResource_updateUser Users Resource update User`, and
`/admin/realms/{realm}/users/{user-id}` as the literal path plus
`admin realms realm users user id`. Without this, an agent searching for "update user"
would never match an identifier written in camel case.

## Ranking

Three stages.

**1. BM25 with per-column weights.** The weights follow SPEC.md §46's table:

| Column | Weight |
| --- | --- |
| canonical operation id | 10 |
| summary | 10 |
| source `operationId` | 8 |
| tags | 6 |
| path | 4 |
| description | 2 |
| parameter names and descriptions | 1.5 |
| schema names | 0.5 |

**2. Query expansion.** BM25 is lexical: "disable a user" cannot match "deactivate an
account" on its own. A small, hand-audited synonym table (`src/search/query.ts`,
~25 entries, all domain-neutral API vocabulary) adds related terms to the candidate
query. This widens recall only — it does not on its own change the order.

**3. Term-coverage re-ranking.** Candidates are re-scored with a bonus proportional to
how many of the words the caller *actually typed* appear in the high-value fields. This
is what stops an expansion term from floating a weakly-related operation above an exact
match. Deprecated operations take a fixed penalty, so a live operation outranks a
deprecated sibling.

The final BM25-derived relevance is mapped into `(0, 1]` by `1 - e^(-r/4)`. The mapping
is fixed rather than relative to the result set, so scores are broadly comparable between
calls — but they are a ranking aid, not an absolute measure of relevance.

## Query safety

A caller's query is never passed to `MATCH` as syntax. FTS5 has its own query language
(`"`, `*`, `NEAR/3`, `AND`/`OR`/`NOT`, `column:`), so a raw agent-supplied string is at
best a syntax error and at worst a query-language injection. `prepareQuery` tokenizes on
non-alphanumeric boundaries, drops stop words, and re-quotes every token as an FTS5
string literal with `""` escaping. `test/unit/search-query.test.ts` asserts that a set of
hostile inputs come out inert.

## Known limits

- **Lexical, not semantic.** If a document uses vocabulary with no lexical overlap with
  the query and no entry in the synonym table, ranking will not find it. The synonym
  table is a bridge, not a substitute for embeddings.
- **Scores are not calibrated.** Treat them as an ordering, not a probability.
- **One API per `search_api` call.** Cross-API operation search is deliberately out of
  scope for the MVP (SPEC.md §59).

## Replacing it

`SearchProvider` (`src/services/types.ts`) is the seam SPEC.md §9 requires:

```ts
interface SearchProvider {
  searchApis(query: string, limit: number): Promise<ApiSearchResult[]>;
  searchOperations(apiId: string, query: string, limit: number, filters?): Promise<OperationSearchResult[]>;
}
```

`FtsSearchProvider` is the only implementation today. A hybrid BM25/vector provider can
replace it without touching the MCP layer, the catalog or the execution runtime — the
stored `operations.search_text`, `param_text` and `schema_text` columns already hold the
text an embedding pass would need.
