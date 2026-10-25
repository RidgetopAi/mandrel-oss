/**
 * BuildStory — the TYPED graph edges touching a task (the TreeWalker "build story" moat),
 * served by GET /api/tasks/:id/links (`useTaskLinks` → `api.tasks.links`). REAL `links`-table
 * rows (structure), NEVER the task's `dependencies` array or any semantic `related` list
 * (the data-gap policy — never conflate). Honest empty / loading / error states.
 *
 * Extracted from the old below-board ThreadDetail so the task CRUD drawer reuses the exact
 * same links rendering when a task is selected — the build story moved INTO the drawer, not
 * lost. Rendered as the "came from / produced" story for the selected task.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Spinner, Alert, cx } from '../../components/ui';
import { BranchIcon, ChevronRight } from './icons';
import { edgeLabel, kindDotVar } from './config';
import { id8 } from './parts';
import { buildNavHref } from '../../utils/navIdLinkify';
import type { TaskLink } from '../../types/task';
import styles from './Tasks.module.css';
import { apiErrorMessage } from '../../api/request';

const EdgeRow: React.FC<{ link: TaskLink }> = ({ link }) => (
  <Link className={styles.edge} to={buildNavHref(link.otherId)}>
    <span className={styles.edgeGutter} aria-hidden="true">
      <span className={styles.edgeNode} style={{ background: `var(${kindDotVar(link.otherKind)})` }} />
    </span>
    <span className={styles.edgeContent}>
      <span className={styles.edgeType}>{edgeLabel(link.edgeType, link.direction)}</span>
      <span className={styles.edgeRow}>
        <span className={styles.edgeKind}>{link.otherType}</span>
        <span className={styles.edgeTitle}>{link.otherTitle}</span>
        <span className={styles.edgeId}>{id8(link.otherId)}</span>
      </span>
    </span>
  </Link>
);

export interface BuildStoryProps {
  links: TaskLink[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

export const BuildStory: React.FC<BuildStoryProps> = ({ links, isLoading, isError, error }) => {
  const count = links?.length ?? 0;
  return (
    <div>
      <div className={styles.storyH}>
        <BranchIcon size={15} />
        Build story
        {count > 0 && <span className={styles.storyCount}>{count}</span>}
        <span
          className={cx(styles.walk, count === 0 && styles.walkDisabled)}
          title="Walk the thread (follow-up)"
          aria-disabled={count === 0}
        >
          Walk the thread <ChevronRight size={13} />
        </span>
      </div>

      {isLoading ? (
        <div className={styles.storyState}>
          <Spinner size="sm" />
        </div>
      ) : isError ? (
        <Alert variant="error" title="Couldn't load the thread">
          {apiErrorMessage(error, 'Failed to load typed edges.')}
        </Alert>
      ) : count === 0 ? (
        <p className={styles.storyEmpty}>
          No typed edges yet — this task isn&apos;t threaded to any decision, context, or
          other task.
        </p>
      ) : (
        <div className={styles.edges}>
          {links!.map((l) => (
            <EdgeRow key={`${l.edgeType}-${l.direction}-${l.otherId}`} link={l} />
          ))}
        </div>
      )}
    </div>
  );
};

export default BuildStory;
