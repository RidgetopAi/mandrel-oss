/**
 * useContextSelection — the rail's multi-select state.
 *
 * The selection is a map id → row SNAPSHOT, not a bare id set, for one reason: the bulk
 * endpoint REPLACES a context's tag list, so "add tags" needs each selected row's current
 * tags, and a selected row may have scrolled out of the current filter. The snapshot is
 * refreshed from the loaded rows whenever the row is on screen, so an edit made in the
 * reader is picked up as soon as the list refetches.
 *
 * Two rules the page asked for, both encoded here rather than in the components:
 *   - the selection SURVIVES filter changes (search / type / sort) — a filter only changes
 *     which rows are visible, never which are selected; and
 *   - it CLEARS on a project switch — the selection is keyed to the project it was made in,
 *     so a different `projectId` reads as empty with no effect and no flash of stale state.
 */
import React from 'react';
import type { Context } from '../../types/context';

export interface ContextSelection {
  /** The selected rows, keyed by id (snapshots, refreshed from the visible rows). */
  selected: ReadonlyMap<string, Context>;
  /** `selected.size`. */
  count: number;
  isSelected: (id: string) => boolean;
  /** Flip one row in or out of the selection. */
  toggle: (ctx: Context) => void;
  /** Select (`on`) or deselect every row in `rows` — the page's "select all in view". */
  setAll: (rows: Context[], on: boolean) => void;
  clear: () => void;
}

interface SelectionState {
  /** The project the selection was made in — a different page project reads as empty. */
  forProject: string | undefined;
  map: Map<string, Context>;
}

const EMPTY: ReadonlyMap<string, Context> = new Map();

export function useContextSelection(
  rows: Context[],
  projectId: string | undefined,
): ContextSelection {
  const [state, setState] = React.useState<SelectionState>({
    forProject: projectId,
    map: new Map(),
  });

  // Derived, not an effect: a project switch must never render one frame of the previous
  // project's selection (the toolbar would offer to delete rows the user can no longer see).
  const stored = state.forProject === projectId ? state.map : EMPTY;

  // ...and then actually dropped, so switching back to the first project does not resurrect
  // a selection the user last saw before leaving it. The derived read above is what keeps
  // this effect from ever being visible.
  React.useEffect(() => {
    if (state.forProject !== projectId) setState({ forProject: projectId, map: new Map() });
  }, [state.forProject, projectId]);

  const selected = React.useMemo<ReadonlyMap<string, Context>>(() => {
    if (stored.size === 0) return EMPTY;
    const fresh = new Map<string, Context>();
    stored.forEach((snapshot, id) => {
      fresh.set(id, rows.find((r) => r.id === id) ?? snapshot);
    });
    return fresh;
  }, [stored, rows]);

  const update = React.useCallback(
    (mutate: (next: Map<string, Context>) => void) => {
      setState((prev) => {
        const next = new Map(prev.forProject === projectId ? prev.map : EMPTY);
        mutate(next);
        return { forProject: projectId, map: next };
      });
    },
    [projectId],
  );

  const toggle = React.useCallback(
    (ctx: Context) =>
      update((next) => {
        if (next.has(ctx.id)) next.delete(ctx.id);
        else next.set(ctx.id, ctx);
      }),
    [update],
  );

  const setAll = React.useCallback(
    (visible: Context[], on: boolean) =>
      update((next) => {
        for (const ctx of visible) {
          if (on) next.set(ctx.id, ctx);
          else next.delete(ctx.id);
        }
      }),
    [update],
  );

  const clear = React.useCallback(() => update((next) => next.clear()), [update]);

  const isSelected = React.useCallback((id: string) => selected.has(id), [selected]);

  return { selected, count: selected.size, isSelected, toggle, setAll, clear };
}
