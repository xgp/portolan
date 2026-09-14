# Portolan

## MCP API Catalog and Execution Runtime

**Status:** Implementation specification
**Target:** MVP / v0.1
**Primary language:** TypeScript
**License:** Apache-2.0 recommended

---

# 1. Summary

Portolan is an MCP server that allows AI agents to discover, inspect, and use arbitrary HTTP APIs described by OpenAPI specifications.

A user connects a single Portolan MCP server to an agent. The user or agent can then add OpenAPI specifications for services such as Stripe, Keycloak, SendGrid, GitHub, internal company APIs, and other services.

Portolan maintains a persistent library of those APIs.

Rather than exposing every OpenAPI operation as an individual MCP tool, Portolan always exposes a small, fixed set of tools:

```text
add_api
find_api
search_api
inspect_api
call_api
run_api_code
```

The number of MCP tools therefore remains constant regardless of whether Portolan contains one API or hundreds of APIs containing tens of thousands of operations.

The normal interaction is:

```text
User
  │
  ▼
Agent
  │
  ├── find_api("manage Keycloak users")
  │
  ▼
Portolan
  │
  ├── search_api("disable a user")
  │
  ├── inspect_api(...)
  │
  └── call_api(...)
  │
  ▼
Remote API
```

For multi-step operations the agent can instead use:

```text
find_api
    ↓
search_api
    ↓
inspect_api
    ↓
run_api_code
```

`run_api_code` provides a constrained JavaScript environment containing an `api.call()` function. It does **not** provide unrestricted shell, filesystem, environment, or network access.

Portolan is therefore simultaneously:

1. an OpenAPI library,
2. an API capability search engine,
3. an OpenAPI inspection system,
4. an HTTP execution runtime, and
5. a constrained scripting runtime for API workflows.

---

# 2. Primary user story

A user configures one MCP server:

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

The user tells their agent:

> Add the Keycloak Admin API to Portolan.

The agent invokes:

```text
add_api(...)
```

Later the user says:

> Disable [john@example.com](mailto:john@example.com) in our Keycloak instance.

The agent does not need the Keycloak OpenAPI specification in its context.

Instead:

```text
find_api("Keycloak administration")
```

returns the appropriate API.

The agent then calls:

```text
search_api(
    api_id="keycloak",
    query="find user by email and update or disable user"
)
```

Portolan returns a small number of relevant operations.

The agent calls:

```text
inspect_api(...)
```

to retrieve detailed schemas only for those operations.

The agent can then use:

```text
call_api(...)
```

for individual requests or:

```text
run_api_code(...)
```

for a workflow involving several requests.

---

# 3. Design principles

## 3.1 Progressive disclosure

Do not send complete OpenAPI specifications to the model unless explicitly requested.

The model should normally see information in this sequence:

```text
API catalog
     ↓
candidate APIs
     ↓
candidate operations
     ↓
specific operation schemas
     ↓
execution
```

Each stage should return only enough information for the next reasoning step.

---

## 3.2 Fixed MCP surface

Do not dynamically create one MCP tool per OpenAPI operation.

Portolan exposes the same six tools regardless of catalog size.

This is a fundamental architectural requirement.

---

## 3.3 OpenAPI is authoritative

Portolan should derive as much behavior as possible from the OpenAPI document:

* paths
* operations
* HTTP methods
* parameter locations
* parameter requirements
* request bodies
* content types
* response schemas
* servers
* authentication schemes
* descriptions
* tags
* examples
* deprecation
* parameter serialization

The agent should not need to manually construct URLs or HTTP requests when sufficient information exists in the specification.

---

## 3.4 Search before schema loading

Search results should be concise.

For example:

```json
{
  "operation_id": "users.update",
  "method": "PUT",
  "path": "/admin/realms/{realm}/users/{user-id}",
  "summary": "Update a user",
  "score": 0.92
}
```

Do not include the entire request/response schema in search results.

That belongs in `inspect_api`.

---

## 3.5 Credentials are never model context

Secrets must not be:

* stored in OpenAPI documents,
* returned by MCP tools,
* included in logs,
* returned by `inspect_api`,
* exposed to `run_api_code`.

Credentials are configured separately and referenced by name.

---

## 3.6 Execution is constrained

An API definition does not imply permission to access arbitrary network resources.

Requests may only be made against registered API environments and must follow administrator-defined execution policy.

`run_api_code` is not a remote shell.

---

# 4. Scope

## MVP includes

* MCP server
* stdio transport
* Streamable HTTP transport
* persistent API catalog
* OpenAPI 3.0.x support
* OpenAPI 3.1.x support
* YAML specifications
* JSON specifications
* specifications supplied inline
* specifications supplied by URL
* `$ref` resolution
* API metadata extraction
* operation indexing
* API search
* operation search
* operation inspection
* HTTP operation execution
* OpenAPI parameter serialization
* request validation
* named environments
* named authentication profiles
* API key authentication
* Bearer token authentication
* HTTP Basic authentication
* OAuth2 client-credentials authentication
* constrained multi-operation JavaScript execution
* SQLite persistence
* SQLite FTS5 search
* structured logs
* Docker image
* automated tests

