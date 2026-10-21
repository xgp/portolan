# Getting started with Portolan and Claude

A step-by-step walkthrough: install Portolan, connect it to Claude, add a real OpenAPI
specification, and have Claude call it. Every command and response below was run against
a live API.

Total time: about five minutes.

---

## What you need

- **Node.js 24 or newer** — `node --version`
- **Claude Code** or **Claude Desktop**
- **Deno** (optional) — only needed for the `run_api_code` tool. The other five tools work
  without it. Install with `curl -fsSL https://deno.land/install.sh | sh`.

---

## Step 1 — Install Portolan

Portolan is not on npm yet, so build it from the repository:

```bash
git clone <your-portolan-repo> portolan
cd portolan

corepack enable          # if you do not already have pnpm
pnpm install
pnpm build

npm link                 # puts `portolan` on your PATH
```

Check it:

```bash
portolan --version
# 0.1.0
```

> **Prefer not to touch your global npm?** Skip `npm link` and use the absolute path
> `node /full/path/to/portolan/dist/cli/index.js` everywhere this guide says `portolan`.
> To undo a link later: `npm unlink -g portolan`.

---

## Step 2 — Create the configuration

```bash
portolan init
```

```
Created /Users/you/.config/portolan/config.yaml
Data directory: /Users/you/.local/share/portolan
```

`init` never overwrites an existing config. Now check everything is healthy:

```bash
portolan doctor
```

```
✔ configuration                loaded /Users/you/.config/portolan/config.yaml
✔ database directory           /Users/you/.local/share/portolan is writable
✔ configuration permissions    configuration file is not world-readable
✔ database                     opened /Users/you/.local/share/portolan/portolan.db
✔ sqlite fts5                  FTS5 is available
✔ catalog                      0 API(s) registered
✔ deno runtime                 found /Users/you/.deno/bin/deno
✔ mcp server                   initializes with 6 tools
✔ auth profiles                none configured
✔ mutation policy              no environment allows mutations (read-only)
✔ network policy               defaults: private, loopback and plain-http destinations are blocked

Portolan looks healthy.
```

`deno runtime` showing `!` instead of `✔` is fine — it only disables `run_api_code`.

---

## Step 3 — Connect it to Claude

### Claude Code

```bash
claude mcp add portolan -s user -- portolan serve
```

`-s user` makes it available in every project. Use `-s project` to share it with your team
through a committed `.mcp.json`, or omit `-s` for just the current project.

Verify:

```bash
claude mcp get portolan
```

```
portolan:
  Scope: User config
  Status: ✔ Connected
  Type: stdio
  Command: portolan
  Args: serve
```

### Claude Desktop

Edit the config file:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

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

Quit and reopen Claude Desktop. If `portolan` is not found, use the absolute path to the
binary (`which portolan` will tell you) instead of the bare name.

---

## Step 4 — Add your first API

