/**
 * Configuration loading (SPEC.md §39).
 *
 * Default location `~/.config/portolan/config.yaml`, overridable with `PORTOLAN_CONFIG`.
 * A missing file is not an error — Portolan starts with schema defaults, which are
 * deliberately the most restrictive settings (no private addresses, no loopback,
 * no mutations, no credentials).
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { PortolanError } from '../errors/errors.js';
import { configSchema, type PortolanConfig } from './schema.js';

export type { PortolanConfig } from './schema.js';
export type { AuthProfileConfig, EnvironmentConfig } from './schema.js';

/** Expand a leading `~` and make the path absolute. */
export function expandPath(input: string): string {
  const expanded = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function defaultConfigPath(): string {
  return process.env.PORTOLAN_CONFIG
    ? expandPath(process.env.PORTOLAN_CONFIG)
    : join(homedir(), '.config', 'portolan', 'config.yaml');
}

export interface LoadedConfig {
  config: PortolanConfig;
  /** Absolute path the configuration was read from, or `null` when defaults were used. */
  path: string | null;
}

/** Format Zod issues as one readable, path-qualified list. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseConfig(raw: unknown, source: string): PortolanConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new PortolanError(
      'CONFIG_INVALID',
      `Invalid configuration in ${source}: ${formatIssues(result.error)}`,
      {
        source,
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    );
  }
  return validateSemantics(result.data, source);
}

/**
 * Cross-field checks the schema cannot express.
 * These are security-relevant, so they fail startup rather than warn.
 */
function validateSemantics(config: PortolanConfig, source: string): PortolanConfig {
  const problems: string[] = [];

  for (const env of config.environments) {
    if (env.auth_profile && !config.auth_profiles[env.auth_profile]) {
      problems.push(
        `environments[${env.api}/${env.name}].auth_profile references unknown profile '${env.auth_profile}'`,
      );
    }
  }

  // SPEC.md §40 / docs/DEVIATIONS.md D17.
  if (config.server.transport === 'http' && !isLoopbackHost(config.server.http.host)) {
    if (!config.server.http.auth_token_env) {
      problems.push(
        `server.http.host '${config.server.http.host}' is not a loopback address; ` +
          'server.http.auth_token_env is required before binding a non-loopback interface',
      );
    }
  }

  if (config.feedback.upstream_issues === 'file' && !config.feedback.github.token_env) {
    problems.push('feedback.upstream_issues is "file" but feedback.github.token_env is not set');
  }

  if (config.logging.destination === 'file' && !config.logging.file) {
    problems.push('logging.destination is "file" but logging.file is not set');
  }

  if (problems.length > 0) {
    throw new PortolanError(
      'CONFIG_INVALID',
      `Invalid configuration in ${source}: ${problems.join('; ')}`,
      {
        source,
        problems,
      },
    );
  }
  return config;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    /^127\./.test(normalized)
  );
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const path = explicitPath ? expandPath(explicitPath) : defaultConfigPath();
  if (!existsSync(path)) {
    return { config: parseConfig({}, 'built-in defaults'), path: null };
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new PortolanError(
      'CONFIG_INVALID',
      `Could not parse ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { source: path },
    );
  }
  return { config: parseConfig(raw, path), path };
}

export const EXAMPLE_CONFIG = `# Portolan configuration — see SPEC.md §39
#
# Secrets are NEVER written here. Auth profiles name environment variables; the
# values live in the process environment.

database:
  path: ~/.local/share/portolan/portolan.db

server:
  transport: stdio
  # http:
  #   host: 127.0.0.1
  #   port: 8765
  #   # Required before binding any non-loopback host:
  #   auth_token_env: PORTOLAN_HTTP_TOKEN

limits:
  max_spec_bytes: 10485760
  max_response_bytes: 2097152
  max_tool_response_bytes: 524288
  default_timeout_ms: 30000
  sandbox_timeout_ms: 30000
  sandbox_max_api_calls: 50

network:
  # Outbound requests are denied to private, loopback and link-local addresses
  # unless explicitly enabled here.
  allow_private_addresses: false
  allow_loopback: false
  allow_http: false
  # When set, every outbound destination host must appear in this list.
  allowed_hosts: []

security:
  # When false (the default) the add_api MCP tool may not attach a credential
  # profile to an environment; do that here instead.
  allow_agent_auth_profile_binding: false

feedback:
  # What to do when Portolan or an agent corrects a flaw in a specification:
  #   draft — return a prefilled "new issue" link for the upstream repository
  #   file  — file the issue on GitHub with the token below
  #   off   — correct the local copy only
  upstream_issues: draft
  # Upstream repositories by api_id, when they cannot be detected from the spec URL.
  # repositories:
  #   example: example-org/example-openapi
  # github:
  #   token_env: GITHUB_TOKEN
  #   max_issues_per_repo_per_day: 5

logging:
  level: info

# auth_profiles:
#   example-bearer:
#     type: bearer
#     token_env: EXAMPLE_TOKEN
#     # Optional second line of defence: refuse to sign for any other host.
#     allowed_hosts: ["api.example.com"]
#
#   example-api-key:
#     type: api_key
#     location: header
#     name: X-API-Key
#     value_env: EXAMPLE_API_KEY
#
#   example-basic:
#     type: basic
#     username_env: EXAMPLE_USERNAME
#     password_env: EXAMPLE_PASSWORD
#
#   example-oauth2:
#     type: oauth2_client_credentials
#     token_url: https://example.com/oauth/token
#     client_id_env: EXAMPLE_CLIENT_ID
#     client_secret_env: EXAMPLE_CLIENT_SECRET
#     scopes: [admin]

# environments:
#   - api: example
#     name: production
#     base_url: https://api.example.com
#     auth_profile: example-bearer
#     allow_mutations: false
`;
