/**
 * Sandbox escape attempts (SPEC.md §34, §35, §54).
 *
 * Every case here must fail. These are the tests that justify shipping `run_api_code`
 * at all, so they assert on the real Deno process, not on a mock.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAppHarness, type AppHarness } from '../fixtures/app-harness.js';
import { findDeno } from '../../src/sandbox/runner.js';

let harness: AppHarness | undefined;
const context = { requestId: 'test-security' };

beforeAll(() => {
  if (!findDeno()) throw new Error('Deno is required for the sandbox security suite.');
});

async function setup(options: Parameters<typeof createAppHarness>[0] = {}) {
  harness = await createAppHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Run a script that reports what happened rather than throwing, so we can assert on it. */
async function probe(h: AppHarness, body: string): Promise<any> {
  const result = await h.app.sandbox.run(
    {
      apiId: h.apiId,
      code: `try { ${body} } catch (error) { return { blocked: true, name: String(error && error.name), message: String(error && error.message).slice(0, 200) }; }`,
      timeoutMs: 10_000,
    },
    context,
  );
  return result.result;
}

describe('filesystem access is impossible (SPEC.md §54)', () => {
  it('cannot read a file through Deno APIs', async () => {
    const h = await setup();
    expect(
      await probe(
        h,
        `const t = await Deno.readTextFile('/etc/passwd'); return { leaked: t.slice(0, 20) };`,
      ),
    ).toMatchObject({ blocked: true });
  });

  it('cannot reach the Deno namespace at all', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `return { deno: typeof globalThis.Deno, keys: Object.keys(globalThis).filter(k => /deno/i.test(k)) };`,
      },
      context,
    );
    expect(result.result).toEqual({ deno: 'undefined', keys: [] });
  });

  it('cannot import node:fs', async () => {
    const h = await setup();
    expect(
      await probe(
        h,
        `const fs = await import('node:fs'); return { leaked: typeof fs.readFileSync };`,
      ),
    ).toMatchObject({ blocked: true });
  });

  it('cannot use require', async () => {
    const h = await setup();
    expect(await probe(h, `const fs = require('fs'); return { leaked: typeof fs };`)).toMatchObject(
      {
        blocked: true,
      },
    );
  });
});

describe('environment access is impossible (SPEC.md §54)', () => {
  it('cannot read process.env', async () => {
    process.env.PORTOLAN_SECRET_CANARY = 'canary-value-should-never-appear';
    const h = await setup();
    try {
      const result = await probe(h, `return { leaked: process.env.PORTOLAN_SECRET_CANARY };`);
      expect(result).toMatchObject({ blocked: true });
      expect(JSON.stringify(result)).not.toContain('canary-value');
    } finally {
      delete process.env.PORTOLAN_SECRET_CANARY;
    }
  });

  it('cannot read Deno.env', async () => {
    const h = await setup();
    expect(await probe(h, `return { leaked: Deno.env.toObject() };`)).toMatchObject({
      blocked: true,
    });
  });

  it('sees no credential values even when the environment uses an auth profile', async () => {
    process.env.SANDBOX_SECRET = 'top-secret-token-value';
    const h = await setup({
      authProfile: 'secret',
      config: { auth_profiles: { secret: { type: 'bearer', token_env: 'SANDBOX_SECRET' } } },
    });
    try {
      const result = await h.app.sandbox.run(
        {
          apiId: h.apiId,
          code: `
            const echoed = await api.call({ operation_id: 'diagnostics.echoAuth' });
            return { globals: Object.keys(globalThis).length, saw: echoed.response.status };
          `,
        },
        context,
      );
      // The call succeeded (so the credential was applied by the parent)...
      expect((result.result as any).saw).toBe(200);
      // ...but the sandbox transcript never carries the secret itself.
      expect(JSON.stringify(result)).not.toContain('top-secret-token-value');
    } finally {
      delete process.env.SANDBOX_SECRET;
    }
  });
});

describe('subprocess execution is impossible (SPEC.md §54)', () => {
  it('cannot spawn with Deno.Command', async () => {
    const h = await setup();
    expect(
      await probe(h, `const out = new Deno.Command('id').outputSync(); return { leaked: out };`),
    ).toMatchObject({ blocked: true });
  });

  it('cannot spawn with node:child_process', async () => {
    const h = await setup();
    expect(
      await probe(
        h,
        `const cp = await import('node:child_process'); return { leaked: cp.execSync('id').toString() };`,
      ),
    ).toMatchObject({ blocked: true });
  });
});

describe('direct network access is impossible (SPEC.md §54)', () => {
  it('cannot fetch', async () => {
    const h = await setup();
    expect(
      await probe(
        h,
        `const r = await fetch('http://169.254.169.254/'); return { leaked: r.status };`,
      ),
    ).toMatchObject({ blocked: true });
  });

  it('cannot reach the fixture server directly, only through api.call', async () => {
    const h = await setup();
    const before = h.server.requests.length;
    const result = await probe(
      h,
      `const r = await fetch('${h.server.url}/users'); return { leaked: await r.text() };`,
    );
    expect(result).toMatchObject({ blocked: true });
    expect(h.server.requests.length).toBe(before);
  });

  it('cannot open a WebSocket or use XMLHttpRequest', async () => {
    const h = await setup();
    expect(
      await probe(h, `const ws = new WebSocket('ws://127.0.0.1:1'); return { leaked: true };`),
    ).toMatchObject({ blocked: true });
    expect(
      await probe(h, `const x = new XMLHttpRequest(); return { leaked: true };`),
    ).toMatchObject({
      blocked: true,
    });
  });

  it('cannot start a Worker to escape the restrictions', async () => {
    const h = await setup();
    expect(
      await probe(
        h,
        `const w = new Worker('data:text/javascript,1', { type: 'module' }); return { leaked: true };`,
      ),
    ).toMatchObject({ blocked: true });
  });

  it('cannot import a remote module', async () => {
    const h = await setup();
    expect(
      await probe(
        h,
        `const m = await import('https://deno.land/std/version.ts'); return { leaked: true };`,
      ),
    ).toMatchObject({ blocked: true });
  });
});

