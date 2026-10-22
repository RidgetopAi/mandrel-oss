/**
 * Contexts data hooks — every read rides the UNIFIED client (`api.contexts.*`) through
 * react-query, mirroring the Sessions reference. The list feeds the left column; stats
 * feed the facet counts; the reader lazy-loads the selected context's full record; and
 * the typed-edge links feed the thread box (the moat) from REAL graph edges. NO
 * axios/generated clients here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { UsePageProject } from '../../hooks/usePageProject';
import type {
  Context,
  ContextLink,
  ContextSearchResult,
  ContextStats,
} from '../../types/context';
import { CONTEXTS_CONFIG, SORT_OPTIONS, type SortValue } from './config';

/**
 * The page's request scope, as a function. Derived from `usePageProject`'s own contract
 * rather than re-declaring the axios-config signature here, for two reasons: it cannot
 * drift from the hook that produces it, and these page modules are guarded against
 * importing `axios` directly (Contexts/Decisions/Tasks `*.wiring.test.ts` — everything
 * goes through the unified `api` client, and a type-only import would still have tripped
 * a guard whose intent is exactly right).
 */
export type RequestScope = UsePageProject['scope'];

/**
 * ── SCOPE IS AN ARGUMENT, NOT AN AMBIENT (epic 41293984 §A1) ─────────────────────────
 * Every read below takes BOTH `projectId` (the value that goes in the query key and the
 * `project_id` query param) and `scope` — `usePageProject().scope`, passed as a FUNCTION
 * so it is called inside the queryFn rather than during render. That matters: `scope()`
 * THROWS when the page has no project yet, and a throw during render would white-screen
 * the page instead of leaving the query disabled. Guard every one on `enabled`.
 */
export interface ContextListParams {
  query: string;
  type: string | null;
  sort: SortValue;
  /**
   * The PAGE's selected project id (`usePageProject().projectId`) — no longer the global
   * selector, which no longer exists. It is part of the query key so switching the project
   * REFETCHES, and it is sent as an explicit `project_id` query param as well as through
   * `scope()`'s header.
   */
  projectId: string | undefined;
  /** `usePageProject().scope` — pins X-Project-ID to THIS page's project per request. */
  scope: RequestScope;
  /**
   * Gate for whether the list read may run — pass `project.ready`. `scope()` throws rather
   * than silently falling back, so a query that could not be scoped must never fire.
   *
   * HISTORY: this used to additionally carry the "text search under 'All
   * Projects' 400s" gate. That state is now unreachable — the Contexts page defaults to a
   * concrete project and offers no All-projects option — so the gate is exactly the
   * readiness check and nothing else. The page's guidance state now covers the one
   * remaining way to have no project: the instance has no projects at all.
   */
  enabled?: boolean;
}

/**
 * GET /api/contexts — the list feed for the rail. A non-empty `query` dispatches to the
 * semantic engine (backend two-mode dispatch); an empty query browses. Both read a single
 * window of CONTEXTS_CONFIG.listLimit rows that the rail scrolls — the grid's server-side
 * pager was retired with the grid, so there is no page offset to walk.
 * `type` filters by context_type; sort maps to (sort_by, sort_order) from config.
 */
export function useContextList(params: ContextListParams) {
  const sort = SORT_OPTIONS.find((s) => s.value === params.sort) ?? SORT_OPTIONS[0];
  const query = params.query.trim();
  return useQuery<ContextSearchResult>({
    queryKey: ['contexts', 'list', params.projectId, query, params.type, params.sort],
    queryFn: () =>
      api.contexts.search(
        {
          ...(query ? { query } : {}),
          ...(params.type ? { type: params.type } : {}),
          project_id: params.projectId,
          limit: CONTEXTS_CONFIG.listLimit,
          offset: 0,
          sort_by: sort.sort_by,
          sort_order: sort.sort_order,
        },
        params.scope()
      ),
    enabled: params.enabled ?? true,
    staleTime: CONTEXTS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/contexts/stats — the by-type facet counts + total (real, never fabricated).
 * Scoped to the PAGE's project: `projectId` in the key so a switch refetches, and the
 * scope on the request so the counts describe the project on screen. This endpoint takes
 * no project query param, so the header IS the scope — which is exactly why it used to
 * silently report the ambient project's counts beside the page's own rows.
 */
export function useContextStats(
  projectId: string | undefined,
  scope: RequestScope,
  enabled = true
) {
  return useQuery<ContextStats>({
    queryKey: ['contexts', 'stats', projectId],
    queryFn: () => api.contexts.stats(scope()),
    enabled,
    staleTime: CONTEXTS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/contexts/:id — the full record for the reader (lazy; only when selected).
 *
 * DELIBERATELY UNSCOPED. A by-id read is authorized against the RECORD's own project by a
 * router.param choke point (backend/src/services/entityProjectScope.ts), never against the
 * request's project header — so this must NOT carry the page's scope, or a `/r/<id8>` link
 * to a record outside the selected project would look like a request for something it
 * isn't. The page re-points its selector at the record's project instead (see Contexts.tsx).
 */
export function useContext(id: string | null) {
  return useQuery<Context>({
    queryKey: ['contexts', 'detail', id],
    queryFn: () => api.contexts.get(id as string),
    enabled: Boolean(id),
    staleTime: CONTEXTS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/contexts/:id/links — the TYPED graph edges (the thread box moat), lazy per
 * selected context. REAL `links`-table rows — distinct from the semantic `related` list.
 */
export function useContextLinks(id: string | null) {
  return useQuery<ContextLink[]>({
    queryKey: ['contexts', 'links', id],
    queryFn: () => api.contexts.links(id as string),
    enabled: Boolean(id),
    staleTime: CONTEXTS_CONFIG.staleTimeMs,
  });
}

/**
 * PUT /api/contexts/:id — edit content/tags, then refresh the list + this record.
 *
 * UNSCOPED, like the by-id reads and for the same reason: this controller addresses the
 * record by id and never consults the request's project (backend controllers/context.ts
 * updateContext). The record on screen may legitimately belong to another project when the
 * reader was reached by short link; pinning the page's project on this request would name a
 * project that has nothing to do with the row being written.
 *
 * This is NOT the `context_store` write. That one — POST /api/contexts, a
 * `requireWriteProjectId` controller — is the one that files into the resolved header
 * project, and the Contexts screen has no create surface that calls it.
 */
export function useUpdateContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: { content?: string; tags?: string[] } }) =>
      api.contexts.update(id, updates),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['contexts', 'list'] });
      qc.invalidateQueries({ queryKey: ['contexts', 'detail', id] });
    },
  });
}

/**
 * DELETE /api/contexts/:id — soft-delete (backend sets `archived_at`), then refresh the
 * list so the removed row drops out of the rail. The caller deselects on success.
 * Unscoped for the same reason as `useUpdateContext` — addressed purely by id.
 *
 * This sentence was FALSE until the backend ran `DELETE FROM contexts`
 * and destroyed the row. It is true now, and `useRestoreContext` below is the undo.
 */
export function useDeleteContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.contexts.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contexts', 'list'] });
      qc.invalidateQueries({ queryKey: ['contexts', 'stats'] });
    },
  });
}

