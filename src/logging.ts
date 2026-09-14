/**
 * Structured logging (SPEC.md §38).
 *
 * Two hard rules:
 *  1. Under the stdio transport, stdout carries JSON-RPC frames only. Logs go to stderr
 *     (or a file) and never to stdout.
 *  2. Credential-bearing fields are redacted by pino before serialization, so a careless
 *     `log.info({ headers })` cannot leak an Authorization header.
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';
import { expandPath } from './config/config.js';
import type { PortolanConfig } from './config/schema.js';

/** Header and field names that must never reach a log sink (SPEC.md §38). */
export const REDACTED_PATHS = [
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.Cookie',
  'headers["set-cookie"]',
  'headers["Set-Cookie"]',
  'headers["proxy-authorization"]',
  'headers["x-api-key"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'response.headers["set-cookie"]',
  'token',
  'access_token',
  'client_secret',
  'password',
  'secret',
  'credentials',
  '*.authorization',
  '*.token',
  '*.access_token',
  '*.client_secret',
  '*.password',
];

export type Logger = pino.Logger;

export function createLogger(config: PortolanConfig): Logger {
  const options: pino.LoggerOptions = {
    level: config.logging.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    base: { name: 'portolan' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.logging.destination === 'file' && config.logging.file) {
    const path = expandPath(config.logging.file);
    mkdirSync(dirname(path), { recursive: true });
    return pino(options, createWriteStream(path, { flags: 'a' }));
  }
  // Default: stderr. Never stdout — stdout is the MCP stdio transport.
  return pino(options, pino.destination({ dest: 2, sync: false }));
}

/** A logger that discards everything; used by tests and by `portolan doctor`. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
