/** The Streamable HTTP transport (SPEC.md §4, §40, docs/DEVIATIONS.md D17). */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { runServe, type ServeHandle } from '../../src/cli/serve.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { connect } from 'node:net';

/** Send a literal HTTP request so headers `fetch` forbids can be forged. */
function rawRequest(port: string, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}`);
    });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(received);
    });
  });
}

let handle: ServeHandle | undefined;
let dataDir: string | undefined;

function writeConfig(config: Record<string, unknown>): string {
  dataDir = mkdtempSync(join(tmpdir(), 'portolan-http-'));
  const path = join(dataDir, 'config.yaml');
  writeFileSync(
    path,
    stringifyYaml({
      database: { path: join(dataDir, 'p.db') },
      logging: { level: 'silent' },
      ...config,
    }),
    'utf8',
  );
  return path;
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe('streamable HTTP transport', () => {
  it('serves MCP over HTTP on loopback', async () => {
    const configPath = writeConfig({
      server: { transport: 'http', http: { host: '127.0.0.1', port: 8765 } },
    });
    handle = await runServe({ configPath, transport: 'http', host: '127.0.0.1', port: 0 });

    const client = new Client({ name: 'http-e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url!)));
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
    } finally {
      await client.close();
    }
  });

  it('refuses to bind a non-loopback address without a configured token', async () => {
    const configPath = writeConfig({
      server: { transport: 'http', http: { host: '127.0.0.1', port: 8765 } },
    });
    await expect(
      runServe({ configPath, transport: 'http', host: '0.0.0.0', port: 0 }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('refuses to bind a non-loopback address when the token variable is unset', async () => {
    delete process.env.PORTOLAN_HTTP_TOKEN_TEST;
    const configPath = writeConfig({
      server: {
        transport: 'http',
        http: { host: '127.0.0.1', port: 8765, auth_token_env: 'PORTOLAN_HTTP_TOKEN_TEST' },
      },
    });
    await expect(
      runServe({ configPath, transport: 'http', host: '0.0.0.0', port: 0 }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('requires a bearer token when one is configured', async () => {
    process.env.PORTOLAN_HTTP_TOKEN_TEST = 'http-transport-token';
    try {
      const configPath = writeConfig({
        server: {
          transport: 'http',
          http: { host: '127.0.0.1', port: 8765, auth_token_env: 'PORTOLAN_HTTP_TOKEN_TEST' },
        },
      });
      handle = await runServe({ configPath, transport: 'http', host: '127.0.0.1', port: 0 });

      const unauthenticated = await fetch(handle.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');

      const wrongToken = await fetch(handle.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token-value' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(wrongToken.status).toBe(401);
    } finally {
      delete process.env.PORTOLAN_HTTP_TOKEN_TEST;
    }
  });

  it('rejects a forged Host or Origin header (DNS rebinding)', async () => {
    const configPath = writeConfig({
      server: { transport: 'http', http: { host: '127.0.0.1', port: 8765 } },
    });
    handle = await runServe({ configPath, transport: 'http', host: '127.0.0.1', port: 0 });
    const url = new URL(handle.url!);

    // `fetch` refuses to send a forged Host header, so this one goes over a raw socket.
    const forgedHost = await rawRequest(url.port, [
      'POST /mcp HTTP/1.1',
      `Host: evil.example.com:${url.port}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}',
    ]);
    expect(forgedHost).toMatch(/^HTTP\/1\.1 403/);

    const realHost = await rawRequest(url.port, [
      'POST /mcp HTTP/1.1',
      `Host: 127.0.0.1:${url.port}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}',
    ]);
    expect(realHost).not.toMatch(/^HTTP\/1\.1 403/);

    const forgedOrigin = await fetch(handle.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: '{}',
    });
    expect(forgedOrigin.status).toBe(403);
  });
});
