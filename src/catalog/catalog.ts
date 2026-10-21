/**
 * The API catalog service (SPEC.md §5, §28, §43).
 *
 * Owns the lifecycle of registered APIs: import, lookup, and the reconciliation of
 * configured environments with stored ones.
 */
import type { PortolanConfig } from '../config/schema.js';
import { errors, PortolanError } from '../errors/errors.js';
import type { Logger } from '../logging.js';
import type { Enricher } from '../enrichment/enricher.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import type { Database } from '../storage/database.js';
import { ApiRepository } from '../storage/repositories/apis.js';
import { EnrichmentRepository, operationContentHash } from '../storage/repositories/enrichments.js';
import { EnvironmentRepository } from '../storage/repositories/environments.js';
import { LintFindingRepository } from '../storage/repositories/lint-findings.js';
import { OperationRepository } from '../storage/repositories/operations.js';
import type {
  ApiRecord,
  ApiVersionRecord,
  EnrichmentRecord,
  EnvironmentRecord,
  LintFindingRecord,
  OperationRecord,
} from '../storage/repositories/types.js';
import type { AddApiInput, AddApiResult } from '../services/types.js';
import { Importer } from './importer.js';

export interface ResolvedOperation {
  api: ApiRecord;
  version: ApiVersionRecord;
  operation: OperationRecord;
}

export class Catalog {
  private readonly apis: ApiRepository;
  private readonly operations: OperationRepository;
  private readonly environments: EnvironmentRepository;
  private readonly lintFindings: LintFindingRepository;
  private readonly enrichments: EnrichmentRepository;
  private readonly importer: Importer;

  constructor(
    db: Database,
    private readonly config: PortolanConfig,
    private readonly logger: Logger,
    /** docs/DEVIATIONS.md D24. Without one, nothing is enriched. */
    private readonly enricher?: Enricher,
  ) {
    this.apis = new ApiRepository(db);
    this.operations = new OperationRepository(db);
    this.environments = new EnvironmentRepository(db);
    this.lintFindings = new LintFindingRepository(db);
    this.enrichments = new EnrichmentRepository(db);
    this.importer = new Importer({
      db,
      logger,
      policy: networkPolicyFrom(config),
      maxSpecBytes: config.limits.max_spec_bytes,
      specTimeoutMs: config.limits.spec_fetch_timeout_ms,
      maxRedirects: config.limits.max_redirects,
      allowAgentAuthProfileBinding: config.security.allow_agent_auth_profile_binding,
      knownAuthProfiles: new Set(Object.keys(config.auth_profiles)),
      feedback: config.feedback,
      lint: config.lint,
    });
  }

  async addApi(input: AddApiInput): Promise<AddApiResult> {
    const result = await this.importer.import(input);
    // Configured environments are authoritative (SPEC.md §28) and must apply to an API
    // registered after startup, not only to one that already existed when the process
    // began. Re-apply them here and report the reconciled list.
    this.applyConfiguredEnvironments(result.api_id);
    const enrichment = this.enricher?.schedule(result.api_id);
    return {
      ...result,
      ...(enrichment ? { enrichment } : {}),
      environments: this.environments.list(result.api_id).map((env) => ({
        name: env.name,
        base_url: env.baseUrl,
        allow_mutations: env.allowMutations,
        source: env.source,
      })),
    };
  }

  listApis(): ApiRecord[] {
    return this.apis.list();
  }

  getApi(apiId: string): ApiRecord {
    const api = this.apis.get(apiId);
    if (!api) throw errors.apiNotFound(apiId);
    return api;
  }

  /** The version every read and execution path uses (SPEC.md §43). */
  getCurrentVersion(apiId: string): ApiVersionRecord {
    const version = this.apis.getCurrentVersion(apiId);
    if (!version) {
      throw new PortolanError(
        'API_NOT_FOUND',
        `API '${apiId}' has no current version. Re-import it with add_api.`,
        { api_id: apiId },
      );
    }
    return version;
  }

  getSpecDocument(apiId: string): unknown {
    return JSON.parse(this.getCurrentVersion(apiId).specJson);
  }

