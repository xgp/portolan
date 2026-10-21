/** Spectral linting (docs/DEVIATIONS.md D23). */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { lintDocument } from '../../src/openapi/lint.js';
import type { OpenApiDocument } from '../../src/openapi/types.js';
import { readSpec } from '../fixtures/helpers.js';

const petstore = () => parseYaml(readSpec('petstore-3.0.yaml')) as OpenApiDocument;

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('lintDocument', () => {
  it("reports Spectral's recommended OpenAPI findings with JSON Pointers", async () => {
    const findings = await lintDocument(petstore());
    expect(findings).toContainEqual({
      rule: 'operation-description',
      severity: 'warn',
      pointer: '/paths/~1pets/post',
      message: 'Operation "description" must be present and non-empty string.',
    });
  });

  it('orders findings most severe first', async () => {
    const document = petstore();
    document.paths!['/pets']!.get!.operationId = 'createPet';
    const findings = await lintDocument(document);
    expect(findings[0]).toMatchObject({ rule: 'operation-operationId-unique', severity: 'error' });
    const order = { error: 0, warn: 1, info: 2, hint: 3 };
    const ranks = findings.map((f) => order[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('applies configured rule overrides', async () => {
    const findings = await lintDocument(petstore(), {
      rules: { 'operation-description': 'off', 'info-contact': 'error' },
    });
    expect(findings.some((f) => f.rule === 'operation-description')).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'info-contact', severity: 'error' }),
    );
  });

  it('leaves the expensive example rules off unless configured', async () => {
    const document = petstore();
    document.components!.schemas!.Pet = {
      type: 'object',
      properties: { id: { type: 'integer' } },
      example: { id: 'not-a-number' },
    };
    const byDefault = await lintDocument(document);
    expect(byDefault.some((f) => f.rule === 'oas3-valid-schema-example')).toBe(false);
    const enabled = await lintDocument(document, {
      rules: { 'oas3-valid-schema-example': 'warn' },
    });
    expect(enabled.some((f) => f.rule === 'oas3-valid-schema-example')).toBe(true);
  });

  it('never fetches a remote or local reference itself', async () => {
    let requests = 0;
    server = createServer((_req, res) => {
      requests += 1;
      res.end('{"type":"string"}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/schema.json`;

    const document = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: 'file:///etc/passwd' } } },
              },
              '404': { $ref: url },
            },
          },
        },
      },
    } as unknown as OpenApiDocument;
    const findings = await lintDocument(document);
    expect(requests).toBe(0);
    expect(findings.filter((f) => f.rule === 'invalid-ref')).toHaveLength(2);
  });
});
