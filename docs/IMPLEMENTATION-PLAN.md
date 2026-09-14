# Implementation plan

Phases follow `SPEC.md` §61. Every phase ends with the repository installing, type
checking, linting, building and passing its full test suite — no phase leaves a broken
tree or a placeholder in core MVP functionality.

| Phase | Delivers                                                                                                                                                                      | Green at the end                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Toolchain: pnpm workspace, TypeScript (NodeNext, strict), ESLint 9 flat config, Prettier, Vitest, LICENSE, `.gitignore`                                                       | `pnpm lint && pnpm typecheck && pnpm build && pnpm test`                                                                                           |
| 1     | Skeleton: `errors/`, `config/`, logging, `storage/` (migrations + repositories), `cli/` (`init`/`serve`/`doctor`), MCP server with six stub tools                             | unit tests for config + storage; **MCP e2e: a real client enumerates exactly six tools**                                                           |
| 2     | Catalog: SSRF-safe fetch, OpenAPI parse/validate/bundle/normalize, operation + identifier derivation, versioning, `add_api`                                                   | import fixtures (3.0/3.1 × JSON/YAML, external refs, recursion, missing/duplicate `operationId`, multiple servers, security schemes, invalid docs) |
| 3     | Discovery: FTS5 schema, `SearchProvider`, query builder, synonym expansion, `find_api`, `search_api`, `inspect_api`                                                           | ranking tests from §47; `inspect_api` closure tests                                                                                                |
| 4     | Execution: environments, auth (bearer/api-key/basic/oauth2-cc), mutation + network policy, parameter serialization, AJV validation, HTTP caller, response shaping, `call_api` | fixture HTTP server + **real HTTP** integration tests covering §52's matrix                                                                        |
| 5     | Sandbox: Deno runner, stdio RPC protocol, in-sandbox runtime, limits, `run_api_code`                                                                                          | sandbox security tests (§54): fs, env, subprocess, network, infinite loop, call cap, output cap                                                    |
| 6     | Hardening: redirect policy, credential sanitization, structured logs, `doctor`, Streamable HTTP transport + auth, Dockerfile, compose, README                                 | SSRF security tests (§54): `file://`, metadata, loopback, redirect-to-loopback, cross-origin credential drop                                       |
| 7     | Canonical end-to-end scenario (§53) driven entirely through the MCP client                                                                                                    | full suite + Docker build                                                                                                                          |

## Module dependency rule (§58)

```
mcp/  →  services  →  catalog/ search/ execution/  →  storage/ net/ sandbox/
```

`catalog`, `search`, `execution` and `sandbox` must not import from `mcp/`. This is
enforced by an ESLint `no-restricted-imports` rule, not by convention alone.

## Test layout

```
test/fixtures/      OpenAPI documents + the local API fixture server
test/unit/          pure logic: identifiers, serialization, validation, policy, ranking …
test/integration/   real HTTP against the fixture server; real SQLite
test/security/      §54 — every case must fail closed
test/e2e/           real MCP client over stdio against the built server
```
