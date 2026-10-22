/**
 * Navigation id-resolver configuration (named tunables — no magic numbers inline).
 *
 * Governs the UNIFIED short-id → record resolver used by the navigation SPINE
 * (GET /api/r/:id): given a bare id (full UUID or hex prefix) it discovers which
 * of the three types (decision / task / context) the id belongs to and returns
 * the canonical record so the route can 302-redirect to the frontend detail page.
 *
 * This mirrors the contract of the Mandrel-core id resolver
 * (mcp-server/src/utils/idResolver.ts) and the Command search predicate
 * (utils/searchPredicates.ts) — same normalization, same parameterized prefix
 * match, same fail-closed ambiguity handling. It has its OWN minimum-length floor
 * because navigation demands a stricter prefix than free-text search: search may
 * treat a 6-char hex run as an id hint, but resolving a bare id to a single record
 * must require the 8-char short-id form every tool reference uses (the core
 * resolver's MIN_SHORT_ID_LENGTH = 8).
 *
 * All values are env-overridable so behavior can be tuned per environment without
 * code changes (standing rule: tunables live in organized named config, never
 * hardcoded).
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const resolveConfig = {
  /**
   * Minimum length (hex chars, dashes stripped) of a short id the navigation
   * resolver will accept. Below this the input is rejected as invalid rather than
   * run as a prefix that could match a flood of records. 8 chars = 32 bits of
   * prefix entropy, the short-id form every Mandrel task/decision reference uses;
   * matches the core resolver's MIN_SHORT_ID_LENGTH.
   */
  shortIdMinLength: intFromEnv('RESOLVE_SHORT_ID_MIN_LENGTH', 8),

  /**
   * Hard cap on candidate rows pulled for an ambiguous prefix. Anything beyond 1
   * already means "ambiguous — do not pick"; the cap simply bounds how many
   * candidates we surface for disambiguation and prevents an absurdly short prefix
   * from pulling unbounded rows. Matches the core resolver's LIMIT 25 guard.
   */
  maxCandidates: intFromEnv('RESOLVE_MAX_CANDIDATES', 25),

  /**
   * Max length of the human-pickable content snippet used as a context's label in
   * an ambiguity list (contexts have no title). Keeps the disambiguation payload
   * compact.
   */
  contextLabelSnippetLength: intFromEnv('RESOLVE_CONTEXT_SNIPPET_LENGTH', 60),
} as const;

export default resolveConfig;
