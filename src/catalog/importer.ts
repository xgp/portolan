/**
 * The `add_api` import pipeline (SPEC.md §10, §16, §43, §44).
 *
 * receive → load → parse → resolve refs → repair (D21) → apply corrections (D20) →
 * validate → derive metadata → derive operations → derive environments → build search
 * text → persist → reindex, all inside one transaction so a failure never replaces the
 * current version. Raising flaws upstream (D22) happens after the commit and can never
 * fail an import.
 */
import type { PortolanConfig } from '../config/schema.js';
import { errors, PortolanError } from '../errors/errors.js';
import {
  composeIssue,
  detectRepository,
  isRepositoryName,
  UpstreamReporter,
} from '../feedback/upstream.js';
import type { Logger } from '../logging.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import { assertUrlAllowed } from '../net/safe-fetch.js';
import { buildOperationSearchText, extractOperations } from '../openapi/operations.js';
import { assertJsonPatch, type JsonPatchOperation } from '../openapi/json-patch.js';
import { lintDocument, type LintFinding } from '../openapi/lint.js';
import { parseSpecText, validateOpenApi } from '../openapi/parser.js';
import { repairDocument } from '../openapi/repairs.js';
import type { OpenApiDocument } from '../openapi/types.js';
import { transaction, type Database } from '../storage/database.js';
import { ApiRepository } from '../storage/repositories/apis.js';
import { CorrectionRepository } from '../storage/repositories/corrections.js';
import { EnvironmentRepository } from '../storage/repositories/environments.js';
import { LintFindingRepository } from '../storage/repositories/lint-findings.js';
import { OperationRepository } from '../storage/repositories/operations.js';
import { SearchIndexRepository } from '../storage/repositories/search-index.js';
import type { OperationRecord } from '../storage/repositories/types.js';
import {
  MAX_REPORTED_CORRECTIONS,
  MAX_REPORTED_LINT_FINDINGS,
  type AddApiInput,
  type AddApiResult,
  type LintSummary,
  type UpstreamIssueSummary,
} from '../services/types.js';
import { apiVersionId, deriveApiId, isValidApiId, operationRowId } from './identifiers.js';
import {
  fingerprintOf,
  planCorrections,
  recordCorrections,
  type IssueReport,
  type RecordedCorrections,
} from './corrections.js';
import { canonicalJson, deriveMetadata, specHash } from './normalizer.js';
import { bundleDocument, fetchSpec, type ResolverOptions } from './resolver.js';

export interface ImporterOptions {
  db: Database;
  logger: Logger;
  policy: NetworkPolicyOptions;
  maxSpecBytes: number;
  specTimeoutMs: number;
  maxRedirects: number;
  /** docs/DEVIATIONS.md D5: whether add_api may bind a named credential profile. */
  allowAgentAuthProfileBinding: boolean;
  /** Profiles that exist in configuration, for validating a permitted binding. */
  knownAuthProfiles: ReadonlySet<string>;
  /** docs/DEVIATIONS.md D22. */
  feedback: PortolanConfig['feedback'];
  /** docs/DEVIATIONS.md D23. */
  lint: PortolanConfig['lint'];
}

interface LoadedSource {
  document: OpenApiDocument;
  sourceType: 'url' | 'content' | null;
  sourceUri: string | null;
}

export class Importer {
  private readonly apis: ApiRepository;
  private readonly operations: OperationRepository;
  private readonly environments: EnvironmentRepository;
  private readonly index: SearchIndexRepository;
  private readonly corrections: CorrectionRepository;
  private readonly lintFindings: LintFindingRepository;
  private readonly upstream: UpstreamReporter;

  constructor(private readonly options: ImporterOptions) {
    this.apis = new ApiRepository(options.db);
    this.operations = new OperationRepository(options.db);
    this.environments = new EnvironmentRepository(options.db);
    this.index = new SearchIndexRepository(options.db);
    this.corrections = new CorrectionRepository(options.db);
    this.lintFindings = new LintFindingRepository(options.db);
    this.upstream = new UpstreamReporter({
      config: options.feedback,
      policy: options.policy,
      timeoutMs: options.specTimeoutMs,
      maxRedirects: options.maxRedirects,
      logger: options.logger,
      filedInLastDay: (repo) =>
        this.corrections.countFiledSince(
          repo,
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        ),
    });
  }

  private get resolverOptions(): ResolverOptions {
    return {
      policy: this.options.policy,
      maxBytes: this.options.maxSpecBytes,
      timeoutMs: this.options.specTimeoutMs,
      maxRedirects: this.options.maxRedirects,
    };
  }

