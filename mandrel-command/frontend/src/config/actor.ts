/**
 * Actor display — the single, named home for how the Command UI renders the session
 * "actor" (the "who ran it" attribution dimension). One label, one normalization rule,
 * used everywhere (configs-not-hardcoded; an earlier task display part).
 *
 * `actor` is ATTRIBUTION, not authz. A session may carry a real principal ("coordinator",
 * "operator", "tick", …), or it may be UNATTRIBUTED — which means any of: no actor at all
 * (null/undefined, a pre-actor / header-less session) OR the mcp-server sentinel
 * `'anonymous'` (stamped when no X-Actor-ID/auth actor was derivable). Those are the
 * SAME thing to a human reader, so they collapse to ONE neutral label here instead of
 * sprawling as a literal "anonymous" row plus a separate "unattributed" row.
 */

/**
 * The one neutral label shown for a session with no attributable actor. Sourced here so
 * no component hardcodes the string (previously duplicated across dashboard/sessions
 * configs and inlined literally in StreamCard).
 */
export const UNATTRIBUTED_ACTOR = 'unattributed' as const;

/**
 * The mcp-server sentinel actor (mirrors mcp-server config/actorRegistry `ACTOR_ANONYMOUS`)
 * — a stamped-but-not-really-attributed value we normalize to UNATTRIBUTED_ACTOR.
 */
export const ANONYMOUS_ACTOR = 'anonymous' as const;

/**
 * True when `actor` is a real, attributable principal. False for null/undefined, an
 * empty/whitespace string, or the `anonymous` sentinel — every "no real who" case.
 */
export function isAttributed(actor: string | null | undefined): actor is string {
  if (actor == null) return false;
  const trimmed = actor.trim();
  if (trimmed === '') return false;
  return trimmed.toLowerCase() !== ANONYMOUS_ACTOR;
}

/** The human-facing label for an actor: the real slug, or the neutral UNATTRIBUTED_ACTOR. */
export function actorLabel(actor: string | null | undefined): string {
  return isAttributed(actor) ? actor : UNATTRIBUTED_ACTOR;
}

/**
 * Accent palette the actor dot cycles through (deterministic per actor slug), so every
 * actor keeps a stable colour without a hardcoded per-actor map. CSS custom-property
 * names only — resolved with `var(--x)` at the callsite (no hex ever lands).
 */
export const ACTOR_DOT_PALETTE = [
  '--teal',
  '--violet',
  '--blue',
  '--green',
  '--amber',
  '--rose',
] as const;

/**
 * Deterministic accent var for an actor (stable dot colour per actor). A non-attributed
 * actor (null / empty / anonymous) gets the muted text token, not an accent.
 */
export function actorDotVar(actor: string | undefined | null): string {
  if (!isAttributed(actor)) return '--tx-4';
  let h = 0;
  for (let i = 0; i < actor.length; i += 1) h = (h * 31 + actor.charCodeAt(i)) >>> 0;
  return ACTOR_DOT_PALETTE[h % ACTOR_DOT_PALETTE.length];
}
