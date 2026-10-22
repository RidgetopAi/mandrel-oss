import { DAY_SUMMARY_CONFIG, momentumSubScore } from '../config/daySummary';
import type { DailyRow } from './dailySeries';

/**
 * momentum — the SINGLE source for the transparent, baseline-relative 0-100 Momentum
 * score. It was previously computed inline in `services/daySummary.ts`; it now lives here
 * so BOTH the Calendar day-summary CARD and the Calendar per-cell MOMENTUM-SERIES endpoint
 * blend the exact same math from the exact same config weights/anchors. That is the
 * no-drift guarantee behind the cell's score MUST equal the card's
 * score for the same day, because there is only one function that can compute either.
 *
 * THE FORMULA (an earlier decision — see `config/daySummary.ts` for the full write-up):
 * three sub-scores, each the target day measured against the user's own trailing N-day
 * rolling baseline average (ratio 1.0 == "on par" == `onParSubScore`), blended by the
 * configured weights. Pure + deterministic (no I/O) so it is fully unit-testable.
 */

export interface MomentumResult {
  score: number;
  delta: number;
  breakdown: { output: number; followThrough: number; depth: number };
}

/** Volume of work recorded that day. */
const outputOf = (r: DailyRow): number => r.contexts + r.decisions + r.tasks_done;
/** Did you FINISH what you started that day (completed vs opened). */
const followThroughOf = (r: { tasks_done: number; tasks_opened: number }): number =>
  r.tasks_opened > 0 ? r.tasks_done / r.tasks_opened : r.tasks_done > 0 ? 1 : 0;
/** Engagement depth that day. */
const depthOf = (r: DailyRow): number => r.sessions + r.active_minutes + r.milestones;

/**
 * Compute the Momentum for `target` relative to its `baseline` window (the `window` days
 * BEFORE the target day). The baseline average divides the summed prior-day values by the
 * fixed `window` size (a true rolling average — sparse history correctly pulls the
 * baseline down), matching the day-summary card exactly. `window` defaults to the config's
 * `baselineWindowDays`; callers pass the same value so the card and the cells agree.
 */
export function computeMomentum(
  target: DailyRow,
  baseline: DailyRow[],
  window: number = DAY_SUMMARY_CONFIG.baselineWindowDays,
): MomentumResult {
  // Rolling average over the fixed window (sum of prior days / window). Never divides by
  // zero (guarded); sparse history pulls the baseline down, as intended.
  const avg = (pick: (r: DailyRow) => number): number => {
    const sum = baseline.reduce((s, r) => s + pick(r), 0);
    return window > 0 ? sum / window : 0;
  };

  const subOutput = momentumSubScore(outputOf(target), avg(outputOf));
  const subFollow = momentumSubScore(
    followThroughOf(target),
    // baseline follow-through = average of the per-day ratios over the window
    window > 0 ? baseline.reduce((s, r) => s + followThroughOf(r), 0) / window : 0,
  );
  const subDepth = momentumSubScore(depthOf(target), avg(depthOf));

  const w = DAY_SUMMARY_CONFIG.momentum.weights;
  const wSum = w.output + w.followThrough + w.depth || 1;
  const score = Math.round(
    (w.output * subOutput + w.followThrough * subFollow + w.depth * subDepth) / wSum,
  );

  return {
    score,
    // A perfectly-average day scores `onParSubScore`, so the delta reads as points
    // above/below the user's own baseline day.
    delta: score - DAY_SUMMARY_CONFIG.momentum.onParSubScore,
    breakdown: { output: subOutput, followThrough: subFollow, depth: subDepth },
  };
}
