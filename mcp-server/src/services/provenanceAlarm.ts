/**
 * DECLARED-RATE + DEAD-SOURCE ALARM (an earlier decision — PHASE 0). Two legs
 * in one pass:
 *   1. DECLARED FLOOR: fires when the count of DECLARED-class edges over the rolling window
 *      falls below the configured floor (a declared minting path — tags/links/positional —
 *      is starving).
 *   2. DEAD SOURCE (the coordinator ruling): fires per SOURCE (created_by stamp) that was
 *      historically active (>= sourceActivePerWeek in some lookback week) yet minted ZERO
 *      edges in the window. This is the leg that WOULD have caught 2026-07-28: the dying
 *      mechanism was guessed-class, invisible to leg 1 by construction. A legitimately
 *      retired source is suppressed via config retiredSources — an explicit recorded
 *      change, never a silenced alarm.
 *
 * WHY: the graph audit measured a declared minting mechanism dying while
 * the similarity guess kept minting — coverage read 97-98% for 15 days over a dead
 * mechanism. Nothing watched the fuel line. This worker is the watcher.
 *
 * SHAPE: mirrors ReembedWorker exactly (start/stop/runOnce, single-flight, config-gated,
 * fail-safe timer) and reuses embedResilience.alertSink — the ONE shared notify mechanism
 * (the operator's notify script). No parallel notification path.
 *
 * THE VERDICT IS STRUCTURED (acceptance 4): `declaredCount` is an SQL `count(*)::int`
 * (provenanceMeter.countDeclaredInWindow) and the verdict is the integer comparison in
 * evaluateDeclaredFloor(). Nothing here greps a log or parses prose.
 *
 * THREE STATES, NOT TWO (C1): a run is `skipped` (single-flight), `measured` (verdict
 * holds), or `could-not-measure` (the SQL read threw). Could-not-measure gets its OWN
 * branch and its OWN alert — an alarm whose meter query silently fails is a dead alarm
 * wearing a green light, which is the exact class this instrument exists to close. It is
 * never mapped onto "0 declared" (that would fire the wrong alert) nor onto silence.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { alertSink, notifyDeliveryCheck } from './embedResilience.js';
import {
  countDeclaredInWindow,
  measureSourceLiveness,
  type SourceLiveness,
} from './provenanceMeter.js';
import { PROVENANCE_CONFIG } from '../config/provenanceConfig.js';

/** The measured verdict: the structured inputs and the booleans they produce. */
export interface ProvenanceAlarmVerdict {
  /** DECLARED-class edges counted in the window (SQL count(*)::int — the structured value). */
  declaredCount: number;
  floor: number;
  windowDays: number;
  /** declaredCount < floor. */
  fired: boolean;
  /** DEAD-SOURCE LEG (the coordinator ruling): historically-active sources that minted ZERO edges in
   *  the window — each one an alert. Structured rows from measureSourceLiveness. */
  deadSources: SourceLiveness[];
  /** Dead sources suppressed because config names them retired (explicit, recorded). */
  retiredSuppressed: SourceLiveness[];
}

/** What happened to ONE alert this run: sent (dispatched to the sink successfully),
 *  undeliverable (the sink could not dispatch — the dedupe slot is NOT consumed, so the
 *  next run retries), or deduped (suppressed by a previously SENT alert's window). */
export interface ProvenanceAlertOutcome {
  kind: string;
  outcome: 'sent' | 'undeliverable' | 'deduped';
}

/** One run's outcome — the three states kept distinct (C1). A measured run additionally
 *  reports the delivery outcome of every alert it raised: could-not-DELIVER is its own
 *  visible state (Reviewer ruling 3), never folded into silence. */
export type ProvenanceAlarmRunResult =
  | { skipped: true }
  | {
      skipped: false;
      measured: true;
      verdict: ProvenanceAlarmVerdict;
      alertOutcomes: ProvenanceAlertOutcome[];
    }
  | { skipped: false; measured: false; error: string; alertOutcomes: ProvenanceAlertOutcome[] };

/**
 * THE CLASSIFIER (acceptance 4): verdict from a structured integer, nothing else. Fires
 * strictly below the floor, so floor=N means "N declared edges in the window is healthy".
 */
export function evaluateDeclaredFloor(declaredCount: number, floor: number): boolean {
  return declaredCount < floor;
}

/**
 * DEAD-SOURCE CLASSIFIER — pure, structured (the coordinator ruling on an earlier task). A
 * historically-active source is DEAD when its in-window count is exactly 0. A source in
 * `retiredSources` is suppressed but still REPORTED (retiredSuppressed), so a retirement
 * is visible in the verdict rather than silently absorbed.
 */
