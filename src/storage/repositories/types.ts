/** Row shapes persisted by the repositories (SPEC.md §8). */

export interface ApiRecord {
  id: string;
  name: string;
  description: string | null;
  aliases: string[];
  tags: string[];
  currentVersionId: string | null;
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
