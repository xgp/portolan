# Spec review: conflicts, ambiguities and deliberate deviations

`SPEC.md` is the product and architectural source of truth. This document records every
place the implementation knowingly differs from it, plus spec points that were
underspecified and had to be decided. It is written adversarially on purpose: several of
the items below are cases where following the spec literally would have weakened a
security boundary or produced something that cannot work.

Nothing here reduces a security boundary described in the spec. Three items (D5, D6, D7)
_strengthen_ boundaries the spec leaves open.

Items are grouped by theme rather than numbered in order; the identifiers are stable
references used from code comments and commit messages.

---

## Security findings in the spec itself

### D5 — `add_api(auth_profile=...)` is a credential-exfiltration primitive (**deviation**)

_Spec:_ §16 lets the MCP `add_api` tool take `default_base_url` and `auth_profile`.
§28 says an environment binds a base URL to an auth profile.

_Problem:_ Those two inputs together let a model (or anything that can influence a model)
create an environment pointing at an **attacker-controlled base URL** and attach an
**existing, named, server-side credential** to it. Portolan then faithfully sends
`Authorization: Bearer <real secret>` to the attacker's host. The agent never sees the
credential — §3.5 is satisfied — and the secret still leaves the building. This defeats
the entire point of keeping credentials out of model context.

_Deviation:_

1. `auth_profile` supplied through the MCP `add_api` tool is **rejected by default** with
   `AUTH_PROFILE_BINDING_NOT_ALLOWED`. The error message explains that profiles are bound
   to environments in `config.yaml`. It can be re-enabled with
   `security.allow_agent_auth_profile_binding: true` for single-user local setups.
2. An auth profile may declare `allowed_hosts`. If present, the profile refuses to sign a
   request whose resolved destination host is not on that list — a second, independent
   check that survives any mistake in environment resolution.
3. Environments defined in `config.yaml` are authoritative. An import creates an
   environment only if none of that name exists, and the configured definition is
   re-applied after every import — so `add_api` can never re-point or re-credential a
   configured environment, whether the API was registered before or after startup.

### D6 — environments created from a specification must not inherit trust (**deviation/clarification**)

_Spec:_ §28 says an environment "may be created from an OpenAPI `servers` entry during
import". §29 says mutations default to `false`.

_Problem:_ §29's default is stated but the interaction with import is not. An imported
third-party document should never be able to widen anything.

_Deviation:_ environments created from `servers` or from `add_api`'s `default_base_url`
are recorded with `source = 'spec' | 'add_api'` and always get `allow_mutations = 0` and
no auth profile. Only `config.yaml` (`source = 'config'`) can set `allow_mutations: true`
or attach credentials. The `environments` table therefore carries one extra column,
`source`, beyond §8.

### D7 — SSRF checks are check-then-connect and are racy (**deviation, strengthening**)

_Spec:_ §12 and §30 require rejecting loopback/link-local/private/metadata addresses.

_Problem:_ the obvious implementation (resolve the hostname, check the IPs, then call
`fetch`) has a TOCTOU hole: DNS is re-resolved by the HTTP stack and an attacker
controlling the record can return a public IP for the check and `169.254.169.254` for the
connection (DNS rebinding). The spec's wording does not rule this out.

_Deviation:_ Portolan resolves the hostname itself, validates **every** returned address,
and then pins the connection to a validated address via an `undici` agent with a custom
`lookup`. The TLS SNI and `Host` header keep the original hostname, so certificate
validation and virtual hosting still work, but the socket cannot be redirected to an
address that was never checked. The same pinned path is used for spec fetching, remote
`$ref` resolution, OAuth2 token requests, and API calls.

---

## Library and platform choices the spec left open or named loosely

### D1 — SQLite driver: `node:sqlite` rather than `better-sqlite3`

_Spec:_ §6 says "SQLite" and "SQLite FTS5" without naming a driver.

_Decision:_ use Node's built-in `node:sqlite`. It is synchronous (same programming model
as `better-sqlite3`), ships FTS5 and `bm25()`, and needs **no native compilation** — which
removes a build toolchain from the Docker image and from CI. Requires Node >= 24.

### D2 — MCP package

