import { Router } from 'express';
import healthRoutes from './health';
import authRoutes from './auth';
import userRoutes from './users';
import contextRoutes from './contexts';
import projectRoutes from './projects';
import sessionRoutes from './sessions';
import sessionCodeRoutes from './sessionCode';
import taskRoutes from './tasks';
import decisionRoutes from './decisions';
import namingRoutes from './naming';
import dashboardRoutes from './dashboard';
import daySummaryRoutes from './daySummary';
import momentumSeriesRoutes from './momentumSeries';
import monitoringRoutes from './monitoring';
import validationRoutes from './validation';
import typeSafetyRoutes from './typeSafety';
import openApiRoutes from './openapi';
import embeddingRoutes from './embedding';
import eventsRoutes from './events';
import gitRoutes from './git';
import feedbackRoutes from './feedback';
import treewalkerRoutes from './treewalker';
import resolveRoutes from './resolve';
import sessionRoutesV2 from './sessionsProxy';
import mcpRoutes from './mcp';
import { taskScopedAttachmentRoutes, attachmentRoutes } from './taskAttachments';

const router = Router();

// Mount route modules
router.use('/', healthRoutes);
router.use('/openapi', openApiRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/contexts', contextRoutes);
router.use('/projects', projectRoutes);
router.use('/sessions', sessionRoutes);
router.use('/session-code', sessionCodeRoutes);
// Punch List task attachments (Lane B) MUST be mounted at `/tasks`
// BEFORE `taskRoutes` below. `router.use(authenticateToken)` inside
// taskRoutes (routes/tasks.ts) is a blanket middleware, not a route: Express runs it for
// EVERY request whose path starts with `/tasks`, including `/tasks/:id/attachments`,
// regardless of whether tasks.ts has a matching ROUTE for that path. The two-vs-three
// path-segment reasoning that makes the ROUTES order-free (see the comment further down)
// does NOT apply to that `.use()` — it is unconditional. Mounted after taskRoutes, an
// agent-token request to `/tasks/:id/attachments` was 401'd by taskRoutes' own
// user-JWT-only `authenticateToken` before ever reaching taskScopedAttachmentRoutes' own
// (agent-aware) `authenticateAgentOrUser` — measured directly: the fix is proved by
// taskAttachmentsAgentAuth.db.test.ts, which failed at exactly this point without this
// reordering. Mounted FIRST, a request that does not match taskScopedAttachmentRoutes'
// one route (`/:id/attachments`) falls through via `next()` to taskRoutes unchanged.
router.use('/tasks', taskScopedAttachmentRoutes);
router.use('/tasks', taskRoutes);
router.use('/decisions', decisionRoutes);
router.use('/naming', namingRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/day-summary', daySummaryRoutes);
router.use('/momentum-series', momentumSeriesRoutes);
router.use('/monitoring', monitoringRoutes);
router.use('/validation', validationRoutes);
// The `/type-safety/*` demonstration family gates itself: sec an earlier task applies
// `authenticateToken` to the WHOLE family in one `router.use(...)` inside the module, so
// none of these routes (esp. `/schema-sync`, which dumps the internal SchemaRegistry) can
// be reached unauthenticated. See routes/typeSafety.ts.
router.use('/type-safety', typeSafetyRoutes);
router.use('/embedding', embeddingRoutes);
router.use('/', eventsRoutes);
router.use('/git', gitRoutes);
router.use('/feedback', feedbackRoutes);
router.use('/treewalker', treewalkerRoutes);
// Navigation SPINE: GET /api/r/:id → resolve a bare id and 302-redirect to its
// detail page (browser-reachable via the existing /api → backend vhost rule).
router.use('/r', resolveRoutes);

// The `/api/v2/sessions/*` family (browser session read + lifecycle proxy to the
// mcp-server) lives in its own router. SECURITY: that module applies
// `authenticateToken` to the WHOLE family in one place, so none of these data-bearing
// routes can be reached unauthenticated (the pre-fix exposure). See sessionsProxy.ts.
router.use('/v2/sessions', sessionRoutesV2);

// The authenticated MCP passthrough for the hosted browser UI (an earlier task — the
// durable F-01/F-04 fix). The module applies `authenticateToken` to the WHOLE family in
// one `router.use(...)`, restricts calls to a deny-by-default READ tool allow-list, and
// enforces per-user project authorization before attaching the internal MCP token.
// The browser's direct /mcp/tools/* path is retired by the same change (see
// frontend/src/api/mandrelApiClient.ts + docs/deploy/trust-boundary-cutover.md).
router.use('/mcp', mcpRoutes);

// The other half of the Punch List task attachments pair (`taskScopedAttachmentRoutes`
// is mounted at `/tasks` ABOVE, before taskRoutes — see that comment). This one owns its
// own, uncontested prefix: the bulk read lives at `GET /attachments?taskIds=` rather than
// `/tasks/attachments` for the same reason (the reviewer #1: the latter was
// captured by `GET /tasks/:id`). Not mounted at `/` — a router-level `authenticateToken`
// there turned unknown `/api/*` into 401s (#6). Both facts are asserted against the real
// app in taskAttachments.db.test.ts.
router.use('/attachments', attachmentRoutes);

export default router;