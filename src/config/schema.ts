/**
 * Configuration schema (SPEC.md §39).
 *
 * Every object is `.strict()`: an unknown key is a startup error rather than a silently
 * ignored typo. See docs/DEVIATIONS.md (D16) for why this is stricter than the spec's
 * "security-sensitive keys" wording.
 */
import { z } from 'zod';

const envVarName = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name');

const httpsUrl = z.string().url();

/** Hosts an auth profile is willing to sign requests for (docs/DEVIATIONS.md D5). */
const allowedHosts = z.array(z.string().min(1)).optional();

export const bearerProfileSchema = z
  .object({
    type: z.literal('bearer'),
    token_env: envVarName,
    allowed_hosts: allowedHosts,
  })
  .strict();

export const apiKeyProfileSchema = z
  .object({
    type: z.literal('api_key'),
    location: z.enum(['header', 'query', 'cookie']),
    name: z.string().min(1),
    value_env: envVarName,
    /** Optional literal prefix, e.g. `Bearer ` when the key goes in an Authorization header. */
    prefix: z.string().optional(),
    allowed_hosts: allowedHosts,
  })
  .strict();

export const basicProfileSchema = z
  .object({
    type: z.literal('basic'),
    username_env: envVarName,
    password_env: envVarName,
    allowed_hosts: allowedHosts,
  })
  .strict();

export const oauth2ClientCredentialsProfileSchema = z
  .object({
    type: z.literal('oauth2_client_credentials'),
    token_url: httpsUrl,
    client_id_env: envVarName,
    client_secret_env: envVarName,
    scopes: z.array(z.string().min(1)).optional(),
    audience: z.string().optional(),
    /** `body` (default) sends credentials as form fields; `basic` uses HTTP Basic. */
    client_auth: z.enum(['body', 'basic']).default('body'),
    allowed_hosts: allowedHosts,
  })
  .strict();

export const authProfileSchema = z.discriminatedUnion('type', [
  bearerProfileSchema,
  apiKeyProfileSchema,
  basicProfileSchema,
  oauth2ClientCredentialsProfileSchema,
]);

export type AuthProfileConfig = z.infer<typeof authProfileSchema>;

export const environmentConfigSchema = z
  .object({
    api: z.string().min(1),
    name: z.string().min(1),
    base_url: httpsUrl,
    auth_profile: z.string().min(1).optional(),
    /** SPEC.md §29: mutations are opt-in, per environment, server side only. */
    allow_mutations: z.boolean().default(false),
    is_default: z.boolean().default(false),
  })
  .strict();

export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;

/** A GitHub repository as `owner/name`. */
export const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/, 'must be a repository as "owner/name"');

/** How to start one ACP agent adapter (docs/DEVIATIONS.md D24). */
const acpAgentSchema = (defaultCommand: string) =>
  z
    .object({
      /** Executable name (looked up on PATH) or absolute path. */
      command: z.string().min(1).default(defaultCommand),
      args: z.array(z.string()).default([]),
      /**
       * Extra environment variables passed through to the agent, beyond the built-in
       * allowlist. Variables named anywhere else in this file are never passed.
       */
      env: z.array(envVarName).default([]),
    })
    .strict()
    .prefault({});

export const lintSeveritySchema = z.enum(['off', 'error', 'warn', 'info', 'hint']);