## Explicitly out of scope for MVP

* graphical UI
* hosted multi-user SaaS
* arbitrary SDK generation
* GraphQL
* SOAP/WSDL
* gRPC
* AsyncAPI
* MCP server ingestion
* vector databases
* embeddings
* LLM calls inside Portolan
* autonomous authentication discovery
* browser-based OAuth authorization-code flows
* secret-management UI
* arbitrary shell execution
* arbitrary Python execution
* arbitrary outbound HTTP from scripts
* user/organization RBAC
* billing
* cloud synchronization

These may be added later without changing the six primary MCP tools.

---

# 5. Terminology

## API

A logical service represented by an OpenAPI specification.

Examples:

```text
keycloak
stripe
sendgrid
github
```

---

## API version

An imported version of an OpenAPI document.

Updating an existing API creates a new version and makes it current.

---

## Operation

One HTTP operation defined by a path and HTTP method.

Example:

```text
PUT /admin/realms/{realm}/users/{user-id}
```

---

## Environment

A concrete server on which an API can be invoked.

Example:

```text
keycloak / dev
keycloak / staging
keycloak / production
```

Each environment has:

```text
base URL
authentication profile
execution policy
```

---

## Authentication profile

Named server-side configuration containing credentials.

Examples:

```text
keycloak-prod
stripe-live
sendgrid-phase-two
```

Secrets are never stored in the OpenAPI catalog.

---

# 6. Technology choices

Use:

```text
TypeScript
Node.js current LTS
pnpm
official MCP TypeScript SDK v2
SQLite
SQLite FTS5
Zod
AJV
YAML parser
OpenAPI parser/resolver
Vitest
Pino
Docker
Deno for sandboxed JavaScript execution
```

Prefer existing maintained libraries rather than implementing OpenAPI parsing from scratch.

Use the official MCP v2 server package:

```text
@modelcontextprotocol/server
```

The server should target the MCP 2026-07-28 specification.

---

# 7. Repository structure

Use approximately:

```text
portolan/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── README.md
├── LICENSE
│
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   ├── serve.ts
│   │   ├── init.ts
│   │   └── doctor.ts
│   │
│   ├── mcp/
│   │   ├── server.ts
│   │   └── tools/
│   │       ├── add-api.ts
│   │       ├── find-api.ts
│   │       ├── search-api.ts
│   │       ├── inspect-api.ts
│   │       ├── call-api.ts
│   │       └── run-api-code.ts
│   │
│   ├── catalog/
│   │   ├── catalog.ts
│   │   ├── importer.ts
│   │   ├── normalizer.ts
│   │   ├── resolver.ts
│   │   └── identifiers.ts
│   │
│   ├── search/
│   │   ├── api-search.ts
│   │   └── operation-search.ts
│   │
│   ├── openapi/
│   │   ├── parser.ts
│   │   ├── operations.ts
│   │   ├── parameters.ts
│   │   ├── serialization.ts
│   │   └── validation.ts
│   │
│   ├── execution/
│   │   ├── caller.ts
│   │   ├── auth.ts
│   │   ├── policy.ts
│   │   ├── response.ts
│   │   └── oauth.ts
│   │
│   ├── sandbox/
│   │   ├── runner.ts
│   │   ├── protocol.ts
│   │   └── runtime.ts
│   │
│   ├── storage/
│   │   ├── database.ts
│   │   ├── migrations/
│   │   └── repositories/
│   │
│   ├── config/
│   │   ├── config.ts
│   │   └── schema.ts
│   │
│   └── errors/
│       └── errors.ts
│
└── test/
    ├── fixtures/
    ├── unit/
    ├── integration/
    └── e2e/
```

Do not put significant business logic directly in MCP tool handlers.

The MCP layer should be thin.

---

# 8. Persistent data model

Use SQLite.

## `apis`

```text
id                  TEXT PRIMARY KEY
name                TEXT NOT NULL
description         TEXT
aliases_json        TEXT
tags_json           TEXT
current_version_id  TEXT
created_at          DATETIME
updated_at          DATETIME
```

`id` is a stable slug such as:

```text
keycloak
stripe
sendgrid
```

---

## `api_versions`

```text
id                TEXT PRIMARY KEY
api_id            TEXT NOT NULL
openapi_version   TEXT
info_version      TEXT
spec_hash         TEXT NOT NULL
spec_json         TEXT NOT NULL
source_type       TEXT
source_uri        TEXT
created_at        DATETIME
```

Store normalized JSON even when YAML was supplied.

Do not discard historical versions when an API is updated.

---

## `operations`

```text
id                    TEXT PRIMARY KEY
api_version_id        TEXT NOT NULL
canonical_id          TEXT NOT NULL
source_operation_id   TEXT
method                TEXT NOT NULL
path                  TEXT NOT NULL
summary               TEXT
description           TEXT
tags_json             TEXT
deprecated            BOOLEAN
search_text           TEXT
operation_json        TEXT
```

---

## `environments`

