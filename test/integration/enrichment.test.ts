/**
 * Enriching APIs with a coding agent over ACP (docs/DEVIATIONS.md D24).
 *
 * The agent is a real ACP agent process (test/fixtures/fake-acp-agent.mjs) driven over
 * stdio by the same client code that drives claude-agent-acp and codex-acp, so the
 * protocol, the lockdown and the failure handling are exercised end to end.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPortolan, type Portolan } from '../../src/app.js';
import { inspectOperations } from '../../src/catalog/inspector.js';
import { createSilentLogger } from '../../src/logging.js';
import { FIXTURE_DIR, readSpec, testConfig } from '../fixtures/helpers.js';

const FAKE_AGENT = join(FIXTURE_DIR, 'fake-acp-agent.mjs');

let app: Portolan | undefined;
let logDir: string | undefined;

afterEach(() => {
  app?.close();
  app = undefined;
  if (logDir) rmSync(logDir, { recursive: true, force: true });
  logDir = undefined;
  delete process.env.FAKE_ACP_LOG;
  delete process.env.ENRICH_TEST_SECRET;
  delete process.env.ENRICH_TEST_UNLISTED;
  delete process.env.ANTHROPIC_ENRICH_TEST;
});

function fakeAgent(mode: string) {
  return { command: process.execPath, args: [FAKE_AGENT, `--mode=${mode}`], env: ['FAKE_ACP_LOG'] };
}

function start(
  enrichment: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Portolan {
  logDir = mkdtempSync(join(tmpdir(), 'portolan-acp-log-'));
  process.env.FAKE_ACP_LOG = join(logDir, 'requests.jsonl');
  const config = testConfig({
    enrichment: {
      agent: 'claude',
      agents: { claude: fakeAgent('describe') },
      batch_size: 2,
      prompt_timeout_ms: 10_000,
      ...enrichment,
    },
    ...extra,
  });
  app = createPortolan({ config, logger: createSilentLogger(), databasePath: ':memory:' });
  return app;
}

/** Requests the fake agent received, in order. */
function requests(): { method: string; mode: string; params: Record<string, unknown> }[] {
  try {
    return readFileSync(process.env.FAKE_ACP_LOG!, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as never);
  } catch {
    return [];
  }
}

async function addUsers(portolan: Portolan, spec = readSpec('users-api.yaml')) {
  const result = await portolan.catalog.addApi({ specContent: spec, apiId: 'users' });
  await portolan.enricher.idle();
  return result;
}

