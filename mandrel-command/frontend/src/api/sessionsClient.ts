import { SessionsService, type ApiSuccessResponse } from './generated';
import type { Session, SessionDetail, UpdateSessionRequest, FileSyncResponse, SessionFile } from '../types/session';
import type { SessionCurrentResponse } from './generated/models/SessionCurrentResponse';

import type { UpdateSession } from './generated/models/UpdateSession';

// Base URL for REST API endpoints (not in generated client)
// Configurable via VITE_MCP_URL environment variable
// Defaults to '' (same-origin) so REST_API_BASE is the relative '/api/v2', which
// nginx routes to the AUTHENTICATED backend proxy. This makes these calls work
// from a hosted browser (no cross-origin to localhost:8080).
const MCP_BASE_URL = import.meta.env.VITE_MCP_URL || '';
const REST_API_BASE = `${MCP_BASE_URL}/api/v2`;

// Build headers for the REST API fetch calls, including the JWT the OpenAPI client
// uses (localStorage 'aidis_token'), so the authenticated backend proxy accepts them.
const restHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = localStorage.getItem('aidis_token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
};

const ensureSuccess = <T extends ApiSuccessResponse>(response: T, failureMessage: string): T => {
  if (!response.success) {
    throw new Error(failureMessage);
  }
  return response;
};

export const sessionsClient = {
  async getSessionDetail(sessionId: string): Promise<SessionDetail> {
    // Call backend /api/sessions/:id endpoint (Phase 2.2)
    const response = await SessionsService.getSessions1({ id: sessionId });
    
    if (!response.success || !response.data?.session) {
      throw new Error('Session detail payload missing in response');
    }

    return response.data.session as SessionDetail;
  },

  async getCurrentSession(): Promise<Session | null> {
    const raw = await SessionsService.getSessionsCurrent() as ApiSuccessResponse & {
      data?: SessionCurrentResponse;
    };

    const response = ensureSuccess(raw, 'Failed to fetch current session');
    return (response.data?.session ?? null) as Session | null;
  },

  async updateSession(sessionId: string, updates: UpdateSessionRequest): Promise<Session> {
    const response = ensureSuccess(
      await SessionsService.putSessions({
        id: sessionId,
        requestBody: updates as UpdateSession,
      }) as ApiSuccessResponse & { data?: { session?: Session } },
      'Failed to update session'
    );

    const session = response.data?.session;
    if (!session) {
      throw new Error('Session update payload missing in response');
    }

    return session;
  },

  /**
   * Sync files from git diff for a session
   * Calls the REST API endpoint directly (not in generated client)
   */
  async syncFilesFromGit(sessionId: string): Promise<FileSyncResponse> {
    const response = await fetch(`${REST_API_BASE}/sessions/${sessionId}/sync-files`, {
      method: 'POST',
      headers: restHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to sync files: ${response.statusText}`);
    }

    return response.json();
  },

  /**
   * Get files modified in a session
   * Calls the REST API endpoint directly (not in generated client)
   */
  async getSessionFiles(sessionId: string): Promise<SessionFile[]> {
    const response = await fetch(`${REST_API_BASE}/sessions/${sessionId}/files`, {
      method: 'GET',
      headers: restHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get session files: ${response.statusText}`);
    }

    const result = await response.json();
    return result.data?.files || [];
  },

  /**
   * Get active session
   * Calls the REST API endpoint directly (new manual session control)
   */
  async getActiveSession(): Promise<SessionDetail | null> {
    const response = await fetch(`${REST_API_BASE}/sessions/active`, {
      method: 'GET',
      headers: restHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get active session: ${response.statusText}`);
    }

    const result = await response.json();
    return result.data as SessionDetail | null;
  },

  /**
   * Get all active sessions (sessions without ended_at)
   * Useful for showing multiple active sessions
   */
  async getAllActiveSessions(): Promise<Session[]> {
    const response = await fetch(`${REST_API_BASE}/sessions?limit=100`, {
      method: 'GET',
      headers: restHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get sessions: ${response.statusText}`);
    }

    const result = await response.json();
    const sessions = result.data?.sessions || [];

    // Filter for active sessions (no ended_at)
    return sessions.filter((s: Session) => !s.ended_at);
  },

  /**
   * Start a new session
   * Calls the REST API endpoint directly (new manual session control)
   */
  async startSession(params?: {
    projectId?: string;
    title?: string;
    description?: string;
    sessionGoal?: string;
    tags?: string[];
    aiModel?: string;
    sessionType?: 'mcp-server' | 'AI Model';
  }): Promise<SessionDetail> {
    const response = await fetch(`${REST_API_BASE}/sessions/start`, {
      method: 'POST',
      headers: restHeaders(),
      body: JSON.stringify(params || {}),
    });

    if (!response.ok) {
      throw new Error(`Failed to start session: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.success || !result.data) {
      throw new Error('Session start failed: No session data returned');
    }

    return result.data as SessionDetail;
  },

  /**
   * End a session
   * Calls the REST API endpoint directly (new manual session control)
   */
  async endSession(sessionId: string): Promise<SessionDetail> {
    const response = await fetch(`${REST_API_BASE}/sessions/${sessionId}/end`, {
      method: 'POST',
      headers: restHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to end session: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.success || !result.data) {
      throw new Error('Session end failed: No session data returned');
    }

    return result.data as SessionDetail;
  },
};

export default sessionsClient;