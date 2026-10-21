/**
 * RFC 6902 JSON Patch and RFC 6901 JSON Pointer, over plain JSON values.
 *
 * Used to correct Portolan's stored copy of a specification (docs/DEVIATIONS.md D20).
 * The implementation is deliberately strict: an operation whose target does not exist
 * fails rather than being silently skipped, so a correction that no longer fits the
 * upstream document is detected instead of half-applied.
 */
import { canonicalJson } from '../catalog/normalizer.js';
import { PortolanError } from '../errors/errors.js';
import { isRecord } from './types.js';

export type JsonPatchOperation =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move' | 'copy'; path: string; from: string };

export const JSON_PATCH_OPS = ['add', 'remove', 'replace', 'move', 'copy', 'test'] as const;

export class JsonPatchError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(message);
    this.name = 'JsonPatchError';
  }
}

/** Split a JSON Pointer into unescaped reference tokens. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`'${pointer}' is not a JSON Pointer`);
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Build a JSON Pointer from unescaped tokens. */
export function toPointer(tokens: readonly string[]): string {
  return tokens.map((token) => `/${token.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** The value at `pointer`, or `undefined` when any segment is missing. */
export function getAtPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, token)) return undefined;
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Follow a local `#/...` reference; anything else resolves to `undefined`. */
export function resolveLocalRef(document: unknown, value: unknown): unknown {
  let current = value;
  for (
    let depth = 0;
    depth < 20 && isRecord(current) && typeof current.$ref === 'string';
    depth++
  ) {
    if (!current.$ref.startsWith('#')) return undefined;
    current = getAtPointer(document, decodeURIComponent(current.$ref.slice(1)));
  }
  return current;
}

/**
 * Apply `operations` to a deep copy of `document` and return the copy. The input is never
 * mutated. Throws {@link JsonPatchError} naming the failing operation.
 */
export function applyJsonPatch<T>(document: T, operations: readonly JsonPatchOperation[]): T {
  return applyJsonPatchInPlace(structuredClone(document), operations);
}

/**
 * As {@link applyJsonPatch}, but mutates `document`. For callers applying many small
 * patches to a large document they already own, where a copy per patch would dominate.
 * On failure the document may be partially patched.
 */
export function applyJsonPatchInPlace<T>(
  document: T,
  operations: readonly JsonPatchOperation[],
): T {
  let root: unknown = document;
  operations.forEach((operation, index) => {
    try {
      root = applyOne(root, operation);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new JsonPatchError(
        `operation ${index} (${operation.op} ${operation.path}): ${reason}`,
        index,
      );
    }
  });
  return root as T;
}

function applyOne(root: unknown, operation: JsonPatchOperation): unknown {
  switch (operation.op) {
    case 'add':
      return add(root, operation.path, structuredClone(operation.value));
    case 'remove':
      return remove(root, operation.path).root;
    case 'replace':
      if (getAtPointer(root, operation.path) === undefined)
        throw new Error('target does not exist');
      if (operation.path === '') return structuredClone(operation.value);
      return add(
        remove(root, operation.path).root,
        operation.path,
        structuredClone(operation.value),
      );
    case 'move': {
      if (operation.path.startsWith(`${operation.from}/`)) {
        throw new Error('cannot move a value into one of its own children');
      }
      const removed = remove(root, operation.from);
      return add(removed.root, operation.path, removed.value);
    }
    case 'copy': {
      const value = getAtPointer(root, operation.from);
      if (value === undefined) throw new Error(`'from' location ${operation.from} does not exist`);
      return add(root, operation.path, structuredClone(value));
    }
    case 'test': {
      const actual = getAtPointer(root, operation.path);
      if (actual === undefined || canonicalJson(actual) !== canonicalJson(operation.value)) {
        throw new Error('test failed: the value at the target does not match');
      }
      return root;
    }
    default:
      throw new Error(`unknown op '${(operation as { op: string }).op}'`);
  }
}

function parentOf(root: unknown, pointer: string): { parent: unknown; key: string } {
  const tokens = parsePointer(pointer);
  const key = tokens.pop()!;
  const parent = getAtPointer(root, toPointer(tokens));
  if (parent === undefined) {
    throw new Error(`parent ${toPointer(tokens) || '(root)'} does not exist; add it first`);
  }
  return { parent, key };
}

function add(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '') return value;
  const { parent, key } = parentOf(root, pointer);
  if (Array.isArray(parent)) {
    const index = key === '-' ? parent.length : arrayIndex(key, parent.length + 1);
    parent.splice(index, 0, value);
  } else if (isRecord(parent)) {
    parent[key] = value;
  } else {
    throw new Error('parent is not an object or array');
  }
  return root;
}

function remove(root: unknown, pointer: string): { root: unknown; value: unknown } {
  if (pointer === '') throw new Error('cannot remove the document root');
  const { parent, key } = parentOf(root, pointer);
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length);
    const [value] = parent.splice(index, 1) as unknown[];
    return { root, value };
  }
  if (isRecord(parent) && Object.hasOwn(parent, key)) {
    const value = parent[key];
    delete parent[key];
    return { root, value };
  }
  throw new Error('target does not exist');
}

function arrayIndex(token: string, limit: number): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new Error(`'${token}' is not an array index`);
  const index = Number(token);
  if (index >= limit) throw new Error(`index ${index} is out of bounds`);
  return index;
}

/** Validate untrusted input as a JSON Patch document, with an agent-readable error. */
export function assertJsonPatch(value: unknown): JsonPatchOperation[] {
  if (!Array.isArray(value)) throw invalidPatch('patches must be an array of operations');
  return value.map((operation, index) => {
    if (!isRecord(operation)) throw invalidPatch(`patches[${index}] is not an object`);
    const { op, path } = operation;
    if (typeof op !== 'string' || !(JSON_PATCH_OPS as readonly string[]).includes(op)) {
      throw invalidPatch(`patches[${index}].op must be one of ${JSON_PATCH_OPS.join(', ')}`);
    }
    if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) {
      throw invalidPatch(
        `patches[${index}].path must be a JSON Pointer such as /paths/~1users/get`,
      );
    }
    if ((op === 'move' || op === 'copy') && typeof operation.from !== 'string') {
      throw invalidPatch(`patches[${index}].from is required for '${op}'`);
    }
    if ((op === 'add' || op === 'replace' || op === 'test') && !('value' in operation)) {
      throw invalidPatch(`patches[${index}].value is required for '${op}'`);
    }
    return operation as JsonPatchOperation;
  });
}

function invalidPatch(message: string): PortolanError {
  return new PortolanError('SPEC_PATCH_INVALID', message);
}
