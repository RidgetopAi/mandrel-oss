/**
 * Session-detail data hooks — every read rides the UNIFIED client (`api.sessions.*`)
 * through react-query, mirroring the Sessions LIST + ProjectDetail references. The
 * detail read serves the header stats + the Contexts/Tasks/Decisions/Timeline tabs; the
 * files read serves the Files tab from its own analytics endpoint. Each owns its own
 * loading/empty/error. NO axios / generated / old sessionsClient here.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { SessionDetail, SessionFile } from '../../types/session';
import { SESSION_DETAIL_CONFIG } from './config';

/**
 * The session detail as this screen reads it. `api.sessions.get` returns the typed
 * `SessionDetail` (extends SessionEntity); the Command backend also serialises a
 * `created_at` on the detail payload that the generated SessionEntity omits, so we
 * augment it here rather than reach past the type.
 */
export type SessionDetailView = SessionDetail & { created_at?: string };

/** GET /api/sessions/:id — full session detail (header + contexts/tasks/decisions). */
export function useSessionDetail(id: string | null | undefined, enabled: boolean) {
  return useQuery<SessionDetailView>({
    queryKey: ['sessions', 'detail', id],
    queryFn: () => api.sessions.get(id as string) as Promise<SessionDetailView>,
    enabled: Boolean(id) && enabled,
    staleTime: SESSION_DETAIL_CONFIG.detailStaleMs,
  });
}

/** GET /api/v2/sessions/:id/files — files modified in the session (Files tab). */
export function useSessionFiles(id: string | null | undefined, enabled: boolean) {
  return useQuery<SessionFile[]>({
    queryKey: ['sessions', 'files', id],
    queryFn: () => api.sessions.files(id as string),
    enabled: Boolean(id) && enabled,
    staleTime: SESSION_DETAIL_CONFIG.filesStaleMs,
  });
}
