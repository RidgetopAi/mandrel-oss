/**
 * ACTIVITY TOUCH — the SINGLE owner of `sessions.last_activity_at`'s write policy.
 * Makes the column mean "are you working", not "did you store something".
 * (an earlier task bug 2 — the read path; an earlier task — the write path.)
 *
 * =============================================================================
 * ONE COLUMN, ONE THROTTLE
 * =============================================================================
 * The read-path liveness change threw the read path through this throttle and left the write path calling
 * `SessionRepo.touchActivity` directly, so the column had two independent writers with
 * two policies — "volume is a function of wall clock" on one side and "volume is a
 * function of traffic" on the other. Both now enter here: reads via `noteToolActivity`,
 * writes via `noteSessionActivity`, sharing one window per session. The invariant is
 * kept by a source-level guard, not by memory:
 * src/tests/sessionActivityTouchSingleWriter.contract.test.ts asserts that this file is
 * the ONLY runtime caller of `SessionRepo.touchActivity`.
 *
 * =============================================================================
 * THE BUG
 * =============================================================================
 * `last_activity_at` advanced on WRITES only. Every caller of
 * `SessionTracker.updateSessionActivity` / `OperationTracker.recordOperation` is a
 * content-producing path (handlers/context.ts, handlers/tasks.ts, handlers/decisions.ts).
 * So an agent that read context for an hour, ran searches and walked threads had a
 * session that read DORMANT — and every consumer of session liveness inherited that lie:
 * the Sessions UI, the LIVE NOW grouping, and the actor-mode dormanter/closer windows,
 * all of which are defined off this one column.
 *
 * =============================================================================
 * WHY THE SEAM IS `runWithProjectScope`
 * =============================================================================
 * The touch must fire for READS, and reads do not pass through any of the write-side
 * trackers by construction. The choke point that EVERY tool call passes through — flat
 * `/mcp/tools/*` and the gateway dispatcher, read and write alike — is `routeExecutor`,
 * and the first thing `routeExecutor` does is establish the ambient project scope via
 * `services/effectiveProjectScope.ts#runWithProjectScope`. Hooking the touch there means
 * a new read tool is covered the day it is added, with nothing to remember: the coverage
 * is a property of the transport wrap, not of a list someone maintains (a past incident —
 * anchor on the choke point, not on the shapes you had in mind).
 *
 * Deliberately NOT keyed on `opRegistry.effect`. `effect` classifies what an op does to
 * PERSISTENT STATE, which is the right question for the caller-identity guards and the
 * wrong one here: for liveness, a read IS activity, so the population is "every op",
 * and any subsetting would re-create the bug for whatever falls outside the subset.
 *
 * =============================================================================
 * THE COST, AND WHAT WE DO ABOUT IT
 * =============================================================================
 * Touching a row on every read turns every read into a write on a shared production DB.
 * Unthrottled, that makes UPDATE volume a function of READ volume — the larger and less
 * predictable of the two. So the touch is THROTTLED IN MEMORY, per session:
 *
 *   at most ONE `UPDATE sessions SET last_activity_at` per session per
 *   SESSION_CONFIG.activityTouchMinIntervalSec (default 60s), regardless of call rate.
 *
 * Write amplification is therefore bounded by (open sessions x wall-clock), not by
 * traffic: a session doing 10,000 reads in an hour issues at most 60 UPDATEs, and one
 * doing 10 reads in an hour issues at most 10. The throttle interval (60s) is 1/60th of
 * the smallest window any consumer measures (`idleDormantSec`, 3600s), so no consumer can
 * observe the coarsening.
 *
 * The throttle is per-process RAM. Two processes serving the same session will each issue
 * up to one UPDATE per interval; that is a bounded constant factor, not an amplification,
 * and a cross-process throttle would need shared state whose upkeep costs more than the
 * writes it saves.
 *
 * =============================================================================
 * WHAT IT WILL NOT DO
 * =============================================================================
 * 1. IT NEVER CREATES A SESSION. The session id comes from the in-RAM
 *    `ActiveSessionStore` — a synchronous map lookup, no DB read, no resolver. If this
 *    connection has no session in RAM, the call is skipped entirely. Lazy session
 *    creation is the action gate's job (`ACTION_TOOLS`, routes/index.ts) and reads must
 *    not spawn session rows.
 * 2. IT NEVER CHANGES A SESSION'S STATUS. `SessionRepo.touchActivity` carries
 *    `WHERE ... AND status = 'active'`, and that is KEPT ON PURPOSE here, not inherited:
 *      - for an ENDED/inactive session, advancing the timestamp would produce a row that
 *        reads "active a moment ago" while being closed — a worse lie than the one this
 *        task fixes;
 *      - for a DORMANT or INTERRUPTED session, the correct transition is a real
 *        re-attach: `SessionRepo.reactivate` sets `status='active'` AND refreshes the
 *        timestamp, under the resolver's re-attach-window policy. A bare timestamp bump
 *        from a read would bypass that policy and leave a row that is dormant-but-fresh,
 *        which no consumer knows how to read.
 *    So the touch can only make an ALREADY-LIVE session look live. It can never
 *    resurrect a parked one. A parked session is revived by the resolver, as before.
 * 3. IT NEVER BLOCKS OR FAILS A CALL. Fire-and-forget with a swallowed error (the
 *    underlying repo already logs). A liveness heartbeat must not be able to fail a read.
 */

