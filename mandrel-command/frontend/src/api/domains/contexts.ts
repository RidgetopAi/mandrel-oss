/**
 * contexts domain — the FULLY-MIGRATED reference domain for the unified client.
 *
 * Every context call (search / CRUD / bulk / stats / related / links / export) rides
 * the shared axios instance via `http`, replacing the mix of generated
 * ContextsService (fetch) + hand-rolled `fetch()` the legacy contextsClient used.
 * Screens call `api.contexts.*` directly (the old `api/contextsClient.ts` shim was
 * retired when the P2 Contexts screen was rebuilt), so every context request flows
 * through the one client.
 *
 * Types reuse `../types/context` (which itself extends the generated ContextEntity
 * / ContextSearchResponse / ContextStats models).
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';
import { withConfig, withParams } from './scopeConfig';
import type {
  Context,
  ContextLink,
  ContextSearchParams,
  ContextSearchResult,
  ContextStats,
} from '../../types/context';

interface ContextSearchData {
  contexts?: Context[];
  total?: number;
  limit?: number;
  offset?: number;
}

/**
 * Map the FE search params to the WIRE query the Command backend reads. The backend
 * (controllers/context.ts + ContextSearchQuerySchema) reads snake_case for ALL keys and
 * Zod-STRIPS unknown keys — so camelCase (`sortBy`/`sortOrder`/`projectId`/`sessionId`)
 * was silently dropped and the sort dropdown did nothing. Emit snake_case to match the
 * wire contract the other keys (date_from/min_similarity/…) already follow. Exported so
 * the contract can be pinned by a test (this drift is invisible at runtime otherwise).
 */
export const toQuery = (params: ContextSearchParams): Record<string, unknown> => ({
  query: params.query,
  project_id: params.project_id,
  session_id: params.session_id,
  type: params.type,
  tags: params.tags?.length ? params.tags.join(',') : undefined,
  min_similarity: params.min_similarity,
  date_from: params.date_from,
  date_to: params.date_to,
  limit: params.limit,
  offset: params.offset,
  sort_by: params.sort_by,
  sort_order: params.sort_order,
});

