/**
 * Decisions data hooks — every read rides the UNIFIED client (`api.decisions.*`) through
 * react-query, mirroring the Contexts/Tasks reference. The list feeds the left column;
 * stats feed the facet counts; the reader lazy-loads the selected decision's full record;
 * and the typed-edge links feed the thread box (the moat) from REAL graph edges. NO
 * axios/generated clients here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { UsePageProject } from '../../hooks/usePageProject';
import type { Decision, DecisionSearchResult, DecisionStats } from '../../types/decision';
import type { RecordLink } from '../../types/recordLink';
import type { DecisionUpdate } from '../../api/domains/decisions';
import { DECISIONS_CONFIG } from './config';

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
 * ── SCOPE IS AN ARGUMENT, NOT AN AMBIENT (an earlier epic §A1) ─────────────────────────
 * Every read takes `scope` — `usePageProject().scope`, passed as a FUNCTION so it is
 * called inside the queryFn. `scope()` THROWS when the page has no project rather than
 * falling back, and a throw during render would white-screen the page; every read is
 * gated on `enabled` instead.
 */
export interface DecisionListParams {
  query: string;
  /** Lifecycle status filter — the ONE server-side facet the MCP engine accepts. */
  status: string | null;
  /**
   * The PAGE's selected project id (`usePageProject().projectId`). In the query key so a
   * switch REFETCHES; sent on the wire by `scope()`'s X-Project-ID header, which the
   * backend's resolver reads (controllers/decision.ts forwards it to the MCP engine's
   * `projectId` param).
   */
  projectId: string | undefined;
  /** `usePageProject().scope` — pins X-Project-ID to THIS page's project per request. */
  scope: RequestScope;
  /** Pass `project.ready`: a read that cannot be scoped must never fire. */
  enabled?: boolean;
}

/**
 * GET /api/decisions — the list. A non-empty `query` dispatches to the MCP decision
 * engine; an empty query browses (all). `status` is forwarded server-side. decision_type /
 * impact / outcome are filtered CLIENT-SIDE by the page (the MCP engine rejects a
 * decision_type param — strict mode).
 */
export function useDecisionList(params: DecisionListParams) {
  const query = params.query.trim();
  return useQuery<DecisionSearchResult>({
    queryKey: ['decisions', 'list', params.projectId, query, params.status],
    queryFn: () =>
      api.decisions.search(
        {
          ...(query ? { query } : {}),
          ...(params.status ? { status: params.status } : {}),
          limit: DECISIONS_CONFIG.listLimit,
          offset: 0,
        },
        params.scope()
      ),
    enabled: params.enabled ?? true,
    staleTime: DECISIONS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/decisions/stats — the by-type facet counts + total (real, never fabricated).
 * Scoped to the PAGE's project: `projectId` in the key so a switch refetches, and
 * `scope()` on the request so the facet counts describe the ledger on screen rather than
 * the ambient default's.
 */
export function useDecisionStats(
  projectId: string | undefined,
  scope: RequestScope,
  enabled = true
) {
  return useQuery<DecisionStats>({
    queryKey: ['decisions', 'stats', projectId],
    queryFn: () => api.decisions.stats(undefined, scope()),
    enabled,
    staleTime: DECISIONS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/decisions/:id — the full record for the reader (lazy; only when selected).
 * DELIBERATELY UNSCOPED: a by-id read is authorized against the RECORD's project
 * (backend/src/services/entityProjectScope.ts), so a `/r/<id8>` link to a decision outside
 * the page's project must open. The page follows the record instead (useRecordProjectSync).
 */
export function useDecision(id: string | null) {
  return useQuery<Decision>({
    queryKey: ['decisions', 'detail', id],
    queryFn: () => api.decisions.get(id as string),
    enabled: Boolean(id),
    staleTime: DECISIONS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/decisions/:id/links — the TYPED graph edges (the thread box moat), lazy per
 * selected decision. REAL `links`-table rows — distinct from any semantic list.
 */
export function useDecisionLinks(id: string | null) {
  return useQuery<RecordLink[]>({
    queryKey: ['decisions', 'links', id],
    queryFn: () => api.decisions.links(id as string),
    enabled: Boolean(id),
    staleTime: DECISIONS_CONFIG.staleTimeMs,
  });
}

/**
 * PUT /api/decisions/:id — record an outcome/lifecycle update, then refresh list + record.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THIS IS A `requireWriteProjectId` WRITE. THE SCOPE IS NOT OPTIONAL.
 * ════════════════════════════════════════════════════════════════════════════════════
 * `controllers/decision.ts:updateDecision` resolves a project from the request
 * (header-beats-body) and forwards it to the MCP `decision_update` tool, which uses it to
 * SCOPE THE decisionId LOOKUP. Two consequences:
 *
 *   • with no scope the resolved project is the ambient default — a different project from
 *     the one the page is showing, by design in this change set;
 *   • the project must be the DECISION'S OWN, not merely the page's. A decision reached by
 *     short link lives elsewhere, and naming the page's project would make the tool look
 *     for that id in a project that does not contain it.
 *
 * So `scope` is a REQUIRED argument and the caller derives it from `decision.project_id`.
 * See DecisionEditDrawer, which is the only caller.
 */
export function useUpdateDecision(scope: RequestScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: DecisionUpdate }) =>
      api.decisions.update(id, updates, scope()),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['decisions', 'list'] });
      qc.invalidateQueries({ queryKey: ['decisions', 'detail', id] });
    },
  });
}
