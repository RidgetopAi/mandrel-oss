/**
 * decisions domain — search / get / stats / update / links, all through the unified client
 * (`http`). Command backend `/api/decisions/*` (which proxies the MCP decision tools).
 *
 * Returns the REAL `Decision` read model (src/types/decision) — grounded against live data,
 * not the stale generated DecisionEntity. The P2 Decisions "why ledger" screen calls
 * `api.decisions.*` directly.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';
import { withParams } from './scopeConfig';
import type { Decision, DecisionSearchResult, DecisionStats } from '../../types/decision';
import type { RecordLink } from '../../types/recordLink';
import type { CreateDecisionRequest } from '../generated/models/CreateDecisionRequest';

interface DecisionSearchData {
  decisions?: Decision[];
  total?: number;
  limit?: number;
  page?: number;
}

/** The fields the backend PUT /api/decisions/:id accepts (outcome / lifecycle updates). */
export interface DecisionUpdate {
  status?: string;
  outcomeStatus?: string;
  outcomeNotes?: string;
  lessonsLearned?: string;
  supersededBy?: string;
  supersededReason?: string;
}

export const decisionsApi = {
  /** GET /api/decisions — search/browse (query dispatches to the MCP decision engine). */
  async search(
    params?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<DecisionSearchResult> {
    const body = await http.get<ApiEnvelope<DecisionSearchData>>(
      '/decisions',
      withParams(config, params ?? {})
    );
    const data = (unwrapData(body, 'Failed to search decisions') ?? {}) as DecisionSearchData;
    return {
      decisions: (data.decisions ?? []) as Decision[],
      total: data.total ?? 0,
      limit: data.limit,
      page: data.page,
    };
  },

  /** GET /api/decisions/:id */
  async get(id: string, config?: AxiosRequestConfig): Promise<Decision> {
    const body = await http.get<ApiEnvelope<Decision>>(
      `/decisions/${encodeURIComponent(id)}`,
      config
    );
    const decision = unwrapData(body, 'Failed to fetch decision');
    if (!decision) {
      throw new Error('Decision payload missing in response');
    }
    return decision;
  },

  /**
   * POST /api/decisions — `decision_record`, a `requireWriteProjectId` surface.
   *
   * `config` IS REQUIRED, and that is the guard (§A1). This controller resolves the
   * project from the RESOLVED WINNER — the header — not from the body, so an unscoped
   * call files the decision in the user's DEFAULT project while the page shows another
   * one: no error, no red, and the record never appears in the list on screen. A
   * required parameter makes that call unwriteable. Pass `usePageProject().scope()`.
   */
  async create(payload: CreateDecisionRequest, config: AxiosRequestConfig): Promise<Decision> {
    const body = await http.post<ApiEnvelope<Decision>>('/decisions', payload, config);
    return unwrapData(body, 'Failed to record decision');
  },

  /**
   * PUT /api/decisions/:id — `decision_update`, the THIRD `requireWriteProjectId`
   * surface. Its two siblings (`contexts.create`, `decisions.create`) take a REQUIRED
   * config; this one is deliberately OPTIONAL and it is the only inconsistency here.
   *
   * WHY: it has one production caller today — `pages/decisions/hooks.ts`
   * (`useUpdateDecision`) → `pages/decisions/DecisionEditDrawer.tsx` — and that page has
   * not yet been converted to `usePageProject`. Making the parameter required puts a
   * compile error two files deep inside the Decisions page stream's in-flight worktree
   * and would require this stream to design that page's scoping. The other two have ZERO
   * production callers, so required is free there.
   *
   * FLIP THIS TO REQUIRED as part of the Decisions page stream, where it is one line and
   * the author has the page context. Until then the seam test
   * (`scopePassthrough.seam.test.ts`) is what holds this surface.
   */
  async update(
    id: string,
    updates: DecisionUpdate,
    config?: AxiosRequestConfig
  ): Promise<void> {
    const body = await http.put<ApiEnvelope<unknown>>(
      `/decisions/${encodeURIComponent(id)}`,
      updates,
      config
    );
    unwrapData(body, 'Failed to update decision');
  },

  /**
   * POST /api/decisions/:id/answer — THE DECISION INBOX.
   * Picks an option on an open/discussing decision; the mcp-server folds every
   * non-chosen option into alternatives_considered. `config` mirrors `update`'s optional
   * scope — the inbox page passes `usePageProject().scope()`.
   */
  async answer(
    id: string,
    option: string,
    note: string | undefined,
    config?: AxiosRequestConfig
  ): Promise<Decision> {
    const body = await http.post<ApiEnvelope<Decision>>(
      `/decisions/${encodeURIComponent(id)}/answer`,
      { option, ...(note ? { note } : {}) },
      config
    );
    return unwrapData(body, 'Failed to answer decision');
  },

  /**
   * POST /api/decisions/:id/discuss — the inbox's escape hatch: kick an open decision back
   * for more context. The row stays open (`answer_status='discussing'`).
   */
  async discuss(id: string, note: string | undefined, config?: AxiosRequestConfig): Promise<Decision> {
    const body = await http.post<ApiEnvelope<Decision>>(
      `/decisions/${encodeURIComponent(id)}/discuss`,
      note ? { note } : {},
      config
    );
    return unwrapData(body, 'Failed to send decision for discussion');
  },

  /** DELETE /api/decisions/:id */
  async remove(id: string, config?: AxiosRequestConfig): Promise<void> {
    const body = await http.del<ApiEnvelope<unknown>>(
      `/decisions/${encodeURIComponent(id)}`,
      config
    );
    unwrapData(body, 'Failed to delete decision');
  },

  /** GET /api/decisions/stats — real by_type / by_impact / by_status counts (never faked). */
  async stats(projectId?: string, config?: AxiosRequestConfig): Promise<DecisionStats> {
    const body = await http.get<ApiEnvelope<DecisionStats>>(
      '/decisions/stats',
      withParams(config, projectId ? { projectId } : {})
    );
    return (unwrapData(body, 'Failed to fetch decision stats') ?? {}) as DecisionStats;
  },

  /**
   * GET /api/decisions/:id/links — the TYPED graph edges (the TreeWalker "thread box"
   * moat) touching this decision, both directions, resolved to each target's title +
   * kind. STRUCTURE (real `links` rows), NOT the semantic `related` list — never conflate.
   */
  async links(id: string, config?: AxiosRequestConfig): Promise<RecordLink[]> {
    const body = await http.get<ApiEnvelope<RecordLink[]>>(
      `/decisions/${encodeURIComponent(id)}/links`,
      config
    );
    return (unwrapData(body, 'Failed to fetch decision links') ?? []) as RecordLink[];
  },
};

export type DecisionsApi = typeof decisionsApi;
