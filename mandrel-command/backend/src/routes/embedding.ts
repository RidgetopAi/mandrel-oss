import { Router, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../types/auth';
import { EmbeddingService } from '../services/EmbeddingService';
import { logger } from '../config/logger';
import { isValidUuid } from '../utils/uuid';
import { resolveAggTimeZone } from '../config/analyticsTime';
import { getRequestProjectId } from '../services/projectScopeResolver';
import { ProjectAccessService } from '../services/projectAccess';
import { ALL_PROJECTS } from '../services/embedding/datasets';

/**
 * ── TWO UNAUTHORIZED PROJECT DOORS, CLOSED (Reviewer D1) ──────
 *
 * This router had EIGHT authenticated routes and its OWN project resolution, which never
 * consulted ProjectAccessService. Measured at the real surface with a zero-grant
 * non-admin: `X-Project-ID` → 403 (the door the resolver closed) while both of these
 * returned 200 and real data.
 *
 * DOOR 1 — a LEGACY `project` REQUEST HEADER. `resolveProjectScope()` read
 * `req.headers.project`, accepted a uuid OR A PROJECT NAME, and attached it unchecked.
 * It is deleted, not authorized: `grep -rniE "headers?\s*[:.\[].{0,20}['\"]project['\"]"
 * frontend/src` returns ZERO hits — no client has ever sent it. The name branch is deleted
 * with it (see EmbeddingScope), so name-based project selection is now unreachable by
 * construction rather than merely checked.
 *
 * DOOR 2 — the `?id=` QUERY PARAM **IS** A PROJECT ID. `getAvailableDatasets` emits
 * `p.id::text AS id` (services/embedding/datasets.ts:35), so a "dataset id" is literally a
 * project id, and the services did
 *     `targetProjectId = datasetId !== 'contexts' ? datasetId : resolvedScopeId`
 * — the caller-supplied `?id=` OVERRODE the scope. `getSimilarityMatrix` then returned
 * `content` from every context in the named project.
 *
 * DOOR 2 is the one worth remembering: it is a project reference named `id`. No
 * name-based scan for "project" will ever find it, which is exactly why the fix is
 * structural — the project now comes from getRequestProjectId(), the single authorized
 * resolution, and the services no longer accept a project through the dataset argument at
 * all. `?id=` is validated AGAINST the authorized scope (403 on a mismatch, never a
 * silent substitution) instead of being trusted to select it.
 *
 * Both doors predate this branch. They are fixed here because
 * services/projectScopeResolver.ts claims to enumerate the population exhaustively, and a
 * claim that is wrong is worse than a hole — it tells the next reader not to look.
 */

/**
 * The AUTHORIZED project for this request, or `undefined`. Every route below funnels
 * through this one line; there is no second resolution in this file any more.
 */
const scopeOf = (req: AuthenticatedRequest): { projectId?: string } => ({
  projectId: getRequestProjectId(req),
});

/** The 400 every route returned when no project was in scope. Unchanged. */
const missingScope = (res: Response, what: string) =>
  res.status(400).json({
    error: 'Project context required',
    details: `Provide X-Project-ID header to scope ${what}`,
  });

/**
 * `?id=` names a DATASET, and a dataset id IS a project id. It may therefore only ever be
 * the project the caller is already authorized for. A uuid that is not that project is a
 * cross-project request: refuse it. Anything non-uuid (e.g. the literal 'contexts') is a
 * dataset selector, not a project reference, and is passed through untouched.
 *
 * Returns true when the request may proceed; otherwise it has already sent a 403.
 */
const datasetIsInScope = (
  datasetId: unknown,
  projectId: string | undefined,
  res: Response
): boolean => {
  // J1: a NON-STRING datasetId is DENIED, not allowed.
  //
  // This returned `true` (allow). Express produces an ARRAY for a repeated `?id=&id=`, and
  // an object for `?id[x]=`, so the one shape that reaches this line as a non-string is
  // the one a caller sends deliberately — measured 200 at the real surface. The old
  // defence was "not exploitable because the current services ignore the value": a claim
  // about today's CALLERS, standing in for a property of the IMPLEMENTATION, inside the
  // authorization primitive this task exists to make trustworthy. Exactly the population
  // mismatch this whole task is about. Unknown shape -> deny.
  if (datasetId !== undefined && typeof datasetId !== 'string') {
    res.status(400).json({
      error: 'Invalid dataset id',
      details: 'The `id` query parameter must be a single string value',
    });
    return false;
  }
  if (typeof datasetId !== 'string') return true;
  const ref = datasetId.trim();
  if (!isValidUuid(ref)) return true;
  if (projectId && ref.toLowerCase() === projectId.toLowerCase()) return true;
  res.status(403).json({
    error: 'Project access denied',
    details: 'The requested dataset belongs to a project outside the request scope',
  });
  return false;
};

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

/**
 * @swagger
 * /embedding/list:
 *   get:
 *     summary: Retrieve available embedding datasets
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: false
 *         description: Optional project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Dataset list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/EmbeddingDataset'
 */
router.get('/list', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const scope = scopeOf(req);
    // /list is the only route here that may be UNSCOPED (the UI needs it to build the
    // project picker). Unscoped must not mean "every project": pass the caller's
    // authorized set so a non-admin sees only its own. admin -> null -> all, unchanged.
    const allowed =
      req.user.role === 'admin'
        ? ALL_PROJECTS
        : await ProjectAccessService.listAccessibleProjectIds(req.user.id);
    const datasets = await EmbeddingService.getAvailableDatasets(
      req.user.id,
      scope,
      allowed
    );
    return res.json(datasets);
  } catch (error) {
    logger.error('Error getting embedding datasets', { error });
    return res.status(500).json({ 
      error: 'Failed to get embedding datasets',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @swagger
 * /embedding/similarity:
 *   get:
 *     summary: Retrieve similarity matrix for an embedding dataset
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: true
 *         description: Project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: rows
 *         schema:
 *           type: integer
 *           default: 100
 *       - in: query
 *         name: cols
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Similarity matrix returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmbeddingSimilarityMatrix'
 */
router.get('/similarity', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id, rows = '100', cols = '100' } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'Dataset ID is required' });
    }

    const scope = scopeOf(req);

    // DOOR 2 FIRST, before the missing-scope 400 (Reviewer item 6). `?id=` is a project
    // id; if it names a project this caller may not have, that is an AUTHORIZATION failure
    // and must be answered as one. Checking the scope header first meant an unscoped
    // `?id=<victim>` got a 400 "send X-Project-ID" — a hint about the wrong problem, and
    // an assertion of `not.toBe(200)` that passed for a reason unrelated to the door.
    if (!datasetIsInScope(id, scope.projectId, res)) return;
    if (!scope.projectId) return missingScope(res, 'embedding analytics');

    const similarity = await EmbeddingService.getSimilarityMatrix(
      req.user.id,
      scope,
      id as string,
      parseInt(rows as string, 10),
      parseInt(cols as string, 10)
    );
    
    return res.json(similarity);
  } catch (error) {
    logger.error('Error getting similarity matrix', { error });
    return res.status(500).json({ 
      error: 'Failed to get similarity matrix',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @swagger
 * /embedding/projection:
 *   get:
 *     summary: Retrieve 2D/3D projection of embeddings
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: true
 *         description: Project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: algo
 *         schema:
 *           type: string
 *           default: pca
 *       - in: query
 *         name: n
 *         schema:
 *           type: integer
 *           default: 1000
 *     responses:
 *       200:
 *         description: Projection data returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmbeddingProjection'
 */
router.get('/projection', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id, algo = 'pca', n = '1000' } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'Dataset ID is required' });
    }

    const scope = scopeOf(req);

    // DOOR 2 FIRST, before the missing-scope 400 (Reviewer item 6). `?id=` is a project
    // id; if it names a project this caller may not have, that is an AUTHORIZATION failure
    // and must be answered as one. Checking the scope header first meant an unscoped
    // `?id=<victim>` got a 400 "send X-Project-ID" — a hint about the wrong problem, and
    // an assertion of `not.toBe(200)` that passed for a reason unrelated to the door.
    if (!datasetIsInScope(id, scope.projectId, res)) return;
    if (!scope.projectId) return missingScope(res, 'embedding analytics');

    const projection = await EmbeddingService.getProjection(
      req.user.id,
      scope,
      id as string,
      algo as string,
      parseInt(n as string, 10)
    );
    
    return res.json(projection);
  } catch (error) {
    logger.error('Error getting projection', { error });
    return res.status(500).json({ 
      error: 'Failed to get projection',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @swagger
 * /embedding/cluster:
 *   get:
 *     summary: Retrieve clustering results for an embedding dataset
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: true
 *         description: Project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: k
 *         schema:
 *           type: integer
 *           default: 8
 *     responses:
 *       200:
 *         description: Clustering data returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmbeddingClusterResult'
 */
router.get('/cluster', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id, k = '8' } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'Dataset ID is required' });
    }

    const scope = scopeOf(req);

    // DOOR 2 FIRST, before the missing-scope 400 (Reviewer item 6). `?id=` is a project
    // id; if it names a project this caller may not have, that is an AUTHORIZATION failure
    // and must be answered as one. Checking the scope header first meant an unscoped
    // `?id=<victim>` got a 400 "send X-Project-ID" — a hint about the wrong problem, and
    // an assertion of `not.toBe(200)` that passed for a reason unrelated to the door.
    if (!datasetIsInScope(id, scope.projectId, res)) return;
    if (!scope.projectId) return missingScope(res, 'embedding analytics');

    const clusters = await EmbeddingService.getClusters(
      req.user.id,
      scope,
      id as string,
      parseInt(k as string, 10)
    );
    
    return res.json(clusters);
  } catch (error) {
    logger.error('Error getting clusters', { error });
    return res.status(500).json({ 
      error: 'Failed to get clusters',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @swagger
 * /embedding/metrics:
 *   get:
 *     summary: Retrieve embedding quality metrics
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: true
 *         description: Project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Quality metrics returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmbeddingQualityMetrics'
 */
router.get('/metrics', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'Dataset ID is required' });
    }

    const scope = scopeOf(req);

    // DOOR 2 FIRST, before the missing-scope 400 (Reviewer item 6). `?id=` is a project
    // id; if it names a project this caller may not have, that is an AUTHORIZATION failure
    // and must be answered as one. Checking the scope header first meant an unscoped
    // `?id=<victim>` got a 400 "send X-Project-ID" — a hint about the wrong problem, and
    // an assertion of `not.toBe(200)` that passed for a reason unrelated to the door.
    if (!datasetIsInScope(id, scope.projectId, res)) return;
    if (!scope.projectId) return missingScope(res, 'embedding analytics');

    const metrics = await EmbeddingService.getQualityMetrics(
      req.user.id,
      scope,
      id as string
    );
    
    return res.json(metrics);
  } catch (error) {
    logger.error('Error getting metrics', { error });
    return res.status(500).json({ 
      error: 'Failed to get metrics',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @swagger
 * /embedding/relationships:
 *   get:
 *     summary: Retrieve project relationship network for the active project
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: true
 *         description: Project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Project relationship network returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmbeddingProjectRelationships'
 */
router.get('/relationships', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const scope = scopeOf(req);

    if (!scope.projectId) return missingScope(res, 'project relationship analytics');

    const relationships = await EmbeddingService.getProjectRelationships(
      req.user.id,
      scope
    );

    return res.json(relationships);
  } catch (error) {
    logger.error('Error getting project relationships', { error });
    return res.status(500).json({
      error: 'Failed to get project relationships',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * @swagger
 * /embedding/knowledge-gaps:
 *   get:
 *     summary: Retrieve knowledge gap analytics for the active project
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: true
  *         description: Project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Knowledge gap metrics returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmbeddingKnowledgeGaps'
 */
router.get('/knowledge-gaps', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const scope = scopeOf(req);

    if (!scope.projectId) return missingScope(res, 'knowledge-gap analytics');

    const gaps = await EmbeddingService.getKnowledgeGapMetrics(
      req.user.id,
      scope
    );

    return res.json(gaps);
  } catch (error) {
    logger.error('Error getting knowledge gap metrics', { error });
    return res.status(500).json({
      error: 'Failed to get knowledge gap metrics',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * @swagger
 * /embedding/usage:
 *   get:
 *     summary: Retrieve usage pattern analytics for the active project
 *     tags: [Embeddings]
 *     parameters:
 *       - in: header
 *         name: X-Project-ID
 *         required: true
 *         description: Project context (UUID), authorized per-caller.
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Usage pattern metrics returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmbeddingUsagePatterns'
 */
router.get('/usage', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const scope = scopeOf(req);

    if (!scope.projectId) return missingScope(res, 'usage pattern analytics');

    // Bucket the daily contexts/day series in the viewer's tz; default UTC.
    const tz = resolveAggTimeZone(req.query.tz);
    const usage = await EmbeddingService.getUsagePatterns(
      req.user.id,
      scope,
      tz
    );

    return res.json(usage);
  } catch (error) {
    logger.error('Error getting usage patterns', { error });
    return res.status(500).json({
      error: 'Failed to get usage patterns',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
