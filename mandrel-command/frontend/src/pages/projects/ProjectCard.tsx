/**
 * ProjectCard — one portfolio card: the project's vital signs (contexts / tasks /
 * decisions), status, PRIMARY badge, and the honest "active work" footer.
 *
 * Data sources (ALL real, never fabricated):
 *  - contexts, last_activity, status, metadata.is_primary → the list row (instant);
 *  - tasks.total, decisions.total, tasks.in_progress → this card's own insights query
 *    (its own loading skeleton / error dash, so a slow insights read never blocks the grid).
 *
 * DATA GAP (policy 10397f65): the mock's per-project 30-day sparkline + literal "active
 * branches" are NOT served. The sparkline is omitted; the footer shows the REAL
 * in-progress-task count as the active-work signal, with a Tooltip explaining the
 * substitution — no fabricated branch names.
 */
import React from 'react';
import { Skeleton, StatusPill, Tooltip, cx } from '../../components/ui';
import type { ProjectEntity } from '../../api/generated';
import { useProjectInsights } from './hooks';
import { formatRelative } from './parts';
import { BranchIcon } from './icons';
import {
  STAT_COLORS,
  ACTIVE_WORK_GAP_NOTE,
  activeWorkLabel,
  isPrimaryProject,
  isProjectActive,
  projectDotVar,
  statusLabel,
  statusTone,
} from './config';
import styles from './Projects.module.css';

export interface ProjectCardProps {
  project: ProjectEntity;
  now: number;
  onOpen: (id: string) => void;
}

const Stat: React.FC<{
  colorVar: string;
  label: string;
  value: number | undefined;
  loading?: boolean;
  error?: boolean;
}> = ({ colorVar, label, value, loading, error }) => (
  <div className={styles.stat}>
    <div className={styles.statVal} style={{ color: `var(${colorVar})` }}>
      {loading ? (
        <Skeleton width={26} height={16} />
      ) : error ? (
        <span className={styles.statDash} aria-label={`${label} unavailable`}>
          —
        </span>
      ) : (
        (value ?? 0).toLocaleString()
      )}
    </div>
    <div className={styles.statKey}>
      <span className={styles.statKd} style={{ background: `var(${colorVar})` }} aria-hidden="true" />
      {label}
    </div>
  </div>
);

export const ProjectCard: React.FC<ProjectCardProps> = ({ project, now, onOpen }) => {
  const insights = useProjectInsights(project.id);
  const active = isProjectActive(project, now);
  const primary = isPrimaryProject(project);
  const dotVar = projectDotVar(project, active);

  const tasks = insights.data?.tasks?.total;
  const decisions = insights.data?.decisions?.total;
  const inProgress = insights.data?.tasks?.in_progress;
  const hasWork = Boolean(inProgress && inProgress > 0);

  return (
    <button
      type="button"
      className={cx(styles.card, primary && styles.cardPrimary)}
      onClick={() => onOpen(project.id)}
      aria-label={`Open project ${project.name}`}
    >
      <div className={styles.cardTop}>
        <span
          className={styles.dot}
          style={{
            background: `var(${dotVar})`,
            boxShadow: active ? `0 0 8px var(${dotVar})` : undefined,
          }}
          aria-hidden="true"
        />
        <span className={styles.name}>{project.name}</span>
        {primary && <span className={styles.primaryTag}>PRIMARY</span>}
        <StatusPill tone={statusTone(active)} className={styles.statusPill}>
          {statusLabel(active)}
        </StatusPill>
      </div>

      <p className={styles.desc}>{project.description || 'No description yet.'}</p>

      <div className={styles.stats}>
        <Stat colorVar={STAT_COLORS.contexts} label="contexts" value={project.context_count} />
        <Stat
          colorVar={STAT_COLORS.tasks}
          label="tasks"
          value={tasks}
          loading={insights.isLoading}
          error={insights.isError}
        />
        <Stat
          colorVar={STAT_COLORS.decisions}
          label="decisions"
          value={decisions}
          loading={insights.isLoading}
          error={insights.isError}
        />
      </div>

      <div className={styles.foot}>
        <Tooltip label={ACTIVE_WORK_GAP_NOTE}>
          <span className={styles.branches}>
            <BranchIcon
              size={15}
              className={cx(styles.branchIco, hasWork ? styles.branchOn : styles.branchOff)}
            />
            <span className={hasWork ? undefined : styles.branchMuted}>
              {insights.isLoading ? '…' : activeWorkLabel(inProgress)}
            </span>
          </span>
        </Tooltip>
        <span className={styles.last}>
          <span
            className={styles.lastDot}
            style={{ background: active ? 'var(--ok)' : 'var(--tx-4)' }}
            aria-hidden="true"
          />
          {formatRelative(project.last_activity)}
        </span>
      </div>
    </button>
  );
};

export default ProjectCard;
