/**
 * sessionConfig — the session-lifecycle knobs (Session-Rework SR-1,  * ref:session-rework).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every session-lifecycle tunable — the idle/close window and the re-attach window —
 * lives HERE: a named value with an operator-aligned default, a one-line doc comment, and
 * an env override. Never a literal buried in the service. Mirrors threadConfig.ts /
 * recallConfig.ts / trustConfig.ts: the config is the contract, the code reads it.
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default),
 * exactly like recallConfig.envInt / threadConfig.envInt.
 *
 * THE MODEL (the operator 2026-06-22):
 *   A session = PER CONNECTION (keyed on the stable connection id the bridge sends as
 *   X-Connection-ID, persisted on the session row so it survives a SERVER restart).
 *   START = first action (auto) OR manual. END = 1h idle OR manual.
 *   reattach_window == idle_timeout == 1h, and they are KEPT EQUAL (a session is
 *   re-attachable for exactly as long as the reaper leaves it open) — see the
 *   single source SESSION_CONFIG.idleTimeoutSec below.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a boolean env var, falling back to `fallback` on missing/unknown. Accepts (case-
 * and whitespace-insensitive) 1/true/yes/on → true and 0/false/no/off → false; anything
 * else (incl. empty/missing) → `fallback`. Same tolerant shape as envInt/envEnum.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * Read an enum env var, falling back to `fallback` on missing/unknown value. Case- and
 * whitespace-insensitive so `MANDREL_SESSION_RESOLVER_MODE=Shadow ` resolves cleanly.
 */
function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Sessions Foundation Phase 2a — the shared-resolver mode (the auditor review §6 Phase 2,
 * an earlier decision). The ENTIRE Phase 2a deliverable is INERT by default: this flag
 * decides whether the new resolveSession() is even consulted.
 *
 *   'legacy' (DEFAULT) — current behavior EXACTLY. The new resolver is NOT consulted;
 *       resolution stays connection-keyed (getActiveSession). Merging/deploying in this
 *       mode changes NOTHING. This is the safe default the whole phase is built around.
 *   'shadow' — compute BOTH the legacy resolution AND the new resolveSession(), ACT ON
 *       LEGACY, and log agree/disagree + increment the shadow counters
 *       (sessions_resolver_shadow_agree / _disagree). How we gather confidence on the
 *       test tenant BEFORE any cutover — zero behavior change, observation only.
 *   'actor' — act on the new resolveSession(). Reserved for the Phase 2b cutover; NOT
 *       set anywhere in 2a.
 */
export type ResolverMode = 'legacy' | 'shadow' | 'actor';
export const RESOLVER_MODES: readonly ResolverMode[] = ['legacy', 'shadow', 'actor'] as const;