export const configSchema = z
  .object({
    database: z
      .object({ path: z.string().min(1).default('~/.local/share/portolan/portolan.db') })
      .strict()
      .prefault({}),

    server: z
      .object({
        transport: z.enum(['stdio', 'http']).default('stdio'),
        http: z
          .object({
            host: z.string().min(1).default('127.0.0.1'),
            port: z.number().int().min(1).max(65535).default(8765),
            /**
             * Bearer token for the HTTP transport. Required when `host` is not a loopback
             * address (SPEC.md §40, docs/DEVIATIONS.md D17).
             */
            auth_token_env: envVarName.optional(),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),

    limits: z
      .object({
        max_spec_bytes: z.number().int().positive().default(10_485_760),
        max_response_bytes: z.number().int().positive().default(2_097_152),
        max_tool_response_bytes: z.number().int().positive().default(524_288),
        default_timeout_ms: z.number().int().positive().default(30_000),
        max_timeout_ms: z.number().int().positive().default(120_000),
        spec_fetch_timeout_ms: z.number().int().positive().default(30_000),
        oauth_timeout_ms: z.number().int().positive().default(15_000),
        max_redirects: z.number().int().min(0).max(10).default(3),
        sandbox_timeout_ms: z.number().int().positive().default(30_000),
        sandbox_max_timeout_ms: z.number().int().positive().default(120_000),
        sandbox_max_api_calls: z.number().int().positive().default(50),
        sandbox_max_api_calls_hard: z.number().int().positive().default(500),
        sandbox_max_input_bytes: z.number().int().positive().default(262_144),
        sandbox_max_code_bytes: z.number().int().positive().default(262_144),
        sandbox_max_output_bytes: z.number().int().positive().default(524_288),
        sandbox_max_total_response_bytes: z.number().int().positive().default(16_777_216),
        sandbox_max_log_entries: z.number().int().positive().default(100),
        sandbox_max_log_bytes: z.number().int().positive().default(16_384),
      })
      .strict()
      .prefault({}),

    network: z
      .object({
        allow_private_addresses: z.boolean().default(false),
        allow_loopback: z.boolean().default(false),
        allow_http: z.boolean().default(false),
        /** When non-empty, every outbound destination host must appear here. */
        allowed_hosts: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .prefault({}),

    security: z
      .object({
        /**
         * Whether the MCP `add_api` tool may bind a named auth profile to an environment.
         * Default off: see docs/DEVIATIONS.md D5.
         */
        allow_agent_auth_profile_binding: z.boolean().default(false),
      })
      .strict()
      .prefault({}),

    sandbox: z
      .object({
        /** Path to the Deno binary. Resolved from PATH and the usual install dirs if unset. */
        deno_path: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),

    logging: z
      .object({
        level: z
          .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
          .default('info'),
        /** Where logs go. stdio transport must never write to stdout. */
        destination: z.enum(['stderr', 'file']).default('stderr'),
        file: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),

    /**
     * Raising specification flaws with the upstream project (docs/DEVIATIONS.md D22).
     * `draft` (default) returns a prefilled "new issue" link and makes no outbound call;
     * `file` files the issue with the token in `github.token_env`; `off` does neither.
     */
    feedback: z
      .object({
        upstream_issues: z.enum(['off', 'draft', 'file']).default('draft'),
        /** api_id → `owner/name`. Authoritative over anything detected from a document. */
        repositories: z.record(z.string().min(1), repositoryName).default({}),
        github: z
          .object({
            token_env: envVarName.optional(),
            api_url: httpsUrl.default('https://api.github.com'),
            web_url: httpsUrl.default('https://github.com'),
            max_issues_per_repo_per_day: z.number().int().min(0).default(5),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),

    /** Spectral linting during add_api (docs/DEVIATIONS.md D23). */
    lint: z
      .object({
        enabled: z.boolean().default(true),
        /** Spectral rule name → severity or `off`, over Portolan's defaults. */
        rules: z.record(z.string().min(1), lintSeveritySchema).default({}),
      })
      .strict()
      .prefault({}),

    /**
     * Describing operations and reviewing documents with a local coding agent over the
     * Agent Client Protocol (docs/DEVIATIONS.md D24). `auto` uses Claude Code, then Codex,
     * whichever adapter is installed and logged in; `off` never starts one.
     */
    enrichment: z
      .object({
        agent: z.enum(['auto', 'claude', 'codex', 'off']).default('auto'),
        agents: z
          .object({
            claude: acpAgentSchema('claude-agent-acp'),
            codex: acpAgentSchema('codex-acp'),
          })
          .strict()
          .prefault({}),
        /**
         * When an adapter is not on PATH but `claude` or `codex` is, run the adapter with
         * `npx -y` at the version Portolan pins. The first run downloads it.
         */
        npx_fallback: z.boolean().default(true),
        /** A model the agent offers, e.g. `sonnet`. The agent's default when unset. */
        model: z.string().min(1).optional(),
        /** Operations described per prompt. */
        batch_size: z.number().int().min(1).max(100).default(20),
        /** Operations described per API; the least-documented are chosen first. */
        max_operations_per_api: z.number().int().min(0).default(200),
        prompt_timeout_ms: z.number().int().positive().default(300_000),
      })
      .strict()
      .prefault({}),

    auth_profiles: z.record(z.string().min(1), authProfileSchema).default({}),

    environments: z.array(environmentConfigSchema).default([]),
  })
  .strict();

export type PortolanConfig = z.infer<typeof configSchema>;
