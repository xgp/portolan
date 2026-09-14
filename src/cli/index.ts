#!/usr/bin/env node
/** The `portolan` CLI (SPEC.md §40). */
import { Command } from 'commander';
import { PortolanError } from '../errors/errors.js';
import { doctorExitCode, formatDoctorReport, runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { runServe } from './serve.js';

const VERSION = '0.1.0';

function fail(error: unknown): never {
  if (PortolanError.is(error)) {
    console.error(`portolan: ${error.code}: ${error.message}`);
  } else {
    console.error(`portolan: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('portolan')
    .description('MCP API catalog and execution runtime for OpenAPI-described HTTP APIs')
    .version(VERSION)
    .option(
      '-c, --config <path>',
      'path to config.yaml (default: $PORTOLAN_CONFIG or ~/.config/portolan/config.yaml)',
    );

  program
    .command('init')
    .description('create the configuration and data directories if they do not exist')
    .action(() => {
      try {
        const result = runInit(program.opts<{ config?: string }>().config);
        console.log(
          result.configCreated
            ? `Created ${result.configPath}`
            : `Configuration already exists at ${result.configPath} (left untouched)`,
        );
        console.log(`Data directory: ${result.databaseDirectory}`);
        console.log('');
        console.log('Next: add Portolan to your MCP client, for example');
        console.log('  {"mcpServers": {"portolan": {"command": "portolan", "args": ["serve"]}}}');
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('serve')
    .description('run the MCP server')
    .option('-t, --transport <transport>', 'stdio or http')
    .option('--host <host>', 'bind address for the http transport')
    .option('--port <port>', 'port for the http transport', (value) => Number.parseInt(value, 10))
    .action(async (options: { transport?: string; host?: string; port?: number }) => {
      try {
        if (options.transport && options.transport !== 'stdio' && options.transport !== 'http') {
          throw new PortolanError(
            'INVALID_ARGUMENT',
            `Unknown transport '${options.transport}'. Use stdio or http.`,
          );
        }
        const handle = await runServe({
          ...(program.opts<{ config?: string }>().config
            ? { configPath: program.opts<{ config?: string }>().config }
            : {}),
          ...(options.transport ? { transport: options.transport as 'stdio' | 'http' } : {}),
          ...(options.host ? { host: options.host } : {}),
          ...(options.port !== undefined ? { port: options.port } : {}),
        });

        if (handle.transport === 'http') {
          // stdout is free to use here; only the stdio transport owns it.
          console.log(`Portolan listening on ${handle.url}`);
        }

        const shutdown = () => {
          void handle.close().finally(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('doctor')
    .description('check configuration, storage, search, sandbox and credentials')
    .action(async () => {
      try {
        const report = await runDoctor(program.opts<{ config?: string }>().config);
        console.log(formatDoctorReport(report));
        process.exit(doctorExitCode(report));
      } catch (error) {
        fail(error);
      }
    });

  return program;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli/index.js') || process.argv[1].endsWith('portolan'));

if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch(fail);
}
