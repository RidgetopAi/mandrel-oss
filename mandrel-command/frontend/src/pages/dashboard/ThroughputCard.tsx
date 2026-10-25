/**
 * Task throughput — the Mandrel-wide "completed vs created / day" trend, sitting
 * directly under Workspace activity. REUSES the Tasks-screen `ThroughputChart`
 * (the same two-series area+line the Analytics view plots) rather than a bespoke
 * chart, and reads through `useDashboardThroughput` (NO project_id → whole
 * workspace). This card owns its own error surface; the shared ThroughputChart
 * owns loading + the HONEST empty state (an empty series ⇒ "No activity in this
 * window", never a fabricated trend — the data-gap policy).
 */
import React from 'react';
import { Alert } from '../../components/ui';
import { SectionHead, type DashboardCardProps } from './parts';
import { TasksIcon } from './icons';
import { ThroughputChart } from '../tasks/ThroughputChart';
import { THROUGHPUT_RANGE_LABEL } from './config';
import { useDashboardThroughput } from './hooks';
import { apiErrorMessage } from '../../api/request';

export const ThroughputCard: React.FC<DashboardCardProps> = ({ projectId, scope }) => {
  const { data, isPending, isError, error } = useDashboardThroughput(projectId, scope);
  // `isPending`, not `isLoading`: a react-query v5 query that is DISABLED (this page has
  // no project yet) reports isLoading=false with no data, which every card below would
  // render as its EMPTY state — "No projects yet" on a workspace that has plenty. Pending
  // is the state that says "no answer yet", and it covers both disabled and in-flight.


  return (
    <section aria-label="Task throughput">
      <SectionHead icon={<TasksIcon size={15} />}>Task throughput</SectionHead>
      {isError ? (
        <Alert variant="error" title="Couldn't load throughput trend">
          {apiErrorMessage(error, 'Failed to load throughput data.')}
        </Alert>
      ) : (
        <ThroughputChart
          series={data}
          rangeLabel={THROUGHPUT_RANGE_LABEL}
          loading={isPending}
        />
      )}
    </section>
  );
};

export default ThroughputCard;
