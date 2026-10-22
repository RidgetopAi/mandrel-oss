/**
 * SpineRibbon — the top roots → tree → trunk → branch lineage strip (unique to TreeWalker).
 * Renders the thread's position on the tree spine; the branch tier is the active, emphasised
 * node. When no thread is loaded it renders a single honest placeholder tier, not a fake
 * lineage.
 */
import React from 'react';
import { cx } from '../../components/ui';
import type { SpineNode } from '../../api/domains/treewalker';
import styles from './TreeWalker.module.css';

export interface SpineRibbonProps {
  spine: SpineNode[] | undefined;
}

/**
 * tier → the CSS-module class that paints its node. The tier VOCABULARY is server-driven
 * (PHASE 2 — the backend derives tiers from data); unknown tiers render with the neutral
 * tree styling rather than breaking. Keys are unquoted names, not display strings.
 */
const TIER_CLASS: Record<string, string> = {
  root: 'sRoot',
  tree: 'sTree',
  trunk: 'sTrunk',
  branch: 'sBranch',
};
const tierClass = (tier: string): string => TIER_CLASS[tier] ?? 'sTree';

export const SpineRibbon: React.FC<SpineRibbonProps> = ({ spine }) => {
  const tiers = spine ?? [];
  if (tiers.length === 0) {
    return (
      <div className={styles.spine} data-testid="tw-spine">
        <span className={cx(styles.snode, styles.snodePlaceholder)}>
          <span className={styles.sd} />
          thread lineage appears here once a thread is loaded
        </span>
      </div>
    );
  }
  return (
    <div className={styles.spine} data-testid="tw-spine">
      {tiers.map((tier, i) => (
        <React.Fragment key={`${tier.tier}-${tier.label}`}>
          {i > 0 && (
            <span
              className={cx(styles.spineLink, tier.tier === 'branch' && styles.spineLinkGrow)}
              aria-hidden="true"
            />
          )}
          <span className={cx(styles.snode, styles[tierClass(tier.tier)])}>
            <span className={styles.sd} />
            {tier.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
};

export default SpineRibbon;
