/** `portolan init` (SPEC.md §40). */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultConfigPath, EXAMPLE_CONFIG, expandPath, loadConfig } from '../config/config.js';

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
  mkdirSync(databaseDirectory, { recursive: true });

  return { configPath, configCreated, databaseDirectory };
}
