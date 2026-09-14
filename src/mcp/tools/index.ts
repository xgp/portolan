/**
 * MCP tool registration (SPEC.md §15, §41).
 *
 * Exactly six tools, whatever the size of the catalog. The handlers are thin: they
 * translate arguments, call one application service, and shape the result. All business
 * logic lives below this layer (SPEC.md §7, §58).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { Portolan } from '../../app.js';
import { inspectOperations } from '../../catalog/inspector.js';
import { newRequestId } from '../../ids.js';
import type { RequestContext } from '../../services/types.js';
import { toolError, toolSuccess, type McpToolResult } from '../tool-result.js';
import {
  addApiSchema,
  callApiSchema,
  clampLimit,
  findApiSchema,
  FIND_API_DEFAULT_LIMIT,
  FIND_API_MAX_LIMIT,
  inspectApiSchema,
  runApiCodeSchema,
  searchApiSchema,
  SEARCH_API_DEFAULT_LIMIT,
  SEARCH_API_MAX_LIMIT,
} from './schemas.js';

/** SPEC.md §41: tool descriptions teach agents how Portolan is meant to be used. */
export const TOOL_DESCRIPTIONS = {
  add_api:
    'Add an OpenAPI-described HTTP API to the persistent Portolan API library. Use this ' +
    'when the user provides an OpenAPI specification or asks Portolan to remember an API ' +
    'for future use. Supply the document as spec_url or as spec_content; filesystem paths ' +
    'are not accepted, so read a local file yourself and pass its contents.',
  find_api:
    'Search the API library to identify which registered service can perform a task. Use ' +
    'this before search_api when you do not already know the API ID. Returns API ' +
    'identifiers and descriptions only — no operations and no schemas.',
  search_api:
    'Search operations within one registered API by capability or task description. ' +
    'Returns concise operation candidates. Use inspect_api before calling an unfamiliar ' +
    'operation.',
  inspect_api:
    'Retrieve detailed OpenAPI parameters, request schemas, responses, examples, and ' +
    'security requirements for selected operations. Request at most 10 operations per ' +
    'call, and only the ones you intend to use.',
  call_api:
    'Execute one registered OpenAPI operation using a configured environment and ' +
    'server-side credentials. You do not supply a URL, a base URL, credentials or ' +
    'authentication headers: the destination and authentication come from the ' +
    'environment configured for the API.',
  run_api_code:
    'Execute a constrained JavaScript workflow that can call multiple operations from one ' +
    'registered API through api.call(). Use for pagination, loops, conditional logic, ' +
    'transformations, or multi-request workflows. Prefer call_api when a single request ' +
    'is enough. The script has no filesystem, network, environment or subprocess access.',
} as const;

/** The agent-facing description of how the six tools fit together (SPEC.md §42). */
export const SERVER_INSTRUCTIONS = `Portolan is a catalog of OpenAPI-described HTTP APIs and a runtime for calling them.

It always exposes the same six tools, however many APIs it holds. Complete OpenAPI
documents never enter your context; you narrow down to the operations you need.

Recommended workflow:

1. If you do not know which API to use, call find_api with a description of the task.
2. Call search_api with that api_id and a description of the operation you need.
3. Call inspect_api for the operations you intend to use, to get their parameters and
   schemas. Request only the operations you need, at most 10 per call.
4. For one or a few requests, call call_api.
5. For pagination, loops, branching or many requests, use run_api_code instead of many
   call_api round trips.

Do not use run_api_code when a single call_api would do.

Things Portolan handles for you, which you should not attempt yourself:
- Base URLs and destinations come from the environment configured for the API.
- Authentication is applied server-side from named credential profiles. Never pass
  tokens, API keys, cookies or Authorization headers as parameters; you will not be
  given credentials and do not need them.
- Requests are validated against the OpenAPI document before they are sent.
- Mutating operations (POST, PUT, PATCH, DELETE) only run where an operator has enabled
  them for that environment. A MUTATION_NOT_ALLOWED error is a policy decision, not a
  transient failure: report it rather than retrying.

Errors are returned as {"error": {"code", "message", "details"}} with stable codes.
The details usually say exactly what to fix.`;

async function guard(fn: () => Promise<McpToolResult> | McpToolResult): Promise<McpToolResult> {
  try {
    return await fn();
  } catch (error) {
    return toolError(error);
  }
}

