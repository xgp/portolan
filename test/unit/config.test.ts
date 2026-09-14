import { describe, expect, it } from 'vitest';
import { parseConfig, isLoopbackHost } from '../../src/config/config.js';
import { PortolanError } from '../../src/errors/errors.js';

describe('config', () => {
  it('applies restrictive defaults when nothing is configured', () => {
    const config = parseConfig({}, 'test');
    expect(config.network.allow_private_addresses).toBe(false);
    expect(config.network.allow_loopback).toBe(false);
    expect(config.network.allow_http).toBe(false);
    expect(config.security.allow_agent_auth_profile_binding).toBe(false);
    expect(config.server.transport).toBe('stdio');
    expect(config.limits.max_spec_bytes).toBe(10_485_760);
    expect(config.limits.sandbox_max_api_calls).toBe(50);
  });

  // SPEC.md §39 / docs/DEVIATIONS.md D16.
  it('rejects unknown configuration keys instead of ignoring them', () => {
    expect(() => parseConfig({ netwrok: { allow_loopback: true } }, 'test')).toThrow(PortolanError);
    expect(() => parseConfig({ network: { allow_loopbak: true } }, 'test')).toThrow(
      /allow_loopbak|Unrecognized/i,
    );
  });

  it('rejects an environment that references an unknown auth profile', () => {
    expect(() =>
      parseConfig(
        {
          environments: [
            {
              api: 'x',
              name: 'production',
              base_url: 'https://x.example.com',
              auth_profile: 'nope',
            },
          ],
        },
        'test',
      ),
    ).toThrow(/unknown profile 'nope'/);
  });

  it('accepts each supported auth profile type', () => {
    const config = parseConfig(
      {
        auth_profiles: {
          b: { type: 'bearer', token_env: 'TOKEN' },
          k: { type: 'api_key', location: 'header', name: 'X-API-Key', value_env: 'KEY' },
          a: { type: 'basic', username_env: 'U', password_env: 'P' },
          o: {
            type: 'oauth2_client_credentials',
            token_url: 'https://example.com/token',
            client_id_env: 'CID',
            client_secret_env: 'CSEC',
            scopes: ['admin'],
          },
        },
      },
      'test',
    );
    expect(Object.keys(config.auth_profiles).sort()).toEqual(['a', 'b', 'k', 'o']);
  });

  it('rejects a literal secret placed where an env var name belongs', () => {
    expect(() =>
      parseConfig(
        { auth_profiles: { b: { type: 'bearer', token_env: 'sk-live-abc123!' } } },
        'test',
      ),
    ).toThrow(PortolanError);
  });

  // SPEC.md §40 / docs/DEVIATIONS.md D17.
  it('refuses an unauthenticated HTTP transport on a non-loopback host', () => {
    expect(() =>
      parseConfig({ server: { transport: 'http', http: { host: '0.0.0.0', port: 8765 } } }, 'test'),
    ).toThrow(/auth_token_env is required/);
  });

  it('allows a non-loopback HTTP transport once a token is configured', () => {
    const config = parseConfig(
      {
        server: {
          transport: 'http',
          http: { host: '0.0.0.0', port: 8765, auth_token_env: 'PORTOLAN_HTTP_TOKEN' },
        },
      },
      'test',
    );
    expect(config.server.http.auth_token_env).toBe('PORTOLAN_HTTP_TOKEN');
  });

  it('allows loopback HTTP without a token', () => {
    expect(() =>
      parseConfig({ server: { transport: 'http', http: { host: '127.0.0.1' } } }, 'test'),
    ).not.toThrow();
  });

  it.each(['localhost', '127.0.0.1', '127.5.5.5', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', 'example.com', '10.0.0.1'])('treats %s as non-loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