export const contextsApi = {
  /** GET /api/contexts — search/browse (query dispatches to the semantic engine). */
  async search(
    params: ContextSearchParams,
    config?: AxiosRequestConfig
  ): Promise<ContextSearchResult> {
    const body = await http.get<ApiEnvelope<ContextSearchData>>(
      '/contexts',
      withParams(config, toQuery(params))
    );
    const data = unwrapData(body, 'Failed to search contexts') ?? {};
    const limit = data.limit ?? params.limit ?? 20;
    const offset = data.offset ?? params.offset ?? 0;
    return {
      contexts: (data.contexts ?? []) as Context[],
      total: data.total ?? 0,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
    };
  },

  /** GET /api/contexts/:id */
  async get(id: string, config?: AxiosRequestConfig): Promise<Context> {
    const body = await http.get<ApiEnvelope<Context>>(
      `/contexts/${encodeURIComponent(id)}`,
      config
    );
    const context = unwrapData(body, 'Failed to fetch context');
    if (!context) {
      throw new Error('Context payload missing in response');
    }
    return context;
  },

  /**
   * POST /api/contexts — `context_store`, a `requireWriteProjectId` surface.
   *
   * `config` IS REQUIRED, and that is the guard (§A1). This controller resolves the
   * project from the RESOLVED WINNER — the header — not from the body, so an unscoped
   * call files the record in the user's DEFAULT project while the page shows another
   * one: no error, no red, the record simply never appears in the list on screen. A
   * required parameter makes that call unwriteable; a test could only notice it after
   * someone wrote it. Pass `usePageProject().scope()`.
   */
  async create(data: {
    content: string;
    type?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    projectId?: string;
  }, config: AxiosRequestConfig): Promise<Context> {
    const body = await http.post<ApiEnvelope<Context>>('/contexts', data, config);
    return unwrapData(body, 'Failed to create context');
  },

  /** PUT /api/contexts/:id */
  async update(
    id: string,
    updates: {
      content?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      relevance_score?: number;
      project_id?: string;
    },
    config?: AxiosRequestConfig
  ): Promise<Context> {
    const body = await http.put<ApiEnvelope<Context>>(
      `/contexts/${encodeURIComponent(id)}`,
      updates,
      config
    );
    const context = unwrapData(body, 'Failed to update context');
    if (!context) {
      throw new Error('Context update payload missing in response');
    }
    return context;
  },

  /** DELETE /api/contexts/:id */
  async remove(id: string, config?: AxiosRequestConfig): Promise<void> {
    const body = await http.del<ApiEnvelope<unknown>>(
      `/contexts/${encodeURIComponent(id)}`,
      config
    );
    unwrapData(body, 'Failed to delete context');
  },

  /**
   * POST /api/contexts/:id/restore — un-archive a soft-deleted context.
   * The undo for `remove` above: the row was never destroyed, only marked, so this puts
   * it back in the list, the counts and the export.
   */
  async restore(id: string, config?: AxiosRequestConfig): Promise<void> {
    const body = await http.post<ApiEnvelope<unknown>>(
      `/contexts/${encodeURIComponent(id)}/restore`,
      {},
      config
    );
    unwrapData(body, 'Failed to restore context');
  },

  /** DELETE /api/contexts/bulk/delete */
  async bulkDelete(ids: string[], config?: AxiosRequestConfig): Promise<{ deleted: number }> {
    const body = await http.del<ApiEnvelope<{ deleted?: number }>>(
      '/contexts/bulk/delete',
      withConfig(config, { data: { ids } })
    );
    return { deleted: unwrapData(body, 'Failed to bulk delete contexts')?.deleted ?? 0 };
  },

  /** POST /api/contexts/bulk/update */
  async bulkUpdate(
    ids: string[],
    updates: { project_id?: string; tags?: string[]; relevance_score?: number },
    config?: AxiosRequestConfig
  ): Promise<{ updated: number }> {
    const body = await http.post<ApiEnvelope<{ updated?: number }>>(
      '/contexts/bulk/update',
      { ids, updates },
      config
    );
    return { updated: unwrapData(body, 'Failed to bulk update contexts')?.updated ?? 0 };
  },

  /** GET /api/contexts/stats */
  async stats(config?: AxiosRequestConfig): Promise<ContextStats> {
    const body = await http.get<ApiEnvelope<ContextStats>>('/contexts/stats', config);
    return (unwrapData(body, 'Failed to fetch context statistics') ?? {}) as ContextStats;
  },

  /** GET /api/contexts/:id/related */
  async related(id: string, config?: AxiosRequestConfig): Promise<Context[]> {
    const body = await http.get<ApiEnvelope<Context[]>>(
      `/contexts/${encodeURIComponent(id)}/related`,
      config
    );
    return (unwrapData(body, 'Failed to fetch related contexts') ?? []) as Context[];
  },

  /**
   * GET /api/contexts/:id/links — the TYPED graph edges (the TreeWalker "thread box"
   * moat) touching this context, both directions, resolved to each target's title +
   * kind. This is STRUCTURE (real `links` rows), NOT the semantic `related` list —
   * never conflate the two.
   */
  async links(id: string, config?: AxiosRequestConfig): Promise<ContextLink[]> {
    const body = await http.get<ApiEnvelope<ContextLink[]>>(
      `/contexts/${encodeURIComponent(id)}/links`,
      config
    );
    return (unwrapData(body, 'Failed to fetch context links') ?? []) as ContextLink[];
  },

  /** GET /api/contexts/export — returns a downloadable Blob. */
  async export(
    params: ContextSearchParams,
    format: 'json' | 'csv' | 'md' = 'json',
    config?: AxiosRequestConfig
  ): Promise<Blob> {
    return http.get<Blob>(
      '/contexts/export',
      withConfig(config, {
        params: { ...toQuery(params), format },
        responseType: 'blob',
      })
    );
  },
};

export type ContextsApi = typeof contextsApi;
