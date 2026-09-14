/**
 * Stable, machine-readable error envelope (SPEC.md §25).
 *
 * Every failure that an agent could plausibly recover from is reported through
 * {@link PortolanError}. The envelope shape is part of the MCP contract and must stay
 * stable: `{ error: { code, message, details } }`.
 */

/** Error codes from SPEC.md §25, plus the additions documented in docs/DEVIATIONS.md. */
export const ERROR_CODES = [
  // §25
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
  // Additions — see docs/DEVIATIONS.md (D5, D6, D12, D14).
  'AUTH_PROFILE_BINDING_NOT_ALLOWED',
  'ENVIRONMENT_IMMUTABLE',
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_OUTPUT_TOO_LARGE',
  'INVALID_ARGUMENT',
  'CONFIG_INVALID',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown>;
  };
}

export class PortolanError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PortolanError';
    this.code = code;
    this.details = details;
  }

  toEnvelope(): ErrorEnvelope {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }

  static is(value: unknown): value is PortolanError {
    return value instanceof PortolanError;
  }
}

/**
 * Convert any thrown value into the §25 envelope. Unknown errors become
 * `INTERNAL_ERROR` and never leak a stack trace to the model.
 */
export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (PortolanError.is(error)) return error.toEnvelope();
  if (error instanceof Error) {
    return { error: { code: 'INTERNAL_ERROR', message: error.message, details: {} } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: String(error), details: {} } };
}

/** Shorthand constructors for the codes used in more than one place. */
export const errors = {
  apiNotFound: (apiId: string) =>
    new PortolanError('API_NOT_FOUND', `API '${apiId}' is not registered.`, { api_id: apiId }),

  operationNotFound: (apiId: string, operationId: string, suggestions: string[] = []) =>
    new PortolanError(
      'OPERATION_NOT_FOUND',
      `Operation '${operationId}' does not exist in API '${apiId}'.`,
      { api_id: apiId, operation_id: operationId, ...(suggestions.length ? { suggestions } : {}) },
    ),

  environmentNotFound: (apiId: string, name: string, available: string[]) =>
    new PortolanError(
      'ENVIRONMENT_NOT_FOUND',
      `API '${apiId}' has no environment named '${name}'.`,
      { api_id: apiId, environment: name, available_environments: available },
    ),

  invalidArgument: (message: string, details: Record<string, unknown> = {}) =>
    new PortolanError('INVALID_ARGUMENT', message, details),

  internal: (message: string, details: Record<string, unknown> = {}) =>
    new PortolanError('INTERNAL_ERROR', message, details),
};
