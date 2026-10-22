/**
 * BELIEF COST LEDGER (Phase 4, BL-10 — the $/day cost monitor).
 *
 * The accounting half of the belief cost monitor. It:
 *   1. COMPUTES a per-call USD cost from token counts × a per-model rate (computeCostUsd) —
 *      pure, config-driven (beliefCostConfig.ts), unknown model → 0 + one-time warning.
 *   2. WRITES one APPEND-ONLY ledger row per REAL LLM call (belief_adjudication_costs,
 *      migration 060), FAIL-SAFE + non-blocking — a ledger error NEVER breaks or slows an
 *      adjudication verdict (recordProviderCallCostsSafe wraps every write in try/catch).
 *   3. ROLLS UP the ledger (rollupCosts) — $/day, calls/day, tokens/day, split by provider and
 *      by project — over a window, reading the append-only ledger (no dedup needed).
 *   4. Decides the runaway-spend ALARM (shouldAlert) — pure, threshold from config.
 *
 * The cost source is the ledger, NOT belief_adjudications (which UPSERTs a verdict snapshot per
 * pair — wrong for money; see migration 060). Providers surface per-call token usage via their
 * `lastUsage` array (types.ts), read serial-safely right after each adjudicate() by
 * recordProviderCallCostsSafe (the single-source seam the orchestrator calls).
 */

import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { BELIEF_COST_CONFIG } from '../../config/beliefCostConfig.js';
import type { BeliefCostConfig } from '../../config/beliefCostConfig.js';
import type { AdjudicationCallUsage, AdjudicationProvider } from './types.js';

/** The result of pricing one call: the USD cost and whether the model was in the rate table. */
export interface CostComputation {
  costUsd: number;
  /** false ⇒ the model had no rate entry → cost forced to 0 (a one-time warning is logged). */
  priced: boolean;
}

// Models we've already warned about (unknown-rate) — warn ONCE per model per process, not per
// call, so a long backfill of an unpriced local model doesn't flood the log.
const warnedUnknownModels = new Set<string>();

/**
 * Compute the USD cost of ONE adjudication call from its token usage × the per-model rate.
 * PURE (no I/O). An unknown model returns { costUsd: 0, priced: false } and logs a single
 * warning for that model — never a wrong number, never a throw. Rates are USD per 1,000,000
 * tokens (config/beliefCostConfig.ts).
 */
export function computeCostUsd(
  model: string,
  usage: Pick<
    AdjudicationCallUsage,
    'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'
  >,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG
): CostComputation {
  const rate = cfg.rates[model];
  if (!rate) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      logger.warn(
        `💸 belief cost: no rate for model "${model}" — pricing its calls at $0. ` +
          `Add it via MANDREL_BELIEF_COST_RATES_JSON to bill it (see config/beliefCostConfig.ts).`
      );
    }
    return { costUsd: 0, priced: false };
  }
  const per = 1_000_000;
  const costUsd =
    (usage.inputTokens / per) * rate.input +
    (usage.outputTokens / per) * rate.output +
    (usage.cacheReadTokens / per) * rate.cacheRead +
    (usage.cacheCreationTokens / per) * rate.cacheWrite;
  return { costUsd, priced: true };
}

/** Input for one ledger row (one real LLM call). */
export interface RecordCostInput {
  projectId: string | null;
  pairKey: string | null;
  usage: AdjudicationCallUsage;
}

/**
 * Insert ONE cost-ledger row for one real LLM call. Computes cost_usd from the usage. This MAY
 * throw (DB error) — callers on the adjudication path MUST use recordProviderCallCostsSafe,
 * which swallows errors so the belief verdict is never at risk. Returns the new row id.
 */
