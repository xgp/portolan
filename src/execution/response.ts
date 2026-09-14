/**
 * Response shaping and sanitization (SPEC.md §24, §37, §51).
 */

/**
 * Headers that are dropped from every returned response.
 *
 * SPEC.md §24 names the first three. `www-authenticate` and `proxy-authenticate` are
 * added because a challenge header can echo credential material (a realm containing a
 * token, or a negotiate blob) straight back into model context.
 */
export const REDACTED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'proxy-authenticate',
]);

export function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (REDACTED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Strip userinfo and any credential-bearing query parameter from a URL (SPEC.md §24). */
export function sanitizeUrl(url: string, credentialQueryParams: readonly string[] = []): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '[unparsable-url]';
  }
  parsed.username = '';
  parsed.password = '';
  for (const name of credentialQueryParams) {
    if (parsed.searchParams.has(name)) parsed.searchParams.set(name, 'REDACTED');
  }
  return parsed.toString();
}

export function parseContentType(value: string | undefined): { type: string; charset?: string } {
  if (!value) return { type: '' };
  const [rawType, ...parameters] = value.split(';');
  const type = (rawType ?? '').trim().toLowerCase();
  const charsetParameter = parameters
    .map((p) => p.trim())
    .find((p) => p.toLowerCase().startsWith('charset='));
  const charset = charsetParameter?.slice('charset='.length).replace(/^["']|["']$/g, '');
  return charset ? { type, charset } : { type };
}

export function isJsonContentType(type: string): boolean {
  return /^application\/(\w[\w.+-]*\+)?json$/.test(type) || type === 'text/json';
}

export function isTextContentType(type: string): boolean {
  return (
    type.startsWith('text/') ||
    type === 'application/xml' ||
    type === 'application/xhtml+xml' ||
    type === 'application/javascript' ||
    type === 'application/x-www-form-urlencoded' ||
    type === 'application/graphql'
  );
}

export interface ParsedBody {
  body: unknown;
  /** Set when the payload could not be represented faithfully as text or JSON. */
  encoding?: 'base64';
}

/**
 * Turn response bytes into something an agent can reason about.
 *
 * Binary payloads are never decoded as text (SPEC.md §51); they are described and, when
 * small enough, returned as bounded base64.
 */
export function parseResponseBody(
  bytes: Buffer,
  contentType: string,
  options: { truncated: boolean; maxBase64Bytes: number },
): ParsedBody {
  if (bytes.length === 0) return { body: null };

  if (isJsonContentType(contentType) && !options.truncated) {
    try {
      return { body: JSON.parse(bytes.toString('utf8')) };
    } catch {
      // Fall through: a malformed JSON body is more useful as text than as an error.
      return { body: bytes.toString('utf8') };
    }
  }

  if (isJsonContentType(contentType) || isTextContentType(contentType) || contentType === '') {
    return { body: bytes.toString('utf8') };
  }

  if (bytes.length <= options.maxBase64Bytes) {
    return { body: bytes.toString('base64'), encoding: 'base64' };
  }
  return {
    body: `[${bytes.length} bytes of ${contentType} omitted: larger than the ${options.maxBase64Bytes}-byte inline limit]`,
  };
}
