/**
 * Execution-path security (SPEC.md §30, §49, §54).
 *
 * Redirects, credential leakage across origins, and the impossibility of aiming
 * `call_api` at an arbitrary destination.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAppHarness, type AppHarness } from '../fixtures/app-harness.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/api-server.js';
import { buildRequestUrl } from '../../src/execution/policy.js';
import { sanitizeResponseHeaders, sanitizeUrl } from '../../src/execution/response.js';

let harness: AppHarness | undefined;
let second: FixtureServer | undefined;
const context = { requestId: 'test-exec-security' };

async function setup(options: Parameters<typeof createAppHarness>[0] = {}) {
  harness = await createAppHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  await second?.close();
  harness = undefined;
  second = undefined;
});

describe('redirects (SPEC.md §49, §54)', () => {
  it('refuses a redirect to a blocked address', async () => {
    const h = await setup();
    await expect(
      h.app.caller.call(
        {
          apiId: h.apiId,
          operationId: 'diagnostics.redirect',
          parameters: { query: { to: 'http://169.254.169.254/latest/meta-data/' } },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });

  it('refuses a redirect to a file: URL', async () => {
    const h = await setup();
    await expect(
      h.app.caller.call(
        {
          apiId: h.apiId,
          operationId: 'diagnostics.redirect',
          parameters: { query: { to: 'file:///etc/passwd' } },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });

  // Policy is re-evaluated on every hop, per category, not just on the first request.
  // The harness permits loopback (the fixture server lives there) but not private
  // addresses, so a redirect into 10/8 must still be refused.
  it('re-applies policy per hop rather than trusting the first destination', async () => {
    const h = await setup();
    await expect(
      h.app.caller.call(
        {
          apiId: h.apiId,
          operationId: 'diagnostics.redirect',
          parameters: { query: { to: 'http://10.0.0.1/internal' } },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });

  it('caps the redirect chain', async () => {
    const h = await setup({ config: { limits: { max_redirects: 2 } } });
    await expect(
      h.app.caller.call(
        { apiId: h.apiId, operationId: 'diagnostics.redirect', parameters: { query: { hops: 9 } } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });

  it('follows a redirect within the limit', async () => {
    const h = await setup({ config: { limits: { max_redirects: 3 } } });
    const result = await h.app.caller.call(
      { apiId: h.apiId, operationId: 'diagnostics.redirect', parameters: { query: { hops: 2 } } },
      context,
    );
    expect(result.response.status).toBe(200);
    expect((result.response.body as any).redirected).toBe(true);
  });

  // SPEC.md §30: "Authentication headers must never be forwarded to a different host
  // after a redirect."
  it('does not forward credentials across an origin change', async () => {
    second = await startFixtureServer();
    process.env.REDIRECT_TOKEN = 'must-not-cross-origins';
    const h = await setup({
      authProfile: 'redirect-token',
      config: {
        auth_profiles: { 'redirect-token': { type: 'bearer', token_env: 'REDIRECT_TOKEN' } },
      },
    });
    try {
      const result = await h.app.caller.call(
        {
          apiId: h.apiId,
          operationId: 'diagnostics.redirect',
          parameters: { query: { to: `${second.url}/echo-auth` } },
        },
        context,
      );
      // The request landed on the second server...
      expect(result.response.status).toBe(200);
      expect(second.requests.some((r) => r.path === '/echo-auth')).toBe(true);
      // ...without the Authorization header.
      expect((result.response.body as any).authorization).toBeNull();
      const crossOrigin = second.requests.find((r) => r.path === '/echo-auth')!;
      expect(crossOrigin.headers.authorization).toBeUndefined();
      // The first hop did carry it, proving the credential was applied at all.
      const firstHop = h.server.requests.find((r) => r.path === '/redirect')!;
      expect(firstHop.headers.authorization).toBe('Bearer must-not-cross-origins');
    } finally {
      delete process.env.REDIRECT_TOKEN;
    }
  });

  it('keeps credentials on a same-origin redirect', async () => {
    process.env.REDIRECT_TOKEN2 = 'same-origin-ok';
    const h = await setup({
      authProfile: 'redirect-token2',
      config: {
        auth_profiles: { 'redirect-token2': { type: 'bearer', token_env: 'REDIRECT_TOKEN2' } },
      },
    });
    try {
      await h.app.caller.call(
        {
          apiId: h.apiId,
          operationId: 'diagnostics.redirect',
          parameters: { query: { to: '/echo-auth' } },
        },
        context,
      );
      const final = h.server.requests.find((r) => r.path === '/echo-auth')!;
      expect(final.headers.authorization).toBe('Bearer same-origin-ok');
    } finally {
      delete process.env.REDIRECT_TOKEN2;
    }
  });
});

// Regression: every other test uses an IP literal, and net.connect skips a custom
// `lookup` for literals — so the pinning path never ran. A hostname is what exercises it.
describe('DNS resolution and connection pinning (docs/DEVIATIONS.md D7)', () => {
  it('completes a request whose base URL is a hostname, not an IP literal', async () => {
    const h = await setup();
    const port = new URL(h.server.url).port;
    // Re-point the environment at the same server via a name that must be resolved.
    h.app.catalog['environments'].upsert({
      apiId: h.apiId,
      name: 'default',
      baseUrl: `http://localhost:${port}`,
      authProfile: null,
      isDefault: true,
      allowMutations: false,
      source: 'config',
    });

    const result = await h.app.caller.call({ apiId: h.apiId, operationId: 'users.list' }, context);
    expect(result.response.status).toBe(200);
    expect(result.request.url).toContain('localhost');
    expect(h.server.requests.at(-1)?.path).toBe('/users');
  });

  it('refuses a hostname that resolves to a blocked address', async () => {
    // `localhost` resolves to loopback, which the shipped defaults block.
    const { resolveAllowedAddresses } = await import('../../src/net/safe-fetch.js');
    await expect(
      resolveAllowedAddresses('localhost', {
        allowPrivateAddresses: false,
        allowLoopback: false,
        allowHttp: false,
        allowedHosts: [],
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });
});

describe('call_api cannot address an arbitrary URL (SPEC.md §30, §60)', () => {
  it('offers no input for a destination', async () => {
    const h = await setup();
    // The tool schema has no base_url / url field at all; passing one is simply not a
    // parameter the operation declares, so it is reported and dropped.
    const result = await h.app.caller.call(
      {
        apiId: h.apiId,
        operationId: 'users.list',
        parameters: { query: { url: 'http://169.254.169.254/' } },
      },
      context,
    );
    expect(result.warnings?.[0]).toMatch(/Ignored undeclared parameter/);
    expect(h.server.requests.at(-1)?.query).toBe('');
    expect(new URL(result.request.url).host).toBe(new URL(h.server.url).host);
  });

  it('keeps an operation path inside the environment base URL', () => {
    const base = 'https://api.example.com/v2';
    expect(buildRequestUrl(base, '/users', '')).toBe('https://api.example.com/v2/users');

    // A protocol-relative-looking path must not become a different host. It is treated
    // as a path segment under the base, which is the safe reading.
    const protocolRelative = new URL(buildRequestUrl(base, '//evil.example.com/x', ''));
    expect(protocolRelative.host).toBe('api.example.com');
    expect(protocolRelative.pathname.startsWith('/v2/')).toBe(true);

    // An absolute URL in the path is refused rather than followed.
    expect(() => buildRequestUrl(base, 'https://evil.example.com/x', '')).toThrow(
      /resolves outside/,
    );

    // Traversal above the base path is refused outright.
    expect(() => buildRequestUrl(base, '/../../secret', '')).toThrow(/escapes/);
  });

  it('does not let a path traversal reach another part of the host', () => {
    expect(() => buildRequestUrl('https://api.example.com/tenant/a', '/../b/secret', '')).toThrow(
      /escapes/,
    );
  });
});

describe('credential sanitization (SPEC.md §24, §38)', () => {
  it('strips credential-bearing response headers', () => {
    const sanitized = sanitizeResponseHeaders({
      'content-type': 'application/json',
      'Set-Cookie': 'session=abc',
      'WWW-Authenticate': 'Bearer realm="x"',
      Authorization: 'Bearer leak',
      'proxy-authorization': 'Basic leak',
      'x-request-id': 'keep-me',
    });
    expect(sanitized).toEqual({ 'content-type': 'application/json', 'x-request-id': 'keep-me' });
  });

  it('strips userinfo and redacts credential query parameters from a URL', () => {
    expect(sanitizeUrl('https://user:pass@api.example.com/x')).toBe('https://api.example.com/x');
    expect(sanitizeUrl('https://api.example.com/x?api_key=secret&q=1', ['api_key'])).toBe(
      'https://api.example.com/x?api_key=REDACTED&q=1',
    );
  });

  it('never returns the response body of a blocked destination', async () => {
    const h = await setup();
    try {
      await h.app.caller.call(
        {
          apiId: h.apiId,
          operationId: 'diagnostics.redirect',
          parameters: { query: { to: 'http://169.254.169.254/latest/meta-data/iam/' } },
        },
        context,
      );
      expect.unreachable();
    } catch (error: any) {
      expect(JSON.stringify(error.details ?? {})).not.toContain('meta-data');
    }
  });
});
