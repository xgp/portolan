/**
 * OAuth2 client-credentials token acquisition (SPEC.md §27).
 *
 * Tokens live in process memory only — never in SQLite, never in a log, never in a tool
 * response — and are refreshed shortly before expiry.
 */
import { PortolanError } from '../errors/errors.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import { safeFetch } from '../net/safe-fetch.js';

export interface ClientCredentialsRequest {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  audience?: string;
  clientAuth: 'body' | 'basic';
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** Refresh this long before the token actually expires. */
const REFRESH_MARGIN_MS = 30_000;

export class OAuthTokenCache {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly policy: NetworkPolicyOptions,
    private readonly timeoutMs: number,
    private readonly maxRedirects: number,
  ) {}

  async getToken(profileName: string, request: ClientCredentialsRequest): Promise<string> {
    const key = cacheKey(profileName, request);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.accessToken;

    // Collapse concurrent refreshes so a burst of calls does not stampede the token
    // endpoint.
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.fetchToken(profileName, request)
      .then((token) => {
        this.tokens.set(key, token);
        return token.accessToken;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, pending);
    return pending;
  }

  /** Drop a cached token, e.g. after the remote API answers 401. */
  invalidate(profileName: string, request: ClientCredentialsRequest): void {
    this.tokens.delete(cacheKey(profileName, request));
  }

  clear(): void {
    this.tokens.clear();
  }

  private async fetchToken(
    profileName: string,
    request: ClientCredentialsRequest,
  ): Promise<CachedToken> {
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (request.scopes && request.scopes.length > 0) form.set('scope', request.scopes.join(' '));
    if (request.audience) form.set('audience', request.audience);

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (request.clientAuth === 'basic') {
      const credentials = Buffer.from(`${request.clientId}:${request.clientSecret}`).toString(
        'base64',
      );
      headers.authorization = `Basic ${credentials}`;
    } else {
      form.set('client_id', request.clientId);
      form.set('client_secret', request.clientSecret);
    }

    let response;
    try {
      response = await safeFetch(request.tokenUrl, {
        method: 'POST',
        headers,
        body: form.toString(),
        timeoutMs: this.timeoutMs,
        maxBytes: 65_536,
        maxRedirects: this.maxRedirects,
        policy: this.policy,
      });
    } catch (cause) {
      if (PortolanError.is(cause) && cause.code === 'NETWORK_DESTINATION_BLOCKED') throw cause;
      throw new PortolanError(
        'AUTH_FAILED',
        `Could not reach the token endpoint for auth profile '${profileName}': ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { auth_profile: profileName },
      );
    }

    if (response.status < 200 || response.status >= 300) {
      // The error body can echo the client secret back; only the status is reported.
      throw new PortolanError(
        'AUTH_FAILED',
        `The token endpoint for auth profile '${profileName}' returned HTTP ${response.status}.`,
        { auth_profile: profileName, status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new PortolanError(
        'AUTH_FAILED',
        `The token endpoint for auth profile '${profileName}' did not return JSON.`,
        { auth_profile: profileName },
      );
    }

    const token = payload as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
    if (typeof token.access_token !== 'string' || token.access_token === '') {
      throw new PortolanError(
        'AUTH_FAILED',
        `The token endpoint for auth profile '${profileName}' returned no access_token.`,
        { auth_profile: profileName },
      );
    }

    const expiresInSeconds = typeof token.expires_in === 'number' ? token.expires_in : 3600;
    return {
      accessToken: token.access_token,
      expiresAt: Date.now() + Math.max(expiresInSeconds, 1) * 1000,
    };
  }
}

function cacheKey(profileName: string, request: ClientCredentialsRequest): string {
  // The secret is not part of the key; the profile name plus target identifies the grant.
  return [
    profileName,
    request.tokenUrl,
    request.clientId,
    (request.scopes ?? []).join(' '),
    request.audience ?? '',
  ]
    .map((part) => `${part.length}:${part}`)
    .join('|');
}
