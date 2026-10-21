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

  // docs/DEVIATIONS.md D20: correcting a document stays inside add_api.
  it('corrects a registered document through add_api, and can revert it', async () => {
    const spec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'E2E Corrections', version: '1' },
      servers: [{ url: 'https://corrections.example.com' }],
      paths: {
        '/items': {
          get: { operationId: 'listItems', responses: { '200': { description: 'OK' } } },
        },
      },
    });
    expect((await harness.call('add_api', { spec_content: spec, api_id: 'e2e-fix' })).isError).toBe(
      false,
    );

    const corrected = await harness.call('add_api', {
      api_id: 'e2e-fix',
      issue: { title: 'GET /items omits the page parameter', description: 'Accepts ?page=N.' },
      patches: [
        {
          op: 'add',
          path: '/paths/~1items/get/parameters',
          value: [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
        },
      ],
      upstream_repo: 'acme/items',
    });
    expect(corrected.isError).toBe(false);
    expect(corrected.data.status).toBe('corrected');
    expect(corrected.data.upstream_issues[0]).toMatchObject({
      repo: 'acme/items',
      status: 'draft',
    });

    const inspected = await harness.call('inspect_api', {
      api_id: 'e2e-fix',
      operation_ids: ['listItems'],
    });
    expect(inspected.data.operations[0].parameters.query[0].name).toBe('page');

    const reverted = await harness.call('add_api', {
      api_id: 'e2e-fix',
      revert_corrections: [corrected.data.corrections[0].id],
    });
    expect(reverted.data.corrections[0].status).toBe('reverted');
  });

  it('returns errors as readable tool results rather than protocol failures', async () => {
    const result = await harness.call('search_api', { api_id: 'nope', query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('API_NOT_FOUND');
    expect(result.data.error.message).toContain('nope');
  });

  it('clamps an over-large limit rather than rejecting the call', async () => {
    await harness.call('add_api', {
      api_id: 'limits',
      spec_content: JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Limits', version: '1' },
        servers: [{ url: 'https://limits.example.com' }],
        paths: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [
            `/thing${i}`,
            {
              get: {
                operationId: `thing${i}`,
                summary: `Get thing ${i}`,
                responses: { 200: { description: 'OK' } },
              },
            },
          ]),
        ),
      }),
    });

    const found = await harness.call('find_api', { query: 'thing', limit: 500 });
    expect(found.isError).toBe(false);
    expect(found.data.results.length).toBeLessThanOrEqual(20);

    const searched = await harness.call('search_api', {
      api_id: 'limits',
      query: 'thing',
      limit: 500,
    });
    expect(searched.isError).toBe(false);
    expect(searched.data.results.length).toBeLessThanOrEqual(30);
  });

  it('refuses more than ten operations in one inspect_api call', async () => {
    const result = await harness.call('inspect_api', {
      api_id: 'limits',
      operation_ids: Array.from({ length: 11 }, (_, i) => `thing${i}`),
    });
    expect(result.isError).toBe(true);
    expect(result.data.error.message).toMatch(/at most 10 operations/);
  });

  it('reports a bad add_api argument combination as a structured error', async () => {
    const result = await harness.call('add_api', {});
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('INVALID_ARGUMENT');
  });
});
