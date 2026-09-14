/** Structured logging redaction (SPEC.md §38). */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACTED_PATHS } from '../../src/logging.js';

/** Build a logger with Portolan's redaction config writing into a buffer. */
function capturingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = pino(
    { level: 'trace', redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } },
    stream,
  );
  return { logger, lines };
}

describe('log redaction', () => {
  it('redacts credential headers on a request or response object', () => {
    const { logger, lines } = capturingLogger();
    logger.info({
      headers: {
        authorization: 'Bearer super-secret',
        cookie: 'session=super-secret',
        'content-type': 'application/json',
      },
    });
    const output = lines.join('');
    expect(output).not.toContain('super-secret');
    expect(output).toContain('[REDACTED]');
    // Non-sensitive headers survive, or the logs would be useless.
    expect(output).toContain('application/json');
  });

  it('redacts token-like fields wherever they appear', () => {
    const { logger, lines } = capturingLogger();
    logger.info({
      token: 'secret-1',
      access_token: 'secret-2',
      client_secret: 'secret-3',
      password: 'secret-4',
      nested: { token: 'secret-5', access_token: 'secret-6' },
    });
    const output = lines.join('');
    for (let i = 1; i <= 6; i++) expect(output, `secret-${i}`).not.toContain(`secret-${i}`);
  });

  it('keeps the fields SPEC.md §38 asks to record', () => {
    const { logger, lines } = capturingLogger();
    logger.info(
      {
        request_id: 'req-1',
        api_id: 'keycloak',
        operation_id: 'users.update',
        environment: 'production',
        method: 'PUT',
        host: 'auth.example.com',
        status: 204,
        duration_ms: 41,
      },
      'api response',
    );
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      request_id: 'req-1',
      api_id: 'keycloak',
      operation_id: 'users.update',
      environment: 'production',
      method: 'PUT',
      host: 'auth.example.com',
      status: 204,
      duration_ms: 41,
    });
  });

  it('covers every header name SPEC.md §38 forbids logging', () => {
    const forbidden = ['authorization', 'cookie', 'set-cookie'];
    for (const name of forbidden) {
      expect(
        REDACTED_PATHS.some((path) => path.toLowerCase().includes(name)),
        name,
      ).toBe(true);
    }
  });
});