```text
id                TEXT PRIMARY KEY
api_id            TEXT NOT NULL
name              TEXT NOT NULL
base_url          TEXT NOT NULL
auth_profile      TEXT
is_default        BOOLEAN
allow_mutations   BOOLEAN
created_at        DATETIME
updated_at        DATETIME
```

Environment names should typically be:

```text
default
dev
staging
production
```

---

# 9. Search indexes

Create two FTS5 tables.

## API search

Index:

```text
id
name
aliases
description
tags
OpenAPI title
OpenAPI description
```

---

## Operation search

Index:

```text
canonical operation ID
source operationId
summary
description
tags
HTTP method
path
parameter names
parameter descriptions
request schema property names
```

Use SQLite BM25 ranking.

Do not require embeddings for MVP.

Search architecture must, however, use an interface such as:

```typescript
interface SearchProvider {
  searchApis(query: string, limit: number): Promise<ApiSearchResult[]>;
  searchOperations(
    apiId: string,
    query: string,
    limit: number
  ): Promise<OperationSearchResult[]>;
}
```

This makes semantic or hybrid search replaceable later.

---

# 10. OpenAPI ingestion

`add_api` performs the following pipeline:

```text
receive specification
       ↓
load contents
       ↓
parse YAML/JSON
       ↓
validate OpenAPI
       ↓
resolve external references
       ↓
normalize specification
       ↓
derive API metadata
       ↓
derive operations
       ↓
derive server environments
       ↓
create searchable text
       ↓
persist version
       ↓
rebuild FTS indexes
```

The import must be transactional.

If any required step fails, do not partially replace the current API version.

---

# 11. Supported specification sources

`add_api` accepts exactly one of:

```text
spec_url
spec_content
```

Examples:

```json
{
  "spec_url": "https://example.com/openapi.json"
}
```

or:

```json
{
  "spec_content": "{ \"openapi\": \"3.1.0\", ... }"
}
```

`spec_content` may contain YAML or JSON.

Do not accept filesystem paths through the MCP interface.

Local files can be loaded by the agent itself and supplied as content.

---

# 12. Remote specification security

Fetching an arbitrary URL creates an SSRF risk.

For `spec_url`:

* only support `https:` and optionally `http:`
* follow a limited number of redirects
* enforce maximum response size
* enforce timeout
* reject non-HTTP URL schemes
* reject link-local addresses by default
* reject metadata-service addresses
* reject loopback addresses by default
* reject private-network addresses by default

Configuration may explicitly permit private networks.

Never support:

```text
file:
ftp:
data:
gopher:
```

---

# 13. API identifiers

If `api_id` is supplied, use it.

Otherwise derive it from:

```text
info.title
```

Normalize to:

```text
lowercase
ASCII where practical
spaces → hyphens
remove punctuation
```

Example:

```text
Keycloak Admin REST API
```

might become:

```text
keycloak-admin-rest-api
```

The user/agent may override it:

```text
api_id="keycloak"
```

IDs must be unique.

---

# 14. Operation identifiers

OpenAPI `operationId` cannot always be trusted.

Each operation must therefore have an internal canonical identifier.

If `operationId` exists and is unique:

```text
canonical_id = operationId
```

If it is missing or duplicated:

```text
canonical_id = lower(method) + ":" + path
```

Example:

```text
put:/admin/realms/{realm}/users/{user-id}
```

Always preserve the original `operationId` separately.

The canonical identifier must remain deterministic between imports where method/path/operationId have not changed.

---

# 15. MCP tools

Portolan exposes exactly these primary tools:

```text
add_api
find_api
search_api
inspect_api
call_api
run_api_code
```

Avoid adding management tools during MVP unless absolutely required.

---

# 16. `add_api`

## Purpose

Add or update an OpenAPI definition.

## Input

```typescript
{
  spec_url?: string;
  spec_content?: string;

  api_id?: string;
  name?: string;
  description?: string;
  aliases?: string[];
  tags?: string[];

  default_base_url?: string;
  default_environment?: string;
  auth_profile?: string;

  replace?: boolean;
}
```

Exactly one of:

```text
spec_url
spec_content
```

is required.

`replace` defaults to `false`.

If an API with the chosen ID already exists and `replace=false`, return a conflict.

If `replace=true`, create a new API version and make it current.

Do not destroy the previous version.

## Output

Example:

```json
{
  "api_id": "keycloak",
  "name": "Keycloak Admin REST API",
  "openapi_version": "3.0.3",
  "api_version": "26.7",
  "operations": 247,
  "environments": [
    {
      "name": "default",
      "base_url": "https://keycloak.example.com"
    }
  ],
  "warnings": [],
  "status": "added"
}
```

Warnings may include:

```text
missing operationIds
duplicate operationIds
unsupported parameter styles
missing servers
unresolved optional documentation
```

Warnings should not contain the full specification.

---

# 17. `find_api`

## Purpose

Answer:

> Which registered API is appropriate for this task?

## Input

```typescript
{
  query: string;
  limit?: number;
}
```

Default:

```text
limit = 5
```

Maximum:

```text
limit = 20
```

## Output