export function evaluateDeadSources(
  rows: SourceLiveness[],
  retiredSources: readonly string[]
): { dead: SourceLiveness[]; retiredSuppressed: SourceLiveness[] } {
  const dead: SourceLiveness[] = [];
  const retiredSuppressed: SourceLiveness[] = [];
  for (const r of rows) {
    if (r.inWindow !== 0) continue;
    if (retiredSources.includes(r.source)) retiredSuppressed.push(r);
    else dead.push(r);
  }
  return { dead, retiredSuppressed };
}

/** Per-kind timestamp (ms) of the last alert, for the dedupe window. Keys: 'fired',
 *  'unmeasurable', and one 'dead:<source>' per dead source (so two mechanisms dying a day
 *  apart each page once). Module-level so the rate-limit is process-wide, mirroring
 *  embedResilience.lastAlertMsByTable. */
const lastAlertMs = new Map<string, number>();

/** TEST HOOK: clear dedupe state so a test's first alert always sends. */
export function resetProvenanceAlarmDedupe(): void {
  lastAlertMs.clear();
}

/**
 * Send at most one alert per kind per dedupe window. THE SLOT IS CONSUMED ONLY BY A
 * SUCCESSFUL DISPATCH (Reviewer ruling 4): recording the timestamp before the send meant
 * an undelivered page ate the once-per-window slot and suppressed the next REAL page —
 * with an hourly check interval that failure mode is a silent day. A failed dispatch
 * leaves the slot free, so the next runOnce retries (bounded by checkIntervalMinutes),
 * and is logged + reported as 'undeliverable' in the run result.
 */
function sendDeduped(kind: string, title: string, body: string): ProvenanceAlertOutcome {
  const now = Date.now();
  const windowMs = PROVENANCE_CONFIG.alertDedupeMinutes * 60 * 1000;
  if (now - (lastAlertMs.get(kind) ?? 0) < windowMs) return { kind, outcome: 'deduped' };
  // ROUND-3: check the whole delivery chain BEFORE dispatching. Without this, an
  // unreadable creds file fails inside the detached child (stderr discarded), the sink
  // honestly reports "dispatched", and the outcome would read 'sent' — the measured
  // silent-death mode. An undeliverable chain is reported as such and retried next run.
  const check = notifyDeliveryCheck();
  if (!check.deliverable) {
    logger.error(
      `❌ Provenance alarm alert '${kind}' COULD NOT BE DELIVERED: ${check.reason} — ` +
      `dedupe slot left free; next check retries.`,
    );
    return { kind, outcome: 'undeliverable' };
  }
  const dispatched = alertSink.send(title, body);
  if (!dispatched) {
    logger.error(
      `❌ Provenance alarm alert '${kind}' COULD NOT BE DELIVERED (notify script unresolved ` +
      `or dispatch failed) — dedupe slot left free; next check retries.`,
    );
    return { kind, outcome: 'undeliverable' };
  }
  lastAlertMs.set(kind, now);
  return { kind, outcome: 'sent' };
}

export class ProvenanceAlarmWorker {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isChecking = false;
  /** When the latch-holding run began (ms epoch) — what the watchdog measures against. */
  private static checkingSince = 0;
  private static isRunning = false;

  /**
   * Start the scheduled alarm. No-op (with a log) when disabled by config — the default is
   * production-only, same gate and same measured reason as the embed alert (a dev worktree
   * must not page the operator's phone).
   */
  static start(pool: Pool = db): void {
    if (!PROVENANCE_CONFIG.alarmEnabled) {
      logger.info('💤 Edge-provenance declared-rate alarm DISABLED (MANDREL_PROVENANCE_ALARM_ENABLED) — not started.');
      return;
    }
    if (this.isRunning) {
      logger.warn('⚠️  Edge-provenance alarm already running');
      return;
    }

    // FAIL LOUD AT STARTUP (Reviewer rulings 3 + round-3): an enabled alarm whose
    // delivery CHAIN is broken is a dead alarm wearing a green light. Two measured
    // breaks, one class: the fleet image does not contain repo-root scripts/ (resolver
    // returns null without the compose bind-mount + MANDREL_EMBED_ALERT_NOTIFY_SCRIPT),
    // and a creds file unreadable by the service uid makes the script FATAL inside a
    // detached child whose stderr is discarded (uid-1001 vs root:600, measured on the
    // prod image). notifyDeliveryCheck() checks both links; announce a break at boot,
    // not at fire time. The worker still starts: every runOnce reports 'undeliverable'
    // outcomes and retries, so fixing the mount/env/perms heals without a restart.
    {
      const check = notifyDeliveryCheck();
      if (!check.deliverable) {
        logger.error(
          `❌ PROVENANCE ALARM ENABLED BUT CANNOT DELIVER: ${check.reason}. ` +
          'In a container this requires the compose bind-mounts + ' +
          'MANDREL_EMBED_ALERT_NOTIFY_SCRIPT / MANDREL_NOTIFY_CREDS_ENV, and a creds file ' +
          'readable by the service uid. ' +
          'Alerts will be raised as undeliverable until this is fixed.',
        );
      }
    }

    const intervalMs = PROVENANCE_CONFIG.checkIntervalMinutes * 60 * 1000;
    logger.info(
      `📉 Starting edge-provenance declared-rate alarm — every ${PROVENANCE_CONFIG.checkIntervalMinutes} min, ` +
      `firing when declared edges over ${PROVENANCE_CONFIG.windowDays}d fall below ${PROVENANCE_CONFIG.declaredFloor}.`,
    );

    // Evaluate once at boot (a mechanism that died while the process was down should page
    // now, not one interval later), then on the interval.
    this.runOnce(pool).catch((error) => logger.error('❌ Initial provenance alarm check failed', error as Error));
    this.intervalId = setInterval(() => {
      this.runOnce(pool).catch((error) => logger.error('❌ Periodic provenance alarm check failed', error as Error));
    }, intervalMs);
    if (typeof this.intervalId.unref === 'function') this.intervalId.unref();

    this.isRunning = true;
    logger.info('✅ Edge-provenance declared-rate alarm started');
  }