  async import(input: AddApiInput): Promise<AddApiResult> {
    const warnings: string[] = [];

    // --- arguments -----------------------------------------------------------
    const hasUrl = typeof input.specUrl === 'string' && input.specUrl.trim() !== '';
    const hasContent = typeof input.specContent === 'string' && input.specContent.trim() !== '';
    const issue = normalizeIssue(input.issue);
    const patch: JsonPatchOperation[] | undefined =
      input.patches !== undefined && input.patches.length > 0
        ? assertJsonPatch(input.patches)
        : undefined;
    if (patch && !issue) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        'patches must come with issue.title describing the flaw they correct.',
      );
    }
    const revertIds = input.revertCorrections ?? [];
    const upstreamRepo = input.upstreamRepo?.trim() || undefined;
    if (upstreamRepo && !isRepositoryName(upstreamRepo)) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        `upstream_repo '${upstreamRepo}' must be a GitHub repository as "owner/name".`,
        { upstream_repo: upstreamRepo },
      );
    }
    const correcting = Boolean(issue || revertIds.length > 0 || upstreamRepo);
    // D20: with no specification source, add_api corrects the registered document.
    const inPlace = !hasUrl && !hasContent;
    if ((hasUrl && hasContent) || (inPlace && !correcting)) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        'Supply exactly one of spec_url or spec_content — or, to correct a registered API, api_id with issue and patches.',
      );
    }

    // --- source, parse, resolve ---------------------------------------------
    const source = inPlace ? this.loadRegistered(input.apiId) : await this.loadSource(input);

    // --- repair, correct, validate (D20, D21) --------------------------------
    const repaired = repairDocument(source.document);

    const apiId = inPlace
      ? input.apiId!.trim()
      : input.apiId?.trim() || deriveApiId(deriveMetadata(repaired.document).title);
    if (!isValidApiId(apiId)) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        `'${apiId}' is not a valid api_id. Use lowercase letters, digits, '.', '-' and '_', starting with a letter or digit.`,
        { api_id: apiId },
      );
    }

    const existing = this.apis.get(apiId);
    if (existing && !inPlace && input.replace !== true) {
      throw new PortolanError(
        'API_ALREADY_EXISTS',
        `API '${apiId}' already exists. Call add_api again with replace=true to add a new version, or choose a different api_id.`,
        { api_id: apiId },
      );
    }

    const stored = existing ? this.corrections.listForApi(apiId) : [];
    const plan = await planCorrections({
      apiId,
      base: repaired.document,
      stored,
      revertIds,
      issue,
      patch,
      validate: validateOpenApi,
    });
    const document = plan.document;
    warnings.push(...plan.warnings);
    if (repaired.repairs.length > 0) {
      warnings.push(
        `Portolan repaired ${repaired.repairs.length} structural problem(s) in its copy of the document (see corrections).`,
      );
    }

    // --- metadata ----------------------------------------------------------
    const metadata = deriveMetadata(document);

    // --- environment binding ------------------------------------------------
    // Resolved before the "unchanged" short-circuit below: an environment is
    // configuration rather than specification content, so a caller-supplied
    // default_base_url must take effect even when the document itself has not changed.
    // Otherwise the documented remedy for "declares no usable servers entry" is
    // unreachable for an API that was first imported without one.
    const authProfile = this.resolveRequestedAuthProfile(input.authProfile);
    const environmentName = input.defaultEnvironment?.trim() || 'default';
    const baseUrl = input.defaultBaseUrl?.trim() || metadata.serverUrls[0];
    if (input.defaultBaseUrl) {
      // Fail fast on a base URL the policy would refuse at call time.
      assertUrlAllowed(input.defaultBaseUrl, this.options.policy);
    }
    if (!baseUrl) {
      warnings.push(
        'The specification declares no usable servers entry; supply default_base_url or configure an environment before calling operations.',
      );
    }
    if (metadata.serverUrls.length > 1) {
      warnings.push(
        `The specification declares ${metadata.serverUrls.length} servers; only the first was used for the '${environmentName}' environment. Configure additional environments in config.yaml.`,
      );
    }

    // docs/DEVIATIONS.md D6: never overwrite an existing (possibly configured)
    // environment, and never grant mutation rights from an import.
    const environmentRecord = baseUrl
      ? {
          apiId,
          name: environmentName,
          baseUrl,
          authProfile,
          isDefault: true,
          allowMutations: false,
          source: input.defaultBaseUrl ? ('add_api' as const) : ('spec' as const),
        }
      : undefined;

    const hash = specHash(document);
    const record = () => {
      if (upstreamRepo) this.apis.setUpstreamRepo(apiId, upstreamRepo);
      return recordCorrections(this.corrections, apiId, repaired.repairs, plan, stored);
    };
    const finish = async (
      result: Omit<AddApiResult, 'corrections' | 'corrections_total' | 'upstream_issues'>,
      recorded: RecordedCorrections,
    ): Promise<AddApiResult> => {
      const upstream = await this.reportUpstream(apiId, recorded, source, result);
      const touched = recorded.touched;
      const lint = this.lintSummary(apiId);
      return {
        ...result,
        ...(lint ? { lint } : {}),
        ...(touched.length > 0
          ? {
              corrections: touched.slice(0, MAX_REPORTED_CORRECTIONS).map((c) => ({
                id: c.id,
                origin: c.origin,
                status: c.status,
                title: c.title,
              })),
              corrections_total: touched.length,
            }
          : {}),
        ...(upstream.length > 0 ? { upstream_issues: upstream } : {}),
      };
    };

    if (existing) {
      const currentVersion = this.apis.getCurrentVersion(apiId);
      if (currentVersion?.specHash === hash) {
        // SPEC.md §44 — identical content, no new version.
        const recorded = transaction(this.options.db, () => {
          if (environmentRecord) this.environments.insertIfAbsent(environmentRecord);
          return record();
        });
        return finish(
          {
            api_id: apiId,
            name: existing.name,
            openapi_version: currentVersion.openapiVersion,
            api_version: currentVersion.infoVersion,
            operations: this.operations.countForVersion(currentVersion.id),
            environments: this.environments.list(apiId).map(toEnvironmentSummary),
            warnings,
            status: 'unchanged',
          },
          recorded,
        );
      }
    }

    const name =
      input.name?.trim() || (inPlace ? existing?.name : undefined) || metadata.title || apiId;
    const description =
      input.description?.trim() ||
      (inPlace ? existing?.description : undefined) ||
      metadata.description ||
      null;
    const apiRow = {
      id: apiId,
      name,
      description,
      aliases: input.aliases ?? (inPlace ? existing?.aliases : undefined) ?? [],
      tags: input.tags ?? (inPlace ? existing?.tags : undefined) ?? metadata.tags,
    };
    const status = existing
      ? inPlace
        ? ('corrected' as const)
        : ('replaced' as const)
      : ('added' as const);

    // Returning to a document this API has had before — an older upstream version, or a
    // correction reverted — reuses that version rather than violating its unique hash.
    const previous = existing ? this.apis.findVersionByHash(apiId, hash) : null;
    if (previous) {
      const recorded = transaction(this.options.db, () => {
        this.apis.upsert(apiRow);
        this.apis.setCurrentVersion(apiId, previous.id);
        if (environmentRecord) this.environments.insertIfAbsent(environmentRecord);
        const operations = this.operations.listForVersion(previous.id);
        this.index.reindexApi({ api: this.apis.get(apiId)!, version: previous });
        this.index.reindexOperations(apiId, operations);
        return { recorded: record(), operations: operations.length };
      });
      return finish(
        {
          api_id: apiId,
          name,
          openapi_version: previous.openapiVersion,
          api_version: previous.infoVersion,
          operations: recorded.operations,
          environments: this.environments.list(apiId).map(toEnvironmentSummary),
          warnings,
          status,
        },
        recorded.recorded,
      );
    }

    // --- operations --------------------------------------------------------
    const extraction = extractOperations(document);
    warnings.push(...extraction.warnings);
    if (extraction.operations.length === 0) {
      warnings.push('The specification defines no operations under "paths".');
    }

    const versionId = apiVersionId(apiId, hash);
    const operationRecords: OperationRecord[] = extraction.operations.map((op) => {
      const searchText = buildOperationSearchText(op);
      return {
        id: operationRowId(versionId, op.canonicalId),
        apiVersionId: versionId,
        canonicalId: op.canonicalId,
        sourceOperationId: op.sourceOperationId ?? null,
        method: op.method,
        path: op.path,
        summary: op.summary ?? null,
        description: op.description ?? null,
        tags: op.tags,
        deprecated: op.deprecated,
        searchText: searchText.combined,
        paramText: searchText.parameters,
        schemaText: searchText.schemaNames,
        operationJson: JSON.stringify({
          canonical_id: op.canonicalId,
          source_operation_id: op.sourceOperationId ?? null,
          method: op.method,
          path: op.path,
          parameters: op.parameters,
          operation: op.operation,
          security: op.security ?? null,
          servers: op.servers,
        }),
      };
    });

    // --- lint (D23) ----------------------------------------------------------
    // Only a version that has not been stored before is linted; a reused one already has
    // its findings.
    let lintFindings: LintFinding[] = [];
    if (this.options.lint.enabled) {
      try {
        lintFindings = await lintDocument(document, { rules: this.options.lint.rules });
      } catch (error) {
        warnings.push(
          `The document could not be linted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // --- persist (one transaction, SPEC.md §10) ----------------------------
    const persisted = transaction(this.options.db, () => {
      this.apis.upsert(apiRow);

      const version = this.apis.insertVersion({
        id: versionId,
        apiId,
        openapiVersion: metadata.openapiVersion ?? null,
        infoVersion: metadata.infoVersion ?? null,
        infoTitle: metadata.title ?? null,
        infoDescription: metadata.description ?? null,
        specHash: hash,
        specJson: canonicalJson(document),
        sourceSpecJson: canonicalJson(source.document),
        sourceType: source.sourceType,
        sourceUri: source.sourceUri,
      });

      this.operations.insertMany(operationRecords);
      this.lintFindings.insertMany(versionId, lintFindings);
      this.apis.setCurrentVersion(apiId, versionId);

      if (environmentRecord) this.environments.insertIfAbsent(environmentRecord);

      const api = this.apis.get(apiId)!;
      this.index.reindexApi({ api, version });
      this.index.reindexOperations(apiId, operationRecords);

      return {
        recorded: record(),
        result: {
          api_id: apiId,
          name,
          openapi_version: metadata.openapiVersion ?? null,
          api_version: metadata.infoVersion ?? null,
          operations: operationRecords.length,
          environments: this.environments.list(apiId).map(toEnvironmentSummary),
          warnings,
          status,
        },
      };
    });

    this.options.logger.info(
      {
        api_id: apiId,
        operations: persisted.result.operations,
        status,
        source_type: source.sourceType,
        repairs: repaired.repairs.length,
      },
      'imported api',
    );
    return finish(persisted.result, persisted.recorded);
  }

  /** D23: counts and the most severe findings for the API's current version. */
  private lintSummary(apiId: string): LintSummary | undefined {
    if (!this.options.lint.enabled) return undefined;
    const version = this.apis.getCurrentVersion(apiId);
    if (!version) return undefined;
    const findings = this.lintFindings.listForVersion(version.id);
    const count = (severity: LintFinding['severity']) =>
      findings.filter((f) => f.severity === severity).length;
    return {
      errors: count('error'),
      warnings: count('warn'),
      info: count('info'),
      hints: count('hint'),
      findings: findings.slice(0, MAX_REPORTED_LINT_FINDINGS),
    };
  }

  /** Fetch or read the document, parse it and bundle its references. */
  private async loadSource(input: AddApiInput): Promise<LoadedSource> {
    let specText: string;
    let sourceType: 'url' | 'content';
    let sourceUri: string | null;
    let baseUri: string | undefined;

    if (typeof input.specUrl === 'string' && input.specUrl.trim() !== '') {
      // Validate the scheme before any I/O so `file:///etc/passwd` is refused up front.
      assertUrlAllowed(input.specUrl, this.options.policy);
      const fetched = await fetchSpec(input.specUrl, this.resolverOptions);
      specText = fetched.text;
      sourceType = 'url';
      sourceUri = fetched.sourceUri;
      baseUri = fetched.sourceUri;
    } else {
      specText = input.specContent!;
      if (Buffer.byteLength(specText, 'utf8') > this.options.maxSpecBytes) {
        throw new PortolanError(
          'SPEC_TOO_LARGE',
          `The specification exceeds the configured max_spec_bytes of ${this.options.maxSpecBytes}.`,
          { limit: this.options.maxSpecBytes },
        );
      }
      sourceType = 'content';
      sourceUri = null;
    }

    const parsed = parseSpecText(specText);
    const document = await bundleDocument(parsed, this.resolverOptions, baseUri);
    return { document, sourceType, sourceUri };
  }

  /** D20: the registered document as originally received, to re-derive with corrections. */
  private loadRegistered(apiId: string | undefined): LoadedSource {
    const id = apiId?.trim();
    if (!id) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        'api_id is required to correct a registered API without supplying a specification.',
      );
    }
    if (!this.apis.get(id)) throw errors.apiNotFound(id);
    const version = this.apis.getCurrentVersion(id);
    if (!version) throw errors.apiNotFound(id);
    return {
      document: JSON.parse(version.sourceSpecJson ?? version.specJson) as OpenApiDocument,
      sourceType: version.sourceType,
      sourceUri: version.sourceUri,
    };
  }

  /**
   * D22: raise flaws not yet reported with the upstream project. Best effort — an outcome
   * that is not `filed` is reported back, never thrown.
   */
  private async reportUpstream(
    apiId: string,
    recorded: RecordedCorrections,
    source: LoadedSource,
    result: { name: string; api_version: string | null; warnings: string[] },
  ): Promise<UpstreamIssueSummary[]> {
    const groups = [
      ...(recorded.pendingSubmission ? [[recorded.pendingSubmission]] : []),
      ...(recorded.pendingRepairs.length > 0 ? [recorded.pendingRepairs] : []),
    ];
    if (!this.upstream.enabled || groups.length === 0) return [];

    const target = detectRepository({
      configured: this.options.feedback.repositories[apiId],
      requested: this.apis.get(apiId)?.upstreamRepo,
      sourceUri: source.sourceUri,
      document: source.document,
      webUrl: this.options.feedback.github.web_url,
    });
    if (!target) {
      if (recorded.anyNew) {
        result.warnings.push(
          `No upstream repository is known for '${apiId}', so these flaws were not reported. Call add_api with api_id and upstream_repo ("owner/name") to report them, or configure feedback.repositories.`,
        );
      }
      return [];
    }

    const outcomes: UpstreamIssueSummary[] = [];
    for (const group of groups) {
      const origin = group[0]!.origin;
      const fingerprint =
        group.length === 1
          ? group[0]!.fingerprint
          : fingerprintOf(apiId, 'group', ...group.map((c) => c.fingerprint).sort());
      const draft = composeIssue({
        apiName: result.name,
        sourceUri: source.sourceUri,
        infoVersion: result.api_version,
        origin,
        fingerprint: fingerprint.slice(0, 16),
        findings: group.map((c) => ({
          title: c.title,
          description: c.description,
          patch: c.patchJson ? (JSON.parse(c.patchJson) as unknown[]) : null,
        })),
      });
      const outcome = await this.upstream.report(target, draft);
      const ids = group.map((c) => c.id);
      this.corrections.setUpstreamIssue(ids, {
        repo: target.repo,
        url: outcome.url,
        status: outcome.status,
      });
      outcomes.push({ ...outcome, correction_ids: ids.slice(0, MAX_REPORTED_CORRECTIONS) });
    }
    return outcomes;
  }

  /**
   * docs/DEVIATIONS.md D5: binding a named credential profile to an environment the
   * model chose the base URL for is a credential-exfiltration primitive, so it is
   * refused unless an operator has explicitly enabled it.
   */
  private resolveRequestedAuthProfile(requested: string | undefined): string | null {
    if (!requested) return null;
    if (!this.options.allowAgentAuthProfileBinding) {
      throw new PortolanError(
        'AUTH_PROFILE_BINDING_NOT_ALLOWED',
        'add_api may not attach an authentication profile to an environment. Bind credentials in config.yaml under "environments:", or set security.allow_agent_auth_profile_binding: true to permit it.',
        { auth_profile: requested },
      );
    }
    if (!this.options.knownAuthProfiles.has(requested)) {
      throw new PortolanError(
        'AUTH_PROFILE_NOT_FOUND',
        `No authentication profile named '${requested}' is configured.`,
        { auth_profile: requested },
      );
    }
    return requested;
  }
}

function toEnvironmentSummary(env: {
  name: string;
  baseUrl: string;
  allowMutations: boolean;
  source: string;
}) {
  return {
    name: env.name,
    base_url: env.baseUrl,
    allow_mutations: env.allowMutations,
    source: env.source,
  };
}

function normalizeIssue(issue: AddApiInput['issue']): IssueReport | undefined {
  if (issue === undefined) return undefined;
  const title = issue.title?.trim();
  if (!title) {
    throw new PortolanError('INVALID_ARGUMENT', 'issue.title is required when reporting a flaw.');
  }
  const description = issue.description?.trim();
  return { title, ...(description ? { description } : {}) };
}