```json
{
  "results": [
    {
      "api_id": "sendgrid",
      "name": "SendGrid API",
      "description": "Email delivery and administration",
      "score": 0.94,
      "matched": [
        "suppression",
        "email"
      ]
    }
  ]
}
```

Do not include operations.

Do not include OpenAPI schemas.

---

# 18. `search_api`

## Purpose

Answer:

> Which operations in this API are relevant to the task?

## Input

```typescript
{
  api_id: string;
  query: string;
  limit?: number;
  tags?: string[];
  methods?: string[];
}
```

Default:

```text
limit = 10
```

Maximum:

```text
limit = 30
```

## Output

Example:

```json
{
  "api_id": "keycloak",
  "results": [
    {
      "operation_id": "UsersResource_updateUser",
      "method": "PUT",
      "path": "/admin/realms/{realm}/users/{user-id}",
      "summary": "Update the user",
      "tags": ["Users"],
      "deprecated": false,
      "score": 0.93
    }
  ]
}
```

Search results must remain compact.

---

# 19. `inspect_api`

## Purpose

Retrieve sufficient detail for an agent to correctly invoke one or more operations.

## Input

```typescript
{
  api_id: string;
  operation_ids: string[];
}
```

Maximum:

```text
10 operations per call
```

## Output

For each operation return:

```text
canonical operation ID
source operationId
method
path
summary
description
tags
deprecated status

path parameters
query parameters
header parameters
cookie parameters

parameter:
  name
  description
  required
  schema
  example
  style
  explode

request body:
  required
  supported content types
  schema
  examples

responses:
  status code
  description
  content type
  schema

security requirements
```

Example:

```json
{
  "operation_id": "UsersResource_updateUser",
  "method": "PUT",
  "path": "/admin/realms/{realm}/users/{user-id}",
  "parameters": {
    "path": [
      {
        "name": "realm",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "user-id",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ]
  },
  "request_body": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "type": "object"
        }
      }
    }
  }
}
```

Do not return unrelated schemas.

---

# 20. `call_api`

## Purpose

Execute one OpenAPI operation.

## Input

```typescript
{
  api_id: string;
  operation_id: string;

  environment?: string;

  parameters?: {
    path?: Record<string, unknown>;
    query?: Record<string, unknown>;
    header?: Record<string, unknown>;
    cookie?: Record<string, unknown>;
  };

  body?: unknown;

  content_type?: string;

  timeout_ms?: number;
}
```

The agent must not supply:

```text
base URL
raw authentication headers
credentials
arbitrary destination URL
```

The destination is resolved from the registered environment.

---

# 21. Request execution pipeline

`call_api` must perform:

```text
resolve API
   ↓
resolve environment
   ↓
resolve operation
   ↓
check execution policy
   ↓
validate parameters
   ↓
validate request body
   ↓
serialize OpenAPI parameters
   ↓
construct URL
   ↓
resolve authentication
   ↓
execute HTTP request
   ↓
limit response size
   ↓
parse response
   ↓
return structured result
```

---

# 22. OpenAPI parameter handling

Correctly distinguish:

```text
path
query
header
cookie
```

Implement common OpenAPI serialization semantics including:

```text
style
explode
arrays
objects
allowReserved
```

At minimum support:

```text
simple
form
spaceDelimited
pipeDelimited
deepObject
```

Unsupported combinations must fail explicitly rather than silently generating an incorrect request.

---

# 23. Request validation

Validate:

* required parameters
* primitive parameter types
* enum values
* array values
* request bodies
* JSON schemas
* required object properties

Prefer AJV.

For OpenAPI 3.0 schemas, normalize schema differences necessary for validation.

Do not reject valid OpenAPI behavior merely because JSON Schema semantics differ slightly.

---

# 24. Response format

Return:

```typescript
{
  request: {
    operation_id: string;
    method: string;
    url: string;       // credentials removed
  };

  response: {
    status: number;
    status_text: string;
    headers: Record<string,string>;
    content_type?: string;
    body: unknown;
    truncated?: boolean;
  };

  duration_ms: number;
}
```

Filter sensitive response headers such as:

```text
set-cookie
authorization
proxy-authorization
```

Do not return credentials embedded in URLs.

---

# 25. Error format

All tool errors should have a stable structure:

```json
{
  "error": {
    "code": "OPERATION_NOT_FOUND",
    "message": "Operation 'users.foo' does not exist in API 'keycloak'.",
    "details": {}
  }
}
```

Define machine-readable codes including:

```text
API_NOT_FOUND
API_ALREADY_EXISTS
SPEC_INVALID
SPEC_FETCH_FAILED
SPEC_TOO_LARGE
OPERATION_NOT_FOUND
ENVIRONMENT_NOT_FOUND
AUTH_PROFILE_NOT_FOUND
AUTH_FAILED
PARAMETER_REQUIRED
PARAMETER_INVALID
REQUEST_BODY_INVALID
CONTENT_TYPE_UNSUPPORTED
MUTATION_NOT_ALLOWED
NETWORK_DESTINATION_BLOCKED
REQUEST_TIMEOUT
RESPONSE_TOO_LARGE
REMOTE_API_ERROR
SANDBOX_TIMEOUT
SANDBOX_CALL_LIMIT
SANDBOX_RUNTIME_ERROR
```

