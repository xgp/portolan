/** The error envelope (SPEC.md §25). */
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, PortolanError, errors, toErrorEnvelope } from '../../src/errors/errors.js';

describe('error envelope', () => {
  it('has the stable shape the MCP contract promises', () => {
    const envelope = new PortolanError('API_NOT_FOUND', 'nope', { api_id: 'x' }).toEnvelope();
    expect(envelope).toEqual({
      error: { code: 'API_NOT_FOUND', message: 'nope', details: { api_id: 'x' } },
    });
    expect(Object.keys(envelope.error).sort()).toEqual(['code', 'details', 'message']);
  });

  it('defaults details to an object rather than omitting it', () => {
    expect(new PortolanError('AUTH_FAILED', 'x').toEnvelope().error.details).toEqual({});
  });

  it('defines every code SPEC.md §25 lists', () => {
    for (const code of [
      'API_NOT_FOUND',
      'API_ALREADY_EXISTS',
      'SPEC_INVALID',
      'SPEC_FETCH_FAILED',
      'SPEC_TOO_LARGE',
      'OPERATION_NOT_FOUND',
      'ENVIRONMENT_NOT_FOUND',
      'AUTH_PROFILE_NOT_FOUND',
      'AUTH_FAILED',
      'PARAMETER_REQUIRED',
      'PARAMETER_INVALID',
      'REQUEST_BODY_INVALID',
      'CONTENT_TYPE_UNSUPPORTED',
      'MUTATION_NOT_ALLOWED',
      'NETWORK_DESTINATION_BLOCKED',
      'REQUEST_TIMEOUT',
      'RESPONSE_TOO_LARGE',
      'REMOTE_API_ERROR',
      'SANDBOX_TIMEOUT',
      'SANDBOX_CALL_LIMIT',
      'SANDBOX_RUNTIME_ERROR',
    ]) {
      expect(ERROR_CODES, code).toContain(code);
    }
  });

  it('has no unused codes left in the list', async () => {
    // Every declared code should be reachable; a stale one is a documentation bug.
    const { readFileSync } = await import('node:fs');
    const { globSync } = await import('node:fs');
    const files = globSync('src/**/*.ts');
    const source = files.map((f: string) => readFileSync(f, 'utf8')).join('\n');
    for (const code of ERROR_CODES) {
      const uses = source.split(`'${code}'`).length - 1;
      // One occurrence is the declaration itself; a real code is used at least once more.
      expect(uses, `${code} is declared but never raised`).toBeGreaterThan(1);
    }
  });
});

describe('toErrorEnvelope', () => {
  it('passes a PortolanError through unchanged', () => {
    const error = new PortolanError('MUTATION_NOT_ALLOWED', 'no', { environment: 'prod' });
    expect(toErrorEnvelope(error)).toEqual(error.toEnvelope());
  });

  it('converts an unknown Error without leaking a stack trace', () => {
    const envelope = toErrorEnvelope(new Error('something internal failed'));
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(envelope.error.message).toBe('something internal failed');
    expect(JSON.stringify(envelope)).not.toContain('at ');
  });

  it('converts a non-Error throw', () => {
    expect(toErrorEnvelope('a string').error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'a string',
    });
    expect(toErrorEnvelope(undefined).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('error constructors carry recovery detail (SPEC.md §25)', () => {
  it('names the API and the operation that was not found', () => {
    const error = errors.operationNotFound('keycloak', 'users.foo', ['users.list']);
    expect(error.message).toBe("Operation 'users.foo' does not exist in API 'keycloak'.");
    expect(error.details).toEqual({
      api_id: 'keycloak',
      operation_id: 'users.foo',
      suggestions: ['users.list'],
    });
  });

  it('lists the environments that do exist', () => {
    const error = errors.environmentNotFound('k', 'prod', ['production', 'staging']);
    expect(error.details.available_environments).toEqual(['production', 'staging']);
  });
});
