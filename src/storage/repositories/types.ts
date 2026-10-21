/** Row shapes persisted by the repositories (SPEC.md §8). */

export interface ApiRecord {
  id: string;
  name: string;
  description: string | null;
  aliases: string[];
  tags: string[];
  currentVersionId: string | null;
  /** Upstream repository (`owner/name`) supplied through add_api, if any. */
  upstreamRepo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiVersionRecord {
  id: string;
  apiId: string;
  openapiVersion: string | null;
  infoVersion: string | null;
  infoTitle: string | null;
  infoDescription: string | null;
  specHash: string;
  specJson: string;
  /** The document as received, before corrections (D20). `null` for rows from before migration 2. */
  sourceSpecJson: string | null;
  sourceType: 'url' | 'content' | null;
  sourceUri: string | null;
  createdAt: string;
}

export interface OperationRecord {
  id: string;
  apiVersionId: string;
  canonicalId: string;
  sourceOperationId: string | null;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  tags: string[];
  deprecated: boolean;
  searchText: string | null;
  paramText: string | null;
  schemaText: string | null;
  operationJson: string;
}

/** Where an environment came from. Only `config` environments may be trusted with
 *  credentials or mutation rights (docs/DEVIATIONS.md D6). */
export type EnvironmentSource = 'config' | 'spec' | 'add_api';

export interface EnvironmentRecord {
  id: string;
  apiId: string;
  name: string;
  baseUrl: string;
  authProfile: string | null;
  isDefault: boolean;
  allowMutations: boolean;
  source: EnvironmentSource;
  createdAt: string;
  updatedAt: string;
}

/** Who found a flaw: Portolan's own repair pass (D21) or an agent through add_api (D20). */
export type CorrectionOrigin = 'portolan' | 'agent';

/**
 * - `applied`: the correction is part of the current document.
 * - `stale`: an agent correction that no longer applies to the upstream document.
 * - `resolved`: a Portolan repair the upstream document no longer needs.
 * - `reported`: a flaw reported without a patch.
 * - `reverted`: an agent correction withdrawn through add_api.
 */
export type CorrectionStatus = 'applied' | 'stale' | 'resolved' | 'reported' | 'reverted';

export type UpstreamIssueStatus = 'filed' | 'existing' | 'draft' | 'failed' | 'rate_limited';

export interface CorrectionRecord {
  id: string;
  apiId: string;
  origin: CorrectionOrigin;
  kind: string;
  fingerprint: string;
  title: string;
  description: string | null;
  /** RFC 6902 operations as JSON, or `null` for a report without a fix. */
  patchJson: string | null;
  status: CorrectionStatus;
  upstreamRepo: string | null;
  upstreamIssueUrl: string | null;
  upstreamIssueStatus: UpstreamIssueStatus | null;
  createdAt: string;
  updatedAt: string;
}