Errors should help the agent recover.

For example, validation errors should identify:

```text
parameter name
location
expected schema
received value
```

---

# 26. Authentication

Credentials are configured outside MCP tool calls.

Use a configuration file such as:

```yaml
auth_profiles:
  keycloak-prod:
    type: bearer
    token_env: KEYCLOAK_ACCESS_TOKEN

  sendgrid:
    type: api_key
    location: header
    name: Authorization
    value_env: SENDGRID_AUTH_HEADER

  internal-service:
    type: basic
    username_env: SERVICE_USERNAME
    password_env: SERVICE_PASSWORD
```

Environment variables contain actual secrets.

Never persist resolved secret values in SQLite.

---

# 27. Supported authentication profiles

MVP supports:

## Bearer

```yaml
type: bearer
token_env: TOKEN
```

Produces:

```text
Authorization: Bearer ...
```

---

## API key

```yaml
type: api_key
location: header
name: X-API-Key
value_env: SERVICE_API_KEY
```

Support:

```text
header
query
cookie
```

---

## Basic authentication

```yaml
type: basic
username_env: USERNAME
password_env: PASSWORD
```

---

## OAuth2 client credentials

```yaml
type: oauth2_client_credentials
token_url: https://example.com/oauth/token
client_id_env: CLIENT_ID
client_secret_env: CLIENT_SECRET
scopes:
  - admin
```

Cache access tokens in memory.

Refresh automatically before expiry.

Never persist access tokens.

---

# 28. Environments

An API may have multiple environments.

Example configuration:

```yaml
environments:
  - api: keycloak
    name: production
    base_url: https://auth.example.com
    auth_profile: keycloak-prod
    allow_mutations: true

  - api: keycloak
    name: staging
    base_url: https://auth-staging.example.com
    auth_profile: keycloak-staging
    allow_mutations: true
```

An environment may be created from an OpenAPI `servers` entry during import.

The explicit configured value takes precedence over the OpenAPI server URL.

---

# 29. Mutation policy

HTTP methods are classified as:

## Safe

```text
GET
HEAD
OPTIONS
```

## Mutating

```text
POST
PUT
PATCH
DELETE
```

Mutating calls require:

```text
environment.allow_mutations = true
```

Default:

```text
false
```

The MCP agent cannot change this policy.

This prevents an imported specification from automatically granting write access.

`run_api_code` is governed by the same policy.

---

# 30. Network policy

Remote API requests must only target the configured base URL of the selected environment.

An OpenAPI operation must never be able to redirect Portolan into becoming a generic HTTP proxy.

Implement configurable policies such as:

```yaml
network:
  allow_private_addresses: false
  allow_loopback: false

  allowed_hosts:
    - api.stripe.com
    - auth.example.com
```

Redirects must be revalidated against network policy.

Authentication headers must never be forwarded to a different host after a redirect.

---

# 31. `run_api_code`

## Purpose

Execute multi-step API workflows efficiently without requiring one MCP invocation per HTTP request.

The agent supplies JavaScript.

Example:

```javascript
const users = await api.call({
  operation_id: "users.search",
  parameters: {
    query: {
      email: input.email,
      exact: true
    }
  }
});

if (!Array.isArray(users.body) || users.body.length === 0) {
  return { found: false };
}

const user = users.body[0];

await api.call({
  operation_id: "users.update",
  parameters: {
    path: {
      "user-id": user.id
    }
  },
  body: {
    ...user,
    enabled: false
  }
});

return {
  found: true,
  user_id: user.id,
  disabled: true
};
```

---

# 32. `run_api_code` input

```typescript
{
  api_id: string;
  environment?: string;
  code: string;
  input?: unknown;

  timeout_ms?: number;
  max_api_calls?: number;
}
```

Defaults:

```text
timeout_ms = 30000
max_api_calls = 50
```

Hard maximums should be configurable.

---

# 33. Script interface

The script receives exactly:

```text
api
input
console
```

`api` exposes:

```typescript
api.call({
  operation_id,
  parameters?,
  body?,
  content_type?
})
```

`api.call()` uses exactly the same internal execution implementation as the MCP `call_api` tool.

Do not duplicate HTTP logic.

---

# 34. Script isolation

Do **not** execute agent code with:

```text
eval()
new Function()
Node vm as the sole security boundary
shell
bash
child_process
```

Use a separately spawned Deno runtime with permissions disabled.

The Deno process must have:

```text
no filesystem access
no network access
no environment access
no subprocess access
no FFI access
no dynamic permission escalation
```

Portolan communicates with the sandbox through stdin/stdout using an internal RPC protocol.

The sandbox requests:

```json
{
  "type": "api_call",
  "id": "123",
  "request": {
    "operation_id": "users.search"
  }
}
```

The parent Portolan process performs the HTTP operation and returns:

```json
{
  "type": "api_result",
  "id": "123",
  "result": {}
}
```

Thus:

```text
sandbox code
      │
      │ api.call()
      ▼
Portolan parent
      │
      │ policy + auth + OpenAPI validation
      ▼
Remote API
```

