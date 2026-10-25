/**
 * PunchBoard — the stage kanban: draft · ready · claimed · verifying · evidence · merged ·
 * deployed, plus the BLOCKED lane (status==='blocked', any stage) shown distinctly. Desktop
 * (≥ the config breakpoint) shows every column; a phone shows ONE column behind a
 * horizontal stage picker, so a thumb can page through stages without a 7-wide grid.
 *
 * PER-COLUMN PAGING: each of the 8 columns fetches its OWN rows —
 * `useTaskColumnPage({ stage })` for the seven stages (`excludeStatus:'blocked'`, since
 * `columnFor`/stage.ts renders a blocked-status task in the blocked lane regardless of its
 * stage) and `useTaskColumnPage({ status:'blocked' })` for the blocked lane — instead of
 * splitting one shared, LIMIT-bound fetch client-side. That single fetch is exactly what let
 * the terminal-order fix starve Merged/Deployed once a project passed the old
 * list cap: every completed-implying row (which both terminal stages imply,
 * `STATUS_FOR_STAGE`) sorts after every open one, so the LIMIT cut the tail first — and
 * only. PUNCH_COLUMNS is a fixed, compile-time-constant set (never variable at runtime), so
 * these are 8 EXPLICIT hook calls rather than one mapped over the array — the
 * rules-of-hooks-safe way to do this (a mapped hook call cannot be statically verified safe
 * by eslint, even though this particular array never changes shape).
 *
 * Drag between columns is the stage change (`useStageDrag`): optimistic, rolled back on
 * failure. A `PUNCH_INCOMPLETE` rejection additionally hands the card + its missing
 * fields to the parent, which opens the detail with them highlighted.
 */
import React from 'react';
import { DragDropContext, type DropResult } from 'react-beautiful-dnd';
import { Spinner, Empty, Alert, cx } from '../../components/ui';
import { apiErrorMessage } from '../../api/request';
import { PunchColumn } from './PunchColumn';
import { Segmented } from './Segmented';
import { PUNCH_COLUMNS, PUNCH_CONFIG, BLOCKED_LANE, type PunchColumnId } from './config';
import { stageChangeFromDrop } from './stage';
import { useStageDrag, useBeforeThumbnails, useTaskColumnPage, type RequestScope } from './hooks';
import { punchIncompleteMissing } from './punchError';
import { matchesSearch } from '../tasks/search';
import type { Task } from '../../types/task';
import type { TaskUpdateInput } from '../tasks/hooks';
import styles from './Punch.module.css';
import drag from '../tasks/BoardDrag.module.css';

export interface PunchBoardProps {
  projectId: string | undefined;
  scope: RequestScope;
  enabled: boolean;
  search: string;
  selectedId: string | null;
  highlightedId?: string | null;
  projectNames: Record<string, string>;
  desktop: boolean;
  onSelect: (id: string) => void;
  /** A drag was rejected as PUNCH_INCOMPLETE: open this card with these fields flagged. */
  onIncomplete: (id: string, missing: string[]) => void;
  /** The whole board's own loading/empty/error gate — reads a total
   *  that is NOT any one column's fetch, so a single column being slow or erroring
   *  cannot blank the whole board (see PunchColumn, which renders its own state). */
  totalOnBoard: number;
  totalOnBoardLoading: boolean;
  totalOnBoardError: boolean;
  totalOnBoardErrorObj?: unknown;
}

const INITIAL_LIMITS: Record<PunchColumnId, number> = Object.fromEntries(
  PUNCH_COLUMNS.map((c) => [c.id, PUNCH_CONFIG.colCardCap]),
) as Record<PunchColumnId, number>;

