/** Response shaping, sanitization and tool-payload limits (SPEC.md §24, §37, §51). */
import { describe, expect, it } from 'vitest';
import {
  isJsonContentType,
  parseContentType,
  parseResponseBody,
  sanitizeResponseHeaders,
  sanitizeUrl,
} from '../../src/execution/response.js';
import { toolError, toolSuccess } from '../../src/mcp/tool-result.js';
import { PortolanError } from '../../src/errors/errors.js';

describe('content type parsing', () => {
  it('splits the type from its parameters', () => {
    expect(parseContentType('application/json; charset=utf-8')).toEqual({
      type: 'application/json',
      charset: 'utf-8',
    });
    expect(parseContentType('TEXT/HTML')).toEqual({ type: 'text/html' });
    expect(parseContentType(undefined)).toEqual({ type: '' });
  });

  it('recognises JSON media types including +json suffixes', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/hal+json')).toBe(true);
    expect(isJsonContentType('application/problem+json')).toBe(true);
    expect(isJsonContentType('text/json')).toBe(true);
    expect(isJsonContentType('application/jsonl')).toBe(false);
    expect(isJsonContentType('text/plain')).toBe(false);
  });
});

describe('body parsing', () => {
  const options = { truncated: false, maxBase64Bytes: 1024 };

  it('parses JSON', () => {
    expect(parseResponseBody(Buffer.from('{"a":1}'), 'application/json', options).body).toEqual({
      a: 1,
    });
  });

  it('returns malformed JSON as text rather than failing the call', () => {
    expect(parseResponseBody(Buffer.from('{not json'), 'application/json', options).body).toBe(
      '{not json',
    );
  });

  it('does not attempt to parse a truncated JSON body', () => {
    const result = parseResponseBody(Buffer.from('{"a":1'), 'application/json', {
      ...options,
      truncated: true,
    });
    expect(typeof result.body).toBe('string');
  });

  it('returns text media types as text', () => {
    expect(parseResponseBody(Buffer.from('<p>hi</p>'), 'text/html', options).body).toBe(
      '<p>hi</p>',
    );
    expect(parseResponseBody(Buffer.from('<a/>'), 'application/xml', options).body).toBe('<a/>');
  });

  it('returns an empty body as null', () => {
    expect(parseResponseBody(Buffer.alloc(0), 'application/json', options).body).toBeNull();
  });

  // SPEC.md §51: "Do not decode arbitrary binary content into text."
  it('returns small binary content as base64', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const result = parseResponseBody(bytes, 'image/png', options);
    expect(result.encoding).toBe('base64');
    expect(Buffer.from(result.body as string, 'base64')).toEqual(bytes);
  });

  it('describes oversized binary content instead of returning it', () => {
    const bytes = Buffer.alloc(4096, 1);
    const result = parseResponseBody(bytes, 'application/octet-stream', options);
    expect(result.encoding).toBeUndefined();
    expect(result.body).toMatch(/4096 bytes of application\/octet-stream omitted/);
  });
});

describe('header and URL sanitization (SPEC.md §24)', () => {
  it('drops every credential-bearing header regardless of case', () => {
    expect(
      sanitizeResponseHeaders({
        'Set-Cookie': 'a=b',
        'set-cookie2': 'a=b',
        AUTHORIZATION: 'Bearer x',
        'Proxy-Authorization': 'Basic x',
        'WWW-Authenticate': 'Bearer',
        'Proxy-Authenticate': 'Basic',
        'Content-Type': 'application/json',
      }),
    ).toEqual({ 'content-type': 'application/json' });
  });

  it('strips userinfo from a URL', () => {
    expect(sanitizeUrl('https://u:p@x.example.com/a?b=1')).toBe('https://x.example.com/a?b=1');
  });

  it('redacts named credential query parameters and leaves the rest', () => {
    expect(sanitizeUrl('https://x.example.com/a?key=secret&page=2', ['key'])).toBe(
      'https://x.example.com/a?key=REDACTED&page=2',
    );
  });

  it('does not throw on an unparsable URL', () => {
    expect(sanitizeUrl('not a url')).toBe('[unparsable-url]');
  });
});

describe('tool payload limits (SPEC.md §37)', () => {
  it('returns a payload that fits, with structured content', () => {
    const result = toolSuccess({ a: 1 }, 1024);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ a: 1 });
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ a: 1 });
  });

  it('replaces an oversized payload with an actionable error', () => {
    const result = toolSuccess({ data: 'x'.repeat(10_000) }, 500);
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.error.code).toBe('RESPONSE_TOO_LARGE');
    expect(payload.error.details.limit).toBe(500);
    expect(payload.error.message).toMatch(/Narrow the request/);
    // The oversized data itself is not what gets returned.
    expect((result.content[0] as any).text.length).toBeLessThan(1000);
  });

  it('handles a non-object payload without inventing structured content', () => {
    const result = toolSuccess([1, 2, 3], 1024);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse((result.content[0] as any).text)).toEqual([1, 2, 3]);
  });

  it('renders an error as a readable tool result', () => {
    const result = toolError(
      new PortolanError('MUTATION_NOT_ALLOWED', 'no writes', { environment: 'prod' }),
    );
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.error.code).toBe('MUTATION_NOT_ALLOWED');
    expect(payload.error.details.environment).toBe('prod');
    expect(result.structuredContent).toEqual(payload);
  });
});