The sandbox never receives credentials.

---

# 35. Sandbox resource controls

Enforce:

```text
wall-clock timeout
maximum API calls
maximum script input size
maximum script output size
maximum individual HTTP response size
maximum cumulative HTTP response size
```

Terminate the sandbox process when limits are exceeded.

Capture a bounded amount of console output.

Return console output separately from the script result.

---

# 36. Script result

Scripts must return JSON-serializable values.

Response:

```json
{
  "result": {
    "found": true,
    "disabled": true
  },
  "api_calls": 2,
  "duration_ms": 418,
  "logs": []
}
```

If the value is not JSON serializable, return:

```text
SANDBOX_RUNTIME_ERROR
```

---

# 37. Response size management

API responses can be extremely large and should not blindly enter model context.

Configure:

```yaml
limits:
  max_response_bytes: 2097152
  max_tool_response_bytes: 524288
```

If an HTTP response exceeds the maximum:

* stop reading once the configured network maximum is reached, or safely truncate,
* mark the response as truncated,
* include status and headers,
* return sufficient metadata to explain truncation.

For JSON arrays, future versions may support paging or structured truncation, but this is not required for MVP.

---

# 38. Logging

Use structured logging.

Record:

```text
timestamp
request ID
MCP tool
api_id
operation_id
environment
HTTP method
hostname
status code
duration
error code
sandbox call count
```

Never log:

```text
Authorization
Cookie
Set-Cookie
API keys
OAuth client secrets
Bearer tokens
request headers containing configured secrets
```

Request and response bodies should not be logged by default.

---

# 39. Configuration

Default location:

```text
~/.config/portolan/config.yaml
```

Allow override:

```text
PORTOLAN_CONFIG
```

Example:

```yaml
database:
  path: ~/.local/share/portolan/portolan.db

server:
  transport: stdio

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

auth_profiles:
  stripe:
    type: bearer
    token_env: STRIPE_API_KEY
```

All configuration must be schema validated at startup.

Unknown security-sensitive configuration keys should generate errors rather than being silently ignored.

---

# 40. CLI

Binary:

```text
portolan
```

Required commands:

```text
portolan init
portolan serve
portolan doctor
```

## `portolan init`

Creates required directories and an example config if missing.

Never overwrite existing configuration.

---

## `portolan serve`

Default:

```text
stdio
```

Support:

```text
portolan serve --transport stdio
```

and:

```text
portolan serve --transport http --host 127.0.0.1 --port 8765
```

Use MCP Streamable HTTP.

Do not expose an unauthenticated HTTP server on non-loopback addresses by default.

---

## `portolan doctor`

Check:

```text
configuration
database
SQLite FTS5
Deno runtime
MCP initialization
auth environment variables
directory permissions
```

Never display secret values.

---

# 41. MCP tool descriptions

Tool descriptions are important because they teach agents how Portolan should be used.

Use descriptions approximately equivalent to:

## `add_api`

> Add an OpenAPI-described HTTP API to the persistent Portolan API library. Use this when the user provides an OpenAPI specification or asks Portolan to remember an API for future use.

## `find_api`

> Search the API library to identify which registered service can perform a task. Use this before search_api when you do not already know the API ID.

## `search_api`

> Search operations within one registered API by capability or task description. Returns concise operation candidates. Use inspect_api before calling an unfamiliar operation.

## `inspect_api`

> Retrieve detailed OpenAPI parameters, request schemas, responses, examples, and security requirements for selected operations.

## `call_api`

> Execute one registered OpenAPI operation using a configured environment and server-side credentials.

## `run_api_code`

> Execute a constrained JavaScript workflow that can call multiple operations from one registered API through api.call(). Use for pagination, loops, conditional logic, transformations, or multi-request workflows.

---

# 42. Recommended agent workflow

Document this in the MCP server instructions.

When an agent needs an API:

```text
1. If API ID is unknown:
       find_api

2. Find relevant operations:
       search_api

3. Inspect unfamiliar operations:
       inspect_api

4. For one or a few simple operations:
       call_api

5. For loops, pagination, branching, or many calls:
       run_api_code
```

Agents should not use `run_api_code` when a single `call_api` is sufficient.

---

# 43. API updates

Calling:

```text
add_api(
    api_id="keycloak",
    replace=true,
    ...
)
```

creates a new version.

After successful import:

```text
apis.current_version_id
```

is atomically updated.

Search always uses the current version.

Historical versions are retained but not searched.

Existing environment configuration remains attached to the API, not the version.

---

# 44. Duplicate specifications

Calculate a cryptographic hash of normalized specification content.

If the same API is replaced with an identical specification:

return:

```json
{
  "status": "unchanged"
}
```

Do not create another version.

---

# 45. `$ref` handling

Support:

```text
local references
same-document references
remote HTTP references
```

Apply the same network restrictions used for specification fetching to remote references.

Detect cycles.

Do not infinitely dereference recursive schemas.

The normalized internal model may retain references where necessary for recursive types.

---

# 46. Search text construction

For each operation build a normalized search document containing, where available:

