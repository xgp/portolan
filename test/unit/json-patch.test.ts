/** RFC 6902 JSON Patch (docs/DEVIATIONS.md D20). */
import { describe, expect, it } from 'vitest';
import {
  applyJsonPatch,
  assertJsonPatch,
  getAtPointer,
  JsonPatchError,
  parsePointer,
  toPointer,
} from '../../src/openapi/json-patch.js';

const doc = () => ({
  paths: { '/users/{id}': { get: { parameters: [{ name: 'a' }, { name: 'b' }] } } },
  tilde: { 'a~b': 1 },
});

describe('JSON Pointer', () => {
  it('escapes "/" and "~" in both directions', () => {
    expect(toPointer(['paths', '/users/{id}', 'get'])).toBe('/paths/~1users~1{id}/get');
    expect(parsePointer('/tilde/a~0b')).toEqual(['tilde', 'a~b']);
    expect(getAtPointer(doc(), '/paths/~1users~1{id}/get/parameters/1/name')).toBe('b');
    expect(getAtPointer(doc(), '/tilde/a~0b')).toBe(1);
  });

  it('returns undefined for a missing segment instead of throwing', () => {
    expect(getAtPointer(doc(), '/paths/~1nope/get')).toBeUndefined();
    expect(getAtPointer(doc(), '/paths/~1users~1{id}/get/parameters/9')).toBeUndefined();
    expect(getAtPointer(doc(), '/paths/~1users~1{id}/get/parameters/01')).toBeUndefined();
  });
});

describe('applyJsonPatch', () => {
  const params = '/paths/~1users~1{id}/get/parameters';

  it('applies every RFC 6902 operation', () => {
    const result = applyJsonPatch(doc(), [
      { op: 'test', path: `${params}/0/name`, value: 'a' },
      { op: 'add', path: `${params}/-`, value: { name: 'c' } },
      { op: 'add', path: `${params}/0`, value: { name: 'first' } },
      { op: 'replace', path: `${params}/1/name`, value: 'A' },
      { op: 'remove', path: `${params}/2` },
      { op: 'copy', from: `${params}/0`, path: '/copied' },
      { op: 'move', from: '/tilde', path: '/moved' },
    ]);
    expect(getAtPointer(result, params)).toEqual([{ name: 'first' }, { name: 'A' }, { name: 'c' }]);
    expect(result).toMatchObject({ copied: { name: 'first' }, moved: { 'a~b': 1 } });
    expect(result).not.toHaveProperty('tilde');
  });

  it('never mutates its input', () => {
    const input = doc();
    const before = JSON.stringify(input);
    applyJsonPatch(input, [{ op: 'remove', path: '/tilde' }]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('fails, naming the operation, rather than skipping a target that is not there', () => {
    const cases = [
      { op: 'replace', path: '/nope', value: 1 },
      { op: 'remove', path: `${params}/5` },
      { op: 'add', path: '/missing/parent', value: 1 },
      { op: 'test', path: `${params}/0/name`, value: 'not-a' },
      { op: 'move', from: '/paths', path: '/paths/inside' },
    ] as const;
    for (const operation of cases) {
      expect(() =>
        applyJsonPatch(doc(), [{ op: 'test', path: '/tilde', value: { 'a~b': 1 } }, operation]),
      ).toThrow(JsonPatchError);
    }
    try {
      applyJsonPatch(doc(), [{ op: 'test', path: '/tilde', value: { 'a~b': 1 } }, cases[0]]);
    } catch (error) {
      expect((error as JsonPatchError).index).toBe(1);
      expect((error as Error).message).toMatch(/operation 1 \(replace \/nope\)/);
    }
  });

  it('compares test values structurally, ignoring key order', () => {
    expect(() =>
      applyJsonPatch({ a: { x: 1, y: 2 } }, [{ op: 'test', path: '/a', value: { y: 2, x: 1 } }]),
    ).not.toThrow();
  });
});

describe('assertJsonPatch', () => {
  it('rejects malformed operations with SPEC_PATCH_INVALID', () => {
    for (const bad of [
      {},
      [{ op: 'frobnicate', path: '/a' }],
      [{ op: 'add', path: 'a', value: 1 }],
      [{ op: 'add', path: '/a' }],
      [{ op: 'move', path: '/a' }],
    ]) {
      expect(() => assertJsonPatch(bad)).toThrow(
        expect.objectContaining({ code: 'SPEC_PATCH_INVALID' }),
      );
    }
    expect(assertJsonPatch([{ op: 'remove', path: '/a' }])).toHaveLength(1);
  });
});
