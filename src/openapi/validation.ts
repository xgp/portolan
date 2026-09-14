/**
 * Request validation (SPEC.md §23).
 *
 * OpenAPI 3.0 schemas are *not* JSON Schema: `nullable` has no JSON Schema meaning, and
 * `exclusiveMinimum`/`exclusiveMaximum` are booleans rather than numbers. 3.1 schemas are
 * JSON Schema 2020-12. Both are normalized before AJV sees them so that valid OpenAPI is
 * not rejected merely because JSON Schema reads a keyword differently.
 *
 * Both AJV instances run with `strict: false`: vendor extensions and annotation keywords
 * should annotate, not fail a request the remote API would happily accept.
 */
// AJV 8 is CommonJS. Its named class exports work under NodeNext ESM; `ajv-formats`
// only has a default export, which the interop layer resolves to the plugin function.
import { Ajv, type AnySchema, type ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
import { PortolanError } from '../errors/errors.js';
import { isRecord, type OpenApiParameter, type ParameterLocation } from './types.js';
import { parameterSpec } from './serialization.js';

// `ajv-formats` exports the plugin as its CJS default; NodeNext keeps that nesting.
const addFormats = (addFormatsModule as unknown as { default: (ajv: unknown) => void }).default;

type AjvInstance = InstanceType<typeof Ajv>;

export type SchemaDialect = '3.0' | '3.1';

interface CompiledValidator {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
  /** Set when the schema could not be compiled and validation was skipped. */
  uncompilable?: string;
}

/** Keywords that describe rather than constrain, and which AJV would reject or mis-read. */
const ANNOTATION_KEYWORDS = new Set([
  'example',
  'examples',
  'xml',
  'externalDocs',
  'discriminator',
  'deprecated',
  'nullable',
  'readOnly',
  'writeOnly',
]);

/**
 * Convert an OpenAPI 3.0 schema into an equivalent draft-07 schema.
 * Structural only: no constraint is added or removed beyond the documented differences.
 */
export function openApi30ToJsonSchema(
  schema: unknown,
  seen = new Map<unknown, unknown>(),
): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => openApi30ToJsonSchema(entry, seen));
  if (!isRecord(schema)) return schema;
  const cached = seen.get(schema);
  if (cached) return cached;

  const out: Record<string, unknown> = {};
  seen.set(schema, out);

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'nullable') continue;
    if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
      // 3.0: boolean modifier on minimum/maximum. Draft-07: a number in its own right.
      if (typeof value === 'boolean') {
        const bound = key === 'exclusiveMinimum' ? schema.minimum : schema.maximum;
        if (value && typeof bound === 'number') out[key] = bound;
        continue;
      }
      out[key] = value;
      continue;
    }
    if (key === 'minimum' && schema.exclusiveMinimum === true) continue;
    if (key === 'maximum' && schema.exclusiveMaximum === true) continue;
    if (ANNOTATION_KEYWORDS.has(key)) continue;
    out[key] = openApi30ToJsonSchema(value, seen);
  }

  // `nullable: true` widens the declared type with null.
  if (schema.nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.type) && !out.type.includes('null')) {
      out.type = [...(out.type as string[]), 'null'];
    } else if (
      out.type === undefined &&
      (out.enum || out.$ref || out.oneOf || out.anyOf || out.allOf)
    ) {
      // A nullable ref/enum: allow null alongside whatever the schema already permits.
      const inner = { ...out };
      for (const key of Object.keys(out)) delete out[key];
      out.anyOf = [inner, { type: 'null' }];
    }
  }
  return out;
}

/** Strip the keywords AJV 2020 would reject in a 3.1 schema. */
export function openApi31ToJsonSchema(
  schema: unknown,
  seen = new Map<unknown, unknown>(),
): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => openApi31ToJsonSchema(entry, seen));
  if (!isRecord(schema)) return schema;
  const cached = seen.get(schema);
  if (cached) return cached;

  const out: Record<string, unknown> = {};
  seen.set(schema, out);
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'discriminator' || key === 'xml' || key === 'externalDocs') continue;
    out[key] = openApi31ToJsonSchema(value, seen);
  }
  return out;
}

export interface ValidationIssue {
  path: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}

export class SchemaValidator {
  private readonly ajv30: AjvInstance;
  private readonly ajv31: AjvInstance;
  private readonly cache = new Map<string, CompiledValidator>();

  constructor(
    private readonly dialect: SchemaDialect,
    /** Component schemas, so `$ref: '#/components/schemas/X'` resolves. */
    private readonly components: Record<string, unknown> = {},
  ) {
    const options = {
      strict: false,
      allErrors: true,
      validateFormats: true,
      // A remote API decides what its defaults are; filling them in locally would send
      // values the caller never asked for.
      useDefaults: false,
      coerceTypes: false,
    } as const;
    this.ajv30 = new Ajv(options);
    this.ajv31 = new Ajv2020(options);
    addFormats(this.ajv30);
    addFormats(this.ajv31);
  }

  private get ajv(): AjvInstance {
    return this.dialect === '3.1' ? this.ajv31 : this.ajv30;
  }

  private convert(schema: unknown): unknown {
    return this.dialect === '3.1' ? openApi31ToJsonSchema(schema) : openApi30ToJsonSchema(schema);
  }