```text
API name
API description
operationId
HTTP method
path
summary
description
tags
parameter names
parameter descriptions
request property names
request property descriptions
response property names
```

Weight approximately:

```text
operationId       high
summary           high
tags              high
path              medium-high
description       medium
parameters        medium
schema names      lower
```

FTS implementation details can vary as long as tests demonstrate sensible ranking.

---

# 47. Search behavior examples

Given Keycloak operations, the search:

```text
disable user
```

should rank user update operations above:

```text
delete user
get user sessions
update client
```

The search:

```text
identity provider certificate
```

should favor identity-provider operations.

The search:

```text
find user by email
```

should favor user search/list operations.

Build search fixtures specifically to test these cases.

---

# 48. HTTP retries

Do not automatically retry arbitrary requests.

Safe methods may optionally retry transient connection failures.

Never automatically retry mutating operations unless explicitly known to be idempotent.

Respect:

```text
Retry-After
```

but do not sleep for arbitrarily long periods.

MVP can simply return rate-limit information to the agent.

---

# 49. Redirects

For redirects:

* cap redirect count,
* reapply network policy,
* never forward credentials to a different origin automatically,
* reject redirect-based attempts to private or blocked addresses.

---

# 50. Timeouts

Implement:

```text
connection/request timeout
sandbox timeout
spec download timeout
OAuth token timeout
```

A timeout must produce a structured error.

Never leave unbounded HTTP operations.

---

# 51. Content types

MVP request support must include:

```text
application/json
application/x-www-form-urlencoded
multipart/form-data
text/plain
```

JSON receives full schema validation.

Form data should follow OpenAPI schemas where practical.

Binary upload support is not required for MVP unless supplied as encoded input.

Binary responses may return metadata and optionally bounded Base64 content.

Do not decode arbitrary binary content into text.

---

# 52. Tests

Testing is a release requirement, not an optional cleanup task.

## Unit tests

Cover:

```text
identifier generation
OpenAPI normalization
operation extraction
parameter serialization
schema validation
authentication injection
network policy
mutation policy
search ranking
response sanitization
error conversion
```

---

## Import tests

Fixtures must include:

```text
OpenAPI 3.0 JSON
OpenAPI 3.0 YAML
OpenAPI 3.1 JSON
OpenAPI 3.1 YAML
external references
recursive schemas
missing operationIds
duplicate operationIds
multiple servers
security schemes
invalid OpenAPI
```

---

## Execution integration server

Create a small local HTTP fixture server exposing an OpenAPI spec and endpoints covering:

```text
GET
POST
PUT
PATCH
DELETE
path parameters
query arrays
deepObject
JSON body
form body
authentication
redirect
large response
timeout
400
401
404
429
500
```

Tests must use real HTTP calls against this fixture.

---

## MCP end-to-end tests

Start Portolan as an MCP server and verify the complete workflow:

```text
add_api
find_api
search_api
inspect_api
call_api
run_api_code
```

Do not consider tests that call internal service classes alone sufficient.

---

# 53. Required end-to-end scenario

The repository must contain one canonical E2E test.

Create a fixture API implementing:

```text
GET /users
PUT /users/{id}
```

Add it with `add_api`.

Then verify:

```text
find_api("user management")
```

finds it.

Verify:

```text
search_api("find user by email")
```

finds the GET operation.

Verify `inspect_api`.

Use `call_api` to retrieve a user.

Then execute:

```javascript
const users = await api.call(...);

for (const user of users.body) {
    if (user.email === input.email) {
        await api.call({
            operation_id: "...",
            ...
        });
        return { updated: user.id };
    }
}

return { updated: null };
```

Verify that the target user was modified.

This proves the complete product concept.

---

# 54. Security tests

Explicitly test attempts to:

```text
fetch file:///etc/passwd
fetch localhost metadata
fetch cloud metadata service
redirect to localhost
send credentials across redirect
call arbitrary URL through call_api
access filesystem from run_api_code
access process environment from run_api_code
start subprocess from run_api_code
make direct network connection from run_api_code
run forever
make more than maximum API calls
return enormous script output
```

Each must fail.

---

# 55. Docker

Provide a production-capable Docker image containing:

```text
Node runtime
Portolan
Deno runtime
SQLite support
```

Persist:

```text
/data
```

Example:

```yaml
services:
  portolan:
    image: portolan
    volumes:
      - ./portolan-data:/data
    environment:
      PORTOLAN_CONFIG: /data/config.yaml
```

Do not bake secrets into the image.

---

# 56. README

README must explain the product from the user's perspective before describing implementation details.

Start with something approximately like:

> Portolan gives AI agents one MCP server for using any OpenAPI-described API. Add API specifications once, then let agents discover, inspect, and safely call them without loading entire OpenAPI documents into context.

Include a minimal example:

```text
"Add this Stripe OpenAPI specification to Portolan."

...

"Use our billing API to find overdue subscriptions."
```

Document the six MCP tools.

---

# 57. Observability

Prepare internal boundaries for future OpenTelemetry support but do not require an OTEL collector in MVP.

Use request IDs across:

```text
MCP request
sandbox calls
HTTP API calls
```

