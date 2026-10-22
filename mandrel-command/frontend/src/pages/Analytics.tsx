/**
 * Analytics — the Command "pivot surface" screen (Phase 3 "Insight"), rebuilt to the LOCKED
 * mock (docs/command-analytics-mock.html) on the P0 foundation: P0.2 tokens + P0.3
 * primitives + the shared P0.6 charting module, ZERO antd, all data through the unified
 * `api` client via react-query (src/pages/analytics/hooks.ts). Mirrors the Phase 2 Decisions
 * rebuild: thin composition here, an `analytics/` module owning the parts, config, data, and
 * a token-driven stylesheet — each section owning its loading / empty / error state.
 *
 * Every panel NAMES the request it makes, in its own provenance line (the footer legend
 * that used to gloss those dots is deleted — see analytics/config.ts):
 *   • KPI strip + hero "Activity over time" — LIVE `/api/sessions/trends` (one derived source);
 *   • "Work mix — tasks" — LIVE `/api/tasks/stats` (cohort bar) + `/api/tasks/lead-time`
 *     (the per-day flow block, a deliberately different population — see WorkMix.tsx);
 *   • "Most active sessions" / "Sessions started — by hour" — live session endpoints;
 *   • "Activity by actor" — LIVE `/api/sessions/contexts-by-actor` (bars + coverage, one read).
 *
 * The legacy placeholder tabs (four "coming soon" panes) are CUT — the locked mock has none.
 *
 * PROJECT SCOPE (epic 41293984 §E): the page owns its scope via `usePageProject`, opens on
 * the user's DEFAULT project (it used to open on "every project"), keeps `?project=` in the
 * URL as the source of truth, and passes that scope EXPLICITLY to every read — both as
 * the endpoint's `project_id` query param and as the per-request `X-Project-ID` header.
 */
import React from 'react';
import { Heading, Text } from '../components/ui';
import { FilterRow, ALL_ACTORS } from './analytics/FilterRow';
import { KpiStrip } from './analytics/KpiStrip';
import { ActivityTrend } from './analytics/ActivityTrend';
import { ActorBars } from './analytics/ActorBars';
import { WorkMix } from './analytics/WorkMix';
import { ProductiveSessions } from './analytics/ProductiveSessions';
import { SessionRhythm } from './analytics/SessionRhythm';
import {
  useActivityTrends,
  useTaskStats,
  useTaskLeadTime,
  useOpenTaskCounts,
  useProductiveSessions,
  useTokenPatterns,
  useContextsByActor,
} from './analytics/hooks';
import { usePageProject } from '../hooks/usePageProject';
import { ANALYTICS_CONFIG, type RangeValue } from './analytics/config';
import styles from './analytics/Analytics.module.css';

const Analytics: React.FC = () => {
  const [range, setRange] = React.useState<RangeValue>(ANALYTICS_CONFIG.defaultRangeDays);
  // The "who" slice (item 6). `ALL_ACTORS` — the empty string — means no
  // slice, and is passed to the hooks as `undefined` so the param is OMITTED from the
  // request rather than sent empty.
  const [actor, setActor] = React.useState<string>(ALL_ACTORS);

  // Scoped by the ONE switch in the topbar: one project at a time, opening
  // on the user's default. No "All projects" here (walkthrough ed6ae449 F2).
  const project = usePageProject();
  // ONE scope object, spread into every read, so a hook cannot be wired up with the
  // project but without the request scope (or the other way round).
  const pageScope = {
    projectId: project.projectId,
    scope: project.scope,
    enabled: project.ready,
  };

  const actorSlice = actor === ALL_ACTORS ? undefined : actor;

  const trends = useActivityTrends({ ...pageScope, days: range, actor: actorSlice });
  const taskStats = useTaskStats({ ...pageScope, days: range });
  // The Work-mix flow block's two extra reads. They are DIFFERENT
  // populations from the cohort bar above them and from each other: lead-time is
  // window-scoped on `completed_at`, open-counts is deliberately unwindowed. Both are
  // passed to the one panel that states which is which.
  const taskLeadTime = useTaskLeadTime({ ...pageScope, days: range });
  const openTasks = useOpenTaskCounts(pageScope);
  const productive = useProductiveSessions({ ...pageScope, days: range });
  const tokenPatterns = useTokenPatterns({ ...pageScope, days: range });
  // Deliberately NOT sliced by actor: this is the panel that SHOWS the actor breakdown,
  // and it is also the source of the control's own option list — filtering it to the
  // selected actor would leave the control able to offer exactly one choice.
  const actorActivity = useContextsByActor({ ...pageScope, days: range });

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Analytics
          </Heading>
          <Text variant="data" tone="faintest">
            pivot activity · {project.projectName ?? '…'}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          The pivot surface — every panel names its live data source (real, not mocked).
        </Text>
      </header>

      <FilterRow
        range={range}
        onRangeChange={setRange}
        actor={actor}
        onActorChange={setActor}
        actorOptions={(actorActivity.data?.actors ?? []).map((a) => a.actor)}
        actorsLoading={actorActivity.isLoading}
      />

      <KpiStrip
        trends={trends.data}
        actor={actorSlice}
        isLoading={trends.isLoading}
        isError={trends.isError}
      />

      <ActivityTrend
        trends={trends.data}
        days={range}
        actor={actorSlice}
        isLoading={trends.isLoading}
        isError={trends.isError}
      />

      <div className={styles.pgrid}>
        <ActorBars
          data={actorActivity.data}
          isLoading={actorActivity.isLoading}
          isError={actorActivity.isError}
          error={actorActivity.error}
        />
        <WorkMix
          stats={taskStats.data}
          days={range}
          isLoading={taskStats.isLoading}
          isError={taskStats.isError}
          error={taskStats.error}
          leadTime={taskLeadTime.data}
          leadTimeLoading={taskLeadTime.isLoading}
          leadTimeError={taskLeadTime.isError}
          openStats={openTasks.data}
        />
        <ProductiveSessions
          sessions={productive.data}
          days={range}
          isLoading={productive.isLoading}
          isError={productive.isError}
          error={productive.error}
        />
        <SessionRhythm
          patterns={tokenPatterns.data}
          isLoading={tokenPatterns.isLoading}
          isError={tokenPatterns.isError}
          error={tokenPatterns.error}
        />
      </div>
    </div>
  );
};

export default Analytics;
