/**
 * The five session-detail tab bodies — Contexts / Tasks / Decisions / Files / Timeline —
 * each rendering REAL data from the unified `api.sessions.*` reads and each owning an
 * honest empty state (the data-gap policy: an empty array shows "nothing recorded", never a
 * fabricated row). Contexts/Tasks/Decisions/Timeline come from `api.sessions.get(id)`;
 * Files comes from `api.sessions.files(id)` (GET /api/v2/sessions/:id/files).
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Empty,
  Spinner,
  Alert,
  Code,
  Text,
  DataTable,
  type Column,
} from '../../components/ui';
import MarkdownContent, { markdownExcerpt } from '../../components/common/MarkdownContent';
import { recordPath } from '../../utils/deepLink';
import type { SessionDetailView } from './hooks';
import type { SessionFile } from '../../types/session';
import {
  SESSION_DETAIL_CONFIG,
  TASK_STATUS_TONE,
  TASK_TYPE_TONE,
  TASK_PRIORITY_TONE,
  FILE_SOURCE_TONE,
  decisionStatusTone,
  decisionImpactTone,
} from './config';
import {
  formatDate,
  formatRelative,
  formatCount,
  contextKind,
  KIND_TONE,
  buildTimeline,
  firstLine,
  TimelineRecordId,
} from './parts';
import { EyeIcon } from './icons';
import styles from './SessionDetail.module.css';
import { apiErrorMessage } from '../../api/request';

type ContextRow = NonNullable<SessionDetailView['contexts']>[number];
type TaskRow = NonNullable<SessionDetailView['tasks']>[number];
type DecisionRow = NonNullable<SessionDetailView['decisions']>[number];

/* ------------------------------------------------------------------ Contexts */

