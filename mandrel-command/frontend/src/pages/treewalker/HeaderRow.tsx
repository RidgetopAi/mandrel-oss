/**
 * HeaderRow — the one compact row above the tabs: the TreeWalker title and project, a branch
 * selector over the served branch list (name + member count, "N of M" when the page is capped,
 * choosing one re-anchors the walk) and the Jump to trunk / Only trusted controls. It wraps on
 * a narrow screen. Colour is token-only.
 */
import React from 'react';
import { cx } from '../../components/ui';
import type { BranchSummary } from '../../api/domains/treewalker';
import { truncateTitle } from './parts';
import { HEADER_CONFIG as H, TREEWALKER_CONFIG } from './config';
import { TreeIcon, TrunkIcon, ClockIcon } from './icons';
import styles from './TreeWalker.module.css';

export interface HeaderRowProps {
  projectName: string | undefined;
  /** The (possibly capped) branch page as served. */
  branches: BranchSummary[] | undefined;
  /** True branch count for the scope, pre-cap. Undefined while loading. */
  total: number | undefined;
  isLoading: boolean;
  /** The spine currently walked, when the URL names one. */
  anchorId: string | null;
  /** Label of the walked branch, for when the anchor is not in the list. */
  currentLabel: string | undefined;
  onSelectBranch: (spineId: string) => void;
  onlyProven: boolean;
  onToggleOnlyProven: () => void;
  onJumpToTrunk: () => void;
  /** No thread loaded: the controls that need one are inert. */
  disabled: boolean;
  /** Extra gate for the jump control only: no trunk head exists to jump to. */
  jumpDisabled: boolean;
}

export const HeaderRow: React.FC<HeaderRowProps> = ({
  projectName,
  branches,
  total,
  isLoading,
  anchorId,
  currentLabel,
  onSelectBranch,
  onlyProven,
  onToggleOnlyProven,
  onJumpToTrunk,
  disabled,
  jumpDisabled,
}) => {
  const list = branches ?? [];
  const selected = list.some((b) => b.spineId === anchorId) ? (anchorId as string) : '';
  const capped = total != null && total > list.length;
  const placeholder = isLoading ? H.loadingOption : list.length === 0 ? H.noBranchesOption : currentLabel ?? H.currentOption;
  return (
    <div className={styles.headerRow} data-testid="tw-header">
      <div className={styles.headTitle}>
        <TreeIcon size={18} className={styles.headIco} />
        <h2 className={styles.title}>TreeWalker</h2>
        {projectName && <span className={styles.headNote}>{projectName}</span>}
      </div>

      <label className={styles.branchPick}>
        <span className={styles.srOnly}>{H.selectLabel}</span>
        <select
          className={styles.select}
          data-testid="tw-branch-select"
          value={selected}
          disabled={isLoading || list.length === 0}
          onChange={(e) => e.target.value && onSelectBranch(e.target.value)}
        >
          <option value="" disabled={selected !== ''}>
            {placeholder}
          </option>
          {list.map((b) => (
            <option key={b.spineId} value={b.spineId}>
              {b.named ? b.name : truncateTitle(b.name, TREEWALKER_CONFIG.branchTitleMaxChars)} · {b.members}
            </option>
          ))}
        </select>
      </label>
      {capped && (
        <span className={styles.cappedNote} data-testid="tw-branches-count">
          {H.cappedNote.replace('{shown}', String(list.length)).replace('{total}', String(total))}
        </span>
      )}

      <div className={styles.headControls}>
        <button type="button" className={styles.btn} onClick={onJumpToTrunk} disabled={disabled || jumpDisabled}>
          <TrunkIcon size={15} />
          {H.jumpLabel}
        </button>
        <button
          type="button"
          className={cx(styles.btn, onlyProven && styles.btnActive)}
          onClick={onToggleOnlyProven}
          disabled={disabled}
          aria-pressed={onlyProven}
        >
          <ClockIcon size={15} />
          {H.trustedLabel}
        </button>
      </div>
    </div>
  );
};

export default HeaderRow;
