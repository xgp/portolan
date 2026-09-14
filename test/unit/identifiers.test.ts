import { describe, expect, it } from 'vitest';
import {
  apiVersionId,
  canonicalOperationId,
  deriveApiId,
  isValidApiId,
  operationRowId,
  slugify,
} from '../../src/catalog/identifiers.js';

describe('api identifiers (SPEC.md §13)', () => {
  it.each([
    ['Keycloak Admin REST API', 'keycloak-admin-rest-api'],
    ['SendGrid v3 API', 'sendgrid-v3-api'],
    ['  Spaces   Everywhere  ', 'spaces-everywhere'],
    ['Punctuation!? Removed.', 'punctuation-removed'],
    ['UPPER CASE', 'upper-case'],
    ['already-a-slug', 'already-a-slug'],
  ])('slugifies %s to %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('transliterates accents rather than dropping the letters', () => {
    expect(slugify('Ökonomie API')).toBe('okonomie-api');
    expect(slugify('Café Service')).toBe('cafe-service');
  });

  it('falls back to a usable id when the title yields nothing', () => {
    expect(deriveApiId('')).toBe('api');
    expect(deriveApiId(undefined)).toBe('api');
    expect(deriveApiId('!!!')).toBe('api');
  });

  it.each([
    ['keycloak', true],
    ['stripe-live', true],
    ['a.b_c-1', true],
    ['', false],
    ['-leading', false],
    ['Upper', false],
    ['has space', false],
    ['slash/path', false],
    ['../escape', false],
  ])('validates %s as %s', (id, valid) => {
    expect(isValidApiId(id)).toBe(valid);
  });
});

describe('canonical operation identifiers (SPEC.md §14)', () => {
  const noDuplicates = new Set<string>();

  it('uses a unique operationId verbatim', () => {
    expect(canonicalOperationId('GET', '/users', 'users.list', noDuplicates)).toBe('users.list');
  });

  it('falls back to method:path when the operationId is missing', () => {
    expect(
      canonicalOperationId('PUT', '/admin/realms/{realm}/users/{user-id}', undefined, noDuplicates),
    ).toBe('put:/admin/realms/{realm}/users/{user-id}');
    expect(canonicalOperationId('GET', '/x', '   ', noDuplicates)).toBe('get:/x');
  });

  it('falls back to method:path when the operationId is duplicated', () => {
    const duplicates = new Set(['getThing']);
    expect(canonicalOperationId('GET', '/a', 'getThing', duplicates)).toBe('get:/a');
    expect(canonicalOperationId('GET', '/b', 'getThing', duplicates)).toBe('get:/b');
  });

  it('is deterministic across imports', () => {
    expect(operationRowId('v1', 'users.list')).toBe(operationRowId('v1', 'users.list'));
    expect(operationRowId('v1', 'users.list')).not.toBe(operationRowId('v2', 'users.list'));
    expect(apiVersionId('k', 'hash')).toBe(apiVersionId('k', 'hash'));
  });

  it('cannot collide across a differently split version/operation pair', () => {
    expect(operationRowId('ab', 'c')).not.toBe(operationRowId('a', 'bc'));
  });
});
