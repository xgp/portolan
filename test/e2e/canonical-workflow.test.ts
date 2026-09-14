/**
 * The canonical end-to-end scenario (SPEC.md §53) and the Definition of Done (§62).
 *
 * Everything here goes through a real MCP client talking to `portolan serve` in a
 * separate process. No internal class is touched: if this suite passes, an agent can do
 * the same thing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../fixtures/api-server.js';
import { startMcpHarness, type McpHarness } from './mcp-client.js';

let server: FixtureServer;
let harness: McpHarness;

/** Everything the transcript ever showed the "model", for the leakage assertions. */
const transcript: string[] = [];

async function call(name: string, args: Record<string, unknown>) {
  const result = await harness.call(name, args);
  transcript.push(JSON.stringify(result.data));
  return result;
}

const SECRET_TOKEN = 'e2e-secret-token-value-do-not-leak';

beforeAll(async () => {
  server = await startFixtureServer();
  harness = await startMcpHarness({
    config: {
      network: { allow_loopback: true, allow_http: true },
      auth_profiles: { fixture: { type: 'bearer', token_env: 'E2E_TOKEN' } },
      environments: [
        {
          api: 'directory',
          name: 'production',
          base_url: server.url,
          auth_profile: 'fixture',
          allow_mutations: true,
          is_default: true,
        },
        // A second environment proves the policy is per-environment (SPEC.md §29).
        { api: 'directory', name: 'readonly', base_url: server.url, allow_mutations: false },
      ],
    },
    env: { E2E_TOKEN: SECRET_TOKEN },
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await server?.close();
});

describe('the canonical workflow (SPEC.md §53)', () => {
  it('1. add_api registers the API', async () => {
    const result = await call('add_api', {
      spec_url: `${server.url}/openapi.json`,
      api_id: 'directory',
    });
    expect(result.isError).toBe(false);
    expect(result.data.status).toBe('added');
    expect(result.data.api_id).toBe('directory');
    expect(result.data.operations).toBeGreaterThan(5);
    // The complete OpenAPI document is not echoed back (SPEC.md §3.1).
    expect(JSON.stringify(result.data)).not.toContain('"openapi"');
    expect(JSON.stringify(result.data).length).toBeLessThan(4000);
  });

  it('2. find_api("user management") finds it', async () => {
    const result = await call('find_api', { query: 'user management' });
    expect(result.isError).toBe(false);
    expect(result.data.results[0].api_id).toBe('directory');
    // No operations, no schemas (SPEC.md §17).
    expect(result.data.results[0]).not.toHaveProperty('operations');
    expect(JSON.stringify(result.data)).not.toContain('parameters');
  });

  it('3. search_api("find user by email") finds the GET operation', async () => {
    const result = await call('search_api', { api_id: 'directory', query: 'find user by email' });
    expect(result.isError).toBe(false);
    expect(result.data.results[0].operation_id).toBe('users.list');
    expect(result.data.results[0].method).toBe('GET');
    // Compact results (SPEC.md §3.4).
    expect(JSON.stringify(result.data)).not.toContain('schema');
  });

  it('3b. search_api("disable a user account") finds the update operation', async () => {
    const result = await call('search_api', {
      api_id: 'directory',
      query: 'disable a user account',
    });
    expect(result.data.results[0].operation_id).toBe('users.update');
    expect(result.data.results[0].method).toBe('PUT');
  });

  it('4. inspect_api returns the detail needed to call them', async () => {
    const result = await call('inspect_api', {
      api_id: 'directory',
      operation_ids: ['users.list', 'users.update'],
    });
    expect(result.isError).toBe(false);
    const [list, update] = result.data.operations;

    expect(list.operation_id).toBe('users.list');
    expect(list.parameters.query.map((p: any) => p.name)).toContain('email');
    expect(list.parameters.query.find((p: any) => p.name === 'email').description).toBeTruthy();

    expect(update.operation_id).toBe('users.update');
    expect(update.method).toBe('PUT');
    expect(update.parameters.path.map((p: any) => p.name)).toEqual(['id']);
    expect(update.request_body.required).toBe(true);
    expect(update.request_body.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/User',
    );
    // The referenced schema is resolvable by the agent (docs/DEVIATIONS.md D11).
    expect(result.data.components.schemas.User.properties.enabled).toBeDefined();
    // ...and only the referenced ones are returned (SPEC.md §19).
    expect(Object.keys(result.data.components.schemas)).toEqual(['User']);
  });

  it('5. call_api retrieves a user', async () => {
    const result = await call('call_api', {
      api_id: 'directory',
      operation_id: 'users.list',
      parameters: { query: { email: 'john@example.com' } },
    });
    expect(result.isError).toBe(false);
    expect(result.data.response.status).toBe(200);
    expect(result.data.response.body).toHaveLength(1);
    expect(result.data.response.body[0].id).toBe('u1');
    expect(result.data.response.body[0].enabled).toBe(true);
  });

  it('6. call_api disables john@example.com and the change is real', async () => {
    const result = await call('call_api', {
      api_id: 'directory',
      operation_id: 'users.update',
      parameters: { path: { id: 'u1' } },
      body: { id: 'u1', email: 'john@example.com', name: 'John Doe', enabled: false },
    });
    expect(result.isError).toBe(false);
    expect(result.data.response.status).toBe(200);
    // Verified against the server's own state, not the response body.
    expect(server.users.get('u1')?.enabled).toBe(false);
  });

  it('7. run_api_code finds disabled users and retrieves their groups', async () => {
    // Disable a second user so the script has more than one to work with.
    await call('call_api', {
      api_id: 'directory',
      operation_id: 'users.update',
      parameters: { path: { id: 'u3' } },
      body: { id: 'u3', email: 'sam@example.com', name: 'Sam Poe', enabled: false },
    });

    const result = await call('run_api_code', {
      api_id: 'directory',
      code: `
        const listed = await api.call({ operation_id: 'users.list' });
        const disabled = listed.response.body.filter((u) => u.enabled === false);
        const detail = [];
        for (const user of disabled) {
          const one = await api.call({
            operation_id: 'users.get',
            parameters: { path: { id: user.id } },
          });
          detail.push({ id: one.response.body.id, email: one.response.body.email });
        }
        console.log('inspected ' + detail.length + ' disabled users');
        return { count: detail.length, users: detail };
      `,
    });

    expect(result.isError).toBe(false);
    expect(result.data.result.count).toBe(2);
    expect(result.data.result.users.map((u: any) => u.id).sort()).toEqual(['u1', 'u3']);
    expect(result.data.api_calls).toBe(3);
    expect(result.data.logs).toEqual(['[log] inspected 2 disabled users']);
  });

  it('8. the SPEC.md §53 loop-and-update script works verbatim', async () => {
    const result = await call('run_api_code', {
      api_id: 'directory',
      input: { email: 'jane@example.com' },
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
    });
    expect(result.data.result).toEqual({ updated: 'u2' });
    expect(server.users.get('u2')?.enabled).toBe(false);
  });
});

describe('the Definition of Done invariants (SPEC.md §62)', () => {
  it('the complete OpenAPI document never entered the transcript', async () => {
    const everythingTheModelSaw = transcript.join('\n');

    // Signature fragments only a full dump would contain.
    expect(everythingTheModelSaw).not.toContain('"openapi":"3.0.3"');
    expect(everythingTheModelSaw).not.toContain('securitySchemes');
    // An operation the agent never asked about must never have been shown to it.
    expect(everythingTheModelSaw).not.toContain('diagnostics.slow');
    expect(everythingTheModelSaw).not.toContain('diagnostics.multipart');

    // The whole workflow cost less context than the document itself would have.
    const response = await fetch(`${server.url}/openapi.json`);
    const documentBytes = (await response.text()).length;
    expect(documentBytes).toBeGreaterThan(4000);
    expect(everythingTheModelSaw.length).toBeLessThan(documentBytes * 2);
  });

  it('credentials never entered the transcript', () => {
    expect(transcript.join('\n')).not.toContain(SECRET_TOKEN);
    expect(transcript.join('\n')).not.toContain('Authorization');
  });

  it('but the credential really was applied server-side', () => {
    const authenticated = server.requests.filter(
      (r) => r.headers.authorization === `Bearer ${SECRET_TOKEN}`,
    );
    expect(authenticated.length).toBeGreaterThan(0);
  });

  it('mutating operations obey per-environment policy', async () => {
    const result = await call('call_api', {
      api_id: 'directory',
      operation_id: 'users.update',
      environment: 'readonly',
      parameters: { path: { id: 'u1' } },
      body: { id: 'u1', email: 'john@example.com', enabled: true },
    });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('MUTATION_NOT_ALLOWED');
    // The read-only environment did not change anything.
    expect(server.users.get('u1')?.enabled).toBe(false);
  });

  it('requests are validated against the OpenAPI document', async () => {
    const result = await call('call_api', {
      api_id: 'directory',
      operation_id: 'users.list',
      parameters: { query: { limit: 'not-an-integer' } },
    });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('PARAMETER_INVALID');
    expect(result.data.error.details.issues[0].path).toBe('query.limit');
  });

  it('scripts cannot reach the network, filesystem, environment or shell', async () => {
    const result = await call('run_api_code', {
      api_id: 'directory',
      code: `
        const probes = {};
        try { await Deno.readTextFile('/etc/passwd'); probes.fs = 'LEAK'; }
        catch (e) { probes.fs = e.name; }
        try { await fetch('http://169.254.169.254/'); probes.net = 'LEAK'; }
        catch (e) { probes.net = e.name; }
        try { probes.env = process.env.E2E_TOKEN ? 'LEAK' : 'empty'; }
        catch (e) { probes.env = e.name; }
        try { new Deno.Command('id').outputSync(); probes.shell = 'LEAK'; }
        catch (e) { probes.shell = e.name; }
        return probes;
      `,
    });
    expect(result.isError).toBe(false);
    expect(Object.values(result.data.result)).not.toContain('LEAK');
  });

  it('still exposes exactly six tools after all of that', async () => {
    const { tools } = await harness.client.listTools();
    expect(tools).toHaveLength(6);
  });
});
