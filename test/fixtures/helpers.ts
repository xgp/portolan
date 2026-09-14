/** Shared test helpers. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../src/config/config.js';
import type { PortolanConfig } from '../../src/config/schema.js';
import { createSilentLogger } from '../../src/logging.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { openDatabase } from '../../src/storage/database.js';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)));
export const SPEC_DIR = join(FIXTURE_DIR, 'specs');

export function readSpec(name: string): string {
  return readFileSync(join(SPEC_DIR, name), 'utf8');
}

/**
 * A configuration for tests. Loopback is enabled because the integration fixture server
 * runs on 127.0.0.1; the security suite deliberately uses the defaults instead.
 */
export function testConfig(overrides: Record<string, unknown> = {}): PortolanConfig {
  return parseConfig(
    {
      database: { path: ':memory:' },
      network: { allow_loopback: true, allow_http: true },
      logging: { level: 'silent' },
      ...overrides,
    },
    'test',
  );
}

export interface TestCatalog {
  catalog: Catalog;
  config: PortolanConfig;
  close(): void;
}

export function createTestCatalog(overrides: Record<string, unknown> = {}): TestCatalog {
  const config = testConfig(overrides);
  const db = openDatabase({ path: ':memory:' });
  const logger = createSilentLogger();
  const catalog = new Catalog(db, config, logger);
  return { catalog, config, close: () => db.close() };
}
