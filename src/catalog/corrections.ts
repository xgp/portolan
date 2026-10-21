/**
 * Corrections to a registered specification (docs/DEVIATIONS.md D20, D21).
 *
 * The stored document is always derived, never edited: the document as received, then
 * Portolan's automatic repairs, then every active agent correction in the order it was
 * made. Re-importing from upstream therefore keeps each correction that still applies and
 * marks the rest stale, instead of losing them or forcing them onto a document they no
 * longer fit.
 */
import { PortolanError } from '../errors/errors.js';
import { sha256Hex } from '../ids.js';
import { applyJsonPatch, JsonPatchError, type JsonPatchOperation } from '../openapi/json-patch.js';
import type { SpecRepair } from '../openapi/repairs.js';
import type { OpenApiDocument } from '../openapi/types.js';
import type { CorrectionRepository } from '../storage/repositories/corrections.js';
import type { CorrectionRecord, CorrectionStatus } from '../storage/repositories/types.js';
import { canonicalJson } from './normalizer.js';

export interface IssueReport {
  title: string;
  description?: string;
}

export interface Submission {
  fingerprint: string;
  issue: IssueReport;
  patch: JsonPatchOperation[] | undefined;
  /** The earlier correction this submission repeats, if any. */
  existing: CorrectionRecord | undefined;
}

export interface CorrectionPlan {
  document: OpenApiDocument;
  warnings: string[];
  /** The status each stored agent correction ends up with. */
  statuses: Map<string, CorrectionStatus>;
  submission: Submission | undefined;
}

export type Validate = (document: OpenApiDocument) => Promise<{ warnings: string[] }>;

export function fingerprintOf(apiId: string, ...parts: string[]): string {
  return sha256Hex([apiId, ...parts].join('\n')).slice(0, 32);
}

function repairFingerprint(apiId: string, repair: SpecRepair): string {
  return fingerprintOf(apiId, 'portolan', repair.kind, repair.title);
}

function correctionId(fingerprint: string): string {
  return `c_${fingerprint.slice(0, 16)}`;
}

function patchOf(record: CorrectionRecord): JsonPatchOperation[] {
  return JSON.parse(record.patchJson ?? '[]') as JsonPatchOperation[];
}

/**
 * Apply stored and submitted agent corrections to `base` (the repaired upstream
 * document) and validate the result.
 */
export async function planCorrections(input: {
  apiId: string;
  base: OpenApiDocument;
  stored: readonly CorrectionRecord[];
  revertIds: readonly string[];
  issue: IssueReport | undefined;
  patch: JsonPatchOperation[] | undefined;
  validate: Validate;
}): Promise<CorrectionPlan> {
  const { apiId, stored, revertIds } = input;
  const warnings: string[] = [];
  const statuses = new Map<string, CorrectionStatus>();

  const agentCorrections = stored.filter((c) => c.origin === 'agent');
  for (const id of revertIds) {
    if (!agentCorrections.some((c) => c.id === id)) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        `API '${apiId}' has no agent correction '${id}' to revert.`,
        { api_id: apiId, correction_id: id, corrections: agentCorrections.map((c) => c.id) },
      );
    }
    statuses.set(id, 'reverted');
  }

  let submission: Submission | undefined;
  if (input.issue) {
    const fingerprint = input.patch
      ? fingerprintOf(apiId, 'patch', canonicalJson(input.patch))
      : fingerprintOf(apiId, 'report', input.issue.title);
    const existing = stored.find((c) => c.fingerprint === fingerprint);
    if (existing && revertIds.includes(existing.id)) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        `Correction '${existing.id}' cannot be submitted and reverted in the same call.`,
        { correction_id: existing.id },
      );
    }
    submission = { fingerprint, issue: input.issue, patch: input.patch, existing };
  }

  // A resubmitted patch is replayed in its original position, and must apply.
  const replay = agentCorrections.filter(
    (c) =>
      c.patchJson !== null &&
      !revertIds.includes(c.id) &&
      (c.status !== 'reverted' || c.id === submission?.existing?.id),
  );
  const strictId = submission?.existing?.id;

  const build = async (validateEach: boolean) => {
    let document = input.base;
    const applied: string[] = [];
    if (validateEach) await input.validate(document);

    for (const correction of replay) {
      let candidate: OpenApiDocument;
      try {
        candidate = applyJsonPatch(document, patchOf(correction));
        if (validateEach) await input.validate(candidate);
      } catch (error) {
        if (correction.id === strictId) throw patchFailure(error);
        statuses.set(correction.id, 'stale');
        warnings.push(
          `Correction ${correction.id} ("${correction.title}") no longer applies to the document and was skipped; the upstream document may have fixed it.`,
        );
        continue;
      }
      document = candidate;
      applied.push(correction.id);
      statuses.set(correction.id, 'applied');
    }

    if (submission?.patch && !submission.existing) {
      try {
        document = applyJsonPatch(document, submission.patch);
        if (validateEach) await input.validate(document);
      } catch (error) {
        throw patchFailure(error);
      }
    }
    return { document, applied };
  };

  // Validating after every step costs one validation per correction, so it is only done
  // to find out which correction broke a document that failed as a whole.
  let { document } = await build(false);
  let validation: { warnings: string[] };
  try {
    validation = await input.validate(document);
  } catch (error) {
    const anyPatch = replay.length > 0 || submission?.patch !== undefined;
    if (!anyPatch || !PortolanError.is(error) || error.code !== 'SPEC_INVALID') throw error;
    statuses.clear();
    for (const id of revertIds) statuses.set(id, 'reverted');
    warnings.length = 0;
    ({ document } = await build(true));
    validation = await input.validate(document);
  }

  return { document, warnings: [...validation.warnings, ...warnings], statuses, submission };
}

