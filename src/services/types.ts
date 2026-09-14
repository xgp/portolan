/**
 * Application-service contracts (SPEC.md §58).
 *
 * The MCP layer depends only on these interfaces. Nothing here mentions MCP, so the same
 * services can back a CLI, a REST façade or a library embedding.
 */

// ---------------------------------------------------------------------------
// add_api (SPEC.md §16)
// ---------------------------------------------------------------------------

export interface AddApiInput {
  specUrl?: string;
  specContent?: string;
  apiId?: string;
  name?: string;
  description?: string;
  aliases?: string[];
  tags?: string[];
  defaultBaseUrl?: string;
  defaultEnvironment?: string;
  authProfile?: string;
  replace?: boolean;
}

export interface AddApiResult {
  api_id: string;
  name: string;
  openapi_version: string | null;
  api_version: string | null;
  operations: number;
  environments: { name: string; base_url: string; allow_mutations: boolean; source: string }[];
  warnings: string[];
  status: 'added' | 'replaced' | 'unchanged';
}

// ---------------------------------------------------------------------------
// find_api / search_api (SPEC.md §17, §18)
// ---------------------------------------------------------------------------

export interface ApiSearchResult {
  api_id: string;
  name: string;
  description: string | null;
  score: number;
  matched: string[];
}

export interface OperationSearchResult {
  operation_id: string;
  method: string;
  path: string;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  score: number;
}

/** SPEC.md §9: the seam that lets FTS be replaced by hybrid or vector search later. */
export interface SearchProvider {
  searchApis(query: string, limit: number): Promise<ApiSearchResult[]>;
  searchOperations(
    apiId: string,
    query: string,
    limit: number,
    filters?: { tags?: string[]; methods?: string[] },
  ): Promise<OperationSearchResult[]>;
}

// ---------------------------------------------------------------------------
// inspect_api (SPEC.md §19)
// ---------------------------------------------------------------------------

export interface InspectedParameter {
  name: string;
  description?: string;
  required: boolean;
  schema?: unknown;
  example?: unknown;
  style?: string;
  explode?: boolean;
  deprecated?: boolean;
}

export interface InspectedOperation {
  operation_id: string;
  source_operation_id: string | null;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  tags: string[];
  deprecated: boolean;
  parameters: {
    path?: InspectedParameter[];
    query?: InspectedParameter[];
    header?: InspectedParameter[];
    cookie?: InspectedParameter[];
  };
  request_body?: {
    required: boolean;
    content: Record<string, { schema?: unknown; examples?: unknown }>;
  };
  responses: Record<
    string,
    { description?: string; content?: Record<string, { schema?: unknown }> }
  >;
  security?: unknown;
}

export interface InspectApiResult {
  api_id: string;
  operations: InspectedOperation[];
  /**
   * Only the component schemas transitively referenced by the operations above
   * (docs/DEVIATIONS.md D11). Present only when at least one `$ref` was returned.
   */
  components?: { schemas: Record<string, unknown> };
  not_found?: string[];
}

// ---------------------------------------------------------------------------
// call_api (SPEC.md §20, §24)
// ---------------------------------------------------------------------------

export interface CallParameters {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  header?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
}

export interface CallApiInput {
  apiId: string;
  operationId: string;
  environment?: string;
  parameters?: CallParameters;
  body?: unknown;
  contentType?: string;
  timeoutMs?: number;
}

export interface CallApiResult {
  request: { operation_id: string; method: string; url: string };
  response: {
    status: number;
    status_text: string;
    headers: Record<string, string>;
    content_type?: string;
    body: unknown;
    truncated?: boolean;
  };
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// run_api_code (SPEC.md §32, §36)
// ---------------------------------------------------------------------------

export interface RunApiCodeInput {
  apiId: string;
  environment?: string;
  code: string;
  input?: unknown;
  timeoutMs?: number;
  maxApiCalls?: number;
}

export interface RunApiCodeResult {
  result: unknown;
  api_calls: number;
  duration_ms: number;
  logs: string[];
}

/** Per-MCP-call context threaded through the services for tracing (SPEC.md §57). */
export interface RequestContext {
  requestId: string;
}