export async function recordAdjudicationCost(
  input: RecordCostInput,
  pool: Pool = db,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG
): Promise<{ id: string; costUsd: number }> {
  const { usage } = input;
  const { costUsd } = computeCostUsd(usage.model, usage, cfg);
  const r = await pool.query(
    `INSERT INTO belief_adjudication_costs (
        project_id, pair_key, tier, provider, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id::text AS id`,
    [
      input.projectId,
      input.pairKey,
      usage.tier,
      usage.provider,
      usage.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationTokens,
      usage.cacheReadTokens,
      costUsd,
    ]
  );
  return { id: r.rows[0].id, costUsd };
}

/**
 * FAIL-SAFE, non-blocking: read a provider's per-call usage (from the adjudicate() just awaited)
 * and append one ledger row PER REAL CALL. Any error (DB down, bad row) is caught + logged and
 * SWALLOWED — the belief verdict is the priority and must never break or slow because cost
 * telemetry hiccuped. Returns the number of ledger rows written (0 on any failure or no usage).
 *
 * SERIAL-SAFETY: `provider.lastUsage` reflects the most recent adjudicate() and is read
 * synchronously here, right after the awaited call — the same serial contract (concurrency=1)
 * that governs the tiered provider's name/model getters. The tiered provider reports 1 (tier-1
 * only) or 2 (tier-1 + tier-2) usage entries; a single provider reports 1.
 */
export async function recordProviderCallCostsSafe(
  provider: AdjudicationProvider,
  ctx: { projectId: string | null; pairKey: string | null },
  pool: Pool = db,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG
): Promise<number> {
  try {
    const usages = provider.lastUsage ?? [];
    let written = 0;
    for (const usage of usages) {
      try {
        await recordAdjudicationCost({ projectId: ctx.projectId, pairKey: ctx.pairKey, usage }, pool, cfg);
        written += 1;
      } catch (e) {
        logger.warn('💸 belief cost: ledger write failed for one call — skipping (verdict unaffected)', {
          metadata: { error: (e as Error)?.message, model: usage.model, tier: usage.tier },
        });
      }
    }
    return written;
  } catch (e) {
    // Belt-and-braces: even reading lastUsage must never bubble into the adjudication path.
    logger.warn('💸 belief cost: cost capture failed entirely — skipping (verdict unaffected)', {
      metadata: { error: (e as Error)?.message },
    });
    return 0;
  }
}

/** Pure ALARM decision: does the day's spend cross the configured runaway threshold? */
export function shouldAlert(
  todayUsd: number,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG
): boolean {
  return Number.isFinite(todayUsd) && todayUsd >= cfg.alertUsdPerDay;
}

// ── Rollup ──────────────────────────────────────────────────────────────────────────────────

