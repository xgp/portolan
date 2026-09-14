/**
 * A real MCP client talking to `portolan serve` over stdio.
 *
 * SPEC.md §52 is explicit that "tests that call internal service classes alone" are not
 * sufficient, so the end-to-end suite spawns the built CLI as a subprocess and speaks
 * MCP to it exactly as a coding agent would.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SERVER_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

export interface McpHarness {
  client: Client;
  configPath: string;
  dataDir: string;
  /** Parse the JSON payload of a tool result, whether success or error. */
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }>;
  close(): Promise<void>;
}

export interface McpHarnessOptions {
  /** Configuration written to the temporary config.yaml the server is started with. */
  config: Record<string, unknown>;
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
}

export async function startMcpHarness(options: McpHarnessOptions): Promise<McpHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'portolan-e2e-'));
  const configPath = join(dataDir, 'config.yaml');

  writeFileSync(
    configPath,
    stringifyYaml({
      database: { path: join(dataDir, 'portolan.db') },
      logging: { level: 'silent' },
      ...options.config,
    }),
    'utf8',
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, 'serve', '--transport', 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORTOLAN_CONFIG: configPath,
      ...options.env,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'portolan-e2e', version: '1.0.0' });
  await client.connect(transport);

  const harness: McpHarness = {
    client,
    configPath,
    dataDir,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const first = result.content?.[0];
      const text = first && first.type === 'text' ? first.text : '{}';
      return { isError: result.isError === true, data: JSON.parse(text) };
    },
    async close() {
      await client.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}
