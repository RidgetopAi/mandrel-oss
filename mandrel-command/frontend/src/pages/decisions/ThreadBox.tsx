/**
 * ThreadBox — the moat, surfaced: the reader footer's typed-edge box ("What this decision
 * shaped"). Renders REAL `links`-table edges (api.decisions.links) as the mock's rows — an
 * edge label ("decided ←" / "caused →" / "builds on ←"), the target's kind dot, its title,
 * and its id8 as a live /r/:id link. Owns its loading / empty / error state.
 *
 * DATA-GAP POLICY: these are the TYPED graph edges ONLY — never a semantic list
 * dressed up as thread edges. When a decision has no typed edges we show an honest empty
 * state, not a fabricated thread. "Walk the story" is a clearly-inert follow-up affordance.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Spinner, Alert, cx } from '../../components/ui';
import { DecisionIcon, ChevronRight } from './icons';
import { edgeLabel, kindDotVar } from './config';
import { id8 } from './parts';
import { buildNavHref } from '../../utils/navIdLinkify';
import type { RecordLink } from '../../types/recordLink';
import styles from './Decisions.module.css';
import { apiErrorMessage } from '../../api/request';

export interface ThreadBoxProps {
  links: RecordLink[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

const EdgeRow: React.FC<{ link: RecordLink }> = ({ link }) => (
  <Link className={styles.link} to={buildNavHref(link.otherId)}>
    <span className={styles.edge}>
      {edgeLabel(link.edgeType, link.direction)} {link.direction === 'incoming' ? '←' : '→'}
    </span>
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
        <DecisionIcon size={15} className={styles.threadIco} />
        <span>What this decision shaped</span>
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
          No typed edges yet — this decision isn&apos;t threaded to any context, task, or
          other decision.
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
