/**
 * daySummary (Command backend) — the single, named home for every tunable used by the
 * Calendar DAY-SUMMARY report endpoint (`GET /api/day-summary`). The operator's standing rule:
 * configs-not-hardcoded — the momentum weights + score anchors + window sizes live HERE
 * as named, env-overridable knobs, never as inline magic numbers in the SQL/service.
 *
 * WHY A TRANSPARENT MOMENTUM SCORE
 *   The day-summary card shows a 0-100 MOMENTUM ring that must be honest and explainable,
 *   NOT a black box: it is a weighted blend of three sub-scores, each of which measures the
 *   day AGAINST THE USER'S OWN ROLLING BASELINE (their trailing N-day average), so the
 *   number answers "how did today compare to my normal?" — non-judgmental (an average day
 *   scores exactly `onParSubScore`, i.e. 50). The three axes:
 *     • output        — volume of work recorded: contexts + decisions + tasks completed.
 *     • followThrough — did you FINISH what you started: completed vs opened that day.
 *     • depth         — engagement: sessions + active minutes + milestones.
 *   Each axis is normalized as `raw / baselineAvg` and mapped so ratio 1.0 → `onParSubScore`
 *   (ratio 2.0 → 100, ratio 0 → 0). The final score is the weight-normalized blend, and the
 *   momentum DELTA is `score - onParSubScore` (a perfectly average day scores `onParSubScore`
 *   by construction, so the delta is literally "points above/below your baseline day").
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function floatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const DAY_SUMMARY_CONFIG = {
  /**
   * The rolling baseline window, in DAYS, that every metric's delta + the momentum score
   * compare the target day against ("the user's own rolling N-day average"). The daily
   * series query spans `baselineWindowDays` days BEFORE the target day plus the target day
   * itself; the baseline average divides the summed prior-day values by this window size
   * (a true rolling average — sparse-history days pull the baseline down, as intended).
   */
  baselineWindowDays: intFromEnv('DAY_SUMMARY_BASELINE_DAYS', 7),

  /**
   * Max length of the auto-composed headline (first line of the day's top milestone/
   * completion context, collapsed to one line + ellipsized). Keeps the shareable PNG clean.
   */
  headlineMaxLength: intFromEnv('DAY_SUMMARY_HEADLINE_MAXLEN', 140),

  momentum: {
    /**
     * The blend weights for the three transparent sub-scores. Proportional — the service
     * normalizes by their sum, so an override that doesn't sum to 1.0 still yields a 0-100
     * score (the weights stay meaningful as ratios). Defaults: output-led, then an even
     * split of follow-through + depth.
     */
    weights: {
      output: floatFromEnv('DAY_SUMMARY_W_OUTPUT', 0.4),
      followThrough: floatFromEnv('DAY_SUMMARY_W_FOLLOWTHROUGH', 0.3),
      depth: floatFromEnv('DAY_SUMMARY_W_DEPTH', 0.3),
    },
    /**
     * The sub-score a day earns when a metric exactly equals its baseline average (ratio
     * 1.0). This is the "on par with your normal" anchor: ratio 2.0 → 2×anchor (clamped to
     * maxScore), ratio 0 → 0. Also the score of a perfectly-average day, so the momentum
     * DELTA (`score - onParSubScore`) reads as points above/below your own baseline.
     */
    onParSubScore: intFromEnv('DAY_SUMMARY_ON_PAR_SUBSCORE', 50),
    /**
     * The sub-score used when there is NO baseline history for a metric (baselineAvg == 0):
     * with nothing to compare against we report NEUTRAL rather than inventing an "above
     * baseline" claim (honest / non-judgmental). Only bites brand-new installs + seeded tests.
     */
    noBaselineSubScore: intFromEnv('DAY_SUMMARY_NO_BASELINE_SUBSCORE', 50),
    /** Ceiling for any sub-score and the blended score (a 0-100 ring). */
    maxScore: intFromEnv('DAY_SUMMARY_MAX_SCORE', 100),
  },

  /**
   * Tunables for the Calendar per-cell MOMENTUM-SERIES endpoint (`GET /api/momentum-series`,
   * an earlier task) — the batch read that paints each day cell's momentum ring/number.
   */
  momentumSeries: {
    /**
     * Hard cap on the requested `[from..to]` span, in days (inclusive count of days − 1),
     * as an abuse guard — a request exceeding it is a 400, never a runaway query. The Month
     * view asks for the widest span (a 42-cell grid → 41 days apart), so this must comfortably
     * exceed 41; the default 45 does. Env-overridable (configs-not-hardcoded).
     */
    maxSpanDays: intFromEnv('MOMENTUM_SERIES_MAX_SPAN_DAYS', 45),
  },
} as const;

/**
 * Map a raw metric value + its baseline average to a 0-`maxScore` sub-score. Ratio 1.0
 * (== baseline) → `onParSubScore`; scales linearly and clamps to [0, maxScore]. No baseline
 * (avg 0) → `noBaselineSubScore` when there is activity, else 0. Pure + deterministic so the
 * momentum math is fully testable (tests-are-the-rock).
 */
export function momentumSubScore(raw: number, baselineAvg: number): number {
  const m = DAY_SUMMARY_CONFIG.momentum;
  if (baselineAvg > 0) {
    const scaled = Math.round(m.onParSubScore * (raw / baselineAvg));
    return Math.max(0, Math.min(m.maxScore, scaled));
  }
  return raw > 0 ? m.noBaselineSubScore : 0;
}
