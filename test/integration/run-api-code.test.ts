/** run_api_code against the real fixture API through a real Deno sandbox (SPEC.md §31–§36). */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAppHarness, type AppHarness } from '../fixtures/app-harness.js';
import { findDeno } from '../../src/sandbox/runner.js';

let harness: AppHarness | undefined;
const context = { requestId: 'test-sandbox' };

beforeAll(() => {
  if (!findDeno()) {
    throw new Error(
      'Deno is required for the sandbox suite. Install it (https://deno.land) or set PORTOLAN_DENO_PATH.',
    );
  }
});

async function setup(options: Parameters<typeof createAppHarness>[0] = {}) {
  harness = await createAppHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('run_api_code', () => {
  // Deno's Node-compatibility layer can read the removed `Deno` global from a promise
  // nothing awaits (seen in CI from `import('node:child_process')`). That rejection used
  // to terminate the sandbox and lose the script's result.
  it('reports a rejection nothing handles in the logs, and carries on', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `
          (async () => Deno.version)();
          Promise.reject(new TypeError('forgotten'));
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { finished: true };
        `,
      },
      context,
    );
    expect(result.result).toEqual({ finished: true });
    expect(result.logs).toEqual([
      '[error] Unhandled promise rejection: ReferenceError: Deno is not defined',
      '[error] Unhandled promise rejection: TypeError: forgotten',
    ]);
  });

  it('runs a script that returns a value', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run(
      { apiId: h.apiId, code: 'return { sum: input.a + input.b };', input: { a: 2, b: 3 } },
      context,
    );
    expect(result.result).toEqual({ sum: 5 });
    expect(result.api_calls).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('calls an operation through api.call', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `
          const users = await api.call({ operation_id: 'users.list' });
          return { status: users.response.status, count: users.response.body.length };
        `,
      },
      context,
    );
    expect(result.result).toEqual({ status: 200, count: 3 });
    expect(result.api_calls).toBe(1);
  });

  it('loops over results and mutates through a second call', async () => {
    const h = await setup({ allowMutations: true });
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `
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
        `,
        input: { email: 'john@example.com' },
      },
      context,
    );
    expect(result.result).toEqual({ updated: 'u1' });
    expect(result.api_calls).toBe(2);
    expect(h.server.users.get('u1')?.enabled).toBe(false);
  });

  it('returns console output separately from the result', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run(
      { apiId: h.apiId, code: 'console.log("one"); console.warn("two", {x:1}); return 42;' },
      context,
    );
    expect(result.result).toBe(42);
    expect(result.logs).toEqual(['[log] one', '[warn] two {"x":1}']);
  });

  it('gives the script a structured error it can branch on', async () => {
    const h = await setup({ allowMutations: false });
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `
          try {
            await api.call({ operation_id: 'users.delete', parameters: { path: { id: 'u1' } } });
            return { blocked: false };
          } catch (error) {
            return { blocked: true, code: error.code };
          }
        `,
      },
      context,
    );
    expect(result.result).toEqual({ blocked: true, code: 'MUTATION_NOT_ALLOWED' });
  });

  it('reports a script exception as SANDBOX_RUNTIME_ERROR', async () => {
    const h = await setup();
    await expect(
      h.app.sandbox.run({ apiId: h.apiId, code: 'throw new Error("boom");' }, context),
    ).rejects.toMatchObject({ code: 'SANDBOX_RUNTIME_ERROR' });
  });

  it('reports a syntax error usefully', async () => {
    const h = await setup();
    await expect(
      h.app.sandbox.run({ apiId: h.apiId, code: 'this is not javascript {{{' }, context),
    ).rejects.toMatchObject({ code: 'SANDBOX_RUNTIME_ERROR' });
  });

  it('rejects a non-serializable return value', async () => {
    const h = await setup();
    await expect(
      h.app.sandbox.run({ apiId: h.apiId, code: 'const a = {}; a.self = a; return a;' }, context),
    ).rejects.toMatchObject({ code: 'SANDBOX_RUNTIME_ERROR' });
  });

  it('treats an undefined return as null rather than failing', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run({ apiId: h.apiId, code: 'const x = 1;' }, context);
    expect(result.result).toBeNull();
  });

  it('fails before spawning anything for an unknown API', async () => {
    const h = await setup();
    await expect(
      h.app.sandbox.run({ apiId: 'nope', code: 'return 1;' }, context),
    ).rejects.toMatchObject({ code: 'API_NOT_FOUND' });
  });

  it('validates api.call arguments inside the sandbox', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `
          try { await api.call({}); } catch (e) { return { name: e.name, message: e.message }; }
          return null;
        `,
      },
      context,
    );
    expect((result.result as any).message).toMatch(/operation_id/);
  });

  it('only exposes api, input and console', async () => {
    const h = await setup();
    const result = await h.app.sandbox.run(
      {
        apiId: h.apiId,
        code: `
          return {
            api: typeof api,
            // input defaults to null when the caller supplies none.
            input: input,
            console: typeof console,
            apiKeys: Object.keys(api),
          };
        `,
      },
      context,
    );
    expect(result.result).toEqual({
      api: 'object',
      input: null,
      console: 'object',
      apiKeys: ['call'],
    });
  });
});
