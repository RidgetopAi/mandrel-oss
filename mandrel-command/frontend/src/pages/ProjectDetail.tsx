/**
 * ProjectDetail — the project-scoped "dashboard", rebuilt to the LOCKED mock
 * (docs/command-project-detail-mock.html) on the P0 foundation: P0.3 primitives + P0.2
 * tokens, ZERO antd, all data through the unified `api` client via react-query
 * (src/pages/projectDetail/hooks.ts). Opened from a Projects card (/projects/:id). Mirrors
 * the Contexts/Tasks/Decisions/Projects rebuilds: thin composition here, a `projectDetail/`
 * module owning the parts, config, data, and a token-driven stylesheet — each section
 * owning its own loading/empty/error state.
 *
 * Layout: a hero (name / status / description / Edit + "Set as my default"), a row of REAL vital tiles
 * (contexts / tasks / decisions / sessions / commits), and a section grid — repository
 * activity, recent sessions, the task mini-board, and recent decisions.
 *
 * DATA GAPS (policy 10397f65 — never fabricate): the mock's per-project 30-day activity
 * sparkline is OMITTED (not served); the "active branches → TreeWalker" card is replaced
 * by the REAL git-activity signal (RepoActivityCard); sessions show real context counts +
 * activity time only (no fabricated token/actor/live fields). See projectDetail/config.ts.
 */
import React from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Spinner, Alert, Button } from '../components/ui';
import { useSettings } from '../hooks/useSettings';
import { logger } from '../utils/logger';
import { Hero } from './projectDetail/Hero';
import { VitalTiles } from './projectDetail/VitalTiles';
import { RepoActivityCard } from './projectDetail/RepoActivityCard';
import { SessionsCard } from './projectDetail/SessionsCard';
import { TasksBoard } from './projectDetail/TasksBoard';
import { DecisionsCard } from './projectDetail/DecisionsCard';
import { EditProjectDrawer } from './projectDetail/EditProjectDrawer';
import { ChevronLeftIcon } from './projectDetail/icons';
import {
  useProjectRecord,
  useProjectInsights,
  useProjectSessions,
  useProjectDecisions,
} from './projectDetail/hooks';
import { isProjectActive } from './projectDetail/config';
import styles from './projectDetail/ProjectDetail.module.css';
import { apiErrorMessage } from '../api/request';

const ProjectDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { defaultProjectId, setDefaultProjectId } = useSettings();

  const record = useProjectRecord(id);
  const insights = useProjectInsights(id);
  const sessions = useProjectSessions(id);
  const decisions = useProjectDecisions(id);

  const [editOpen, setEditOpen] = React.useState(false);
  const [settingDefault, setSettingDefault] = React.useState(false);

  const project = record.data;
  const now = React.useMemo(() => Date.now(), [record.data]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Make this project THIS USER's default (epic 41293984 §C). Formerly "switch to
   * project", which set a hidden app-wide scope; there is no such global now.
   *
   * The write is authorization-checked server-side (the backend refuses a project the
   * user cannot see), so a failure is surfaced rather than optimistically painted.
   */
  const onSetDefault = React.useCallback(async () => {
    if (!project?.id) return;
    setSettingDefault(true);
    try {
      await setDefaultProjectId(project.id);
    } catch (err) {
      logger.error('Set default project error', err);
    } finally {
      setSettingDefault(false);
    }
  }, [project, setDefaultProjectId]);

  const backLink = (
    <Link to="/projects" className={styles.back}>
      <ChevronLeftIcon size={15} />
      Projects
    </Link>
  );

  if (record.isLoading) {
    return (
      <div className={styles.page}>
        {backLink}
        <div className={styles.pageState}>
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  if (record.isError || !project) {
    return (
      <div className={styles.page}>
        {backLink}
        <div className={styles.pageState}>
          <Alert variant="error" title="Couldn't load this project">
            {apiErrorMessage(record.error, 'This project could not be found or loaded.')}
          </Alert>
          <Button onClick={() => navigate('/projects')}>Back to Projects</Button>
        </div>
      </div>
    );
  }

  const active = isProjectActive(project, now);

  return (
    <div className={styles.page}>
      {backLink}

      <Hero
        project={project}
        active={active}
        onEdit={() => setEditOpen(true)}
        onSetDefault={onSetDefault}
        settingDefault={settingDefault}
        isDefault={!!project.id && project.id === defaultProjectId}
      />

      <VitalTiles
        project={project}
        insights={insights.data}
        insightsLoading={insights.isLoading}
        insightsError={insights.isError}
      />

      <div className={styles.cols}>
        <RepoActivityCard
          insights={insights.data}
          loading={insights.isLoading}
          error={insights.isError}
        />
        <SessionsCard
          sessions={sessions.data}
          loading={sessions.isLoading}
          isError={sessions.isError}
          error={sessions.error}
        />
        <TasksBoard
          insights={insights.data}
          loading={insights.isLoading}
          error={insights.isError}
        />
        <DecisionsCard
          decisions={decisions.data}
          loading={decisions.isLoading}
          isError={decisions.isError}
          error={decisions.error}
        />
      </div>

      <EditProjectDrawer
        open={editOpen}
        project={project}
        onClose={() => setEditOpen(false)}
      />
    </div>
  );
};

export default ProjectDetail;
