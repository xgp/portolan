/**
 * OAuth2 client credentials (SPEC.md §27) and remote `$ref` resolution (SPEC.md §45),
 * both against a real local HTTP server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPortolan, type Portolan } from '../../src/app.js';
import { parseConfig } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/logging.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/api-server.js';

interface TokenServer {
  url: string;
  issued: number;
  bodies: string[];
  authHeaders: (string | undefined)[];
  expiresIn: number;
  status: number;
  close(): Promise<void>;
}

async function startTokenServer(): Promise<TokenServer> {
  const state = { issued: 0, expiresIn: 3600, status: 200 };
  const bodies: string[] = [];
  const authHeaders: (string | undefined)[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      authHeaders.push(req.headers.authorization);
      if (state.status !== 200) {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        // Deliberately echo the secret: Portolan must not pass this on.
        res.end(JSON.stringify({ error: 'invalid_client', secret_echo: 'oauth-client-secret' }));
        return;
      }
      state.issued += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: `issued-token-${state.issued}`,
          token_type: 'Bearer',
          expires_in: state.expiresIn,
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/oauth/token`,
    get issued() {
      return state.issued;
    },
    bodies,
    authHeaders,
    set expiresIn(value: number) {
      state.expiresIn = value;
    },
    get expiresIn() {
      return state.expiresIn;
    },
    set status(value: number) {
      state.status = value;
    },
    get status() {
      return state.status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: Portolan | undefined;
let api: FixtureServer | undefined;
let tokens: TokenServer | undefined;
const context = { requestId: 'oauth-test' };

afterEach(async () => {
  app?.close();
  await api?.close();
  await tokens?.close();
  app = undefined;
  api = undefined;
  tokens = undefined;
  delete process.env.OAUTH_CLIENT_ID;
  delete process.env.OAUTH_CLIENT_SECRET;
});

async function setupOAuth(profileOverrides: Record<string, unknown> = {}) {
  api = await startFixtureServer();
  tokens = await startTokenServer();
  process.env.OAUTH_CLIENT_ID = 'portolan-client';
  process.env.OAUTH_CLIENT_SECRET = 'oauth-client-secret';

  const config = parseConfig(
    {
      database: { path: ':memory:' },
      network: { allow_loopback: true, allow_http: true },
      logging: { level: 'silent' },
      auth_profiles: {
        partner: {
          type: 'oauth2_client_credentials',
          token_url: tokens.url,
          client_id_env: 'OAUTH_CLIENT_ID',
          client_secret_env: 'OAUTH_CLIENT_SECRET',
          scopes: ['admin', 'read'],
          ...profileOverrides,
        },
      },
      environments: [
        {
          api: 'fixture',
          name: 'default',
          base_url: api.url,
          auth_profile: 'partner',
          is_default: true,
        },
      ],
    },
    'oauth-test',
  );

  app = createPortolan({ config, logger: createSilentLogger(), databasePath: ':memory:' });
  await app.catalog.addApi({ specUrl: `${api.url}/openapi.json`, apiId: 'fixture' });
  app.catalog.syncConfiguredEnvironments();
  return { app, api, tokens };
}

describe('OAuth2 client credentials (SPEC.md §27)', () => {
  it('obtains a token and sends it as a bearer credential', async () => {
    const h = await setupOAuth();
    const result = await h.app.caller.call(
      { apiId: 'fixture', operationId: 'diagnostics.echoAuth' },
      context,
    );
    expect((result.response.body as any).authorization).toBe('Bearer issued-token-1');
    expect(h.tokens.issued).toBe(1);

    const form = new URLSearchParams(h.tokens.bodies[0]);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('admin read');
    expect(form.get('client_id')).toBe('portolan-client');
  });

  it('caches the token across calls rather than re-fetching', async () => {
    const h = await setupOAuth();
    for (let i = 0; i < 3; i++) {
      await h.app.caller.call({ apiId: 'fixture', operationId: 'diagnostics.echoAuth' }, context);
    }
    expect(h.tokens.issued).toBe(1);
  });

  it('refreshes before expiry rather than sending a stale token', async () => {
    const h = await setupOAuth();
    h.tokens.expiresIn = 1; // inside the refresh margin, so every call re-fetches
    await h.app.caller.call({ apiId: 'fixture', operationId: 'diagnostics.echoAuth' }, context);
    const second = await h.app.caller.call(
      { apiId: 'fixture', operationId: 'diagnostics.echoAuth' },
      context,
    );
    expect(h.tokens.issued).toBe(2);
    expect((second.response.body as any).authorization).toBe('Bearer issued-token-2');
  });

  it('collapses concurrent refreshes into one token request', async () => {
    const h = await setupOAuth();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        h.app.caller.call({ apiId: 'fixture', operationId: 'diagnostics.echoAuth' }, context),
      ),
    );
    expect(h.tokens.issued).toBe(1);
  });

  it('supports HTTP Basic client authentication', async () => {
    const h = await setupOAuth({ client_auth: 'basic' });
    await h.app.caller.call({ apiId: 'fixture', operationId: 'diagnostics.echoAuth' }, context);
    const header = h.tokens.authHeaders[0]!;
    expect(Buffer.from(header.replace('Basic ', ''), 'base64').toString()).toBe(
      'portolan-client:oauth-client-secret',
    );
    expect(new URLSearchParams(h.tokens.bodies[0]).has('client_secret')).toBe(false);
  });

  it('never persists or returns the access token', async () => {
    const h = await setupOAuth();
    const result = await h.app.caller.call(
      { apiId: 'fixture', operationId: 'users.list' },
      context,
    );
    expect(JSON.stringify(result)).not.toContain('issued-token');
    // Nothing token-shaped is anywhere in the database.
    const tables = h.app.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (name.startsWith('sqlite_')) continue;
      const rows = h.app.db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows), name).not.toContain('issued-token');
      expect(JSON.stringify(rows), name).not.toContain('oauth-client-secret');
    }
  });

  it('reports a token endpoint failure without echoing the error body', async () => {
    const h = await setupOAuth();
    h.tokens.status = 401;
    try {
      await h.app.caller.call({ apiId: 'fixture', operationId: 'diagnostics.echoAuth' }, context);
      expect.unreachable();
    } catch (error: any) {
      expect(error.code).toBe('AUTH_FAILED');
      expect(error.details.status).toBe(401);
      // The endpoint echoed the secret back; Portolan must not pass that on.
      expect(JSON.stringify(error)).not.toContain('oauth-client-secret');
    }
  });

  it('refuses a token endpoint the network policy blocks', async () => {
    api = await startFixtureServer();
    process.env.OAUTH_CLIENT_ID = 'c';
    process.env.OAUTH_CLIENT_SECRET = 's';
    const config = parseConfig(
      {
        database: { path: ':memory:' },
        network: { allow_loopback: true, allow_http: true },
        logging: { level: 'silent' },
        auth_profiles: {
          evil: {
            type: 'oauth2_client_credentials',
            token_url: 'http://169.254.169.254/token',
            client_id_env: 'OAUTH_CLIENT_ID',
            client_secret_env: 'OAUTH_CLIENT_SECRET',
          },
        },
        environments: [
          {
            api: 'fixture',
            name: 'default',
            base_url: api.url,
            auth_profile: 'evil',
            is_default: true,
          },
        ],
      },
      'oauth-blocked',
    );
    app = createPortolan({ config, logger: createSilentLogger(), databasePath: ':memory:' });
    await app.catalog.addApi({ specUrl: `${api.url}/openapi.json`, apiId: 'fixture' });
    app.catalog.syncConfiguredEnvironments();

    await expect(
      app.caller.call({ apiId: 'fixture', operationId: 'users.list' }, context),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });
});

describe('spec_url import and remote $refs (SPEC.md §11, §45)', () => {
  it('imports a specification by URL', async () => {
    api = await startFixtureServer();
    const config = parseConfig(
      {
        database: { path: ':memory:' },
        network: { allow_loopback: true, allow_http: true },
        logging: { level: 'silent' },
      },
      'url-import',
    );
    app = createPortolan({ config, logger: createSilentLogger(), databasePath: ':memory:' });
    const result = await app.catalog.addApi({ specUrl: `${api.url}/openapi.json` });
    expect(result.status).toBe('added');
    expect(result.api_id).toBe('fixture-directory-api');
    expect(result.operations).toBeGreaterThan(5);
    expect(app.catalog.getCurrentVersion(result.api_id).sourceType).toBe('url');
  });

  it('resolves a remote $ref through the same policy-checked fetch', async () => {
    // A tiny server that serves one schema document.
    const schema = { type: 'object', title: 'Item', properties: { sku: { type: 'string' } } };
    let served = 0;
    const refServer = createServer((_req, res) => {
      served += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(schema));
    });
    await new Promise<void>((resolve) => refServer.listen(0, '127.0.0.1', resolve));
    const port = (refServer.address() as AddressInfo).port;

    try {
      const config = parseConfig(
        {
          database: { path: ':memory:' },
          network: { allow_loopback: true, allow_http: true },
          logging: { level: 'silent' },
        },
        'ref-test',
      );
      app = createPortolan({ config, logger: createSilentLogger(), databasePath: ':memory:' });
      const result = await app.catalog.addApi({
        apiId: 'refs',
        specContent: JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'Remote Refs', version: '1' },
          servers: [{ url: 'https://refs.example.com' }],
          paths: {
            '/items': {
              get: {
                operationId: 'listItems',
                responses: {
                  '200': {
                    description: 'OK',
                    content: {
                      'application/json': {
                        schema: { $ref: `http://127.0.0.1:${port}/item.json` },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      });
      expect(result.status).toBe('added');
      expect(served).toBeGreaterThan(0);
      // The external schema was inlined into the stored document.
      expect(JSON.stringify(app.catalog.getSpecDocument('refs'))).toContain('"sku"');
    } finally {
      refServer.closeAllConnections();
      await new Promise<void>((resolve) => refServer.close(() => resolve()));
    }
  });

  it('refuses a remote $ref to a blocked address', async () => {
    const config = parseConfig(
      { database: { path: ':memory:' }, logging: { level: 'silent' } },
      'ref-blocked',
    );
    app = createPortolan({ config, logger: createSilentLogger(), databasePath: ':memory:' });
    await expect(
      app.catalog.addApi({
        apiId: 'evil-refs',
        specContent: JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'Evil Refs', version: '1' },
          servers: [{ url: 'https://x.example.com' }],
          paths: {
            '/a': {
              get: {
                operationId: 'a',
                responses: {
                  '200': {
                    description: 'OK',
                    content: {
                      'application/json': {
                        schema: { $ref: 'http://169.254.169.254/latest/meta-data/' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });
});
