/**
 * The request execution pipeline (SPEC.md §20, §21, §22, §23, §24, §51).
 *
 * resolve API → resolve environment → resolve operation → check execution policy →
 * validate parameters → validate body → serialize → construct URL → resolve auth →
 * execute → limit size → parse → return.
 *
 * This is the single implementation of "call one OpenAPI operation". The MCP `call_api`
 * tool and the sandbox's `api.call()` both go through it, so there is exactly one place
 * where policy, authentication and validation are applied (SPEC.md §33).
 */
import type { PortolanConfig } from '../config/schema.js';
import { PortolanError } from '../errors/errors.js';
import type { Logger } from '../logging.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import { safeFetch } from '../net/safe-fetch.js';
import {
  applyPathTemplate,
  buildQueryString,
  parameterSpec,
  serializeCookieParameter,
  serializeHeaderParameter,
  serializePathParameter,
  serializeQueryParameter,
  type SerializedQueryPair,
} from '../openapi/serialization.js';
import {
  SchemaValidator,
  validateParameters,
  validateRequestBody,
  type SchemaDialect,
} from '../openapi/validation.js';
import { isRecord, type OpenApiDocument, type OpenApiParameter } from '../openapi/types.js';
import type { CallApiInput, CallApiResult, RequestContext } from '../services/types.js';
import type { Catalog } from '../catalog/catalog.js';
import type { AuthResolver } from './auth.js';
import { assertDestinationAllowed, assertMutationAllowed, buildRequestUrl } from './policy.js';
import {
  parseResponseBody,
  parseContentType,
  sanitizeResponseHeaders,
  sanitizeUrl,
} from './response.js';

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

/** Content types Portolan knows how to encode a request body into (SPEC.md §51). */
const SUPPORTED_REQUEST_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
] as const;

export interface CallerOptions {
  catalog: Catalog;
  config: PortolanConfig;
  auth: AuthResolver;
  logger: Logger;
  policy: NetworkPolicyOptions;
}

export class Caller {
  /** One validator per API version; schema compilation is expensive to repeat. */
  private readonly validators = new Map<string, SchemaValidator>();

  constructor(private readonly options: CallerOptions) {}

