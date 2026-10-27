/**
 * The unified, typed API client for the Command UI.
 *
 * `api.<domain>.<method>()` is the ONE way every screen talks to the backend. A
 * caller NEVER has to know which backend or path family serves a call: the
 * Command backend (`/api/*`) vs mcp-server (`/api/v2/*`) split is an internal
 * ownership boundary hidden inside each domain method (see `domains/sessions.ts`
 * for the canonical example — `api.sessions.list()` hits `/api/sessions` while
 * `api.sessions.start()` hits `/api/v2/sessions/start`, and the caller can't tell).
 *
 * Everything rides ONE axios instance (services/api `apiClient`) via the typed
 * `http` layer (src/api/request.ts): bearer token, X-Project-ID self-heal, the
 * discriminating 401 force-logout, correlation id, Sentry breadcrumbs, and the
 * host-agnostic relative `/api` base. Response TYPES reuse the generated OpenAPI
 * models so no type information is lost by moving off the generated fetch client.
 *
 * WIRED LIVE onto this client today: auth (login/logout/profile/refresh) + contexts
 * (the whole domain — the P2 Contexts screen calls `api.contexts.*` directly; the old
 * `contextsClient` shim was retired when that screen was rebuilt). The other domains
 * expose real, typed methods and are adopted screen-by-screen during the redesign
 * phases — none is a `throw new Error('todo')` stub.
 */
import { authApi } from './domains/auth';
import { contextsApi } from './domains/contexts';
import { projectsApi } from './domains/projects';
import { sessionsApi } from './domains/sessions';
import { tasksApi } from './domains/tasks';
import { attachmentsApi } from './domains/attachments';
import { decisionsApi } from './domains/decisions';
import { dashboardApi } from './domains/dashboard';
import { embeddingApi } from './domains/embedding';
import { monitoringApi } from './domains/monitoring';
import { usersApi } from './domains/users';
import { apiTokensApi } from './domains/apiTokens';
import { feedbackApi } from './domains/feedback';
import { resolveApi } from './domains/resolve';
import { treewalkerApi } from './domains/treewalker';
import { metaApi } from './domains/meta';
import { daySummaryApi } from './domains/daySummary';
import { momentumSeriesApi } from './domains/momentumSeries';

export const api = {
  auth: authApi,
  contexts: contextsApi,
  projects: projectsApi,
  sessions: sessionsApi,
  tasks: tasksApi,
  attachments: attachmentsApi,
  decisions: decisionsApi,
  dashboard: dashboardApi,
  embedding: embeddingApi,
  monitoring: monitoringApi,
  users: usersApi,
  apiTokens: apiTokensApi,
  feedback: feedbackApi,
  resolve: resolveApi,
  treewalker: treewalkerApi,
  meta: metaApi,
  daySummary: daySummaryApi,
  momentumSeries: momentumSeriesApi,
} as const;

export type Api = typeof api;

// The transport + envelope helpers, for advanced callers / tests.
export { http, unwrapData, type ApiEnvelope, type ApiError } from './request';

export default api;
