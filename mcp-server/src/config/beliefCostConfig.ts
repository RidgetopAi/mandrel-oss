/**
 * BELIEF ADJUDICATOR COST CONFIG (Phase 4, BL-10 — the $/day cost monitor).
 *
 * THE MONEY KNOBS in ONE place. The operator is turning belief detection ON (flag default-on, BL-9)
 * and needs LIVE visibility on the per-write LLM spend plus a runaway-spend alarm. The cost is
 * accounted from an APPEND-ONLY LEDGER (belief_adjudication_costs, migration 060) — one row per
 * REAL adjudication API call — and each row's cost_usd is computed from token counts × a
 * per-model USD RATE. Those rates + the alert threshold + the rollup window are TUNABLES, so —
 * per the standing "no hardcoded variables" rule (mirrors beliefConfig.ts / trustConfig.ts) —
 * they live HERE as named, documented, env-overridable values, never a literal in the cost
 * math. The service (services/belief/costLedger.ts) reads this config; this module is data only.
 *
 * RATE SOURCE + HONESTY: the defaults are the BEST-KNOWN PUBLIC list prices for the two shipped
 * adjudicator models as of 2026-07 (Sonnet 5 over the Anthropic Messages API for tier-2 /
 * single, gpt-oss-120b over Groq for tier-1). Public list prices drift and vary by tier/contract
 * — so EVERY rate is env-overridable (MANDREL_BELIEF_COST_RATES_JSON) and an UNKNOWN model costs
 * 0 with a logged warning rather than a wrong number or a crash. Treat the rollup's absolute $ as
 * an estimate to be corrected via env once real invoices land; the SHAPE (which tier/model/tenant
 * dominates, the day-over-day trend, the runaway alarm) is what it is built to surface.
 */

import { logger } from '../utils/logger.js';

/** Read a finite (may be zero) number env var, falling back on missing/garbage. */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Read a positive-integer env var (e.g. a window in days), else `fallback`. */
function envPosInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * USD price for ONE model, per 1,000,000 tokens, split by token class. Cost for a call =
 * inputTokens/1e6*input + outputTokens/1e6*output + cacheReadTokens/1e6*cacheRead +
 * cacheCreationTokens/1e6*cacheWrite. A host that does not bill a class (e.g. Groq has no
 * separate cache-write line) simply sets that rate to 0.
 */
export interface ModelRateUsdPerMTok {
  /** Uncached input (prompt) tokens, USD / 1M. */
  input: number;
  /** Output (completion) tokens, USD / 1M. */
  output: number;
  /** Prompt-cache READ (hit) tokens, USD / 1M. Anthropic ~= 0.1x input. */
  cacheRead: number;
  /** Prompt-cache WRITE (miss) tokens, USD / 1M. Anthropic ~= 1.25x input. */
  cacheWrite: number;
}

export interface BeliefCostConfig {
  /**
   * Per-model USD rate table, keyed by the EXACT model id stored on the ledger row (the value
   * providers expose as `.model` — e.g. 'claude-sonnet-5', 'openai/gpt-oss-120b'). A model NOT
   * present here is priced at 0 with a one-time-per-model warning (never a crash — see
   * costLedger.computeCostUsd). Override / extend via MANDREL_BELIEF_COST_RATES_JSON (a JSON
   * object model->{input,output,cacheRead,cacheWrite}) merged OVER these defaults.
   */
  rates: Record<string, ModelRateUsdPerMTok>;
  /**
   * Runaway-spend alarm threshold, USD for the current calendar day (UTC). When today's summed
   * cost_usd crosses this, the daily notifier fires a LOUD chat alert (else a silent digest).
   * Env: MANDREL_BELIEF_COST_ALERT_USD_PER_DAY. Default 5.00 — a deliberately LOW starter tripwire
   * while the operator builds a feel for the per-write spend; raise it via env once the baseline is known.
   */
  alertUsdPerDay: number;
  /**
   * Default rollup window (days) for the belief-cost report when no --days/arg is given. Env:
   * MANDREL_BELIEF_COST_ROLLUP_WINDOW_DAYS. Default 7.
   */
  rollupWindowDays: number;
  /**
   * HARD daily spend cap, USD per UTC day. Once today's summed ledger cost reaches this, NO paid
   * adjudication call is made (either tier); the pair is booked in the attempt ledger as
   * spend-cap-reached and the write that triggered it is unaffected. The next UTC day resumes
   * on its own. Env: MANDREL_BELIEF_DAILY_SPEND_CAP_USD. Default 2; 0 = no cap. Negative or
   * non-numeric values fall back to the default (a typo must not silently uncap the spend).
   */
  dailySpendCapUsd: number;
}

