/**
 * RE-EMBED SELF-HEAL WORKER — the scheduled, single-flight side of
 * the unified embed-failure resilience mechanism. It heals rows whose ACTIVE embedding
 * column is NULL, whether that NULL came from a live embed failure (the degrade+persist
 * sites) OR from a tenant backfill that has not finished. A NULL on the active column IS the
 * needs-reembed marker — there is deliberately NO separate flag/column (task constraint) —
 * and so is a DEGENERATE zero-norm vector, which is the SAME state wearing a NOT NULL mask
 *. Both are decided by the engine, never re-spelled here.
 *
 * WHAT IT REUSES: the EXISTING, tested backfill engine (services/reembedBackfill.ts) with
 * `force:false`, so it selects exactly the engine's needs-reembed set — a NULL column OR a
 * DEGENERATE (zero-norm) vector, which is NOT NULL yet uncomparable and used to be invisible
 * to this worker forever — and is idempotent +
 * resumable + column-agnostic (the engine already keys off embeddingConfig.activeEmbeddingColumn() —
 * prod=embedding_gemma, fleet=embedding). This worker adds ONLY scheduling + single-flight.
 *
 * SINGLE-FLIGHT: runs never overlap. A boolean `isSweeping` guard is set before a
 * sweep and cleared in `finally` on EVERY exit path (success or throw) — a dead-locked flag
 * would silently stop all future self-heal. An interval tick (or a manual runOnce) that lands
 * while a sweep is in flight is SKIPPED, not queued.
 *
 * CONFIG-DRIVEN (configs-not-hardcoded): enabled / interval / batch size all come from
 * resilienceConfig.RESILIENCE_CONFIG — no magic numbers here.
 *
 * FAIL-SAFE: a sweep error is logged and swallowed; the timer keeps ticking so a transient
 * embedder outage self-heals on the next sweep once the embedder recovers.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { backfillAllTables, BACKFILL_TABLES, type BackfillStats } from './reembedBackfill.js';
import { RESILIENCE_CONFIG } from '../config/resilienceConfig.js';

export interface SweepResult {
  /** True when this call was skipped because a sweep was already in flight (single-flight). */
  skipped: boolean;
  /**
   * Per-table stats keyed by BACKFILL_TABLES spec key ('contexts' | 'decisions' | 'tasks' | …).
   * A MAP rather than named fields DELIBERATELY: named fields are a second list of tables, and
   * a table added to the registry but forgotten here would be healed while reporting nothing.
   */
  tables?: Record<string, BackfillStats>;
  /** @deprecated read `tables.contexts`. Kept so existing callers/tests do not break. */
  contexts?: BackfillStats;
  /** @deprecated read `tables.decisions`. */
  decisions?: BackfillStats;
}

export class ReembedWorker {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isSweeping = false;
  private static isRunning = false;

  /**
   * Start the scheduled self-heal worker. No-op (with a log) when disabled by config, so a
   * fully-dark deploy is one env flip. Runs one sweep immediately, then every interval.
   */
  static start(pool: Pool = db): void {
    if (!RESILIENCE_CONFIG.workerEnabled) {
      logger.info('💤 Re-embed self-heal worker DISABLED (MANDREL_REEMBED_WORKER_ENABLED=false) — not started.');
      return;
    }
    if (this.isRunning) {
      logger.warn('⚠️  Re-embed self-heal worker already running');
      return;
    }
    const intervalMs = RESILIENCE_CONFIG.workerIntervalMinutes * 60 * 1000;
    logger.info(
      `🩹 Starting re-embed self-heal worker — every ${RESILIENCE_CONFIG.workerIntervalMinutes} min, ` +
      `re-embedding rows whose active column is NULL or degenerate (progress-log cadence ${RESILIENCE_CONFIG.workerBatchSize}).`,
    );

    // Run once immediately so a NULL backlog starts healing at boot (not one interval later).
    this.runOnce(pool).catch((error) => logger.error('❌ Initial re-embed sweep failed', error as Error));

    this.intervalId = setInterval(() => {
      this.runOnce(pool).catch((error) => logger.error('❌ Periodic re-embed sweep failed', error as Error));
    }, intervalMs);
    // Do not keep the event loop alive solely for this timer (mirrors a background sweep).
    if (typeof this.intervalId.unref === 'function') this.intervalId.unref();

    this.isRunning = true;
    logger.info('✅ Re-embed self-heal worker started');
  }

  /** Stop the worker and clear its timer. Idempotent. */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('🛑 Re-embed self-heal worker stopped');
  }

  /**
   * Run ONE self-heal sweep: re-embed the NULL-or-degenerate-active-column rows of
   * EVERY table in the backfill registry (BACKFILL_TABLES — contexts, decisions, tasks). SINGLE-FLIGHT: if a sweep is already in flight this
   * returns `{ skipped: true }` immediately (never overlaps, never queues). The `isSweeping`
   * flag is cleared in `finally` on every path — success, skip-return, or throw.
   *
   * Exposed (not private) so it can be triggered/tested directly and so a future ops tool can
   * force an immediate heal. Uses the SAME engine + config as the scheduled path.
   */
  static async runOnce(pool: Pool = db): Promise<SweepResult> {
    if (this.isSweeping) {
      logger.info('⏭️  Re-embed sweep skipped — a sweep is already in flight (single-flight).');
      return { skipped: true };
    }
    this.isSweeping = true;
    try {
      const args = {
        apply: true,
        force: false, // force:false → the engine's needs-reembed set (NULL or degenerate)
        batchSize: RESILIENCE_CONFIG.workerBatchSize,
        allProjects: true,
        understandTarget: false,
      };
      // The engine selects its needs-reembed set oldest-first and re-embeds ALL such
      // rows this sweep (batchSize is its progress-log cadence, not a row cap — see config doc).
      // Single-flight guarantees this can't overlap a prior sweep; a still-failing row retries
      // next sweep. allProjects/null filter = heal the whole DB (correct for prod self-heal).
      //
      // ITERATES THE REGISTRY, it does not name tables. That is what makes
      // "registered => healed" true by construction: `tasks` is healed here because it is in
      // BACKFILL_TABLES, not because anyone remembered to add a third call. Guard:
      // reembedRegistryCoverage.contract.test.ts.
      const tables = await backfillAllTables(null, args, pool);
      const healed = Object.values(tables).reduce((n, s) => n + s.done, 0);
      const stillFailing = Object.values(tables).reduce((n, s) => n + s.failed, 0);
      if (healed > 0) {
        const per = BACKFILL_TABLES
          .map((spec) => `${spec.label} ${tables[spec.key].done}/${tables[spec.key].total}`)
          .join(', ');
        logger.info(
          `🩹 Re-embed sweep healed ${healed} row(s): ${per}` +
          (stillFailing > 0
            ? ` (still-failing: ${BACKFILL_TABLES.map((spec) => `${spec.label} ${tables[spec.key].failed}`).join(', ')})`
            : ''),
        );
      }
      return { skipped: false, tables, contexts: tables.contexts, decisions: tables.decisions };
    } finally {
      // ALWAYS clear the flag — a stuck flag would permanently wedge self-heal.
      this.isSweeping = false;
    }
  }

  /** Introspection for status/tests. */
  static getStatus(): { isRunning: boolean; isSweeping: boolean; enabled: boolean } {
    return {
      isRunning: this.isRunning,
      isSweeping: this.isSweeping,
      enabled: RESILIENCE_CONFIG.workerEnabled,
    };
  }
}
