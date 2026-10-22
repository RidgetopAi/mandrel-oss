import { Router, Request, Response , type RequestParamHandler } from 'express';
import { SessionController } from '../controllers/session';
import { authenticateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../types/auth';
import { validateUUIDParam } from '../middleware/validation';
import { logger } from '../config/logger';
import { McpService } from '../services/mcp';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

/**
 * sessionsProxy — the `/api/v2/sessions/*` family (mounted at `/v2/sessions` in
 * routes/index.ts). This is the browser-facing session read + lifecycle surface: it
 * serves real session data (ids, project names, timestamps, modified files) and proxies
 * the lifecycle writes (start/end) to the mcp-server.
 *
 * SECURITY: every route here returns/acts on real session data, so the
 * ENTIRE family is gated behind `authenticateToken` in ONE place — the `router.use(...)`
 * below, applied before any route. This is the class fix: a new
 * `/v2/sessions/*` route added to this file is authenticated by construction, so no
 * future route can silently be born public (which is exactly how the pre-fix exposure —
 * unauthenticated `/api/v2/sessions*` on the public internet — happened). It reuses the
 * SAME `authenticateToken` the rest of `/api` uses (one auth source, no second path).
 *
 * MUTATION-PROBE: delete the `router.use(authenticateToken)` line and every 401 test in
 * sessionRoutesAuth.test.ts must fail — that is what proves the tests catch a regression.
 */
const router = Router();

// Prefer an explicit MCP base URL (needed in containerized deploys where the MCP
// server is a sibling container reachable by service name, NOT localhost). Fall
// back to host:port form for same-namespace/dev deploys.
const MCP_BASE =
  process.env.MANDREL_MCP_URL ||
  `http://localhost:${process.env.MANDREL_MCP_PORT || process.env.AIDIS_MCP_PORT || '8080'}`;

// Deprecation warning for AIDIS_MCP_PORT
if (process.env.AIDIS_MCP_PORT && !process.env.MANDREL_MCP_PORT) {
  logger.warn('⚠️  AIDIS_MCP_PORT is deprecated. Please use MANDREL_MCP_PORT instead.');
}

// ── THE GATE ────────────────────────────────────────────────────────────────
// One line guards the whole family. Registered before every route below.
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /:sessionId/files and the v2 session lifecycle proxy.
 * Registered as `router.param`, so it runs during ROUTING for every route on this router
 * that carries `:sessionId` — including ones nobody has written yet. That inheritance is the
 * whole point; the list-shaped alternative is what left these open while
 * `/api/projects/:id` next door was tight.
 *
 * Fail-closed and NON-DISCLOSING: a row that does not exist and a row the caller may not
 * have both answer 403, matching authorizeProjectPathParam. See services/entityProjectScope.ts.
 */
const authorizeSessionIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeEntityPathParam('session')(
    req as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[0],
    res as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[1],
    next,
    String(value)
  );
router.param('sessionId', authorizeSessionIdParam);


/**
 * Headers for every OUTBOUND fetch this proxy makes to the mcp-server's now-gated
 * `/api/v2/sessions/*` REST family. SECURITY (an earlier task trust boundary): the mcp-server
 * gates that family behind the INTERNAL SERVICE TOKEN (MCP_AUTH_TOKEN); this backend is the
 * single authenticated caller, so it MUST present that token on EVERY proxied request or the
 * mcp-server returns 401. ONE source — McpService.authHeader() (← config.mcp.authToken) — so
 * no handler here can drift or be born token-less. The token value is never logged
 *. `extra` merges per-call headers (e.g. X-Actor-ID) without duplicating the token
 * logic. Content-Type is set first so a caller can never accidentally override the auth header.
 */
function mcpProxyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', ...McpService.authHeader(), ...extra };
}

/**
 * GET /api/v2/sessions/current - current active session.
 *
 * Delegates to the SAME controller as the legacy `/api/sessions/current` so the
 * consistent v2 path resolves. Declared BEFORE the parameterized `/:sessionId/*`
 * proxies so "current" is matched as a literal segment and never captured as a
 * :sessionId.
 */
router.get('/current', SessionController.getCurrentSession);

/**
 * Proxy GET /api/v2/sessions/:sessionId/files to MCP server
 */
