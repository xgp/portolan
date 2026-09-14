/**
 * Normalization and metadata derivation (SPEC.md §10, §44).
 */
import { createHash } from 'node:crypto';
import { isRecord, type OpenApiDocument } from '../openapi/types.js';

/**
 * Canonical JSON: object keys sorted, no incidental whitespace. Two documents that differ
 * only in key order or formatting therefore produce the same hash, which is what makes
 * SPEC.md §44's "unchanged" result meaningful for a YAML document re-imported as JSON.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function specHash(document: OpenApiDocument): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}

export interface DerivedMetadata {
  title: string | undefined;
  description: string | undefined;
  infoVersion: string | undefined;
  openapiVersion: string | undefined;
  serverUrls: string[];
  tags: string[];
  warnings: string[];
}

export function deriveMetadata(document: OpenApiDocument): DerivedMetadata {
  const warnings: string[] = [];
  const info = document.info ?? {};

  const serverUrls: string[] = [];
  const servers = Array.isArray(document.servers) ? document.servers : [];
  for (const server of servers) {
    const url = resolveServerUrl(server);
    if (url) serverUrls.push(url);
  }
  if (serverUrls.length === 0) {
    warnings.push(
      'The specification declares no usable servers entry; supply default_base_url or configure an environment before calling operations.',
    );
  }

  const tags = Array.isArray(document.tags)
    ? document.tags
        .map((t) => (isRecord(t) && typeof t.name === 'string' ? t.name : undefined))
        .filter((t): t is string => typeof t === 'string')
    : [];

  return {
    title: typeof info.title === 'string' ? info.title : undefined,
    description: typeof info.description === 'string' ? info.description : undefined,
    infoVersion: typeof info.version === 'string' ? info.version : undefined,
    openapiVersion: typeof document.openapi === 'string' ? document.openapi : undefined,
    serverUrls,
    tags,
    warnings,
  };
}

/**
 * Substitute OpenAPI server-variable defaults. A server URL that still contains an
 * unsubstituted `{variable}` after this is unusable and is dropped.
 */
export function resolveServerUrl(server: unknown): string | undefined {
  if (!isRecord(server) || typeof server.url !== 'string') return undefined;
  let url = server.url;
  const variables = isRecord(server.variables) ? server.variables : {};
  url = url.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    const variable = variables[name];
    const fallback =
      isRecord(variable) && typeof variable.default === 'string' ? variable.default : undefined;
    return fallback ?? match;
  });
  if (url.includes('{')) return undefined;
  // Relative server URLs ("/v1") have no host and cannot be executed against on their own.
  if (!/^https?:\/\//i.test(url)) return undefined;
  return url.replace(/\/+$/, '');
}
