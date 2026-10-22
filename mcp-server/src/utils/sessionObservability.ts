/**
 * Session observability counters (Sessions Foundation Phase 5, the auditor review §5 / F3).
 *
 * The current system loses session attribution SILENTLY (F3): the action gate proceeds
 * session-less on failure, the tracking middleware silent-fails, and a write can land with
 * session_id NULL — all logged at warn but never surfaced as a metric. A past incident (fail
 * loud, don't silent-degrade): make each of those losses a VISIBLE counter on the existing
 * monitoring singleton so operators can watch attribution health, not discover it from a
 * NULL-ratio query weeks later (A6).
 *
 * ONE place defines the counter names + label shapes (a past incident — centralize, no N drifting
 * copies). Every call site imports a named helper, never a raw string. These are pure telemetry
 * (in-memory counters); they never throw and never change behavior.
 *
 * Counters:
 *   sessions_resolver_path        — which precedence path the ONE resolver picked
 *                                   (explicit | pin | newest-open | lazy-create). Emitted from
 *                                   resolveSession, so it fires only when the resolver is
 *                                   consulted (shadow/actor modes — never in legacy default).
 *   sessions_writes_without_session — an ACTION tool (context_store | task_create |
 *                                   decision_record) completed but attributed to NO session
 *                                   (session_id NULL): the concrete attribution loss (A6).
 *   sessions_ensure_failures      — the action gate's ensureSessionForAction swallowed an error
 *                                   and proceeded session-less (the fail-open path, F3).
 *
 * Companion counters already exist: sessions_created_anonymous_actor (Phase 1),
 * sessions_resolver_shadow_agree/_disagree (Phase 2a).
 */

import { monitoring } from './monitoring.js';

/** The resolver precedence path that was taken (mirrors resolveSession's ResolveSource). */
export type ResolverPath = 'explicit' | 'pin' | 'newest-open' | 'lazy-create';

/**
 * Record which precedence path the ONE resolver picked. Called from resolveSession, so it
 * increments only when the resolver is consulted (resolverMode shadow or actor) — never in the
 * legacy default. Labeled by path so the mix (how often lazy-create vs re-join) is visible.
 */
export function recordResolverPath(path: ResolverPath): void {
  monitoring.incrementCounter('sessions_resolver_path', { path });
}

/**
 * Record that an action tool wrote content with NO session attributed (session_id NULL).
 * Labeled by the action tool so the loss is attributable to a surface.
 */
export function recordWriteWithoutSession(tool: string): void {
  monitoring.incrementCounter('sessions_writes_without_session', { tool });
}

/**
 * Record that the action gate's lazy session-ensure threw and was swallowed (fail-open).
 * Labeled by the action tool whose write proceeded session-less.
 */
export function recordEnsureFailure(tool: string): void {
  monitoring.incrementCounter('sessions_ensure_failures', { tool });
}