export interface SessionConfig {
  /**
   * idleTimeoutSec — a session with no activity for this long is CLOSED by the idle
   * reaper (status=inactive + ended_at stamped, RAM entry evicted). Also the END
   * trigger described in the model. The operator: 1 HOUR (was 2h).
   * Env: MANDREL_SESSION_IDLE_TIMEOUT_SEC. Default 3600 (1h).
   */
  idleTimeoutSec: number;
  /**
   * reattachWindowSec — on an action with no valid in-RAM session, the newest OPEN
   * (ended_at NULL, status active|interrupted) session for the SAME connection id
   * within this window is RE-ATTACHED instead of minting a new one. This is the core
   * fix for random-spawning after a server restart. KEPT EQUAL to idleTimeoutSec by
   * default (the operator: "keep them equal") — a session is re-attachable exactly as long
   * as the reaper has not yet closed it. Env: MANDREL_SESSION_REATTACH_WINDOW_SEC.
   * Default = idleTimeoutSec (1h).
   */
  reattachWindowSec: number;
  /**
   * reaperSweepIntervalSec — how often the LEGACY idle reaper (SessionTimeoutService in
   * legacy/shadow mode) wakes to CLOSE sessions idle past idleTimeoutSec. This is the sweep
   * cadence, NOT the idle window itself. Env: MANDREL_SESSION_REAPER_SWEEP_SEC. Default 300
   * (5 min). Actor mode uses dormanterSweepIntervalSec + closerSweepIntervalSec instead.
   */
  reaperSweepIntervalSec: number;
  /**
   * reaperFailureAlertAfter — how many CONSECUTIVE failed reaper sweeps before the service
   * escalates from a per-sweep error line to a single, distinctly-greppable CRITICAL line.
   * The reaper is one whole-table UPDATE, so a single bad row aborts the WHOLE sweep and no
   * session is reaped at all; the callers swallow that into logger.error and setInterval keeps
   * firing, so without an escalation the outage is indistinguishable from routine noise
   *. Env: MANDREL_SESSION_REAPER_FAILURE_ALERT_AFTER. Default 3 sweeps.
   */
  reaperFailureAlertAfter: number;
  /**
   * Sessions Foundation Phase 3 — ACTOR-MODE lifecycle windows (the auditor review §4.2/§5).
   * All UTC-agnostic durations in seconds; the reaper passes them to the DB sweep functions
   * as INTERVALs (never hardcoded in SQL). Only consulted when resolverMode==='actor'.
   */
  /**
   * idleDormantSec — an active/interrupted session with no activity for this long is marked
   * 'dormant' by the dormanter (ended_at STAYS NULL — resumable; NOT ended). This is the
   * active→dormant window, the Break-2 fix's first step. Env: MANDREL_SESSION_IDLE_DORMANT_SEC.
   * Default 3600 (1h) — matches the historical idle window, but now yields dormancy, not death.
   */
  idleDormantSec: number;
  /**
   * hardCapSec — a DORMANT session whose LAST ACTIVITY is older than this is ENDED (with full
   * finalize) by the closer. Idle-based dormancy cap: "gone this long → the next action starts
   * a fresh session." Measured from last_activity_at (so a session dormant since idleDormantSec
   * is closed hardCapSec after its last activity). Env: MANDREL_SESSION_HARD_CAP_SEC.
   * Default 18000 (5h).
   *
   * WHY 5h (the operator, an earlier decision / ref:session-boundary — was 24h): a session models a
   * SITTING — it ends when you stop working, not on the calendar. The boundary is TOTAL
   * INACTIVITY: dormant at 1h (idleDormantSec, resumable — a lunch break must not split your
   * session), then ended 5h after the LAST action. 5h = "dormant 1h + 4h more": long enough
   * that no realistic pause inside one sitting trips it, short enough that yesterday's work
   * doesn't bleed into today's session. At the old 24h a session left overnight was still
   * re-joinable the next morning, welding two distinct sittings into one record.
   */
  hardCapSec: number;
  /**
   * absoluteCapSec — backstop: ANY open session (active|interrupted|dormant) whose started_at
   * is older than this is ENDED (with full finalize) by the closer, regardless of recent
   * activity — so a continuously-active thread cannot live forever. Measured from started_at
   * (UTC-correct, timestamptz). Env: MANDREL_SESSION_ABSOLUTE_CAP_SEC. Default 604800 (7d).
   */
  absoluteCapSec: number;
  /**
   * dormanterSweepIntervalSec — how often the ACTOR-MODE dormanter wakes to demote idle
   * active/interrupted sessions → dormant. Env: MANDREL_SESSION_DORMANTER_SWEEP_SEC.
   * Default 300 (5 min) — same cadence as the legacy reaper it replaces in actor mode.
   */
  dormanterSweepIntervalSec: number;
  /**
   * closerSweepIntervalSec — how often the ACTOR-MODE closer wakes to finalize dormant
   * sessions past hardCapSec (or any open session past absoluteCapSec). Runs less often than
   * the dormanter — closing is coarse-grained. Env: MANDREL_SESSION_CLOSER_SWEEP_SEC.
   * Default 3600 (1h).
   */
  closerSweepIntervalSec: number;
  /**
   * flushIntervalSec — how often SessionFlushService persists in-memory session data
   * (token + activity counters) to the DB, so a crash loses at most this window.
   * Env: MANDREL_SESSION_FLUSH_SEC. Default 30 (30 s).
   */
  flushIntervalSec: number;
  /**
   * ramStoreCleanupIntervalSec — how often the in-RAM ActiveSessionStore sweeps stale
   * per-connection entries. Env: MANDREL_SESSION_RAMSTORE_CLEANUP_SEC. Default 600 (10 min).
   */
  ramStoreCleanupIntervalSec: number;
  /**
   * ramStoreMaxIdleSec — a per-connection RAM entry unused for longer than this is
   * evicted by the cleanup sweep above. Env: MANDREL_SESSION_RAMSTORE_MAX_IDLE_SEC.
   * Default 86400 (24 h).
   */
  ramStoreMaxIdleSec: number;
  /**
   * resolverMode — Sessions Foundation Phase 2a: gates the shared resolveSession().
   * 'legacy' (DEFAULT) = new resolver not consulted, behavior unchanged; 'shadow' =
   * compute-both / act-legacy / log agree-disagree; 'actor' = act on new resolver (2b
   * cutover only). Env: MANDREL_SESSION_RESOLVER_MODE. See the ResolverMode doc above.
   */
  resolverMode: ResolverMode;
  /**
   * requireActor — Sessions Foundation Phase 4: the header-less TIGHTENING (the auditor review
   * §4.3/§5 "header-less writes rejected"). DARK by default (false): when a write action
   * has no derivable actor it falls to the flagged `anonymous` actor exactly as today. When
   * TRUE, the action gate REJECTS such a write with a clear error naming the missing
   * `X-Actor-ID` header (fail loud) instead of silently minting an anonymous
   * session. This is the mechanism to deprecate `http-default`/anonymous once first-party
   * callers all declare actors (watch sessions_created_anonymous_actor → ~0, then flip this
   * on PER ENVIRONMENT). Independent of resolverMode — it gates the incoming header, not
   * resolution. Env: MANDREL_SESSION_REQUIRE_ACTOR. Default false.
   */
  requireActor: boolean;
  /**
   * activityTouchOnRead — whether a READ tool call advances the caller's
   * `sessions.last_activity_at` (bug 2). Default TRUE.
   *
   * WHY THIS EXISTS. Before this flag, `last_activity_at` moved ONLY on a write
   * (handlers/context.ts, handlers/tasks.ts, handlers/decisions.ts →
   * SessionTracker.updateSessionActivity, plus OperationTracker.recordOperation). An
   * agent that spent an hour searching, recalling and walking threads still reported
   * DORMANT, so every consumer of session liveness — the Sessions UI, the LIVE NOW
   * grouping, the dormanter/closer windows — was reading "did you store something",
   * not "are you working".
   *
   * IT IS A KILL SWITCH, not a feature flag: turning it OFF restores the pre-task
   * behaviour exactly (writes still touch; reads stop touching), which is the escape
   * hatch if the added UPDATE volume is ever a problem on a shared DB.
   * Env: MANDREL_SESSION_ACTIVITY_TOUCH_ON_READ.
   */
  activityTouchOnRead: boolean;
  /**
   * activityTouchMinIntervalSec — the THROTTLE. At most one
   * `UPDATE sessions SET last_activity_at` is issued per session per this many seconds,
   * no matter how many calls arrive. Default 60.
   *
   * WHY A THROTTLE IS MANDATORY HERE. Touching a row on every read turns every read into
   * a write on a shared production database; an unthrottled hook makes write volume a
   * function of READ volume, which is the larger and less predictable of the two. With
   * the throttle, UPDATE volume is bounded by (open sessions x wall-clock), completely
   * independent of request rate.
   *
   * WHY 60s IS THE RIGHT DEFAULT. The coarsest consumer of this column is the actor-mode
   * dormanter, whose window is `idleDormantSec` (3600s). A 60s granularity is 1/60th of
   * the smallest window anything measures, so no consumer can observe the difference —
   * while cutting a busy session's read-touch writes from thousands per hour to at most 60.
   * Env: MANDREL_SESSION_ACTIVITY_TOUCH_MIN_INTERVAL_SEC.
   */
  activityTouchMinIntervalSec: number;
  /**
   * activityTouchThrottleMaxEntries — soft cap on the in-RAM throttle map before it
   * sweeps entries older than the throttle interval. A map entry older than
   * `activityTouchMinIntervalSec` can never suppress anything, so sweeping is pure
   * reclamation. Default 10000. Env: MANDREL_SESSION_ACTIVITY_TOUCH_MAX_ENTRIES.
   */
  activityTouchThrottleMaxEntries: number;
}

