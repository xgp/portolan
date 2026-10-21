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
  /**
   * docs/DEVIATIONS.md D20: a flaw found in the document. With `apiId` and no spec source,
   * corrects the registered API in place.
   */
  issue?: { title: string; description?: string };
  /** RFC 6902 operations correcting the flaw described by `issue`. */
  patches?: unknown[];
  /** Ids of earlier agent corrections to withdraw. */
  revertCorrections?: string[];
  /** `owner/name` of the repository that publishes the document. */
  upstreamRepo?: string;
}

export interface CorrectionSummary {
  id: string;
  origin: 'portolan' | 'agent';
  status: 'applied' | 'stale' | 'resolved' | 'reported' | 'reverted';
  title: string;
}

export interface UpstreamIssueSummary {
  repo: string;
  status: 'filed' | 'existing' | 'draft' | 'failed' | 'rate_limited';
  url: string;
  title: string;
  message?: string;
  correction_ids: string[];
}

export interface AddApiResult {
  api_id: string;
  name: string;
  openapi_version: string | null;
  api_version: string | null;
  operations: number;
  environments: { name: string; base_url: string; allow_mutations: boolean; source: string }[];
  warnings: string[];
  status: 'added' | 'replaced' | 'corrected' | 'unchanged';
  /**
   * Corrections this call created or changed the status of (D20, D21), at most
   * {@link MAX_REPORTED_CORRECTIONS}; `corrections_total` counts all of them.
   */
  corrections?: CorrectionSummary[];
  corrections_total?: number;
  /** Upstream issues drafted or filed by this call (D22). */
  upstream_issues?: UpstreamIssueSummary[];
}

export const MAX_REPORTED_CORRECTIONS = 20;

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
  path?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  header?: Record<string, unknown> | undefined;
  cookie?: Record<string, unknown> | undefined;
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
    /** Set when `body` holds base64 rather than text or JSON (SPEC.md §51). */
    body_encoding?: 'base64';
  };
  duration_ms: number;
  /** Non-fatal notes, e.g. parameters the operation does not declare. */
  warnings?: string[];
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
