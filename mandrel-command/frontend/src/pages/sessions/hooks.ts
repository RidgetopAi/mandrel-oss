/**
 * Sessions data hooks — every read/write rides the UNIFIED client (`api.<domain>.*`)
 * through react-query, mirroring the Dashboard reference. NO axios/generated clients
 * here. The list feeds the accordion; the detail lazy-loads when a stream expands;
 * the projects list feeds the filter; the mutation edits a session's metadata.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxiosRequestConfig } from 'axios';
import { api } from '../../api';
import type { Session, SessionDetail, UpdateSessionRequest } from '../../types/session';
import { SESSIONS_CONFIG } from './config';

/**
 * The fields `/api/sessions` serialises that the Sessions list actually renders.
 * The read model now serialises `actor` — the "who ran it"
 * attribution (e.g. "coordinator", "tick", or null when unstamped). It drives the
 * per-card actor chip and the actor filter; it is NOT an authz boundary.
 */
export interface SessionListRow {
  id: string;
  display_id?: string;
  project_id?: string;
  project_name?: string;
  title?: string;
  description?: string;
  session_goal?: string;
  tags?: string[];
  ai_model?: string;
  session_type?: string;
  status?: string;
  /** Who ran the session (attribution). Null for unstamped / pre-actor sessions. */
  actor?: string | null;
  started_at?: string;
  created_at?: string;
  ended_at?: string | null;
  last_activity_at?: string;
  last_context_at?: string;
  /**
   * pg NUMERIC/BIGINT come back as strings — parse at the callsite.
   * Tokens are the ONE metric with no child table: they cannot be recomputed, so this is
   * the raw `sessions.total_tokens` column. Sessions finalized before an earlier task had
   * their token history destroyed and will legitimately read 0 forever.
   */
  total_tokens?: string | number;
  /**
   * Every count below is DERIVED server-side from the child tables (contexts / tasks /
   * technical_decisions by session_id) — never the denormalized `sessions.*_created`
   * counters, which SessionRepo.finish() zeroed on every session end.
   * The `*_created` name and its `*_count` sibling carry the SAME derived value, so the
   * old defensive `contexts_created ?? context_count` chain is no longer meaningful:
   * read ONE field. Chains are what let a broken `0` win over a correct fallback, since
   * `??` only falls through on null/undefined.
   */
  contexts_created?: number;
  context_count?: number;
  tasks_created?: number;
  task_count?: number;
  decisions_created?: number;
  decision_count?: number;
  files_modified_count?: number;
}

/**
 * GET /api/sessions — the page's sessions, newest first (Command backend, Postgres).
 *
 * ── THE PROJECT FILTER IS SERVER-SIDE (page-scope epic §E) ─────────────────────────────
 * It used to be applied CLIENT-SIDE, over whatever the un-filtered `limit`-capped page
 * happened to contain. That is not a filter, it is a filter-shaped subset: with the cap
 * at `SESSIONS_CONFIG.listLimit`, a project whose sessions are all older than the newest
 * N across every project renders as "No sessions" — correct-looking, and wrong. It also
 * meant every project's rows crossed the wire to draw one project's screen.
 *
 * `/api/sessions` already resolves its scope server-side through `resolveListScope`
 * (backend/src/services/projectListScope.ts), so the fix is to NAME the project rather
 * than to fetch everything and hide most of it.
 *
 * `projectId` is passed RAW, `'all'` included: the backend reads `'all'` on a query source
 * as EXPLICITLY UNSCOPED (projectScopeResolver's `UNSCOPED_SENTINEL`), which is a
 * different, deliberate request from omitting the param — omitting it means "scope me by
 * the ambient header", i.e. the user's default project, which is not what the page shows.
 *
 * `scope` is the page's per-request scope (`usePageProject().scope`). Passing it is what
 * keeps the header on THIS page's project instead of the pinned ambient default.
 *
 * Pass `actor` to slice the list to one actor server-side (the `?actor=` param);
 * omit it for the full, unsliced list. Both `projectId` and `actor` are part of
 * the query key, so changing either re-fetches rather than serving the last one's rows.
 */
export function useSessions(args: {
  projectId: string | undefined;
  scope: () => AxiosRequestConfig;
  enabled: boolean;
  actor?: string;
}) {
  const { projectId, scope, enabled, actor } = args;
  return useQuery<SessionListRow[]>({
    queryKey: ['sessions', 'list', SESSIONS_CONFIG.listLimit, projectId ?? null, actor ?? null],
    enabled,
    queryFn: async () => {
      const rows = (await api.sessions.list(
        {
          limit: SESSIONS_CONFIG.listLimit,
          ...(projectId ? { project_id: projectId } : {}),
          ...(actor ? { actor } : {}),
        },
        scope()
      )) as Session[];
      return rows as unknown as SessionListRow[];
    },
    staleTime: SESSIONS_CONFIG.staleTimeMs,
  });
}

/** GET /api/sessions/:id — full session detail, lazy (only when a stream expands). */
export function useSessionDetail(id: string | null, enabled: boolean) {
  return useQuery<SessionDetail>({
    queryKey: ['sessions', 'detail', id],
    queryFn: () => api.sessions.get(id as string),
    enabled: Boolean(id) && enabled,
    staleTime: SESSIONS_CONFIG.staleTimeMs,
  });
}



/** PUT /api/sessions/:id — edit title/description/goal/tags, then refresh the list. */
export function useUpdateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: UpdateSessionRequest }) =>
      api.sessions.update(id, updates),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['sessions', 'list'] });
      qc.invalidateQueries({ queryKey: ['sessions', 'detail', id] });
    },
  });
}

/**
 * The metadata a human can attach when manually starting a session. Every field is
 * optional — a bare start lets the backend auto-detect the project and stamp the
 * actor from the authenticated principal (see mcp-server startSession handler). This
 * is intentionally the MINIMAL manual-control surface (title + project); the richer
 * start form (AI model, goal, tags) is deferred to the Sessions IA redesign.
 */
export interface StartSessionInput {
  projectId?: string;
  title?: string;
}

/**
 * POST /api/v2/sessions/start — the manual "New session" control.
 * Wires the previously-orphaned `api.sessions.start` lifecycle method to a real call
 * site, then refreshes the list + the current-session read so the new session shows
 * up immediately.
 */
export function useStartSession() {
  const qc = useQueryClient();
  return useMutation({
    // A WRITE. `scope` is NOT optional decoration: a write carries no query param and the
    // backend's write precedence is HEADER > body, so an unscoped start is filed against
    // the ambient DEFAULT project rather than the one chosen here (page-scope epic §A1).
    mutationFn: ({ input, scope }: { input?: StartSessionInput; scope: AxiosRequestConfig }) =>
      api.sessions.start(input, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'list'] });
      qc.invalidateQueries({ queryKey: ['sessions', 'current'] });
    },
  });
}

/**
 * POST /api/v2/sessions/:id/end — the manual "End session" control.
 * Wires the previously-orphaned `api.sessions.end` lifecycle method to a real call
 * site so a human can close a sitting (agent/human sessions otherwise hold ONE
 * session until explicitly ended). Refreshes the list + this session's detail.
 */
export function useEndSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.sessions.end(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['sessions', 'list'] });
      qc.invalidateQueries({ queryKey: ['sessions', 'detail', id] });
    },
  });
}