_Spec:_ §6 names `@modelcontextprotocol/server` v2 targeting MCP `2026-07-28`.

_Verified and used as specified_: `@modelcontextprotocol/server@2.0.0` exports `McpServer`,
`serveStdio` (stdio binding) and `createMcpHandler` (Streamable HTTP, web-standard
`fetch`). `@modelcontextprotocol/client@2.0.0` drives the MCP end-to-end tests. No
deviation.

### D3 — OpenAPI tooling

_Spec:_ §6, "prefer existing maintained libraries".

_Decision:_ `@apidevtools/json-schema-ref-parser` for `$ref` bundling and
`@readme/openapi-parser` for OpenAPI 3.0 **and 3.1** structural validation (the original
`swagger-parser` does not validate 3.1 properly). Both are driven with filesystem
resolution disabled and a custom HTTP resolver wired to Portolan's SSRF-safe fetch — see
D7. `yaml` for YAML, `ajv`/`ajv-formats` for request validation.

### D11 — `bundle()` not `dereference()`, and what `inspect_api` must therefore return

_Spec:_ §45 permits retaining `$ref` "where necessary for recursive types"; §19 says
"Do not return unrelated schemas".

_Problem:_ full dereferencing cannot represent a recursive schema (infinite expansion),
and the spec explicitly requires recursive schemas as an import fixture (§52). But if the
stored model keeps internal `$ref`s, a naive `inspect_api` hands the agent a `$ref` it has
no way to resolve, because it never sees the whole document.

_Decision:_ external references are **bundled** into `#/components/...`; internal
references are retained. `inspect_api` computes the **transitive closure** of the internal
`$ref`s actually reachable from the returned operation and includes only those under a
`components` key. Unrelated schemas are never returned, recursion terminates, and the
agent can resolve every pointer it is given.

---

## Things the spec asks for that need qualification

### D4 — "disable a user" ranking cannot come from BM25 alone

_Spec:_ §47 asks that `search_api("disable user")` rank _update user_ above _delete user_;
§60 forbids embeddings for MVP.

_Problem:_ BM25 is purely lexical. If the word "disable" does not appear in the update
operation's text, no amount of weight tuning ranks it first. The spec's own example is
only satisfiable with either semantics or a lexical bridge.

_Decision (addition, not deviation):_ three cheap lexical measures, all inside the
`SearchProvider` interface §9 mandates so they can be swapped for embeddings later:

1. the FTS5 `porter` tokenizer, so `disabling`/`disabled`/`disable` share a stem;
2. per-column `bm25()` weights matching the §46 weighting table;
3. a small static, domain-neutral synonym table (`disable → deactivate/enabled/suspend`,
   `remove → delete`, and ~20 more) used for query expansion only. Expanded terms are
   scored at a lower weight than the terms the caller actually typed.

No embeddings, no external infrastructure, no LLM calls. `docs/SEARCH.md` records the
ranking model and its limits. The ranking fixtures required by §47 are real.

### D13 — `score` semantics

_Spec:_ §17/§18 show `"score": 0.94`.

_Clarification:_ SQLite's `bm25()` returns an unbounded negative number where more
negative is better. Portolan maps it monotonically into `(0, 1]` with the fixed transform
`1 - e^(-r/4)`. The mapping does not depend on the result set, so scores are broadly
comparable between calls — but they are a ranking aid, not a calibrated relevance
measure. `docs/SEARCH.md` says so.

### D10 — OpenAPI 3.0 schemas are not JSON Schema

_Spec:_ §23, "prefer AJV… normalize schema differences necessary for validation… do not
reject valid OpenAPI behavior".

_Decision:_ 3.0 schemas are converted before validation — `nullable: true` becomes a type
union, boolean `exclusiveMinimum`/`exclusiveMaximum` become numeric, and annotation-only
keywords (`example`, `xml`, `discriminator`, `externalDocs`, `deprecated`) are stripped.
3.1 schemas are validated with AJV 2020-12 directly. Both AJV instances run
`strict: false` so unknown vendor keywords annotate rather than fail.

### D12 — `run_api_code` has no fallback when Deno is absent

_Spec:_ §34 forbids `eval`, `new Function` and "Node `vm` as the sole security boundary",
and mandates a separate Deno process.

