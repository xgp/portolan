/**
 * Parsing and validation of OpenAPI documents (SPEC.md §10).
 *
 * YAML and JSON both arrive here as text; everything downstream sees normalized JSON.
 */
import { parse as parseYaml } from 'yaml';
import { validate } from '@readme/openapi-parser';
import { PortolanError } from '../errors/errors.js';
import { isRecord, type OpenApiDocument } from './types.js';

/** Parse YAML or JSON. YAML is a superset of JSON, so one parser handles both. */
export function parseSpecText(text: string): OpenApiDocument {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new PortolanError('SPEC_INVALID', 'The specification is empty.');
  }
  let parsed: unknown;
  try {
    parsed =
      trimmed.startsWith('{') || trimmed.startsWith('[')
        ? JSON.parse(trimmed)
        : parseYaml(trimmed, { maxAliasCount: 1000 });
  } catch (cause) {
    throw new PortolanError(
      'SPEC_INVALID',
      `The specification is not valid JSON or YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new PortolanError('SPEC_INVALID', 'The specification must be a JSON or YAML object.');
  }
  return parsed;
}

/**
 * Structural validation for OpenAPI 3.0.x and 3.1.x (SPEC.md §4).
 *
 * The document handed here is already bundled, so `resolve.external` is off — validation
 * must not perform its own network I/O outside the policy-checked resolver.
 */
export async function validateOpenApi(document: OpenApiDocument): Promise<{ warnings: string[] }> {
  const version = typeof document.openapi === 'string' ? document.openapi : undefined;
  if (!version) {
    throw new PortolanError(
      'SPEC_INVALID',
      'Missing "openapi" version field. Swagger 2.0 documents are not supported; convert to OpenAPI 3.x first.',
      { ...(typeof document.swagger === 'string' ? { swagger: document.swagger } : {}) },
    );
  }
  if (!/^3\.(0|1)\./.test(version)) {
    throw new PortolanError(
      'SPEC_INVALID',
      `OpenAPI version '${version}' is not supported. Portolan supports 3.0.x and 3.1.x.`,
      { openapi: version },
    );
  }

  let result: Awaited<ReturnType<typeof validate>>;
  try {
    // structuredClone: the validator mutates what it is given.
    result = await validate(
      structuredClone(document) as never,
      {
        resolve: { external: false },
      } as never,
    );
  } catch (cause) {
    throw new PortolanError(
      'SPEC_INVALID',
      `The document is not a valid OpenAPI ${version} specification: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { openapi: version },
    );
  }

  const warnings = (result.warnings ?? []).map((w) => summarize(w.message));

  if (!result.valid) {
    // SPEC.md §14 and §16 require Portolan to *import* documents with duplicated
    // operationIds, assigning method:path identifiers and emitting a warning. A strict
    // validator calls that invalid, so those findings are demoted to warnings here;
    // everything else still fails the import.
    const findings = (result.errors ?? []).map((e) => summarize(e.message));
    const fatal = findings.filter((message) => !isToleratedFinding(message));
    if (fatal.length > 0) {
      throw new PortolanError(
        'SPEC_INVALID',
        `The document is not a valid OpenAPI ${version} specification: ${fatal.slice(0, 5).join('; ')}`,
        { openapi: version, errors: fatal.slice(0, 5) },
      );
    }
    warnings.push(...findings);
  }

  return { warnings: warnings.slice(0, 20) };
}

/**
 * Conformance findings Portolan imports anyway, because the specification requires it to
 * cope with them rather than refuse the document.
 */
const TOLERATED_FINDINGS = [/operationId .* is duplicated/i];

function isToleratedFinding(message: string): boolean {
  return TOLERATED_FINDINGS.some((pattern) => pattern.test(message));
}

/** Validation messages embed a source excerpt; keep only the first line for warnings. */
function summarize(message: string): string {
  return message.split('\n')[0]?.trim() ?? message;
}
