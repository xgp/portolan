# Portolan

**Portolan gives AI agents one MCP server for using any OpenAPI-described API. Add API
specifications once, then let agents discover, inspect, and safely call them without
loading entire OpenAPI documents into context.**

---

## The problem

The usual way to give an agent an HTTP API is to turn every operation into an MCP tool.
The Keycloak Admin API alone has several hundred. Do that for three or four services and
the tool list is thousands of entries long — most of the context window is spent on
descriptions of things the agent will never call, and tool selection gets worse the more
you add.

Portolan takes the other approach. However many APIs it holds, it exposes **six tools**:

```
add_api      find_api      search_api      inspect_api      call_api      run_api_code
```

The agent narrows down instead of scanning: _which API?_ → _which operation?_ → _what
does it take?_ → _call it_. Each step returns only enough to decide the next one, so the
context cost stays small and roughly constant whether Portolan knows about one API or a
hundred.

## What it looks like

> **You:** Add this Stripe OpenAPI specification to Portolan.

The agent calls `add_api`. Portolan parses, validates and indexes it, and remembers it.

> **You:** Use our billing API to find overdue subscriptions.

```
find_api("billing and subscriptions")        → stripe
search_api("stripe", "list overdue subscriptions")
                                             → listSubscriptions  GET /v1/subscriptions
inspect_api("stripe", ["listSubscriptions"]) → the parameters and response schema
call_api(...)                                → the result
```

The Stripe OpenAPI document is several megabytes. None of it entered the conversation.

For anything involving loops, pagination or several dependent requests, the agent writes
a small script instead of making a dozen round trips:

> **You:** Disable john@example.com in our directory.

```js
const users = await api.call({ operation_id: 'users.list' });

for (const user of users.response.body) {
  if (user.email === input.email) {
    await api.call({
      operation_id: 'users.update',
      parameters: { path: { id: user.id } },
      body: { ...user, enabled: false },
    });
    return { updated: user.id };
  }
}
return { updated: null };
```

That runs inside `run_api_code`, in a sandbox with no filesystem, network, environment or
subprocess access. Its only capability is `api.call()`, which Portolan performs on its
behalf — applying the same validation, policy and credentials as `call_api`.

---

## Install

**New here? [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) is a five-minute
walkthrough**: install, connect it to Claude, add a real public API, and make a call.

