/**
 * sessions domain — the clearest demonstration of the client hiding the backend
 * split. Two backends own "sessions":
 *
 *   • the Command backend (`/api/sessions/*`) owns the ANALYTICS reads (Postgres);
 *   • mcp-server (`/api/v2/sessions/*`, proxied) owns the LIFECYCLE (start/end/active).
 *
 * `/api/v2` is NOT a version — it is that ownership boundary leaking into the URL.
 * The caller of `api.sessions.list()` (→ `/api/sessions`) vs `api.sessions.start()`
 * (→ `/api/v2/sessions/start`) CANNOT tell which backend serves it: both go through
 * the same shared instance whose baseURL is `/api`, so the domain method just picks
 * `/sessions` vs `/v2/sessions/start` as the path. When the backends are eventually
 * deduped, only these paths change — no screen does.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';
import { withParams } from './scopeConfig';
import { getBrowserTimeZone } from '../../utils/browserTimeZone';
import type {
  Session,
  SessionDetail,
  SessionFile,
  FileSyncResponse,
  UpdateSessionRequest,
} from '../../types/session';

interface SessionListData {
  sessions?: Session[];
  total?: number;
}

/**
 * Query params for `GET /api/sessions` (Command backend). All optional. `actor`
 * slices by the "who" dimension (the stable principal that owns a session) — the
 * backend validates/normalizes it and drops an invalid value rather than 500ing.
 */
export interface SessionListParams {
  project_id?: string;
  status?: string;
  actor?: string;
  limit?: number;
  offset?: number;
}

/**
 * One day of workspace-activity totals (`GET /api/sessions/trends`). The read
 * model the Analytics AreaChart + the Dashboard "Workspace activity" card share.
 */
export interface SessionTrendPoint {
  date: string;
  session_count: number;
  total_tokens_used: number;
  total_contexts: number;
  total_tasks_created: number;
  /**
   * Tasks COMPLETED that day, counted by the task's own `completed_at` — not by the
   * date of whatever session closed it, and not by `created_at`. This is
   * the field the Analytics hero + KPI strip plot as their activity indicator, in the
   * slot the deleted `MCP payload (est.)` metric used to hold.
   */
  total_tasks_completed: number;
  total_duration_minutes?: number;
  average_duration_minutes?: number;
}

/**
 * One row of the ranked "Most active sessions" list (`GET /api/sessions/productive`),
 * ordered by CONTEXTS CREATED in the requested window.
 *
 * `productivity_score` is gone from this payload (item 3c) — the backend
 * type of the same name carries the measurement and the reasoning. `actor` / `actor_kind`
 * are the "who": the kind is classified SERVER-side from the first-party actor registry,
 * the same way `ActorContextCount.kind` is and for the same reason.
 */
export interface ProductiveSession {
  id: string;
  project_id: string;
  project_name?: string;
  actor: string | null;
  actor_kind: ActorKind | null;
  created_at: string;
  duration_minutes: number;
  context_count: number;
  tokens_used: number;
  context_summary?: string;
}

/**
 * One hour-of-day bucket (`GET /api/sessions/token-patterns`) — 24 rows, hour 0..23,
 * gap-filled by the backend (generate_series), bucketed in the VIEWER's timezone and
 * bounded by the requested window.
 *
 * `session_count` is sessions that STARTED in that local hour. `total_tokens` is the
 * whole-session token figure of those same sessions, which is a true statement about
 * sessions-that-started-then and NOT a statement about when the tokens were spent —
 * see the service doc-comment for why the panel is drawn in `session_count`.
 */
export interface TokenUsagePattern {
  hour: number;
  total_tokens: number;
  session_count: number;
  average_tokens_per_session: number;
}

/**
 * The principal kinds an actor classifies to. MIRRORS the backend `ActorKind` union as a
 * TYPE only — this file carries no registry and no classification rule, because the
 * registry is already mirrored twice behind a set-equality drift guard and a third copy
 * would be one that guard does not cover. The server sends the answer; this names it.
 */
export type ActorKind = 'human' | 'agent' | 'automation';

/** One actor's share of the contexts created in the window (verbatim actor slug). */
export interface ActorContextCount {
  actor: string;
  context_count: number;
  /** The server's classification, or `null` when the registry does not know this actor. */
  kind: ActorKind | null;
}

/**
 * `GET /api/sessions/contexts-by-actor` — the by-actor read model behind the Analytics
 * "Activity by actor" panel. The bars AND their coverage line come from this ONE payload,
 * in ONE unit (contexts), so the chart and the sentence above it cannot disagree.
 *
 * `actors` is NOT truncated by the server: the top-N cut and the "Other" roll-up are a
 * presentation choice and live in `pages/analytics/config.ts`, so the totals here always
 * describe the whole population the bars were cut from.
 */
