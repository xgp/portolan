/**
 * Query preparation for FTS5 (SPEC.md §9, §46, §47).
 *
 * Two jobs:
 *
 * 1. **Safety.** A caller's query never reaches `MATCH` as syntax. FTS5 has its own
 *    query language — `"`, `*`, `NEAR/3`, `AND`/`OR`/`NOT`, column filters — and passing
 *    an agent-supplied string through raw means a stray quote is a syntax error and a
 *    crafted string is a query-language injection. Everything is tokenized and re-quoted.
 *
 * 2. **Recall.** BM25 is purely lexical, so "disable a user" cannot match "deactivate an
 *    account" on its own. A small, domain-neutral synonym table bridges the common cases
 *    without embeddings or any external service (docs/DEVIATIONS.md D4). Expansion terms
 *    widen the candidate set; the ranking step in `ranking.ts` still prefers the words
 *    the caller actually typed.
 */

/** Words that carry no signal in an API-capability query. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'this',
  'to',
  'us',
  'was',
  'we',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'you',
  'your',
  'api',
  'endpoint',
  'operation',
  'request',
  'please',
  'need',
]);

/**
 * Domain-neutral synonyms for verbs and nouns that recur across HTTP APIs.
 * Deliberately small and hand-audited: every entry is a word an OpenAPI document
 * plausibly uses for the same concept.
 */
const SYNONYMS: Record<string, string[]> = {
  disable: ['deactivate', 'enabled', 'suspend', 'deactivated', 'inactive', 'lock'],
  enable: ['activate', 'enabled', 'unlock', 'reactivate'],
  delete: ['remove', 'destroy', 'purge', 'erase'],
  remove: ['delete', 'destroy'],
  create: ['add', 'new', 'register', 'post'],
  add: ['create', 'register'],
  update: ['modify', 'edit', 'change', 'patch', 'replace', 'put'],
  modify: ['update', 'edit', 'change'],
  find: ['search', 'query', 'lookup', 'list', 'get'],
  search: ['find', 'query', 'lookup', 'list'],
  list: ['index', 'all', 'search', 'get'],
  get: ['fetch', 'retrieve', 'read', 'show'],
  fetch: ['get', 'retrieve'],
  user: ['users', 'account', 'member', 'principal'],
  account: ['user', 'customer'],
  group: ['groups', 'role', 'team', 'membership'],
  permission: ['role', 'scope', 'grant', 'privilege'],
  credential: ['secret', 'password', 'token', 'key'],
  password: ['credential', 'secret'],
  email: ['mail', 'address'],
  subscription: ['plan', 'billing'],
  invoice: ['billing', 'charge'],
  payment: ['charge', 'transaction'],
  certificate: ['cert', 'key', 'keystore'],
  identity: ['idp', 'provider', 'federation'],
  upload: ['import', 'post'],
  download: ['export', 'get'],
};

export interface PreparedQuery {
  /** Tokens the caller actually typed, lowercased and de-duplicated. */
  terms: string[];
  /** Synonym-derived tokens, disjoint from `terms`. */
  expansions: string[];
  /** A safe FTS5 MATCH expression, or `null` when nothing searchable remains. */
  match: string | null;
}

/** Split into alphanumeric tokens. Anything FTS5 would treat as syntax is discarded. */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

export function prepareQuery(
  query: string,
  { expand = true }: { expand?: boolean } = {},
): PreparedQuery {
  const raw = tokenize(query);
  const terms: string[] = [];
  for (const token of raw) {
    // Single characters and stop words produce noise, but keep them if they are all
    // the caller gave us.
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    if (!terms.includes(token)) terms.push(token);
  }
  if (terms.length === 0) {
    for (const token of raw) if (!terms.includes(token)) terms.push(token);
  }

  const expansions: string[] = [];
  if (expand) {
    for (const term of terms) {
      for (const synonym of SYNONYMS[term] ?? []) {
        if (!terms.includes(synonym) && !expansions.includes(synonym)) expansions.push(synonym);
      }
    }
  }

  const all = [...terms, ...expansions].slice(0, 64);
  const match = all.length === 0 ? null : all.map(quoteTerm).join(' OR ');
  return { terms, expansions, match };
}

/**
 * Quote a token for FTS5 and allow a prefix match.
 *
 * FTS5 string literals are double-quoted with `""` as the escape, so a token containing a
 * quote cannot break out. Tokenization has already removed quotes, but the escape stays
 * as defence in depth: this function must be safe for *any* input, not only for input
 * that happens to have been tokenized first.
 */
export function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"*`;
}
