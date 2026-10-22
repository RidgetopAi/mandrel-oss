/**
 * EDGE PROVENANCE METER + DECLARED-RATE ALARM CONFIG (an earlier decision —
 * PHASE 0 of the positional-membership plan).
 *
 * WHY THIS EXISTS (graph audit): the declared edge-minting path can die
 * while the guess keeps minting, and an undifferentiated edge count reads as full health —
 * measured live: auto:active_thread went 93→4→8→0/wk from 2026-07-20 while coverage read
 * 97-98% throughout, for 15 days. The alarm below watches the DECLARED class specifically.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES. Every
 * knob of the provenance alarm lives HERE — named, documented, env-overridable — mirroring
 * resilienceConfig.ts (whose alert this alarm deliberately shares machinery with).
 *
 * NOTE ON WHAT IS *NOT* HERE: the declared/guessed CLASSIFICATION itself. That is SQL —
 * the `link_provenance` view (migration 079) — and is deliberately not re-spelled in
 * TypeScript. This file holds only the alarm's tunables.
 */

/** Read a boolean env var ("true"/"1"/"yes"/"on" → true, "false"/"0"/"no"/"off" → false), else `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Read a positive-integer env var, else `fallback` (ignores zero/negative/garbage). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export interface ProvenanceConfig {
  /**
   * ALARM WORKER master switch — gates the SCHEDULED worker only (runOnce stays callable,
   * which is how the contract tests exercise the production invocation path directly).
   * DEFAULT `NODE_ENV === 'production'`, the same gate and for the same measured reason as
   * resilienceConfig.alertEnabled: a dev worktree with a notify script configured pages the
   * same people prod does, and an alert channel carrying dev noise trains its reader to
   * ignore it. env: MANDREL_PROVENANCE_ALARM_ENABLED
   */
  alarmEnabled: boolean;
  /**
   * THE FLOOR: minimum DECLARED-class edges that must exist in the rolling window for the
   * alarm to stay silent. `declaredCount < floor` fires. DEFAULT 10 per 7-day window:
   * healthy weeks on prod run ~200-400 declared edges (measured 2026-08-12, backtest in
   * an earlier task), so 10 is far below any healthy week while still catching the collapse
   * shape (4, 8, 0 per week). env: MANDREL_PROVENANCE_DECLARED_FLOOR
   */
  declaredFloor: number;
  /**
   * THE ROLLING WINDOW, in days, that declaredFloor is evaluated over. DEFAULT 7 (the grain
   * the audit measured the collapse at). env: MANDREL_PROVENANCE_WINDOW_DAYS
   */
  windowDays: number;
  /**
   * How often the worker re-evaluates the window (minutes). DEFAULT 60 — a dead minting
   * mechanism is a days-scale failure; hourly detection is far inside the 15-day blindness
   * this instrument exists to close. env: MANDREL_PROVENANCE_CHECK_INTERVAL_MINUTES
   */
  checkIntervalMinutes: number;
  /**
   * STATEMENT-LEVEL timeout (ms) on the alarm's two meter reads (countDeclaredInWindow,
   * measureSourceLiveness) — pg's per-query `query_timeout`, scoped to exactly those two
   * queries. Deliberately NOT a pool/server-wide statement_timeout: migrations and
   * backfills share the pool and may legitimately run long. WHY: the
   * server-side statement_timeout is 0 and the chain had no timeout at all, so one hung
   * meter query held runOnce's single-flight latch FOREVER — every later check returned
   * {skipped:true} and the alarm went silently blind. With this bound the hang THROWS,
   * which lands in the existing could-not-measure branch and PAGES. On timeout pg-pool
   * destroys that connection (release(err)), so the hung statement cannot poison the pool.
   * DEFAULT 30000 (30s — the meter queries run in milliseconds; matches the 30s bound
   * databasePool.ts already uses). env: MANDREL_PROVENANCE_METER_QUERY_TIMEOUT_MS
   */
  meterQueryTimeoutMs: number;
  /**
   * WATCHDOG bound (minutes) on the runOnce single-flight latch — belt to the query
   * timeout's suspenders. If a check has held the latch longer than this, the NEXT
   * scheduled check pages (a 'wedged' alert through the same dedupe/delivery path — never
   * a silent reset), clears the latch, and runs. DEFAULT 15 — a healthy check completes in
   * seconds and the query timeout bounds it near 1 min, so 15 min is generous while still
   * far inside the 15-day blindness this alarm exists to close.
   * env: MANDREL_PROVENANCE_CHECK_WATCHDOG_MINUTES
   */
  checkWatchdogMinutes: number;
  /**
   * Alert dedupe window (minutes): once fired (or once a could-not-measure alert is sent),
   * further alerts of the SAME kind are suppressed for this long. Dead-source alerts dedupe
   * PER SOURCE (kind = the source stamp). The condition persists until fixed, so an hourly
   * checker without dedupe would page every hour. DEFAULT 1440 (one page per day per kind).
   * env: MANDREL_PROVENANCE_ALERT_DEDUPE_MINUTES
   */
  alertDedupeMinutes: number;

  // ── DEAD-SOURCE LEG (the coordinator ruling on an earlier task's surfaced item 2) ────────────────
  // The declared-class floor above would NOT have fired on the 2026-07-28 incident: the
  // dying mechanism (auto:active_thread) is classified GUESSED, and the declared class
  // held ~300-420/wk through the collapse. The failure class the task exists to close is
  // "any single minting mechanism dies while the totals look healthy" — so the alarm also
  // watches each SOURCE (created_by stamp) that was recently active and pages when one
  // goes to ZERO in the current window.

  /**
   * A source counts as HISTORICALLY ACTIVE when at least one week in the lookback minted
   * at least this many edges. DEFAULT 20/wk — auto:active_thread ran 64-93/wk before its
   * death (measured, backtest in an earlier task) so it clears this comfortably, while
   * one-off/trickle stamps (e.g. 'link' at a few per week) stay below it and cannot page.
   * env: MANDREL_PROVENANCE_SOURCE_ACTIVE_PER_WEEK
   */
  sourceActivePerWeek: number;
  /**
   * How many weeks back a source's history is examined for the active test. DEFAULT 8.
   * env: MANDREL_PROVENANCE_SOURCE_LOOKBACK_WEEKS
   */
  sourceLookbackWeeks: number;
  /**
   * Sources whose DEATH IS EXPECTED AND ACCEPTED (e.g. auto:active_thread once Phase 1
   * ships and the anchor is retired). A retired source is suppressed from the dead-source
   * alert — retirement is an explicit, recorded CONFIG change, never a silenced alarm.
   * DEFAULT empty. env: MANDREL_PROVENANCE_RETIRED_SOURCES (comma-separated stamps).
   */
  retiredSources: readonly string[];
}

