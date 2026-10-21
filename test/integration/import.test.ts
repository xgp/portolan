/** Import pipeline tests (SPEC.md §10, §13, §14, §43, §44, §45, §52). */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestCatalog, readSpec, type TestCatalog } from '../fixtures/helpers.js';
import { PortolanError } from '../../src/errors/errors.js';
import { inspectOperations } from '../../src/catalog/inspector.js';

let harness: TestCatalog | undefined;

function catalog(overrides: Record<string, unknown> = {}) {
  harness = createTestCatalog(overrides);
  return harness.catalog;
}

/** A minimal valid document that declares no servers entry. */
function noServersSpec(): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'No Servers', version: '1' },
    paths: { '/x': { get: { operationId: 'x', responses: { '200': { description: 'OK' } } } } },
  });
}

afterEach(() => {
  harness?.close();
  harness = undefined;
});

describe('add_api import pipeline', () => {
  it('imports OpenAPI 3.0 JSON', async () => {
    const result = await catalog().addApi({ specContent: readSpec('petstore-3.0.json') });
    expect(result.status).toBe('added');
    expect(result.api_id).toBe('petstore-api');
    expect(result.openapi_version).toBe('3.0.3');
    expect(result.api_version).toBe('1.2.3');
    expect(result.operations).toBe(5);
    expect(result.environments[0]).toMatchObject({
      name: 'default',
      base_url: 'https://petstore.example.com/api/v3',
      allow_mutations: false,
    });
  });

  it('imports OpenAPI 3.0 YAML', async () => {
    const result = await catalog().addApi({ specContent: readSpec('petstore-3.0.yaml') });
    expect(result.status).toBe('added');
    expect(result.api_id).toBe('petstore-yaml-api');
    expect(result.operations).toBe(5);
  });

  it('imports OpenAPI 3.1 YAML', async () => {
    const result = await catalog().addApi({ specContent: readSpec('petstore-3.1.yaml') });
    expect(result.openapi_version).toBe('3.1.0');
    expect(result.operations).toBe(2);
  });

  it('honours an explicit api_id, name, description, aliases and tags', async () => {
    const c = catalog();
    const result = await c.addApi({
      specContent: readSpec('petstore-3.0.json'),
      apiId: 'pets',
      name: 'Pets',
      description: 'Our pet service',
      aliases: ['animals'],
      tags: ['internal'],
    });
    expect(result.api_id).toBe('pets');
    const api = c.getApi('pets');
    expect(api.name).toBe('Pets');
    expect(api.aliases).toEqual(['animals']);
    expect(api.tags).toEqual(['internal']);
  });

  it('rejects an invalid api_id rather than silently rewriting it', async () => {
    await expect(
      catalog().addApi({ specContent: readSpec('petstore-3.0.json'), apiId: '../escape' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('requires exactly one of spec_url and spec_content', async () => {
    const c = catalog();
    await expect(c.addApi({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      c.addApi({ specUrl: 'https://x.example.com/s.json', specContent: '{}' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  // SPEC.md §16
  it('conflicts on a second import without replace, and versions with it', async () => {
    const c = catalog();
    await c.addApi({ specContent: readSpec('petstore-3.0.json'), apiId: 'pets' });
    await expect(
      c.addApi({ specContent: readSpec('petstore-3.1.yaml'), apiId: 'pets' }),
    ).rejects.toMatchObject({ code: 'API_ALREADY_EXISTS' });

    const replaced = await c.addApi({
      specContent: readSpec('petstore-3.1.yaml'),
      apiId: 'pets',
      replace: true,
    });
    expect(replaced.status).toBe('replaced');
    expect(c.getCurrentVersion('pets').openapiVersion).toBe('3.1.0');
  });

  // SPEC.md §43 — history is retained and only the current version is used.
  it('retains the previous version after a replace', async () => {
    const c = catalog();
    await c.addApi({ specContent: readSpec('petstore-3.0.json'), apiId: 'pets' });
    const firstVersion = c.getCurrentVersion('pets').id;
    await c.addApi({ specContent: readSpec('petstore-3.1.yaml'), apiId: 'pets', replace: true });
    const secondVersion = c.getCurrentVersion('pets').id;

    expect(secondVersion).not.toBe(firstVersion);
    expect(
      c
        .listOperations('pets')
        .map((o) => o.canonicalId)
        .sort(),
    ).toEqual(['listPets31', 'replacePet31']);
  });

  // SPEC.md §44
  it('returns "unchanged" for an identical replacement', async () => {
    const c = catalog();
    await c.addApi({ specContent: readSpec('petstore-3.0.json'), apiId: 'pets' });
    const again = await c.addApi({
      specContent: readSpec('petstore-3.0.json'),
      apiId: 'pets',
      replace: true,
    });
    expect(again.status).toBe('unchanged');
  });

  it('treats a reformatted but equivalent document as unchanged', async () => {
    const c = catalog();
    const original = readSpec('petstore-3.0.json');
    await c.addApi({ specContent: original, apiId: 'pets' });
    // Same document, different key order and whitespace.
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(original)).reverse()),
      null,
      4,
    );
    const again = await c.addApi({ specContent: reordered, apiId: 'pets', replace: true });
    expect(again.status).toBe('unchanged');
  });

  // SPEC.md §14
  it('synthesises identifiers when operationIds are missing', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('no-operation-ids.yaml') });
    expect(result.warnings.join(' ')).toMatch(/no operationId/);
    const ids = c
      .listOperations(result.api_id)
      .map((o) => o.canonicalId)
      .sort();
    expect(ids).toEqual(['delete:/widgets/{id}', 'get:/widgets', 'post:/widgets']);
  });

  it('falls back to method:path for duplicated operationIds and keeps unique ones', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('duplicate-operation-ids.yaml') });
    expect(result.warnings.join(' ')).toMatch(/Duplicate operationId/);
    const operations = c.listOperations(result.api_id);
    const ids = operations.map((o) => o.canonicalId).sort();
    expect(ids).toEqual(['get:/a', 'get:/b', 'uniqueThing']);
    // The original operationId is preserved separately.
    expect(operations.find((o) => o.path === '/a')?.sourceOperationId).toBe('getThing');
  });

  it('produces identical operation ids across repeated imports', async () => {
    const first = createTestCatalog();
    const second = createTestCatalog();
    try {
      const a = await first.catalog.addApi({
        specContent: readSpec('petstore-3.0.json'),
        apiId: 'p',
      });
      const b = await second.catalog.addApi({
        specContent: readSpec('petstore-3.0.json'),
        apiId: 'p',
      });
      expect(a.api_id).toBe(b.api_id);
      expect(first.catalog.listOperations('p').map((o) => o.id)).toEqual(
        second.catalog.listOperations('p').map((o) => o.id),
      );
    } finally {
      first.close();
      second.close();
    }
  });

  // SPEC.md §45
  it('imports a recursive schema without expanding it forever', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('recursive.yaml') });
    expect(result.operations).toBe(1);
    const spec = c.getSpecDocument(result.api_id) as any;
    // The recursive reference is retained rather than inlined.
    expect(spec.components.schemas.Node.properties.parent.$ref).toBe('#/components/schemas/Node');
  });

  it('merges path-item parameters into each operation', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('petstore-3.0.json') });
    const op = c.resolveOperation(result.api_id, 'getPet');
    const parsed = JSON.parse(op.operation.operationJson);
    expect(parsed.parameters.map((p: any) => p.name)).toContain('petId');
  });

  it('substitutes server variables and warns about extra servers', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('multiple-servers.yaml') });
    expect(result.environments[0]?.base_url).toBe('https://eu.api.example.com/v2');
    expect(result.warnings.join(' ')).toMatch(/declares 2 servers/);
  });

  it('warns when no usable server is declared', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: noServersSpec() });
    expect(result.warnings.join(' ')).toMatch(/no usable servers/);
    expect(result.environments).toEqual([]);
  });

  it('does not warn about servers when default_base_url is supplied', async () => {
    const c = catalog();
    const result = await c.addApi({
      specContent: noServersSpec(),
      defaultBaseUrl: 'https://api.example.com/v1',
    });
    expect(result.warnings.join(' ')).not.toMatch(/no usable servers/);
    expect(result.environments[0]?.base_url).toBe('https://api.example.com/v1');
  });

  it('binds default_base_url on re-import of an unchanged specification', async () => {
    const c = catalog();
    const first = await c.addApi({ specContent: noServersSpec() });
    expect(first.environments).toEqual([]);

    // Same bytes, so no new version is created — but the environment must still bind,
    // otherwise the remedy the warning recommends can never be applied.
    const second = await c.addApi({
      specContent: noServersSpec(),
      defaultBaseUrl: 'https://api.example.com/v1',
      replace: true,
    });
    expect(second.status).toBe('unchanged');
    expect(second.environments).toEqual([
      expect.objectContaining({
        name: 'default',
        base_url: 'https://api.example.com/v1',
        allow_mutations: false,
        source: 'add_api',
      }),
    ]);
  });

  // The pre-flight check covers scheme, embedded credentials and allowed_hosts; address
  // classification happens at connect time (see test/security/ssrf-spec-fetch.test.ts).
  // This asserts the pre-flight still runs on the short-circuited path.
  it('pre-flights default_base_url on an unchanged re-import', async () => {
    const c = catalog();
    await c.addApi({ specContent: noServersSpec() });
    await expect(
      c.addApi({
        specContent: noServersSpec(),
        defaultBaseUrl: 'ftp://files.example.com/v1',
        replace: true,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });

  it('records security schemes in the stored document', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('security-schemes.yaml') });
    const spec = c.getSpecDocument(result.api_id) as any;
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual([
      'apiKeyAuth',
      'basicAuth',
      'bearerAuth',
      'oauth2',
    ]);
  });

  it('rejects an invalid OpenAPI document', async () => {
    await expect(catalog().addApi({ specContent: readSpec('invalid.yaml') })).rejects.toMatchObject(
      {
        code: 'SPEC_INVALID',
      },
    );
  });

  it('rejects Swagger 2.0 with an actionable message', async () => {
    await expect(catalog().addApi({ specContent: readSpec('not-openapi.yaml') })).rejects.toThrow(
      /Swagger 2\.0 documents are not supported/,
    );
  });

  it('rejects text that is neither JSON nor YAML', async () => {
    await expect(catalog().addApi({ specContent: ': : not valid : :' })).rejects.toMatchObject({
      code: 'SPEC_INVALID',
    });
  });

  it('rejects a specification larger than max_spec_bytes', async () => {
    const c = catalog({ limits: { max_spec_bytes: 500 } });
    await expect(c.addApi({ specContent: readSpec('petstore-3.0.json') })).rejects.toMatchObject({
      code: 'SPEC_TOO_LARGE',
    });
  });

  it('leaves the current version untouched when a replacement fails', async () => {
    const c = catalog();
    await c.addApi({ specContent: readSpec('petstore-3.0.json'), apiId: 'pets' });
    const before = c.getCurrentVersion('pets').id;
    await expect(
      c.addApi({ specContent: readSpec('invalid.yaml'), apiId: 'pets', replace: true }),
    ).rejects.toBeInstanceOf(PortolanError);
    expect(c.getCurrentVersion('pets').id).toBe(before);
    expect(c.listOperations('pets')).toHaveLength(5);
  });

  // docs/DEVIATIONS.md D5
  it('refuses to bind a credential profile through add_api by default', async () => {
    const c = catalog({
      auth_profiles: { creds: { type: 'bearer', token_env: 'TOKEN' } },
    });
    await expect(
      c.addApi({
        specContent: readSpec('petstore-3.0.json'),
        defaultBaseUrl: 'https://attacker.example.com',
        authProfile: 'creds',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROFILE_BINDING_NOT_ALLOWED' });
  });

  it('permits the binding only when an operator opts in, and only to a known profile', async () => {
    const c = catalog({
      security: { allow_agent_auth_profile_binding: true },
      auth_profiles: { creds: { type: 'bearer', token_env: 'TOKEN' } },
    });
    await expect(
      c.addApi({ specContent: readSpec('petstore-3.0.json'), apiId: 'a', authProfile: 'nope' }),
    ).rejects.toMatchObject({ code: 'AUTH_PROFILE_NOT_FOUND' });

    const ok = await c.addApi({
      specContent: readSpec('petstore-3.0.json'),
      apiId: 'b',
      authProfile: 'creds',
    });
    expect(ok.status).toBe('added');
  });

  // docs/DEVIATIONS.md D6
  it('never grants mutation rights from an imported specification', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('petstore-3.0.json') });
    expect(result.environments.every((e) => e.allow_mutations === false)).toBe(true);
  });

  it('does not let a re-import overwrite a configured environment', async () => {
    const harness2 = createTestCatalog({
      environments: [
        {
          api: 'pets',
          name: 'default',
          base_url: 'https://configured.example.com',
          allow_mutations: true,
        },
      ],
    });
    try {
      await harness2.catalog.addApi({ specContent: readSpec('petstore-3.0.json'), apiId: 'pets' });
      harness2.catalog.syncConfiguredEnvironments();
      const replaced = await harness2.catalog.addApi({
        specContent: readSpec('petstore-3.1.yaml'),
        apiId: 'pets',
        replace: true,
      });
      const env = replaced.environments.find((e) => e.name === 'default');
      expect(env?.base_url).toBe('https://configured.example.com');
      expect(env?.allow_mutations).toBe(true);
    } finally {
      harness2.close();
    }
  });

  it('refuses a default_base_url the network policy would block', async () => {
    const c = catalog({ network: { allow_loopback: false, allow_http: false } });
    await expect(
      c.addApi({ specContent: readSpec('petstore-3.0.json'), defaultBaseUrl: 'http://10.0.0.1' }),
    ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
  });
});

