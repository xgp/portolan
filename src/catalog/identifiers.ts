/** API and operation identifier derivation (SPEC.md §13, §14). */
import { sha256Hex } from '../ids.js';

/**
 * Derive a stable slug from a title (SPEC.md §13): lowercase, ASCII where practical,
 * spaces to hyphens, punctuation removed.
 */
export function slugify(input: string): string {
  const ascii = input
    .normalize('NFKD')
    // Strip combining marks so "Ökonomie" becomes "okonomie" rather than "konomie".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ');

  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return slug;
}

const API_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidApiId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && API_ID_PATTERN.test(id);
}

export function deriveApiId(title: string | undefined): string {
  const slug = slugify(title ?? '');
  return slug || 'api';
}

/**
 * SPEC.md §14: the canonical operation id is the `operationId` when it exists and is
 * unique within the document, and `method:path` otherwise. Deterministic across imports
 * as long as method, path and operationId are unchanged.
 */
export function canonicalOperationId(
  method: string,
  path: string,
  operationId: string | undefined,
  duplicateOperationIds: ReadonlySet<string>,
): string {
  if (operationId && operationId.trim() !== '' && !duplicateOperationIds.has(operationId)) {
    return operationId;
  }
  return `${method.toLowerCase()}:${path}`;
}

/** Deterministic row id so repeated imports of the same document produce the same keys. */
export function operationRowId(apiVersionId: string, canonicalId: string): string {
  return sha256Hex(`${apiVersionId.length}:${apiVersionId}:${canonicalId}`).slice(0, 32);
}

export function apiVersionId(apiId: string, specHash: string): string {
  return sha256Hex(`${apiId.length}:${apiId}:${specHash}`).slice(0, 32);
}
