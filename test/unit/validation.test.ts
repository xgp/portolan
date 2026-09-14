/** Request validation and OpenAPI schema normalization (SPEC.md §23). */
import { describe, expect, it } from 'vitest';
import {
  SchemaValidator,
  openApi30ToJsonSchema,
  validateParameters,
  validateRequestBody,
} from '../../src/openapi/validation.js';
import { PortolanError } from '../../src/errors/errors.js';

describe('OpenAPI 3.0 to JSON Schema conversion', () => {
  it('turns nullable into a type union', () => {
    expect(openApi30ToJsonSchema({ type: 'string', nullable: true })).toEqual({
      type: ['string', 'null'],
    });
  });

  it('leaves a non-nullable schema alone', () => {
    expect(openApi30ToJsonSchema({ type: 'string' })).toEqual({ type: 'string' });
  });

  it('converts boolean exclusiveMinimum/Maximum to the draft-07 numeric form', () => {
    expect(openApi30ToJsonSchema({ type: 'number', minimum: 5, exclusiveMinimum: true })).toEqual({
      type: 'number',
      exclusiveMinimum: 5,
    });
    expect(openApi30ToJsonSchema({ type: 'number', maximum: 9, exclusiveMaximum: true })).toEqual({
      type: 'number',
      exclusiveMaximum: 9,
    });
  });

  it('keeps minimum when exclusiveMinimum is false', () => {
    expect(openApi30ToJsonSchema({ type: 'number', minimum: 5, exclusiveMinimum: false })).toEqual({
      type: 'number',
      minimum: 5,
    });
  });

  it('strips annotation-only keywords', () => {
    expect(
      openApi30ToJsonSchema({
        type: 'object',
        example: { a: 1 },
        xml: { name: 'x' },
        discriminator: { propertyName: 'k' },
        externalDocs: { url: 'https://x' },
        deprecated: true,
      }),
    ).toEqual({ type: 'object' });
  });

  it('makes a nullable $ref permit null without losing the reference', () => {
    expect(openApi30ToJsonSchema({ $ref: '#/components/schemas/X', nullable: true })).toEqual({
      anyOf: [{ $ref: '#/components/schemas/X' }, { type: 'null' }],
    });
  });

  it('terminates on a recursive schema', () => {
    const node: Record<string, unknown> = { type: 'object' };
    node.properties = { child: node };
    expect(() => openApi30ToJsonSchema(node)).not.toThrow();
  });
});

describe('SchemaValidator', () => {
  const components = {
    User: {
      type: 'object',
      required: ['id', 'email'],
      properties: {
        id: { type: 'string' },
        email: { type: 'string', format: 'email' },
        manager: { $ref: '#/components/schemas/User', nullable: true },
      },
    },
  };

  it('validates against a component reference', () => {
    const validator = new SchemaValidator('3.0', components);
    const schema = { $ref: '#/components/schemas/User' };
    expect(validator.validate(schema, { id: '1', email: 'a@b.com' }, 'k1')).toEqual([]);
    const issues = validator.validate(schema, { id: '1' }, 'k1');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/required property 'email'/);
  });

  it('resolves a recursive component reference', () => {
    const validator = new SchemaValidator('3.0', components);
    const schema = { $ref: '#/components/schemas/User' };
    expect(
      validator.validate(
        schema,
        { id: '1', email: 'a@b.com', manager: { id: '2', email: 'c@d.com' } },
        'k2',
      ),
    ).toEqual([]);
    expect(validator.validate(schema, { id: '1', email: 'a@b.com', manager: null }, 'k2')).toEqual(
      [],
    );
  });

  it('validates enums and types', () => {
    const validator = new SchemaValidator('3.0');
    expect(validator.validate({ type: 'string', enum: ['a', 'b'] }, 'c', 'k3')).not.toHaveLength(0);
    expect(validator.validate({ type: 'integer' }, 'nope', 'k4')).not.toHaveLength(0);
    expect(
      validator.validate({ type: 'array', items: { type: 'number' } }, [1, 'x'], 'k5'),
    ).not.toHaveLength(0);
  });

  it('accepts a 3.1 type union', () => {
    const validator = new SchemaValidator('3.1');
    const schema = { type: ['string', 'null'] };
    expect(validator.validate(schema, null, 'k6')).toEqual([]);
    expect(validator.validate(schema, 'x', 'k6')).toEqual([]);
    expect(validator.validate(schema, 5, 'k6')).not.toHaveLength(0);
  });

  it('does not reject a schema carrying vendor extensions', () => {
    const validator = new SchemaValidator('3.0');
    expect(validator.validate({ type: 'string', 'x-vendor-thing': { a: 1 } }, 'ok', 'k7')).toEqual(
      [],
    );
  });

  // The remote API is the authority; an uncompilable schema must not block the call.
  it('lets a request through when the schema cannot be compiled', () => {
    const validator = new SchemaValidator('3.0');
    expect(validator.validate({ type: 'not-a-real-type', $ref: 4 }, 'anything', 'k8')).toEqual([]);
  });
});