export const ContextsPanel: React.FC<{ contexts: ContextRow[] }> = ({ contexts }) => {
  const navigate = useNavigate();
  if (contexts.length === 0) {
    return (
      <div className={styles.tabState}>
        <Empty title="No contexts" description="No contexts were recorded in this session." />
      </div>
    );
  }
  return (
    <div className={styles.ctxRows}>
      {contexts.map((c) => {
        const type = c.context_type ?? c.type;
        return (
          <div key={c.id} className={styles.ctxRow}>
            <div className={styles.ctxHead}>
              <Badge variant={KIND_TONE[contextKind(type)]}>{type ?? 'context'}</Badge>
              <span className={styles.ctxTime}>{formatDate(c.created_at)}</span>
              <span className={styles.ctxView}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate(recordPath('context', c.id))}
                >
                  <EyeIcon size={14} /> View
                </Button>
              </span>
            </div>
            <MarkdownContent content={c.content} className={styles.ctxBody} />
            {c.tags && c.tags.length > 0 && (
              <div className={styles.ctxTags}>
                {c.tags.map((tag) => (
                  <Badge key={tag} variant="neutral">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/* --------------------------------------------------------------------- Tasks */

export const TasksPanel: React.FC<{ tasks: TaskRow[] }> = ({ tasks }) => {
  if (tasks.length === 0) {
    return (
      <div className={styles.tabState}>
        <Empty title="No tasks" description="No tasks were created or touched in this session." />
      </div>
    );
  }
  const columns: Column<TaskRow>[] = [
    {
      key: 'title',
      header: 'Title',
      render: (t) => <Text variant="data">{t.title}</Text>,
    },
    {
      key: 'type',
      header: 'Type',
      width: 130,
      render: (t) =>
        t.type ? <Badge variant={TASK_TYPE_TONE[t.type] ?? 'neutral'}>{t.type}</Badge> : '—',
    },
    {
      key: 'status',
      header: 'Status',
      width: 130,
      render: (t) =>
        t.status ? (
          <Badge variant={TASK_STATUS_TONE[t.status] ?? 'neutral'}>
            {t.status.replace('_', ' ')}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'priority',
      header: 'Priority',
      width: 110,
      render: (t) =>
        t.priority ? (
          <Badge variant={TASK_PRIORITY_TONE[t.priority] ?? 'neutral'}>{t.priority}</Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'created_at',
      header: 'Created',
      width: 150,
      render: (t) => (
        <Text variant="label" tone="faint">
          {formatRelative(t.created_at)}
        </Text>
      ),
    },
  ];
  return <DataTable columns={columns} data={tasks} rowKey={(t) => t.id} />;
};

/* ----------------------------------------------------------------- Decisions */

export const DecisionsPanel: React.FC<{ decisions: DecisionRow[] }> = ({ decisions }) => {
  if (decisions.length === 0) {
    return (
      <div className={styles.tabState}>
        <Empty title="No decisions" description="No decisions were recorded in this session." />
      </div>
    );
  }
  return (
    <div className={styles.decRows}>
      {decisions.map((d) => (
        <div key={d.id} className={styles.decRow}>
          <div className={styles.decTitle}>{d.title}</div>
          {d.description && <div className={styles.decDesc}>{d.description}</div>}
          <div className={styles.decMeta}>
            {d.decision_type && (
              <Badge variant="violet" className={styles.kindtag}>
                {d.decision_type}
              </Badge>
            )}
            {d.status && <Badge variant={decisionStatusTone(d.status)}>{d.status}</Badge>}
            {d.impact_level && (
              <Badge variant={decisionImpactTone(d.impact_level)}>impact: {d.impact_level}</Badge>
            )}
            <span className={styles.decTime}>· {formatRelative(d.created_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

/* --------------------------------------------------------------------- Files */

export const FilesPanel: React.FC<{
  files: SessionFile[];
  loading: boolean;
  isError: boolean;
  error: unknown;
}> = ({ files, loading, isError, error }) => {
  if (loading) {
    return (
      <div className={styles.tabState}>
        <Spinner size="md" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={styles.tabState}>
        <Alert variant="error" title="Couldn't load files">
          {apiErrorMessage(error, 'Failed to load session files.')}
        </Alert>
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className={styles.tabState}>
        <Empty title="No files" description="No files were tracked as modified in this session." />
      </div>
    );
  }

  const totalAdded = files.reduce((s, f) => s + (f.lines_added ?? 0), 0);
  const totalDeleted = files.reduce((s, f) => s + (f.lines_deleted ?? 0), 0);

  const columns: Column<SessionFile>[] = [
    {
      key: 'file_path',
      header: 'File path',
      render: (f) => <Code>{f.file_path}</Code>,
    },
    {
      key: 'lines_added',
      header: 'Added',
      align: 'right',
      width: 100,
      render: (f) => <span className={styles.add}>+{f.lines_added ?? 0}</span>,
    },
    {
      key: 'lines_deleted',
      header: 'Deleted',
      align: 'right',
      width: 100,
      render: (f) => <span className={styles.del}>-{f.lines_deleted ?? 0}</span>,
    },
    {
      key: 'source',
      header: 'Source',
      width: 100,
      render: (f) =>
        f.source ? <Badge variant={FILE_SOURCE_TONE[f.source] ?? 'neutral'}>{f.source}</Badge> : '—',
    },
    {
      key: 'last_modified_at',
      header: 'Modified',
      width: 140,
      render: (f) => (
        <Text variant="label" tone="faint">
          {formatRelative(f.last_modified_at)}
        </Text>
      ),
    },
  ];

  return (
    <>
      <DataTable columns={columns} data={files} rowKey={(f) => f.id} />
      <div className={styles.filesTotal}>
        <span>
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <span>
          <span className={styles.add}>+{totalAdded.toLocaleString()}</span>{' '}
          <span className={styles.del}>-{totalDeleted.toLocaleString()}</span> net{' '}
          <b>
            {totalAdded - totalDeleted >= 0 ? '+' : ''}
            {(totalAdded - totalDeleted).toLocaleString()}
          </b>
        </span>
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ Timeline */

export const TimelinePanel: React.FC<{ detail: SessionDetailView }> = ({ detail }) => {
  const [showAll, setShowAll] = React.useState(false);
  const events = buildTimeline(detail);

  if (events.length === 0) {
    return (
      <div className={styles.tabState}>
        <Empty
          title="No activity"
          description="No contexts, decisions, tasks, or commits recorded in this session yet."
        />
      </div>
    );
  }

  const shown = showAll ? events : events.slice(0, SESSION_DETAIL_CONFIG.timelineInitialCount);

  return (
    <>
      <div className={styles.timeline}>
        {shown.map((ev) => (
          <div key={ev.key} className={styles.tlItem}>
            <span className={styles.tlTime}>{formatRelative(ev.at)}</span>
            <span className={styles.tlRail}>
              <span className={styles.tlNode} aria-hidden="true" />
            </span>
            <span className={styles.tlMain}>
              <span className={styles.tlHead}>
                <Badge variant={KIND_TONE[ev.kind]}>{ev.kind}</Badge>
                {ev.sub && (
                  <Text variant="label" tone="faint">
                    {ev.sub}
                  </Text>
                )}
                <TimelineRecordId event={ev} className={styles.tlSub} />
              </span>
              <span className={styles.tlTitle}>{firstLine(markdownExcerpt(ev.title, 200), 200)}</span>
            </span>
          </div>
        ))}
      </div>
      {events.length > SESSION_DETAIL_CONFIG.timelineInitialCount && (
        <button type="button" className={styles.moreLink} onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? 'Show fewer'
            : `Show ${events.length - SESSION_DETAIL_CONFIG.timelineInitialCount} earlier events`}
        </button>
      )}
    </>
  );
};

/** Small helper: a real count for a tab label, hidden when zero-unknown. */
export function tabCount(n: number | undefined): string {
  return formatCount(n);
}