This should make one agent operation traceable through logs.

---

# 58. Internal architectural boundaries

Maintain these dependencies:

```text
MCP layer
    ↓
application services
    ↓
catalog/search/execution
    ↓
storage/network/sandbox
```

The execution runtime must not depend on MCP.

The search engine must not depend on MCP.

The catalog importer must not depend on MCP.

This allows future interfaces such as:

```text
CLI
REST
library
agent skill
```

without duplicating core behavior.

---

# 59. Future-compatible interfaces

The design should make the following possible without redesigning storage:

## Semantic search

Replace or augment FTS with:

```text
embeddings
hybrid BM25/vector search
reranking
```

---

## API collections

Example:

```text
aws
google-cloud
internal-services
```

---

## Cross-API code execution

A future `run_api_code` could permit:

```javascript
const customer = await api("stripe").call(...);
await api("sendgrid").call(...);
```

MVP intentionally restricts one script to one `api_id`.

---

## Generated SDKs

A future runtime may generate a typed SDK and expose it to script execution.

This must not be required for MVP.

---

## Automatic API selection

A future convenience operation could combine:

```text
find_api
search_api
```

but the primitive operations should remain available.

---

## API refresh

A future scheduler may periodically re-fetch specifications imported from URLs.

Not required in MVP.

---

## Additional protocols

The catalog architecture may later support:

```text
GraphQL
AsyncAPI
gRPC
MCP
```

Do not introduce protocol abstraction prematurely in MVP.

OpenAPI is the only supported API-definition format.

---

# 60. Important product decisions

The implementation must preserve these decisions unless concrete implementation evidence demonstrates they are infeasible.

### Do not expose every endpoint as an MCP tool.

This defeats the central purpose of Portolan.

### Do not require embeddings.

FTS is sufficient for MVP and avoids external infrastructure.

### Do not expose credentials to agents.

Authentication occurs inside Portolan.

### Do not let `call_api` accept arbitrary URLs.

All execution goes through registered APIs and environments.

### Do not implement `run_api_code` as unrestricted Node execution.

Use a genuinely constrained process.

### Do not generate an SDK as a prerequisite for API execution.

OpenAPI itself must be executable.

### Do not introduce a web UI.

The MCP interface is the product for MVP.

---

# 61. Implementation sequence

Implement in these phases.

## Phase 1 — skeleton

Create:

```text
TypeScript project
CLI
config
SQLite migrations
MCP server
six stub tools
test infrastructure
```

Confirm an MCP client can enumerate the tools.

---

## Phase 2 — catalog

Implement:

```text
OpenAPI loading
validation
normalization
operation extraction
SQLite storage
versioning
add_api
```

Add import fixtures.

---

## Phase 3 — discovery

Implement:

```text
FTS5 indexes
find_api
search_api
inspect_api
```

Add ranking tests.

At this point an agent should be able to navigate an API without executing it.

---

## Phase 4 — execution

Implement:

```text
environment resolution
authentication
policy checks
parameter serialization
request validation
HTTP execution
response handling
call_api
```

Add the HTTP fixture server.

---

## Phase 5 — script runtime

Implement:

```text
Deno sandbox
stdio RPC
api.call()
timeouts
call limits
output limits
run_api_code
```

Verify the sandbox security tests.

---

## Phase 6 — hardening

Implement:

```text
SSRF protection
redirect security
credential sanitization
structured errors
logging
doctor command
Docker
```

---

## Phase 7 — E2E validation

Run the canonical workflow entirely through MCP.

Do not call implementation classes directly.

---

# 62. Definition of done

The MVP is complete when an MCP-capable coding agent can start with a fresh Portolan installation and perform this conversation:

```text
User:
Add this OpenAPI specification to my API library.

Agent:
→ add_api
```

Later:

```text
User:
Which of my APIs can manage users?

Agent:
→ find_api
```

Then:

```text
User:
Find the operation for disabling a user.

Agent:
→ search_api
→ inspect_api
```

Then:

```text
User:
Disable user john@example.com.

Agent:
→ call_api
```

And:

```text
User:
Find all disabled users and retrieve their groups.

Agent:
→ search_api
→ inspect_api
→ run_api_code
```

with all of the following true:

* the complete OpenAPI document never enters model context,
* credentials never enter model context,
* API selection works from natural-language capability searches,
* operation selection works from natural-language searches,
* requests are validated against OpenAPI,
* HTTP requests use server-managed authentication,
* scripts cannot directly access network, filesystem, environment, or shell,
* mutating operations obey server-side policy,
* the MCP server still exposes only six primary tools.

---

# 63. Success criteria

Portolan should make the following statement true:

> An agent connected to Portolan can discover and safely use any registered OpenAPI-described service without having that service exposed as hundreds of individual tools and without needing its entire OpenAPI document in context.

The central measure of success is therefore not simply whether HTTP requests work.

It is whether an agent can reliably progress from:

```text
"I need an API that can do X"
```

to:

```text
correct API
    ↓
correct operation
    ↓
correct parameters
    ↓
correct execution
```

while consuming a small and predictable amount of model context.

That is the core product.
