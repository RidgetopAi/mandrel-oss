/**
 * RepoActivityCard — the REAL repository-activity signal from insights.git_activity
 * (commits, code churn, files changed, and the latest commit subject). This card stands
 * in for the mock's "active branches → TreeWalker" card, whose per-branch telemetry is
 * NOT served (policy 10397f65): rather than fabricate branch names we surface the git
 * activity we DO have, and disclose the substitution on-screen (BRANCH_GAP_NOTE).
 *
 * When no commits are indexed for the project, the card shows an honest empty state
 * instead of a wall of zeros.
 */
import React from 'react';
import { Card, CardHeader, Spinner, Empty, Tooltip } from '../../components/ui';
import type { ProjectDetailInsights } from './hooks';
import { BRANCH_GAP_NOTE } from './config';
import { fmtChurn, commitSubject, formatRelative, fmtCount } from './parts';
import { CommitIcon } from './icons';
import styles from './ProjectDetail.module.css';

export interface RepoActivityCardProps {
  insights: ProjectDetailInsights | undefined;
  loading: boolean;
  error: boolean;
}

export const RepoActivityCard: React.FC<RepoActivityCardProps> = ({
  insights,
  loading,
  error,
}) => {
  const git = insights?.git_activity;
  const commits = git?.total_commits ?? 0;

  return (
    <Card>
      <CardHeader className={styles.ch}>
        <CommitIcon size={15} className={styles.chIco} />
        <span>Repository activity</span>
        <Tooltip label={BRANCH_GAP_NOTE}>
          <span className={styles.chNote}>git · not branches</span>
        </Tooltip>
      </CardHeader>

      {loading ? (
        <div className={styles.sectionState}>
          <Spinner size="sm" />
        </div>
      ) : error ? (
        <div className={styles.boardEmpty}>Repository activity unavailable.</div>
      ) : commits === 0 ? (
        <div className={styles.sectionState}>
          <Empty
            title="No indexed commits"
            description="No git activity has been indexed for this project yet."
          />
        </div>
      ) : (
        <div className={styles.repoBody}>
          <div className={styles.repoStats}>
            <div className={styles.repoStat}>
              <div className={styles.repoV}>{fmtCount(git?.total_commits)}</div>
              <div className={styles.repoK}>commits</div>
            </div>
            <div className={styles.repoStat}>
              <div className={styles.repoV}>{fmtChurn(git?.total_insertions, git?.total_deletions)}</div>
              <div className={styles.repoK}>churn</div>
            </div>
            <div className={styles.repoStat}>
              <div className={styles.repoV}>{fmtCount(git?.files_changed)}</div>
              <div className={styles.repoK}>files changed</div>
            </div>
          </div>
          {git?.latest_commit_message && (
            <div className={styles.repoLatest}>
              <div className={styles.repoLatestMsg}>{commitSubject(git.latest_commit_message)}</div>
              <div className={styles.repoLatestMeta}>
                latest · {formatRelative(git.latest_commit_date)}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};

export default RepoActivityCard;