We will use the [APIs.guru](https://apis.guru) directory — a real, public, read-only API
that needs no key and whose OpenAPI document declares a usable server URL, so it works
with no extra configuration.

Just ask Claude:

> **You:** Add this OpenAPI spec to Portolan and call it `apis-guru`:
> https://api.apis.guru/v2/specs/apis.guru/2.2.0/openapi.json

Claude calls `add_api` and you get back:

```json
{
  "api_id": "apis-guru",
  "name": "APIs.guru",
  "openapi_version": "3.0.0",
  "api_version": "2.2.0",
  "operations": 7,
  "environments": [
    { "name": "default", "base_url": "https://api.apis.guru/v2", "allow_mutations": false }
  ],
  "warnings": [],
  "status": "added",
  "lint": { "errors": 0, "warnings": 0, "info": 0, "hints": 0, "findings": [] },
  "enrichment": { "status": "queued", "agent": "claude", "pending": 7 }
}
```

The API is now stored. It survives restarts, and you never have to paste that
specification again.

`lint` is what Spectral found wrong with the document. This one is clean; most are not.
`enrichment` appears when a coding agent can describe the operations for search, which
it then does in the background. That needs Claude Code or Codex, logged in. Portolan runs
the agent's ACP adapter with `npx` the first time (a large download), or you can install
it once with `npm install -g @agentclientprotocol/claude-agent-acp`. Without an agent
you see `"status": "unavailable"` and everything else works the same.

---

## Step 5 — Use it

> **You:** Which of my APIs knows about public API directories?

Claude calls `find_api` and gets back `apis-guru` — API ids and descriptions only, no
operations, no schemas.

> **You:** Find the operation that lists all providers, then call it.

Claude calls `search_api`:

```json
{
  "results": [
    {
      "operation_id": "getProviders",
      "method": "GET",
      "path": "/providers.json",
      "summary": "List all providers",
      "score": 0.68
    }
  ]
}
```

then `inspect_api` to see the parameters and response schema, then `call_api`:

```json
{
  "request": {
    "operation_id": "getProviders",
    "method": "GET",
    "url": "https://api.apis.guru/v2/providers.json"
  },
  "response": {
    "status": 200,
    "body": { "data": ["1forge.com", "1password.com", "..."] }
  }
}
```

That is the whole product. The OpenAPI document never entered the conversation — Claude
saw one API summary, one operation summary, and one schema.

---

## Step 6 — An API that needs a base URL

Plenty of real specifications declare a **relative** server URL, which is not enough to
send a request to. The Swagger Petstore is one: its `servers` entry is just `/api/v3`.

Try it and Portolan tells you:

> **You:** Add https://petstore3.swagger.io/api/v3/openapi.json as `petstore`.

```json
{
  "api_id": "petstore",
  "operations": 19,
  "environments": [],
  "warnings": [
    "The specification declares no usable servers entry; supply default_base_url or configure an environment before calling operations."
  ],
  "status": "added"
}
```

The import succeeded — you can search and inspect it — but calling anything fails, and
says exactly why:

```json
{
  "error": {
    "code": "ENVIRONMENT_NOT_FOUND",
    "message": "API 'petstore' has no environments. Add one under \"environments:\" in config.yaml, or re-import with default_base_url.",
    "details": { "api_id": "petstore", "available_environments": [] }
  }
}
```

Fix it by giving the API an **environment** in `~/.config/portolan/config.yaml`:

```yaml
environments:
  - api: petstore
    name: default
    base_url: https://petstore3.swagger.io/api/v3
    is_default: true
```

Restart Portolan (in Claude Code: `/mcp` → reconnect, or restart Claude Desktop) and
searching and calling both work:

> **You:** Using petstore, find pets by status "available".

```json
{
  "request": {
    "operation_id": "findPetsByStatus",
    "method": "GET",
    "url": "https://petstore3.swagger.io/api/v3/pet/findByStatus?status=available"
  },
  "response": { "status": 200, "body": [ ... ] }
}
```

---

## Step 7 — Allow writes

By default **every** environment is read-only. `POST`, `PUT`, `PATCH` and `DELETE` are
refused:

```json
{
  "error": {
    "code": "MUTATION_NOT_ALLOWED",
    "message": "Operation 'addPet' uses POST, which mutates state, but environment 'default' of API 'petstore' does not allow mutations. An operator must set allow_mutations: true for that environment in config.yaml.",
    "details": {
      "api_id": "petstore",
      "environment": "default",
      "method": "POST",
      "operation_id": "addPet"
    }
  }
}
```

This is deliberate. Adding a specification gives Claude the ability to _read_, never to
_write_, until you say so — per environment, in your config file:

```yaml
environments:
  - api: petstore
    name: default
    base_url: https://petstore3.swagger.io/api/v3
    allow_mutations: true # ← writes now permitted
    is_default: true
```

A common pattern is two environments, so the agent can read production but only write to
staging:

```yaml
environments:
  - api: acme
    name: production
    base_url: https://api.acme.com
    auth_profile: acme-prod
    allow_mutations: false
    is_default: true

  - api: acme
    name: staging
    base_url: https://staging.api.acme.com
    auth_profile: acme-staging
    allow_mutations: true
```

Claude picks the environment by name: _"update the record in staging"_.

---

## Step 8 — Add credentials

Credentials go in your config **by name only**. The actual secret lives in an environment
variable, and is never written to the database, never logged, and never shown to Claude.

```yaml
auth_profiles:
  acme-prod:
    type: bearer
    token_env: ACME_API_TOKEN
    # Optional but recommended: refuse to sign a request for any other host.
    allowed_hosts: ['api.acme.com']

environments:
  - api: acme
    name: production
    base_url: https://api.acme.com
    auth_profile: acme-prod
    is_default: true
```

Then make the variable available to the Portolan process:

```bash
claude mcp add portolan -s user -e ACME_API_TOKEN=sk-live-... -- portolan serve
```

or, in Claude Desktop:

```json
{
  "mcpServers": {
    "portolan": {
      "command": "portolan",
      "args": ["serve"],
      "env": { "ACME_API_TOKEN": "sk-live-..." }
    }
  }
}
```

The four supported profile types are `bearer`, `api_key` (header, query or cookie),
`basic`, and `oauth2_client_credentials`. See the
[README](../README.md#configuration) for the full shape of each.

Check what is wired up without revealing anything:

```bash
portolan doctor
```

```
✔ auth profile: acme-prod      bearer; required variables are set
! auth profile: acme-staging   bearer; unset environment variable(s): ACME_STAGING_TOKEN
```

---

## The six tools, in the order you use them

|     | Tool           | When                                           |
| --- | -------------- | ---------------------------------------------- |
| 1   | `add_api`      | Once per API. It is remembered.                |
| 2   | `find_api`     | You don't know which API can do the job.       |
| 3   | `search_api`   | You know the API, not the operation.           |
| 4   | `inspect_api`  | Before calling an operation you haven't used.  |
| 5   | `call_api`     | One request.                                   |
| 6   | `run_api_code` | Loops, pagination, several dependent requests. |

Claude is told this workflow automatically — you don't have to prompt it.

**When an API doesn't match its specification**, Claude corrects Portolan's copy with
`add_api` instead of working around the flaw on every call. The `add_api` result includes
a link to report the flaw to the API's maintainers when Portolan knows their GitHub
repository. To have Portolan file those issues itself, see "Reporting flaws upstream" in
the [README](../README.md#reporting-flaws-upstream).

---

## Troubleshooting

**`portolan: command not found`**
`npm link` didn't take, or your shell hasn't picked it up. Run `which portolan`; if it is
empty, use the absolute path `node /full/path/to/portolan/dist/cli/index.js` in your MCP
config.

**Claude Code says the server failed to connect**
Run `portolan doctor` directly. It reports the same problems with a real message. Also
check `claude mcp get portolan`.

**`ENVIRONMENT_NOT_FOUND`**
The API has no base URL — its specification declared a relative server, or none at all.
Add an `environments:` entry as in Step 6.

**`SPEC_PATCH_INVALID`**
A correction did not apply to the registered document, or the result was not valid
OpenAPI. Nothing was changed. Patch paths are JSON Pointers, so `/` in a path key is
written `~1`: `/paths/~1users~1{id}/get`.

**`"enrichment": {"status": "unavailable"}`**
Neither the agent CLI nor its ACP adapter was found on `PATH`, `npx` could not start the
adapter, or the agent is not logged in. `portolan doctor` says which. Make sure `claude`
(or `codex`) works on its own, install `@agentclientprotocol/claude-agent-acp` (or
`codex-acp`) if `npx` is unavailable, then run `portolan enrich` to describe the APIs you
already have.

**`MUTATION_NOT_ALLOWED`**
Working as intended. Set `allow_mutations: true` on that specific environment (Step 7).

**`NETWORK_DESTINATION_BLOCKED`**
Portolan refuses private, loopback and plain-`http` destinations by default. For a service
on your own network:

```yaml
network:
  allow_private_addresses: true
  allow_http: true # only if the service really has no TLS
```

Cloud metadata endpoints stay blocked regardless — there is no flag for those.

**`SANDBOX_UNAVAILABLE`**
`run_api_code` needs Deno. Install it, or point at it with `sandbox.deno_path` in your
config. The other five tools are unaffected.

**Config changes aren't taking effect**
Portolan reads its configuration at startup. Restart the server: in Claude Code use `/mcp`
and reconnect; in Claude Desktop, quit and reopen the app.

---

## Where to go next

- [README](../README.md) — the six tools and the security model
- [docs/SEARCH.md](SEARCH.md) — how ranking works, and what it cannot do
- [SPEC.md](../SPEC.md) — the full specification
