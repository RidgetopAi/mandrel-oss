/**
 * HANDOFF RESUME POINTER — the named rule.
 *
 * THE MEASURED FAILURE THIS ENCODES AGAINST (2026-08-23):
 * three handoffs were stored with EMPTY tag arrays by a session that had a declared
 * branch position open and correctly concluded its writes were already threaded.
 * Threading WAS fine. But "which handoff is live" is resolved by three independent
 * systems through the `ref:resume` TAG, not through the edge graph — the boot hook,
 * riverbend/runtime/branch-board/board.config.ts, and riverbend/runtime/tree-drift/
 * config.ts (a live daily cron). All three went blind at once and the next cold
 * session read its MODE and PATH out of a four-generations-superseded handoff.
 *
 * WHY IT LIVES IN THE PRODUCT AND NOT IN A RULE. `services/handoffSupersession.ts`
 * already fires on every `type:handoff` store and mints a DECLARED supersedes edge —
 * something on the write path already knows "this is a handoff" and already acts on
 * it. The pointer that three consumers actually read belongs in the same place.
 * House rule: a rule that lives as prose is the expensive, weak
 * version; the same rule encoded in the write path is the cheap, strong one.
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. The rule lives here as named
 * exports, read by exactly one module (services/handoffResumePointer.ts).
 *
 * WHAT IS *NOT* TUNABLE, AND WHY — the same refusal positionalMembershipConfig.ts
 * makes. There is no env read in this file on purpose. `ref:resume` is not a knob: it
 * is the NAME three external consumers hard-resolve. A deployment that renamed it, or
 * switched the guarantee off, would keep reporting successful handoff stores while the
 * boot ritual silently read a stale one — which is exactly the failure being encoded
 * against, reintroduced as configuration.
 */

/** The context_type whose stores carry the resume pointer. Mirrors TRUNK_CONTEXT_TYPE. */
export const RESUME_POINTER_CONTEXT_TYPE = 'handoff';

/** The ref slug three consumers resolve "which handoff is live" through. */
export const RESUME_POINTER_SLUG = 'resume';

/** The full tag guaranteed present on every stored handoff. */
export const RESUME_POINTER_TAG = `ref:${RESUME_POINTER_SLUG}`;

/**
 * The exact sentence surfaced to the caller when the SERVER added the tag. A caller
 * must be able to tell "I passed this" from "Mandrel added this" (task acceptance 3),
 * so this reads as an action the server took, not as advice.
 */
export const RESUME_POINTER_ADDED_NOTE =
  `Added "${RESUME_POINTER_TAG}" — every ${RESUME_POINTER_CONTEXT_TYPE} carries the resume ` +
  `pointer so boot/recall resolves the NEWEST one. Server-added, not supplied by the caller.`;
