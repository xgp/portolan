/** The CLI surface (SPEC.md §40). */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.js';
import { runDoctor, formatDoctorReport, doctorExitCode } from '../../src/cli/doctor.js';
import { formatEnrichmentRun, runEnrich } from '../../src/cli/enrich.js';
import { createPortolan } from '../../src/app.js';
import { parseConfig } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/logging.js';
import { FIXTURE_DIR, readSpec } from '../fixtures/helpers.js';

let dir: string | undefined;

function tmp(): string {
  dir = mkdtempSync(join(tmpdir(), 'portolan-cli-'));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('portolan init', () => {
  it('creates a config file and the data directory', () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    const result = runInit(configPath);
    expect(result.configCreated).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('auth_profiles');
  });

  it('writes the config file without world-readable permissions', () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    runInit(configPath);
    const mode = statSync(configPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('never overwrites an existing configuration', () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    const custom = join(base, 'custom', 'path.db');
    writeFileSync(configPath, `database:\n  path: ${custom}\n`);
    const result = runInit(configPath);
    expect(result.configCreated).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain(custom);
    expect(result.databaseDirectory).toBe(join(base, 'custom'));
  });

  it('reports an unusable data directory instead of a raw filesystem error', () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    writeFileSync(configPath, 'database:\n  path: /proc/portolan-cannot-live-here/p.db\n');
    expect(() => runInit(configPath)).toThrow(/Could not create the data directory/);
  });

  it('produces a configuration that actually parses', () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    expect(() => runInit(configPath)).not.toThrow();
  });
});

describe('portolan doctor', () => {
  it('reports healthy for a fresh installation', async () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    writeFileSync(
      configPath,
      `database:\n  path: ${join(base, 'p.db')}\nlogging:\n  level: silent\n`,
    );

    const report = await runDoctor(configPath);
    expect(doctorExitCode(report)).toBe(0);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('configuration');
    expect(names).toContain('sqlite fts5');
    expect(names).toContain('deno runtime');
    expect(names).toContain('mcp server');
    expect(names).toContain('network policy');
    expect(report.checks.find((c) => c.name === 'mcp server')?.detail).toContain('6 tools');
  });

  it('fails on invalid configuration rather than starting anyway', async () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    writeFileSync(configPath, 'netwrok:\n  allow_loopback: true\n');
    const report = await runDoctor(configPath);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('fail');
  });

  it('reports which credential variables are unset without revealing any value', async () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    process.env.DOCTOR_PRESENT = 'super-secret-doctor-value';
    delete process.env.DOCTOR_ABSENT;
    writeFileSync(
      configPath,
      `database:\n  path: ${join(base, 'p.db')}\nlogging:\n  level: silent\n` +
        'auth_profiles:\n' +
        '  present:\n    type: bearer\n    token_env: DOCTOR_PRESENT\n' +
        '  absent:\n    type: bearer\n    token_env: DOCTOR_ABSENT\n',
    );
    try {
      const report = await runDoctor(configPath);
      const present = report.checks.find((c) => c.name === 'auth profile: present')!;
      const absent = report.checks.find((c) => c.name === 'auth profile: absent')!;
      expect(present.status).toBe('ok');
      expect(absent.status).toBe('warn');
      expect(absent.detail).toContain('DOCTOR_ABSENT');
      // The value is never printed, only the variable name.
      expect(formatDoctorReport(report)).not.toContain('super-secret-doctor-value');
    } finally {
      delete process.env.DOCTOR_PRESENT;
    }
  });

  it('warns when the network policy has been relaxed', async () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    writeFileSync(
      configPath,
      `database:\n  path: ${join(base, 'p.db')}\nlogging:\n  level: silent\n` +
        'network:\n  allow_private_addresses: true\n  allow_loopback: true\n',
    );
    const report = await runDoctor(configPath);
    const check = report.checks.find((c) => c.name === 'network policy')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('allow_private_addresses');
    // A relaxed policy is a warning, not a failure.
    expect(report.ok).toBe(true);
  });
});

describe('portolan enrich (docs/DEVIATIONS.md D24)', () => {
  const fakeAgent = (mode: string) =>
    `    claude:\n      command: ${process.execPath}\n      args: [${join(FIXTURE_DIR, 'fake-acp-agent.mjs')}, --mode=${mode}]\n`;

  async function catalogWithUsers(base: string, mode = 'describe'): Promise<string> {
    const configPath = join(base, 'config.yaml');
    const database = join(base, 'p.db');
    writeFileSync(
      configPath,
      `database:\n  path: ${database}\nlogging:\n  level: silent\nenrichment:\n  agent: claude\n  agents:\n${fakeAgent(mode)}`,
    );
    // Register the API with enrichment off, as if no agent had been installed yet.
    const app = createPortolan({
      config: parseConfig({ database: { path: database }, enrichment: { agent: 'off' } }, 'test'),
      logger: createSilentLogger(),
    });
    await app.catalog.addApi({ specContent: readSpec('users-api.yaml'), apiId: 'users' });
    app.close();
    return configPath;
  }

  it('describes every API with work pending, then has nothing left to do', async () => {
    const configPath = await catalogWithUsers(tmp());
    const runs = await runEnrich({ configPath, apiIds: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ api_id: 'users', agent: 'claude', operations_pending: 0 });
    expect(formatEnrichmentRun(runs[0]!)).toMatch(
      /^users: \d+ operation\(s\) described by claude and the API summarised; \d+ finding\(s\); 0 operation\(s\) still pending$/,
    );
    expect(await runEnrich({ configPath, apiIds: [] })).toEqual([]);
  });

  it('refuses when no agent can run, and names unknown APIs', async () => {
    const base = tmp();
    const configPath = join(base, 'config.yaml');
    writeFileSync(
      configPath,
      `database:\n  path: ${join(base, 'p.db')}\nlogging:\n  level: silent\nenrichment:\n  agent: claude\n  agents:\n    claude:\n      command: portolan-no-such-acp-adapter\n`,
    );
    await expect(runEnrich({ configPath, apiIds: [] })).rejects.toThrow(/No ACP adapter/);

    const working = await catalogWithUsers(tmp());
    await expect(runEnrich({ configPath: working, apiIds: ['nope'] })).rejects.toMatchObject({
      code: 'API_NOT_FOUND',
    });
  });

  it('is reported by doctor', async () => {
    const configPath = await catalogWithUsers(tmp());
    const report = await runDoctor(configPath);
    expect(report.checks.find((c) => c.name === 'enrichment')).toMatchObject({ status: 'ok' });
    expect(report.checks.find((c) => c.name === 'lint')).toMatchObject({ status: 'ok' });
  });
});