  /** Stop the alarm and clear its timer. Idempotent. */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('🛑 Edge-provenance declared-rate alarm stopped');
  }

  /**
   * ONE evaluation — THE production invocation path (the interval calls exactly this, and
   * so do the contract tests: acceptance 3's control leg runs this method, not a harness).
   *
   * `overrides` narrows floor/window for a single call (tests; ad-hoc probes). They default
   * to the named config — production passes nothing.
   */
  static async runOnce(
    pool: Pool = db,
    overrides: {
      declaredFloor?: number;
      windowDays?: number;
      sourceActivePerWeek?: number;
      sourceLookbackWeeks?: number;
      retiredSources?: readonly string[];
      /** Watchdog bound override (fractional minutes allowed — the same test seam
       *  windowDays documents). Production passes nothing (named config governs). */
      checkWatchdogMinutes?: number;
    } = {}
  ): Promise<ProvenanceAlarmRunResult> {
    // Alerts raised BEFORE the measurement (currently only 'wedged') — carried into
    // whichever branch returns, so a watchdog trip is visible in the run result.
    const preOutcomes: ProvenanceAlertOutcome[] = [];
    if (this.isChecking) {
      // WATCHDOG: the single-flight latch had no bound, so ONE hung
      // check (e.g. a meter query blocked forever — no timeout existed anywhere in the
      // chain) made every later run return {skipped:true} with no log and no alert:
      // silent blindness, the exact class this alarm exists to close. Within the bound,
      // single-flight skip as designed; past it, SURFACE (log + alert through the same
      // dedupe/delivery path — never a silent reset), clear the latch, and take over.
      const watchdogMinutes = overrides.checkWatchdogMinutes ?? PROVENANCE_CONFIG.checkWatchdogMinutes;
      const heldMs = Date.now() - this.checkingSince;
      if (heldMs <= watchdogMinutes * 60 * 1000) return { skipped: true };
      const heldMin = (heldMs / 60000).toFixed(1);
      logger.error(
        `❌ Provenance alarm WEDGED: a check has held the single-flight latch for ${heldMin} min ` +
        `(watchdog bound ${watchdogMinutes} min) — clearing the latch and taking over this run.`,
      );
      preOutcomes.push(sendDeduped(
        'wedged',
        'Mandrel edge-provenance alarm WEDGED — latch cleared by watchdog',
        `A provenance alarm check held its single-flight latch for ${heldMin} min ` +
        `(bound: ${watchdogMinutes} min) — a meter query likely hung. The watchdog cleared ` +
        `the latch and this run took over, but the hung check is a real defect: check DB ` +
        `health and the mandrel logs.\n` +
        `(Further wedged alerts suppressed for ${PROVENANCE_CONFIG.alertDedupeMinutes} min.)`,
      ));
      // Fall through: the takeover below re-arms the latch. If the wedged run's await
      // truly never settles, its finally never runs and nothing races this. If it
      // settles LATE (after the takeover), its finally clears the latch the takeover
      // now owns, permitting one overlapping check on the next tick — bounded harm:
      // both runs are read-only and alerts dedupe. A generation counter closes that
      // window if it ever matters (Reviewer r1, ruled not worth the lines).
    }
    this.isChecking = true;
    this.checkingSince = Date.now();
    try {
      const floor = overrides.declaredFloor ?? PROVENANCE_CONFIG.declaredFloor;
      const windowDays = overrides.windowDays ?? PROVENANCE_CONFIG.windowDays;
      const activePerWeek = overrides.sourceActivePerWeek ?? PROVENANCE_CONFIG.sourceActivePerWeek;
      const lookbackWeeks = overrides.sourceLookbackWeeks ?? PROVENANCE_CONFIG.sourceLookbackWeeks;
      const retiredSources = overrides.retiredSources ?? PROVENANCE_CONFIG.retiredSources;

      let declaredCount: number;
      let liveness: SourceLiveness[];
      try {
        declaredCount = await countDeclaredInWindow(windowDays, pool);
        liveness = await measureSourceLiveness(
          { windowDays, lookbackWeeks, activePerWeek },
          pool
        );
      } catch (error) {
        // COULD NOT MEASURE — its own branch, its own alert. Never "0 declared", never
        // silence: a meter that cannot read is exactly as blind as the 15-day incident.
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Provenance alarm COULD NOT MEASURE: ${message}`);
        const outcome = sendDeduped(
          'unmeasurable',
          'Mandrel edge-provenance alarm — COULD NOT MEASURE',
          `The declared-edge meter query failed, so the declared-rate alarm is BLIND.\n` +
          `Reason: ${message}\n` +
          `(Further could-not-measure alerts suppressed for ${PROVENANCE_CONFIG.alertDedupeMinutes} min.)`,
        );
        return { skipped: false, measured: false, error: message, alertOutcomes: [...preOutcomes, outcome] };
      }

      const fired = evaluateDeclaredFloor(declaredCount, floor);
      const { dead, retiredSuppressed } = evaluateDeadSources(liveness, retiredSources);
      const verdict: ProvenanceAlarmVerdict = {
        declaredCount,
        floor,
        windowDays,
        fired,
        deadSources: dead,
        retiredSuppressed,
      };

      const alertOutcomes: ProvenanceAlertOutcome[] = [...preOutcomes];
      if (fired) {
        logger.warn(
          `📉 DECLARED-RATE ALARM: ${declaredCount} declared edge(s) in the last ${windowDays}d ` +
          `(floor ${floor}). A declared minting mechanism may be dead.`,
        );
        alertOutcomes.push(sendDeduped(
          'fired',
          'Mandrel declared-edge rate BELOW FLOOR',
          `Only ${declaredCount} DECLARED edge(s) minted in the last ${windowDays} day(s) ` +
          `(floor: ${floor}).\n` +
          `A declared minting path (tags / links arg / positional) may have died — the ` +
          `2026-07-28 auto:active_thread death was invisible for 15 days without this alarm.\n` +
          `Meter: GET /api/v2/graph/provenance\n` +
          `(Further below-floor alerts suppressed for ${PROVENANCE_CONFIG.alertDedupeMinutes} min.)`,
        ));
      } else {
        logger.debug?.(
          `📈 Provenance alarm healthy: ${declaredCount} declared edge(s) in ${windowDays}d (floor ${floor}).`,
        );
      }

      // ── DEAD-SOURCE LEG: one alert per dead mechanism, deduped per source. ──
      for (const d of dead) {
        logger.warn(
          `💀 MINT SOURCE DEAD: '${d.source}' — historically up to ${d.peakWeekly}/wk in the ` +
          `last ${lookbackWeeks} week(s), 0 edge(s) in the last ${windowDays}d window.`,
        );
        alertOutcomes.push(sendDeduped(
          `dead:${d.source}`,
          `Mandrel mint source DEAD: ${d.source}`,
          `Edge mint source '${d.source}' minted ZERO edges in the last ${windowDays} day(s), ` +
          `but was historically active (peak ${d.peakWeekly}/wk within the last ${lookbackWeeks} weeks).\n` +
          `This is the exact shape of the 2026-07-28 auto:active_thread death (15 days invisible).\n` +
          `If this retirement is INTENDED, record it: add the source to ` +
          `MANDREL_PROVENANCE_RETIRED_SOURCES (explicit config, not a silenced alarm).\n` +
          `Meter: GET /api/v2/graph/provenance\n` +
          `(Further alerts for this source suppressed for ${PROVENANCE_CONFIG.alertDedupeMinutes} min.)`,
        ));
      }
      if (retiredSuppressed.length > 0) {
        logger.info(
          `💤 Dead-but-RETIRED source(s) suppressed by config: ` +
          retiredSuppressed.map((r) => r.source).join(', '),
        );
      }

      return { skipped: false, measured: true, verdict, alertOutcomes };
    } finally {
      this.isChecking = false;
    }
  }
}
