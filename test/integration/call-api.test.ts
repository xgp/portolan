/**
 * Execution against a real local HTTP server (SPEC.md §20–§24, §29, §48, §51, §52).
 * Nothing here is mocked: every assertion is about bytes that crossed a socket.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAppHarness, type AppHarness } from '../fixtures/app-harness.js';
import { FIXTURE_API_KEY } from '../fixtures/api-server.js';

let harness: AppHarness | undefined;

async function setup(options: Parameters<typeof createAppHarness>[0] = {}) {
  harness = await createAppHarness(options);
  return harness;
}

const context = { requestId: 'test-request' };

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('call_api: methods and bodies', () => {
  it('performs a GET and returns a parsed JSON body', async () => {
    const h = await setup();
    const result = await h.app.caller.call({ apiId: h.apiId, operationId: 'users.list' }, context);
    expect(result.response.status).toBe(200);
    expect(result.response.content_type).toBe('application/json');
    expect(Array.isArray(result.response.body)).toBe(true);
    expect((result.response.body as any[]).map((u) => u.email)).toContain('john@example.com');
    expect(result.request.method).toBe('GET');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('substitutes path parameters', async () => {
    const h = await setup();
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'users.get', parameters: { path: { id: 'u2' } } },
      context,
    );
    expect((result.response.body as any).email).toBe('jane@example.com');
    expect(h.server.requests.at(-1)?.path).toBe('/users/u2');
  });

  it('performs a PUT with a JSON body and actually changes remote state', async () => {
    const h = await setup({ allowMutations: true });
    await h.app.caller.call(
      {
        apiId: h.apiId,
        operationId: 'users.update',
        parameters: { path: { id: 'u1' } },
        body: { id: 'u1', email: 'john@example.com', name: 'John Doe', enabled: false },
      },
      context,
    );
    expect(h.server.users.get('u1')?.enabled).toBe(false);
    const sent = h.server.requests.at(-1)!;
    expect(sent.method).toBe('PUT');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent.body).enabled).toBe(false);
  });

  it('performs POST, PATCH and DELETE', async () => {
    const h = await setup({ allowMutations: true });
    const created = await h.app.caller.call(
      {
        apiId: h.apiId,
        operationId: 'users.create',
        body: { email: 'new@example.com', name: 'New' },
      },
      context,
    );
    expect(created.response.status).toBe(201);
    const id = (created.response.body as any).id;

    const patched = await h.app.caller.call(
      {
        apiId: h.apiId,
        operationId: 'users.patch',
        parameters: { path: { id } },
        body: { name: 'Renamed' },
      },
      context,
    );
    expect((patched.response.body as any).name).toBe('Renamed');

    const deleted = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'users.delete', parameters: { path: { id } } },
      context,
    );
    expect(deleted.response.status).toBe(204);
    expect(h.server.users.has(id)).toBe(false);
  });

  it('sends a urlencoded form body', async () => {
    const h = await setup({ allowMutations: true });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.form', body: { a: '1', b: 'two words' } },
      context,
    );
    expect((result.response.body as any).content_type).toBe('application/x-www-form-urlencoded');
    expect((result.response.body as any).body).toBe('a=1&b=two+words');
  });

  it('sends a multipart body', async () => {
    const h = await setup({ allowMutations: true });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.multipart', body: { field: 'value' } },
      context,
    );
    expect((result.response.body as any).content_type).toMatch(/^multipart\/form-data; boundary=/);
    expect((result.response.body as any).body).toContain('name="field"');
    expect((result.response.body as any).body).toContain('value');
  });

  it('sends a text/plain body', async () => {
    const h = await setup({ allowMutations: true });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.text', body: 'hello world' },
      context,
    );
    expect((result.response.body as any).body).toBe('hello world');
    expect((result.response.body as any).content_type).toBe('text/plain');
  });

  it('rejects a content type the operation does not declare', async () => {
    const h = await setup({ allowMutations: true });
    await expect(
      h.app.caller.call(
        { apiId: h.apiId, operationId: 'users.create', body: {}, contentType: 'application/xml' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CONTENT_TYPE_UNSUPPORTED' });
  });
});

describe('call_api: parameter serialization over the wire (SPEC.md §22)', () => {
  it('sends an exploded form array as repeated parameters', async () => {
    const h = await setup();
    await h.app.caller.call(
      { apiId: h.apiId, operationId: 'users.list', parameters: { query: { tags: ['a', 'b'] } } },
      context,
    );
    expect(h.server.requests.at(-1)?.query).toBe('tags=a&tags=b');
  });

  it('sends a pipeDelimited array', async () => {
    const h = await setup();
    await h.app.caller.call(
      { apiId: h.apiId, operationId: 'users.list', parameters: { query: { ids: ['u1', 'u2'] } } },
      context,
    );
    expect(h.server.requests.at(-1)?.query).toBe('ids=u1|u2');
  });

  it('sends a deepObject filter and the server can act on it', async () => {
    const h = await setup();
    const result = await h.app.caller.call(
      {
        apiId: h.apiId,
        operationId: 'users.list',
        parameters: { query: { filter: { enabled: false } } },
      },
      context,
    );
    expect(h.server.requests.at(-1)?.query).toBe('filter%5Benabled%5D=false');
    expect((result.response.body as any[]).map((u) => u.id)).toEqual(['u3']);
  });

  it('sends header and cookie parameters', async () => {
    const h = await setup();
    const result = await h.app.caller.call(
      {
        apiId: h.apiId,
        operationId: 'diagnostics.headers',
        parameters: { header: { 'X-Trace': 'abc123' }, cookie: { session: 's1' } },
      },
      context,
    );
    const echoed = (result.response.body as any).headers;
    expect(echoed['x-trace']).toBe('abc123');
    expect(echoed.cookie).toBe('session=s1');
  });
});

describe('call_api: validation (SPEC.md §23)', () => {
  it('rejects a missing required path parameter before sending anything', async () => {
    const h = await setup();
    const before = h.server.requests.length;
    await expect(
      h.app.caller.call({ apiId: h.apiId, operationId: 'users.get' }, context),
    ).rejects.toMatchObject({ code: 'PARAMETER_REQUIRED' });
    expect(h.server.requests.length).toBe(before);
  });

  it('rejects a parameter that violates its schema', async () => {
    const h = await setup();
    await expect(
      h.app.caller.call(
        { apiId: h.apiId, operationId: 'users.list', parameters: { query: { limit: 999 } } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'PARAMETER_INVALID' });
  });

  it('rejects a request body missing a required property', async () => {
    const h = await setup({ allowMutations: true });
    await expect(
      h.app.caller.call(
        { apiId: h.apiId, operationId: 'users.create', body: { name: 'no email' } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_BODY_INVALID' });
  });

  it('warns about undeclared parameters instead of forwarding them', async () => {
    const h = await setup();
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'users.list', parameters: { query: { nonsense: 'x' } } },
      context,
    );
    expect(result.warnings?.[0]).toMatch(/Ignored undeclared parameter/);
    expect(h.server.requests.at(-1)?.query).toBe('');
  });

  it('reports an unknown operation with suggestions', async () => {
    const h = await setup();
    await expect(
      h.app.caller.call({ apiId: h.apiId, operationId: 'users.nope' }, context),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
  });

  it('reports an unknown environment with the list of real ones', async () => {
    const h = await setup();
    try {
      await h.app.caller.call(
        { apiId: h.apiId, operationId: 'users.list', environment: 'nope' },
        context,
      );
      expect.unreachable();
    } catch (error: any) {
      expect(error.code).toBe('ENVIRONMENT_NOT_FOUND');
      expect(error.details.available_environments).toContain('default');
    }
  });
});

describe('call_api: mutation policy (SPEC.md §29)', () => {
  it('refuses a mutating method when the environment does not allow it', async () => {
    const h = await setup({ allowMutations: false });
    const before = h.server.requests.length;
    for (const operationId of ['users.create', 'users.update', 'users.patch', 'users.delete']) {
      await expect(
        h.app.caller.call(
          {
            apiId: h.apiId,
            operationId,
            parameters: { path: { id: 'u1' } },
            body: { email: 'x@y.z' },
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'MUTATION_NOT_ALLOWED' });
    }
    // Nothing reached the network.
    expect(h.server.requests.length).toBe(before);
  });

  it('allows safe methods regardless of mutation policy', async () => {
    const h = await setup({ allowMutations: false });
    await expect(
      h.app.caller.call({ apiId: h.apiId, operationId: 'users.list' }, context),
    ).resolves.toMatchObject({ response: { status: 200 } });
  });
});

describe('call_api: responses (SPEC.md §24, §37, §48, §51)', () => {
  it.each([400, 401, 404, 429, 500])(
    'returns HTTP %i as a result, not an exception',
    async (code) => {
      const h = await setup();
      const result = await h.app.caller.call(
        { apiId: h.apiId, operationId: 'diagnostics.status', parameters: { path: { code } } },
        context,
      );
      expect(result.response.status).toBe(code);
      expect((result.response.body as any).status).toBe(code);
    },
  );

  it('surfaces Retry-After without sleeping on it', async () => {
    const h = await setup();
    const started = Date.now();
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.status', parameters: { path: { code: 429 } } },
      context,
    );
    expect(result.response.headers['retry-after']).toBe('120');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('never returns set-cookie or www-authenticate', async () => {
    const h = await setup();
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.status', parameters: { path: { code: 401 } } },
      context,
    );
    expect(result.response.headers).not.toHaveProperty('set-cookie');
    expect(result.response.headers).not.toHaveProperty('www-authenticate');
    expect(result.response.headers['content-type']).toBe('application/json');
  });

  it('truncates a response larger than max_response_bytes', async () => {
    const h = await setup({ config: { limits: { max_response_bytes: 4096 } } });
    const result = await h.app.caller.call(
      {
        apiId: h.apiId,
        operationId: 'diagnostics.large',
        parameters: { query: { bytes: 2_000_000 } },
      },
      context,
    );
    expect(result.response.truncated).toBe(true);
    expect(result.response.status).toBe(200);
    expect(typeof result.response.body).toBe('string');
    expect((result.response.body as string).length).toBeLessThanOrEqual(4096);
  });

  it('returns binary content as bounded base64 rather than mangled text', async () => {
    const h = await setup();
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'users.avatar', parameters: { path: { id: 'u1' } } },
      context,
    );
    expect(result.response.content_type).toBe('image/png');
    expect(result.response.body_encoding).toBe('base64');
    expect(
      Buffer.from(result.response.body as string, 'base64')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });

  it('times out with a structured error', async () => {
    const h = await setup();
    await expect(
      h.app.caller.call(
        {
          apiId: h.apiId,
          operationId: 'diagnostics.slow',
          parameters: { query: { ms: 3000 } },
          timeoutMs: 300,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });
});

describe('call_api: authentication (SPEC.md §26, §27)', () => {
  it('applies an api_key header profile without exposing the value', async () => {
    process.env.FIXTURE_KEY = FIXTURE_API_KEY;
    const h = await setup({
      authProfile: 'fixture-key',
      config: {
        auth_profiles: {
          'fixture-key': {
            type: 'api_key',
            location: 'header',
            name: 'X-API-Key',
            value_env: 'FIXTURE_KEY',
          },
        },
      },
    });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.secure' },
      context,
    );
    expect(result.response.status).toBe(200);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_API_KEY);
    delete process.env.FIXTURE_KEY;
  });

  it('applies a bearer profile', async () => {
    process.env.FIXTURE_TOKEN = 'tok-abc';
    const h = await setup({
      authProfile: 'fixture-bearer',
      config: {
        auth_profiles: { 'fixture-bearer': { type: 'bearer', token_env: 'FIXTURE_TOKEN' } },
      },
    });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.echoAuth' },
      context,
    );
    expect((result.response.body as any).authorization).toBe('Bearer tok-abc');
    delete process.env.FIXTURE_TOKEN;
  });

  it('applies a basic profile', async () => {
    process.env.FIXTURE_USER = 'alice';
    process.env.FIXTURE_PASS = 'sesame';
    const h = await setup({
      authProfile: 'fixture-basic',
      config: {
        auth_profiles: {
          'fixture-basic': {
            type: 'basic',
            username_env: 'FIXTURE_USER',
            password_env: 'FIXTURE_PASS',
          },
        },
      },
    });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.echoAuth' },
      context,
    );
    const header = (result.response.body as any).authorization as string;
    expect(Buffer.from(header.replace('Basic ', ''), 'base64').toString()).toBe('alice:sesame');
    delete process.env.FIXTURE_USER;
    delete process.env.FIXTURE_PASS;
  });

  it('redacts an api_key query parameter from the returned URL', async () => {
    process.env.FIXTURE_QS_KEY = 'super-secret-value';
    const h = await setup({
      authProfile: 'fixture-qs',
      config: {
        auth_profiles: {
          'fixture-qs': {
            type: 'api_key',
            location: 'query',
            name: 'access_token',
            value_env: 'FIXTURE_QS_KEY',
          },
        },
      },
    });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.echoAuth' },
      context,
    );
    // The credential reached the server...
    expect((result.response.body as any).query).toContain('super-secret-value');
    // ...but never appears in the URL Portolan reports back.
    expect(result.request.url).toContain('access_token=REDACTED');
    expect(result.request.url).not.toContain('super-secret-value');
    delete process.env.FIXTURE_QS_KEY;
  });

  it('fails clearly when the credential environment variable is unset', async () => {
    delete process.env.MISSING_TOKEN_VAR;
    const h = await setup({
      authProfile: 'fixture-missing',
      config: {
        auth_profiles: { 'fixture-missing': { type: 'bearer', token_env: 'MISSING_TOKEN_VAR' } },
      },
    });
    try {
      await h.app.caller.call({ apiId: h.apiId, operationId: 'diagnostics.echoAuth' }, context);
      expect.unreachable();
    } catch (error: any) {
      expect(error.code).toBe('AUTH_FAILED');
      expect(error.message).toContain('MISSING_TOKEN_VAR');
    }
  });

  it('refuses to sign for a host outside the profile allowed_hosts', async () => {
    process.env.FIXTURE_TOKEN2 = 'tok';
    const h = await setup({
      authProfile: 'restricted',
      config: {
        auth_profiles: {
          restricted: {
            type: 'bearer',
            token_env: 'FIXTURE_TOKEN2',
            allowed_hosts: ['api.example.com'],
          },
        },
      },
    });
    await expect(
      h.app.caller.call({ apiId: h.apiId, operationId: 'diagnostics.echoAuth' }, context),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    delete process.env.FIXTURE_TOKEN2;
  });
});