export interface CostRow {
  day: string; // YYYY-MM-DD (UTC)
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface ProviderTotal {
  provider: string;
  calls: number;
  costUsd: number;
}

export interface ProjectTotal {
  projectId: string | null;
  projectName: string | null;
  calls: number;
  costUsd: number;
}

export interface DayTotal {
  day: string;
  calls: number;
  costUsd: number;
}

export interface CostRollup {
  windowDays: number;
  since: string; // ISO
  totalCostUsd: number;
  totalCalls: number;
  todayUsd: number;
  todayCalls: number;
  alertThresholdUsd: number;
  alert: boolean;
  /** The hard daily spend cap in USD (0 = no cap). Today's spend is `todayUsd`. */
  dailySpendCapUsd: number;
  /** true ⇒ a cap is set and today's spend has reached it (paid adjudication is paused). */
  capReached: boolean;
  byDay: DayTotal[];
  byProvider: ProviderTotal[];
  byProject: ProjectTotal[];
  /** Fine-grained per-day×provider×model breakdown (the raw rollup rows). */
  byDayProviderModel: CostRow[];
}

/**
 * Roll up the append-only ledger over the last `windowDays` (UTC day boundaries): $/day,
 * calls/day, tokens/day, split by provider (Groq vs Sonnet) and by project/tenant. Reads only
 * belief_adjudication_costs — one row per real call, so a plain SUM is correct (no dedup). Today
 * (UTC) is summed separately for the runaway alarm.
 */
export async function rollupCosts(
  pool: Pool = db,
  windowDays: number = BELIEF_COST_CONFIG.rollupWindowDays,
  cfg: BeliefCostConfig = BELIEF_COST_CONFIG
): Promise<CostRollup> {
  const days = Number.isInteger(windowDays) && windowDays > 0 ? windowDays : cfg.rollupWindowDays;
  // Window start = midnight UTC, (days-1) days ago, so `days` includes today.
  const sinceExpr = `date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1::int - 1)`;

  const byRowsR = await pool.query(
    `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            provider, model,
            count(*)::bigint                         AS calls,
            coalesce(sum(input_tokens),0)::bigint    AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint   AS output_tokens,
            coalesce(sum(cache_creation_tokens),0)::bigint AS cache_creation_tokens,
            coalesce(sum(cache_read_tokens),0)::bigint     AS cache_read_tokens,
            coalesce(sum(cost_usd),0)::numeric       AS cost_usd
       FROM belief_adjudication_costs
      WHERE created_at >= ${sinceExpr}
      GROUP BY day, provider, model
      ORDER BY day DESC, cost_usd DESC`,
    [days]
  );

  const byProjectR = await pool.query(
    `SELECT c.project_id::text AS project_id, p.name AS project_name,
            count(*)::bigint AS calls, coalesce(sum(c.cost_usd),0)::numeric AS cost_usd
       FROM belief_adjudication_costs c
       LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.created_at >= ${sinceExpr}
      GROUP BY c.project_id, p.name
      ORDER BY cost_usd DESC`,
    [days]
  );

  const byDayProviderModel: CostRow[] = byRowsR.rows.map((r) => ({
    day: r.day,
    provider: r.provider,
    model: r.model,
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheCreationTokens: Number(r.cache_creation_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    costUsd: Number(r.cost_usd),
  }));

  // Derive the coarser rollups from the fine-grained rows (single query, in-process fold).
  const dayMap = new Map<string, DayTotal>();
  const provMap = new Map<string, ProviderTotal>();
  let totalCostUsd = 0;
  let totalCalls = 0;
  for (const row of byDayProviderModel) {
    totalCostUsd += row.costUsd;
    totalCalls += row.calls;
    const d = dayMap.get(row.day) ?? { day: row.day, calls: 0, costUsd: 0 };
    d.calls += row.calls;
    d.costUsd += row.costUsd;
    dayMap.set(row.day, d);
    const pv = provMap.get(row.provider) ?? { provider: row.provider, calls: 0, costUsd: 0 };
    pv.calls += row.calls;
    pv.costUsd += row.costUsd;
    provMap.set(row.provider, pv);
  }

  const byProject: ProjectTotal[] = byProjectR.rows.map((r) => ({
    projectId: r.project_id ?? null,
    projectName: r.project_name ?? null,
    calls: Number(r.calls),
    costUsd: Number(r.cost_usd),
  }));

  const todayStr = new Date().toISOString().slice(0, 10);
  const today = dayMap.get(todayStr) ?? { day: todayStr, calls: 0, costUsd: 0 };

  const byDay = [...dayMap.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const byProvider = [...provMap.values()].sort((a, b) => b.costUsd - a.costUsd);

  const sinceIso = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

  return {
    windowDays: days,
    since: sinceIso,
    totalCostUsd,
    totalCalls,
    todayUsd: today.costUsd,
    todayCalls: today.calls,
    alertThresholdUsd: cfg.alertUsdPerDay,
    alert: shouldAlert(today.costUsd, cfg),
    dailySpendCapUsd: cfg.dailySpendCapUsd,
    capReached: cfg.dailySpendCapUsd > 0 && today.costUsd >= cfg.dailySpendCapUsd,
    byDay,
    byProvider,
    byProject,
    byDayProviderModel,
  };
}