describe('linting during add_api (docs/DEVIATIONS.md D23)', () => {
  it('reports counts and the most severe findings for the new version', async () => {
    const result = await catalog().addApi({ specContent: readSpec('petstore-3.0.yaml') });
    expect(result.lint).toMatchObject({ errors: 0, warnings: 5, info: 0, hints: 0 });
    expect(result.lint!.findings).toContainEqual({
      rule: 'operation-description',
      severity: 'warn',
      pointer: '/paths/~1pets/post',
      message: 'Operation "description" must be present and non-empty string.',
    });
    // No enricher is attached to a bare catalog.
    expect(result.enrichment).toBeUndefined();
  });

  it('keeps the findings of a version it reuses rather than linting again', async () => {
    const c = catalog();
    const first = await c.addApi({ specContent: readSpec('petstore-3.0.yaml'), apiId: 'pets' });
    const again = await c.addApi({
      specContent: readSpec('petstore-3.0.yaml'),
      apiId: 'pets',
      replace: true,
    });
    expect(again.status).toBe('unchanged');
    expect(again.lint).toEqual(first.lint);
  });

  it("shows an operation's errors and warnings in inspect_api", async () => {
    const c = catalog();
    await c.addApi({ specContent: readSpec('petstore-3.0.yaml'), apiId: 'pets' });
    const [operation] = inspectOperations(c, 'pets', ['createPet']).operations;
    expect(operation!.lint).toEqual([
      expect.objectContaining({ rule: 'operation-description', pointer: '/paths/~1pets/post' }),
    ]);
  });

  it('can be switched off, or have rules overridden', async () => {
    const off = await catalog({ lint: { enabled: false } }).addApi({
      specContent: readSpec('petstore-3.0.yaml'),
    });
    expect(off.lint).toBeUndefined();
    harness?.close();

    const tuned = await catalog({ lint: { rules: { 'operation-description': 'off' } } }).addApi({
      specContent: readSpec('petstore-3.0.yaml'),
    });
    expect(tuned.lint!.warnings).toBe(1);
  });
});
