/**
 * SessionDetail — the session-scoped detail screen, rebuilt onto the redesign
 * foundation (P0.2 tokens + P0.3 primitives, ZERO antd) to match the Phase-2 detail
 * pattern (ProjectDetail). Thin composition here; a co-located `sessionDetail/` module
 * owns the parts, config, data hooks, and a token-only stylesheet. Opened from a
 * Sessions card (/sessions/:id).
 *
 * The five tabs are all wired to REAL data through the unified `api.sessions.*` client:
 *   Contexts / Tasks / Decisions / Timeline ← api.sessions.get(id)  (GET /api/sessions/:id)
 *   Files                                    ← api.sessions.files(id) (GET /api/v2/sessions/:id/files)
 * Each tab owns an honest empty state (the data-gap policy) — no fabricated rows.
 *
 * Route guard mirrors ProjectDetail's self-heal: a malformed :id (not a UUID) never
 * fires a request guaranteed to 400/404 (queries disabled) and redirects to /sessions,
 * so a bad URL can't wedge the page.
 */
import React from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Spinner, Alert, Button, Card, Tabs, type TabItem } from '../components/ui';
import { isValidUuid } from '../utils/uuid';
import { logger } from '../utils/logger';
import { Hero } from './sessionDetail/Hero';
import { SessionVitals } from './sessionDetail/SessionVitals';
import {
  ContextsPanel,
  TasksPanel,
  DecisionsPanel,
  FilesPanel,
  TimelinePanel,
} from './sessionDetail/panels';
import { ChevronLeftIcon } from './sessionDetail/icons';
import { useSessionDetail, useSessionFiles } from './sessionDetail/hooks';
import styles from './sessionDetail/SessionDetail.module.css';
import { apiErrorMessage } from '../api/request';

const SessionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const valid = isValidUuid(id);

  const detail = useSessionDetail(id, valid);
  const files = useSessionFiles(id, valid);

  // Self-heal: a malformed :id can never load — redirect to the list rather than
  // wedge on a perpetual loading/empty state (matches ProjectDetail).
  React.useEffect(() => {
    if (id && !valid) {
      logger.error('Invalid session id in route, redirecting:', id);
      navigate('/sessions');
    }
  }, [id, valid, navigate]);

  const backLink = (
    <Link to="/sessions" className={styles.back}>
      <ChevronLeftIcon size={15} />
      Sessions
    </Link>
  );

  if (detail.isLoading) {
    return (
      <div className={styles.page}>
        {backLink}
        <div className={styles.pageState}>
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  const session = detail.data;
  if (detail.isError || !session) {
    return (
      <div className={styles.page}>
        {backLink}
        <div className={styles.pageState}>
          <Alert variant="error" title="Couldn't load this session">
            {apiErrorMessage(detail.error, 'This session could not be found or loaded.')}
          </Alert>
          <Button onClick={() => navigate('/sessions')}>Back to Sessions</Button>
        </div>
      </div>
    );
  }

  const contexts = session.contexts ?? [];
  const tasks = session.tasks ?? [];
  const decisions = session.decisions ?? [];
  const fileRows = files.data ?? [];

  const label = (text: string, n: number) => `${text} (${n.toLocaleString()})`;

  const items: TabItem[] = [
    { key: 'contexts', label: label('Contexts', contexts.length), content: <ContextsPanel contexts={contexts} /> },
    { key: 'tasks', label: label('Tasks', tasks.length), content: <TasksPanel tasks={tasks} /> },
    { key: 'decisions', label: label('Decisions', decisions.length), content: <DecisionsPanel decisions={decisions} /> },
    {
      key: 'files',
      label: label('Files', fileRows.length),
      content: (
        <FilesPanel
          files={fileRows}
          loading={files.isLoading}
          isError={files.isError}
          error={files.error}
        />
      ),
    },
    { key: 'timeline', label: 'Timeline', content: <TimelinePanel detail={session} /> },
  ];

  return (
    <div className={styles.page}>
      {backLink}
      <Hero session={session} />
      <SessionVitals session={session} />
      <Card className={styles.tabsCard}>
        <Tabs items={items} aria-label="Session detail sections" className={styles.tabBody} />
      </Card>
    </div>
  );
};

export default SessionDetail;
