/**
 * BELIEF DAILY SPEND CAP — the HARD ceiling on paid
 * adjudication spend. costLedger.shouldAlert only ALERTS; this STOPS.
 *
 * Before every adjudication that could make a paid call (any provider whose model has a nonzero
 * rate; for the tiered provider, either tier), today's recorded cost (UTC day) is summed from the
 * append-only cost ledger. At or over cfg.dailySpendCapUsd ⇒ BeliefSpendCapError is thrown BEFORE
 * the provider is touched. adjudicatePair books it in the attempt ledger (errorClass
 * BELIEF_SPEND_CAP_ERROR_CLASS) and rethrows; adjudicateNeighbourhood already degrades a thrown
 * pair to a skipped pair, and the hook is post-store + fail-safe, so the triggering context /
 * decision write succeeds exactly as with supersession off. Resumes by itself at the next UTC day
 * because "today" is recomputed from the ledger on every check.
 *
 * FAIL-OPEN-ON-READ-ERROR is deliberately NOT chosen: if the ledger cannot be read the spend is
 * unknown, so the call is refused (fail closed on money). Cap 0 never reads the ledger at all.
 */

import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { BELIEF_COST_CONFIG } from '../../config/beliefCostConfig.js';
import type { BeliefCostConfig } from '../../config/beliefCostConfig.js';
import type { AdjudicationProvider } from './types.js';

/** The attempt-ledger error_class for a pair skipped because the daily cap was reached. */
export const BELIEF_SPEND_CAP_ERROR_CLASS = 'BeliefSpendCapReached';

export class BeliefSpendCapError extends Error {
  readonly todayUsd: number;
  readonly capUsd: number;
  constructor(todayUsd: number, capUsd: number) {
    super(
      `spend cap reached: $${todayUsd.toFixed(4)} spent today (UTC) of a $${capUsd.toFixed(2)} ` +
        `daily cap (MANDREL_BELIEF_DAILY_SPEND_CAP_USD) — paid adjudication paused until the next UTC day`
    );
    this.name = BELIEF_SPEND_CAP_ERROR_CLASS;
    this.todayUsd = todayUsd;
    this.capUsd = capUsd;
  }
}

/** Today's (UTC) summed cost_usd from the cost ledger. */
export async function readTodaySpendUsd(pool: Pool = db): Promise<number> {
  const r = await pool.query(
    `SELECT coalesce(sum(cost_usd),0)::numeric AS today_usd
       FROM belief_adjudication_costs
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
  );
  const v = Number(r.rows[0]?.today_usd ?? 0);
  if (!Number.isFinite(v)) throw new Error('cost ledger returned a non-numeric daily total');
  return v;
}

/** The model ids this provider may call: both tiers for a tiered provider, else its one model. */
function modelsOf(provider: AdjudicationProvider): string[] {
  const tiers = (provider as { tiers?: { tier1: { model: string }; tier2: { model: string } } }).tiers;
  return tiers ? [tiers.tier1.model, tiers.tier2.model] : [provider.model];
}

/** true ⇒ at least one model this provider may call has a nonzero price in the rate table. */
export function isPaidProvider(
  provider: AdjudicationProvider,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG
): boolean {
  return modelsOf(provider).some((m) => {
    const r = cfg.rates[m];
    return !!r && (r.input > 0 || r.output > 0 || r.cacheRead > 0 || r.cacheWrite > 0);
  });
}

let lastWarnedDay: string | null = null;
/** Test seam: forget the once-per-day warning state. */
export function __resetSpendCapWarningForTest(): void {
  lastWarnedDay = null;
}

/**
 * Throws BeliefSpendCapError when the provider is paid, a cap is set (> 0) and today's spend has
 * reached it. Logs ONE warning per UTC day naming the cap and today's total.
 */
export async function assertWithinSpendCap(
  provider: AdjudicationProvider,
  pool: Pool = db,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG,
  now: Date = new Date()
): Promise<void> {
  const cap = cfg.dailySpendCapUsd;
  if (!(cap > 0) || !isPaidProvider(provider, cfg)) return;
  const today = await readTodaySpendUsd(pool);
  if (today < cap) return;
  const day = now.toISOString().slice(0, 10);
  if (lastWarnedDay !== day) {
    lastWarnedDay = day;
    logger.warn(
      `💸 belief spend cap: $${today.toFixed(4)} spent today (UTC ${day}) ≥ $${cap.toFixed(2)} daily cap ` +
        `(MANDREL_BELIEF_DAILY_SPEND_CAP_USD) — skipping paid supersession calls until the next UTC day. Writes are unaffected.`
    );
  }
  throw new BeliefSpendCapError(today, cap);
}