_Decision:_ Deno is a **hard requirement** for `run_api_code` only. If the binary is
missing, `run_api_code` returns `SANDBOX_UNAVAILABLE` (a code added to §25's list) and the
other five tools keep working. There is deliberately no in-process fallback, because any
fallback would be exactly the boundary the spec forbids.

Inside the sandbox the user's code is compiled with `AsyncFunction`. That is not a
security boundary and is not relied on as one — the Deno process, started with every
permission explicitly denied, is the boundary. Before the user's code runs, the runtime
deletes `Deno`, `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `Worker` and
`navigator` from the sandbox global, so the script has no capability object to reach for
even in the absence of permissions.

### D14 — two different response limits

_Spec:_ §37 gives `max_response_bytes` and `max_tool_response_bytes` without saying how
they compose.

_Decision:_ `max_response_bytes` caps bytes read off the wire (the read is abandoned at
the cap and the body marked `truncated`). `max_tool_response_bytes` caps the serialized
MCP tool payload and is applied last, after assembly; when it trips, the body is replaced
with a truncation marker while `status`, `headers` and `content_type` survive, per §37.
In `run_api_code` a third limit, `sandbox_max_total_response_bytes`, caps the _cumulative_
bytes a single script may pull, per §35.

### D15 — error transport

_Spec:_ §25 defines an error envelope but not how it reaches the client.

_Decision:_ tool-level failures are returned as MCP tool results with `isError: true`
whose content is the §25 envelope (and the same object as `structuredContent`), not as
JSON-RPC protocol errors. Agents can read and recover from them; JSON-RPC errors are
reserved for protocol-level faults.

### D16 — unknown configuration keys

_Spec:_ §39 says unknown _security-sensitive_ keys should error.

_Decision:_ **all** unknown keys error. "Security-sensitive" is not knowable at parse
time, and a silently-ignored typo in `allow_private_addresses` is precisely the failure
mode the clause exists to prevent.

### D17 — HTTP transport binding

_Spec:_ §40, "do not expose an unauthenticated HTTP server on non-loopback addresses by
default".

_Decision:_ binding a non-loopback host without `server.http.auth_token_env` is a startup
error. When a token is configured, every request must present
`Authorization: Bearer <token>` (compared in constant time). Origin and Host headers are
validated against the bind address on every request (DNS-rebinding protection) regardless
of binding.

### D18 — `node:sqlite` and transactions

_Spec:_ §10, "the import must be transactional".

_Decision:_ imports run inside `BEGIN IMMEDIATE` / `COMMIT` with rollback on any failure,
including FTS index rebuild, so a failed import can never leave `current_version_id`
pointing at a half-written version.

---

## Smaller decisions made where the spec was silent

| Area                        | Decision                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FTS5 `MATCH` injection      | User queries are tokenized and re-quoted; raw query syntax never reaches `MATCH`. A query of `"` or `NEAR/` cannot produce a syntax error or alter the query.                                            |
| `search_api` filters        | `tags`/`methods` (§18) are applied as SQL filters after FTS matching, not folded into the MATCH expression.                                                                                              |
| Historical versions         | Retained (§43) and excluded from search by joining on `apis.current_version_id`.                                                                                                                         |
| Duplicate spec detection    | SHA-256 over the canonically-serialized normalized document (§44); identical content returns `status: "unchanged"` without a new version.                                                                |
| `operations.id`             | `sha256(api_version_id + canonical_id)`, so it is deterministic between identical imports (§14).                                                                                                         |
| Cookie auth in query/header | Supported per §27; cookie values are URL-encoded and merged into one `Cookie` header.                                                                                                                    |
| Redacted headers            | `set-cookie`, `authorization`, `proxy-authorization`, `www-authenticate`, `proxy-authenticate` are dropped from returned responses (§24 plus the two challenge headers, which echo credential material). |
| URL sanitization            | Userinfo is stripped and any query parameter whose name matches a configured `api_key` query parameter is replaced with `REDACTED` before a URL is returned or logged (§24).                             |
| Retries                     | None, for any method (§48). `Retry-After` is surfaced to the agent verbatim in the response headers; Portolan never sleeps on it.                                                                        |
| Request IDs                 | One ULID-ish id per MCP tool call, propagated to sandbox RPC and to every outbound HTTP call, present on every log line (§57).                                                                           |
| `limit` clamping            | Out-of-range `limit` values are clamped to the §17/§18 maxima rather than rejected.                                                                                                                      |

### D19 — duplicate `operationId` must import, not fail

_Spec:_ §14 defines a fallback for duplicated `operationId`s; §16 lists "duplicate
operationIds" as a _warning_; §52 requires a duplicate-`operationId` import fixture.

_Problem:_ a duplicate `operationId` is a conformance violation, and the OpenAPI
validator rejects the document outright — which would make three parts of the spec
impossible to satisfy at once.

_Decision:_ that specific validator finding is demoted to a warning and the import
proceeds with `method:path` identifiers, exactly as §14 prescribes. Every other
validation failure still rejects the document. The demotion list is a single explicit
pattern in `src/openapi/parser.ts`, not a blanket "continue on error" mode.

---

## Correcting specifications ([issue #1](https://github.com/xgp/portolan/issues/1))

§3.3 makes the OpenAPI document authoritative, and documents in the wild are wrong often
enough to matter: undeclared path parameters, schemas that do not match real responses,
missing query parameters. The spec has no feedback path for that. An agent that notices
can only work around the flaw on every call, and a document that a strict validator
rejects for a trivial reason cannot be imported at all. D20–D22 add that feedback path
without changing the six-tool surface.

### D20 — `add_api` corrects a registered document (**addition**)

_Spec:_ §16 defines `add_api` as import-only, and it requires a document.

_Addition:_ `add_api` takes `issue {title, description}`, `patches` (RFC 6902 JSON
Patch), `revert_corrections` and `upstream_repo`. When an `api_id` is given with no
`spec_url` or `spec_content`, Portolan corrects the registered API in place. It re-derives
the document from the copy it stored on import (`api_versions.source_spec_json`) and
creates a new version with `status: "corrected"`.

The stored document is always derived, never edited in place: the document as received,
then the D21 repairs, then every active agent correction in the order it was made.
Corrections live in `spec_corrections`, keyed by API, so they outlive any one version.

- A re-import from upstream replays every correction. One that no longer applies (a
  `test` operation fails, or its target has moved) is marked `stale` with a warning
  rather than failing the import, since the upstream document has probably fixed it.
- A patch that does not apply when submitted, or that yields an invalid document, is
  refused with `SPEC_PATCH_INVALID` (a code added to §25's list), and nothing changes.
- A replayed correction can break validation of a new upstream document. Portolan then
  re-applies the corrections one at a time, validating after each, and marks the
  offenders `stale`. Each correction costs one validation, so this only runs when the
  whole document has already failed.
- An identical resubmission is the same correction (it is fingerprinted by the patch),
  not a duplicate.
- Returning to a document the API has already had, by reverting a correction or by
  re-importing an older upstream version, reuses that version instead of violating the
  unique `(api_id, spec_hash)` index.
- An `issue` without `patches` records a flaw Portolan cannot fix (`reported`) so it can
  still be raised upstream.

_Why `add_api` and not a seventh tool:_ §3.2 is explicit that the surface is six tools,
and `add_api` already owns the content of the library.

_Security:_ this adds no capability. `add_api(replace=true)` already lets an agent
replace a document wholesale, and nothing in a document can widen trust: base URLs come
from environments, credentials from configuration, mutation rights from configuration
(D5, D6).

### D21 — structural flaws with one correct fix are repaired on import (**addition**, extends D19)

_Spec:_ §10 requires validation and rejects invalid documents. D19 already demotes
duplicate `operationId`s to a warning.

_Problem:_ a common class of validator failure has exactly one reasonable fix, and
refusing the whole document over it helps nobody.

_Decision:_ `src/openapi/repairs.ts` repairs, before validation:

| Flaw                                                           | Repair                                 |
| -------------------------------------------------------------- | -------------------------------------- |
| path variable `{x}` with no `in: path` declaration             | declare it as a required string        |
| one undeclared variable plus one non-matching declaration      | rename the declaration                 |
| `in: path` declaration with no matching `{x}` in the path      | remove it (it could never be sent)     |
| path parameter without `required: true` (inline or via `$ref`) | set `required: true` at its definition |
| OpenAPI 3.0 operation with no `responses`                      | add a `default` response               |
| `info.version` missing                                         | `"unspecified"`                        |

Anything that needs a judgment about what the API actually does is left to the validator
to reject. Each repair is recorded in `spec_corrections` (`origin = 'portolan'`) with the
JSON Patch that makes it, reported in the `add_api` result under `corrections`, and
marked `resolved` once an upstream version no longer needs it. Repairs are recomputed on
every import, never replayed.

### D22 — flaws are raised with the upstream project (**addition**)

_Decision:_ after an import commits, Portolan raises every correction not yet raised,
grouped as one issue per agent correction plus one issue for all new D21 repairs. The
upstream repository comes from, in order: `feedback.repositories` in config, the
`upstream_repo` given to `add_api` (stored on the API), the GitHub URL the document was
fetched from, then `info.contact.url`, `externalDocs.url` or `info.x-origin` in the
document.

`feedback.upstream_issues` decides what happens:

- `draft` (default): the result carries a prefilled `github.com/<repo>/issues/new` link
  for the user or agent to open. No outbound request is made.
- `file`: Portolan files the issue itself with the token in `feedback.github.token_env`.
- `off`: corrections stay local.

When filing:

1. Only repositories from **config** or from the **spec URL** are filed against. A
   repository named by the agent or by the document's own metadata gets a draft link.
   This is the D5 reasoning applied to the operator's GitHub token: an agent, or a
   document an agent supplied, must not be able to aim it at a repository of its choice.
2. Before filing, GitHub is searched for an issue carrying the same fingerprint (printed
   in the issue body), so separate installations do not file duplicates. A match is
   linked as `existing`.
3. At most `max_issues_per_repo_per_day` (default 5) issues are filed per repository.
   After that the result is `rate_limited` with a draft link.
4. GitHub requests go through `safeFetch`, so the network policy and `allowed_hosts`
   apply to them as to everything else.
5. A failure is reported as `failed` with a draft link. It never fails the import.

Issue bodies say they were opened automatically by Portolan. The `issue.description`
written by an agent becomes public text, and the `add_api` schema tells the agent so.

---

## Linting and enrichment on import ([issue #2](https://github.com/xgp/portolan/issues/2))

Search quality depends on the text a document carries (§9), and many documents carry
little: operations with a summary and nothing else, parameters with no description. D23
reports what is missing; D24 fills the gap for search, using a coding agent the user
already has.

### D23 — documents are linted with Spectral on import (**addition**)

_Spec:_ §10 validates a document and has no lint step.

_Decision:_ every new version is linted with Spectral's `oas` ruleset (`recommended`)
before it is stored. Findings go in `lint_findings`, keyed by version, and never fail an
import. `add_api` returns counts by severity and the ten most severe findings;
`inspect_api` shows an operation's own errors and warnings. Rules can be turned off or
re-graded under `lint.rules`, and `lint.enabled: false` skips the step.

_Why Spectral:_ it is the JavaScript-native choice and runs in-process. Vacuum and
Speakeasy's linter are Go binaries that would have to be installed and spawned
separately.

Two defaults differ from Spectral's own:

- **Spectral's `$ref` resolver fetches `http(s):` and `file:` references itself.** That
  would bypass the network policy (§30, D7), the size limits and the redirect checks
  applied to every other fetch, and would read local files. Portolan gives Spectral a
  resolver with no schemes at all. The document has already been bundled, so only local
  references remain, and those need no resolver. A test makes sure nothing is fetched.
- **The example-validation rules (`oas3-valid-media-example`,
  `oas3-valid-schema-example` and their OAS 2 versions) are off.** They compile a JSON
  Schema validator for every example. On api.github.com's 13 MB document they take 14 of
  the 16 seconds and about 2 GB of memory. With them off, the same document lints in
  about 2 seconds. `oas2-schema` and `oas3-schema` are off as well, because they repeat
  what validation already checked. Each can be turned back on under `lint.rules`.

A version that is reused (an unchanged re-import, or a return to an earlier document)
keeps the findings it was stored with and is not linted again.

### D24 — a local coding agent describes operations, over ACP (**deviation**)

_Spec:_ §4 lists "LLM calls inside Portolan" as out of scope for the MVP.

_Deviation:_ when the user has Claude Code or Codex installed and logged in, Portolan
asks it to describe each operation, its parameters and its top-level request body fields,
and the API as a whole. The agent may also note up to three problems per operation. The
text goes into the search index, so a query can match words the document never used
("remove" for an operation documented only as "delete"). It also appears in `inspect_api`
under `generated`, attributed to the agent. Portolan calls no model API and holds no
model credentials: it drives the user's own agent through the
[Agent Client Protocol](https://agentclientprotocol.com), as a client, via the official
adapters `claude-agent-acp` and `codex-acp`.

- `enrichment.agent: auto` (default) tries Claude Code, then Codex. Each is used if its
  adapter is on `PATH`, or, failing that, if the agent's own CLI (`claude`, `codex`) is
  and `npx` is too. The adapter is then run as `npx -y <package>@<version>`, at the
  version pinned in `src/enrichment/acp-agent.ts` (the one tested), never `latest`. The
  first run downloads it, a few hundred megabytes with the agent binary it bundles.
  `enrichment.npx_fallback: false` turns this off, for machines that should not fetch
  code at runtime. A login problem shows up as ACP's `auth_required` on the first
  prompt; the next agent is then tried, and the failed one is skipped for 15 minutes.
  `claude`, `codex` and `off` choose explicitly.
- The work runs in the background after `add_api` commits. The result says
  `queued`, `up_to_date`, `disabled` or `unavailable`, and never waits for the agent.
  `portolan serve` resumes unfinished work at startup, and `portolan enrich` runs it in
  the foreground.
- Enrichments are stored in `enrichments`, keyed by a hash of the operation as stored.
  An operation unchanged in a new version keeps its description, and a changed one is
  described afresh. The least documented operations go first, up to
  `max_operations_per_api` (default 200), in batches of `batch_size`.
- The document is never modified. The specification stays authoritative (§3.3): spec
  hashes, versions and corrections (D20) are unaffected, and agent findings are not
  raised upstream (D22). They are leads for the calling agent to verify, and the server
  instructions say so.

_Security:_ the agent reads text taken from a third-party document, so it is treated as
an agent that may be prompt-injected. It must be unable to act, and anything it writes
is distrusted:

1. **No capability is offered.** The client advertises no file-system or terminal
   capability and answers every `session/request_permission` with `cancelled`.
2. **Each agent is started with its own tools off.** Claude Code gets the Agent SDK
   options `tools: []`, `settingSources: []` (no user or project settings, and therefore
   no hooks or MCP servers, including Portolan itself) and `persistSession: false`.
   Codex starts in `read-only` mode with its shell, unified exec, code mode, apps,
   plugins, sub-agents, image tools and web search disabled, and no MCP servers. This was
   tested against both: with these settings neither could read `/etc/hosts` when asked
   to. Without them, Codex's read-only mode could.
3. **A tool call ends the job.** If an agent reports a tool call anyway, the turn is
   cancelled, its output discarded, and no further batches are sent.
4. **The process gets only what it needs.** It runs in an empty temporary directory.
   Its environment is built from an allowlist (`PATH`, `HOME`, locale, proxy and CA
   settings, `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, and `npm_config_*` for
   npx) plus any names listed
   under `enrichment.agents.<name>.env`. Every variable named in an auth profile, the
   HTTP transport token or the GitHub token is removed, even if it is listed.
5. **Replies are parsed as untrusted input.** Only operations, parameters and fields
   that were in the brief are kept. Control characters are stripped and every string is
   capped. Generated text reaches only the local search index and `inspect_api`, both
   clearly marked, so it is no more able to steer the calling agent than the document's
   own descriptions already are.

_Privacy:_ enrichment sends each operation's brief to the agent's model provider, under
the user's own account with that agent. That is a new data flow, so `doctor` reports it
and `enrichment.agent: off` disables it. Operators cataloguing documents that must not
leave the machine should set it.
