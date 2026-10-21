/** The CLI surface (SPEC.md §40). */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.js';
import { runDoctor, formatDoctorReport, doctorExitCode } from '../../src/cli/doctor.js';

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
    // A directory cannot be created beneath a regular file, on any platform. (A path
    // under /proc is no good: on Linux, Node's recursive mkdirSync loops forever there.)
    const file = join(base, 'not-a-directory');
    writeFileSync(file, '');
    writeFileSync(configPath, `database:\n  path: ${join(file, 'p.db')}\n`);
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
