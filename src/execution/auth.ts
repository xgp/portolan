/**
 * Authentication (SPEC.md §26, §27, §3.5).
 *
 * Secrets are read from the process environment at call time and applied to the outgoing
 * request. They are never persisted, never logged, never returned by a tool, and never
 * visible to `run_api_code`.
 *
 * A profile may declare `allowed_hosts`. When it does, the profile refuses to sign a
 * request for any other host — an independent check that survives a mistake anywhere in
 * environment resolution (docs/DEVIATIONS.md D5).
 */
import { PortolanError } from '../errors/errors.js';
import type { AuthProfileConfig } from '../config/schema.js';
import { hostMatches } from '../net/address-policy.js';
import type { OAuthTokenCache } from './oauth.js';

export interface AppliedAuth {
  headers: Record<string, string>;
  /** Query parameters to append, already name/value decoded. */
  query: [string, string][];
  cookies: [string, string][];
  /** Names of the headers carrying credentials, so redirects can drop exactly those. */
  credentialHeaders: string[];
  /** Query parameter names carrying credentials, so URLs can be redacted before return. */
  credentialQueryParams: string[];
}

export const EMPTY_AUTH: AppliedAuth = {
  headers: {},
  query: [],
  cookies: [],
  credentialHeaders: [],
  credentialQueryParams: [],
};

function requireEnv(name: string, profileName: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new PortolanError(
      'AUTH_FAILED',
      `Auth profile '${profileName}' needs environment variable ${name}, which is not set.`,
      { auth_profile: profileName, environment_variable: name },
    );
  }
  return value;
}

function assertHostPermitted(profile: AuthProfileConfig, profileName: string, host: string): void {
  const allowed = profile.allowed_hosts;
  if (!allowed || allowed.length === 0) return;
  if (allowed.some((pattern) => hostMatches(host, pattern))) return;
  throw new PortolanError(
    'AUTH_FAILED',
    `Auth profile '${profileName}' is restricted to [${allowed.join(', ')}] and will not sign a request to '${host}'.`,
    { auth_profile: profileName, host },
  );
}

export class AuthResolver {
  constructor(
    private readonly profiles: Readonly<Record<string, AuthProfileConfig>>,
    private readonly oauth: OAuthTokenCache,
  ) {}

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.profiles, name);
  }

  /** Resolve credentials for a request to `host`. */
  async apply(profileName: string | null, host: string): Promise<AppliedAuth> {
    if (!profileName) return EMPTY_AUTH;

    const profile = this.profiles[profileName];
    if (!profile) {
      throw new PortolanError(
        'AUTH_PROFILE_NOT_FOUND',
        `No authentication profile named '${profileName}' is configured.`,
        { auth_profile: profileName },
      );
    }
    assertHostPermitted(profile, profileName, host);

    switch (profile.type) {
      case 'bearer': {
        const token = requireEnv(profile.token_env, profileName);
        return {
          ...EMPTY_AUTH,
          headers: { authorization: `Bearer ${token}` },
          credentialHeaders: ['authorization'],
        };
      }

      case 'api_key': {
        const value = `${profile.prefix ?? ''}${requireEnv(profile.value_env, profileName)}`;
        if (profile.location === 'header') {
          return {
            ...EMPTY_AUTH,
            headers: { [profile.name.toLowerCase()]: value },
            credentialHeaders: [profile.name.toLowerCase()],
          };
        }
        if (profile.location === 'query') {
          return {
            ...EMPTY_AUTH,
            query: [[profile.name, value]],
            credentialQueryParams: [profile.name],
          };
        }
        return { ...EMPTY_AUTH, cookies: [[profile.name, value]], credentialHeaders: ['cookie'] };
      }

      case 'basic': {
        const username = requireEnv(profile.username_env, profileName);
        const password = requireEnv(profile.password_env, profileName);
        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        return {
          ...EMPTY_AUTH,
          headers: { authorization: `Basic ${encoded}` },
          credentialHeaders: ['authorization'],
        };
      }

      case 'oauth2_client_credentials': {
        const token = await this.oauth.getToken(profileName, {
          tokenUrl: profile.token_url,
          clientId: requireEnv(profile.client_id_env, profileName),
          clientSecret: requireEnv(profile.client_secret_env, profileName),
          ...(profile.scopes ? { scopes: profile.scopes } : {}),
          ...(profile.audience ? { audience: profile.audience } : {}),
          clientAuth: profile.client_auth,
        });
        return {
          ...EMPTY_AUTH,
          headers: { authorization: `Bearer ${token}` },
          credentialHeaders: ['authorization'],
        };
      }
    }
  }

  /**
   * Report whether the environment variables a profile needs are present, without
   * revealing any value. Used by `portolan doctor` (SPEC.md §40).
   */
  describeReadiness(profileName: string): { profile: string; type: string; missing: string[] } {
    const profile = this.profiles[profileName];
    if (!profile) return { profile: profileName, type: 'unknown', missing: [] };
    const required: string[] = [];
    switch (profile.type) {
      case 'bearer':
        required.push(profile.token_env);
        break;
      case 'api_key':
        required.push(profile.value_env);
        break;
      case 'basic':
        required.push(profile.username_env, profile.password_env);
        break;
      case 'oauth2_client_credentials':
        required.push(profile.client_id_env, profile.client_secret_env);
        break;
    }
    return {
      profile: profileName,
      type: profile.type,
      missing: required.filter((name) => !process.env[name]),
    };
  }
}
