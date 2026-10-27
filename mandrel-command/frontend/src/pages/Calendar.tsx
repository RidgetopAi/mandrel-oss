/**
 * Calendar — the Command "time axis of work" screen. Full-screen, three ranges:
 * MONTH (default) / Week / Day, switchable in the toolbar. Built on the P0 foundation
 * (P0.3 primitives + P0.2 tokens, ZERO antd), all data through the unified `api`
 * client via react-query (src/pages/calendar/hooks.ts).
 *
 * WHAT THIS SCREEN IS (data-gap policy · an earlier decision): Mandrel records
 * are HISTORICAL, so this is the **activity-by-date** view — each day cell shows that
 * day's MOMENTUM score (ring + number, from `/api/momentum-series`, TZ-correct per an earlier task)
 * plus its session/context counts and any task whose `due_date` lands on it.
 * Every day cell is CLICKABLE → opens the day-summary card (built separately,
 * this shell renders the `<DaySummary/>` boundary). The old "Unscheduled"
 * backlog rail and the mock's drag-to-schedule / sprint / export layers are DROPPED —
 * this is a daily-summary tool, not a planning board.
 *
 * PROJECT SCOPE (an earlier epic §E): the page owns its scope via `usePageProject` and opens
 * on the user's DEFAULT project (it used to open on 'all'). Only the INITIAL VALUE changed:
 * the wire contract is untouched — the selection is still sent RAW as `?project=`, literal
 * `'all'` included, which the backend reads as explicitly unscoped and which beats the
 * ambient header. DaySummary still inherits this page's selection by prop.
 */
import React from 'react';
import { Heading, Text, Spinner, Alert } from '../components/ui';
import { CalendarToolbar } from './calendar/CalendarToolbar';
import { WeekGrid } from './calendar/WeekGrid';
import { MonthGrid } from './calendar/MonthGrid';
import { DayView } from './calendar/DayView';
import { DaySummary } from './calendar/DaySummary';
import { bucketMomentum, tasksByDay } from './calendar/parts';
import { useMomentumSeries, useCalendarTasks } from './calendar/hooks';
import { usePageProject } from '../hooks/usePageProject';
import { CALENDAR_CONFIG, type CalendarView } from './calendar/config';
import {
  startOfDay,
  startOfWeek,
  weekDays,
  monthGridDays,
  addDays,
  addWeeks,
  addMonths,
  toDateKey,
  formatWeekRange,
  formatMonthLabel,
  formatDayLabel,
} from './calendar/dates';
import { getBrowserTimeZone } from '../utils/browserTimeZone';
import styles from './calendar/Calendar.module.css';
import { apiErrorMessage } from '../api/request';

