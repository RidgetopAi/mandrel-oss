/**
 * Calendar configuration — the single, named home for every Calendar-screen
 * tunable (no magic numbers in the components; see configs-not-hardcoded). The
 * week anchor, history cap, list caps, query staleness, and the priority→token
 * palette all live here.
 *
 * WHAT THIS SCREEN IS (grounded to the data, per data-gap policy 10397f65):
 * Mandrel records are HISTORICAL — sessions/contexts/tasks carry timestamps, not a
 * planning schedule. So this Calendar is the **activity-by-date** view: each day
 * cell shows that day's MOMENTUM score (ring + number, from `/api/momentum-series`)
 * plus its session/context counts and any task whose `due_date` lands on it. It
 * renders full-screen across three ranges — Month (default) / Week / Day — and every
 * day cell is clickable to open the day-summary card. The old
 * "Unscheduled" backlog rail and the mock's drag-to-schedule / sprint band / export
 * are DROPPED (not this tool).
 */
import type { TaskEntity } from '../../api/generated/models/TaskEntity';

/** The three time ranges the calendar can render. Month is the default. */
export type CalendarView = 'month' | 'week' | 'day';

/** View-switcher options, in toolbar order (single source — no magic strings). */
export const CALENDAR_VIEWS: ReadonlyArray<{ value: CalendarView; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
] as const;

export const CALENDAR_CONFIG = {
  /** The range shown on first load. */
  defaultView: 'month' as CalendarView,
  /**
   * Which weekday a grid row starts on (0 = Sunday … 6 = Saturday). Standard
   * Sunday-start; flip to 6 for a Saturday-start (one-line change, no code touched).
   */
  weekStartsOn: 0,
  /** Max rows pulled from `/api/tasks` (feeds the scheduled-by-due-date cards). */
  taskListLimit: 1000,
  /** react-query staleTime for the Calendar reads. */
  staleTimeMs: 1000 * 60 * 2,
} as const;

/** A task is "done" (dimmed + checked on its day) when completed/cancelled. */
export const DONE_STATUSES: ReadonlyArray<TaskEntity['status']> = ['completed', 'cancelled'] as const;

/**
 * Priority → design-token custom-property NAME (never a hex). Resolved with
 * `var(--x)` at the callsite, so no colour literal lands in TS or CSS.
 */
export const PRIORITY_VAR: Record<TaskEntity['priority'], string> = {
  urgent: '--rose',
  high: '--amber',
  medium: '--blue',
  low: '--tx-3',
} as const;

/** Token var for a task priority, defaulting to the faint ramp for unknowns. */
export function priorityVar(priority: TaskEntity['priority'] | undefined): string {
  return (priority && PRIORITY_VAR[priority]) || '--tx-3';
}

/** Is this status one of the "done" set (drives the checked/dimmed card look)? */
export function isDone(status: TaskEntity['status'] | undefined): boolean {
  return status != null && DONE_STATUSES.includes(status);
}
