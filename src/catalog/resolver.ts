/**
 * Specification loading and `$ref` resolution (SPEC.md §11, §12, §45).
 *
 * Both the initial document fetch and every remote `$ref` go through {@link safeFetch},
 * so the SSRF policy applies uniformly. Filesystem resolution is disabled outright: a
 * `$ref` to `file:///etc/passwd` must not be readable, and SPEC.md §11 forbids accepting
 * filesystem paths through the MCP interface at all.
 */
import { bundle } from '@apidevtools/json-schema-ref-parser';
import { PortolanError } from '../errors/errors.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import { redactUrl, safeFetch } from '../net/safe-fetch.js';
import type { OpenApiDocument } from '../openapi/types.js';

export interface ResolverOptions {
  policy: NetworkPolicyOptions;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export interface FetchedSpec {
  text: string;
  sourceUri: string;
  contentType: string | undefined;
}

/** Fetch an OpenAPI document by URL under the network policy (SPEC.md §12). */
export async function fetchSpec(url: string, options: ResolverOptions): Promise<FetchedSpec> {
  const response = await safeFetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.5',
    },
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
    policy: options.policy,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new PortolanError(
      'SPEC_FETCH_FAILED',
      `Fetching ${redactUrl(url)} returned HTTP ${response.status}.`,
      { url: redactUrl(url), status: response.status },
    );
  }
  if (response.truncated) {
    throw new PortolanError(
      'SPEC_TOO_LARGE',
      `The document at ${redactUrl(url)} exceeds the configured max_spec_bytes of ${options.maxBytes}.`,
      { url: redactUrl(url), limit: options.maxBytes },
    );
  }

  return {
    text: response.body.toString('utf8'),
    sourceUri: response.url,
    contentType: response.headers['content-type'],
  };
}

/**
 * Bundle a document: external references are inlined, internal references are retained so
 * recursive schemas terminate (SPEC.md §45, docs/DEVIATIONS.md D11).
 *
 * `canRead` is the security gate. Anything that is not an absolute http(s) URL — a
 * `file:` ref, or a relative ref that the parser has already turned into a local
 * filesystem path — is refused before any I/O happens.
 */
export async function bundleDocument(
  document: OpenApiDocument,
  options: ResolverOptions,
  baseUri?: string,
): Promise<OpenApiDocument> {
  const seen = new Set<string>();

  const httpResolver = {
    order: 1,
    canRead: (file: { url: string }) => /^https?:\/\//i.test(file.url),
    read: async (file: { url: string }) => {
      if (seen.size >= 50) {
        throw new PortolanError(
          'SPEC_INVALID',
          'The document references more than 50 external files; refusing to continue.',
        );
      }
      seen.add(file.url);
      const fetched = await fetchSpec(file.url, options);
      return fetched.text;
    },
  };

  try {
    const bundled = (await bundle(baseUri ? { ...document, $id: baseUri } : document, {
      // SPEC.md §11/§12: no filesystem resolution, ever.
      resolve: { file: false, http: httpResolver },
      dereference: { circular: true },
      mutateInputSchema: false,
    })) as unknown as OpenApiDocument;
    if (baseUri && '$id' in bundled) delete (bundled as Record<string, unknown>).$id;
    return bundled;
  } catch (error) {
    if (PortolanError.is(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PortolanError('SPEC_INVALID', `Could not resolve document references: ${message}`);
  }
}
