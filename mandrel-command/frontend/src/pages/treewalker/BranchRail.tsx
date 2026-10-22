/**
 * BranchRail — the RESUME SURFACE (PHASE 2 item c, a4f8886d): DRAWERS only
 * (P2), newest-active first. "Come back two days later,
 * click to re-anchor": clicking a branch re-anchors the walk on its spine.
 *
 * TOP-LEVEL ONLY (P2): a branch whose spine is itself a member of
 * another branch is a SECTION, not a drawer — it is reachable by drilling into its
 * parent (P3, not this punch) and does not compete for a rail slot here. As of an earlier task
 * the backend (`treewalkerTiers.ts`) already excludes sections from the query
 * BEFORE applying the branch-list cap, so `isTopLevel` is always true on every branch
 * this rail receives — the `.filter` below is defense-in-depth against a future/other
 * caller of this component, never trust in an upstream filter it cannot see.
 *
 * NAMING: a named branch shows its once-on-the-spine `branch:<name>` tag, chosen by hand
 * and trusted to be short, in full. An unnamed one falls back to the spine's own title,
 * which carries no such guarantee, so it is truncated (`truncateTitle`,
 * `TREEWALKER_CONFIG.branchTitleMaxChars`) before it reaches the DOM.
 *
 * HONEST COUNT: the rail states what it is not showing rather than let a capped page
 * pass as the whole set — how many drawers are ON SCREEN against `total`, the true
 * DRAWER count for the scope (an earlier task — sections are no longer mixed into this
 * number; see treewalkerTiers.ts). The line never claims a number the payload cannot
 * support: it says "drawers" on both sides of "of", never "branches" for a total that
 * (before this fix) silently included sections too. This count line renders on EVERY
 * non-loading, non-empty path — including the all-sections path below, which used to
 * return early and say nothing about the count at all.
 *
 * TWO distinct empty states, not one collapsed into the other:
 *   - no branches at all → the pre-existing explanation (a project with no declared
 *     members shows this, never fabricated branches) — PLUS the count line whenever
 *     `total > 0` (CLAUSE 5). This path used to return before the count
 *     line existed, so zero rows against a non-zero total rendered a flat "no branches
 *     yet" — the rail claiming nothing exists while its own payload said otherwise. At
 *     `total === 0` the line is withheld: it would only restate the sentence above it.
 *   - branches exist on this page but NONE are top-level (every one filtered out as a
 *     section) — unreachable via the real backend since an earlier task (it only ever
 *     serves drawers), kept as a defensive rendering path for a props shape this
 *     component cannot otherwise validate → a distinct honest note, so "nothing to
 *     show" is never confused with "nothing exists" — plus the same count line, so this
 *     path is never the one place the rail goes silent about what it isn't showing.
 */
import React from 'react';
import { cx } from '../../components/ui';
import type { BranchSummary } from '../../api/domains/treewalker';
import { id8, truncateTitle } from './parts';
import { TREEWALKER_CONFIG } from './config';
import styles from './TreeWalker.module.css';

export interface BranchRailProps {
  /** The (possibly capped) drawer page as served (an earlier task — sections already
   *  excluded server-side before the cap). */
  branches: BranchSummary[] | undefined;
  /** True DRAWER count for the scope (sections excluded), pre-cap. Undefined while loading. */
  total: number | undefined;
  /** The cap actually applied to `branches.length`. Undefined while loading. */
  cap: number | undefined;
  isLoading: boolean;
  /** The spine currently walked (highlighted). */
  activeSpineId: string | null;
  onSelect: (spineId: string) => void;
}

export const BranchRail: React.FC<BranchRailProps> = ({
  branches,
  total,
  cap,
  isLoading,
  activeSpineId,
  onSelect,
}) => {
  if (isLoading) {
    return (
      <div className={styles.branches} data-testid="tw-branches">
        <span className={styles.branchesNote}>loading branches…</span>
      </div>
    );
  }
  const drawers = branches ? branches.filter((b) => b.isTopLevel) : [];

  const countLine = total != null && (
    <span className={styles.branchesNote} data-testid="tw-branches-count">
      {drawers.length} drawer{drawers.length === 1 ? '' : 's'} shown of {total} drawer
      {total === 1 ? '' : 's'} in this project
      {cap != null && total > cap ? ` (page capped at ${cap})` : ''}
    </span>
  );

  // CLAUSE 5: the EMPTY page is not exempt from the count line. This
  // path used to return before `countLine` was even computed, so a payload with zero rows
  // and a non-zero total said "no branches yet" and nothing else — the one shape where the
  // rail asserts that nothing exists while the server is telling it something does. The
  // line is withheld only for total === 0, where "0 drawers shown of 0 drawers" would add
  // nothing to the sentence above it.
  if (!branches || branches.length === 0) {
    return (
      <div className={styles.branches} data-testid="tw-branches">
        <span className={styles.branchesNote}>
          no branches yet — records written while standing on a branch (branch_open) appear here
        </span>
        {total != null && total > 0 ? countLine : null}
      </div>
    );
  }

  if (drawers.length === 0) {
    return (
      <div className={styles.branches} data-testid="tw-branches">
        <span className={styles.branchesNote} data-testid="tw-branches-filtered-note">
          {branches.length} branch{branches.length === 1 ? '' : 'es'} on this page, but none
          are top-level drawers — all {branches.length === 1 ? 'is' : 'are'} nested sections of
          another branch
        </span>
        {countLine}
      </div>
    );
  }

  return (
    <div className={styles.branches} data-testid="tw-branches">
      {drawers.map((b) => (
        <button
          key={b.spineId}
          type="button"
          className={cx(styles.branchItem, b.spineId === activeSpineId && styles.branchItemActive)}
          onClick={() => onSelect(b.spineId)}
          title={`${b.name} · ${b.spineType} ${id8(b.spineId)} · ${b.members} member${b.members === 1 ? '' : 's'}`}
        >
          {b.open && <span className={styles.branchOpenDot} aria-label="open position" />}
          <span className={styles.branchName}>
            {b.named ? b.name : truncateTitle(b.name, TREEWALKER_CONFIG.branchTitleMaxChars)}
          </span>
          <span className={styles.branchMeta}>{b.members}</span>
        </button>
      ))}
      {countLine}
    </div>
  );
};

export default BranchRail;