export const PunchBoard: React.FC<PunchBoardProps> = ({
  projectId,
  scope,
  enabled,
  search,
  selectedId,
  highlightedId,
  projectNames,
  desktop,
  onSelect,
  onIncomplete,
  totalOnBoard,
  totalOnBoardLoading,
  totalOnBoardError,
  totalOnBoardErrorObj,
}) => {
  const [phoneColumn, setPhoneColumn] = React.useState<PunchColumnId>('ready');
  const [limits, setLimits] = React.useState<Record<PunchColumnId, number>>(INITIAL_LIMITS);
  const bumpLimit = React.useCallback((id: PunchColumnId) => {
    setLimits((prev) => ({ ...prev, [id]: prev[id] + PUNCH_CONFIG.colCardCap }));
  }, []);

  // EIGHT explicit calls — see the file header for why this cannot be `PUNCH_COLUMNS.map`.
  const draftQ = useTaskColumnPage(projectId, scope, { stage: 'draft', excludeStatus: 'blocked', limit: limits.draft, enabled });
  const readyQ = useTaskColumnPage(projectId, scope, { stage: 'ready', excludeStatus: 'blocked', limit: limits.ready, enabled });
  const claimedQ = useTaskColumnPage(projectId, scope, { stage: 'claimed', excludeStatus: 'blocked', limit: limits.claimed, enabled });
  const verifyingQ = useTaskColumnPage(projectId, scope, { stage: 'verifying', excludeStatus: 'blocked', limit: limits.verifying, enabled });
  const evidenceQ = useTaskColumnPage(projectId, scope, { stage: 'evidence', excludeStatus: 'blocked', limit: limits.evidence, enabled });
  const mergedQ = useTaskColumnPage(projectId, scope, { stage: 'merged', excludeStatus: 'blocked', limit: limits.merged, enabled });
  const deployedQ = useTaskColumnPage(projectId, scope, { stage: 'deployed', excludeStatus: 'blocked', limit: limits.deployed, enabled });
  const blockedQ = useTaskColumnPage(projectId, scope, { status: 'blocked', limit: limits.blocked, enabled });

  const queries = {
    draft: draftQ,
    ready: readyQ,
    claimed: claimedQ,
    verifying: verifyingQ,
    evidence: evidenceQ,
    merged: mergedQ,
    deployed: deployedQ,
    [BLOCKED_LANE]: blockedQ,
  } as const satisfies Record<PunchColumnId, ReturnType<typeof useTaskColumnPage>>;

  // The union of every row loaded across all 8 columns — feeds the ONE bulk `before`
  // thumbnail read (unchanged shape from before this split; only its input now comes
  // from 8 pages instead of 1 shared list).
  const allLoaded = React.useMemo(
    () => PUNCH_COLUMNS.flatMap((c) => queries[c.id].data?.tasks ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      draftQ.data,
      readyQ.data,
      claimedQ.data,
      verifyingQ.data,
      evidenceQ.data,
      mergedQ.data,
      deployedQ.data,
      blockedQ.data,
    ],
  );
  const thumbs = useBeforeThumbnails(allLoaded);

  const handleDragError = React.useCallback(
    (err: unknown, id: string, _updates: TaskUpdateInput) => {
      const missing = punchIncompleteMissing(err);
      if (missing) onIncomplete(id, missing);
    },
    [onIncomplete],
  );
  const { move, isError: moveFailed, error: moveError, reset } = useStageDrag(handleDragError);

  // Drag vs click arbitration — identical to the Tasks board (see its note).
  const dragEndedRef = React.useRef(false);
  const noteInteractionStart = React.useCallback(() => {
    dragEndedRef.current = false;
  }, []);
  const handleSelect = React.useCallback(
    (id: string) => {
      if (dragEndedRef.current) {
        dragEndedRef.current = false;
        return;
      }
      onSelect(id);
    },
    [onSelect],
  );
  const handleDragEnd = React.useCallback(
    (result: DropResult) => {
      dragEndedRef.current = true;
      const change = stageChangeFromDrop(result);
      if (change) move(change.id, change.updates);
    },
    [move],
  );

  if (totalOnBoardLoading) {
    return (
      <div className={styles.boardState}>
        <Spinner size="lg" />
      </div>
    );
  }
  if (totalOnBoardError) {
    return (
      <div className={styles.boardState}>
        <Alert variant="error" title="Couldn't load the punch list">
          {apiErrorMessage(totalOnBoardErrorObj, 'Failed to load tasks.')}
        </Alert>
      </div>
    );
  }
  if (totalOnBoard === 0) {
    return (
      <div className={styles.boardState}>
        <Empty title="No punches" description="Nothing filed in this project yet." />
      </div>
    );
  }

  const columns = desktop ? PUNCH_COLUMNS : PUNCH_COLUMNS.filter((c) => c.id === phoneColumn);
  const searching = search.trim().length > 0;

  return (
    <>
      {moveFailed && !punchIncompleteMissing(moveError) && (
        <Alert variant="error" title="Couldn't move the punch" className={drag.moveError} onClose={reset}>
          {apiErrorMessage(moveError, 'The request failed.')} The card has been put back.
        </Alert>
      )}

      {!desktop && (
        <Segmented
          aria-label="Stage"
          scroll
          value={phoneColumn}
          onChange={setPhoneColumn}
          options={PUNCH_COLUMNS.map((c) => ({
            value: c.id,
            label: c.label,
            dotVar: c.dotVar,
            meta: queries[c.id].data?.total ?? 0,
          }))}
        />
      )}

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className={cx(styles.board, !desktop && styles.boardPhone)}>
          {columns.map((col) => {
            const q = queries[col.id];
            const loaded = q.data?.tasks ?? [];
            const total = q.data?.total ?? 0;
            const visible = searching
              ? loaded.filter((t: Task) => matchesSearch(t, search))
              : loaded;
            return (
              <PunchColumn
                key={col.id}
                id={col.id}
                label={col.label}
                dotVar={col.dotVar}
                blocked={col.id === BLOCKED_LANE}
                tasks={visible}
                total={searching ? visible.length : total}
                isLoading={q.isLoading}
                isError={q.isError}
                error={q.error}
                canLoadMore={loaded.length < total}
                loadMoreCount={total - loaded.length}
                onLoadMore={() => bumpLimit(col.id)}
                selectedId={selectedId}
                highlightedId={highlightedId}
                projectNames={projectNames}
                thumbs={thumbs}
                onSelect={handleSelect}
                onInteractStart={noteInteractionStart}
              />
            );
          })}
        </div>
      </DragDropContext>
    </>
  );
};

export default PunchBoard;