/**
 * THE LIVE CONFIG — read once at module load. Defaults are operator-aligned values
 * (1h window, re-attach == idle); both env-overridable. The re-attach window defaults
 * to whatever the idle timeout resolves to, so the "keep them equal" invariant holds
 * even when only the idle timeout is overridden — but it can still be overridden
 * independently if an operator ever needs to.
 */
const idleTimeoutSec = envInt('MANDREL_SESSION_IDLE_TIMEOUT_SEC', 3600);

export const SESSION_CONFIG: SessionConfig = {
  idleTimeoutSec,
  reattachWindowSec: envInt('MANDREL_SESSION_REATTACH_WINDOW_SEC', idleTimeoutSec),
  reaperSweepIntervalSec: envInt('MANDREL_SESSION_REAPER_SWEEP_SEC', 300),
  reaperFailureAlertAfter: envInt('MANDREL_SESSION_REAPER_FAILURE_ALERT_AFTER', 3),
  // Phase 3 actor-mode lifecycle windows (env-overridable; passed to the DB sweeps as INTERVALs).
  idleDormantSec: envInt('MANDREL_SESSION_IDLE_DORMANT_SEC', 3600),
  hardCapSec: envInt('MANDREL_SESSION_HARD_CAP_SEC', 18000),
  absoluteCapSec: envInt('MANDREL_SESSION_ABSOLUTE_CAP_SEC', 604800),
  dormanterSweepIntervalSec: envInt('MANDREL_SESSION_DORMANTER_SWEEP_SEC', 300),
  closerSweepIntervalSec: envInt('MANDREL_SESSION_CLOSER_SWEEP_SEC', 3600),
  flushIntervalSec: envInt('MANDREL_SESSION_FLUSH_SEC', 30),
  ramStoreCleanupIntervalSec: envInt('MANDREL_SESSION_RAMSTORE_CLEANUP_SEC', 600),
  ramStoreMaxIdleSec: envInt('MANDREL_SESSION_RAMSTORE_MAX_IDLE_SEC', 86400),
  // Phase 2a: INERT by default — 'legacy' means the new resolver is never consulted.
  resolverMode: envEnum<ResolverMode>('MANDREL_SESSION_RESOLVER_MODE', RESOLVER_MODES, 'legacy'),
  // Phase 4: header-less tightening — DARK by default (anonymous behavior unchanged).
  requireActor: envBool('MANDREL_SESSION_REQUIRE_ACTOR', false),
  // an earlier Task bug 2: reads advance last_activity_at, throttled to one UPDATE per
  // session per minute. ON by default — the bug it closes is that liveness was a proxy
  // for "did you write", not for "are you working".
  activityTouchOnRead: envBool('MANDREL_SESSION_ACTIVITY_TOUCH_ON_READ', true),
  activityTouchMinIntervalSec: envInt('MANDREL_SESSION_ACTIVITY_TOUCH_MIN_INTERVAL_SEC', 60),
  activityTouchThrottleMaxEntries: envInt('MANDREL_SESSION_ACTIVITY_TOUCH_MAX_ENTRIES', 10000),
};

/** The idle/timeout window as a Postgres INTERVAL literal (e.g. '3600 seconds'). */
export function idleTimeoutInterval(): string {
  return `${SESSION_CONFIG.idleTimeoutSec} seconds`;
}

/** Phase 3: active→dormant window as a Postgres INTERVAL literal (configs-not-hardcoded). */
export function idleDormantInterval(): string {
  return `${SESSION_CONFIG.idleDormantSec} seconds`;
}

/** Phase 3: dormant→ended hard cap as a Postgres INTERVAL literal. */
export function hardCapInterval(): string {
  return `${SESSION_CONFIG.hardCapSec} seconds`;
}

/** Phase 3: absolute (since started_at) backstop cap as a Postgres INTERVAL literal. */
export function absoluteCapInterval(): string {
  return `${SESSION_CONFIG.absoluteCapSec} seconds`;
}
