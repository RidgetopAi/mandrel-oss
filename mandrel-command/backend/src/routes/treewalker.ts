import { Router , type RequestParamHandler } from 'express';
import { TreeWalkerController } from '../controllers/treewalker';
import { authenticateToken } from '../middleware/auth';
import { validateUUIDParam } from '../middleware/validation';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

const router = Router();

// Authenticate all TreeWalker routes.
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /:anchorId/thread — an anchor may be a context, task or decision.
 * Registered as `router.param`, so it runs during ROUTING for every route on this router
 * that carries `:anchorId` — including ones nobody has written yet. That inheritance is the
 * whole point; the list-shaped alternative is what left these open while
 * `/api/projects/:id` next door was tight.
 *
 * Fail-closed and NON-DISCLOSING: a row that does not exist and a row the caller may not
 * have both answer 403, matching authorizeProjectPathParam. See services/entityProjectScope.ts.
 */
const authorizeAnchorIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeEntityPathParam('any')(
    req as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[0],
    res as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[1],
    next,
    String(value)
  );
router.param('anchorId', authorizeAnchorIdParam);


/**
 * @swagger
 * /treewalker/thread:
 *   get:
 *     summary: Walk the LIVE resume-anchor thread (whole-thread graph + recall_thread story + trust)
 *     description: >
 *       Resolves the newest `ref:resume`-tagged context in the active project (X-Project-ID
 *       scoped), walks its typed-edge thread ~2 hops over the `links` graph (migration 049),
 *       and returns the ThreadGraph the TreeWalker screen renders: spine lineage, nodes (kind +
 *       trust), typed edges, and the ordered story. A genuinely-empty thread returns an honest
 *       empty graph (never fabricated).
 *     tags: [TreeWalker]
 *     responses:
 *       200:
 *         description: Thread graph retrieved
 */
router.get('/thread', TreeWalkerController.getResumeThread);

/**
 * @swagger
 * /treewalker/trunk:
 *   get:
 *     summary: The project's handoff TIMELINE (the trunk) — time-ordered, supersession as corroboration only
 *     description: >
 *       PHASE 2 item a: the trunk tier resolved from DATA — the scoped
 *       project's handoff contexts newest-first (full count + bounded entries + the trunk
 *       head id). Ordering is created_at ALWAYS; a declared supersedes edge appears only
 *       as per-entry corroboration metadata. No recursive supersedes walk exists on this path.
 *     tags: [TreeWalker]
 *     responses:
 *       200:
 *         description: Trunk timeline retrieved
 */
router.get('/trunk', TreeWalkerController.getTrunk);

/**
 * @swagger
 * /treewalker/branches:
 *   get:
 *     summary: The branch list (resume surface) — spines with DECLARED members, newest-active first
 *     description: >
 *       PHASE 2 item c: branches enumerated from declared `informs`
 *       membership edges (the link_provenance view — P1 positional + tag/links-arg
 *       provenance), named by their once-on-the-spine `branch:` tag else spine title,
 *       with open branch positions marked. TOP-LEVEL DRAWERS ONLY (P2):
 *       a spine that is itself a member of another branch (a
 *       SECTION) is filtered out BEFORE the cap, not merely flagged, so it can never
 *       consume a page slot a genuine drawer needed. Each branch reports sectionCount
 *       (how many of its own members are themselves branch spines); the envelope
 *       carries the honest `total` DRAWER count (post-filter, pre-cap) and the `cap`
 *       applied, so a caller can never mistake a truncated list for the whole set.
 *     tags: [TreeWalker]
 *     responses:
 *       200:
 *         description: Branch list retrieved
 */
router.get('/branches', TreeWalkerController.getBranches);

/**
 * @swagger
 * /treewalker/{anchorId}/thread:
 *   get:
 *     summary: Walk an EXPLICIT anchor's thread (whole-thread graph + recall_thread story + trust)
 *     tags: [TreeWalker]
 *     parameters:
 *       - in: path
 *         name: anchorId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Thread graph retrieved
 *       404:
 *         description: Anchor not found
 */
router.get('/:anchorId/thread', validateUUIDParam('anchorId'), TreeWalkerController.getThread);

export default router;
