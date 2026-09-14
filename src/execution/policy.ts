/**
 * Execution policy (SPEC.md §29, §30).
 *
 * Two independent gates, both evaluated before any network activity:
 *
 * - **Mutation policy.** A mutating method requires `allow_mutations` on the selected
 *   environment. The agent cannot change this; importing a specification cannot grant it.
 * - **Network policy.** The destination is derived from the environment's base URL, never
 *   from anything the agent supplies. An OpenAPI document must not be able to turn
 *   Portolan into a generic HTTP proxy.
 */
import { PortolanError } from '../errors/errors.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import { assertUrlAllowed } from '../net/safe-fetch.js';
import { isMutatingMethod } from '../openapi/types.js';
import type { EnvironmentRecord } from '../storage/repositories/types.js';

export function assertMutationAllowed(
  environment: EnvironmentRecord,
  method: string,
  operationId: string,
): void {
  if (!isMutatingMethod(method)) return;
  if (environment.allowMutations) return;
  throw new PortolanError(
    'MUTATION_NOT_ALLOWED',
    `Operation '${operationId}' uses ${method.toUpperCase()}, which mutates state, but environment '${environment.name}' of API '${environment.apiId}' does not allow mutations. An operator must set allow_mutations: true for that environment in config.yaml.`,
    {
      api_id: environment.apiId,
      environment: environment.name,
      method: method.toUpperCase(),
      operation_id: operationId,
    },
  );
}

/**
 * Build the absolute request URL from the environment base URL and the operation path.
 *
 * The path is joined to the base, never used to replace it: a path that looks absolute
 * (`//evil.example.com/x`, `https://evil.example.com/x`) must not escape the base URL.
 */
export function buildRequestUrl(baseUrl: string, path: string, queryString: string): string {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const relative = path.replace(/^\/+/, '');
  const url = new URL(relative, base);

  if (url.origin !== base.origin) {
    throw new PortolanError(
      'NETWORK_DESTINATION_BLOCKED',
      `The operation path '${path}' resolves outside the environment base URL '${baseUrl}'.`,
      { base_url: baseUrl, path },
    );
  }
  // A path escaping upward past the base must not reach an unrelated part of the host.
  if (!url.pathname.startsWith(new URL(base).pathname)) {
    throw new PortolanError(
      'NETWORK_DESTINATION_BLOCKED',
      `The operation path '${path}' escapes the environment base path '${base.pathname}'.`,
      { base_url: baseUrl, path },
    );
  }

  url.search = queryString ? `?${queryString}` : '';
  return url.toString();
}

export function assertDestinationAllowed(url: string, policy: NetworkPolicyOptions): URL {
  return assertUrlAllowed(url, policy);
}