describe('parameter validation', () => {
  const validator = new SchemaValidator('3.0');
  const parameters = [
    { name: 'realm', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } },
  ];

  it('accepts a valid parameter set', () => {
    const result = validateParameters({
      parameters,
      supplied: { path: { realm: 'master' }, query: { limit: 5 } },
      validator,
      operationId: 'op',
    });
    expect(result.values.path.get('realm')).toBe('master');
    expect(result.values.query.get('limit')).toBe(5);
    expect(result.unknown).toEqual([]);
  });

  it('reports a missing required parameter with enough detail to fix it', () => {
    try {
      validateParameters({ parameters, supplied: {}, validator, operationId: 'op' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PortolanError);
      const e = error as PortolanError;
      expect(e.code).toBe('PARAMETER_REQUIRED');
      expect(e.details.parameter).toBe('realm');
      expect(e.details.in).toBe('path');
      expect(e.details.expected_schema).toEqual({ type: 'string' });
    }
  });

  it('treats a path parameter as required even without required: true', () => {
    expect(() =>
      validateParameters({
        parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
        supplied: {},
        validator,
        operationId: 'op',
      }),
    ).toThrow(/is required/);
  });

  it('reports the parameter name, location, expectation and received value', () => {
    try {
      validateParameters({
        parameters,
        supplied: { path: { realm: 'm' }, query: { status: 'zzz' } },
        validator,
        operationId: 'op',
      });
      expect.unreachable();
    } catch (error) {
      const e = error as PortolanError;
      expect(e.code).toBe('PARAMETER_INVALID');
      const issues = e.details.issues as any[];
      expect(issues[0].path).toBe('query.status');
      expect(issues[0].received).toBe('zzz');
      expect(issues[0].expected).toBeDefined();
    }
  });

  it('reports parameters the operation does not declare rather than sending them', () => {
    const result = validateParameters({
      parameters,
      supplied: { path: { realm: 'm' }, query: { nope: 1 } },
      validator,
      operationId: 'op',
    });
    expect(result.unknown).toEqual([{ name: 'nope', in: 'query' }]);
    expect(result.values.query.has('nope')).toBe(false);
  });

  it('rejects an undefined style/explode combination before serializing', () => {
    expect(() =>
      validateParameters({
        parameters: [
          { name: 'p', in: 'query', style: 'spaceDelimited', explode: true, schema: {} },
        ],
        supplied: { query: { p: ['a'] } },
        validator,
        operationId: 'op',
      }),
    ).toThrow(/undefined/);
  });
});

describe('request body validation', () => {
  const validator = new SchemaValidator('3.0');
  const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

  it('accepts a valid body', () => {
    expect(() =>
      validateRequestBody(schema, { name: 'x' }, validator, 'op', 'application/json'),
    ).not.toThrow();
  });

  it('rejects a body missing a required property', () => {
    try {
      validateRequestBody(schema, {}, validator, 'op', 'application/json');
      expect.unreachable();
    } catch (error) {
      const e = error as PortolanError;
      expect(e.code).toBe('REQUEST_BODY_INVALID');
      expect(e.details.content_type).toBe('application/json');
      expect(String(e.message)).toMatch(/required property 'name'/);
    }
  });
});
