/**
 * SessionsCard — the project's recent sessions from `api.projects.sessions` (REAL:
 * context-based sessions carrying a context count + first/last activity). Owns its own
 * loading / empty / error state.
 *
 * DATA GAP (policy): `api.projects.sessions` does NOT serve per-session token
 * counts, actor identity, or a live/ended flag, so the mock's "N tok" + live pulse +
 * actor avatars are NOT rendered — each row shows the session's REAL context count and
 * relative activity time only. The substitution is disclosed via the header Tooltip
 * (SESSIONS_GAP_NOTE).
 */
import React from 'react';
import { Card, CardHeader, Spinner, Empty, Alert, Tooltip } from '../../components/ui';
import type { ProjectSession } from './hooks';
import { SESSIONS_GAP_NOTE, PROJECT_DETAIL_CONFIG } from './config';
import { formatRelative, id8 } from './parts';
import { SessionsIcon } from './icons';
import styles from './ProjectDetail.module.css';
import { apiErrorMessage } from '../../api/request';

export interface SessionsCardProps {
  sessions: ProjectSession[] | undefined;
  loading: boolean;
  isError: boolean;
  error: unknown;
}

export const SessionsCard: React.FC<SessionsCardProps> = ({
  sessions,
  loading,
  isError,
  error,
}) => {
  const rows = (sessions ?? []).slice(0, PROJECT_DETAIL_CONFIG.sessionsShown);

  return (
    <Card>
      <CardHeader className={styles.ch}>
        <SessionsIcon size={15} className={styles.chIco} />
        <span>Recent sessions</span>
        <Tooltip label={SESSIONS_GAP_NOTE}>
          <span className={styles.chNote}>context-based</span>
        </Tooltip>
      </CardHeader>

      {loading ? (
        <div className={styles.sectionState}>
          <Spinner size="sm" />
        </div>
      ) : isError ? (
        <div className={styles.sectionState}>
          <Alert variant="error" title="Couldn't load sessions">
            {apiErrorMessage(error, 'Failed to load sessions.')}
          </Alert>
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.sectionState}>
          <Empty title="No sessions" description="No sessions recorded for this project yet." />
        </div>
      ) : (
        <div className={styles.srows}>
          {rows.map((s) => (
            <div key={s.id} className={styles.srow}>
              <span className={styles.sav} aria-hidden="true">
                <SessionsIcon size={13} />
              </span>
              <div className={styles.sbody}>
                <div className={styles.sn}>session {id8(s.id)}</div>
                <div className={styles.sm}>
                  {(s.context_count ?? 0).toLocaleString()} ctx
                </div>
              </div>
              <span className={styles.st}>
                {formatRelative(s.last_context_at ?? s.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

export default SessionsCard;
