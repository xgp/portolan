/** OpenAPI parameter serialization (SPEC.md §22). */
import { describe, expect, it } from 'vitest';
import {
  applyPathTemplate,
  buildQueryString,
  encodeValue,
  parameterSpec,
  serializeCookieParameter,
  serializeHeaderParameter,
  serializePathParameter,
  serializeQueryParameter,
} from '../../src/openapi/serialization.js';
import type { ParameterLocation } from '../../src/openapi/types.js';

function spec(location: ParameterLocation, overrides: Record<string, unknown> = {}, name = 'p') {
  return parameterSpec({ name, in: location, ...overrides }, location);
}

function query(parameter: Record<string, unknown>, value: unknown, name = 'p') {
  return buildQueryString(serializeQueryParameter(spec('query', parameter, name), value));
}

describe('style defaults', () => {
  it('defaults to simple for path and header, form for query and cookie', () => {
    expect(spec('path').style).toBe('simple');
    expect(spec('header').style).toBe('simple');
    expect(spec('query').style).toBe('form');
    expect(spec('cookie').style).toBe('form');
  });

  it('defaults explode to true only for form', () => {
    expect(spec('query').explode).toBe(true);
    expect(spec('cookie').explode).toBe(true);
    expect(spec('path').explode).toBe(false);
    expect(spec('header').explode).toBe(false);
    expect(spec('query', { style: 'pipeDelimited' }).explode).toBe(false);
    // deepObject is only defined exploded, and documents routinely omit the flag.
    expect(spec('query', { style: 'deepObject' }).explode).toBe(true);
  });
});

describe('path parameters', () => {
  it('serializes primitives', () => {
    expect(serializePathParameter(spec('path'), 5)).toBe('5');
    expect(serializePathParameter(spec('path'), 'blue')).toBe('blue');
    expect(serializePathParameter(spec('path'), true)).toBe('true');
  });

  it('percent-encodes reserved characters', () => {
    expect(serializePathParameter(spec('path'), 'a/b c')).toBe('a%2Fb%20c');
    expect(serializePathParameter(spec('path'), 'user@example.com')).toBe('user%40example.com');
  });

  it('leaves reserved characters when allowReserved is set', () => {
    expect(serializePathParameter(spec('path', { allowReserved: true }), 'a/b')).toBe('a/b');
  });

  it.each([
    ['simple', false, 'blue,black,brown'],
    ['simple', true, 'blue,black,brown'],
    ['label', false, '.blue,black,brown'],
    ['label', true, '.blue.black.brown'],
    ['matrix', false, ';p=blue,black,brown'],
    ['matrix', true, ';p=blue;p=black;p=brown'],
  ])('serializes an array with style %s explode=%s', (style, explode, expected) => {
    expect(
      serializePathParameter(spec('path', { style, explode }), ['blue', 'black', 'brown']),
    ).toBe(expected);
  });

  it.each([
    ['simple', false, 'R,100,G,200'],
    ['simple', true, 'R=100,G=200'],
    ['label', false, '.R,100,G,200'],
    ['label', true, '.R=100.G=200'],
    ['matrix', false, ';p=R,100,G,200'],
    ['matrix', true, ';R=100;G=200'],
  ])('serializes an object with style %s explode=%s', (style, explode, expected) => {
    expect(serializePathParameter(spec('path', { style, explode }), { R: 100, G: 200 })).toBe(
      expected,
    );
  });

  it('substitutes into a path template', () => {
    const values = new Map([
      ['realm', 'master'],
      ['user-id', 'abc%20def'],
    ]);
    expect(applyPathTemplate('/admin/realms/{realm}/users/{user-id}', values)).toBe(
      '/admin/realms/master/users/abc%20def',
    );
  });

  it('fails loudly when a template placeholder has no value', () => {
    expect(() => applyPathTemplate('/users/{id}', new Map())).toThrow(
      /Path parameter 'id' is required/,
    );
  });
});

