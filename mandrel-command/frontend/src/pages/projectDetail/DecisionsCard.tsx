/**
 * DecisionsCard — the project's recent decisions from `api.decisions.search` scoped by
 * project_id (an EXISTING endpoint). Each row shows the real title, decision_type tag,
 * and the id8 as a live `/r/:id` resolve-link (consistent with the other screens). Owns
 * its own loading / empty / error state.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, Spinner, Empty, Alert, Badge } from '../../components/ui';
import type { Decision } from '../../types/decision';
import { buildNavHref } from '../../utils/navIdLinkify';
import { formatRelative, id8 } from './parts';
import { DecisionsIcon } from './icons';
import styles from './ProjectDetail.module.css';
import { apiErrorMessage } from '../../api/request';

export interface DecisionsCardProps {
  decisions: Decision[] | undefined;
  loading: boolean;
  isError: boolean;
  error: unknown;
}

export const DecisionsCard: React.FC<DecisionsCardProps> = ({
  decisions,
  loading,
  isError,
  error,
}) => {
  const rows = decisions ?? [];

  return (
    <Card>
      <CardHeader className={styles.ch}>
        <DecisionsIcon size={15} className={styles.chIco} />
        <span>Recent decisions</span>
      </CardHeader>

      {loading ? (
        <div className={styles.sectionState}>
          <Spinner size="sm" />
        </div>
      ) : isError ? (
        <div className={styles.sectionState}>
          <Alert variant="error" title="Couldn't load decisions">
            {apiErrorMessage(error, 'Failed to load decisions.')}
          </Alert>
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.sectionState}>
          <Empty title="No decisions" description="No decisions recorded for this project yet." />
        </div>
      ) : (
        <div className={styles.drows}>
          {rows.map((d) => (
            <div key={d.id} className={styles.drow}>
              <div className={styles.dt}>{d.title}</div>
              <div className={styles.dm}>
                {d.decision_type && (
                  <Badge variant="blue" className={styles.kindtag}>
                    {d.decision_type}
                  </Badge>
                )}
                <Link className={styles.did} to={buildNavHref(d.id)}>
                  {id8(d.id)}
                </Link>
                <span className={styles.dtime}>· {formatRelative(d.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

export default DecisionsCard;
