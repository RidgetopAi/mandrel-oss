/**
 * THE DECISION INBOX — REST half.
 *
 * `GET /api/decisions?answerStatus=open` and `POST /api/decisions/:id/answer` / `/discuss`
 * mirror the `decision_search` / `decision_answer` / `decision_discuss` gateway actions
 * EXACTLY — this router runs requests through the SAME validator
 * (`validateToolArguments`) and the SAME route handlers (`decisionsRoutes.handle*`) the MCP
 * surfaces use, so there is no second copy of the filtering/validation/refusal logic to
 * drift from the tool actions. This file only translates between REST shape
 * (query string / path param / JSON body) and the tool-call shape, and between the
 * `McpResponse` envelope and a plain REST JSON body.
 *
 * MOUNTED with `bearerAuth()` in server/healthServer.ts — the SAME static-token guard the
 * `/api/v2/sessions` family uses (an earlier task / trust boundary). This surface
 * serves and mutates real decision data; it does not get to be born unauthenticated.
 */
import express, { Router, Request, Response } from 'express';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { deriveActor } from '../config/actorRegistry.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import { logger } from '../utils/logger.js';

/** Mirrors the same header name healthServer.ts / remoteMcpTransport.ts read (no new header). */
const ACTOR_ID_HEADER = 'x-actor-id';

function actorFor(req: Request): string | undefined {
  return deriveActor(undefined, req.header(ACTOR_ID_HEADER));
}

/** Flatten an McpResponse's `content` blocks into one string, for the REST `message` field. */
function textOf(resp: McpResponse): string {
  return resp.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';
}

/**
 * The HTTP status for a refused tool-action result. This surface does not plug into the
 * `/mcp` transport's full JSON-RPC-code classification (mcpErrorStatus.ts) — that table
 * exists ONE level up, above tool dispatch, for errors an in-process REST call never
 * produces (auth/session/binding gates all sit in front of this router already, at the
 * mount). What CAN reach here are the typed decision-inbox refusals, always a CLIENT
 * fault, so this is a small, closed, REST-local mapping keyed on their `.code`.
 */
function statusForCode(code: string | undefined): number {
  switch (code) {
    case 'DECISION_ALREADY_DECIDED':
      return 409; // Conflict — the state this call assumed no longer holds.
    case 'DECISION_UNKNOWN_OPTION':
    case 'DECISION_OPEN_INVALID':
      return 400; // Bad Request — the payload itself is malformed.
    default:
      return 400;
  }
}

function sendToolResult(res: Response, resp: McpResponse): void {
  if (resp.isError) {
    const code = (resp.structuredContent as { code?: string } | undefined)?.code;
    res.status(statusForCode(code)).json({
      ok: false,
      error: code ?? 'error',
      message: textOf(resp),
      ...(resp.structuredContent ?? {}),
    });
    return;
  }
  res.status(200).json({ ok: true, message: textOf(resp), ...(resp.structuredContent ?? {}) });
}

export function createDecisionsRestRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use((req, _res, next) => {
    logger.debug(`Decisions REST API: ${req.method} ${req.path}`);
    next();
  });

  /**
   * GET /api/decisions — decision_search over REST. `?answerStatus=open` is THE INBOX read:
   * every decision waiting on a human. Any decision_search query param is accepted here
   * (query, decisionType, status, outcomeStatus, implementationStatus, answerStatus,
   * impactLevel, component, tags, limit, offset, sortDirection, projectId, includeArchived,
   * includeOutcome) — validated by the SAME zod schema decision_search uses, so a malformed
   * filter is rejected identically on both surfaces.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const rawTags = req.query.tags;
      const args = validateToolArguments('decision_search', {
        query: req.query.query,
        decisionType: req.query.decisionType,
        status: req.query.status,
        outcomeStatus: req.query.outcomeStatus,
        implementationStatus: req.query.implementationStatus,
        answerStatus: req.query.answerStatus,
        impactLevel: req.query.impactLevel,
        component: req.query.component,
        tags: typeof rawTags === 'string' ? rawTags.split(',').filter(Boolean) : rawTags,
        limit: req.query.limit,
        offset: req.query.offset,
        sortDirection: req.query.sortDirection,
        includeOutcome: req.query.includeOutcome,
        includeArchived: req.query.includeArchived,
        projectId: req.query.projectId,
      });
      const resp = await decisionsRoutes.handleSearch(args, { actor: actorFor(req) });
      if (resp.isError) {
        sendToolResult(res, resp);
        return;
      }
      // decision_search's McpResponse carries its machine channel on `data`, not
      // `structuredContent` (see routes/decisions.routes.ts handleSearch) — the REST body is
      // that payload directly (results + total/page/limit/returned/offset/hasMore), the same
      // shape the UI renders from the tool action.
      res.status(200).json({ ok: true, ...((resp as { data?: Record<string, unknown> }).data ?? {}) });
    } catch (error) {
      res.status(400).json({ ok: false, error: 'validation_error', message: (error as Error).message });
    }
  });

  /**
   * POST /api/decisions/:id/answer — decision_answer over REST. Body: { option, note? }.
   */
  router.post('/:id/answer', async (req: Request, res: Response) => {
    try {
      const args = validateToolArguments('decision_answer', {
        decisionId: req.params.id,
        option: req.body?.option,
        note: req.body?.note,
        projectId: req.body?.projectId,
      });
      const resp = await decisionsRoutes.handleAnswer(args, { actor: actorFor(req) });
      sendToolResult(res, resp);
    } catch (error) {
      res.status(400).json({ ok: false, error: 'validation_error', message: (error as Error).message });
    }
  });

  /**
   * POST /api/decisions/:id/discuss — decision_discuss over REST. Body: { note? }.
   */
  router.post('/:id/discuss', async (req: Request, res: Response) => {
    try {
      const args = validateToolArguments('decision_discuss', {
        decisionId: req.params.id,
        note: req.body?.note,
        projectId: req.body?.projectId,
      });
      const resp = await decisionsRoutes.handleDiscuss(args, { actor: actorFor(req) });
      sendToolResult(res, resp);
    } catch (error) {
      res.status(400).json({ ok: false, error: 'validation_error', message: (error as Error).message });
    }
  });

  return router;
}

export default createDecisionsRestRouter;
