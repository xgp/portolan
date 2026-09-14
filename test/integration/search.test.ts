/** Search and inspection (SPEC.md §17, §18, §19, §46, §47). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCatalog, readSpec, type TestCatalog } from '../fixtures/helpers.js';
import { FtsSearchProvider } from '../../src/search/fts-search-provider.js';
import { inspectOperations } from '../../src/catalog/inspector.js';
import { openDatabase } from '../../src/storage/database.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { createSilentLogger } from '../../src/logging.js';
import { testConfig } from '../fixtures/helpers.js';

let harness: TestCatalog;
let search: FtsSearchProvider;
let catalog: Catalog;

beforeAll(async () => {
  const config = testConfig();
  const db = openDatabase({ path: ':memory:' });
  catalog = new Catalog(db, config, createSilentLogger());
  search = new FtsSearchProvider(db);
  harness = { catalog, config, close: () => db.close() };

  await catalog.addApi({ specContent: readSpec('keycloak-subset.yaml'), apiId: 'keycloak' });
  await catalog.addApi({ specContent: readSpec('sendgrid-subset.yaml'), apiId: 'sendgrid' });
  await catalog.addApi({ specContent: readSpec('stripe-subset.yaml'), apiId: 'stripe' });
  await catalog.addApi({ specContent: readSpec('users-api.yaml'), apiId: 'directory' });
});

afterAll(() => harness.close());

/** Position of an operation in a result list, or -1. */
function rank(results: { operation_id: string }[], id: string): number {
  return results.findIndex((r) => r.operation_id === id);
}

