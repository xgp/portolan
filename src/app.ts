/**
 * The application container (SPEC.md §58).
 *
 * Wires configuration, storage, catalog, search, execution and the sandbox into one
 * object. Nothing here knows about MCP; the MCP layer is a thin adapter over this.
 */
import { Catalog, networkPolicyFrom } from './catalog/catalog.js';
import type { PortolanConfig } from './config/schema.js';
import { Enricher } from './enrichment/enricher.js';
import { AuthResolver } from './execution/auth.js';
import { Caller } from './execution/caller.js';
import { OAuthTokenCache } from './execution/oauth.js';
import { createLogger, type Logger } from './logging.js';
import { FtsSearchProvider } from './search/fts-search-provider.js';
import { SandboxRunner } from './sandbox/runner.js';
import { openDatabase, type Database } from './storage/database.js';
import type { SearchProvider } from './services/types.js';

export interface Portolan {
  readonly config: PortolanConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly catalog: Catalog;
  /** docs/DEVIATIONS.md D24. */
  readonly enricher: Enricher;
  readonly search: SearchProvider;
  readonly caller: Caller;
  readonly auth: AuthResolver;
  readonly sandbox: SandboxRunner;
  close(): void;
}

export interface CreatePortolanOptions {
  config: PortolanConfig;
  logger?: Logger;
  /** Overrides `config.database.path`; used by tests to run against an in-memory DB. */
  databasePath?: string;
}

export function createPortolan(options: CreatePortolanOptions): Portolan {
  const { config } = options;
  const logger = options.logger ?? createLogger(config);
  const db = openDatabase({ path: options.databasePath ?? config.database.path });

  const policy = networkPolicyFrom(config);
  const enricher = new Enricher({ db, config, logger });
  const catalog = new Catalog(db, config, logger, enricher);
  catalog.syncConfiguredEnvironments();

  const oauth = new OAuthTokenCache(
    policy,
    config.limits.oauth_timeout_ms,
    config.limits.max_redirects,
  );
  const auth = new AuthResolver(config.auth_profiles, oauth);
  const caller = new Caller({ catalog, config, auth, logger, policy });
  const search = new FtsSearchProvider(db);
  const sandbox = new SandboxRunner({ config, logger, caller, catalog });

  return {
    config,
    logger,
    db,
    catalog,
    enricher,
    search,
    caller,
    auth,
    sandbox,
    close() {
      enricher.close();
      oauth.clear();
      db.close();
    },
  };
}
