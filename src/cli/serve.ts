/**
 * `portolan serve` (SPEC.md §40).
 *
 * stdio is the default. Streamable HTTP binds loopback unless a bearer token is
 * configured (docs/DEVIATIONS.md D17), and always validates Origin and Host headers
 * against the bind address to block DNS-rebinding from a browser.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createPortolan, type Portolan } from '../app.js';
import { isLoopbackHost, loadConfig } from '../config/config.js';
import { PortolanError } from '../errors/errors.js';
import { createMcpServer } from '../mcp/server.js';

export interface ServeOptions {
  configPath?: string;
  transport?: 'stdio' | 'http';
  host?: string;
  port?: number;
}

export interface ServeHandle {
  transport: 'stdio' | 'http';
  /** Bound address, for the HTTP transport. */
  url?: string;
  app: Portolan;
  close(): Promise<void>;
}

export async function runServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const { config } = loadConfig(options.configPath);
  const transport = options.transport ?? config.server.transport;

  const app = createPortolan({ config });
  // docs/DEVIATIONS.md D24: pick up enrichment a previous run did not finish.
  app.enricher.scheduleAll();

  if (transport === 'stdio') {
    // Anything written to stdout other than JSON-RPC corrupts the transport; the logger
    // is configured to stderr and nothing here prints.
    const handle = serveStdio(() => createMcpServer(app), {
      onerror: (error) => app.logger.error({ err: error.message }, 'stdio transport error'),
    });
    app.logger.info({ transport: 'stdio' }, 'portolan serving');
    return {
      transport: 'stdio',
      app,
      close: async () => {
        await handle.close();
        app.close();
      },
    };
  }

  return serveHttp(app, options);
}

async function serveHttp(app: Portolan, options: ServeOptions): Promise<ServeHandle> {
  const { config } = app;
  const host = options.host ?? config.server.http.host;
  const port = options.port ?? config.server.http.port;

  // SPEC.md §40 — never expose an unauthenticated server off loopback.
  const tokenEnv = config.server.http.auth_token_env;
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (!isLoopbackHost(host)) {
    if (!tokenEnv) {
      app.close();
      throw new PortolanError(
        'CONFIG_INVALID',
        `Refusing to bind ${host}: an HTTP transport on a non-loopback address requires server.http.auth_token_env.`,
        { host },
      );
    }
    if (!token) {
      app.close();
      throw new PortolanError(
        'CONFIG_INVALID',
        `Refusing to bind ${host}: environment variable ${tokenEnv} is not set.`,
        { host, environment_variable: tokenEnv },
      );
    }
  }

  const handler = createMcpHandler(() => createMcpServer(app), {
    onerror: (error) => app.logger.error({ err: error.message }, 'http transport error'),
  });

  const allowedHostnames = allowedHostHeaders(host, port);

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      handler,
      allowedHostnames,
      ...(token ? { token } : {}),
      app,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}/mcp`;
  app.logger.info({ transport: 'http', url, authenticated: Boolean(token) }, 'portolan serving');

  return {
    transport: 'http',
    url,
    app,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await handler.close();
      app.close();
    },
  };
}

interface RequestOptions {
  handler: ReturnType<typeof createMcpHandler>;
  allowedHostnames: string[];
  token?: string;
  app: Portolan;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestOptions,
): Promise<void> {
  const { handler, allowedHostnames, token } = options;

  // DNS-rebinding protection: a browser page cannot reach a local server whose Host or
  // Origin it cannot forge.
  const hostHeader = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
  if (!allowedHostnames.includes(hostHeader)) {
    return respond(res, 403, { error: { code: 'FORBIDDEN', message: 'Host header not allowed.' } });
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return respond(res, 403, {
        error: { code: 'FORBIDDEN', message: 'Malformed Origin header.' },
      });
    }
    if (!allowedHostnames.includes(originHost)) {
      return respond(res, 403, { error: { code: 'FORBIDDEN', message: 'Origin not allowed.' } });
    }
  }

  if (token && !hasValidBearer(req.headers.authorization, token)) {
    res.setHeader('www-authenticate', 'Bearer');
    return respond(res, 401, {
      error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' },
    });
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/mcp' && url.pathname !== '/') {
    return respond(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown path.' } });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers: toHeaders(req),
    ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
    // Node's Request requires duplex for a streaming body; a buffered body does not.
  });

  const response = await handler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
  }
  res.end();
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else headers.set(name, value);
  }
  return headers;
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Constant-time bearer comparison, so token length and prefix do not leak via timing. */
function hasValidBearer(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const supplied = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length) return false;
  return timingSafeEqual(supplied, wanted);
}

function allowedHostHeaders(host: string, port: number): string[] {
  const names = new Set<string>([host.toLowerCase()]);
  if (isLoopbackHost(host)) {
    names.add('localhost');
    names.add('127.0.0.1');
    names.add('[::1]');
    names.add('::1');
  }
  void port;
  return [...names];
}