/** Default hard daily cap (USD). */
const DEFAULT_DAILY_SPEND_CAP_USD = 2;

/** Read a non-negative finite number env var, else `fallback`. */
function envNonNeg(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * DEFAULT RATES (public list prices — env-overridable, see module header).
 *   - claude-sonnet-5 (Anthropic Messages API): $2 / $10 per 1M in/out; prompt-cache read
 *     0.1x input ($0.20) and 5-minute cache write 1.25x input ($2.50) — BL-12 sends the
 *     ~2,500-token static prefix as a 5-minute ephemeral cached block. Read from
 *     platform.claude.com/docs/en/about-claude/pricing on 2026-10-12: the launch $2/$10 became
 *     the standard price and the scheduled 2026-09-01 rise to $3/$15 did not happen (the table
 *     had carried $3/$15 since 2026-07).
 *   - claude-sonnet-5-5: $2 / $10 per 1M in/out; cache read 0.05x input ($0.10); 5-minute cache
 *     write $2.50 (same pricing page, same date).
 *   - openai/gpt-oss-120b (Groq): $0.15 / $0.75 per 1M in/out. Groq does not bill a separate
 *     cache-WRITE line; cached input, when reported, is ~0.5x input ($0.075). cacheWrite 0.
 *   - subq-snap-preview (SubQ Decisions API, public preview): $0.05 per 1M input, output free
 *     (docs.subq.ai models page, read 2026-10-12; preview pricing — may change before GA).
 */
const DEFAULT_RATES: Record<string, ModelRateUsdPerMTok> = {
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 },
  'openai/gpt-oss-120b': { input: 0.15, output: 0.75, cacheRead: 0.075, cacheWrite: 0 },
  'subq-snap-preview': { input: 0.05, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * Parse MANDREL_BELIEF_COST_RATES_JSON and DEEP-MERGE it over the defaults. Each entry may set
 * any subset of the four rate fields (missing fields keep the default / 0). Malformed JSON or a
 * malformed entry is logged and IGNORED (fail-safe: a bad env never crashes cost accounting —
 * it falls back to the built-in defaults). Returns a fresh merged map.
 */
function loadRates(): Record<string, ModelRateUsdPerMTok> {
  const merged: Record<string, ModelRateUsdPerMTok> = {};
  for (const [k, v] of Object.entries(DEFAULT_RATES)) merged[k] = { ...v };

  const raw = process.env.MANDREL_BELIEF_COST_RATES_JSON;
  if (raw === undefined || raw.trim() === '') return merged;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(
      '💸 belief cost config: MANDREL_BELIEF_COST_RATES_JSON is not valid JSON — ignoring, using default rates.'
    );
    return merged;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(
      '💸 belief cost config: MANDREL_BELIEF_COST_RATES_JSON must be a JSON object of model->rate — ignoring.'
    );
    return merged;
  }
  for (const [model, r] of Object.entries(parsed as Record<string, unknown>)) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      logger.warn(`💸 belief cost config: rate override for "${model}" is not an object — skipping it.`);
      continue;
    }
    const o = r as Record<string, unknown>;
    const base: ModelRateUsdPerMTok = merged[model] ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const num = (x: unknown, fallback: number): number =>
      typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : fallback;
    merged[model] = {
      input: num(o.input, base.input),
      output: num(o.output, base.output),
      cacheRead: num(o.cacheRead, base.cacheRead),
      cacheWrite: num(o.cacheWrite, base.cacheWrite),
    };
  }
  return merged;
}

/** THE LIVE COST CONFIG — read once at module load; every value env-overridable. */
export const BELIEF_COST_CONFIG: BeliefCostConfig = {
  rates: loadRates(),
  alertUsdPerDay: envNum('MANDREL_BELIEF_COST_ALERT_USD_PER_DAY', 5.0),
  rollupWindowDays: envPosInt('MANDREL_BELIEF_COST_ROLLUP_WINDOW_DAYS', 7),
  dailySpendCapUsd: envNonNeg('MANDREL_BELIEF_DAILY_SPEND_CAP_USD', DEFAULT_DAILY_SPEND_CAP_USD),
};