describe('find_api (SPEC.md §17)', () => {
  it('finds the right service from a capability description', async () => {
    const results = await search.searchApis('manage Keycloak users and realms', 5);
    expect(results[0]?.api_id).toBe('keycloak');
  });

  it('finds an email service from a task description', async () => {
    const results = await search.searchApis('email suppression list and bounces', 5);
    expect(results[0]?.api_id).toBe('sendgrid');
    expect(results[0]?.matched).toEqual(expect.arrayContaining(['suppression', 'email']));
  });

  it('finds a billing service', async () => {
    const results = await search.searchApis('overdue subscriptions and invoices', 5);
    expect(results[0]?.api_id).toBe('stripe');
  });

  it('ranks a user-management API first for "user management"', async () => {
    const results = await search.searchApis('user management', 5);
    expect(['keycloak', 'directory']).toContain(results[0]?.api_id);
  });

  it('returns compact results without operations or schemas', async () => {
    const results = await search.searchApis('users', 5);
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual([
        'api_id',
        'description',
        'matched',
        'name',
        'score',
      ]);
    }
  });

  it('respects the limit and produces scores in (0,1]', async () => {
    const results = await search.searchApis('api', 2);
    expect(results.length).toBeLessThanOrEqual(2);
    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('returns nothing rather than throwing for an unmatchable query', async () => {
    expect(await search.searchApis('zzzzqqqxyzzy', 5)).toEqual([]);
  });

  it('does not fail on FTS5 query syntax in the query string', async () => {
    for (const query of ['"', 'user" OR x', 'NEAR/2(a b)', 'a AND NOT b', '((']) {
      await expect(search.searchApis(query, 5)).resolves.toBeInstanceOf(Array);
    }
  });
});

describe('search_api ranking (SPEC.md §47)', () => {
  it('ranks user update above delete, sessions and client update for "disable user"', async () => {
    const results = await search.searchOperations('keycloak', 'disable a user', 10);
    const update = rank(results, 'UsersResource_updateUser');
    expect(update).toBeGreaterThanOrEqual(0);
    for (const other of [
      'UsersResource_deleteUser',
      'UsersResource_getSessions',
      'ClientsResource_updateClient',
    ]) {
      const position = rank(results, other);
      expect(position === -1 || update < position, `${other} outranked the update operation`).toBe(
        true,
      );
    }
  });

  it('favours identity-provider operations for "identity provider certificate"', async () => {
    const results = await search.searchOperations('keycloak', 'identity provider certificate', 5);
    expect(results[0]?.operation_id).toMatch(/IdentityProvidersResource/);
  });

  it('favours user search for "find user by email"', async () => {
    const results = await search.searchOperations('keycloak', 'find user by email', 5);
    expect(results[0]?.operation_id).toBe('UsersResource_getUsers');
  });

  it('favours the list operation for "find user by email" in the directory API', async () => {
    const results = await search.searchOperations('directory', 'find user by email', 5);
    expect(results[0]?.operation_id).toBe('users.list');
  });

  it('favours the update operation for "disable a user account" in the directory API', async () => {
    const results = await search.searchOperations('directory', 'disable a user account', 5);
    expect(results[0]?.operation_id).toBe('users.update');
  });

  it('returns compact results without schemas (SPEC.md §3.4)', async () => {
    const results = await search.searchOperations('keycloak', 'users', 5);
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual([
        'deprecated',
        'method',
        'operation_id',
        'path',
        'score',
        'summary',
        'tags',
      ]);
    }
  });

  it('filters by method', async () => {
    const results = await search.searchOperations('keycloak', 'user', 20, { methods: ['PUT'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.method === 'PUT')).toBe(true);
  });

  it('filters by tag', async () => {
    const results = await search.searchOperations('keycloak', 'get', 20, {
      tags: ['Identity Providers'],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tags.includes('Identity Providers'))).toBe(true);
  });

  it('does not leak operations from another API', async () => {
    const results = await search.searchOperations('sendgrid', 'user', 20);
    expect(results.every((r) => !r.operation_id.startsWith('UsersResource'))).toBe(true);
  });

  // SPEC.md §43: historical versions are retained but never searched.
  it('only searches the current version', async () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      const local = new Catalog(db, testConfig(), createSilentLogger());
      const provider = new FtsSearchProvider(db);
      await local.addApi({ specContent: readSpec('keycloak-subset.yaml'), apiId: 'k' });
      expect(await provider.searchOperations('k', 'update the user', 5)).not.toHaveLength(0);

      await local.addApi({
        specContent: readSpec('sendgrid-subset.yaml'),
        apiId: 'k',
        replace: true,
      });
      // The Keycloak operations still exist as a historical version but must not surface.
      const stale = await provider.searchOperations('k', 'update the user', 10);
      expect(stale.map((r) => r.operation_id)).not.toContain('UsersResource_updateUser');
      const current = await provider.searchOperations('k', 'send an email', 10);
      expect(current.map((r) => r.operation_id)).toContain('sendMail');
    } finally {
      db.close();
    }
  });

  it('ranks a deprecated operation below its live siblings', async () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      const local = new Catalog(db, testConfig(), createSilentLogger());
      await local.addApi({ specContent: readSpec('petstore-3.0.json'), apiId: 'pets' });
      const provider = new FtsSearchProvider(db);
      const results = await provider.searchOperations('pets', 'pet', 10);
      const deprecatedIndex = results.findIndex((r) => r.deprecated);
      expect(deprecatedIndex).toBeGreaterThan(0);
      expect(results.slice(0, deprecatedIndex).every((r) => !r.deprecated)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('inspect_api (SPEC.md §19)', () => {
  it('returns full parameter, body, response and security detail', () => {
    const result = inspectOperations(catalog, 'keycloak', ['UsersResource_updateUser']);
    const op = result.operations[0]!;
    expect(op.operation_id).toBe('UsersResource_updateUser');
    expect(op.method).toBe('PUT');
    expect(op.path).toBe('/admin/realms/{realm}/users/{user-id}');
    expect(op.parameters.path?.map((p) => p.name).sort()).toEqual(['realm', 'user-id']);
    expect(op.parameters.path?.every((p) => p.required)).toBe(true);
    expect(op.request_body?.content['application/json']?.schema).toBeDefined();
    expect(Object.keys(op.responses)).toContain('204');
  });

  it('marks query parameters as optional unless declared required', () => {
    const result = inspectOperations(catalog, 'keycloak', ['UsersResource_getUsers']);
    const query = result.operations[0]!.parameters.query!;
    expect(query.find((p) => p.name === 'email')?.required).toBe(false);
    expect(query.find((p) => p.name === 'email')?.description).toMatch(/email/i);
  });

  it('includes only the component schemas the operation actually references', () => {
    const result = inspectOperations(catalog, 'directory', ['users.update']);
    expect(Object.keys(result.components!.schemas)).toEqual(['User']);
    // Group is referenced by a different operation and must not appear.
    expect(result.components!.schemas).not.toHaveProperty('Group');
  });

  it('follows nested references transitively', async () => {
    const c = createTestCatalog();
    try {
      await c.catalog.addApi({
        specContent: JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'Nested', version: '1' },
          servers: [{ url: 'https://nested.example.com' }],
          paths: {
            '/a': {
              get: {
                operationId: 'a',
                responses: {
                  '200': {
                    description: 'OK',
                    content: {
                      'application/json': { schema: { $ref: '#/components/schemas/Outer' } },
                    },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              Outer: {
                type: 'object',
                properties: { inner: { $ref: '#/components/schemas/Inner' } },
              },
              Inner: {
                type: 'object',
                properties: { leaf: { $ref: '#/components/schemas/Leaf' } },
              },
              Leaf: { type: 'string' },
              Unrelated: { type: 'string' },
            },
          },
        }),
        apiId: 'nested',
      });
      const result = inspectOperations(c.catalog, 'nested', ['a']);
      expect(Object.keys(result.components!.schemas).sort()).toEqual(['Inner', 'Leaf', 'Outer']);
      // The unreferenced schema must not be returned (SPEC.md §19).
      expect(result.components!.schemas).not.toHaveProperty('Unrelated');
    } finally {
      c.close();
    }
  });

  it('terminates on a recursive schema', async () => {
    const c = createTestCatalog();
    try {
      await c.catalog.addApi({ specContent: readSpec('recursive.yaml'), apiId: 'tree' });
      const result = inspectOperations(c.catalog, 'tree', ['listNodes']);
      expect(Object.keys(result.components!.schemas)).toEqual(['Node']);
    } finally {
      c.close();
    }
  });

  it('reports unknown operations instead of failing the whole call', () => {
    const result = inspectOperations(catalog, 'keycloak', ['UsersResource_getUser', 'nope']);
    expect(result.operations).toHaveLength(1);
    expect(result.not_found).toEqual(['nope']);
  });

  it('rejects more than ten operations per call', () => {
    expect(() =>
      inspectOperations(
        catalog,
        'keycloak',
        Array.from({ length: 11 }, (_, i) => `op${i}`),
      ),
    ).toThrow(/at most 10 operations/);
  });

  it('rejects an empty operation list', () => {
    expect(() => inspectOperations(catalog, 'keycloak', [])).toThrow(/at least one operation_id/);
  });

  it('reports the document-level security requirement when the operation has none', async () => {
    const c = createTestCatalog();
    try {
      await c.catalog.addApi({ specContent: readSpec('security-schemes.yaml'), apiId: 'secured' });
      const result = inspectOperations(c.catalog, 'secured', ['getMe', 'getAdmin']);
      expect(result.operations[0]?.security).toEqual([{ bearerAuth: [] }]);
      expect(result.operations[1]?.security).toEqual([{ oauth2: ['admin'] }]);
    } finally {
      c.close();
    }
  });
});
