/**
 * HOW project_briefing GOT ITS SPINE — the provenance + refusal vocabulary (FIX A).
 *
 * SK5 made the briefing branch-scoped from the caller's OPEN POSITION. That works for a
 * client that holds a position, and CANNOT work for the SessionStart boot hook: a position is
 * keyed on CONNECTION ID, the MCP bridge mints its own inside its process, and the hook is a
 * separate shell client on its own connection. Different slots, so the hook always landed on
 * the trunk fallback. FIX A adds an explicit `spine` argument, which means the spine now has
 * TWO possible origins — and a caller that cannot tell them apart cannot debug either one.
 * Hence a value, reported in a field, exactly as SK5 did for `spineId` itself.
 *
 * PRECEDENCE: `explicit` BEATS `position`. An argument is a DECLARED intent from the caller;
 * a position is an AMBIENT one the connection happens to be holding. Explicit beats ambient
 * is the same ladder the record-linking convention already uses for threading,
 * and the alternative — ambient state overriding what the caller asked for — is
 * the class of surprise that ladder exists to prevent.
 */
export const BRIEFING_SPINE_SOURCE = {
  /** The caller passed `spine` and it resolved. */
  explicit: 'explicit',
  /** No `spine` argument; the connection's open branch position supplied it. */
  position: 'position',
  /** No spine was used — trunk render. The pre-SK5 document, and a legitimate state. */
  none: 'none',
} as const;

export type BriefingSpineSource =
  (typeof BRIEFING_SPINE_SOURCE)[keyof typeof BRIEFING_SPINE_SOURCE];

/**
 * WHY AN EXPLICITLY-SUPPLIED SPINE WAS NOT USED. Reported in
 * `structuredContent.briefing.spineRefusal` (null when there was nothing to refuse).
 *
 * A refusal MUST be a field. The failure mode this closes is the one the whole STRONG BONES
 * program has been closing: the caller asked for a branch, got the global render, and nothing
 * in the response said so. A briefing that silently means something other than what was asked
 * for is worse than an error, because it reads as an answer.
 *
 * Resolution failures reuse services/spineResolver.ts's SPINE_REFUSAL values, so the reason a
 * branch_open would have given is the reason the briefing gives.
 */
export const BRIEFING_SPINE_REFUSAL = {
  /**
   * MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED is OFF, so branch scoping is refused — INCLUDING an
   * explicitly-supplied spine. THIS IS THE POINT OF THE FLAG, not an edge case: if an argument
   * could route around it, the flag would not be a tenant guarantee, it would be a default. A
   * tenant on the shipped default must get the pre-SK5 document no matter what any caller
   * passes.
   */
  flagOff: 'branch-scope-flag-off',
} as const;

export type BriefingSpineRefusal =
  (typeof BRIEFING_SPINE_REFUSAL)[keyof typeof BRIEFING_SPINE_REFUSAL];
