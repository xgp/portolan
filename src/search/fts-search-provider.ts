/**
 * The FTS5 implementation of {@link SearchProvider} (SPEC.md §9).
 *
 * Keeping search behind this interface is what makes a later move to embeddings or a
 * hybrid ranker a drop-in replacement rather than a rewrite.
 */
import type { Database } from '../storage/database.js';
import type { ApiSearchResult, OperationSearchResult, SearchProvider } from '../services/types.js';
import { searchApis } from './api-search.js';
import { searchOperations } from './operation-search.js';

export class FtsSearchProvider implements SearchProvider {
  constructor(private readonly db: Database) {}

  searchApis(query: string, limit: number): Promise<ApiSearchResult[]> {
    return Promise.resolve(searchApis(this.db, query, limit));
  }

  searchOperations(
    apiId: string,
    query: string,
    limit: number,
    filters?: { tags?: string[]; methods?: string[] },
  ): Promise<OperationSearchResult[]> {
    return Promise.resolve(searchOperations(this.db, apiId, query, limit, filters ?? {}));
  }
}