describe('query parameters', () => {
  it('serializes primitives', () => {
    expect(query({}, 'blue')).toBe('p=blue');
    expect(query({}, 5)).toBe('p=5');
    expect(query({}, false)).toBe('p=false');
  });

  it.each([
    ['form', true, 'p=blue&p=black&p=brown'],
    ['form', false, 'p=blue,black,brown'],
    ['spaceDelimited', false, 'p=blue%20black%20brown'],
    ['pipeDelimited', false, 'p=blue|black|brown'],
  ])('serializes an array with style %s explode=%s', (style, explode, expected) => {
    expect(query({ style, explode }, ['blue', 'black', 'brown'])).toBe(expected);
  });

  it.each([
    ['form', true, 'R=100&G=200'],
    ['form', false, 'p=R,100,G,200'],
    ['deepObject', true, 'p%5BR%5D=100&p%5BG%5D=200'],
  ])('serializes an object with style %s explode=%s', (style, explode, expected) => {
    expect(query({ style, explode }, { R: 100, G: 200 })).toBe(expected);
  });

  it('percent-encodes values', () => {
    expect(query({}, 'a b&c=d')).toBe('p=a%20b%26c%3Dd');
  });

  it('honours allowReserved', () => {
    expect(query({ allowReserved: true }, 'a/b:c')).toBe('p=a/b:c');
  });

  it('emits a bare name for an empty value', () => {
    expect(query({}, '')).toBe('p');
  });
});

describe('header and cookie parameters', () => {
  it('serializes header arrays and objects', () => {
    expect(serializeHeaderParameter(spec('header'), ['a', 'b'])).toBe('a,b');
    expect(serializeHeaderParameter(spec('header'), { R: 1, G: 2 })).toBe('R,1,G,2');
    expect(serializeHeaderParameter(spec('header', { explode: true }), { R: 1, G: 2 })).toBe(
      'R=1,G=2',
    );
  });

  it('does not percent-encode header values', () => {
    expect(serializeHeaderParameter(spec('header'), 'a b/c')).toBe('a b/c');
  });

  it('encodes cookie values', () => {
    expect(serializeCookieParameter(spec('cookie'), 'a b')).toBe('a%20b');
    expect(serializeCookieParameter(spec('cookie'), ['a', 'b'])).toBe('a,b');
  });
});

// SPEC.md §22: "Unsupported combinations must fail explicitly rather than silently
// generating an incorrect request."
describe('undefined combinations fail explicitly', () => {
  it('rejects a style that is not valid for the location', () => {
    expect(() => spec('path', { style: 'form' })).toThrow(/does not define/);
    expect(() => spec('query', { style: 'matrix' })).toThrow(/does not define/);
    expect(() => spec('header', { style: 'deepObject' })).toThrow(/does not define/);
    expect(() => spec('cookie', { style: 'pipeDelimited' })).toThrow(/does not define/);
  });

  it('rejects spaceDelimited and pipeDelimited with explode=true', () => {
    expect(() => spec('query', { style: 'spaceDelimited', explode: true })).toThrow(/undefined/);
    expect(() => spec('query', { style: 'pipeDelimited', explode: true })).toThrow(/undefined/);
  });

  it('rejects an explicit deepObject with explode=false', () => {
    expect(() => spec('query', { style: 'deepObject', explode: false })).toThrow(/undefined/);
  });

  it('rejects deepObject applied to a non-object value', () => {
    expect(() => query({ style: 'deepObject' }, ['a', 'b'])).toThrow(/only for objects/);
    expect(() => query({ style: 'deepObject' }, 'scalar')).toThrow(/only for objects/);
  });

  it('rejects a non-JSON content parameter', () => {
    expect(() =>
      parameterSpec({ name: 'p', in: 'query', content: { 'application/xml': {} } }, 'query'),
    ).toThrow(/only JSON content parameters/);
  });

  it('serializes a JSON content parameter', () => {
    const s = parameterSpec(
      { name: 'p', in: 'query', content: { 'application/json': {} } },
      'query',
    );
    expect(buildQueryString(serializeQueryParameter(s, { a: 1 }))).toBe('p=%7B%22a%22%3A1%7D');
  });
});

describe('encodeValue', () => {
  it('escapes the characters encodeURIComponent leaves alone', () => {
    expect(encodeValue("!'()*", false)).toBe('%21%27%28%29%2A');
  });
});
