/**
 * Search configuration (named tunables — no magic numbers inline).
 *
 * Governs the id-prefix lookup + partial-tag matching shared by the contexts,
 * tasks (and any future direct-SQL) search services. Mirrors the contract of the
 * Mandrel-core id resolver (mcp-server/src/utils/idResolver.ts) so the Command UI
 * search box behaves the same way the MCP tools do.
 *
 * All values are env-overridable so behavior can be tuned per environment without
 * code changes (the operator's standing rule: tunables live in organized named config,
 * never hardcoded).
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const searchConfig = {
  /**
   * Minimum length of a hex id-prefix before we treat a query as an id-prefix
   * lookup. Below this, a short alphanumeric query is treated as plain text only
   * (avoids e.g. "ab" matching a flood of ids). The task spec sets this floor at
   * 6 (so `0f3906cd` — 8 chars — qualifies).
   */
  idPrefixMinLength: intFromEnv('SEARCH_ID_PREFIX_MIN_LENGTH', 6),

  /**
   * Hard cap on rows pulled by an ambiguous id-prefix match, so an absurdly short
   * prefix can never pull unbounded rows into the OR predicate. Matches the
   * resolver's LIMIT 25 ambiguity guard.
   */
  idMaxCandidates: intFromEnv('SEARCH_ID_MAX_CANDIDATES', 25),

  /**
   * Default "top N" relevance results a query-mode (semantic) search returns when
   * the caller does not specify a limit (search consolidation).
   * Search mode has NO honest total to paginate (the engine returns a ranked top-N),
   * so this is the single knob for how many matches to surface. Browse mode keeps
   * real COUNT(*) pagination and its own per-page limit.
   */
  searchDefaultLimit: intFromEnv('SEARCH_DEFAULT_LIMIT', 50),

  /**
   * Hard cap on the `limit` we forward to the MCP `decision_search` tool, which
   * schema-validates `limit` at max 100 and 500s the whole request on anything
   * higher. We CLAMP to this here so any client passing a larger window (the P2
   * Decisions screen historically requested 150) degrades gracefully to the tool
   * max instead of erroring. Mirrors the mcp-server decision_search contract.
   */
  decisionSearchMaxLimit: intFromEnv('DECISION_SEARCH_MAX_LIMIT', 100),
} as const;

export default searchConfig;
