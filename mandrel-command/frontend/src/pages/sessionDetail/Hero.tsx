/**
 * Hero — the session header: the pulse icon, the session title (or "Session <id8>"),
 * the full id, the live/dormant/ended status pill, an optional goal, tags, and a meta
 * grid (project · AI model · git branch · commit · created · last activity). Every
 * field is REAL from the session detail; a missing field shows an honest placeholder,
 * never a fabricated value. Presentational only.
 */
import React from 'react';
import { StatusPill, Badge, Code } from '../../components/ui';
import type { SessionDetailView } from './hooks';
import { id8, formatDate, formatRelative, deriveSessionStatus, statusPillTone } from './parts';
import {
  SessionIcon,
  ProjectIcon,
  ModelIcon,
  BranchIcon,
  ClockIcon,
} from './icons';
import styles from './SessionDetail.module.css';

const STATUS_LABEL = { live: 'live', dormant: 'dormant', ended: 'ended' } as const;

const MetaItem: React.FC<{
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, icon, children }) => (
  <div className={styles.metaItem}>
    <div className={styles.metaK}>{label}</div>
    <div className={styles.metaV}>
      {icon && <span className={styles.metaVIco}>{icon}</span>}
      <span className={styles.metaVText}>{children}</span>
    </div>
  </div>
);

export interface HeroProps {
  session: SessionDetailView;
}

export const Hero: React.FC<HeroProps> = ({ session }) => {
  const status = deriveSessionStatus(session);
  const title = session.title || `Session ${id8(session.id ?? '')}`;
  const shortSha = session.working_commit_sha
    ? `${session.working_commit_sha.slice(0, 8)}…`
    : 'not tracked';
  const created = session.started_at ?? session.created_at;
  const lastActivity = session.last_activity_at ?? session.last_context_at;

  return (
    <header>
      <div className={styles.hero}>
        <div className={styles.sicon} aria-hidden="true">
          <SessionIcon size={23} />
        </div>
        <div className={styles.hbody}>
          <div className={styles.h1r}>
            <h1 className={styles.hname}>{title}</h1>
            <StatusPill tone={statusPillTone(status)}>{STATUS_LABEL[status]}</StatusPill>
          </div>
          {session.id && <div className={styles.hid}>{session.id}</div>}
          {session.session_goal && <p className={styles.hgoal}>{session.session_goal}</p>}
          {session.tags && session.tags.length > 0 && (
            <div className={styles.htags}>
              {session.tags.map((tag) => (
                <Badge key={tag} variant="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.meta} style={{ marginTop: 'var(--sp-4)' }}>
        <MetaItem label="Project" icon={<ProjectIcon size={14} />}>
          {session.project_name || 'Unassigned'}
        </MetaItem>
        <MetaItem label="AI model" icon={<ModelIcon size={14} />}>
          {session.ai_model || 'not specified'}
        </MetaItem>
        <MetaItem label="Git branch" icon={<BranchIcon size={14} />}>
          {session.active_branch ? <Code>{session.active_branch}</Code> : 'not tracked'}
        </MetaItem>
        <MetaItem label="Commit" icon={<BranchIcon size={14} />}>
          <Code>{shortSha}</Code>
        </MetaItem>
        <MetaItem label="Created" icon={<ClockIcon size={14} />}>
          {formatDate(created)}
        </MetaItem>
        <MetaItem label="Last activity" icon={<ClockIcon size={14} />}>
          {lastActivity ? formatRelative(lastActivity) : 'no activity'}
        </MetaItem>
      </div>
    </header>
  );
};

export default Hero;