  listOperations(apiId: string): OperationRecord[] {
    return this.operations.listForVersion(this.getCurrentVersion(apiId).id);
  }

  resolveOperation(apiId: string, operationId: string): ResolvedOperation {
    const api = this.getApi(apiId);
    const version = this.getCurrentVersion(apiId);
    const operation = this.operations.findByIdentifier(version.id, operationId);
    if (!operation) {
      throw errors.operationNotFound(
        apiId,
        operationId,
        this.operations.suggestIdentifiers(version.id),
      );
    }
    return { api, version, operation };
  }

  /** D23: lint findings for an operation, or anything inside it. */
  lintFindingsUnder(versionId: string, pointer: string, limit: number): LintFindingRecord[] {
    return this.lintFindings.listUnder(versionId, pointer, limit);
  }

  /** D24: what a coding agent wrote about this exact operation, if anything. */
  operationEnrichment(apiId: string, operation: OperationRecord): EnrichmentRecord | null {
    return this.enrichments.get(apiId, 'operation', operationContentHash(operation.operationJson));
  }

  listEnvironments(apiId: string): EnvironmentRecord[] {
    return this.environments.list(apiId);
  }

  resolveEnvironment(apiId: string, name: string | undefined): EnvironmentRecord {
    const available = this.environments.list(apiId);
    if (available.length === 0) {
      throw new PortolanError(
        'ENVIRONMENT_NOT_FOUND',
        `API '${apiId}' has no environments. Add one under "environments:" in config.yaml, or re-import with default_base_url.`,
        { api_id: apiId, available_environments: [] },
      );
    }
    if (!name) {
      const fallback = this.environments.getDefault(apiId);
      if (!fallback) {
        throw errors.environmentNotFound(
          apiId,
          'default',
          available.map((e) => e.name),
        );
      }
      return fallback;
    }
    const environment = this.environments.get(apiId, name);
    if (!environment) {
      throw errors.environmentNotFound(
        apiId,
        name,
        available.map((e) => e.name),
      );
    }
    return environment;
  }

  /**
   * Reconcile configured environments into storage at startup (SPEC.md §28).
   * Configured values win over anything derived from a specification, and a configured
   * environment that has been removed from config is removed from storage.
   */
  syncConfiguredEnvironments(): void {
    const configuredApis = new Set(this.config.environments.map((env) => env.api));
    for (const apiId of configuredApis) {
      if (!this.apis.get(apiId)) {
        this.logger.warn(
          { api_id: apiId },
          'configured environment references an API that is not registered yet; it will be applied when the API is added',
        );
        continue;
      }
      this.applyConfiguredEnvironments(apiId);
    }
    // Drop config-sourced environments for APIs that are no longer configured at all.
    for (const api of this.apis.list()) {
      if (!configuredApis.has(api.id)) this.environments.deleteConfigEnvironmentsNotIn(api.id, []);
    }
  }

  /** Apply the configured environments for one API, overwriting derived ones by name. */
  private applyConfiguredEnvironments(apiId: string): void {
    const configured = this.config.environments.filter((env) => env.api === apiId);
    if (configured.length === 0) {
      this.environments.deleteConfigEnvironmentsNotIn(apiId, []);
      return;
    }
    for (const env of configured) {
      this.environments.upsert({
        apiId,
        name: env.name,
        baseUrl: env.base_url.replace(/\/+$/, ''),
        authProfile: env.auth_profile ?? null,
        isDefault: env.is_default,
        allowMutations: env.allow_mutations,
        source: 'config',
      });
    }
    if (configured.some((env) => env.is_default)) this.environments.clearDerivedDefaults(apiId);
    this.environments.deleteConfigEnvironmentsNotIn(
      apiId,
      configured.map((env) => env.name),
    );
  }
}

export function networkPolicyFrom(config: PortolanConfig): NetworkPolicyOptions {
  return {
    allowPrivateAddresses: config.network.allow_private_addresses,
    allowLoopback: config.network.allow_loopback,
    allowHttp: config.network.allow_http,
    allowedHosts: config.network.allowed_hosts,
  };
}
