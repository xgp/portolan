/**
 * A local HTTP API used by the integration and end-to-end suites (SPEC.md §52, §53).
 *
 * It serves its own OpenAPI document and implements every case the spec requires:
 * all five methods, path parameters, query arrays, deepObject, JSON and form bodies,
 * authentication, redirects, a large response, a slow endpoint, and the 400/401/404/429/500
 * status codes. Tests make real HTTP requests against it — nothing is mocked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface User {
  id: string;
  email: string;
  name: string;
  enabled: boolean;
}

export interface FixtureServer {
  url: string;
  port: number;
  /** Every request the server received, for asserting what was actually sent. */
  requests: RecordedRequest[];
  users: Map<string, User>;
  reset(): void;
  close(): Promise<void>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

const API_KEY = 'fixture-secret-key';

export function openApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Fixture Directory API',
      version: '1.0.0',
      description:
        'A local directory service for tests: list and search users by email, update a ' +
        'user to enable or disable the account, and exercise error and redirect handling.',
    },
    servers: [{ url: baseUrl }],
    tags: [{ name: 'Users' }, { name: 'Diagnostics' }],
    paths: {
      '/users': {
        get: {
          operationId: 'users.list',
          summary: 'List or find users by email',
          description:
            'Returns the directory. Supply email to find a single user by email address.',
          tags: ['Users'],
          parameters: [
            {
              name: 'email',
              in: 'query',
              description: 'Exact email address to find',
              schema: { type: 'string' },
            },
            {
              name: 'tags',
              in: 'query',
              description: 'Repeated tag filter',
              style: 'form',
              explode: true,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'ids',
              in: 'query',
              description: 'Pipe-delimited id list',
              style: 'pipeDelimited',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'filter',
              in: 'query',
              description: 'Structured filter',
              style: 'deepObject',
              explode: true,
              schema: {
                type: 'object',
                properties: { enabled: { type: 'boolean' }, name: { type: 'string' } },
              },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: {
            200: {
              description: 'Users',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
        },
        post: {
          operationId: 'users.create',
          summary: 'Create a user',
          tags: ['Users'],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NewUser' } } },
          },
          responses: { 201: { description: 'Created' } },
        },
      },
      '/users/{id}': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'User identifier',
            schema: { type: 'string' },
          },
        ],
        get: {
          operationId: 'users.get',
          summary: 'Get one user',
          tags: ['Users'],
          responses: {
            200: {
              description: 'User',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
            },
            404: { description: 'Not found' },
          },
        },
        put: {
          operationId: 'users.update',
          summary: 'Update a user to enable or disable the account',
          description: 'Replace the user record. Set enabled to false to disable the account.',
          tags: ['Users'],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          responses: {
            200: {
              description: 'Updated',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
            },
          },
        },
        patch: {
          operationId: 'users.patch',
          summary: 'Partially update a user',
          tags: ['Users'],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { 200: { description: 'Patched' } },
        },
        delete: {
          operationId: 'users.delete',
          summary: 'Delete a user',
          tags: ['Users'],
          responses: { 204: { description: 'Deleted' } },
        },
      },
      '/users/{id}/avatar': {
        get: {
          operationId: 'users.avatar',
          summary: 'Get the user avatar image',
          tags: ['Users'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'PNG bytes' } },
        },
      },
      '/headers': {
        get: {
          operationId: 'diagnostics.headers',
          summary: 'Echo the request headers back',
          tags: ['Diagnostics'],
          parameters: [
            {
              name: 'X-Trace',
              in: 'header',
              description: 'Trace header',
              schema: { type: 'string' },
            },
            {
              name: 'session',
              in: 'cookie',
              description: 'Session cookie',
              schema: { type: 'string' },
            },
          ],
          responses: { 200: { description: 'Echo' } },
        },
      },
      '/form': {
        post: {
          operationId: 'diagnostics.form',
          summary: 'Accept a urlencoded form body',
          tags: ['Diagnostics'],
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: { a: { type: 'string' }, b: { type: 'string' } },
                },
              },
            },
          },
          responses: { 200: { description: 'Echo' } },
        },
      },
      '/multipart': {
        post: {
          operationId: 'diagnostics.multipart',
          summary: 'Accept a multipart body',
          tags: ['Diagnostics'],
          requestBody: {
            required: true,
            content: { 'multipart/form-data': { schema: { type: 'object' } } },
          },
          responses: { 200: { description: 'Echo' } },
        },
      },
      '/text': {
        post: {
          operationId: 'diagnostics.text',
          summary: 'Accept a plain text body',
          tags: ['Diagnostics'],
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          responses: { 200: { description: 'Echo' } },
        },
      },
      '/secure': {
        get: {
          operationId: 'diagnostics.secure',
          summary: 'Require an API key',
          tags: ['Diagnostics'],
          responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } },
        },
      },
      '/large': {
        get: {
          operationId: 'diagnostics.large',
          summary: 'Return a very large response',
          tags: ['Diagnostics'],
          parameters: [{ name: 'bytes', in: 'query', schema: { type: 'integer' } }],
          responses: { 200: { description: 'Large body' } },
        },
      },
      '/slow': {
        get: {
          operationId: 'diagnostics.slow',
          summary: 'Respond after a delay',
          tags: ['Diagnostics'],
          parameters: [{ name: 'ms', in: 'query', schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/status/{code}': {
        get: {
          operationId: 'diagnostics.status',
          summary: 'Return the requested status code',
          tags: ['Diagnostics'],
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            200: { description: 'OK' },
            400: { description: 'Bad request' },
            401: { description: 'Unauthorized' },
            404: { description: 'Not found' },
            429: { description: 'Rate limited' },
            500: { description: 'Server error' },
          },
        },
      },
      '/redirect': {
        get: {
          operationId: 'diagnostics.redirect',
          summary: 'Redirect to another location',
          tags: ['Diagnostics'],
          parameters: [
            { name: 'to', in: 'query', schema: { type: 'string' } },
            { name: 'hops', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' }, 302: { description: 'Redirect' } },
        },
      },
      '/echo-auth': {
        get: {
          operationId: 'diagnostics.echoAuth',
          summary: 'Report which credential headers arrived',
          tags: ['Diagnostics'],
          responses: { 200: { description: 'OK' } },
        },
      },
    },
    components: {
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      schemas: {
        User: {
          type: 'object',
          required: ['id', 'email'],
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            name: { type: 'string' },
            enabled: { type: 'boolean', description: 'Whether the account is enabled or disabled' },
          },
        },
        NewUser: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string' },
            name: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
      },
    },
  };
}

