/** Zod input schemas for the six MCP tools (SPEC.md §16–§20, §32). */
import { z } from 'zod';

export const FIND_API_DEFAULT_LIMIT = 5;
export const FIND_API_MAX_LIMIT = 20;
export const SEARCH_API_DEFAULT_LIMIT = 10;
export const SEARCH_API_MAX_LIMIT = 30;
export const INSPECT_API_MAX_OPERATIONS = 10;
export const MAX_PATCH_OPERATIONS = 100;

export const addApiSchema = z.object({
  spec_url: z
    .string()
    .describe(
      'HTTPS URL of an OpenAPI document. Supply exactly one of spec_url or spec_content, or ' +
        'neither when correcting a registered API.',
    )
    .optional(),
  spec_content: z
    .string()
    .describe(
      'An OpenAPI document as YAML or JSON text. Supply exactly one of spec_url or spec_content, ' +
        'or neither when correcting a registered API. ' +
        'Filesystem paths are not accepted; read the file yourself and pass its contents.',
    )
    .optional(),
  api_id: z
    .string()
    .describe('Stable short identifier, e.g. "keycloak". Derived from info.title when omitted.')
    .optional(),
  name: z.string().describe('Human-readable name. Defaults to info.title.').optional(),
  description: z
    .string()
    .describe('Short capability description used by find_api. Defaults to info.description.')
    .optional(),
  aliases: z.array(z.string()).describe('Alternative names to match in find_api.').optional(),
  tags: z.array(z.string()).describe('Free-form tags used by find_api.').optional(),
  default_base_url: z
    .string()
    .describe('Base URL for the default environment. Overrides the OpenAPI servers entry.')
    .optional(),
  default_environment: z
    .string()
    .describe('Name for the default environment. Defaults to "default".')
    .optional(),
  auth_profile: z
    .string()
    .describe(
      'Name of a server-side auth profile to bind. Disabled by default: bind credentials in ' +
        'config.yaml instead.',
    )
    .optional(),
  replace: z
    .boolean()
    .describe('Replace an existing API with this ID by adding a new version. Defaults to false.')
    .optional(),
  issue: z
    .object({
      title: z
        .string()
        .min(1)
        .max(200)
        .describe('One line naming the flaw, e.g. "GET /users/{id} omits the 404 response".'),
      description: z
        .string()
        .max(8000)
        .describe(
          'What the document says, what the API actually does, and how you found out. ' +
            'Becomes the body of the upstream issue, so never include credentials or personal data.',
        )
        .optional(),
    })
    .describe(
      'A flaw you found in the OpenAPI document, e.g. a missing parameter or a schema that does ' +
        'not match real responses. With api_id and no spec source, corrects the registered API.',
    )
    .optional(),
  patches: z
    .array(
      z.object({
        op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
        path: z.string(),
        value: z.unknown().optional(),
        from: z.string().optional(),
      }),
    )
    .max(MAX_PATCH_OPERATIONS)
    .describe(
      'RFC 6902 JSON Patch fixing the flaw in issue, applied to the whole document as ' +
        'inspect_api presents it. Escape "/" in path keys as "~1", e.g. ' +
        '/paths/~1users~1{id}/get/parameters/-. Lead with "test" operations so the fix is ' +
        'skipped once the upstream document changes.',
    )
    .optional(),
  revert_corrections: z
    .array(z.string().min(1))
    .describe('Ids of earlier corrections to withdraw, as returned in corrections.')
    .optional(),
  upstream_repo: z
    .string()
    .describe('GitHub repository that publishes this document, as "owner/name".')
    .optional(),
});

export const findApiSchema = z.object({
  query: z.string().min(1).describe('Natural-language description of the task or capability.'),
  limit: z
    .number()
    .int()
    .describe(`Maximum results. Default ${FIND_API_DEFAULT_LIMIT}, maximum ${FIND_API_MAX_LIMIT}.`)
    .optional(),
});

export const searchApiSchema = z.object({
  api_id: z.string().min(1).describe('The API to search within, as returned by find_api.'),
  query: z.string().min(1).describe('Natural-language description of the operation you need.'),
  limit: z
    .number()
    .int()
    .describe(
      `Maximum results. Default ${SEARCH_API_DEFAULT_LIMIT}, maximum ${SEARCH_API_MAX_LIMIT}.`,
    )
    .optional(),
  tags: z
    .array(z.string())
    .describe('Restrict results to operations carrying these tags.')
    .optional(),
  methods: z
    .array(z.string())
    .describe('Restrict results to these HTTP methods, e.g. ["GET","PUT"].')
    .optional(),
});

export const inspectApiSchema = z.object({
  api_id: z.string().min(1).describe('The API containing the operations.'),
  operation_ids: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      `Operation IDs from search_api. At most ${INSPECT_API_MAX_OPERATIONS} operations per call.`,
    ),
});

export const callApiSchema = z.object({
  api_id: z.string().min(1).describe('The API to call.'),
  operation_id: z.string().min(1).describe('The operation to execute, as returned by search_api.'),
  environment: z
    .string()
    .describe('Named environment to execute against. Defaults to the API default environment.')
    .optional(),
  parameters: z
    .object({
      path: z.record(z.string(), z.unknown()).optional(),
      query: z.record(z.string(), z.unknown()).optional(),
      header: z.record(z.string(), z.unknown()).optional(),
      cookie: z.record(z.string(), z.unknown()).optional(),
    })
    .describe('OpenAPI parameters grouped by location. Do not put credentials here.')
    .optional(),
  body: z.unknown().describe('Request body, matching the operation request schema.').optional(),
  content_type: z
    .string()
    .describe('Request content type. Defaults to the first type the operation declares.')
    .optional(),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .describe('Per-request timeout in milliseconds.')
    .optional(),
});

export const runApiCodeSchema = z.object({
  api_id: z.string().min(1).describe('The single API the script may call.'),
  environment: z.string().describe('Named environment to execute against.').optional(),
  code: z
    .string()
    .min(1)
    .describe(
      'JavaScript executed in a sandbox with no filesystem, network, environment or subprocess ' +
        'access. Available bindings: api.call({operation_id, parameters, body, content_type}), ' +
        'input, console. Use `return` at top level to produce the result.',
    ),
  input: z
    .unknown()
    .describe('JSON-serializable value exposed to the script as `input`.')
    .optional(),
  timeout_ms: z.number().int().positive().describe('Wall-clock limit. Default 30000.').optional(),
  max_api_calls: z
    .number()
    .int()
    .positive()
    .describe('Maximum api.call() invocations. Default 50.')
    .optional(),
});

/** Clamp a caller-supplied limit into the documented range instead of rejecting it. */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