describe('enrichment', () => {
  it('queues the API from add_api and describes every operation in the background', async () => {
    const portolan = start();
    const result = await portolan.catalog.addApi({
      specContent: readSpec('users-api.yaml'),
      apiId: 'users',
    });
    const total = portolan.catalog.listOperations('users').length;
    expect(result.enrichment).toEqual({ status: 'queued', agent: 'claude', pending: total });

    await portolan.enricher.idle();
    expect(portolan.enricher.pendingWork('users')).toEqual({ operations: [], api: false });
    // batch_size 2: ceil(total / 2) operation prompts, then one for the API.
    expect(requests().filter((r) => r.method === 'session/prompt')).toHaveLength(
      Math.ceil(total / 2) + 1,
    );
  });

  it('adds what the agent wrote to inspect_api without touching the document', async () => {
    const portolan = start();
    await addUsers(portolan);
    const before = portolan.catalog.getCurrentVersion('users').specHash;

    const [operation] = inspectOperations(portolan.catalog, 'users', ['users.list']).operations;
    expect(operation!.description).toContain('Search the user directory');
    expect(operation!.generated).toEqual({
      by: 'claude',
      // The control character the agent sent is gone.
      description: 'Fake description of users.list for zebracorn search.',
      parameters: { email: 'About email.', enabled: 'About enabled.', limit: 'About limit.' },
      findings: [{ severity: 'warn', message: 'Fake finding for users.list.' }],
    });
    expect(portolan.catalog.getCurrentVersion('users').specHash).toBe(before);
  });

  it('makes generated text searchable', async () => {
    const portolan = start();
    await addUsers(portolan);
    const operations = await portolan.search.searchOperations('users', 'zebracorn', 10);
    expect(operations.length).toBe(portolan.catalog.listOperations('users').length);
    const apis = await portolan.search.searchApis('unicornish', 5);
    expect(apis.map((a) => a.api_id)).toEqual(['users']);
  });

  it('does nothing more for an unchanged re-import, and only new operations after a change', async () => {
    const portolan = start();
    await addUsers(portolan);
    const prompts = () => requests().filter((r) => r.method === 'session/prompt').length;
    const afterFirst = prompts();

    const again = await portolan.catalog.addApi({
      specContent: readSpec('users-api.yaml'),
      apiId: 'users',
      replace: true,
    });
    expect(again.enrichment).toEqual({ status: 'up_to_date' });

    const changed = readSpec('users-api.yaml').replace(
      'Search the user directory.',
      'Search the whole user directory.',
    );
    const replaced = await portolan.catalog.addApi({
      specContent: changed,
      apiId: 'users',
      replace: true,
    });
    // One operation changed; the API as a whole is a new version, so it is described again.
    expect(replaced.enrichment).toMatchObject({ status: 'queued', pending: 1 });
    await portolan.enricher.idle();
    expect(prompts()).toBe(afterFirst + 2);
  });

  it('starts the agent locked down: no client capabilities, no tools, no user settings', async () => {
    const portolan = start();
    await addUsers(portolan);
    const initialize = requests().find((r) => r.method === 'initialize')!;
    expect(initialize.params.clientCapabilities).toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    const session = requests().find((r) => r.method === 'session/new')!;
    expect(session.params.mcpServers).toEqual([]);
    expect(session.params._meta).toMatchObject({
      claudeCode: { options: { tools: [], settingSources: [], mcpServers: {} } },
    });
    expect(requests().some((r) => r.method === 'session/close')).toBe(true);
  });

  it('refuses every permission request', async () => {
    const portolan = start({ agents: { claude: fakeAgent('permission') } });
    await addUsers(portolan);
    const [operation] = inspectOperations(portolan.catalog, 'users', ['users.list']).operations;
    expect(operation!.generated?.description).toContain('permission:cancelled');
  });

  it('cancels a turn that uses a tool and keeps none of its output', async () => {
    const portolan = start({ agents: { claude: fakeAgent('tool') } });
    await addUsers(portolan);
    const run = await portolan.enricher.enrich('users');
    expect(run.operations_enriched).toBe(0);
    expect(run.errors.join(' ')).toMatch(/tried to use a tool \(Read ~\/.ssh\/id_rsa\)/);
    expect(requests().some((r) => r.method === 'session/cancel')).toBe(true);
    // A tool call ends a job rather than trying every batch: one prompt for the queued
    // job, one for the run above.
    expect(requests().filter((r) => r.method === 'session/prompt')).toHaveLength(2);
    expect(portolan.enricher.pendingWork('users').api).toBe(true);
  });

  it('passes only allowlisted variables, and never one a credential is read from', async () => {
    process.env.ENRICH_TEST_SECRET = 'hunter2';
    process.env.ENRICH_TEST_UNLISTED = 'x';
    process.env.ANTHROPIC_ENRICH_TEST = 'y';
    const portolan = start(
      { agents: { claude: { ...fakeAgent('env'), env: ['FAKE_ACP_LOG', 'ENRICH_TEST_SECRET'] } } },
      { auth_profiles: { svc: { type: 'bearer', token_env: 'ENRICH_TEST_SECRET' } } },
    );
    await addUsers(portolan);
    const [operation] = inspectOperations(portolan.catalog, 'users', ['users.list']).operations;
    const names = operation!.generated!.description!.replace(/^env: /, '').split(' ');
    expect(names).toContain('PATH');
    expect(names).toContain('ANTHROPIC_ENRICH_TEST');
    expect(names).not.toContain('ENRICH_TEST_SECRET');
    expect(names).not.toContain('ENRICH_TEST_UNLISTED');
  });

  it('falls back to the next agent when the first is not logged in', async () => {
    const portolan = start({
      agent: 'auto',
      agents: { claude: fakeAgent('auth'), codex: fakeAgent('describe') },
    });
    await addUsers(portolan);
    const [operation] = inspectOperations(portolan.catalog, 'users', ['users.list']).operations;
    expect(operation!.generated?.by).toBe('codex');
    expect(portolan.enricher.pendingWork('users')).toEqual({ operations: [], api: false });
    // Codex is given its own lockdown through the environment, not session metadata.
    const sessions = requests().filter((r) => r.method === 'session/new');
    expect(sessions.at(-1)!.params._meta).toBeUndefined();

    // The failed agent is remembered rather than retried on every import.
    const next = await portolan.catalog.addApi({
      specContent: readSpec('petstore-3.0.yaml'),
      apiId: 'pets',
    });
    expect(next.enrichment).toMatchObject({ status: 'queued', agent: 'codex' });
  });

  it('counts a reply that is not JSON as a failed batch and carries on', async () => {
    const portolan = start({ agents: { claude: fakeAgent('garbage') } });
    await addUsers(portolan);
    const run = await portolan.enricher.enrich('users');
    const total = portolan.catalog.listOperations('users').length;
    expect(run.failed_batches).toBe(Math.ceil(total / 2));
    expect(run.operations_enriched).toBe(0);
    expect(run.operations_pending).toBe(total);
  });

  it('gives up on a prompt that takes too long', async () => {
    const portolan = start({
      agents: { claude: fakeAgent('hang') },
      prompt_timeout_ms: 300,
      max_operations_per_api: 1,
    });
    await portolan.catalog.addApi({ specContent: readSpec('petstore-3.1.yaml'), apiId: 'pets' });
    await portolan.enricher.idle();
    const run = await portolan.enricher.enrich('pets');
    expect(run.errors[0]).toMatch(/did not answer in time/);
    expect(requests().some((r) => r.method === 'session/cancel')).toBe(true);
  });

  it('can be closed while an agent is working', async () => {
    const portolan = start({ agents: { claude: fakeAgent('hang') } });
    await portolan.catalog.addApi({ specContent: readSpec('users-api.yaml'), apiId: 'users' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    portolan.close();
    app = undefined;
    await portolan.enricher.idle();
  });

  it('describes the least documented operations first, up to the configured limit', async () => {
    const portolan = start({ max_operations_per_api: 2 });
    await addUsers(portolan);
    const documented = portolan.catalog
      .listOperations('users')
      .map((op) => ({
        id: op.canonicalId,
        text: (op.summary ?? '') + (op.description ?? ''),
        generated: inspectOperations(portolan.catalog, 'users', [op.canonicalId]).operations[0]!
          .generated,
      }))
      .sort((a, b) => a.text.length - b.text.length);
    expect(documented.filter((op) => op.generated).map((op) => op.id)).toEqual(
      documented.slice(0, 2).map((op) => op.id),
    );
  });

  it('reports why nothing will happen when no agent can run', async () => {
    const off = start({ agent: 'off' });
    expect((await addUsers(off)).enrichment).toEqual({ status: 'disabled' });
    off.close();

    const missing = start({ agents: { claude: { command: 'portolan-no-such-acp-adapter' } } });
    expect((await addUsers(missing)).enrichment).toEqual({
      status: 'unavailable',
      message:
        'No ACP adapter found on PATH (portolan-no-such-acp-adapter), and no agent CLI to run one for with npx.',
    });
  });

  describe.skipIf(process.platform === 'win32')('npx fallback', () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    /** A PATH holding a `claude` CLI and an `npx` that records its arguments and starts the fake agent. */
    function fakeBin(withNpx = true): string {
      const bin = mkdtempSync(join(tmpdir(), 'portolan-bin-'));
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'claude'), 0o755);
      if (withNpx) {
        writeFileSync(
          join(bin, 'npx'),
          `#!/bin/sh\necho "$@" > "${bin}/npx-args"\nexec "${process.execPath}" "${FAKE_AGENT}" --mode=describe\n`,
        );
        chmodSync(join(bin, 'npx'), 0o755);
      }
      return bin;
    }

    it('runs the pinned adapter with npx when only the agent CLI is installed', async () => {
      const bin = fakeBin();
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      const portolan = start({ agents: {} });
      expect(portolan.enricher.candidates()).toEqual([
        {
          name: 'claude',
          command: 'npx',
          args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'],
          env: [],
        },
      ]);
      await addUsers(portolan);
      expect(readFileSync(join(bin, 'npx-args'), 'utf8').trim()).toBe(
        '-y @agentclientprotocol/claude-agent-acp@0.94.0',
      );
      expect(portolan.enricher.pendingWork('users')).toEqual({ operations: [], api: false });
      rmSync(bin, { recursive: true, force: true });
    });

    it('does not fall back when switched off, without npx, or for a custom command', () => {
      const bin = fakeBin(false);
      process.env.PATH = bin;
      expect(start({ agents: {} }).enricher.candidates()).toEqual([]);
      app!.close();

      const withNpx = fakeBin();
      process.env.PATH = withNpx;
      expect(start({ agents: {}, npx_fallback: false }).enricher.candidates()).toEqual([]);
      app!.close();
      expect(
        start({ agents: { claude: { command: 'my-claude-adapter' } } }).enricher.candidates(),
      ).toEqual([]);
      rmSync(bin, { recursive: true, force: true });
      rmSync(withNpx, { recursive: true, force: true });
    });
  });
});
