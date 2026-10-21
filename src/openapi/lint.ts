/**
 * Linting with Spectral's OpenAPI ruleset (docs/DEVIATIONS.md D23).
 *
 * Validation (parser.ts) decides whether Portolan can use a document at all; linting
 * reports what is legal but unhelpful — an operation with no description, a parameter
 * nobody explained, an operationId used twice. Findings never fail an import.
 *
 * Two defaults matter:
 *
 * - Spectral's own `$ref` resolver fetches `http(s):` and `file:` references. That would
 *   step around every network policy check in safe-fetch.ts, so the linter is given a
 *   resolver with no schemes at all. The document has already been bundled, so the only
 *   references left are local ones, which need no resolver.
 * - The example-validation rules compile a JSON Schema validator per example. On a large
 *   document (api.github.com) they take most of the time and gigabytes of memory, so they
 *   are off unless configured. The schema rules repeat what validation already checked.
 */
import spectralCore, { type RulesetDefinition } from '@stoplight/spectral-core';
import refResolver from '@stoplight/spectral-ref-resolver';
import { oas } from '@stoplight/spectral-rulesets';
import { toPointer } from './json-patch.js';
import type { OpenApiDocument } from './types.js';

const { Spectral } = spectralCore;

export type LintSeverity = 'error' | 'warn' | 'info' | 'hint';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  /** JSON Pointer to the offending node. */
  pointer: string;
  message: string;
}

export type LintRuleSetting = 'off' | LintSeverity;

export interface LintOptions {
  /** Rule name → severity, or `off`. Applied over {@link DEFAULT_RULE_OVERRIDES}. */
  rules?: Readonly<Record<string, LintRuleSetting>>;
}

export const DEFAULT_RULE_OVERRIDES: Readonly<Record<string, LintRuleSetting>> = {
  'oas2-schema': 'off',
  'oas3-schema': 'off',
  'oas2-valid-media-example': 'off',
  'oas2-valid-schema-example': 'off',
  'oas3-valid-media-example': 'off',
  'oas3-valid-schema-example': 'off',
};

/** Spectral's `DiagnosticSeverity`, by index. */
const SEVERITIES: readonly LintSeverity[] = ['error', 'warn', 'info', 'hint'];

export const SEVERITY_ORDER: Readonly<Record<LintSeverity, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  hint: 3,
};

export async function lintDocument(
  document: OpenApiDocument,
  options: LintOptions = {},
): Promise<LintFinding[]> {
  const spectral = new Spectral({ resolver: new refResolver.Resolver({ resolvers: {} }) });
  spectral.setRuleset({
    // The published ruleset's inferred type is narrower than the definition type under
    // exactOptionalPropertyTypes; it is a valid definition.
    extends: [[oas as RulesetDefinition, 'recommended']],
    rules: { ...DEFAULT_RULE_OVERRIDES, ...options.rules },
  });
  const results = await spectral.run(document as Record<string, unknown>);
  return results
    .map((result) => ({
      rule: String(result.code),
      severity: SEVERITIES[result.severity] ?? 'hint',
      pointer: toPointer(result.path.map(String)),
      message: result.message,
    }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.pointer.localeCompare(b.pointer) ||
        a.rule.localeCompare(b.rule),
    );
}
