/**
 * sessionActor (Command backend) — validation + normalization for the session
 * ACTOR read/slice dimension.
 *
 * WHY: the Sessions Foundation (migration 062) stamps a stable,
 * human-meaningful `actor` on every session at write time (operator, coordinator,
 * builder-<id8>, tick, deploy-smoke, anonymous…). The Command read models now
 * SERIALIZE that actor and let callers SLICE the session list / analytics / trends
 * by it (`?actor=<slug>`). This module is the single, config-driven place that
 * decides what a valid `actor` filter value looks like and normalizes it to match
 * how the mcp-server stamps it — so the two surfaces can never diverge on casing.
 *
 * SOURCE-OF-TRUTH NOTE: the actor TAXONOMY (which principals exist + their kind)
 * lives in the mcp-server (`mcp-server/src/config/actorRegistry.ts`); this file
 * intentionally holds ONLY the read-boundary VALIDATION RULE (a pure function), not
 * a second copy of the registry. The Command backend and the mcp-server are separate
 * services with no shared package, so the normalization rule is mirrored here (kept
 * byte-compatible with `normalizeActor`): lowercase slug of [a-z0-9-].
 *
 * TRUST MODEL: `actor` is ATTRIBUTION on the single-tenant container, NOT an authz
 * boundary — see the migration 062 comment. This filter is a read-side slice, never
 * an access-control decision.
 */

/**
 * Config knobs for the actor filter (configs-not-hardcoded — no magic numbers inline).
 */
export const SESSION_ACTOR_CONFIG = {
  /** Max accepted length of an actor slug (mirrors the mcp-server naming: short slugs). */
  maxLength: 64,
  /**
   * A normalized actor slug: lowercase alphanumerics separated by single hyphens,
   * no leading/trailing/doubled hyphen. Matches coordinator / tick / builder-<id8> /
   * deploy-smoke / anonymous. Anchored so the whole value must conform.
   */
  pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
} as const;

/**
 * Normalize a raw actor string so equivalent values collapse to one stable key:
 * trim → lowercase → whitespace runs to a single hyphen → collapse repeated hyphens
 * → strip edge hyphens. Empty/blank/undefined/null → undefined (no actor). Idempotent.
 * (Mirrors mcp-server `normalizeActor`; kept here because the services don't share a
 * package.)
 */
export function normalizeActor(input?: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const normalized = String(input)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized === '' ? undefined : normalized;
}

/**
 * Parse a request `actor` query param into a safe filter value, or `undefined` when
 * absent/invalid. Invalid values are DROPPED (returned as undefined) rather than
 * throwing — the same defensive posture the routes use for a malformed `project_id`
 * (see getAllSessionsParams.test.ts): a bad slice param must never 500 or become an
 * unfiltered "return everything" surprise, it simply yields no actor filter.
 *
 * Validation: normalize, then require it to be a bounded lowercase slug. Because every
 * SQL use of the result is a bound parameter ($n), this is hygiene/shape-guarding, not
 * the injection defense (that's parameterization).
 */
export function parseActorParam(raw?: unknown): string | undefined {
  const normalized = normalizeActor(raw);
  if (normalized === undefined) return undefined;
  if (normalized.length > SESSION_ACTOR_CONFIG.maxLength) return undefined;
  if (!SESSION_ACTOR_CONFIG.pattern.test(normalized)) return undefined;
  return normalized;
}
