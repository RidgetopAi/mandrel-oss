/**
 * Recently active — the rail projects list from the mock, wired to `/api/projects`
 * (real ProjectEntity fields: context_count, session_count, last_activity). Sorted
 * by last activity in the hook. Rows link to the project detail. (The mock's
 * per-project task/decision counts aren't in the list payload — we show the ctx +
 * session counts the endpoint actually serialises; see the coordinator note.)
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Spinner, Empty, Alert, Text, Badge } from '../../components/ui';
import type { ProjectEntity } from '../../api/generated/models/ProjectEntity';
import { SectionHead, formatCount, formatRelative } from './parts';
import { ProjectsIcon } from './icons';
import { useRecentProjects } from './hooks';
import type { DashboardCardProps } from './parts';
import styles from './Dashboard.module.css';
import { apiErrorMessage } from '../../api/request';

function ProjectRow({ p }: { p: ProjectEntity }) {
  const navigate = useNavigate();
  return (
    <button type="button" className={styles.prow} onClick={() => navigate(`/projects/${p.id}`)}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.pmid}>
        <span className={styles.pname}>
          <Text variant="body" style={{ fontWeight: 560 }}>
            {p.name}
          </Text>
          {p.status === 'active' && <Badge variant="teal">active</Badge>}
        </span>
        <Text variant="data" tone="faint">
          {formatCount(p.context_count)} ctx · {formatCount(p.session_count)} sessions
        </Text>
      </span>
      <Text variant="data" tone="faintest">
        {formatRelative(p.last_activity)}
      </Text>
    </button>
  );
}

export const RecentProjects: React.FC<DashboardCardProps> = ({ projectId, scope }) => {
  const { data, isPending, isError, error } = useRecentProjects(projectId, scope);
  // `isPending`, not `isLoading`: a react-query v5 query that is DISABLED (this page has
  // no project yet) reports isLoading=false with no data, which every card below would
  // render as its EMPTY state — "No projects yet" on a workspace that has plenty. Pending
  // is the state that says "no answer yet", and it covers both disabled and in-flight.

  const projects = data ?? [];

  return (
    <section aria-label="Recently active projects">
      <SectionHead icon={<ProjectsIcon size={15} />}>Recently active</SectionHead>
      <Card flush className={styles.panelFlush}>
        {isPending ? (
          <div className={styles.stateWrap}>
            <Spinner size="md" />
          </div>
        ) : isError ? (
          <div className={styles.stateWrap}>
            <Alert variant="error" title="Couldn't load projects">
              {apiErrorMessage(error, 'Failed to load projects.')}
            </Alert>
          </div>
        ) : projects.length === 0 ? (
          <div className={styles.stateWrap}>
            <Empty title="No projects yet" description="Create a project to get started." />
          </div>
        ) : (
          <div className={styles.rows}>
            {projects.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </div>
        )}
      </Card>
    </section>
  );
};

export default RecentProjects;
