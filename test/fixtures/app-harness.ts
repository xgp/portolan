/** Builds a full Portolan instance wired to the local fixture API server. */
import { createPortolan, type Portolan } from '../../src/app.js';
import { parseConfig } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/logging.js';
import { startFixtureServer, type FixtureServer } from './api-server.js';

export interface AppHarness {
  app: Portolan;
  server: FixtureServer;
  /** api_id of the fixture API, already imported. */
  apiId: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Extra configuration merged over the defaults. */
  config?: Record<string, unknown>;
  /** Whether the default environment allows mutating requests. */
  allowMutations?: boolean;
  /** Auth profile to bind to the environment. */
  authProfile?: string;
  apiId?: string;
}

export async function createAppHarness(options: HarnessOptions = {}): Promise<AppHarness> {
  const server = await startFixtureServer();
  const apiId = options.apiId ?? 'fixture';

  const config = parseConfig(
    {
      database: { path: ':memory:' },
      network: { allow_loopback: true, allow_http: true },
      logging: { level: 'silent' },
      ...options.config,
      environments: [
        {
          api: apiId,
          name: 'default',
          base_url: server.url,
          allow_mutations: options.allowMutations ?? false,
          is_default: true,
          ...(options.authProfile ? { auth_profile: options.authProfile } : {}),
        },
        ...(((options.config?.environments as unknown[]) ?? []) as Record<string, unknown>[]),
      ],
    },
    'test-harness',
  );

  const app = createPortolan({ config, logger: createSilentLogger(), databasePath: ':memory:' });

  await app.catalog.addApi({ specUrl: `${server.url}/openapi.json`, apiId });
  // Config environments are reconciled at startup, which is before the API existed.
  app.catalog.syncConfiguredEnvironments();

  return {
    app,
    server,
    apiId,
    close: async () => {
      app.close();
      await server.close();
    },
  };
}