Requires **Node.js 24 or newer**. [Deno](https://deno.land) is needed only for
`run_api_code`; the other five tools work without it.

```bash
npm install -g portolan     # or: pnpm add -g portolan
portolan init
portolan doctor
```

`portolan doctor` checks configuration, storage, FTS5, the Deno runtime, MCP
initialization, credential environment variables and directory permissions. It never
prints a secret value.

Add it to your MCP client:

```json
{
  "mcpServers": {
    "portolan": {
      "command": "portolan",
      "args": ["serve"]
    }
  }
}
```

### Docker

```bash
export PORTOLAN_HTTP_TOKEN="$(openssl rand -hex 32)"
docker compose up -d
```

The image carries Node, Portolan and Deno. `/data` holds the SQLite database and
`config.yaml`. No secrets are baked into the image — credentials are passed as
environment variables and referenced by name.

---

## The six tools

| Tool           | What it does                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `add_api`      | Add or update an OpenAPI 3.0/3.1 document (JSON or YAML, by URL or inline). Creates a new version; the old one is kept. |
| `find_api`     | "Which of my APIs can do X?" Returns API ids and descriptions. No operations, no schemas.                               |
| `search_api`   | "Which operation in this API does X?" Returns compact operation candidates.                                             |
| `inspect_api`  | Full parameters, request and response schemas, examples and security requirements for up to 10 named operations.        |
| `call_api`     | Execute one operation against a configured environment with server-side credentials.                                    |
| `run_api_code` | Run a sandboxed JavaScript workflow that can make several `api.call()` requests.                                        |

The agent never supplies a URL, a base URL, a credential or an `Authorization` header.
Destinations come from the configured environment; authentication is applied inside
Portolan.

---

## Configuration

Default location `~/.config/portolan/config.yaml`, overridable with `PORTOLAN_CONFIG`.
Configuration is schema-validated at startup, and **an unknown key is an error**, not a
silently ignored typo — a misspelled `allow_private_addresses` is exactly the failure
this rule exists to catch.

```yaml
database:
  path: ~/.local/share/portolan/portolan.db

limits:
  max_spec_bytes: 10485760
  max_response_bytes: 2097152
  max_tool_response_bytes: 524288
  default_timeout_ms: 30000
  sandbox_timeout_ms: 30000
  sandbox_max_api_calls: 50

network:
  allow_private_addresses: false
  allow_loopback: false
  allow_http: false
  # When set, every outbound destination host must appear here.
  allowed_hosts: []

auth_profiles:
  keycloak-prod:
    type: bearer
    token_env: KEYCLOAK_ACCESS_TOKEN
    # Optional second line of defence: refuse to sign for any other host.
    allowed_hosts: ['auth.example.com']

  sendgrid:
    type: api_key
    location: header # header | query | cookie
    name: Authorization
    value_env: SENDGRID_AUTH_HEADER

  internal-service:
    type: basic
    username_env: SERVICE_USERNAME
    password_env: SERVICE_PASSWORD

  partner-api:
    type: oauth2_client_credentials
    token_url: https://example.com/oauth/token
    client_id_env: PARTNER_CLIENT_ID
    client_secret_env: PARTNER_CLIENT_SECRET
    scopes: [admin]

environments:
  - api: keycloak
    name: production
    base_url: https://auth.example.com
    auth_profile: keycloak-prod
    allow_mutations: true
    is_default: true

  - api: keycloak
    name: staging
    base_url: https://auth-staging.example.com
    auth_profile: keycloak-staging
    allow_mutations: true
```

**Configuration never contains a secret.** An auth profile names an _environment
variable_; the value lives in the process environment and is read at call time. Resolved
credentials and OAuth access tokens are never written to SQLite, never logged, never
returned by a tool, and never visible to `run_api_code`.

---

## Security model

Portolan executes HTTP requests on an agent's behalf, so the boundaries matter more than
the features.

**Credentials never reach the model.** Profiles are referenced by name. Credential
headers are stripped from responses, credential query parameters are redacted from any
URL Portolan returns, and the logger redacts them before serialization.

**The agent cannot choose a destination.** There is no URL parameter on any tool. The
operation path is _joined_ to the environment's base URL and cannot escape it — a path
that looks absolute or traverses upward is refused. An imported OpenAPI document cannot
turn Portolan into a generic HTTP proxy.

**SSRF is closed at the socket, not at the string.** Portolan resolves the hostname
itself, validates every returned address against the network policy, and then pins the
connection to a validated address. A "resolve, check, then hand the name to an HTTP
client" design can be defeated by DNS rebinding — the client re-resolves and an attacker
controlling the record answers differently the second time. Here the address that was
checked is the address that is connected to. IPv4-mapped, 6to4 and NAT64 encodings are
decoded before classification, so `::ffff:169.254.169.254` is recognised as the metadata
service. Cloud metadata endpoints are refused under every configuration.

**Redirects are re-validated per hop.** Each hop is re-checked against the policy, and
credential headers are dropped whenever the origin changes.

**Writes are opt-in, per environment.** `POST`, `PUT`, `PATCH` and `DELETE` require
`allow_mutations: true` on the specific environment. The default is `false`, the agent
cannot change it, and importing a specification never grants it. An API imported by an
agent is read-only until a human says otherwise.

**`run_api_code` is not a remote shell.** Scripts run in a Deno subprocess started with
every permission explicitly denied and an empty environment. Before the script runs, the
runtime deletes `Deno`, `fetch`, `WebSocket`, `Worker`, `process` and the rest from the
global scope, so there is nothing to reach for even by name. The only capability is
`api.call()`, which the parent process performs — applying the same policy, credentials
and OpenAPI validation as `call_api`. Wall-clock time, API call count, cumulative
response bytes, output size and captured log volume are all bounded, and the process is
killed when a limit is hit.

**The HTTP transport refuses to be careless.** Binding a non-loopback address without a
configured bearer token is a startup error. `Origin` and `Host` are validated on every
request to block DNS rebinding from a browser.

`test/security/` contains a test for each of these. They are part of the normal test run.

---

## How it works

```
MCP layer  (six thin tool handlers)
    ↓
application services
    ↓
catalog · search · execution · sandbox
    ↓
storage · network · Deno
```

Nothing below the MCP layer imports it — enforced by an ESLint rule, not by convention —
so the same core can back a CLI, a REST façade or a library embedding.

**Storage** is a single SQLite file via Node's built-in `node:sqlite`: no native module,
so no build toolchain in CI or in the Docker image. Imports are transactional; a failed
re-import can never leave an API pointing at a half-written version. Old versions are
retained and excluded from search.

**Ingestion** parses YAML or JSON, resolves `$ref`s with filesystem resolution disabled
and remote references routed through the same SSRF-safe fetch, validates against OpenAPI
3.0 and 3.1, then derives operations, search text and environments. External references
are bundled; internal ones are kept, so recursive schemas terminate.

**Search** is FTS5 with BM25, per-column weights, a small domain-neutral synonym table
and a term-coverage re-rank. See [docs/SEARCH.md](docs/SEARCH.md) for the ranking model
and its limits. It sits behind a `SearchProvider` interface so embeddings or a hybrid
ranker can replace it without touching anything else.

**Execution** implements OpenAPI parameter serialization properly — `style`, `explode`,
arrays, objects, `allowReserved`, `deepObject` — and fails loudly on combinations
OpenAPI leaves undefined rather than emitting a plausible-but-wrong request. Bodies and
parameters are validated with AJV, with OpenAPI 3.0 schemas normalized to JSON Schema
first.

---

## Development

```bash
pnpm install
pnpm check        # lint + typecheck + build + test
pnpm test
pnpm build
```

| Command                 |                                                                     |
| ----------------------- | ------------------------------------------------------------------- |
| `pnpm test:unit`        | pure logic: identifiers, serialization, validation, policy, ranking |
| `pnpm test:integration` | real HTTP against a local fixture API; real SQLite; real Deno       |
| `pnpm test:security`    | the SSRF and sandbox-escape matrix; every case must fail closed     |
| `pnpm test:e2e`         | a real MCP client driving the built server as a subprocess          |

The end-to-end suite does not call internal classes: it spawns `portolan serve` and
speaks MCP to it, so a passing run means an agent can do the same thing.

Deno must be installed for the sandbox suites.

## Documentation

- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) — install it, connect it to Claude,
  add an API, make a call
- [SPEC.md](SPEC.md) — the product and architectural specification
- [docs/DEVIATIONS.md](docs/DEVIATIONS.md) — where the implementation departs from the
  spec, and why, including the three places it tightens a boundary the spec left open
- [docs/SEARCH.md](docs/SEARCH.md) — the ranking model and its limits
- [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) — the build phases

## Licence

Apache-2.0.
