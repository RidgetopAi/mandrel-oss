/**
 * ThreadBox — the moat, surfaced: the reader footer's typed-edge box. Renders REAL
 * `links`-table edges (api.contexts.links) as the mock's rows — an edge label
 * ("decided by →" / "informs →" / "supersedes →"), the target's kind dot, its title, and
 * its id8 as a live /r/:id link. Owns its loading / empty / error state.
 *
 * DATA-GAP POLICY: these are the TYPED graph edges ONLY — never semantic
 * `related` results dressed up as thread edges. When a context has no typed edges we show
 * an honest empty state, not a fabricated thread. "Walk the story" is a clearly-inert
 * follow-up affordance (no recall/thread route exists in this UI yet) — surfaced, not faked.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Spinner, Alert, cx } from '../../components/ui';
import { ThreadIcon, ChevronRight } from './icons';
import { edgeLabel, kindDotVar } from './config';
import { id8 } from './parts';
import { buildNavHref } from '../../utils/navIdLinkify';
import type { ContextLink } from '../../types/context';
import styles from './Contexts.module.css';
import { apiErrorMessage } from '../../api/request';

export interface ThreadBoxProps {
  links: ContextLink[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

const EdgeRow: React.FC<{ link: ContextLink }> = ({ link }) => (
  <Link className={styles.link} to={buildNavHref(link.otherId)}>
    <span className={styles.edge}>{edgeLabel(link.edgeType, link.direction)} →</span>
    <span
      className={styles.linkKind}
      style={{ background: `var(${kindDotVar(link.otherKind)})` }}
      aria-hidden="true"
    />
    <span className={styles.linkTitle}>{link.otherTitle}</span>
    <span className={styles.linkId}>{id8(link.otherId)}</span>
  </Link>
);

export const ThreadBox: React.FC<ThreadBoxProps> = ({ links, isLoading, isError, error }) => {
  const count = links?.length ?? 0;
  return (
    <div className={styles.threadBox}>
      <div className={styles.threadHead}>
        <ThreadIcon size={15} className={styles.threadIco} />
        <span>In thread</span>
        {count > 0 && <span className={styles.threadCount}>{count}</span>}
        <span
          className={cx(styles.walk, count === 0 && styles.walkDisabled)}
          title="Walk the story (follow-up)"
          aria-disabled={count === 0}
        >
          Walk the story <ChevronRight size={13} />
        </span>
      </div>

      {isLoading ? (
        <div className={styles.threadState}>
          <Spinner size="sm" />
        </div>
      ) : isError ? (
        <Alert variant="error" title="Couldn't load the thread">
          {apiErrorMessage(error, 'Failed to load typed edges.')}
        </Alert>
      ) : count === 0 ? (
        <p className={styles.threadEmpty}>
          No typed edges yet — this context isn&apos;t threaded to any decision, task, or
          other context.
        </p>
      ) : (
        <div className={styles.links}>
          {links!.map((l) => (
            <EdgeRow key={`${l.edgeType}-${l.direction}-${l.otherId}`} link={l} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ThreadBox;
