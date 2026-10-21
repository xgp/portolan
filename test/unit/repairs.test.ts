/** Automatic repair of structural flaws (docs/DEVIATIONS.md D21). */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { getAtPointer } from '../../src/openapi/json-patch.js';
import { validateOpenApi } from '../../src/openapi/parser.js';
import { repairDocument, UNSPECIFIED_VERSION } from '../../src/openapi/repairs.js';
import type { OpenApiDocument } from '../../src/openapi/types.js';
import { readSpec } from '../fixtures/helpers.js';

const repairable = () => parseYaml(readSpec('repairable.yaml')) as OpenApiDocument;

describe('repairDocument', () => {
  it('turns a document the validator rejects into one it accepts', async () => {
    await expect(validateOpenApi(repairable())).rejects.toMatchObject({ code: 'SPEC_INVALID' });
    const { document, repairs } = repairDocument(repairable());
    await expect(validateOpenApi(document)).resolves.toBeDefined();
    expect(repairs.map((r) => r.kind).sort()).toEqual([
      'info-version-missing',
      'path-parameter-not-required',
      'path-parameter-orphaned',
      'path-parameter-renamed',
      'path-parameter-undeclared',
      'responses-missing',
    ]);
  });

  it('declares an undeclared path variable as a required string', () => {
    const { document } = repairDocument(repairable());
    expect(getAtPointer(document, '/paths/~1users~1{id}/get/parameters')).toEqual([
      expect.objectContaining({
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }),
    ]);
  });

  it('renames a single misspelt declaration instead of deleting and inventing one', () => {
    const { document } = repairDocument(repairable());
    const params = getAtPointer(document, '/paths/~1groups~1{groupId}/parameters') as unknown[];
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ name: 'groupId', in: 'path', required: true });
  });

  it('fixes a shared $ref parameter once, at its definition', () => {
    const { document, repairs } = repairDocument(repairable());
    expect(getAtPointer(document, '/components/parameters/TeamId/required')).toBe(true);
    expect(repairs.filter((r) => r.kind === 'path-parameter-not-required')).toHaveLength(1);
    expect(getAtPointer(document, '/paths/~1teams~1{teamId}/get/parameters/0')).toEqual({
      $ref: '#/components/parameters/TeamId',
    });
  });

  it('removes an orphaned path parameter, and adds missing 3.0 responses and info.version', () => {
    const { document } = repairDocument(repairable());
    const params = getAtPointer(document, '/paths/~1teams~1{teamId}/get/parameters') as unknown[];
    expect(params).toHaveLength(1);
    expect(getAtPointer(document, '/paths/~1teams~1{teamId}/get/responses')).toHaveProperty(
      'default',
    );
    expect(getAtPointer(document, '/info/version')).toBe(UNSPECIFIED_VERSION);
  });

  it('records each repair as a patch that reproduces it from the original', () => {
    const { repairs } = repairDocument(repairable());
    for (const repair of repairs) {
      expect(repair.patch.length).toBeGreaterThan(0);
      expect(repair.title).not.toBe('');
    }
  });

  it('is idempotent and leaves its input alone', () => {
    const input = repairable();
    const before = JSON.stringify(input);
    const once = repairDocument(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(repairDocument(once.document).repairs).toEqual([]);
  });

  it('does not require responses in OpenAPI 3.1', () => {
    const { repairs } = repairDocument({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: { '/x': { get: {} } },
    });
    expect(repairs).toEqual([]);
  });

  it('changes nothing in a valid document', () => {
    const document = parseYaml(readSpec('petstore-3.0.yaml')) as OpenApiDocument;
    expect(repairDocument(document).repairs).toEqual([]);
  });
});
