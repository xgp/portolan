/** `portolan init` (SPEC.md §40). */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultConfigPath, EXAMPLE_CONFIG, expandPath, loadConfig } from '../config/config.js';
import { PortolanError } from '../errors/errors.js';

export interface InitResult {
  configPath: string;
  configCreated: boolean;
  databaseDirectory: string;
}

/** Creates directories and an example config. Never overwrites existing configuration. */
export function runInit(explicitPath?: string): InitResult {
  const configPath = explicitPath ? expandPath(explicitPath) : defaultConfigPath();
  const configCreated = !existsSync(configPath);

  if (configCreated) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, EXAMPLE_CONFIG, { encoding: 'utf8', mode: 0o600 });
  }

  const { config } = loadConfig(configPath);
  const databasePath = expandPath(config.database.path);
  const databaseDirectory = dirname(databasePath);
  try {
    mkdirSync(databaseDirectory, { recursive: true });
  } catch (cause) {
    throw new PortolanError(
      'CONFIG_INVALID',
      `Could not create the data directory ${databaseDirectory} for database.path in ${configPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { directory: databaseDirectory, config: configPath },
    );
  }

  return { configPath, configCreated, databaseDirectory };
}