describe('resource limits (SPEC.md §35, §54)', () => {
  it('terminates a script that runs forever', async () => {
    const h = await setup();
    const started = Date.now();
    await expect(
      h.app.sandbox.run({ apiId: h.apiId, code: 'while (true) {}', timeoutMs: 1500 }, context),
    ).rejects.toMatchObject({ code: 'SANDBOX_TIMEOUT' });
    // The limit is enforced, not merely reported.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('terminates a script that awaits forever', async () => {
    const h = await setup();
    await expect(
      h.app.sandbox.run(
        { apiId: h.apiId, code: 'await new Promise(() => {}); return 1;', timeoutMs: 1500 },
        context,
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_TIMEOUT' });
  });

  it('stops a script that exceeds its API call limit', async () => {
    const h = await setup();
    await expect(
      h.app.sandbox.run(
        {
          apiId: h.apiId,
          code: 'for (let i = 0; i < 100; i++) { await api.call({ operation_id: "users.list" }); } return i;',
          maxApiCalls: 3,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_CALL_LIMIT' });
    // The cap is enforced at the parent, so no more than the limit reached the network.
    expect(h.server.requests.filter((r) => r.path === '/users').length).toBeLessThanOrEqual(3);
  });

  it('rejects an enormous script output', async () => {
    const h = await setup({ config: { limits: { sandbox_max_output_bytes: 4096 } } });
    await expect(
      h.app.sandbox.run({ apiId: h.apiId, code: 'return "x".repeat(200000);' }, context),
    ).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_TOO_LARGE' });
  });

  it('rejects an oversized script', async () => {
    const h = await setup({ config: { limits: { sandbox_max_code_bytes: 100 } } });
    await expect(
      h.app.sandbox.run({ apiId: h.apiId, code: `// ${'x'.repeat(500)}\nreturn 1;` }, context),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects oversized script input', async () => {
    const h = await setup({ config: { limits: { sandbox_max_input_bytes: 100 } } });
    await expect(
      h.app.sandbox.run(
        { apiId: h.apiId, code: 'return 1;', input: { blob: 'x'.repeat(500) } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('caps the cumulative response bytes one script may read', async () => {
    const h = await setup({
      config: {
        limits: { sandbox_max_total_response_bytes: 50_000, max_response_bytes: 100_000 },
      },
    });
    await expect(
      h.app.sandbox.run(
        {
          apiId: h.apiId,
          code: `
            for (let i = 0; i < 20; i++) {
              await api.call({ operation_id: 'diagnostics.large', parameters: { query: { bytes: 90000 } } });
            }
            return 'done';
          `,
          maxApiCalls: 20,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('bounds captured console output', async () => {
    const h = await setup({ config: { limits: { sandbox_max_log_entries: 5 } } });
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: 'for (let i = 0; i < 100; i++) console.log("line " + i); return "ok";',
      },
      context,
    );
    expect(result.result).toBe('ok');
    expect(result.logs.length).toBeLessThanOrEqual(5);
  });
});

describe('the sandbox cannot bypass execution policy (SPEC.md §29)', () => {
  it('cannot mutate through api.call when the environment forbids it', async () => {
    const h = await setup({ allowMutations: false });
    const before = { ...h.server.users.get('u1')! };
    await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `
          try {
            await api.call({ operation_id: 'users.update', parameters: { path: { id: 'u1' } },
                             body: { id: 'u1', email: 'x@y.z', enabled: false } });
          } catch { /* expected */ }
          return 'done';
        `,
      },
      context,
    );
    expect(h.server.users.get('u1')).toEqual(before);
  });

  it('cannot call an operation belonging to a different API', async () => {
    const h = await setup();
    await h.app.catalog.addApi({
      specContent: JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Other', version: '1' },
        servers: [{ url: 'https://other.example.com' }],
        paths: {
          '/secret': {
            get: { operationId: 'other.secret', responses: { 200: { description: 'OK' } } },
          },
        },
      }),
      apiId: 'other',
    });
    const result = await probe(
      h,
      `await api.call({ operation_id: 'other.secret' }); return { leaked: true };`,
    );
    expect(result).toMatchObject({ blocked: true });
  });

  it('cannot reach an arbitrary URL by naming one as an operation', async () => {
    const h = await setup();
    for (const operationId of [
      'http://169.254.169.254/',
      'get:http://169.254.169.254/',
      '../../etc/passwd',
    ]) {
      const result = await probe(
        h,
        `await api.call({ operation_id: ${JSON.stringify(operationId)} }); return { leaked: true };`,
      );
      expect(result, operationId).toMatchObject({ blocked: true });
    }
  });
});
