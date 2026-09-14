/**
 * A deliberately small structural view of OpenAPI 3.0/3.1.
 *
 * Portolan never needs a complete typed model of the specification — it reads the parts
 * listed in SPEC.md §3.3 and carries everything else through untouched. Keeping the
 * types narrow avoids pretending to a precision the documents in the wild do not have.
 */

export interface OpenApiDocument {
  openapi?: string;
  info?: OpenApiInfo;
  servers?: OpenApiServer[];
  paths?: Record<string, OpenApiPathItem | undefined>;
  webhooks?: Record<string, unknown>;
  components?: OpenApiComponents;
  security?: SecurityRequirement[];
  tags?: { name?: string; description?: string }[];
  [key: string]: unknown;
}

export interface OpenApiInfo {
  title?: string;
  description?: string;
  version?: string;
  [key: string]: unknown;
}

export interface OpenApiServer {
  url?: string;
  description?: string;
  variables?: Record<string, { default?: string; enum?: string[]; description?: string }>;
}

export interface OpenApiComponents {
  schemas?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  requestBodies?: Record<string, unknown>;
  responses?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  securitySchemes?: Record<string, SecurityScheme>;
  examples?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SecurityScheme {
  type?: string;
  scheme?: string;
  name?: string;
  in?: string;
  bearerFormat?: string;
  flows?: unknown;
  openIdConnectUrl?: string;
  description?: string;
}

export type SecurityRequirement = Record<string, string[]>;

export interface OpenApiPathItem {
  summary?: string;
  description?: string;
  servers?: OpenApiServer[];
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  put?: OpenApiOperation;
  post?: OpenApiOperation;
  delete?: OpenApiOperation;
  options?: OpenApiOperation;
  head?: OpenApiOperation;
  patch?: OpenApiOperation;
  trace?: OpenApiOperation;
  [key: string]: unknown;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  security?: SecurityRequirement[];
  servers?: OpenApiServer[];
  externalDocs?: unknown;
  [key: string]: unknown;
}

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export interface OpenApiParameter {
  name?: string;
  in?: string;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, unknown>;
  content?: Record<string, OpenApiMediaType>;
  [key: string]: unknown;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiMediaType {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, unknown>;
  encoding?: Record<string, unknown>;
}

export interface OpenApiResponse {
  description?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, OpenApiMediaType>;
}

/** The HTTP methods an OpenAPI path item may define, in a stable order. */
export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** SPEC.md §29: which methods are treated as mutating. */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function isMutatingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
