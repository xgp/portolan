# Spec review: conflicts, ambiguities and deliberate deviations

`SPEC.md` is the product and architectural source of truth. This document records every
place the implementation knowingly differs from it, plus spec points that were
underspecified and had to be decided. It is written adversarially on purpose: several of
the items below are cases where following the spec literally would have weakened a
security boundary or produced something that cannot work.

Nothing here reduces a security boundary described in the spec. Three items (D5, D6, D7)
_strengthen_ boundaries the spec leaves open.

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
3. Environments defined in `config.yaml` are authoritative: `add_api` can never modify,
   re-point, or re-credential an existing environment (`ENVIRONMENT_IMMUTABLE`).

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
D8. `yaml` for YAML, `ajv`/`ajv-formats` for request validation.

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
negative is better. Portolan maps it monotonically into `(0, 1]` **relative to the current
result set**. Scores are comparable within one response and are not an absolute relevance
measure; the README says so.

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
