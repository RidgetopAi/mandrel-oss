/**
 * WorkMix — the mock's "Work mix — tasks" stacked single-bar (mixbar) + 2-col legend
 * (Done / In progress / Blocked / To do), plus the FLOW block beneath it. LIVE from
 * `/api/tasks/stats` (`by_status`) and `/api/tasks/lead-time`, real counts only; a status
 * with no count shows a 0 rather than a fabricated slice. Owns its loading (skeleton) /
 * empty / error state.
 *
 * ── IT IS TASKS CREATED IN THE WINDOW (item 4) ─────────────────────────
 * This panel took no window at all: it read every task ever filed while sitting under the
 * page's 7d/30d/90d control, which did not even re-fetch it. It therefore printed an
 * unmoving 89% Done. The window is real now, and the subtitle NAMES THE VERB, because
 * "work mix over 30 days" has two defensible readings and they give different answers:
 *   • CREATED  — the cohort taken on in the window, wherever it has got to since. Chosen.
 *   • TOUCHED  — whatever moved in the window. Rejected: membership shifts when someone
 *     edits a description, and one task can sit in the 7d and 30d views in two states.
 * CREATED is also the verb the "Tasks created" KPI on this same page counts in, so the
 * two panels are answering about one population. See backend services/task.ts.
 *
 * `cancelled` is deliberately absent from `WORK_MIX` and therefore from `total` — see
 * config.ts. That is not an oversight and must not be "fixed".
 *
 * ── THE FLOW BLOCK IS A SECOND POPULATION, AND IT SAYS SO ─────────────
 * The operator asked for per-day task rates in this panel's empty lower half. The hazard is that
 * a rate looks like it belongs to the bar and does not: the bar's "Done" is a slice of the
 * tasks CREATED in the window, while a completed-per-day rate counts everything that
 * FINISHED in the window whenever it was filed. On prod those are 262 and 288, and 25 of
 * the 288 were filed before the window opened. So the flow figures sit below a rule, under
 * their own heading, with their own endpoint named, and the difference is written out in
 * `TASK_RATES.footnote` rather than left for the reader to fail to notice.
 *
 * The CREATED figure is not fetched separately — it IS `total`, the bar's own sum. That is
 * what makes "created" mean exactly the same thing in both halves of the panel; see
 * `TASK_RATES` in config.ts for why cancelled is excluded and what was measured to settle
 * it. There is deliberately no composite "productivity" score here: empty space is not a
 * reason to synthesize a number nothing can falsify.
 */
import React from 'react';
import { Skeleton, Empty, Alert } from '../../components/ui';
import { Panel, Provenance, formatInt } from './parts';
import { TaskIcon } from './icons';
import { WORK_MIX, OPEN_STATUSES, TASK_RATES } from './config';
import type { TaskStats, TaskLeadTime } from '../../types/task';
import styles from './Analytics.module.css';
import { apiErrorMessage } from '../../api/request';

export interface WorkMixProps {
  stats: TaskStats | undefined;
  /** The active window, in days — stated in the subtitle so the mix is readable. */
  days: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /**
   * `/api/tasks/lead-time` for the window: carries BOTH the completed-in-window count
   * (`stats.totalTasks`) and the median days-to-done, from one set of rows.
   */
  leadTime: TaskLeadTime | undefined;
  leadTimeLoading: boolean;
  leadTimeError: boolean;
  /**
   * The UNWINDOWED `/api/tasks/stats`, for "Open now". Deliberately not the windowed
   * payload above — see `useOpenTaskCounts` in hooks.ts.
   */
  openStats: TaskStats | undefined;
}

/** The per-day flow figures. `null` on a quantity that has no honest value yet. */
export interface TaskRates {
  windowDays: number;
  /** Tasks created in the window, excluding cancelled — the mix bar's own total. */
  created: number;
  /** Tasks whose `completed_at` falls in the window, whenever they were created. */
  completed: number;
  createdPerDay: number;
  completedPerDay: number;
  /** created/day − completed/day. Positive = the backlog is growing. */
  netPerDay: number;
  /** `null` when nothing completed in the window — there is no median of nothing. */
  medianDaysToDone: number | null;
  /** `null` while the unwindowed read has not answered. Never window-scoped. */
  openNow: number | null;
}