import { SESSION_CONFIG } from '../../config/sessionConfig.js';
import { ActiveSessionStore } from './state/ActiveSessionStore.js';
import { SessionRepo } from './infra/db/SessionRepo.js';

/** sessionId -> epoch ms of the last UPDATE this process ISSUED for it. */
const lastTouchBySession = new Map<string, number>();

/**
 * Observable counters. These exist so the throttle can be MEASURED rather than asserted
 * (C1: name the instrument). `issued` is the only one that costs a DB write.
 */
export interface ActivityTouchStats {
  /** Calls into noteToolActivity(). */
  considered: number;
  /** Skipped: the kill switch is off. */
  skippedDisabled: number;
  /** Skipped: this connection has no session in RAM (nothing to touch, nothing created). */
  skippedNoSession: number;
  /** Skipped: an UPDATE for this session was already issued inside the throttle window. */
  suppressedByThrottle: number;
  /** UPDATE statements actually issued. */
  issued: number;
}

const stats: ActivityTouchStats = {
  considered: 0,
  skippedDisabled: 0,
  skippedNoSession: 0,
  suppressedByThrottle: 0,
  issued: 0,
};

/** In-flight touches, so a test (or a shutdown path) can wait for the DB write to land. */
const inFlight = new Set<Promise<void>>();

/** A snapshot of the counters. */
export function activityTouchStats(): ActivityTouchStats {
  return { ...stats };
}

/**
 * Wait for every touch this process has already dispatched. Fire-and-forget is right for
 * production (a heartbeat must not add latency to a read) but untestable without a join
 * point, so this is it. Never rejects.
 */
