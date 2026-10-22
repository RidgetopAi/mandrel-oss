/**
 * resolveSession — THE ONE session-targeting resolver (Sessions Foundation Phase 2a,
 * The auditor review §4.1 / §5 "the ONE resolver").
 *
 * A single pure/injectable function implementing the targeting precedence that will replace
 * the three drifted "current session" definitions and the global fallback. It is INERT in
 * Phase 2a: only consulted when SESSION_CONFIG.resolverMode != 'legacy' (shadow logs, actor
 * acts — 2b only). The legacy connection-keyed path is untouched at the default.
 *
 * PRECEDENCE (first match wins):
 *   (a) EXPLICIT session id — a caller-supplied session_id, verified OPEN, resolved for ANY
 *       actor. Explicit = user intent, so it deliberately crosses actor boundaries (this is
 *       the ONLY sanctioned cross-actor access).
 *   (b) The actor's DB-persisted PIN — if set AND the pinned session is still open.
 *   (c) The actor's NEWEST OPEN session. For actors classified `automation` (tick,
 *       deploy-smoke, cron, anonymous…) this is additionally restricted to sessions started
 *       the same UTC day → a deterministic daily rollover (review §4.3). For human/agent
 *       actors there is no day restriction (their session persists across idle gaps).
 *   (d) LAZY-CREATE signal — nothing resolved; the action gate should create a session keyed
 *       by this actor. resolveSession NEVER creates; it only signals.
 *
 * HARD RULE: NO GLOBAL FALLBACK anywhere in here. It never calls getLastActive and never
 * resolves "the newest session anywhere" — the class of cross-actor misattribution this whole
 * redesign exists to kill. The only cross-actor path is (a), and only because the caller named
 * the exact session.
 *
 * INJECTABLE: all DB/registry access is via the `ports` object so every branch is unit-testable
 * in isolation with no DB. `defaultResolveSessionPorts()` binds the real repos + classifier.
 */

import { classifyActor, normalizeActor } from '../../../../config/actorRegistry.js';
import { SessionRepo, SessionPinRepo } from '../../infra/db/index.js';
import { recordResolverPath } from '../../../../utils/sessionObservability.js';

/** The source of a resolution — for logging, shadow comparison, and metrics. */
export type ResolveSource = 'explicit' | 'pin' | 'newest-open' | 'lazy-create';

/**
 * The resolver result. A concrete `sessionId` for explicit/pin/newest-open; `null` with
 * source 'lazy-create' when nothing resolved (the gate creates, keyed by actor).
 */
export type ResolveSessionResult =
  | { source: 'explicit' | 'pin' | 'newest-open'; sessionId: string }
  | { source: 'lazy-create'; sessionId: null };

/**
 * The injectable dependency surface. Pure branches call these; the default binding hits the
 * real DB. `classify` defaults to the actorRegistry classifier but is injectable for tests.
 */
export interface ResolveSessionPorts {
  /** True iff the session row exists AND is still OPEN (ended_at NULL, status active|interrupted). */
  existsActive(sessionId: string): Promise<boolean>;
  /** The actor's current DB pin (or null). Openness is re-validated here, not by the repo. */
  getPin(actor: string): Promise<{ sessionId: string } | null>;
  /** The actor's newest open session; `sameUtcDayOnly` restricts to today (UTC) for automation. */
  newestOpenForActor(actor: string, sameUtcDayOnly: boolean): Promise<string | null>;
  /** Classify the actor → human|agent|automation (decides the same-UTC-day rule). */
  classify(actor: string): 'human' | 'agent' | 'automation';
}

/** Real ports: SessionRepo + SessionPinRepo + the actorRegistry classifier. */
export function defaultResolveSessionPorts(): ResolveSessionPorts {
  return {
    existsActive: (sessionId) => SessionRepo.existsActive(sessionId),
    getPin: async (actor) => {
      const pin = await SessionPinRepo.getPin(actor);
      return pin ? { sessionId: pin.sessionId } : null;
    },
    newestOpenForActor: (actor, sameUtcDayOnly) => SessionRepo.newestOpenForActor(actor, sameUtcDayOnly),
    classify: (actor) => classifyActor(actor),
  };
}

/**
 * Resolve the session an action should target for `actor`, honoring an optional explicit
 * session id. Pure w.r.t. its ports; performs NO writes and NO session creation.
 *
 * @param actor            the raw principal string (normalized internally). May be blank/absent.
 * @param explicitSessionId a caller-named target session id (context_store's sessionId arg, etc.).
 * @param ports            injectable DB/registry access (default: defaultResolveSessionPorts()).
 */
export async function resolveSession(
  actor: string | null | undefined,
  explicitSessionId: string | null | undefined,
  ports: ResolveSessionPorts = defaultResolveSessionPorts()
): Promise<ResolveSessionResult> {
  const result = await resolveSessionInner(actor, explicitSessionId, ports);
  // Observability (Phase 5, F3 / §5): record which precedence path was picked. This is only
  // ever reached when the resolver is CONSULTED (resolverMode shadow or actor — legacy never
  // calls resolveSession), so it is a pure diagnostic signal with no behavior change and no
  // cost in the default path. Labeled by source: explicit | pin | newest-open | lazy-create.
  recordResolverPath(result.source);
  return result;
}

/**
 * The precedence logic itself — kept internal + free of side effects so every branch stays
 * trivially unit-testable with injected ports (no DB, no metrics coupling). The public
 * resolveSession wraps this to emit the sessions_resolver_path metric on the way out.
 */
async function resolveSessionInner(
  actor: string | null | undefined,
  explicitSessionId: string | null | undefined,
  ports: ResolveSessionPorts
): Promise<ResolveSessionResult> {
  // (a) EXPLICIT session id — user intent, any actor. Verified open (a stale/closed id falls
  //     through to the actor-scoped steps rather than resolving to a dead session).
  const explicit = explicitSessionId?.trim();
  if (explicit) {
    if (await ports.existsActive(explicit)) {
      return { source: 'explicit', sessionId: explicit };
    }
  }

  // Everything below is ACTOR-scoped. With no derivable actor, only an explicit id could
  // have resolved — signal lazy-create (the gate stamps the flagged anonymous actor on the
  // new row, exactly as Phase 1 does).
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor) {
    return { source: 'lazy-create', sessionId: null };
  }

  // (b) The actor's PIN — if set and STILL OPEN. A stale pin (session since closed/deleted)
  //     is ignored and we fall through; nothing is resurrected.
  const pin = await ports.getPin(normalizedActor);
  if (pin && (await ports.existsActive(pin.sessionId))) {
    return { source: 'pin', sessionId: pin.sessionId };
  }

  // (c) The actor's NEWEST OPEN session. Automation actors: same UTC day only (deterministic
  //     daily rollover). Human/agent actors: any open session (no day restriction).
  const sameUtcDayOnly = ports.classify(normalizedActor) === 'automation';
  const newest = await ports.newestOpenForActor(normalizedActor, sameUtcDayOnly);
  if (newest) {
    return { source: 'newest-open', sessionId: newest };
  }

  // (d) Nothing resolved — signal the action gate to lazily create, keyed by this actor.
  return { source: 'lazy-create', sessionId: null };
}
