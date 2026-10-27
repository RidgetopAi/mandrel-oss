/**
 * ContextList — the mock's left column: a scrollable list of context items (kind badge,
 * relative time, first-line title, tag row). Selecting an item drives the reader. Owns
 * its own loading / empty / error state (Spinner / Empty / Alert), like the Sessions page.
 */
import React from 'react';
import { Badge, Checkbox, Spinner, Empty, Alert, cx } from '../../components/ui';
import { kindTone } from './config';
import { formatRelative, contextTitle } from './parts';
import type { Context } from '../../types/context';
import styles from './Contexts.module.css';
import { apiErrorMessage } from '../../api/request';

export interface ContextListProps {
  contexts: Context[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /**
   * True when the page has NO project to scope to and is not merely still loading one.
   *
   * HISTORY (an earlier task → an earlier epic): this used to be `needsProject` — "you typed a
   * search while the global selector was on All Projects", which 400s because the canonical
   * engine scopes matching by project. That state is now UNREACHABLE: the page owns its own
   * selector, opens on a concrete project, and offers no All-projects option. What remains
   * is the genuine third state — an instance with no projects at all, where `scope()` would
   * throw and every read is gated off. Guiding is still better than a red error, so the
   * branch survives with the one meaning it can still have.
   */
  noProject?: boolean;
  /**
   * MULTI-SELECT. When present, every row grows a checkbox and the rail
   * grows a "select all in view" header. The list is DUMB about the selection: it reports
   * toggles and reads membership; the page (useContextSelection) owns the state and its
   * survive-filters / clear-on-project-switch rules. Absent → the pre-bulk rail, unchanged.
   */
  selection?: {
    isSelected: (id: string) => boolean;
    onToggle: (ctx: Context) => void;
    /** Select (`on`) or deselect exactly the rows currently rendered — never the whole project. */
    onToggleAll: (visible: Context[], on: boolean) => void;
  };
}

/** The `context_type` of a row (the generated model widens `type`; contexts carry it). */
function rowKind(ctx: Context): string {
  return (ctx as { context_type?: string; type?: string }).context_type ?? ctx.type ?? 'context';
}

const ContextRow: React.FC<{
  ctx: Context;
  active: boolean;
  onSelect: (id: string) => void;
  /** `undefined` = no multi-select on this rail (no checkbox rendered). */
  checked?: boolean;
  onToggle?: (ctx: Context) => void;
}> = ({ ctx, active, onSelect, checked, onToggle }) => {
  const kind = rowKind(ctx);
  const tags = ctx.tags ?? [];
  // The checkbox sits BESIDE the row button, not inside it: an interactive control nested
  // in a <button> is invalid HTML and a click on it would also open the reader.
  return (
    <div className={cx(styles.item, active && styles.itemOn, checked && styles.itemChecked)}>
      {onToggle && (
        <Checkbox
          className={styles.itemCheck}
          checked={Boolean(checked)}
          onChange={() => onToggle(ctx)}
          aria-label={`Select context ${contextTitle(ctx.content)}`}
        />
      )}
      <button
        type="button"
        className={styles.itemMain}
        aria-current={active}
        onClick={() => onSelect(ctx.id)}
      >
        <span className={styles.itemR1}>
          <Badge variant={kindTone(kind)}>{kind}</Badge>
          <span className={styles.itemTime}>{formatRelative(ctx.created_at)}</span>
        </span>
        <span className={styles.itemTitle}>{contextTitle(ctx.content)}</span>
        {tags.length > 0 && (
          <span className={styles.itemTags}>
            {tags.slice(0, 3).map((t) => (
              <span key={t} className={styles.itemTag}>
                {t}
              </span>
            ))}
          </span>
        )}
      </button>
    </div>
  );
};

export const ContextList: React.FC<ContextListProps> = ({
  contexts,
  selectedId,
  onSelect,
  isLoading,
  isError,
  error,
  noProject = false,
  selection,
}) => {
  // Guide, don't error. With no project the reads are gated off, so without this branch the
  // rail would render the ordinary "No contexts" empty state and imply the project is empty
  // rather than absent. Checked FIRST, so it wins over those idle states.
  if (noProject) {
    return (
      <div className={styles.listState}>
        <Empty
          title="No project selected"
          description="Contexts are scoped to a project. Create a project, or pick one from the selector above, to read its memory."
        />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className={styles.listState}>
        <Spinner size="md" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={styles.listState}>
        <Alert variant="error" title="Couldn't load contexts">
          {apiErrorMessage(error, 'Failed to load contexts.')}
        </Alert>
      </div>
    );
  }
  if (contexts.length === 0) {
    return (
      <div className={styles.listState}>
        <Empty title="No contexts" description="No contexts match the current filters." />
      </div>
    );
  }

  // "Select all" is scoped to the rows ON SCREEN — `contexts` is exactly the rendered
  // window, so the count it reports is the count it would select.
  const visibleSelected = selection ? contexts.filter((c) => selection.isSelected(c.id)).length : 0;
  const allVisible = visibleSelected > 0 && visibleSelected === contexts.length;

  return (
    <div className={styles.rail}>
      {selection && (
        <div className={styles.listHead}>
          <Checkbox
            checked={allVisible}
            indeterminate={visibleSelected > 0 && !allVisible}
            onChange={() => selection.onToggleAll(contexts, !allVisible)}
            aria-label="Select all in view"
          >
            Select all
          </Checkbox>
          <span className={styles.listHeadCount}>{contexts.length} in view</span>
        </div>
      )}
      <div className={styles.list} role="listbox" aria-label="Contexts">
        {contexts.map((ctx) => (
          <ContextRow
            key={ctx.id}
            ctx={ctx}
            active={ctx.id === selectedId}
            onSelect={onSelect}
            checked={selection ? selection.isSelected(ctx.id) : undefined}
            onToggle={selection?.onToggle}
          />
        ))}
      </div>
    </div>
  );
};

export default ContextList;
