import { logger } from '../config/logger';
import { type ProjectListScope } from './projectListScope';
import { DAY_SUMMARY_CONFIG } from '../config/daySummary';
import { DailyRow, emptyDailyRow, queryDailySeries } from './dailySeries';
import { computeMomentum } from './momentum';

/**
 * MomentumSeriesService — the batch read behind the Calendar per-cell momentum heatmap
 * (`GET /api/momentum-series`). It returns one
 * row per day in `[from..to]`, each carrying the day's Momentum score + delta and its
 * headline counts, so the Day/Week/Month grids can paint a momentum ring on every cell
 * WITHOUT clicking into the day-summary card.
 *
 * NO DRIFT: the score is produced by the SAME `computeMomentum` helper the day-summary
 * CARD uses, over the SAME `queryDailySeries` machinery — so a cell's score is identical
 * to the card's score for that date, by construction.
 *
 * EFFICIENT: ONE daily-series query spans `[from − baselineWindowDays .. to]` (so the very
 * first in-range day still has its full trailing baseline window), then each in-range day's
 * momentum is computed in JS from that single result set — never N per-day round-trips.
 */

/** One per-day row of the momentum series (what a calendar cell renders from). */
export interface MomentumSeriesRow {
  date: string;
  momentum: { score: number; delta: number };
  sessions: number;
  contexts: number;
  /** Tasks COMPLETED that day (the day-summary "tasks done" metric). */
  tasks: number;
  /** False when the day had zero recorded activity → the cell renders blank (no ring). */
  hasData: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a strict `YYYY-MM-DD` key to a UTC-midnight epoch (calendar arithmetic only). */
function dayEpoch(key: string): number {
  const [y, m, d] = key.split('-').map((n) => parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
}

/** Shift a `YYYY-MM-DD` key by `n` whole days, returning a `YYYY-MM-DD` key. */
function addDaysKey(key: string, n: number): string {
  return new Date(dayEpoch(key) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Inclusive whole-day span between two `YYYY-MM-DD` keys (`to − from`). */
export function spanDaysBetween(from: string, to: string): number {
  return Math.round((dayEpoch(to) - dayEpoch(from)) / MS_PER_DAY);
}

/** Every `YYYY-MM-DD` key in `[from..to]` inclusive (assumes from ≤ to). */
function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = 0, span = spanDaysBetween(from, to); i <= span; i += 1) {
    out.push(addDaysKey(from, i));
  }
  return out;
}

/** Any recorded activity that day (drives `hasData`). */
function dayHasData(r: DailyRow): boolean {
  return (
    r.sessions +
      r.contexts +
      r.decisions +
      r.tasks_done +
      r.tasks_opened +
      r.active_minutes +
      r.files_touched +
      r.milestones >
    0
  );
}

export class MomentumSeriesService {
  /**
   * Per-day momentum for every day in `[from..to]` (both `YYYY-MM-DD`), bucketed in `tz`.
   * `projectId` undefined = all projects; a uuid scopes every metric to that project.
   * Assumes `from ≤ to` and the span is within the configured cap (validated by the caller).
   */
  static async getMomentumSeries(
    from: string,
    to: string,
    tz: string,
    scope: ProjectListScope,
  ): Promise<MomentumSeriesRow[]> {
    try {
      const window = DAY_SUMMARY_CONFIG.baselineWindowDays;
      const proj = scope;

      // ONE query spanning [from − window .. to]. `queryDailySeries(end, tz, span, proj)`
      // returns [end − span .. end]; with end = to and span = (to − from) + window, that is
      // exactly [from − window .. to] — every in-range day plus its trailing baseline.
      const span = spanDaysBetween(from, to) + window;
      const series = await queryDailySeries(to, tz, span, proj);
      const byDay = new Map<string, DailyRow>(series.map((r) => [r.day, r]));

      return enumerateDays(from, to).map((date) => {
        const target = byDay.get(date) ?? emptyDailyRow(date);
        // The trailing baseline window: the `window` days strictly before `date`. The series
        // is a contiguous, gap-filled daily run, so these rows are always present.
        const windowStart = addDaysKey(date, -window);
        const baseline = series.filter((r) => r.day >= windowStart && r.day < date);
        const m = computeMomentum(target, baseline, window);
        return {
          date,
          momentum: { score: m.score, delta: m.delta },
          sessions: target.sessions,
          contexts: target.contexts,
          tasks: target.tasks_done,
          hasData: dayHasData(target),
        };
      });
    } catch (error) {
      logger.error('Get momentum series error', { error, from, to, tz, scope: scope.mode });
      throw new Error('Failed to get momentum series');
    }
  }
}
