/**
 * Dashboard — the Command landing screen, rebuilt to the LOCKED mock
 * (docs/command-dashboard-mock.html) on the P0 foundation: P0.3 primitives +
 * P0.6 charts + P0.2 tokens, ZERO antd, all data through the unified `api` client
 * via react-query (src/pages/dashboard/hooks.ts). This is the reference the later
 * screen rebuilds copy: config-driven cards, each owning its loading/empty/error state.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THIS PAGE IS PROJECT-SCOPED. IT USED TO CLAIM IT WASN'T. (epic 41293984)
 * ════════════════════════════════════════════════════════════════════════════════════
 * The header said "Mandrel-wide" and two card captions repeated it. That was never true.
 * Every read on this page — `/api/dashboard/stats`, `/api/sessions`, `/api/sessions/trends`,
 * `/api/tasks/throughput`, and `/api/projects` — resolves a `ProjectListScope` on the
 * backend before it counts or lists anything, and none of them named a project, so all of
 * them were scoped by the ambient `X-Project-ID` header. The KPI row was one project's
 * counts wearing a workspace-wide label, and it changed meaning whenever the ambient
 * project changed, with no control on screen moving.
 *
 * WHY A SELECTOR RATHER THAN "MAKE IT GENUINELY MANDREL-WIDE". Both were live options and
 * the brief asked for a deliberate choice, so:
 *
 *   1. Truly workspace-wide means sending NO project, forever. That is exactly the
 *      permanently-unscoped state amendment §A2 exists to make unreachable, and it is the
 *      one input several backend controllers read as "every project".
 *   2. It does not even mean the same thing for two users. `resolveListScope` reads an
 *      unscoped request as ALL_PROJECTS for an admin and as "your granted projects" for
 *      everyone else — so the identical screen would silently show two different
 *      populations under one label. A number whose population depends on who is looking,
 *      without saying so, is the same dishonesty in a new place.
 *   3. "Everything" is still reachable, but as a THING THE USER PICKED: the selector
 *      offers All projects, which sends `project_id=all` — the resolver's explicit
 *      unscoped sentinel. Chosen widening, visible in the control and in the URL.
 *
 * So: one selector, defaulting to the user's default project, and every caption follows
 * the selection instead of asserting a scope of its own.
 */
import React from 'react';
import { Heading, Text } from '../components/ui';
import { usePageProject } from '../hooks/usePageProject';
import { useAuthContext } from '../contexts/AuthContext';
import { DashboardKpis } from './dashboard/DashboardKpis';
import { ActivityCard } from './dashboard/ActivityCard';
import { ThroughputCard } from './dashboard/ThroughputCard';
import { SessionsByActor } from './dashboard/SessionsByActor';
import { RecentProjects } from './dashboard/RecentProjects';
import styles from './dashboard/Dashboard.module.css';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const DATE_FMT: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'short', day: 'numeric' };

const Dashboard: React.FC = () => {
  const { user } = useAuthContext();
  const name = user?.username || 'there';
  const today = new Date().toLocaleDateString(undefined, DATE_FMT);

  // Scoped by the ONE switch in the topbar: one project at a time, opening
  // on the user's default. No "All projects" here (walkthrough ed6ae449 F2).
  const project = usePageProject();

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            {greeting()}, {name}
          </Heading>
          <Text variant="data" tone="faintest">
            {today}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          What&apos;s moving in {project.projectName ?? 'this project'} — and where the work lives.
        </Text>
      </header>

      <DashboardKpis
        projectId={project.projectId}
        projectName={project.projectName}
        scope={project.scope}
      />

      {/* Full-width single-column stack (the KPI row sits above): Workspace activity,
          then Task throughput (completed vs created / day), Recently active projects, and
          Sessions by actor — each spanning the full canvas width, and each reading THE
          SAME scope this page's selector names. (The chronological session feed lives on
          the Sessions page; a normalized `actor` is the single "who" for attribution.) */}
      <div className={styles.stack}>
        <ActivityCard
          projectId={project.projectId}
          projectName={project.projectName}
          scope={project.scope}
        />
        <ThroughputCard projectId={project.projectId} scope={project.scope} />
        <RecentProjects projectId={project.projectId} scope={project.scope} />
        <SessionsByActor projectId={project.projectId} scope={project.scope} />
      </div>
    </div>
  );
};

export default Dashboard;