router.get('/:sessionId/files', validateUUIDParam('sessionId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const url = `${MCP_BASE}/api/v2/sessions/${sessionId}/files`;

    const response = await fetch(url, {
      method: 'GET',
      headers: mcpProxyHeaders(),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error('MCP proxy error (GET files)', { error });
    res.status(503).json({
      success: false,
      error: 'MCP service unavailable',
      message: error instanceof Error ? error.message : 'Failed to proxy request to MCP server'
    });
  }
});

/**
 * Proxy POST /api/v2/sessions/:sessionId/sync-files to MCP server
 */
router.post(
  '/:sessionId/sync-files',
  declareAnyAuthenticatedMayWrite('syncing the file list of a session; additive'),
  validateUUIDParam('sessionId'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const url = `${MCP_BASE}/api/v2/sessions/${sessionId}/sync-files`;

    const response = await fetch(url, {
      method: 'POST',
      headers: mcpProxyHeaders(),
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error('MCP proxy error (POST sync-files)', { error });
    res.status(503).json({
      success: false,
      error: 'MCP service unavailable',
      message: error instanceof Error ? error.message : 'Failed to proxy request to MCP server'
    });
  }
});

/**
 * Proxy POST /api/v2/sessions/start to MCP server.
 * Forwards to the (unauth) MCP REST endpoint; auth is enforced by the family gate above.
 */
router.post(
  '/start',
  declareAnyAuthenticatedMayWrite('starting a session is ordinary user work'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const url = `${MCP_BASE}/api/v2/sessions/start`;

    // Sessions Foundation Phase 1: derive the ACTOR from the AUTHENTICATED user (the JWT
    // principal the gate just verified) and forward it as X-Actor-ID — NEVER from client
    // say-so. So the session the mcp-server creates is attributed to the logged-in human
    // instead of `anonymous`.
    const authedActor = (req as AuthenticatedRequest).user?.username;
    const extra: Record<string, string> = {};
    if (authedActor && authedActor.trim() !== '') extra['X-Actor-ID'] = authedActor.trim();

    const response = await fetch(url, {
      method: 'POST',
      headers: mcpProxyHeaders(extra),
      body: JSON.stringify(req.body || {}),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error('MCP proxy error (POST sessions/start)', { error });
    res.status(503).json({
      success: false,
      error: 'MCP service unavailable',
      message: error instanceof Error ? error.message : 'Failed to proxy request to MCP server'
    });
  }
});

/**
 * Proxy GET /api/v2/sessions/active to MCP server.
 */
router.get('/active', async (_req: Request, res: Response): Promise<void> => {
  try {
    const url = `${MCP_BASE}/api/v2/sessions/active`;

    const response = await fetch(url, {
      method: 'GET',
      headers: mcpProxyHeaders(),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error('MCP proxy error (GET sessions/active)', { error });
    res.status(503).json({
      success: false,
      error: 'MCP service unavailable',
      message: error instanceof Error ? error.message : 'Failed to proxy request to MCP server'
    });
  }
});

/**
 * Proxy POST /api/v2/sessions/:sessionId/end to MCP server.
 */
router.post(
  '/:sessionId/end',
  declareAnyAuthenticatedMayWrite('ending a session is ordinary user work'),
  validateUUIDParam('sessionId'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const url = `${MCP_BASE}/api/v2/sessions/${sessionId}/end`;

    const response = await fetch(url, {
      method: 'POST',
      headers: mcpProxyHeaders(),
      body: JSON.stringify(req.body || {}),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error('MCP proxy error (POST sessions/end)', { error });
    res.status(503).json({
      success: false,
      error: 'MCP service unavailable',
      message: error instanceof Error ? error.message : 'Failed to proxy request to MCP server'
    });
  }
});

/**
 * Proxy GET /api/v2/sessions (list) to MCP server. Forwards the query string (e.g. ?limit=100).
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const queryIndex = req.originalUrl.indexOf('?');
    const queryString = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    const url = `${MCP_BASE}/api/v2/sessions${queryString}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: mcpProxyHeaders(),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error('MCP proxy error (GET sessions list)', { error });
    res.status(503).json({
      success: false,
      error: 'MCP service unavailable',
      message: error instanceof Error ? error.message : 'Failed to proxy request to MCP server'
    });
  }
});

export default router;