function patchFailure(error: unknown): PortolanError {
  if (error instanceof JsonPatchError) {
    return new PortolanError(
      'SPEC_PATCH_INVALID',
      `The patch does not apply to the registered document: ${error.message}. Patches apply to the document as inspect_api shows it, with "/" in path keys escaped as "~1".`,
      { operation_index: error.index },
    );
  }
  if (PortolanError.is(error) && error.code === 'SPEC_INVALID') {
    return new PortolanError(
      'SPEC_PATCH_INVALID',
      `The patch applies, but the result is not a valid OpenAPI document: ${error.message}`,
      error.details,
    );
  }
  if (PortolanError.is(error)) return error;
  return new PortolanError(
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

export interface RecordedCorrections {
  /** Corrections created or changed by this import, in their new state. */
  touched: CorrectionRecord[];
  /** Portolan repairs not yet raised upstream. */
  pendingRepairs: CorrectionRecord[];
  /** The agent's submission, when it has not been raised upstream yet. */
  pendingSubmission: CorrectionRecord | undefined;
  /** Whether anything in `pending*` was created by this import. */
  anyNew: boolean;
}

/** Raised already, or deliberately not: do not raise again. */
function needsReport(record: CorrectionRecord): boolean {
  return (
    record.upstreamIssueStatus === null ||
    record.upstreamIssueStatus === 'failed' ||
    record.upstreamIssueStatus === 'rate_limited'
  );
}

/** Persist the outcome of {@link planCorrections}. Call inside the import transaction. */
export function recordCorrections(
  repository: CorrectionRepository,
  apiId: string,
  repairs: readonly SpecRepair[],
  plan: CorrectionPlan,
  stored: readonly CorrectionRecord[],
): RecordedCorrections {
  const touched: CorrectionRecord[] = [];
  const pendingRepairs: CorrectionRecord[] = [];
  let anyNew = false;
  const byFingerprint = new Map(stored.map((c) => [c.fingerprint, c]));
  const setStatus = (record: CorrectionRecord, status: CorrectionStatus) => {
    if (record.status === status) return record;
    repository.setStatus(record.id, status);
    const updated = { ...record, status };
    touched.push(updated);
    return updated;
  };

  const insert = (
    record: Omit<
      CorrectionRecord,
      'id' | 'createdAt' | 'updatedAt' | 'upstreamRepo' | 'upstreamIssueUrl' | 'upstreamIssueStatus'
    >,
  ): CorrectionRecord => {
    const id = correctionId(record.fingerprint);
    repository.insert({ ...record, id });
    const now = new Date().toISOString();
    const created: CorrectionRecord = {
      ...record,
      id,
      upstreamRepo: null,
      upstreamIssueUrl: null,
      upstreamIssueStatus: null,
      createdAt: now,
      updatedAt: now,
    };
    touched.push(created);
    anyNew = true;
    return created;
  };

  // --- Portolan's repairs: recomputed on every import ------------------------
  const current = new Set<string>();
  for (const repair of repairs) {
    const fingerprint = repairFingerprint(apiId, repair);
    current.add(fingerprint);
    const existing = byFingerprint.get(fingerprint);
    const record = existing
      ? setStatus(existing, 'applied')
      : insert({
          apiId,
          origin: 'portolan',
          kind: repair.kind,
          fingerprint,
          title: repair.title,
          description: null,
          patchJson: JSON.stringify(repair.patch),
          status: 'applied',
        });
    if (needsReport(record)) pendingRepairs.push(record);
  }
  for (const record of stored) {
    if (
      record.origin === 'portolan' &&
      record.status === 'applied' &&
      !current.has(record.fingerprint)
    ) {
      setStatus(record, 'resolved');
    }
  }

  // --- agent corrections ------------------------------------------------------
  for (const [id, status] of plan.statuses) {
    const record = stored.find((c) => c.id === id);
    if (record) setStatus(record, status);
  }

  let pendingSubmission: CorrectionRecord | undefined;
  const submission = plan.submission;
  if (submission) {
    let record: CorrectionRecord;
    if (submission.existing) {
      record = touched.find((c) => c.id === submission.existing!.id) ?? submission.existing;
      if (!touched.includes(record)) touched.push(record);
    } else {
      record = insert({
        apiId,
        origin: 'agent',
        kind: submission.patch ? 'patch' : 'report',
        fingerprint: submission.fingerprint,
        title: submission.issue.title,
        description: submission.issue.description ?? null,
        patchJson: submission.patch ? JSON.stringify(submission.patch) : null,
        status: submission.patch ? 'applied' : 'reported',
      });
    }
    if (needsReport(record)) pendingSubmission = record;
  }

  return { touched, pendingRepairs, pendingSubmission, anyNew };
}
