/**
 * Workspace activity — the hero trend from the mock (teal area, emphasized
 * endpoint). Real per-day data from `/api/sessions/trends`; we plot contexts/day
 * (ACTIVITY_METRIC). AreaChartCard (P0.6) owns the loading/empty states; the
 * top-right value is the total over the window.
 */
import React from 'react';
import { AreaChartCard } from '../../components/charts';
import { Alert } from '../../components/ui';
import { SectionHead, formatCount, scopeCaption, type DashboardCardProps } from './parts';
import { ActivityIcon } from './icons';
import { DASHBOARD_CONFIG, ACTIVITY_METRIC } from './config';
import { useActivityTrends } from './hooks';
import { apiErrorMessage } from '../../api/request';
import { formatDayShort, formatDayLong } from '../../utils/datetime';

export const ActivityCard: React.FC<DashboardCardProps> = ({ projectId, projectName, scope }) => {
  const { data, isPending, isError, error } = useActivityTrends(projectId, scope);
  // `isPending`, not `isLoading`: a react-query v5 query that is DISABLED (this page has
  // no project yet) reports isLoading=false with no data, which every card below would
  // render as its EMPTY state — "No projects yet" on a workspace that has plenty. Pending
  // is the state that says "no answer yet", and it covers both disabled and in-flight.


  const points = data ?? [];
  const total = points.reduce((sum, p) => sum + (Number(p[ACTIVITY_METRIC]) || 0), 0);

  return (
    <section aria-label="Workspace activity">
      <SectionHead icon={<ActivityIcon size={15} />}>Workspace activity</SectionHead>
      {isError ? (
        <Alert variant="error" title="Couldn't load activity trend">
          {apiErrorMessage(error, 'Failed to load trend data.')}
        </Alert>
      ) : (
        <AreaChartCard
          data={points as unknown as Array<Record<string, number | string>>}
          xKey="date"
          // `date` is a per-day BUCKET the backend already computed in the viewer's zone
          // (`AT TIME ZONE $tz`), serialised by res.json as a full ISO string. Rendered
          // raw it read `2026-07-13T00:00:00.000Z` on the axis; converted to local time it
          // would slide to the 12th for every negative-offset viewer. formatDayShort does
          // neither — see utils/datetime.ts.
          xTickFormatter={(v) => formatDayShort(v as string)}
          tooltipLabelFormatter={(v) => formatDayLong(v as string)}
          series={[{ key: ACTIVITY_METRIC, name: 'Contexts', color: 'var(--teal)' }]}
          title="Contexts / day"
          caption={`${scopeCaption(projectName)} · last ${DASHBOARD_CONFIG.trendDays}d`}
          value={isPending ? undefined : formatCount(total)}
          valueTone="teal"
          height={DASHBOARD_CONFIG.activityChartHeight}
          loading={isPending}
          showAxes
          showGrid
        />
      )}
    </section>
  );
};

export default ActivityCard;
