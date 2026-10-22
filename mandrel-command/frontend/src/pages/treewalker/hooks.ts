/**
 * TreeWalker data hook — the whole-thread read rides the UNIFIED client (`api.treewalker.*`)
 * through react-query, mirroring the Decisions/Contexts reference. NO axios/generated client.
 *
 * DATA-GAP POLICY (10397f65): the read is gated on TREEWALKER_CONFIG.backendReady (now LIVE).
 * With NO explicit anchor the hook calls the no-arg resume endpoint (the backend resolves the
 * newest `ref:resume` context for the active project); with an explicit anchor it reads that
 * anchor's thread. A genuinely-empty thread comes back as an honest empty graph — never
 * fabricated. While backendReady is false the query stays disabled and `unavailable` is true.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { UsePageProject } from '../../hooks/usePageProject';
import type { BranchListResult, BranchSummary, ThreadGraph } from '../../api/domains/treewalker';
import { TREEWALKER_CONFIG } from './config';

export interface TreeWalkerThreadState {
  data: ThreadGraph | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /** True while the backend thread endpoint isn't wired — the honest "not yet available". */
  unavailable: boolean;
  refetch: () => void;
}

/**
 * Read the thread. With `anchorId` null the backend resolves the live resume anchor (no-arg
 * endpoint); with an explicit `anchorId` it reads that anchor's thread.
 *
 * `scope` is the page's `usePageProject().scope` — it pins X-Project-ID to the project the
 * page's selector names, for this request only. It is passed as the FUNCTION rather than a
 * pre-built config because it THROWS when there is no project, and it must therefore be
 * called inside `queryFn` (where react-query turns a throw into an error state) rather
 * than during render (where it would take the screen down).
 */
/** The branch list read state: the page (possibly capped) plus the honest totals P1 added
 *  (`total`/`cap`) — the rail needs both to state what it is NOT showing (P2
 *  / an earlier task), never just the array. */
export interface TreeWalkerBranchesState {
  branches: BranchSummary[] | undefined;
  /** The true DRAWER count for the scope (sections excluded, P2 an earlier task), pre-cap.
   *  Undefined while loading. */
  total: number | undefined;
  /** The cap actually applied to `branches.length`. Undefined while loading. */
  cap: number | undefined;
  isLoading: boolean;
}

/** The branch list (resume surface — PHASE 2 item c): newest-active first, project-scoped. */
export function useTreeWalkerBranches(
  projectId: string | undefined,
  scope: UsePageProject['scope'],
): TreeWalkerBranchesState {
  const enabled = TREEWALKER_CONFIG.backendReady && Boolean(projectId);
  const query = useQuery<BranchListResult>({
    queryKey: ['treewalker', 'branches', projectId ?? null],
    queryFn: () => api.treewalker.getBranches(scope()),
    enabled,
    staleTime: TREEWALKER_CONFIG.staleTimeMs,
  });
  return {
    branches: query.data?.branches,
    total: query.data?.total,
    cap: query.data?.cap,
    isLoading: enabled && query.isLoading,
  };
}

export function useTreeWalkerThread(
  anchorId: string | null,
  projectId: string | undefined,
  // The hook's own type, not a restatement — see the note on ScopeFn in
  // pages/dashboard/hooks.ts. Naming `axios` here would (correctly) trip the wiring guard
  // that keeps pages off the transport.
  scope: UsePageProject['scope'],
): TreeWalkerThreadState {
  // TWO gates, not one. `backendReady` is the honest "this endpoint does not exist yet"
  // switch; `projectId` is "this page does not know its scope yet". They are different
  // states and they must not share a branch — running the query without a scope would
  // not return nothing, it would walk every project the caller can see (C1: an
  // instrument has three states).
  const enabled = TREEWALKER_CONFIG.backendReady && Boolean(projectId);
  const query = useQuery<ThreadGraph>({
    // projectId is part of the key so changing the page's project refetches that
    // project's thread rather than serving the previous one's cache entry.
    queryKey: ['treewalker', 'thread', anchorId, projectId ?? null],
    queryFn: () =>
      anchorId
        ? api.treewalker.getThread(anchorId, scope())
        : api.treewalker.getResumeThread(scope()),
    enabled,
    staleTime: TREEWALKER_CONFIG.staleTimeMs,
  });

  return {
    data: query.data,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    error: query.error,
    unavailable: !TREEWALKER_CONFIG.backendReady,
    refetch: () => {
      void query.refetch();
    },
  };
}
