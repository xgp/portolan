/**
 * `inspect_api` — detailed operation schemas (SPEC.md §19).
 *
 * The stored document keeps internal `$ref`s so recursive schemas terminate
 * (docs/DEVIATIONS.md D11). That means a returned schema can contain pointers the agent
 * cannot resolve, because it never sees the whole document. So this module walks the
 * transitive closure of the `$ref`s actually reachable from the requested operations and
 * returns exactly those components — no more (SPEC.md §19: "do not return unrelated
 * schemas"), no fewer (or the agent is handed a dangling pointer).
 */
import { PortolanError } from '../errors/errors.js';
import { isRecord, type OpenApiDocument, type OpenApiParameter } from '../openapi/types.js';
import type {
  InspectApiResult,
  InspectedOperation,
  InspectedParameter,
} from '../services/types.js';
import type { Catalog } from './catalog.js';

export const MAX_INSPECT_OPERATIONS = 10;

interface StoredOperation {
  canonical_id: string;
  source_operation_id: string | null;
  method: string;
  path: string;
  parameters: OpenApiParameter[];
  operation: Record<string, unknown>;
  security: unknown;
  servers: string[];
}

export function inspectOperations(
  catalog: Catalog,
  apiId: string,
  operationIds: readonly string[],
): InspectApiResult {
  if (operationIds.length === 0) {
    throw new PortolanError('INVALID_ARGUMENT', 'Supply at least one operation_id.');
  }
  if (operationIds.length > MAX_INSPECT_OPERATIONS) {
    throw new PortolanError(
      'INVALID_ARGUMENT',
      `inspect_api accepts at most ${MAX_INSPECT_OPERATIONS} operations per call; ${operationIds.length} were supplied.`,
      { limit: MAX_INSPECT_OPERATIONS, supplied: operationIds.length },
    );
  }

  catalog.getApi(apiId);
  const version = catalog.getCurrentVersion(apiId);
  const document = JSON.parse(version.specJson) as OpenApiDocument;

  const operations: InspectedOperation[] = [];
  const notFound: string[] = [];
  const refs = new Set<string>();

  for (const identifier of operationIds) {
    let resolved;
    try {
      resolved = catalog.resolveOperation(apiId, identifier);
    } catch {
      notFound.push(identifier);
      continue;
    }
    const stored = JSON.parse(resolved.operation.operationJson) as StoredOperation;
    operations.push(
      describeOperation(
        stored,
        resolved.operation.summary,
        resolved.operation.description,
        resolved.operation.tags,
        resolved.operation.deprecated,
        document,
        refs,
      ),
    );
  }

  const components = collectComponents(document, refs);
  return {
    api_id: apiId,
    operations,
    ...(Object.keys(components).length > 0 ? { components: { schemas: components } } : {}),
    ...(notFound.length > 0 ? { not_found: notFound } : {}),
  };
}

function describeOperation(
  stored: StoredOperation,
  summary: string | null,
  description: string | null,
  tags: string[],
  deprecated: boolean,
  document: OpenApiDocument,
  refs: Set<string>,
): InspectedOperation {
  const grouped: InspectedOperation['parameters'] = {};
  for (const parameter of stored.parameters ?? []) {
    const location = parameter.in;
    if (
      location !== 'path' &&
      location !== 'query' &&
      location !== 'header' &&
      location !== 'cookie'
    ) {
      continue;
    }
    const described = describeParameter(parameter, document, refs);
    (grouped[location] ??= []).push(described);
  }

  const operation = stored.operation ?? {};
  const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined;
  const responses = isRecord(operation.responses) ? operation.responses : {};

  const inspected: InspectedOperation = {
    operation_id: stored.canonical_id,
    source_operation_id: stored.source_operation_id,
    method: stored.method,
    path: stored.path,
    summary,
    description,
    tags,
    deprecated,
    parameters: grouped,
    responses: describeResponses(responses, document, refs),
  };

  if (requestBody) {
    inspected.request_body = {
      required: requestBody.required === true,
      content: describeContent(requestBody.content, document, refs),
    };
  }

  // SPEC.md §19 asks for security requirements; fall back to the document-level default
  // so an agent can see that an operation is protected even when it says nothing itself.
  const security = stored.security ?? document.security;
  if (security !== undefined && security !== null) inspected.security = security;

  return inspected;
}

