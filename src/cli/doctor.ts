/**
 * `portolan doctor` (SPEC.md §40).
 *
 * Checks configuration, database, FTS5, the Deno runtime, MCP initialization, auth
 * environment variables and directory permissions. It reports whether a secret is
 * *present*, never what it is.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPortolan } from '../app.js';
import { expandPath, loadConfig } from '../config/config.js';
import { PortolanError } from '../errors/errors.js';
import { createSilentLogger } from '../logging.js';
import { createMcpServer } from '../mcp/server.js';
import { TOOL_NAMES } from '../mcp/tools/index.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  ok: boolean;
}

export async function runDoctor(explicitConfigPath?: string): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  // --- configuration -------------------------------------------------------
  let loaded;
  try {
    loaded = loadConfig(explicitConfigPath);
    add(
      'configuration',
      'ok',
      loaded.path ? `loaded ${loaded.path}` : 'no config file found; using built-in defaults',
    );
  } catch (error) {
    add('configuration', 'fail', error instanceof Error ? error.message : String(error));
    return { checks, ok: false };
  }
  const { config } = loaded;

  // --- directories ---------------------------------------------------------
  const databasePath = expandPath(config.database.path);
  const databaseDir = dirname(databasePath);
  if (databasePath === ':memory:') {
    add('database directory', 'ok', 'in-memory database; no directory required');
  } else if (!existsSync(databaseDir)) {
    add('database directory', 'fail', `${databaseDir} does not exist; run "portolan init"`);
  } else {
    try {
      accessSync(databaseDir, constants.W_OK);
      add('database directory', 'ok', `${databaseDir} is writable`);
    } catch {
      add('database directory', 'fail', `${databaseDir} is not writable`);
    }
  }

  if (loaded.path && existsSync(loaded.path)) {
    const mode = statSync(loaded.path).mode & 0o777;
    if ((mode & 0o077) !== 0 && process.platform !== 'win32') {
      add(
        'configuration permissions',
        'warn',
        `${loaded.path} is mode ${mode.toString(8)}; 600 is recommended since it names credential sources`,
      );
    } else {
      add('configuration permissions', 'ok', 'configuration file is not world-readable');
    }
  }

  // --- database and FTS5 ---------------------------------------------------
  let app;
  try {
    app = createPortolan({ config, logger: createSilentLogger() });
    add('database', 'ok', `opened ${databasePath}`);
    add('sqlite fts5', 'ok', 'FTS5 is available');
  } catch (error) {
    add('database', 'fail', error instanceof Error ? error.message : String(error));
    return { checks, ok: false };
  }

  try {
    const apis = app.catalog.listApis();
    add('catalog', 'ok', `${apis.length} API(s) registered`);

    // --- Deno sandbox ------------------------------------------------------
    const sandbox = app.sandbox.status();
    if (sandbox.available) {
      add('deno runtime', 'ok', `found ${sandbox.denoPath}`);
    } else if (!sandbox.denoPath) {
      add(
        'deno runtime',
        'warn',
        'Deno was not found. run_api_code will be unavailable; the other five tools work. Install Deno or set sandbox.deno_path.',
      );
    } else {
      add(
        'deno runtime',
        'fail',
        `sandbox runtime missing at ${sandbox.runtime}; re-run the build`,
      );
    }

    // --- MCP initialization ------------------------------------------------
    try {
      const server = createMcpServer(app);
      await server.close();
      add('mcp server', 'ok', `initializes with ${TOOL_NAMES.length} tools`);
    } catch (error) {
      add('mcp server', 'fail', error instanceof Error ? error.message : String(error));
    }

    // --- auth profiles -----------------------------------------------------
    const profileNames = Object.keys(config.auth_profiles);
    if (profileNames.length === 0) {
      add('auth profiles', 'ok', 'none configured');
    } else {
      for (const name of profileNames) {
        const readiness = app.auth.describeReadiness(name);
        if (readiness.missing.length === 0) {
          add(`auth profile: ${name}`, 'ok', `${readiness.type}; required variables are set`);
        } else {
          add(
            `auth profile: ${name}`,
            'warn',
            `${readiness.type}; unset environment variable(s): ${readiness.missing.join(', ')}`,
          );
        }
      }
    }

    // --- environments ------------------------------------------------------
    let withMutations = 0;
    for (const api of app.catalog.listApis()) {
      for (const environment of app.catalog.listEnvironments(api.id)) {
        if (environment.allowMutations) withMutations += 1;
      }
    }
    add(
      'mutation policy',
      'ok',
      withMutations === 0
        ? 'no environment allows mutations (read-only)'
        : `${withMutations} environment(s) allow mutating requests`,
    );

    // --- network policy ----------------------------------------------------
    const relaxed: string[] = [];
    if (config.network.allow_private_addresses) relaxed.push('allow_private_addresses');
    if (config.network.allow_loopback) relaxed.push('allow_loopback');
    if (config.network.allow_http) relaxed.push('allow_http');
    if (config.security.allow_agent_auth_profile_binding) {
      relaxed.push('security.allow_agent_auth_profile_binding');
    }
    add(
      'network policy',
      relaxed.length === 0 ? 'ok' : 'warn',
      relaxed.length === 0
        ? 'defaults: private, loopback and plain-http destinations are blocked'
        : `relaxed: ${relaxed.join(', ')}`,
    );
  } finally {
    app.close();
  }

  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}

export function formatDoctorReport(report: DoctorReport): string {
  const symbol: Record<CheckStatus, string> = { ok: '✔', warn: '!', fail: '✖' };
  const lines = report.checks.map(
    (check) => `${symbol[check.status]} ${check.name.padEnd(28)} ${check.detail}`,
  );
  lines.push('');
  lines.push(
    report.ok ? 'Portolan looks healthy.' : 'Portolan has problems; see the ✖ lines above.',
  );
  return lines.join('\n');
}

export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? 0 : 1;
}

export { PortolanError };
