/**
 * StoryRail — the RIGHT panel: the recall_thread-ordered walk of the thread. A trust bar
 * summarising proven/soaking/unproven/stale counts, a "Walk the story" play control, the
 * ordered steps (each with its relation caption, title, kind tag, trust pill + short id on a
 * threaded spindle), and a footer that opens the full thread in the reader. When no story is
 * loaded it shows an honest empty state — never a fabricated walk.
 */
import React from 'react';
import { cx, Empty } from '../../components/ui';
import type { ThreadGraph } from '../../api/domains/treewalker';
import { kindLabel, trustLabel } from './config';
import { id8, trustCounts, trustTotal } from './parts';
import { StoryIcon, PlayIcon, ArrowIcon } from './icons';
import styles from './TreeWalker.module.css';

export interface StoryRailProps {
  graph: ThreadGraph | undefined;
  unavailable: boolean;
  isLoading: boolean;
  activeStepId: string | null;
  onStepClick: (id: string) => void;
  onWalk: () => void;
}

export const StoryRail: React.FC<StoryRailProps> = ({
  graph,
  unavailable,
  isLoading,
  activeStepId,
  onStepClick,
  onWalk,
}) => {
  const story = graph?.story ?? [];
  const counts = trustCounts(graph?.nodes);
  const total = trustTotal(counts);
  const hasStory = story.length > 0;

  return (
    <div className={styles.rail} data-testid="tw-story">
      <div className={styles.card}>
        <div className={styles.storyHead}>
          <div className={styles.storyH1}>
            <StoryIcon size={15} className={styles.storyHeadIco} />
            <b>The story</b>
            <span className={styles.storyCount}>
              recall_thread · {story.length} step{story.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className={styles.storySub}>
            Read yourself into the thread — in the order it happened, with a trust read on each
            record.
          </div>

          {total > 0 && (
            <>
              <div className={styles.trustbar} data-testid="tw-trustbar">
                {counts.map((c) => (
                  <span
                    key={c.trust}
                    className={cx(styles.seg, styles[`seg-${c.trust}`])}
                    style={{ flexGrow: c.count }}
                    title={`${c.count} ${trustLabel(c.trust)}`}
                  />
                ))}
              </div>
              <div className={styles.trustkey}>
                {counts.map((c) => (
                  <span key={c.trust}>
                    <i className={cx(styles.trustKeyDot, styles[`trust-${c.trust}`])} />
                    {c.count} {trustLabel(c.trust)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {hasStory && (
          <button type="button" className={styles.walkbtn} onClick={onWalk}>
            <PlayIcon size={15} className={styles.walkIco} />
            Walk the story
          </button>
        )}

        {hasStory ? (
          <div className={styles.steps}>
            {story.map((step) => (
              <button
                type="button"
                key={step.id}
                className={cx(
                  styles.step,
                  styles[`step-${step.marker}`],
                  activeStepId === step.id && styles.stepOn,
                )}
                onClick={() => onStepClick(step.id)}
              >
                <span className={styles.spindle} aria-hidden="true">
                  <span className={styles.sq} />
                </span>
                <span className={styles.sbody}>
                  <span className={styles.srel}>
                    {step.relation}
                    {step.relationTerm && <span className={styles.rt}>{step.relationTerm}</span>}
                  </span>
                  <span className={styles.stitle}>{step.title}</span>
                  <span className={styles.smeta}>
                    <span className={cx(styles.kindtag, styles[`kindtag-${step.kind}`])}>
                      {kindLabel(step.kind)}
                    </span>
                    {step.trust && (
                      <span className={cx(styles.pill, styles[`pill-${step.trust}`])}>
                        <i className={cx(styles.pillDot, styles[`trust-${step.trust}`])} />
                        {trustLabel(step.trust)}
                      </span>
                    )}
                    <span className={styles.sid}>{id8(step.id)}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.storyEmpty}>
            <Empty
              title={
                isLoading
                  ? 'Loading the story…'
                  : unavailable
                    ? 'Story not yet available'
                    : 'No story steps yet'
              }
              description={
                isLoading
                  ? undefined
                  : unavailable
                    ? 'The recall_thread story endpoint isn’t wired yet.'
                    : 'This thread has no ordered steps to walk.'
              }
            />
          </div>
        )}

        <div className={styles.railfoot} role="button" tabIndex={0}>
          <ArrowIcon size={15} className={styles.railfootIco} />
          Open the full thread in the reader
        </div>
      </div>
    </div>
  );
};

export default StoryRail;
