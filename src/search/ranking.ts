/**
 * Score shaping shared by API and operation search (SPEC.md §17, §18, §46).
 */

/**
 * SQLite's `bm25()` returns an unbounded negative number, more negative meaning a better
 * match. Callers want a positive, bounded score. This mapping is monotonic and fixed —
 * not relative to the result set — so scores are comparable between calls
 * (docs/DEVIATIONS.md D13).
 */
export function normalizeScore(relevance: number): number {
  const positive = Math.max(0, relevance);
  return Math.round((1 - Math.exp(-positive / 4)) * 100) / 100;
}

/**
 * Reward a candidate for containing the words the caller actually typed, as opposed to
 * synonym expansions. Without this, expansion can float a weakly-related operation above
 * an exact match.
 */
export function termCoverageBonus(
  fields: readonly (string | null | undefined)[],
  terms: readonly string[],
  perTerm = 1.5,
): number {
  if (terms.length === 0) return 0;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  let matched = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matched += 1;
  }
  return (matched / terms.length) * perTerm * terms.length;
}

/** Which query terms a candidate actually contains, for the `matched` field in §17. */
export function matchedTerms(
  fields: readonly (string | null | undefined)[],
  terms: readonly string[],
  limit = 8,
): string[] {
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return terms.filter((term) => haystack.includes(term)).slice(0, limit);
}
