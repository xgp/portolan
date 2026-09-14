/**
 * The API catalog service (SPEC.md §5, §28, §43).
 *
 * Owns the lifecycle of registered APIs: import, lookup, and the reconciliation of
 * configured environments with stored ones.
 */
import type { PortolanConfig } from '../config/schema.js';
import { errors, PortolanError } from '../errors/errors.js';
import type { Logger } from '../logging.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import type { Database } from '../storage/database.js';
import { ApiRepository } from '../storage/repositories/apis.js';
import { EnvironmentRepository } from '../storage/repositories/environments.js';
import { OperationRepository } from '../storage/repositories/operations.js';
import type {
  ApiRecord,
  ApiVersionRecord,
  EnvironmentRecord,
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
  private readonly importer: Importer;

  constructor(
    db: Database,
    private readonly config: PortolanConfig,
    private readonly logger: Logger,
  ) {
    this.apis = new ApiRepository(db);
    this.operations = new OperationRepository(db);
    this.environments = new EnvironmentRepository(db);
    this.importer = new Importer({
      db,
      logger,
      policy: networkPolicyFrom(config),
      maxSpecBytes: config.limits.max_spec_bytes,
      specTimeoutMs: config.limits.spec_fetch_timeout_ms,
      maxRedirects: config.limits.max_redirects,
      allowAgentAuthProfileBinding: config.security.allow_agent_auth_profile_binding,
      knownAuthProfiles: new Set(Object.keys(config.auth_profiles)),
    });
  }

  addApi(input: AddApiInput): Promise<AddApiResult> {
    return this.importer.import(input);
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
    const byApi = new Map<string, string[]>();
    for (const env of this.config.environments) {
      if (!this.apis.get(env.api)) {
        this.logger.warn(
          { api_id: env.api, environment: env.name },
          'configured environment references an API that is not imported yet',
        );
        continue;
      }
      this.environments.upsert({
        apiId: env.api,
        name: env.name,
        baseUrl: env.base_url.replace(/\/+$/, ''),
        authProfile: env.auth_profile ?? null,
        isDefault: env.is_default,
        allowMutations: env.allow_mutations,
        source: 'config',
      });
      byApi.set(env.api, [...(byApi.get(env.api) ?? []), env.name]);
    }
    for (const api of this.apis.list()) {
      this.environments.deleteConfigEnvironmentsNotIn(api.id, byApi.get(api.id) ?? []);
    }
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