function describeParameter(
  parameter: OpenApiParameter,
  document: OpenApiDocument,
  refs: Set<string>,
): InspectedParameter {
  const described: InspectedParameter = {
    name: typeof parameter.name === 'string' ? parameter.name : '',
    required: parameter.required === true || parameter.in === 'path',
  };
  if (typeof parameter.description === 'string') described.description = parameter.description;
  if (parameter.schema !== undefined)
    described.schema = trackRefs(parameter.schema, document, refs);
  if (parameter.example !== undefined) described.example = parameter.example;
  if (typeof parameter.style === 'string') described.style = parameter.style;
  if (typeof parameter.explode === 'boolean') described.explode = parameter.explode;
  if (parameter.deprecated === true) described.deprecated = true;
  return described;
}

function describeContent(
  content: unknown,
  document: OpenApiDocument,
  refs: Set<string>,
): Record<string, { schema?: unknown; examples?: unknown }> {
  const out: Record<string, { schema?: unknown; examples?: unknown }> = {};
  if (!isRecord(content)) return out;
  for (const [mediaType, media] of Object.entries(content)) {
    if (!isRecord(media)) continue;
    const entry: { schema?: unknown; examples?: unknown } = {};
    if (media.schema !== undefined) entry.schema = trackRefs(media.schema, document, refs);
    if (media.examples !== undefined) entry.examples = media.examples;
    else if (media.example !== undefined) entry.examples = { default: { value: media.example } };
    out[mediaType] = entry;
  }
  return out;
}

function describeResponses(
  responses: Record<string, unknown>,
  document: OpenApiDocument,
  refs: Set<string>,
): InspectedOperation['responses'] {
  const out: InspectedOperation['responses'] = {};
  for (const [status, response] of Object.entries(responses)) {
    if (!isRecord(response)) continue;
    const entry: { description?: string; content?: Record<string, { schema?: unknown }> } = {};
    if (typeof response.description === 'string') entry.description = response.description;
    if (response.content !== undefined) {
      entry.content = describeContent(response.content, document, refs);
    }
    out[status] = entry;
  }
  return out;
}

/** Record every `#/components/schemas/...` pointer appearing in a subtree. */
function trackRefs(node: unknown, document: OpenApiDocument, refs: Set<string>): unknown {
  walkRefs(node, refs, new Set());
  // Follow the pointers into the document so nested references are collected too.
  let frontier = [...refs];
  const visited = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const name of frontier) {
      if (visited.has(name)) continue;
      visited.add(name);
      const schema = componentSchema(document, name);
      if (schema === undefined) continue;
      const found = new Set<string>();
      walkRefs(schema, found, new Set());
      for (const child of found) {
        if (!refs.has(child)) {
          refs.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return node;
}

function walkRefs(node: unknown, out: Set<string>, seen: Set<unknown>): void {
  if (Array.isArray(node)) {
    for (const entry of node) walkRefs(entry, out, seen);
    return;
  }
  if (!isRecord(node) || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = componentName(value);
      if (name) out.add(name);
      continue;
    }
    walkRefs(value, out, seen);
  }
}

const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;

function componentName(ref: string): string | undefined {
  const match = SCHEMA_REF.exec(ref);
  return match?.[1]
    ? decodeURIComponent(match[1].replace(/~1/g, '/').replace(/~0/g, '~'))
    : undefined;
}

function componentSchema(document: OpenApiDocument, name: string): unknown {
  const schemas = document.components?.schemas;
  return isRecord(schemas) ? schemas[name] : undefined;
}

function collectComponents(document: OpenApiDocument, refs: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of [...refs].sort()) {
    const schema = componentSchema(document, name);
    if (schema !== undefined) out[name] = schema;
  }
  return out;
}
