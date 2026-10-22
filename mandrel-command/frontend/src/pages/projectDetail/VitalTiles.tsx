/**
 * VitalTiles — the row of vital-sign tiles (contexts / tasks / decisions / sessions /
 * commits), all from REAL fields:
 *   - contexts  → the project record's context_count;
 *   - tasks     → insights.tasks.total (with the completion % as the caption);
 *   - decisions → insights.decisions.total;
 *   - sessions  → the project record's session_count;
 *   - commits   → insights.git_activity.total_commits.
 * Insights-backed tiles show a Skeleton while loading and an honest em-dash on error —
 * never a fabricated 0.
 */
import React from 'react';
import { Skeleton } from '../../components/ui';
import type { ProjectEntity } from '../../api/generated';
import type { ProjectDetailInsights } from './hooks';
import { VITAL_TILES, type VitalKey } from './config';
import { fmtCount } from './parts';
import {
  ContextsIcon,
  TasksIcon,
  DecisionsIcon,
  SessionsIcon,
  CommitIcon,
  type IconProps,
} from './icons';
import styles from './ProjectDetail.module.css';

const ICONS: Record<VitalKey, React.FC<IconProps>> = {
  contexts: ContextsIcon,
  tasks: TasksIcon,
  decisions: DecisionsIcon,
  sessions: SessionsIcon,
  commits: CommitIcon,
};

export interface VitalTilesProps {
  project: ProjectEntity;
  insights: ProjectDetailInsights | undefined;
  insightsLoading: boolean;
  insightsError: boolean;
}

interface Cell {
  value: number | undefined;
  caption?: string;
  /** Whether this tile's value comes from the insights read (governs loading/error UI). */
  fromInsights: boolean;
}

export const VitalTiles: React.FC<VitalTilesProps> = ({
  project,
  insights,
  insightsLoading,
  insightsError,
}) => {
  const tasks = insights?.tasks;
  const cellFor = (key: VitalKey): Cell => {
    switch (key) {
      case 'contexts':
        return { value: project.context_count, fromInsights: false };
      case 'tasks': {
        const done = tasks?.completed;
        const total = tasks?.total;
        const pct = tasks?.completion_percentage;
        const caption =
          total != null && done != null
            ? `${done.toLocaleString()} / ${total.toLocaleString()} done${
                pct != null ? ` · ${pct}%` : ''
              }`
            : undefined;
        return { value: total, caption, fromInsights: true };
      }
      case 'decisions':
        return { value: insights?.decisions?.total, fromInsights: true };
      case 'sessions':
        return { value: project.session_count, fromInsights: false };
      case 'commits':
        return { value: insights?.git_activity?.total_commits, fromInsights: true };
      default:
        return { value: undefined, fromInsights: false };
    }
  };

  return (
    <div className={styles.vitals}>
      {VITAL_TILES.map((tile) => {
        const Icon = ICONS[tile.key];
        const cell = cellFor(tile.key);
        const loading = cell.fromInsights && insightsLoading;
        const error = cell.fromInsights && insightsError;
        return (
          <div
            key={tile.key}
            className={tile.accent ? `${styles.vt} ${styles.vtAccent}` : styles.vt}
          >
            <div className={styles.vk}>
              <Icon size={13} className={styles.vkIco} />
              {tile.label}
            </div>
            <div className={styles.vv} style={{ color: `var(${tile.colorVar})` }}>
              {loading ? (
                <Skeleton width={40} height={22} />
              ) : error ? (
                <span className={styles.vDash} aria-label={`${tile.label} unavailable`}>
                  —
                </span>
              ) : (
                fmtCount(cell.value)
              )}
            </div>
            <div className={styles.vd}>{!loading && !error ? cell.caption ?? ' ' : ' '}</div>
          </div>
        );
      })}
    </div>
  );
};

export default VitalTiles;
