/**
 * SSRF-resistant HTTP client (SPEC.md §12, §30, §49, §50).
 *
 * The important property is that the address we *check* is the address we *connect to*.
 * A naive implementation resolves DNS, validates the result, then hands the hostname to
 * an HTTP client that resolves it again — and an attacker who controls the record can
 * answer differently the second time (DNS rebinding). Here Portolan resolves the name
 * itself, validates every returned address, and pins the socket to a validated address
 * through an undici agent with a fixed `lookup`. TLS SNI and the Host header keep the
 * original hostname, so certificates and virtual hosting still work.
 *
 * Redirects are never followed by the transport. Each hop is re-validated here, and
 * credentials are dropped whenever the origin changes.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, request as undiciRequest } from 'undici';
import { PortolanError } from '../errors/errors.js';
import {
  ALLOWED_PROTOCOLS,
  isAddressAllowed,
  isHostAllowed,
  type NetworkPolicyOptions,
} from './address-policy.js';

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | undefined;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  policy: NetworkPolicyOptions;
  /**
   * Headers stripped when a redirect crosses to a different origin (SPEC.md §30, §49).
   * Defaults to the credential-bearing set.
   */
  credentialHeaders?: readonly string[];
  signal?: AbortSignal;
}

export interface SafeFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  /** The final URL after any redirects. */
  url: string;
  redirects: string[];
}

const DEFAULT_CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
] as const;

export function blocked(message: string, details: Record<string, unknown> = {}): PortolanError {
  return new PortolanError('NETWORK_DESTINATION_BLOCKED', message, details);
}

/** Validate a URL's scheme, credentials and host against policy. Throws when refused. */
export function assertUrlAllowed(rawUrl: string, policy: NetworkPolicyOptions): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw blocked(`'${rawUrl}' is not a valid absolute URL.`, { url: rawUrl });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw blocked(
      `URL scheme '${url.protocol}' is not supported. Only https: (and http: when enabled) are fetched.`,
      { url: redactUrl(url), scheme: url.protocol },
    );
  }
  if (url.protocol === 'http:' && !policy.allowHttp) {
    throw blocked('Plain http: URLs are blocked (set network.allow_http to permit them).', {
      url: redactUrl(url),
    });
  }
  if (url.username || url.password) {
    throw blocked('URLs must not embed credentials.', { url: redactUrl(url) });
  }
  if (!isHostAllowed(url.hostname, policy)) {
    throw blocked(`Host '${url.hostname}' is not in network.allowed_hosts.`, {
      host: url.hostname,
    });
  }
  return url;
}

/**
 * Resolve a hostname and return the addresses that pass policy.
 * Every returned address is checked: if any resolved address is refused the whole
 * destination is refused, so a record mixing a public and a private answer cannot be
 * used to smuggle a connection through.
 */