const Calendar: React.FC = () => {
  const [view, setView] = React.useState<CalendarView>(CALENDAR_CONFIG.defaultView);
  // `anchor` is a representative day inside the visible range; each view derives its
  // days from it, and the nav arrows step it by the active view's unit.
  const [anchor, setAnchor] = React.useState(() => new Date());
  // The day whose summary card is open (null = closed). Clicking a cell sets it.
  const [selectedDate, setSelectedDate] = React.useState<Date | null>(null);

  // Scoped by the ONE switch in the topbar: one project at a time, opening
  // on the user's default. No "All projects" here (an earlier walkthrough F2).
  const project = usePageProject();
  const pageScope = { scope: project.scope, enabled: project.ready };
  const tz = getBrowserTimeZone();

  // Derive the visible days + labels from (view, anchor). Each view requests EXACTLY its
  // own span from the momentum-series endpoint: fromKey/toKey are the first/last visible
  // day (a single day, the 7 week days, or the 42-cell month grid).
  const { days, fromKey, toKey, rangeLabel } = React.useMemo(() => {
    if (view === 'month') {
      const d = monthGridDays(anchor, CALENDAR_CONFIG.weekStartsOn);
      return { days: d, fromKey: toDateKey(d[0]), toKey: toDateKey(d[d.length - 1]), rangeLabel: formatMonthLabel(anchor) };
    }
    if (view === 'week') {
      const ws = startOfWeek(anchor, CALENDAR_CONFIG.weekStartsOn);
      const d = weekDays(ws);
      return { days: d, fromKey: toDateKey(d[0]), toKey: toDateKey(d[d.length - 1]), rangeLabel: formatWeekRange(ws) };
    }
    const d0 = startOfDay(anchor);
    const k = toDateKey(d0);
    return { days: [d0], fromKey: k, toKey: k, rangeLabel: formatDayLabel(d0) };
  }, [view, anchor]);

  // The grid's ONE data source: per-day momentum + counts for the visible range. The page's
  // selection is passed RAW (the literal 'all' included) so the Calendar's own scope is
  // authoritative on the backend — see the contract note in calendar/hooks.ts.
  const activity = useMomentumSeries({
    fromKey,
    toKey,
    project: project.projectId,
    tz,
    ...pageScope,
  });
  const tasksQ = useCalendarTasks({ projectId: project.projectId, ...pageScope });

  const momentum = React.useMemo(() => bucketMomentum(activity.data), [activity.data]);
  const byDay = React.useMemo(() => tasksByDay(tasksQ.data), [tasksQ.data]);
  const selectedKey = selectedDate ? toDateKey(selectedDate) : undefined;

  const isLoading = activity.isLoading || tasksQ.isLoading;
  const isError = activity.isError || tasksQ.isError;
  const err = activity.error ?? tasksQ.error;

  // Nav: step the anchor by the active view's unit; Today resets it; a jump sets it.
  const stepBy = (dir: -1 | 1) =>
    setAnchor((a) =>
      view === 'month' ? addMonths(a, dir) : view === 'week' ? addWeeks(a, dir) : addDays(a, dir),
    );

  const selectDate = (d: Date) => setSelectedDate(d);
  const closeDay = () => setSelectedDate(null);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Calendar
          </Heading>
          <Text variant="data" tone="faintest">
            activity by date · {project.projectName ?? '…'}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          The time axis of work — what got done, day by day. Click any day to open its summary.
        </Text>
      </header>

      <CalendarToolbar
        view={view}
        onViewChange={setView}
        rangeLabel={rangeLabel}
        anchor={anchor}
        onPrev={() => stepBy(-1)}
        onNext={() => stepBy(1)}
        onToday={() => setAnchor(new Date())}
        onJumpToDate={(d) => setAnchor(d)}
      />

      {isLoading ? (
        <div className={styles.pageState}>
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <div className={styles.pageState}>
          <Alert variant="error" title="Couldn't load the calendar">
            {apiErrorMessage(err, 'Failed to load calendar data.')}
          </Alert>
        </div>
      ) : (
        <div className={styles.cal}>
          {view === 'month' ? (
            <MonthGrid
              days={days}
              month={anchor}
              momentum={momentum}
              tasksByDay={byDay}
              onSelectDate={selectDate}
              selectedKey={selectedKey}
            />
          ) : view === 'week' ? (
            <WeekGrid
              days={days}
              momentum={momentum}
              tasksByDay={byDay}
              onSelectDate={selectDate}
              selectedKey={selectedKey}
            />
          ) : (
            <DayView
              day={days[0]}
              momentum={momentum}
              tasksByDay={byDay}
              onSelectDate={selectDate}
              selectedKey={selectedKey}
            />
          )}

          {/* The day card INHERITS the Calendar's selection — it has no selector of its
              own, by design (an earlier epic §E). It gets the same raw project value and the
              same per-request scope, so the card and the grid behind it can never
              disagree about which project they are showing. */}
          {selectedDate && project.projectId && (
            <DaySummary
              date={selectedDate}
              tz={tz}
              project={project.projectId}
              scope={project.scope}
              onClose={closeDay}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default Calendar;
