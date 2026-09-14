/**
 * Operation extraction and search-document construction (SPEC.md §14, §46).
 */
import {
  HTTP_METHODS,
  isRecord,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
  type SecurityRequirement,
} from './types.js';

export interface ExtractedOperation {
  canonicalId: string;
  sourceOperationId: string | undefined;
  method: string;
  path: string;
  summary: string | undefined;
  description: string | undefined;
  tags: string[];
  deprecated: boolean;
  /** Parameters with path-item level parameters merged in, per the OpenAPI rules. */
  parameters: OpenApiParameter[];
  operation: OpenApiOperation;
  security: SecurityRequirement[] | undefined;
  /** Servers declared at the operation or path-item level, if any. */
  servers: string[];
}

export interface ExtractionResult {
  operations: ExtractedOperation[];
  warnings: string[];
}

/** A parameter is identified by name+location; an operation-level entry wins. */
function parameterKey(parameter: OpenApiParameter): string {
  return `${parameter.in ?? ''}:${parameter.name ?? ''}`;
}

function mergeParameters(
  pathLevel: OpenApiParameter[] | undefined,
  operationLevel: OpenApiParameter[] | undefined,
): OpenApiParameter[] {
  const merged = new Map<string, OpenApiParameter>();
  for (const parameter of pathLevel ?? []) {
    if (isRecord(parameter)) merged.set(parameterKey(parameter), parameter);
  }
  for (const parameter of operationLevel ?? []) {
    if (isRecord(parameter)) merged.set(parameterKey(parameter), parameter);
  }
  return [...merged.values()];
}

export function extractOperations(document: OpenApiDocument): ExtractionResult {
  const warnings: string[] = [];
  const paths = document.paths ?? {};

  // First pass: find operationIds used more than once. SPEC.md §14 requires those to
  // fall back to method:path rather than silently shadowing each other.
  const operationIdCounts = new Map<string, number>();
  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      const id = isRecord(operation) ? operation.operationId : undefined;
      if (typeof id === 'string' && id.trim() !== '') {
        operationIdCounts.set(id, (operationIdCounts.get(id) ?? 0) + 1);
      }
    }
  }
  const duplicates = new Set(
    [...operationIdCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );
  if (duplicates.size > 0) {
    warnings.push(
      `Duplicate operationId values were found (${[...duplicates].slice(0, 5).join(', ')}${
        duplicates.size > 5 ? ', …' : ''
      }); those operations use method:path identifiers instead.`,
    );
  }

  const operations: ExtractedOperation[] = [];
  let missingOperationIds = 0;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    const item = pathItem;

    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const op = operation;

      const sourceOperationId =
        typeof op.operationId === 'string' && op.operationId.trim() !== ''
          ? op.operationId
          : undefined;
      if (!sourceOperationId) missingOperationIds += 1;

      const canonicalId =
        sourceOperationId && !duplicates.has(sourceOperationId)
          ? sourceOperationId
          : `${method}:${path}`;

      const servers = [...collectServerUrls(op.servers), ...collectServerUrls(item.servers)];

      operations.push({
        canonicalId,
        sourceOperationId,
        method: method.toUpperCase(),
        path,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        description: typeof op.description === 'string' ? op.description : undefined,
        tags: Array.isArray(op.tags)
          ? op.tags.filter((t): t is string => typeof t === 'string')
          : [],
        deprecated: op.deprecated === true,
        parameters: mergeParameters(item.parameters, op.parameters),
        operation: op,
        security: Array.isArray(op.security) ? op.security : undefined,
        servers,
      });
    }
  }

  if (missingOperationIds > 0) {
    warnings.push(
      `${missingOperationIds} operation(s) have no operationId; they are addressed as "method:/path".`,
    );
  }

  // Two operations must never collide on canonical id.
  const seen = new Set<string>();
  for (const op of operations) {
    if (seen.has(op.canonicalId)) {
      op.canonicalId = `${op.method.toLowerCase()}:${op.path}`;
    }
    seen.add(op.canonicalId);
  }

  return { operations, warnings };
}

function collectServerUrls(servers: unknown): string[] {
  if (!Array.isArray(servers)) return [];
  return servers
    .map((s) => (isRecord(s) && typeof s.url === 'string' ? s.url : undefined))
    .filter((u): u is string => typeof u === 'string');
}

// ---------------------------------------------------------------------------
// Search documents (SPEC.md §46)
// ---------------------------------------------------------------------------

export interface OperationSearchText {
  /** Parameter names and descriptions. */
  parameters: string;
  /** Request and response property names, plus schema component names. */
  schemaNames: string;
  /** The whole document, retained for debugging and for future re-ranking. */
  combined: string;
}

const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_TOKENS = 300;

export function buildOperationSearchText(operation: ExtractedOperation): OperationSearchText {
  const parameterWords: string[] = [];
  for (const parameter of operation.parameters) {
    if (typeof parameter.name === 'string') parameterWords.push(parameter.name);
    if (typeof parameter.description === 'string') parameterWords.push(parameter.description);
  }

  const schemaWords = new Set<string>();
  collectSchemaNames(operation.operation.requestBody, schemaWords, 0);
  for (const response of Object.values(operation.operation.responses ?? {})) {
    collectSchemaNames(response, schemaWords, 0);
  }

  const parameters = parameterWords.join(' ');
  const schemaNames = [...schemaWords].slice(0, MAX_SCHEMA_TOKENS).join(' ');
  const combined = [
    operation.canonicalId,
    operation.sourceOperationId ?? '',
    operation.method,
    operation.path,
    operation.summary ?? '',
    operation.description ?? '',
    operation.tags.join(' '),
    parameters,
    schemaNames,
  ]
    .filter(Boolean)
    .join('\n');

  return { parameters, schemaNames, combined };
}

/**
 * Walk a schema collecting property names, enum values, `$ref` component names and
 * descriptions. Depth-limited and cycle-safe, because bundled documents keep recursive
 * `$ref`s.
 */
function collectSchemaNames(
  node: unknown,
  out: Set<string>,
  depth: number,
  seen = new Set<unknown>(),
): void {
  if (depth > MAX_SCHEMA_DEPTH || out.size > MAX_SCHEMA_TOKENS) return;
  if (!isRecord(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = value.split('/').pop();
      if (name) out.add(name);
      continue;
    }
    if (key === 'properties' && isRecord(value)) {
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        out.add(propertyName);
        const description = isRecord(propertySchema) ? propertySchema.description : undefined;
        if (typeof description === 'string') out.add(description);
        collectSchemaNames(propertySchema, out, depth + 1, seen);
      }
      continue;
    }
    if (key === 'enum' && Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') out.add(entry);
      continue;
    }
    if (key === 'description' && typeof value === 'string' && depth > 0) {
      out.add(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collectSchemaNames(entry, out, depth + 1, seen);
      continue;
    }
    if (isRecord(value)) collectSchemaNames(value, out, depth + 1, seen);
  }
}
