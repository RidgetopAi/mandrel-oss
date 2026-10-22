/**
 * Toolbar — the anchor readout ("Walking <branch> · anchored on <id> · N records"), the
 * "Jump to trunk" pop-back, the "Only trusted" trust filter, and the Graph / Story view
 * toggle. Controls that need a loaded thread are disabled while the thread is unavailable so
 * the toolbar never implies data it doesn't have.
 */
import React from 'react';
import { cx } from '../../components/ui';
import type { ThreadAnchor } from '../../api/domains/treewalker';
import type { TreeWalkerView } from './config';
import { id8 } from './parts';
import { TrunkIcon, ClockIcon, GraphIcon, StoryIcon } from './icons';
import styles from './TreeWalker.module.css';

export interface ToolbarProps {
  anchor: ThreadAnchor | undefined;
  view: TreeWalkerView;
  onViewChange: (view: TreeWalkerView) => void;
  onlyProven: boolean;
  onToggleOnlyProven: () => void;
  onJumpToTrunk: () => void;
  disabled: boolean;
  /** Extra gate for the jump control only: no trunk head exists to jump to (no handoffs). */
  jumpDisabled?: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  anchor,
  view,
  onViewChange,
  onlyProven,
  onToggleOnlyProven,
  onJumpToTrunk,
  disabled,
  jumpDisabled = false,
}) => (
  <div className={styles.twbar}>
    <div className={styles.anchor} data-testid="tw-anchor">
      <span className={styles.anchorDot} aria-hidden="true" />
      {anchor ? (
        <>
          Walking&nbsp;<b>{anchor.branchLabel}</b>
          <span className={styles.anchorMeta}>
            · anchored on {id8(anchor.anchorId)} · {anchor.recordCount} records
          </span>
        </>
      ) : (
        <span className={styles.anchorMeta}>No thread loaded</span>
      )}
    </div>

    <button
      type="button"
      className={styles.btn}
      onClick={onJumpToTrunk}
      disabled={disabled || jumpDisabled}
    >
      <TrunkIcon size={15} />
      Jump to trunk
    </button>

    <button
      type="button"
      className={cx(styles.btn, onlyProven && styles.btnActive)}
      onClick={onToggleOnlyProven}
      disabled={disabled}
      aria-pressed={onlyProven}
    >
      <ClockIcon size={15} />
      Only trusted
    </button>

    <div className={styles.vtoggle} role="group" aria-label="View">
      <button
        type="button"
        className={cx(styles.vtoggleItem, view === 'graph' && styles.vtoggleOn)}
        onClick={() => onViewChange('graph')}
        aria-pressed={view === 'graph'}
      >
        <GraphIcon size={15} />
        Graph
      </button>
      <button
        type="button"
        className={cx(styles.vtoggleItem, view === 'story' && styles.vtoggleOn)}
        onClick={() => onViewChange('story')}
        aria-pressed={view === 'story'}
      >
        <StoryIcon size={15} />
        Story
      </button>
    </div>
  </div>
);

export default Toolbar;
