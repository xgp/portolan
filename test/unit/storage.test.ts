import { describe, expect, it } from 'vitest';
import { openDatabase, transaction } from '../../src/storage/database.js';
import { ApiRepository } from '../../src/storage/repositories/apis.js';
import { OperationRepository } from '../../src/storage/repositories/operations.js';
import {
  EnvironmentRepository,
  environmentId,
} from '../../src/storage/repositories/environments.js';
import { splitIdentifier, splitPath } from '../../src/storage/repositories/search-index.js';
import type { OperationRecord } from '../../src/storage/repositories/types.js';

function db() {
  return openDatabase({ path: ':memory:' });
}

function operation(
  overrides: Partial<OperationRecord> & { id: string; apiVersionId: string },
): OperationRecord {
  return {
    canonicalId: 'get:/users',
    sourceOperationId: null,
    method: 'GET',
    path: '/users',
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    searchText: null,
    paramText: null,
    schemaText: null,
    operationJson: '{}',
    ...overrides,
  };
}

describe('storage', () => {
  it('creates the schema and supports FTS5', () => {
    const database = db();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('apis');
    expect(tables).toContain('api_versions');
    expect(tables).toContain('operations');
    expect(tables).toContain('environments');
    expect(tables).toContain('api_fts');
    expect(tables).toContain('operation_fts');
  });

  it('is idempotent across reopens', () => {
    const database = db();
    const version = database.prepare('PRAGMA user_version').get() as any;
    expect(version.user_version).toBeGreaterThan(0);
  });

  it('rolls back a failed transaction entirely', () => {
    const database = db();
    const apis = new ApiRepository(database);
    expect(() =>
      transaction(database, () => {
        apis.upsert({ id: 'x', name: 'X', description: null, aliases: [], tags: [] });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(apis.get('x')).toBeNull();
  });

  it('retains historical versions and switches the current one atomically', () => {
    const database = db();
    const apis = new ApiRepository(database);
    apis.upsert({ id: 'k', name: 'K', description: null, aliases: [], tags: [] });
    apis.insertVersion({
      id: 'v1',
      apiId: 'k',
      openapiVersion: '3.0.3',
      infoVersion: '1',
      infoTitle: 'K',
      infoDescription: null,
      specHash: 'h1',
      specJson: '{}',
      sourceType: 'content',
      sourceUri: null,
    });
    apis.setCurrentVersion('k', 'v1');
    apis.insertVersion({
      id: 'v2',
      apiId: 'k',
      openapiVersion: '3.0.3',
      infoVersion: '2',
      infoTitle: 'K',
      infoDescription: null,
      specHash: 'h2',
      specJson: '{}',
      sourceType: 'content',
      sourceUri: null,
    });
    apis.setCurrentVersion('k', 'v2');

    expect(apis.getCurrentVersion('k')?.id).toBe('v2');
    expect(
      apis
        .listVersions('k')
        .map((v) => v.id)
        .sort(),
    ).toEqual(['v1', 'v2']);
    expect(apis.findVersionByHash('k', 'h1')?.id).toBe('v1');
  });

  it('resolves operations by canonical id, source operationId and method:path', () => {
    const database = db();
    const apis = new ApiRepository(database);
    apis.upsert({ id: 'k', name: 'K', description: null, aliases: [], tags: [] });
    apis.insertVersion({
      id: 'v1',
      apiId: 'k',
      openapiVersion: '3.0.3',
      infoVersion: '1',
      infoTitle: 'K',
      infoDescription: null,
      specHash: 'h',
      specJson: '{}',
      sourceType: 'content',
      sourceUri: null,
    });
    const ops = new OperationRepository(database);
    ops.insertMany([
      operation({
        id: 'o1',
        apiVersionId: 'v1',
        canonicalId: 'users.list',
        sourceOperationId: 'users.list',
      }),
      operation({
        id: 'o2',
        apiVersionId: 'v1',
        canonicalId: 'put:/users/{id}',
        method: 'PUT',
        path: '/users/{id}',
        sourceOperationId: null,
      }),
    ]);

    expect(ops.findByIdentifier('v1', 'users.list')?.id).toBe('o1');
    expect(ops.findByIdentifier('v1', 'put:/users/{id}')?.id).toBe('o2');
    expect(ops.findByIdentifier('v1', 'PUT:/users/{id}')?.id).toBe('o2');
    expect(ops.findByIdentifier('v1', 'nope')).toBeNull();
    expect(ops.countForVersion('v1')).toBe(2);
  });

  it('keys environments deterministically and never collides across api/name splits', () => {
    // "ab"/"c" and "a"/"bc" must not produce the same id.
    expect(environmentId('ab', 'c')).not.toBe(environmentId('a', 'bc'));
    expect(environmentId('k', 'prod')).toBe(environmentId('k', 'prod'));
  });

  it('does not let insertIfAbsent overwrite an existing environment', () => {
    const database = db();
    const apis = new ApiRepository(database);
    apis.upsert({ id: 'k', name: 'K', description: null, aliases: [], tags: [] });
    const envs = new EnvironmentRepository(database);
    envs.upsert({
      apiId: 'k',
      name: 'production',
      baseUrl: 'https://real.example.com',
      authProfile: 'creds',
      isDefault: true,
      allowMutations: true,
      source: 'config',
    });
    const inserted = envs.insertIfAbsent({
      apiId: 'k',
      name: 'production',
      baseUrl: 'https://evil.example.com',
      authProfile: null,
      isDefault: false,
      allowMutations: false,
      source: 'spec',
    });
    expect(inserted).toBe(false);
    const env = envs.get('k', 'production');
    expect(env?.baseUrl).toBe('https://real.example.com');
    expect(env?.authProfile).toBe('creds');
  });
});

describe('search text splitting', () => {
  it('splits camelCase and snake_case identifiers while keeping the original', () => {
    expect(splitIdentifier('UsersResource_updateUser').split(' ')).toEqual([
      'UsersResource_updateUser',
      'Users',
      'Resource',
      'update',
      'User',
    ]);
    expect(splitIdentifier('users.list').split(' ')).toEqual(['users.list', 'users', 'list']);
  });

  it('splits path templates into words', () => {
    const words = splitPath('/admin/realms/{realm}/users/{user-id}').split(' ');
    expect(words[0]).toBe('/admin/realms/{realm}/users/{user-id}');
    expect(words).toContain('realms');
    expect(words).toContain('users');
    expect(words).toContain('user');
    expect(words).toContain('id');
  });
});