function newContext(): RequestContext {
  return { requestId: newRequestId() };
}

export function registerTools(server: McpServer, app: Portolan): void {
  const maxBytes = app.config.limits.max_tool_response_bytes;

  server.registerTool(
    'add_api',
    { title: 'Add an API', description: TOOL_DESCRIPTIONS.add_api, inputSchema: addApiSchema },
    async (args) =>
      guard(async () => {
        const result = await app.catalog.addApi({
          ...(args.spec_url !== undefined ? { specUrl: args.spec_url } : {}),
          ...(args.spec_content !== undefined ? { specContent: args.spec_content } : {}),
          ...(args.api_id !== undefined ? { apiId: args.api_id } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.aliases !== undefined ? { aliases: args.aliases } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.default_base_url !== undefined ? { defaultBaseUrl: args.default_base_url } : {}),
          ...(args.default_environment !== undefined
            ? { defaultEnvironment: args.default_environment }
            : {}),
          ...(args.auth_profile !== undefined ? { authProfile: args.auth_profile } : {}),
          ...(args.replace !== undefined ? { replace: args.replace } : {}),
        });
        return toolSuccess(result, maxBytes);
      }),
  );

  server.registerTool(
    'find_api',
    { title: 'Find an API', description: TOOL_DESCRIPTIONS.find_api, inputSchema: findApiSchema },
    async (args) =>
      guard(async () => {
        const limit = clampLimit(args.limit, FIND_API_DEFAULT_LIMIT, FIND_API_MAX_LIMIT);
        const results = await app.search.searchApis(args.query, limit);
        return toolSuccess({ results }, maxBytes);
      }),
  );

  server.registerTool(
    'search_api',
    {
      title: 'Search operations',
      description: TOOL_DESCRIPTIONS.search_api,
      inputSchema: searchApiSchema,
    },
    async (args) =>
      guard(async () => {
        // Fail with API_NOT_FOUND rather than returning an empty list for a typo.
        app.catalog.getApi(args.api_id);
        const limit = clampLimit(args.limit, SEARCH_API_DEFAULT_LIMIT, SEARCH_API_MAX_LIMIT);
        const results = await app.search.searchOperations(args.api_id, args.query, limit, {
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.methods !== undefined ? { methods: args.methods } : {}),
        });
        return toolSuccess({ api_id: args.api_id, results }, maxBytes);
      }),
  );

  server.registerTool(
    'inspect_api',
    {
      title: 'Inspect operations',
      description: TOOL_DESCRIPTIONS.inspect_api,
      inputSchema: inspectApiSchema,
    },
    (args) =>
      guard(() =>
        toolSuccess(inspectOperations(app.catalog, args.api_id, args.operation_ids), maxBytes),
      ),
  );

  server.registerTool(
    'call_api',
    {
      title: 'Call an operation',
      description: TOOL_DESCRIPTIONS.call_api,
      inputSchema: callApiSchema,
    },
    async (args) =>
      guard(async () => {
        const result = await app.caller.call(
          {
            apiId: args.api_id,
            operationId: args.operation_id,
            ...(args.environment !== undefined ? { environment: args.environment } : {}),
            ...(args.parameters !== undefined ? { parameters: args.parameters } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
            ...(args.content_type !== undefined ? { contentType: args.content_type } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
          },
          newContext(),
        );
        return toolSuccess(result, maxBytes);
      }),
  );

  server.registerTool(
    'run_api_code',
    {
      title: 'Run an API workflow',
      description: TOOL_DESCRIPTIONS.run_api_code,
      inputSchema: runApiCodeSchema,
    },
    async (args) =>
      guard(async () => {
        const result = await app.sandbox.run(
          {
            apiId: args.api_id,
            code: args.code,
            ...(args.environment !== undefined ? { environment: args.environment } : {}),
            ...(args.input !== undefined ? { input: args.input } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
            ...(args.max_api_calls !== undefined ? { maxApiCalls: args.max_api_calls } : {}),
          },
          newContext(),
        );
        return toolSuccess(result, maxBytes);
      }),
  );
}

/** The names Portolan exposes. Asserted by the end-to-end tests (SPEC.md §3.2). */
export const TOOL_NAMES = [
  'add_api',
  'find_api',
  'search_api',
  'inspect_api',
  'call_api',
  'run_api_code',
] as const;
