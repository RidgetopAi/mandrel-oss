/**
 * Dashboard configuration — the single, named home for every Dashboard tunable
 * (no magic numbers in the components; see configs-not-hardcoded). Adjust the
 * time window, list sizes, or query staleness here and every card follows.
 */
import { RANGE_OPTIONS, type RangeValue } from '../tasks/config';

export const DASHBOARD_CONFIG = {
  /** Days of history behind the "Workspace activity" trend card. */
  trendDays: 30,
  /** Max rows in the "Recently active" projects rail. */
  recentProjectsLimit: 6,
  /** Max sessions scanned to build the "Sessions by actor" breakdown. */
  byActorScanLimit: 500,
  /** react-query staleTime for the Dashboard reads. */
  staleTimeMs: 1000 * 60 * 5,
  /** Fixed stage height (px) of the activity chart. */
  activityChartHeight: 220,
  /**
   * Range window for the Mandrel-wide "Task throughput" trend card (completed vs
   * created / day). One of the tasks RANGE_OPTIONS values (7d/30d/90d/all) — the
   * SAME range vocabulary the Tasks Analytics throughput uses, so the two stay
   * consistent. Matches the 30d activity window above by default.
   */
  throughputRange: '30d' as RangeValue,
} as const;

/**
 * Human label for the throughput window — resolved from the SINGLE-SOURCE tasks
 * RANGE_OPTIONS so the "· 30d" caption can never drift from the range value the
 * card actually queries. Falls back to the raw value if the option is ever removed.
 */
export const THROUGHPUT_RANGE_LABEL: string =
  RANGE_OPTIONS.find((r) => r.value === DASHBOARD_CONFIG.throughputRange)?.label ??
  DASHBOARD_CONFIG.throughputRange;

/**
 * Actor display constants + helpers now live in ONE shared source
 * (`src/config/actor.ts`) so the neutral label and the anonymous→unattributed
 * normalization can't drift across screens. Re-exported here for back-compat with
 * existing `./config` importers.
 */
export {
  UNATTRIBUTED_ACTOR,
  ANONYMOUS_ACTOR,
  isAttributed,
  actorLabel,
  ACTOR_DOT_PALETTE,
  actorDotVar,
} from '../../config/actor';

/** The metric key on a SessionTrendPoint the activity card plots (contexts/day). */
export const ACTIVITY_METRIC = 'total_contexts' as const;

export type KpiTone = 'teal' | 'green' | 'violet' | 'blue';

/** Static presentation for each KPI tile; the value/delta/caption are wired from
 *  live data in DashboardKpis (config carries only label + colour + icon key). */
export interface KpiSpec {
  key: 'projects' | 'activeTasks' | 'contexts' | 'decisions';
  label: string;
  tone: KpiTone;
  icon: 'projects' | 'tasks' | 'contexts' | 'decisions';
}

export const KPI_SPECS: readonly KpiSpec[] = [
  { key: 'projects', label: 'Projects', tone: 'teal', icon: 'projects' },
  { key: 'activeTasks', label: 'Active tasks', tone: 'green', icon: 'tasks' },
  { key: 'contexts', label: 'Contexts', tone: 'violet', icon: 'contexts' },
  { key: 'decisions', label: 'Decisions', tone: 'blue', icon: 'decisions' },
] as const;