export async function resolveAllowedAddress(
  hostname: string,
  policy: NetworkPolicyOptions,
): Promise<{ address: string; family: 4 | 6 }> {
  const literal = isIP(hostname.replace(/^\[|\]$/g, ''));
  if (literal) {
    const address = hostname.replace(/^\[|\]$/g, '');
    const decision = isAddressAllowed(address, policy);
    if (!decision.allowed) {
      throw blocked(`Destination ${address} is blocked: ${decision.reason}.`, {
        address,
        category: decision.category,
      });
    }
    return { address, family: literal === 4 ? 4 : 6 };
  }

  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw blocked(
      `Could not resolve host '${hostname}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { host: hostname },
    );
  }
  if (records.length === 0) {
    throw blocked(`Host '${hostname}' did not resolve to any address.`, { host: hostname });
  }

  for (const record of records) {
    const decision = isAddressAllowed(record.address, policy);
    if (!decision.allowed) {
      throw blocked(
        `Host '${hostname}' resolves to ${record.address}, which is blocked: ${decision.reason}.`,
        { host: hostname, address: record.address, category: decision.category },
      );
    }
  }

  const first = records[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** Build a dispatcher that can only ever connect to `address`. */
function pinnedAgent(address: string, family: 4 | 6, timeoutMs: number): Agent {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: (
        _hostname: string,
        _options: unknown,
        callback: (err: Error | null, address: string, family: number) => void,
      ) => {
        callback(null, address, family);
      },
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connections: 1,
    pipelining: 0,
  });
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/** Remove userinfo so a URL is safe to log or return (SPEC.md §24). */
export function redactUrl(url: URL | string): string {
  const parsed = typeof url === 'string' ? safeParse(url) : url;
  if (!parsed) return '[unparsable-url]';
  const copy = new URL(parsed.toString());
  if (copy.username || copy.password) {
    copy.username = '';
    copy.password = '';
  }
  return copy.toString();
}

function safeParse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function readCapped(
  body: AsyncIterable<Buffer | Uint8Array>,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length >= maxBytes) {
      chunks.push(buf.subarray(0, Math.max(0, maxBytes - total)));
      return { buffer: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { buffer: Buffer.concat(chunks), truncated: false };
}

function normalizeHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Perform an HTTP request under the network policy, following redirects manually.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResponse> {
  const credentialHeaders = (options.credentialHeaders ?? DEFAULT_CREDENTIAL_HEADERS).map((h) =>
    h.toLowerCase(),
  );
  const started = Date.now();
  const redirects: string[] = [];

  let currentUrl = assertUrlAllowed(rawUrl, options.policy);
  let method = options.method ?? 'GET';
  let body = options.body;
  let headers = { ...(options.headers ?? {}) };
  const origin = new URL(currentUrl.toString());

  for (let hop = 0; ; hop++) {
    const remaining = options.timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new PortolanError('REQUEST_TIMEOUT', `Request to ${redactUrl(currentUrl)} timed out.`, {
        timeout_ms: options.timeoutMs,
      });
    }

    const pinned = await resolveAllowedAddress(currentUrl.hostname, options.policy);
    const agent = pinnedAgent(pinned.address, pinned.family, remaining);
    try {
      const response = await undiciRequest(currentUrl, {
        method: method as 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
        dispatcher: agent,
        // undici does not follow redirects unless an interceptor is installed; we handle
        // every hop ourselves so policy is re-applied and credentials are dropped.

        headersTimeout: remaining,
        bodyTimeout: remaining,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const responseHeaders = normalizeHeaders(response.headers);

      if (REDIRECT_STATUSES.has(response.statusCode) && responseHeaders.location) {
        response.body.destroy();
        if (hop >= options.maxRedirects) {
          throw blocked(
            `Too many redirects (limit ${options.maxRedirects}) starting at ${redactUrl(origin)}.`,
            { redirects },
          );
        }
        const next = assertUrlAllowed(
          new URL(responseHeaders.location, currentUrl).toString(),
          options.policy,
        );
        // SPEC.md §30/§49: never carry credentials across an origin change.
        if (!sameOrigin(next, currentUrl)) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !credentialHeaders.includes(k.toLowerCase())),
          );
        }
        // 301/302/303 turn the follow-up into a GET without a body, as browsers do.
        if (
          response.statusCode === 303 ||
          ((response.statusCode === 301 || response.statusCode === 302) && method !== 'HEAD')
        ) {
          method = 'GET';
          body = undefined;
          delete headers['content-type'];
          delete headers['Content-Type'];
          delete headers['content-length'];
          delete headers['Content-Length'];
        }
        redirects.push(redactUrl(next));
        currentUrl = next;
        continue;
      }

      const { buffer, truncated } = await readCapped(response.body, options.maxBytes);
      if (truncated) response.body.destroy();

      return {
        status: response.statusCode,
        statusText: statusTextFor(response.statusCode),
        headers: responseHeaders,
        body: buffer,
        truncated,
        url: redactUrl(currentUrl),
        redirects,
      };
    } catch (error) {
      throw translateNetworkError(error, currentUrl, options.timeoutMs);
    } finally {
      void agent.close().catch(() => undefined);
    }
  }
}

function translateNetworkError(error: unknown, url: URL, timeoutMs: number): unknown {
  if (PortolanError.is(error)) return error;
  const code = (error as { code?: string } | null)?.code;
  const name = (error as { name?: string } | null)?.name;
  if (
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    name === 'AbortError' ||
    name === 'TimeoutError'
  ) {
    return new PortolanError('REQUEST_TIMEOUT', `Request to ${redactUrl(url)} timed out.`, {
      url: redactUrl(url),
      timeout_ms: timeoutMs,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PortolanError('REMOTE_API_ERROR', `Request to ${redactUrl(url)} failed: ${message}`, {
    url: redactUrl(url),
    ...(code ? { cause_code: code } : {}),
  });
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function statusTextFor(status: number): string {
  return STATUS_TEXT[status] ?? '';
}