/**
 * The flow arithmetic, pure and exported so it is provable without a DOM.
 *
 * Two guards carry the weight here, and both are about populations that produce a
 * PLAUSIBLE wrong number rather than an obvious one:
 *
 *  • `windowDays <= 0` returns null instead of dividing. The range control only offers
 *    7/30/90 today, so this is unreachable through the UI — which is exactly why it is
 *    asserted rather than assumed: an Infinity printed as a rate is indistinguishable
 *    from a real spike.
 *  • ZERO COMPLETIONS ⇒ NO MEDIAN. The backend returns `medianLeadTime: 0` alongside
 *    `totalTasks: 0` for an empty window (services/task.ts returns a zeroed stats block
 *    rather than nulls). Rendering that verbatim prints "0.0 days" — the value a
 *    perfectly fast team would show — for a window in which nothing was finished at all.
 *    The count is what decides, not the number.
 */
export function computeTaskRates(input: {
  createdInWindow: number;
  completedInWindow: number;
  medianLeadTimeDays: number;
  openNow: number | null;
  windowDays: number;
}): TaskRates | null {
  const { createdInWindow, completedInWindow, medianLeadTimeDays, openNow, windowDays } = input;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;
  const createdPerDay = createdInWindow / windowDays;
  const completedPerDay = completedInWindow / windowDays;
  return {
    windowDays,
    created: createdInWindow,
    completed: completedInWindow,
    createdPerDay,
    completedPerDay,
    netPerDay: createdPerDay - completedPerDay,
    medianDaysToDone: completedInWindow > 0 ? medianLeadTimeDays : null,
    openNow,
  };
}

/** Sum the OPEN statuses out of a by-status payload. `undefined` payload ⇒ null, not 0. */
export function openCount(stats: TaskStats | undefined): number | null {
  if (!stats?.by_status) return null;
  const by = stats.by_status;
  return OPEN_STATUSES.reduce((a, s) => a + Number(by[s] ?? 0), 0);
}

/** `12.5`. Fixed decimals so a rate never renders as `12.533333333333333`. */
export function formatRate(n: number): string {
  return Number.isFinite(n) ? n.toFixed(TASK_RATES.decimals) : '—';
}

/**
 * `+2.9` / `-1.2` / `0.0`. The SIGN is the whole content of the net figure — "2.9" alone
 * does not say whether the backlog is growing or shrinking — so it is always printed,
 * including the `+`, which `toFixed` does not give you.
 */
export function formatSignedRate(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const body = formatRate(Math.abs(n));
  // -0.04 rounds to "0.0"; printing "-0.0" reads as a shrinking backlog that isn't.
  if (Number(body) === 0) return `0.${'0'.repeat(TASK_RATES.decimals)}`;
  return `${n > 0 ? '+' : '−'}${body}`;
}

const Stat: React.FC<{ label: string; value: string; note: string }> = ({
  label,
  value,
  note,
}) => (
  <div className={styles.rateStat}>
    <span className={styles.rateLabel}>{label}</span>
    <span className={styles.rateValue}>{value}</span>
    <span className={styles.rateNote}>{note}</span>
  </div>
);