  async call(input: CallApiInput, context: RequestContext): Promise<CallApiResult> {
    const started = Date.now();
    const { catalog, config, policy } = this.options;

    // --- resolve -----------------------------------------------------------
    const resolved = catalog.resolveOperation(input.apiId, input.operationId);
    const environment = catalog.resolveEnvironment(input.apiId, input.environment);
    const stored = JSON.parse(resolved.operation.operationJson) as StoredOperation;

    // --- policy ------------------------------------------------------------
    assertMutationAllowed(environment, stored.method, stored.canonical_id);

    // --- validate ----------------------------------------------------------
    const validator = this.validatorFor(
      resolved.version.id,
      resolved.version.specJson,
      resolved.version.openapiVersion,
    );
    const validated = validateParameters({
      parameters: stored.parameters ?? [],
      supplied: input.parameters ?? {},
      validator,
      operationId: stored.canonical_id,
    });

    const bodyPlan = this.planRequestBody(stored, input, validator);

    // --- serialize ---------------------------------------------------------
    const declared = new Map<string, OpenApiParameter>();
    for (const parameter of stored.parameters ?? []) {
      if (typeof parameter.name === 'string' && parameter.in) {
        declared.set(`${parameter.in}:${parameter.name}`, parameter);
      }
    }

    const pathValues = new Map<string, string>();
    for (const [name, value] of validated.values.path) {
      const parameter = declared.get(`path:${name}`)!;
      pathValues.set(name, serializePathParameter(parameterSpec(parameter, 'path'), value));
    }

    const queryPairs: SerializedQueryPair[] = [];
    for (const [name, value] of validated.values.query) {
      const parameter = declared.get(`query:${name}`)!;
      queryPairs.push(...serializeQueryParameter(parameterSpec(parameter, 'query'), value));
    }

    const headers: Record<string, string> = { accept: 'application/json, */*;q=0.8' };
    for (const [name, value] of validated.values.header) {
      const parameter = declared.get(`header:${name}`)!;
      headers[name.toLowerCase()] = serializeHeaderParameter(
        parameterSpec(parameter, 'header'),
        value,
      );
    }

    const cookies: [string, string][] = [];
    for (const [name, value] of validated.values.cookie) {
      const parameter = declared.get(`cookie:${name}`)!;
      cookies.push([name, serializeCookieParameter(parameterSpec(parameter, 'cookie'), value)]);
    }

    // --- construct URL -----------------------------------------------------
    const path = applyPathTemplate(stored.path, pathValues);
    const url = buildRequestUrl(environment.baseUrl, path, buildQueryString(queryPairs));
    const destination = assertDestinationAllowed(url, policy);

    // --- authenticate ------------------------------------------------------
    const auth = await this.options.auth.apply(environment.authProfile, destination.hostname);
    Object.assign(headers, auth.headers);
    for (const [name, value] of auth.cookies) cookies.push([name, value]);

    let finalUrl = url;
    if (auth.query.length > 0) {
      const parsed = new URL(url);
      for (const [name, value] of auth.query) parsed.searchParams.append(name, value);
      finalUrl = parsed.toString();
    }
    if (cookies.length > 0) {
      headers.cookie = cookies.map(([name, value]) => `${name}=${value}`).join('; ');
    }
    if (bodyPlan.contentType) headers['content-type'] = bodyPlan.contentType;

    // --- execute -----------------------------------------------------------
    const timeoutMs = Math.min(
      input.timeoutMs ?? config.limits.default_timeout_ms,
      config.limits.max_timeout_ms,
    );

    this.options.logger.info(
      {
        request_id: context.requestId,
        api_id: input.apiId,
        operation_id: stored.canonical_id,
        environment: environment.name,
        method: stored.method,
        host: destination.hostname,
      },
      'api call',
    );

    const response = await safeFetch(finalUrl, {
      method: stored.method,
      headers,
      ...(bodyPlan.body === undefined ? {} : { body: bodyPlan.body }),
      timeoutMs,
      maxBytes: config.limits.max_response_bytes,
      maxRedirects: config.limits.max_redirects,
      policy,
      credentialHeaders: [
        ...auth.credentialHeaders,
        'cookie',
        'authorization',
        'proxy-authorization',
      ],
    });

    const durationMs = Date.now() - started;
    const contentType = parseContentType(response.headers['content-type']).type;
    const parsed = parseResponseBody(response.body, contentType, {
      truncated: response.truncated,
      maxBase64Bytes: Math.min(config.limits.max_tool_response_bytes / 2, 131_072),
    });

    this.options.logger.info(
      {
        request_id: context.requestId,
        api_id: input.apiId,
        operation_id: stored.canonical_id,
        status: response.status,
        duration_ms: durationMs,
        truncated: response.truncated,
      },
      'api response',
    );

    const result: CallApiResult = {
      request: {
        operation_id: stored.canonical_id,
        method: stored.method,
        url: sanitizeUrl(response.url, auth.credentialQueryParams),
      },
      response: {
        status: response.status,
        status_text: response.statusText,
        headers: sanitizeResponseHeaders(response.headers),
        ...(contentType ? { content_type: contentType } : {}),
        body: parsed.body,
        ...(response.truncated ? { truncated: true } : {}),
      },
      duration_ms: durationMs,
    };

    if (validated.unknown.length > 0) {
      // Reported, not silently dropped: an agent that misspelled a parameter needs to know.
      result.warnings = [
        `Ignored undeclared parameter(s): ${validated.unknown
          .map((p) => `${p.name} (in ${p.in})`)
          .join(
            ', ',
          )}. Use inspect_api to see the declared parameters for '${stored.canonical_id}'.`,
      ];
    }
    if (parsed.encoding === 'base64') result.response.body_encoding = 'base64';
    return result;
  }

  private validatorFor(
    versionId: string,
    specJson: string,
    openapiVersion: string | null,
  ): SchemaValidator {
    const cached = this.validators.get(versionId);
    if (cached) return cached;
    const document = JSON.parse(specJson) as OpenApiDocument;
    const components = isRecord(document.components?.schemas) ? document.components.schemas : {};
    const dialect: SchemaDialect = openapiVersion?.startsWith('3.1') ? '3.1' : '3.0';
    const validator = new SchemaValidator(dialect, components);
    this.validators.set(versionId, validator);
    return validator;
  }

