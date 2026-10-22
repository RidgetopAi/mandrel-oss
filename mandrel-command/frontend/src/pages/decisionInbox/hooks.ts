/**
 * Decision Inbox data hooks — reuses the Decisions page's data layer (`api.decisions.*`
 * through react-query, unified client, no axios/generated clients) rather than inventing a
 * second one. THE DECISION INBOX.
 *
 * TWO SEARCHES, NOT ONE. `decision_search`'s `answerStatus` filter takes exactly one value
 * (a bare zod enum, not an array — verified in mcp-server/src/middleware/validation.ts), and
 * the inbox needs BOTH `open` and `discussing` rows. A single unfiltered search would risk
 * paging OUT the open rows behind a window full of `decided` ones on a busy project, so this
 * issues one `decision_search` per status (mirroring the Decisions page's own two-query
 * split for stats vs list) and merges client-side.
 */
import React from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { UsePageProject } from '../../hooks/usePageProject';
import type { Decision } from '../../types/decision';
import { DECISION_INBOX_CONFIG } from './config';

export type RequestScope = UsePageProject['scope'];

/** The two answerStatus values the inbox lists — everything waiting on a human. */
const INBOX_STATUSES = ['open', 'discussing'] as const;

export interface DecisionInboxListParams {
  projectId: string | undefined;
  scope: RequestScope;
  enabled?: boolean;
}

export interface DecisionInboxList {
  decisions: Decision[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

/** Soonest deadline first (a decision with no deadline sorts after every deadlined one), then newest first. */
function sortInbox(rows: Decision[]): Decision[] {
  return [...rows].sort((a, b) => {
    const ad = a.deadline ? Date.parse(a.deadline) : null;
    const bd = b.deadline ? Date.parse(b.deadline) : null;
    if (ad !== null && bd !== null && ad !== bd) return ad - bd;
    if (ad !== null && bd === null) return -1;
    if (ad === null && bd !== null) return 1;
    const ac = a.created_at ? Date.parse(a.created_at) : 0;
    const bc = b.created_at ? Date.parse(b.created_at) : 0;
    return bc - ac;
  });
}

/**
 * The inbox list: every `open` or `discussing` decision for the page's project, sorted
 * soonest-deadline-first then newest. Guarded on `enabled` (pass `project.ready`) exactly
 * like the Decisions page's reads — `scope()` throws rather than sending an unscoped
 * request.
 */
export function useDecisionInboxList(params: DecisionInboxListParams): DecisionInboxList {
  const { projectId, scope, enabled = true } = params;

  const results = useQueries({
    queries: INBOX_STATUSES.map((answerStatus) => ({
      queryKey: ['decisionInbox', 'list', projectId, answerStatus],
      queryFn: () =>
        api.decisions.search(
          { answerStatus, limit: DECISION_INBOX_CONFIG.listLimit, offset: 0 },
          scope(),
        ),
      enabled,
      staleTime: DECISION_INBOX_CONFIG.staleTimeMs,
    })),
  });

  const isLoading = results.some((r) => r.isLoading);
  const isError = results.some((r) => r.isError);
  const error = results.find((r) => r.isError)?.error;

  // Depend on each query's `data` BY REFERENCE (react-query hands back a stable reference
  // until a refetch actually resolves), not a stringified join — an object always stringifies
  // to the same "[object Object]", which would freeze this memo after the first load and hide
  // every later refetch (e.g. the list not shrinking after a successful Decide/Discuss).
  const openData = results[0]?.data;
  const discussingData = results[1]?.data;
  const decisions = React.useMemo(() => {
    const merged = [...(openData?.decisions ?? []), ...(discussingData?.decisions ?? [])];
    return sortInbox(merged);
  }, [openData, discussingData]);

  return { decisions, isLoading, isError, error };
}

/**
 * POST /api/decisions/:id/answer — pick an option. On success, invalidates BOTH inbox
 * lists (the row leaves `open`/`discussing`) and the nav badge's open count.
 */
export function useAnswerDecision(scope: RequestScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, option, note }: { id: string; option: string; note?: string }) =>
      api.decisions.answer(id, option, note, scope()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['decisionInbox'] });
      qc.invalidateQueries({ queryKey: ['decisions'] });
    },
  });
}

/** POST /api/decisions/:id/discuss — the escape hatch; the row stays in the inbox. */
export function useDiscussDecision(scope: RequestScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api.decisions.discuss(id, note, scope()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['decisionInbox'] });
      qc.invalidateQueries({ queryKey: ['decisions'] });
    },
  });
}

/**
 * The nav badge's open count — `answerStatus:'open'` only (not `discussing`: the badge is
 * "how many need a first look", not the full inbox). Rides the AMBIENT project scope (no
 * explicit `scope()`): the shared axios instance already attaches `X-Project-ID` from the
 * topbar's selection to every request (api/http/projectHeaders.ts), and the sidebar is
 * global chrome, not a page — it has no page-owned project to pin.
 */
export function useOpenDecisionCount(enabled = true) {
  return useQuery<number>({
    queryKey: ['decisionInbox', 'openCount'],
    queryFn: async () => {
      const result = await api.decisions.search({ answerStatus: 'open', limit: 1, offset: 0 });
      return result.total ?? 0;
    },
    enabled,
    staleTime: DECISION_INBOX_CONFIG.badgeStaleTimeMs,
    refetchInterval: DECISION_INBOX_CONFIG.badgeRefetchIntervalMs,
  });
}