/** Read a comma-separated string-list env var, else `fallback`. Entries are trimmed;
 *  empties dropped. */
function envStrList(name: string, fallback: readonly string[]): readonly string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export const PROVENANCE_CONFIG: ProvenanceConfig = {
  alarmEnabled: envBool('MANDREL_PROVENANCE_ALARM_ENABLED', process.env.NODE_ENV === 'production'),
  declaredFloor: envInt('MANDREL_PROVENANCE_DECLARED_FLOOR', 10),
  windowDays: envInt('MANDREL_PROVENANCE_WINDOW_DAYS', 7),
  checkIntervalMinutes: envInt('MANDREL_PROVENANCE_CHECK_INTERVAL_MINUTES', 60),
  meterQueryTimeoutMs: envInt('MANDREL_PROVENANCE_METER_QUERY_TIMEOUT_MS', 30_000),
  checkWatchdogMinutes: envInt('MANDREL_PROVENANCE_CHECK_WATCHDOG_MINUTES', 15),
  alertDedupeMinutes: envInt('MANDREL_PROVENANCE_ALERT_DEDUPE_MINUTES', 1440),
  sourceActivePerWeek: envInt('MANDREL_PROVENANCE_SOURCE_ACTIVE_PER_WEEK', 20),
  sourceLookbackWeeks: envInt('MANDREL_PROVENANCE_SOURCE_LOOKBACK_WEEKS', 8),
  retiredSources: envStrList('MANDREL_PROVENANCE_RETIRED_SOURCES', []),
};