  /** Choose a content type, validate the body against its schema, and encode it. */
  private planRequestBody(
    stored: StoredOperation,
    input: CallApiInput,
    validator: SchemaValidator,
  ): { body: Buffer | string | undefined; contentType: string | undefined } {
    const requestBody = isRecord(stored.operation.requestBody)
      ? stored.operation.requestBody
      : undefined;
    const content = isRecord(requestBody?.content) ? requestBody.content : undefined;

    if (!content || Object.keys(content).length === 0) {
      if (input.body !== undefined && input.body !== null) {
        throw new PortolanError(
          'REQUEST_BODY_INVALID',
          `Operation '${stored.canonical_id}' does not declare a request body, but one was supplied.`,
          { operation_id: stored.canonical_id },
        );
      }
      return { body: undefined, contentType: undefined };
    }

    const available = Object.keys(content);
    const requested = input.contentType?.toLowerCase();
    const chosen = requested
      ? available.find((type) => type.toLowerCase() === requested)
      : (available.find((type) => SUPPORTED_REQUEST_TYPES.includes(type.toLowerCase() as never)) ??
        available[0]);

    if (!chosen) {
      throw new PortolanError(
        'CONTENT_TYPE_UNSUPPORTED',
        `Operation '${stored.canonical_id}' does not declare content type '${input.contentType}'. It declares: ${available.join(', ')}.`,
        { operation_id: stored.canonical_id, requested: input.contentType, available },
      );
    }

    if (input.body === undefined || input.body === null) {
      if (requestBody?.required === true) {
        throw new PortolanError(
          'REQUEST_BODY_INVALID',
          `Operation '${stored.canonical_id}' requires a request body.`,
          { operation_id: stored.canonical_id, content_types: available },
        );
      }
      return { body: undefined, contentType: undefined };
    }

    const media = isRecord(content[chosen]) ? content[chosen] : {};
    if (media.schema !== undefined) {
      validateRequestBody(media.schema, input.body, validator, stored.canonical_id, chosen);
    }

    return encodeBody(input.body, chosen, stored.canonical_id);
  }
}

function encodeBody(
  body: unknown,
  contentType: string,
  operationId: string,
): { body: Buffer | string; contentType: string } {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (base === 'application/x-www-form-urlencoded') {
    if (!isRecord(body)) {
      throw new PortolanError(
        'REQUEST_BODY_INVALID',
        `A ${base} body must be an object of field names to values.`,
        { operation_id: operationId, content_type: contentType },
      );
    }
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const entry of value) form.append(key, scalar(entry));
      else form.append(key, scalar(value));
    }
    return { body: form.toString(), contentType: base };
  }

  if (base === 'multipart/form-data') {
    if (!isRecord(body)) {
      throw new PortolanError(
        'REQUEST_BODY_INVALID',
        'A multipart/form-data body must be an object of field names to values.',
        { operation_id: operationId, content_type: contentType },
      );
    }
    return encodeMultipart(body);
  }

  if (base === 'text/plain' || base.startsWith('text/')) {
    return { body: typeof body === 'string' ? body : JSON.stringify(body), contentType: base };
  }

  if (base === 'application/octet-stream') {
    if (typeof body !== 'string') {
      throw new PortolanError(
        'REQUEST_BODY_INVALID',
        'A binary body must be supplied as a base64-encoded string.',
        { operation_id: operationId, content_type: contentType },
      );
    }
    return { body: Buffer.from(body, 'base64'), contentType: base };
  }

  // JSON and anything JSON-shaped (application/*+json).
  return { body: JSON.stringify(body), contentType };
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/**
 * Encode a multipart body. Values are sent as text parts; a part may be given as
 * `{ filename, content_type?, content_base64 }` to attach encoded binary content
 * (SPEC.md §51).
 */
function encodeMultipart(body: Record<string, unknown>): { body: Buffer; contentType: string } {
  const boundary = `portolan-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const parts: Buffer[] = [];

  const push = (name: string, value: unknown) => {
    if (isRecord(value) && typeof value.content_base64 === 'string') {
      const filename = typeof value.filename === 'string' ? value.filename : name;
      const type =
        typeof value.content_type === 'string' ? value.content_type : 'application/octet-stream';
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
            `Content-Type: ${type}\r\n\r\n`,
        ),
        Buffer.from(value.content_base64, 'base64'),
        Buffer.from('\r\n'),
      );
      return;
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${scalar(value)}\r\n`,
      ),
    );
  };

  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const entry of value) push(name, entry);
    else push(name, value);
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
