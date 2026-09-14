import { describe, expect, it } from 'vitest';
import { prepareQuery, quoteTerm, tokenize } from '../../src/search/query.js';
import { matchedTerms, normalizeScore, termCoverageBonus } from '../../src/search/ranking.js';

describe('FTS query preparation', () => {
  it('tokenizes on non-alphanumeric boundaries', () => {
    expect(tokenize('find user by e-mail!')).toEqual(['find', 'user', 'by', 'e', 'mail']);
  });

  it('drops stop words but keeps the meaningful terms', () => {
    expect(prepareQuery('how do I find a user by their email').terms).toEqual([
      'find',
      'user',
      'email',
    ]);
  });

  it('keeps something searchable when the query is only stop words', () => {
    const prepared = prepareQuery('the and of');
    expect(prepared.terms.length).toBeGreaterThan(0);
    expect(prepared.match).not.toBeNull();
  });

  it('returns a null match for a query with nothing in it', () => {
    expect(prepareQuery('   ').match).toBeNull();
    expect(prepareQuery('!!! ???').match).toBeNull();
  });

  // The important safety property: FTS5 query syntax in the input must be inert.
  it.each([
    '"',
    'user" OR api_id:"x',
    'NEAR/3(a b)',
    'a AND NOT b',
    'foo*',
    '(((',
    'col:value',
    '^anchor',
    String.raw`back\slash`,
  ])('renders %j inert rather than as FTS5 syntax', (input) => {
    const prepared = prepareQuery(input);
    if (prepared.match === null) return;
    // Every quoted section is a literal; no bare operators or punctuation survive.
    const withoutLiterals = prepared.match.replace(/"(?:[^"]|"")*"\*/g, 'T');
    expect(withoutLiterals).toMatch(/^T( OR T)*$/);
  });

  it('escapes a double quote inside a term even if tokenization is bypassed', () => {
    expect(quoteTerm('a"b')).toBe('"a""b"*');
  });

  it('expands domain synonyms without duplicating the original terms', () => {
    const prepared = prepareQuery('disable user');
    expect(prepared.terms).toEqual(['disable', 'user']);
    expect(prepared.expansions).toContain('deactivate');
    expect(prepared.expansions).toContain('enabled');
    expect(prepared.expansions).toContain('account');
    for (const term of prepared.terms) expect(prepared.expansions).not.toContain(term);
  });

  it('can be asked not to expand', () => {
    expect(prepareQuery('disable user', { expand: false }).expansions).toEqual([]);
  });

  it('bounds the number of terms sent to SQLite', () => {
    const long = Array.from({ length: 200 }, (_, i) => `term${i}`).join(' ');
    expect(prepareQuery(long).match!.split(' OR ')).toHaveLength(64);
  });
});

describe('score shaping', () => {
  it('maps bm25 relevance into (0,1) monotonically', () => {
    expect(normalizeScore(0)).toBe(0);
    expect(normalizeScore(-5)).toBe(0);
    expect(normalizeScore(1)).toBeGreaterThan(0);
    expect(normalizeScore(4)).toBeGreaterThan(normalizeScore(1));
    expect(normalizeScore(100)).toBeLessThanOrEqual(1);
    expect(normalizeScore(100)).toBeGreaterThan(0.9);
  });

  it('rewards candidates containing the terms the caller typed', () => {
    const withBoth = termCoverageBonus(['disable a user account'], ['disable', 'user']);
    const withOne = termCoverageBonus(['deactivate a user account'], ['disable', 'user']);
    expect(withBoth).toBeGreaterThan(withOne);
    expect(termCoverageBonus(['unrelated'], ['disable', 'user'])).toBe(0);
    expect(termCoverageBonus(['anything'], [])).toBe(0);
  });

  it('reports which terms matched', () => {
    expect(matchedTerms(['Email suppression list'], ['suppression', 'email', 'invoice'])).toEqual([
      'suppression',
      'email',
    ]);
  });
});

describe('limit clamping (SPEC.md §17, §18)', () => {
  it('clamps out-of-range limits instead of rejecting them', async () => {
    const { clampLimit } = await import('../../src/mcp/tools/schemas.js');
    expect(clampLimit(undefined, 5, 20)).toBe(5);
    expect(clampLimit(3, 5, 20)).toBe(3);
    expect(clampLimit(100, 5, 20)).toBe(20);
    expect(clampLimit(0, 5, 20)).toBe(1);
    expect(clampLimit(-7, 5, 20)).toBe(1);
    expect(clampLimit(7.9, 5, 20)).toBe(7);
    expect(clampLimit(Number.NaN, 5, 20)).toBe(5);
    expect(clampLimit(Number.POSITIVE_INFINITY, 5, 20)).toBe(5);
  });
});