function defaultUsers(): Map<string, User> {
  return new Map<string, User>([
    ['u1', { id: 'u1', email: 'john@example.com', name: 'John Doe', enabled: true }],
    ['u2', { id: 'u2', email: 'jane@example.com', name: 'Jane Roe', enabled: true }],
    ['u3', { id: 'u3', email: 'sam@example.com', name: 'Sam Poe', enabled: false }],
  ]);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  let users = defaultUsers();
  let baseUrl = '';

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(', ') : (v ?? ''),
          ]),
        ),
        body,
      });
      void handle(req, res, url, body);
    });
  });

  function json(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (path === '/openapi.json') return json(res, 200, openApiDocument(baseUrl));

    if (path === '/users' && method === 'GET') {
      let list = [...users.values()];
      const email = url.searchParams.get('email');
      if (email) list = list.filter((u) => u.email === email);
      const enabled = url.searchParams.get('filter[enabled]');
      if (enabled !== null) list = list.filter((u) => String(u.enabled) === enabled);
      const limit = url.searchParams.get('limit');
      if (limit) list = list.slice(0, Number(limit));
      return json(res, 200, list);
    }

    if (path === '/users' && method === 'POST') {
      const parsed = JSON.parse(body || '{}') as Partial<User>;
      const id = `u${users.size + 1}`;
      const user: User = {
        id,
        email: parsed.email ?? '',
        name: parsed.name ?? '',
        enabled: parsed.enabled ?? true,
      };
      users.set(id, user);
      return json(res, 201, user);
    }

    const userMatch = /^\/users\/([^/]+)$/.exec(path);
    if (userMatch?.[1]) {
      const id = decodeURIComponent(userMatch[1]);
      const existing = users.get(id);
      if (method === 'GET') {
        return existing ? json(res, 200, existing) : json(res, 404, { error: 'not found' });
      }
      if (method === 'PUT') {
        const parsed = JSON.parse(body || '{}') as User;
        const updated: User = { ...parsed, id };
        users.set(id, updated);
        return json(res, 200, updated);
      }
      if (method === 'PATCH') {
        if (!existing) return json(res, 404, { error: 'not found' });
        const updated = { ...existing, ...(JSON.parse(body || '{}') as Partial<User>), id };
        users.set(id, updated);
        return json(res, 200, updated);
      }
      if (method === 'DELETE') {
        users.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (/^\/users\/[^/]+\/avatar$/.test(path)) {
      // A tiny PNG: binary content that must not be decoded as text.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      res.end(png);
      return;
    }

    if (path === '/headers') {
      return json(res, 200, { headers: req.headers });
    }

    if (path === '/form' || path === '/multipart' || path === '/text') {
      return json(res, 200, { content_type: req.headers['content-type'] ?? null, body });
    }

    if (path === '/secure') {
      if (req.headers['x-api-key'] !== API_KEY) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'ApiKey realm="fixture"',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      return json(res, 200, { ok: true });
    }

    if (path === '/echo-auth') {
      return json(res, 200, {
        authorization: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
        'x-api-key': req.headers['x-api-key'] ?? null,
        query: url.search,
      });
    }

    if (path === '/large') {
      const size = Number(url.searchParams.get('bytes') ?? 5_000_000);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":"');
      const chunk = 'x'.repeat(64 * 1024);
      let written = 0;
      while (written < size) {
        res.write(chunk);
        written += chunk.length;
      }
      res.write('"}');
      res.end();
      return;
    }

    if (path === '/slow') {
      const delay = Number(url.searchParams.get('ms') ?? 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return json(res, 200, { slept_ms: delay });
    }

    const statusMatch = /^\/status\/(\d{3})$/.exec(path);
    if (statusMatch?.[1]) {
      const code = Number(statusMatch[1]);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (code === 429) headers['retry-after'] = '120';
      if (code === 401) headers['www-authenticate'] = 'Bearer realm="fixture"';
      headers['set-cookie'] = 'session=should-never-be-returned; Path=/';
      res.writeHead(code, headers);
      res.end(JSON.stringify({ status: code, message: `fixture status ${code}` }));
      return;
    }

    if (path === '/redirect') {
      const hops = Number(url.searchParams.get('hops') ?? 0);
      const to = url.searchParams.get('to');
      if (hops > 0) {
        res.writeHead(302, { location: `/redirect?hops=${hops - 1}` });
        res.end();
        return;
      }
      if (to) {
        res.writeHead(302, { location: to });
        res.end();
        return;
      }
      return json(res, 200, { redirected: true });
    }

    return json(res, 404, { error: 'no such fixture route', path });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    port,
    requests,
    get users() {
      return users;
    },
    reset() {
      requests.length = 0;
      users = defaultUsers();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export const FIXTURE_API_KEY = API_KEY;
