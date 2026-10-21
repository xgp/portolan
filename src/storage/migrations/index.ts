/**
 * Schema migrations (SPEC.md §8, §9).
 *
 * Migrations are append-only: add a new entry, never edit an applied one. `user_version`
 * tracks the applied count.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE apis (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  aliases_json       TEXT NOT NULL DEFAULT '[]',
  tags_json          TEXT NOT NULL DEFAULT '[]',
  current_version_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE api_versions (
  id              TEXT PRIMARY KEY,
  api_id          TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
  openapi_version TEXT,
  info_version    TEXT,
  info_title      TEXT,
  info_description TEXT,
  spec_hash       TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  source_type     TEXT,
  source_uri      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_api_versions_api ON api_versions(api_id);
CREATE UNIQUE INDEX idx_api_versions_hash ON api_versions(api_id, spec_hash);

CREATE TABLE operations (
  id                  TEXT PRIMARY KEY,
  api_version_id      TEXT NOT NULL REFERENCES api_versions(id) ON DELETE CASCADE,
  canonical_id        TEXT NOT NULL,
  source_operation_id TEXT,
  method              TEXT NOT NULL,
  path                TEXT NOT NULL,
  summary             TEXT,
  description         TEXT,
  tags_json           TEXT NOT NULL DEFAULT '[]',
  deprecated          INTEGER NOT NULL DEFAULT 0,
  search_text         TEXT,
  param_text          TEXT,
  schema_text         TEXT,
  operation_json      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_operations_canonical ON operations(api_version_id, canonical_id);
CREATE INDEX idx_operations_version ON operations(api_version_id);

-- docs/DEVIATIONS.md D6: 'source' records who created the environment. Only 'config'
-- environments may carry credentials or allow mutations.
CREATE TABLE environments (
  id              TEXT PRIMARY KEY,
  api_id          TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  auth_profile    TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0,
  allow_mutations INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'spec',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_environments_name ON environments(api_id, name);

-- SPEC.md §9: FTS5 with the porter tokenizer so morphological variants of a verb
-- ("disable"/"disabled"/"disabling") share a stem. Contentless-external tables keep the
-- text in one place; we use ordinary content tables for simplicity and rebuild them
-- inside the import transaction.
CREATE VIRTUAL TABLE api_fts USING fts5(
  api_id UNINDEXED,
  name,
  aliases,
  description,
  tags,
  title,
  spec_description,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE operation_fts USING fts5(
  operation_row_id UNINDEXED,
  api_id UNINDEXED,
  canonical_id,
  source_operation_id,
  summary,
  tags,
  path,
  method UNINDEXED,
  description,
  parameters,
  schema_names,
  tokenize = 'porter unicode61'
);
`,
  },
  {
    version: 2,
    name: 'spec_corrections',
    sql: `
-- docs/DEVIATIONS.md D20/D21. The document as received is kept beside the corrected one
-- so a correction can be added or reverted without fetching the source again.
ALTER TABLE api_versions ADD COLUMN source_spec_json TEXT;

-- An upstream repository supplied through add_api. Configured repositories are read from
-- config.yaml at runtime and never stored.
ALTER TABLE apis ADD COLUMN upstream_repo TEXT;

CREATE TABLE spec_corrections (
  id                    TEXT PRIMARY KEY,
  api_id                TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
  origin                TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  fingerprint           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  patch_json            TEXT,
  status                TEXT NOT NULL,
  upstream_repo         TEXT,
  upstream_issue_url    TEXT,
  upstream_issue_status TEXT,
  upstream_issue_at     TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_spec_corrections_fingerprint ON spec_corrections(api_id, fingerprint);
CREATE INDEX idx_spec_corrections_issue ON spec_corrections(upstream_repo, upstream_issue_status);
`,
  },
];