export async function awaitPendingActivityTouches(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Reset counters + throttle state. For tests and for an operator who has just changed
 * the interval at runtime; harmless at any time (a cleared throttle costs at most one
 * extra UPDATE per session).
 */
export function resetActivityTouchState(): void {
  lastTouchBySession.clear();
  stats.considered = 0;
  stats.skippedDisabled = 0;
  stats.skippedNoSession = 0;
  stats.suppressedByThrottle = 0;
  stats.issued = 0;
}

/**
 * Drop throttle entries that can no longer suppress anything. An entry older than the
 * throttle interval is dead weight by definition, so this is reclamation, never a
 * behaviour change.
 */
function sweepIfLarge(now: number, intervalMs: number): void {
  if (lastTouchBySession.size <= SESSION_CONFIG.activityTouchThrottleMaxEntries) return;
  for (const [sessionId, at] of lastTouchBySession) {
    if (now - at >= intervalMs) lastTouchBySession.delete(sessionId);
  }
}

/**
 * Record that a tool call happened on `connectionId`. Synchronous, allocation-light, and
 * safe to call on the hot path of every request; the DB write (when the throttle allows
 * one) is dispatched without being awaited.
 *
 * Config is read PER CALL, not captured at module load, so an operator (or a test) can
 * change the interval or flip the kill switch without a restart.
 */
/**
 * THE ONE PLACE `sessions.last_activity_at` IS ADVANCED.
 *
 * Throttle + issue, keyed on SESSION id. Both public entry points below funnel here, so
 * there is exactly ONE throttle window per session no matter which path reached it: a
 * read that has just claimed the window suppresses the write that follows it, and vice
 * versa. Before the single-writer change the write path called `SessionRepo.touchActivity` directly and
 * this window did not apply to it at all — one column, two policies. MEASURED pre-fix:
 * 20 `context_store` calls in one window issued 21 UPDATE statements at the `db.query`
 * seam; post-fix, 1.
 *
 * Returns the in-flight write so an awaiting caller (the write handlers, which have
 * always awaited their touch) keeps its ordering guarantee. A suppressed touch resolves
 * immediately. Never rejects.
 *
 * Deliberately NOT exported: an external caller could reach it with a session id it has
 * not accounted for in `stats.considered`. The two exported entry points are the surface.
 */
function throttledTouch(sessionId: string): Promise<void> {
  const now = Date.now();
  const intervalMs = SESSION_CONFIG.activityTouchMinIntervalSec * 1000;
  const last = lastTouchBySession.get(sessionId);
  if (last !== undefined && now - last < intervalMs) {
    stats.suppressedByThrottle++;
    return Promise.resolve();
  }

  // Claim the window BEFORE the await. A burst of concurrent calls for one session must
  // collapse to a single UPDATE; claiming after the write would let all of them through.
  lastTouchBySession.set(sessionId, now);
  sweepIfLarge(now, intervalMs);
  stats.issued++;

  // `SessionRepo.touchActivity` swallows and logs its own errors, so this catch is not a
  // recovery path and does not pretend to be one: it exists only so that a future
  // rejection (or a stubbed repo) can never surface as an unhandled rejection on a
  // fire-and-forget heartbeat. The throttle window stays claimed either way — releasing
  // it on failure would let a session whose UPDATE matches no row (see the
  // `status='active'` note above) retry on every single read, unthrottled.
  const p: Promise<void> = SessionRepo.touchActivity(sessionId)
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
  return p;
}

/**
 * READ PATH. Record that a tool call happened on `connectionId`. Synchronous,
 * allocation-light, and safe to call on the hot path of every request; the DB write (when
 * the throttle allows one) is dispatched without being awaited.
 *
 * Config is read PER CALL, not captured at module load, so an operator (or a test) can
 * change the interval or flip the kill switch without a restart.
 */
export function noteToolActivity(connectionId?: string): void {
  stats.considered++;

  if (!SESSION_CONFIG.activityTouchOnRead) {
    stats.skippedDisabled++;
    return;
  }

  // Pure RAM lookup — deliberately not the resolver. No DB read, no session creation.
  const sessionId = ActiveSessionStore.get(connectionId);
  if (!sessionId) {
    stats.skippedNoSession++;
    return;
  }

  void throttledTouch(sessionId);
}

/**
 * WRITE PATH. Record that a content-producing operation completed for `sessionId`
 *. Called by `SessionTracker.updateSessionActivity` — the seam every
 * write handler already goes through — and by `OperationTracker.recordOperation`.
 *
 * WHY THE KILL SWITCH IS NOT CONSULTED HERE, AND THIS IS NOT AN OVERSIGHT.
 * `activityTouchOnRead` is documented as a kill switch whose OFF state "restores the
 * pre-task behaviour exactly: writes still touch, reads stop touching". Consulting it
 * here would silently promote it to a global liveness-off switch, so an operator reaching
 * for the documented escape hatch (read-touch volume on a shared DB) would instead
 * freeze `last_activity_at` for every session in the fleet and hand the dormanter a
 * fleet-wide false dormancy. Convergence of the two writers is about the THROTTLE — one
 * policy for one column — not about merging two different questions into one flag.
 *
 * Awaited by its callers, unlike the read path: the write handlers have always awaited
 * their touch, and a write's liveness bump is ordered with respect to the row it wrote.
 */
export async function noteSessionActivity(sessionId: string): Promise<void> {
  stats.considered++;
  if (!sessionId) {
    stats.skippedNoSession++;
    return;
  }
  await throttledTouch(sessionId);
}