export const WorkMix: React.FC<WorkMixProps> = ({
  stats,
  days,
  isLoading,
  isError,
  error,
  leadTime,
  leadTimeLoading,
  leadTimeError,
  openStats,
}) => {
  const byStatus = stats?.by_status ?? {};
  const segments = WORK_MIX.map((s) => ({ ...s, count: Number(byStatus[s.status] ?? 0) }));
  const total = segments.reduce((a, s) => a + s.count, 0);

  const rates = computeTaskRates({
    createdInWindow: total,
    completedInWindow: Number(leadTime?.stats?.totalTasks ?? 0),
    medianLeadTimeDays: Number(leadTime?.stats?.medianLeadTime ?? 0),
    openNow: openCount(openStats),
    windowDays: days,
  });

  return (
    <Panel
      icon={<TaskIcon size={15} />}
      title="Work mix — tasks"
      subtitle={`Tasks created in the last ${days} days, by current status`}
      provenance={<Provenance>/api/tasks/stats?range={days}d</Provenance>}
    >
      {isLoading ? (
        <Skeleton width="100%" height={64} />
      ) : isError ? (
        <Alert variant="error" title="Couldn't load task stats">
          {apiErrorMessage(error, 'Failed to load task statistics.')}
        </Alert>
      ) : total === 0 ? (
        <Empty title="No tasks" description="No tasks were created in this window." />
      ) : (
        <>
          <div className={styles.mixbar} role="img" aria-label="Task status distribution">
            {segments
              .filter((s) => s.count > 0)
              .map((s) => (
                <span
                  key={s.status}
                  className={styles.mixbarSeg}
                  style={{ width: `${(s.count / total) * 100}%`, background: `var(${s.tintVar})` }}
                  title={`${s.label}: ${s.count}`}
                />
              ))}
          </div>
          <div className={styles.mixleg}>
            {segments.map((s) => (
              <span key={s.status} className={styles.mixlegItem}>
                <span className={styles.mixlegDot} style={{ background: `var(${s.tintVar})` }} aria-hidden="true" />
                {s.label}
                <span className={styles.mixlegVal}>{formatInt(s.count)}</span>
              </span>
            ))}
          </div>

          {/*
            The flow block. Separated by a rule and given its own heading + provenance
            because it answers about a DIFFERENT population than the bar above — see the
            file header and TASK_RATES. It is a sibling section of the panel, never a
            fifth legend row.
          */}
          <section className={styles.rates} aria-label="Task flow rates">
            <div className={styles.ratesHead}>
              <span className={styles.ratesTitle}>{TASK_RATES.heading(days)}</span>
              <Provenance>/api/tasks/lead-time?range={days}d</Provenance>
            </div>

            {leadTimeError ? (
              <div className={styles.inlineError} role="alert">
                Couldn&apos;t load task flow rates.
              </div>
            ) : leadTimeLoading || !rates ? (
              <Skeleton width="100%" height={72} />
            ) : (
              <>
                <div className={styles.ratesGrid}>
                  <Stat
                    label={TASK_RATES.createdLabel}
                    value={formatRate(rates.createdPerDay)}
                    note={`${formatInt(rates.created)} filed in ${days}d, excl. cancelled — the bar above`}
                  />
                  <Stat
                    label={TASK_RATES.completedLabel}
                    value={formatRate(rates.completedPerDay)}
                    note={`${formatInt(rates.completed)} finished in ${days}d, whenever filed`}
                  />
                  <Stat
                    label={TASK_RATES.netLabel}
                    value={formatSignedRate(rates.netPerDay)}
                    note={`created − completed · ${TASK_RATES.netDirection(rates.netPerDay)}`}
                  />
                  <Stat
                    label={TASK_RATES.openLabel}
                    value={rates.openNow === null ? '—' : formatInt(rates.openNow)}
                    note="to do + in progress + blocked, right now — not this window"
                  />
                  <Stat
                    label={TASK_RATES.medianLabel}
                    value={
                      rates.medianDaysToDone === null
                        ? '—'
                        : `${formatRate(rates.medianDaysToDone)}d`
                    }
                    note={
                      rates.medianDaysToDone === null
                        ? `nothing completed in ${days}d`
                        : `of the ${formatInt(rates.completed)} completed in ${days}d`
                    }
                  />
                </div>
                <p className={styles.ratesFoot}>{TASK_RATES.footnote}</p>
              </>
            )}
          </section>
        </>
      )}
    </Panel>
  );
};

export default WorkMix;
