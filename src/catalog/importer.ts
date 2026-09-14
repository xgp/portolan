/**
 * The `add_api` import pipeline (SPEC.md §10, §16, §43, §44).
 *
 * receive → load → parse → validate → resolve refs → normalize → derive metadata →
 * derive operations → derive environments → build search text → persist → reindex,
 * all inside one transaction so a failure never replaces the current version.
 */
import { PortolanError } from '../errors/errors.js';
import type { Logger } from '../logging.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import { assertUrlAllowed } from '../net/safe-fetch.js';
import { buildOperationSearchText, extractOperations } from '../openapi/operations.js';
import { parseSpecText, validateOpenApi } from '../openapi/parser.js';
import { transaction, type Database } from '../storage/database.js';
import { ApiRepository } from '../storage/repositories/apis.js';
import { EnvironmentRepository } from '../storage/repositories/environments.js';
import { OperationRepository } from '../storage/repositories/operations.js';
import { SearchIndexRepository } from '../storage/repositories/search-index.js';
import type { OperationRecord } from '../storage/repositories/types.js';
import type { AddApiInput, AddApiResult } from '../services/types.js';
import { apiVersionId, deriveApiId, isValidApiId, operationRowId } from './identifiers.js';
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
}

export class Importer {
  private readonly apis: ApiRepository;
  private readonly operations: OperationRepository;
  private readonly environments: EnvironmentRepository;
  private readonly index: SearchIndexRepository;

  constructor(private readonly options: ImporterOptions) {
    this.apis = new ApiRepository(options.db);
    this.operations = new OperationRepository(options.db);
    this.environments = new EnvironmentRepository(options.db);
    this.index = new SearchIndexRepository(options.db);
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

    // --- source ------------------------------------------------------------
    const hasUrl = typeof input.specUrl === 'string' && input.specUrl.trim() !== '';
    const hasContent = typeof input.specContent === 'string' && input.specContent.trim() !== '';
    if (hasUrl === hasContent) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        'Supply exactly one of spec_url or spec_content.',
      );
    }

    let specText: string;
    let sourceType: 'url' | 'content';
    let sourceUri: string | null;
    let baseUri: string | undefined;

    if (hasUrl) {
      // Validate the scheme before any I/O so `file:///etc/passwd` is refused up front.
      assertUrlAllowed(input.specUrl!, this.options.policy);
      const fetched = await fetchSpec(input.specUrl!, this.resolverOptions);
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

    // --- parse, resolve, validate -----------------------------------------
    const parsed = parseSpecText(specText);
    const bundled = await bundleDocument(parsed, this.resolverOptions, baseUri);
    const validation = await validateOpenApi(bundled);
    warnings.push(...validation.warnings);

    // --- metadata ----------------------------------------------------------
    const metadata = deriveMetadata(bundled);

    const apiId = input.apiId?.trim() || deriveApiId(metadata.title);
    if (!isValidApiId(apiId)) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        `'${apiId}' is not a valid api_id. Use lowercase letters, digits, '.', '-' and '_', starting with a letter or digit.`,
        { api_id: apiId },
      );
    }

    const existing = this.apis.get(apiId);
    if (existing && input.replace !== true) {
      throw new PortolanError(
        'API_ALREADY_EXISTS',
        `API '${apiId}' already exists. Call add_api again with replace=true to add a new version, or choose a different api_id.`,
        { api_id: apiId },
      );
    }

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

    const hash = specHash(bundled);
    if (existing) {
      const currentVersion = this.apis.getCurrentVersion(apiId);
      if (currentVersion?.specHash === hash) {
        // SPEC.md §44 — identical content, no new version.
        if (environmentRecord) this.environments.insertIfAbsent(environmentRecord);
        return {
          api_id: apiId,
          name: existing.name,
          openapi_version: currentVersion.openapiVersion,
          api_version: currentVersion.infoVersion,
          operations: this.operations.countForVersion(currentVersion.id),
          environments: this.environments.list(apiId).map(toEnvironmentSummary),
          warnings,
          status: 'unchanged',
        };
      }
    }

    // --- operations --------------------------------------------------------
    const extraction = extractOperations(bundled);
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

    // --- persist (one transaction, SPEC.md §10) ----------------------------
    const name = input.name?.trim() || metadata.title || apiId;
    const description = input.description?.trim() || metadata.description || null;

    const result = transaction(this.options.db, () => {
      this.apis.upsert({
        id: apiId,
        name,
        description,
        aliases: input.aliases ?? [],
        tags: input.tags ?? metadata.tags,
      });

      const version = this.apis.insertVersion({
        id: versionId,
        apiId,
        openapiVersion: metadata.openapiVersion ?? null,
        infoVersion: metadata.infoVersion ?? null,
        infoTitle: metadata.title ?? null,
        infoDescription: metadata.description ?? null,
        specHash: hash,
        specJson: canonicalJson(bundled),
        sourceType,
        sourceUri,
      });

      this.operations.insertMany(operationRecords);
      this.apis.setCurrentVersion(apiId, versionId);

      if (environmentRecord) this.environments.insertIfAbsent(environmentRecord);

      const api = this.apis.get(apiId)!;
      this.index.reindexApi({ api, version });
      this.index.reindexOperations(apiId, operationRecords);

      return {
        api_id: apiId,
        name,
        openapi_version: metadata.openapiVersion ?? null,
        api_version: metadata.infoVersion ?? null,
        operations: operationRecords.length,
        environments: this.environments.list(apiId).map(toEnvironmentSummary),
        warnings,
        status: existing ? ('replaced' as const) : ('added' as const),
      };
    });

    this.options.logger.info(
      {
        api_id: apiId,
        operations: result.operations,
        status: result.status,
        source_type: sourceType,
      },
      'imported api',
    );
    return result;
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