  /**
   * Compile a schema together with the component definitions it may reference. The whole
   * `components.schemas` map is attached under `$defs` and `#/components/schemas/...`
   * pointers are rewritten to it, which keeps recursive references working.
   */
  private compile(schema: unknown, cacheKey: string): CompiledValidator {
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // The operation schema goes inside `allOf` rather than at the root. In draft-07 a
    // sibling of `$ref` is ignored, so a root-level `{ $ref, $defs }` would silently
    // drop the component definitions and fail to resolve the reference.
    const root = {
      $defs: this.convert(this.components) as Record<string, unknown>,
      allOf: [this.convert(schema)],
    };
    const rewritten = rewriteComponentRefs(root);

    let validator: CompiledValidator;
    try {
      validator = this.ajv.compile(rewritten as AnySchema) as CompiledValidator;
    } catch (cause) {
      // An uncompilable schema must not block the request: the remote API remains the
      // authority on what it accepts.
      const message = cause instanceof Error ? cause.message : String(cause);
      validator = Object.assign(() => true, { errors: null, uncompilable: message });
    }
    this.cache.set(cacheKey, validator);
    return validator;
  }

  validate(schema: unknown, value: unknown, cacheKey: string): ValidationIssue[] {
    if (schema === undefined || schema === null) return [];
    const validator = this.compile(schema, cacheKey);
    if (validator(value)) return [];
    // AJV attaches errors to the compiled function, not to the Ajv instance.
    const errors = (validator.errors ?? []).slice(0, 20);
    return errors.map((error) => ({
      path: error.instancePath === '' ? '(root)' : error.instancePath,
      message: error.message ?? 'is invalid',
      ...(error.params && Object.keys(error.params).length > 0 ? { expected: error.params } : {}),
    }));
  }
}

/** Rewrite `#/components/schemas/X` to `#/$defs/X` so a single compiled schema resolves. */
function rewriteComponentRefs(node: unknown, seen = new Set<unknown>()): unknown {
  if (Array.isArray(node)) return node.map((entry) => rewriteComponentRefs(entry, seen));
  if (!isRecord(node)) return node;
  if (seen.has(node)) return node;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      node[key] = value.replace('#/components/schemas/', '#/$defs/');
      continue;
    }
    rewriteComponentRefs(value, seen);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Parameter validation
// ---------------------------------------------------------------------------

export interface ParameterValidationInput {
  parameters: readonly OpenApiParameter[];
  supplied: Partial<Record<ParameterLocation, Record<string, unknown> | undefined>>;
  validator: SchemaValidator;
  operationId: string;
}

export interface ValidatedParameters {
  /** Declared parameters that were supplied, grouped by location. */
  values: Record<ParameterLocation, Map<string, unknown>>;
  /** Supplied names the operation does not declare. */
  unknown: { name: string; in: string }[];
}

const LOCATIONS: ParameterLocation[] = ['path', 'query', 'header', 'cookie'];

export function validateParameters(input: ParameterValidationInput): ValidatedParameters {
  const values: Record<ParameterLocation, Map<string, unknown>> = {
    path: new Map(),
    query: new Map(),
    header: new Map(),
    cookie: new Map(),
  };
  const unknownParameters: { name: string; in: string }[] = [];
  const issues: ValidationIssue[] = [];

  const declared = new Map<string, OpenApiParameter>();
  for (const parameter of input.parameters) {
    const location = parameter.in;
    if (!isParameterLocation(location) || typeof parameter.name !== 'string') continue;
    declared.set(`${location}:${parameter.name}`, parameter);
  }

  for (const [key, parameter] of declared) {
    const [location, name] = splitKey(key);
    const suppliedForLocation = input.supplied[location] ?? {};
    const hasValue = Object.prototype.hasOwnProperty.call(suppliedForLocation, name);
    const value = suppliedForLocation[name];

    const required = parameter.required === true || location === 'path';
    if (!hasValue || value === undefined) {
      if (required) {
        throw new PortolanError(
          'PARAMETER_REQUIRED',
          `Parameter '${name}' (in ${location}) is required by operation '${input.operationId}' but was not supplied.`,
          {
            parameter: name,
            in: location,
            operation_id: input.operationId,
            ...(parameter.schema !== undefined ? { expected_schema: parameter.schema } : {}),
          },
        );
      }
      continue;
    }

    // Reject a style/explode combination before serializing anything (SPEC.md §22).
    parameterSpec(parameter, location);

    if (parameter.schema !== undefined) {
      const found = input.validator.validate(parameter.schema, value, `param:${key}`);
      for (const issue of found) {
        issues.push({
          ...issue,
          path: `${location}.${name}${issue.path === '(root)' ? '' : issue.path}`,
          received: value,
        });
      }
    }
    values[location].set(name, value);
  }

  for (const location of LOCATIONS) {
    for (const name of Object.keys(input.supplied[location] ?? {})) {
      if (!declared.has(`${location}:${name}`)) unknownParameters.push({ name, in: location });
    }
  }

  if (issues.length > 0) {
    throw new PortolanError(
      'PARAMETER_INVALID',
      `Parameters for operation '${input.operationId}' are invalid: ${issues
        .map((i) => `${i.path} ${i.message}`)
        .join('; ')}`,
      { operation_id: input.operationId, issues },
    );
  }

  return { values, unknown: unknownParameters };
}

export function validateRequestBody(
  schema: unknown,
  body: unknown,
  validator: SchemaValidator,
  operationId: string,
  contentType: string,
): void {
  const issues = validator.validate(schema, body, `body:${operationId}:${contentType}`);
  if (issues.length === 0) return;
  throw new PortolanError(
    'REQUEST_BODY_INVALID',
    `The request body for operation '${operationId}' does not match its ${contentType} schema: ${issues
      .map((i) => `${i.path} ${i.message}`)
      .join('; ')}`,
    { operation_id: operationId, content_type: contentType, issues },
  );
}

function isParameterLocation(value: unknown): value is ParameterLocation {
  return value === 'path' || value === 'query' || value === 'header' || value === 'cookie';
}

function splitKey(key: string): [ParameterLocation, string] {
  const index = key.indexOf(':');
  return [key.slice(0, index) as ParameterLocation, key.slice(index + 1)];
}
