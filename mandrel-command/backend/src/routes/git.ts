import { Router , type RequestParamHandler } from 'express';
import { GitController } from '../controllers/git';
import { authenticateToken } from '../middleware/auth';
import { validateUUIDParam } from '../middleware/validation';
import { authenticateAgentOrUser } from '../middleware/agentAuth';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

/**
 * Git Routes
 * Endpoints for pushing git stats from local agents
 */

const router = Router();

/**
 * POST /git/push-stats — receive git data from the headless mandrel-watcher agent.
 *
 * CLOSED 2026-08-25. This was the ONLY state-changing route on the whole
 * served surface reachable with no credential: anyone on the internet could write git
 * statistics into a customer's instance. The flag it used to carry said the quiet part —
 * "security is handled via session_id + project_id validation" is possession of two ids,
 * not authentication.
 *
 * `authenticateAgentOrUser` accepts the MANDREL_AGENT_TOKEN service credential OR an
 * ordinary user JWT, and 401s a caller with neither. ⚠️ DEPLOY: the watcher must be given
 * MANDREL_AGENT_TOKEN in the same roll or its pushes start returning 401. Its READ path
 * fails soft (ConfigManager caches); its WRITE path has NOT been checked for the same
 * property — see the task.
 */
router.post('/push-stats', authenticateAgentOrUser, GitController.pushStats);

// Routes below require authentication
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /session/:sessionId/stats.
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


// GET /git/session/:sessionId/stats - Get git stats for a session
router.get('/session/:sessionId/stats', validateUUIDParam('sessionId'), GitController.getSessionGitStats);

export default router;
