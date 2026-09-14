/** The MCP surface itself (SPEC.md §3.2, §15, §41, §62). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMcpHarness, type McpHarness } from './mcp-client.js';
import { TOOL_NAMES } from '../../src/mcp/tools/index.js';

let harness: McpHarness;

beforeAll(async () => {
  harness = await startMcpHarness({ config: {} });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('MCP surface', () => {
  it('exposes exactly the six primary tools', async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(6);
  });

  it('gives every tool a description that teaches the workflow', async () => {
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description!.length, tool.name).toBeGreaterThan(60);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('find_api')!.description).toMatch(/before search_api/);
    expect(byName.get('search_api')!.description).toMatch(/inspect_api/);
    expect(byName.get('run_api_code')!.description).toMatch(/api\.call\(\)/);
  });

  it('publishes input schemas the client can validate against', async () => {
    const { tools } = await harness.client.listTools();
    const callApi = tools.find((t) => t.name === 'call_api')!;
    const schema = callApi.inputSchema as any;
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['api_id', 'operation_id', 'environment', 'parameters', 'body']),
    );
    // SPEC.md §20: the agent must not be able to supply a destination or credentials.
    expect(Object.keys(schema.properties)).not.toContain('base_url');
    expect(Object.keys(schema.properties)).not.toContain('url');
    expect(Object.keys(schema.properties)).not.toContain('headers');
    expect(Object.keys(schema.properties)).not.toContain('auth');
  });

  it('sends server instructions describing the workflow', () => {
    const instructions = harness.client.getInstructions();
    expect(instructions).toMatch(/find_api/);
    expect(instructions).toMatch(/run_api_code/);
    expect(instructions).toMatch(/Never pass\s+tokens/);
  });

  it('returns errors as readable tool results rather than protocol failures', async () => {
    const result = await harness.call('search_api', { api_id: 'nope', query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('API_NOT_FOUND');
    expect(result.data.error.message).toContain('nope');
  });

  it('reports a bad add_api argument combination as a structured error', async () => {
    const result = await harness.call('add_api', {});
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('INVALID_ARGUMENT');
  });
});