export interface ContextsByActor {
  actors: ActorContextCount[];
  /** Sum of `actors[].context_count`. */
  attributed_contexts: number;
  /** Contexts whose owning session carries no actor, plus contexts with no session. */
  unattributed_contexts: number;
  total_contexts: number;
  /**
   * The user-vs-automation split of `attributed_contexts` (they sum to it exactly).
   * `unknown_kind_contexts` is an actor the registry does not recognise — the absence of
   * the classification, folded into the coverage line rather than drawn as a third group.
   */
  user_driven_contexts: number;
  automated_contexts: number;
  unknown_kind_contexts: number;
  /** The window the server actually used, after clamping. */
  days: number;
}

export const sessionsApi = {
  // ---- Command backend: analytics reads (`/api/sessions/*`) -------------------

  /** GET /api/sessions — list sessions (Command backend, Postgres). */
  async list(params?: SessionListParams, config?: AxiosRequestConfig): Promise<Session[]> {
    const body = await http.get<ApiEnvelope<SessionListData>>(
      '/sessions',
      withParams(config, (params ?? {}) as Record<string, unknown>)
    );
    return (unwrapData(body, 'Failed to list sessions')?.sessions ?? []) as Session[];
  },

  /**
   * GET /api/sessions/trends?days= — per-day activity totals (Command backend).
   * The time-series behind the Dashboard "Workspace activity" trend and the
   * Analytics page AreaChart. `projectId` scopes it; omit for Mandrel-wide.
   */
  async trends(params?: {
    days?: number;
    projectId?: string;
    /** Slice/group the time series by the owning principal (the "who" dimension). */
    actor?: string;
  }, config?: AxiosRequestConfig): Promise<SessionTrendPoint[]> {
    // Send the viewer's tz so the backend buckets each day in local time —
    // otherwise an evening-local session lands on the wrong calendar cell. Absent → UTC.
    const tz = getBrowserTimeZone();
    const body = await http.get<ApiEnvelope<SessionTrendPoint[]>>(
      '/sessions/trends',
      withParams(config, {
        ...(params?.days != null ? { days: params.days } : {}),
        ...(params?.projectId ? { project_id: params.projectId } : {}),
        ...(params?.actor ? { actor: params.actor } : {}),
        ...(tz ? { tz } : {}),
      })
    );
    return (unwrapData(body, 'Failed to fetch session trends') ?? []) as SessionTrendPoint[];
  },

  /**
   * GET /api/sessions/contexts-by-actor — contexts created in the window, grouped by
   * the owning session's actor, WITH the coverage totals for the same window+scope.
   * `projectId` scopes it; `days` is the same pivot window the trends read uses. Sends
   * the viewer's tz for the same reason `trends` does — the day window is a LOCAL one.
   */
  async contextsByActor(
    params?: { days?: number; projectId?: string },
    config?: AxiosRequestConfig
  ): Promise<ContextsByActor> {
    const tz = getBrowserTimeZone();
    const body = await http.get<ApiEnvelope<ContextsByActor>>(
      '/sessions/contexts-by-actor',
      withParams(config, {
        ...(params?.days != null ? { days: params.days } : {}),
        ...(params?.projectId ? { project_id: params.projectId } : {}),
        ...(tz ? { tz } : {}),
      })
    );
    // No `?? []` fallback shape here: an absent payload means the read FAILED, and a
    // fabricated zero-coverage object would render the onboarding prompt ("nothing is
    // attributed yet") for what is actually an error. unwrapData throws instead.
    return unwrapData(body, 'Failed to fetch contexts by actor') as ContextsByActor;
  },

  /**
   * GET /api/sessions/productive — the most productive sessions, ranked by the
   * backend's productivity score (Command backend, BUILT). `projectId` scopes it.
   */
  async productive(
    params?: { limit?: number; projectId?: string; days?: number },
    config?: AxiosRequestConfig
  ): Promise<ProductiveSession[]> {
    const body = await http.get<ApiEnvelope<{ sessions?: ProductiveSession[] }>>(
      '/sessions/productive',
      withParams(config, {
        ...(params?.limit != null ? { limit: params.limit } : {}),
        ...(params?.projectId ? { project_id: params.projectId } : {}),
        // `days` was never sent, so this read answered ALL TIME under the Analytics page's
        // range control (item 3a).
        ...(params?.days != null ? { days: params.days } : {}),
      })
    );
    return (unwrapData(body, 'Failed to fetch productive sessions')?.sessions ?? []) as ProductiveSession[];
  },

  /**
   * GET /api/sessions/token-patterns — token usage bucketed by hour of day (24
   * gap-filled rows; Command backend, BUILT). `projectId` scopes it.
   */
  async tokenPatterns(
    params?: { days?: number; projectId?: string },
    config?: AxiosRequestConfig
  ): Promise<TokenUsagePattern[]> {
    // `days` + `tz` are sent for the same reason `contextsByActor` sends them: this read
    // sits under the page's range control and buckets by hour-of-day, so a request that
    // omits either is answered in the wrong window or in the wrong zone.
    const tz = getBrowserTimeZone();
    const body = await http.get<ApiEnvelope<{ patterns?: TokenUsagePattern[] }>>(
      '/sessions/token-patterns',
      withParams(config, {
        ...(params?.days != null ? { days: params.days } : {}),
        ...(params?.projectId ? { project_id: params.projectId } : {}),
        ...(tz ? { tz } : {}),
      })
    );
    return (unwrapData(body, 'Failed to fetch token patterns')?.patterns ?? []) as TokenUsagePattern[];
  },

  /** GET /api/sessions/:id — session detail (Command backend). */
  async get(id: string, config?: AxiosRequestConfig): Promise<SessionDetail> {
    const body = await http.get<ApiEnvelope<{ session?: SessionDetail }>>(
      `/sessions/${encodeURIComponent(id)}`,
      config
    );
    const session = unwrapData(body, 'Failed to fetch session')?.session;
    if (!session) {
      throw new Error('Session detail payload missing in response');
    }
    return session;
  },

  /** GET /api/sessions/current — the current session (Command backend). */
  async current(config?: AxiosRequestConfig): Promise<Session | null> {
    const body = await http.get<ApiEnvelope<{ session?: Session }>>('/sessions/current', config);
    return (unwrapData(body, 'Failed to fetch current session')?.session ?? null) as Session | null;
  },

  /** PUT /api/sessions/:id — edit title/description/tags (Command backend). */
  async update(
    id: string,
    updates: UpdateSessionRequest,
    config?: AxiosRequestConfig
  ): Promise<Session> {
    const body = await http.put<ApiEnvelope<{ session?: Session }>>(
      `/sessions/${encodeURIComponent(id)}`,
      updates,
      config
    );
    const session = unwrapData(body, 'Failed to update session')?.session;
    if (!session) {
      throw new Error('Session update payload missing in response');
    }
    return session;
  },

  // ---- mcp-server: lifecycle (`/api/v2/sessions/*`, proxied) ------------------
  // Same shared instance; the caller cannot tell these hit a different backend.

  /** POST /api/v2/sessions/start — start a session (stamps X-Actor-ID from JWT). */
  async start(params?: {
    projectId?: string;
    title?: string;
    description?: string;
    sessionGoal?: string;
    tags?: string[];
    aiModel?: string;
    sessionType?: 'mcp-server' | 'AI Model';
  }, config?: AxiosRequestConfig): Promise<SessionDetail> {
    const body = await http.post<ApiEnvelope<SessionDetail>>(
      '/v2/sessions/start',
      params ?? {},
      config
    );
    const session = unwrapData(body, 'Failed to start session');
    if (!session) {
      throw new Error('Session start failed: No session data returned');
    }
    return session;
  },

  /** POST /api/v2/sessions/:id/end — end a session. */
  async end(id: string, config?: AxiosRequestConfig): Promise<SessionDetail> {
    const body = await http.post<ApiEnvelope<SessionDetail>>(
      `/v2/sessions/${encodeURIComponent(id)}/end`,
      undefined,
      config
    );
    const session = unwrapData(body, 'Failed to end session');
    if (!session) {
      throw new Error('Session end failed: No session data returned');
    }
    return session;
  },

  /** GET /api/v2/sessions/active — the active session. */
  async active(config?: AxiosRequestConfig): Promise<SessionDetail | null> {
    const body = await http.get<ApiEnvelope<SessionDetail>>('/v2/sessions/active', config);
    return (unwrapData(body, 'Failed to get active session') ?? null) as SessionDetail | null;
  },

  /** GET /api/v2/sessions/:id/files — files modified in a session. */
  async files(id: string, config?: AxiosRequestConfig): Promise<SessionFile[]> {
    const body = await http.get<ApiEnvelope<{ files?: SessionFile[] }>>(
      `/v2/sessions/${encodeURIComponent(id)}/files`,
      config
    );
    return (unwrapData(body, 'Failed to get session files')?.files ?? []) as SessionFile[];
  },

  /** POST /api/v2/sessions/:id/sync-files — trigger a git file sync. */
  async syncFiles(id: string, config?: AxiosRequestConfig): Promise<FileSyncResponse> {
    return http.post<FileSyncResponse>(
      `/v2/sessions/${encodeURIComponent(id)}/sync-files`,
      undefined,
      config
    );
  },
};

export type SessionsApi = typeof sessionsApi;