/**
 * POST /api/contexts/:id/restore — the UNDO for the soft delete above.
 *
 * Before that task the Command UI delete DESTROYED the row, so there was nothing to
 * restore and the comment above was false. Now the row survives and this puts it back.
 * The detail query is invalidated too, so the reader re-renders without the archived
 * banner rather than needing a reload.
 */
export function useRestoreContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.contexts.restore(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['contexts', 'list'] });
      qc.invalidateQueries({ queryKey: ['contexts', 'stats'] });
      qc.invalidateQueries({ queryKey: ['contexts', 'detail', id] });
    },
  });
}

/**
 * GET /api/contexts/:id/related — the SEMANTIC "related contexts" list (vector
 * similarity). This is DELIBERATELY DISTINCT from the typed thread box (useContextLinks
 * / ThreadBox), which renders REAL `links`-table edges — the two are never conflated
 * (data-gap policy 10397f65). Lazy: only fetched when the reader's Related section is
 * expanded, so opening a context doesn't pay for a similarity query it may never show.
 */
export function useRelatedContexts(id: string | null, enabled: boolean) {
  return useQuery<Context[]>({
    queryKey: ['contexts', 'related', id],
    queryFn: () => api.contexts.related(id as string),
    enabled: Boolean(id) && enabled,
    staleTime: CONTEXTS_CONFIG.staleTimeMs,
  });
}

/**
 * DELETE /api/contexts/bulk/delete — soft-delete a SELECTION, then refresh
 * the list + counts. Every id's detail entry is invalidated too, so a reader still pointed
 * at one of them re-reads and shows the archived banner instead of a stale live record.
 *
 * SCOPED, unlike the single delete: the controller has no `:id` param to authorize against,
 * so it authorizes the whole batch against the REQUEST's project scope (backend
 * controllers/context.ts bulkDeleteContexts → resolveListScope). The page's scope names the
 * project the rows were selected from; without it the header falls back to the ambient
 * default and the batch is silently narrowed to whatever ids live there.
 */
export function useBulkDeleteContexts(scope: RequestScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.contexts.bulkDelete(ids, scope()),
    onSuccess: (_data, ids) => {
      qc.invalidateQueries({ queryKey: ['contexts', 'list'] });
      qc.invalidateQueries({ queryKey: ['contexts', 'stats'] });
      for (const id of ids) qc.invalidateQueries({ queryKey: ['contexts', 'detail', id] });
    },
  });
}

/** One `POST /api/contexts/bulk/update` request: these ids get exactly these fields. */
export interface BulkUpdateBatch {
  ids: string[];
  updates: { project_id?: string; tags?: string[] };
}

/**
 * POST /api/contexts/bulk/update, as a list of BATCHES run in order — because the endpoint
 * applies ONE update object to every id, while "add tags" needs each row's own union of
 * existing + new tags. The toolbar groups the selection by resulting tag set, so a move is
 * always one batch and a tag-add is one batch per distinct outcome (usually one).
 * Unscoped, like `useUpdateContext`: the controller addresses rows purely by id.
 */
export function useBulkUpdateContexts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (batches: BulkUpdateBatch[]) => {
      let updated = 0;
      for (const batch of batches) {
        // Sequential on purpose: partial failure leaves the earlier batches applied and the
        // error names the one that failed; a Promise.all would interleave them.
        // eslint-disable-next-line no-await-in-loop
        const res = await api.contexts.bulkUpdate(batch.ids, batch.updates);
        updated += res.updated;
      }
      return { updated };
    },
    onSuccess: (_data, batches) => {
      qc.invalidateQueries({ queryKey: ['contexts', 'list'] });
      qc.invalidateQueries({ queryKey: ['contexts', 'stats'] });
      for (const b of batches)
        for (const id of b.ids) qc.invalidateQueries({ queryKey: ['contexts', 'detail', id] });
    },
  });
}
