/**
 * /api/mcp — the AUTHENTICATED MCP passthrough for the hosted browser UI
 * (durable F-01/F-04 fix, Option 2 — single trust boundary).
 *
 * ── THE ARCHITECTURE THIS IMPLEMENTS ─────────────────────────────────────────────────
 * Before: browser → (public) mcp-server /mcp/tools/* — gated only by a token the browser
 * had to be handed (Option 1: the shared MANDREL_JWT_SECRET let the mcp-server trust
 * command login JWTs directly, i.e. ANY logged-in user got full tool access).
 * After:  browser → THIS backend (login JWT, full session validation) → per-user/project
 * authorization → internal MCP_AUTH_TOKEN attached server-side → mcp-server. The public
 * /mcp/tools/* surface is then blocked at the proxies (infra/ artifacts + runbook), and
 * the mcp-server no longer needs the shared secret.
 *
 * ── ENFORCEMENT LAYERS ON EVERY CALL (each fail-closed) ──────────────────────────────
 *   1. authenticateToken             — real login: JWT + live session row (whole family).
 *   2. read-only tool allow-list     — deny-by-default (config/mcpReadAllowlist.ts):
 *      unknown tool = 403; the browser can NEVER reach a write/scope-switch through
 *      here. Drift-guarded against the mcp-server's opRegistry by contract test.
 *   3. project authorization (F-04)  — two doors, both checked:
 *        - X-Project-ID header        → app-level projectContextMiddleware (server.ts
 *          mounts it on ALL of /api, this family included);
 *        - arguments.projectId/project IN THE BODY → checked HERE (tools accept a
 *          project by id or name; an unresolvable reference is 403, never forwarded).
 *   4. AMBIENT SCOPE BINDING — the ref-less path is covered too: every
 *      forwarded call is either BOUND to one project the caller is authorized for
 *      (X-Mandrel-Project on the upstream request — the mcp-server's authoritative
 *      rung-1 binding) or the tool is registered 'global' (carries no project data).
 *      Before this layer, a ref-less call fell to the mcp-server's shared header-less
 *      connection slot, so a ZERO-GRANT user read whatever project that slot pointed
 *      at. The rule, stated once (resolveScopeBinding below):
 *        - explicit ref(s) in the arguments → authorized (layer 3) → bind to that
 *          project; refs naming TWO different projects are refused (400, incoherent).
 *        - no ref, tool 'global'            → forward unbound (no project data flows).
 *        - no ref, authorized X-Project-ID  → bind to it (the UI's normal path).
 *        - no ref, exactly one grant        → bind to it (least surprise).
 *        - no ref, zero grants              → 403 (deny-by-default now covers ambient).
 *        - no ref, multiple grants or admin → 400 naming the fix: there is NO default-
 *          project concept in the grant model (user_project_access, migration 075), so
 *          any server-side pick would be invented semantics — the caller must name one
 *          (arguments.projectId or X-Project-ID).
 *   5. the internal bearer token is attached by McpProxyService — it exists only
 *      server-side; the response is forwarded verbatim so the browser client's
 *      envelope contract ({success, result}) is unchanged.
 */

import { Router, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { AuthenticatedRequest } from '../types/auth';
import { McpProxyService, RawMcpResponse } from '../services/mcpProxy';
import { ProjectAccessService } from '../services/projectAccess';
import {
  isAllowedReadTool,
  isProjectScopedReadTool,
  MCP_READ_TOOL_ALLOWLIST,
} from '../config/mcpReadAllowlist';
import { logger } from '../config/logger';

const router = Router();

// Real login required for the WHOLE family — one line, no route can forget it.
router.use(authenticateToken);

/** Forward an upstream raw response verbatim (status + body + content-type). */
function relay(res: Response, upstream: RawMcpResponse): void {
  res.status(upstream.status).type(upstream.contentType).send(upstream.body);
}

/** 502 for "the mcp-server could not be reached" — its own branch, never a fake tool error. */
function upstreamFailure(res: Response, error: unknown, what: string): void {
  logger.error(`[api/mcp] upstream failure on ${what}`, {
    error: error instanceof Error ? error.message : error,
  });
  res.status(502).json({
    success: false,
    error: 'MCP upstream unavailable',
    message: error instanceof Error ? error.message : 'Unknown upstream error',
  });
}

/**
 * The outcome of the scope-binding rule (layer 4). Exactly one of the three shapes:
 * refuse with a status+body, forward bound to ONE authorized project, or forward
 * unbound (only ever chosen for 'global' tools).
 */
type ScopeDecision =
  | { kind: 'refuse'; status: number; body: { success: false; error: string; message: string } }
  | { kind: 'bind'; projectId: string }
  | { kind: 'unbound' };

/**
 * Resolve the AMBIENT scope rule for a ref-less call (layer 4 in the module doc).
 * `explicitRefs` are the project ids ALREADY resolved + authorized by layer 3 — this
 * function never re-checks them, it only decides what the upstream binding is.
 *
 * Throws on a grants-lookup failure — the caller maps that onto 500, never onto
 * allow OR deny (C1: could-not-measure is its own branch).
 */
async function resolveScopeBinding(
  req: AuthenticatedRequest,
  toolName: string,
  explicitRefs: string[]
): Promise<ScopeDecision> {
  if (explicitRefs.length > 0) {
    const distinct = [...new Set(explicitRefs)];
    if (distinct.length > 1) {
      // arguments.projectId and arguments.project naming DIFFERENT projects: there is
      // no coherent single scope to bind, and forwarding would let the upstream pick.
      return {
        kind: 'refuse',
        status: 400,
        body: {
          success: false,
          error: 'Conflicting project references',
          message:
            'The tool arguments name more than one project. Name exactly one ' +
            '(arguments.projectId).',
        },
      };
    }
    return { kind: 'bind', projectId: distinct[0] };
  }

  if (!isProjectScopedReadTool(toolName)) {
    // 'global' tools (mandrel_ping/mandrel_status) resolve no project on any handler
    // path — classification + reasons live in config/mcpReadAllowlist.ts, drift-pinned.
    return { kind: 'unbound' };
  }

  // The UI's normal path: an authorized X-Project-ID header. projectContextMiddleware
  // (mounted app-wide, BEFORE this route) has already authorized the caller for it —
  // req.projectId is only ever attached post-authorization.
  if (req.projectId) {
    return { kind: 'bind', projectId: req.projectId };
  }

  const user = req.user;
  if (!user) {
    return {
      kind: 'refuse',
      status: 401,
      body: { success: false, error: 'Authentication required', message: 'No caller to scope' },
    };
  }

  if ((user as { role?: string | null }).role === 'admin') {
    // Admin holds ALL projects — there is no single project to bind, and no default-
    // project concept exists in the grant model to fall back on. Require an explicit ref.
    return {
      kind: 'refuse',
      status: 400,
      body: {
        success: false,
        error: 'Ambiguous project scope',
        message:
          `Tool '${toolName}' is project-scoped and this call names no project. ` +
          'Admin holds access to all projects — name one explicitly ' +
          '(arguments.projectId or the X-Project-ID header).',
      },
    };
  }

  const grants = await ProjectAccessService.listAccessibleProjectIds(user.id);
  if (grants.length === 0) {
    // THE headline case (the reviewer nit 1): deny-by-default now covers the ambient path.
    return {
      kind: 'refuse',
      status: 403,
      body: {
        success: false,
        error: 'Project access denied',
        message: 'You have no project grants, so no project scope can be resolved for this tool.',
      },
    };
  }
  if (grants.length === 1) {
    return { kind: 'bind', projectId: grants[0] };
  }
  return {
    kind: 'refuse',
    status: 400,
    body: {
      success: false,
      error: 'Ambiguous project scope',
      message:
        `Tool '${toolName}' is project-scoped and this call names no project. ` +
        `You hold access to ${grants.length} projects — name one explicitly ` +
        '(arguments.projectId or the X-Project-ID header).',
    },
  };
}

/**
 * GET /api/mcp/healthz — mcp-server liveness for the UI health widget.
 * (Replaces the browser's direct same-origin /healthz fetch.)
 */
router.get('/healthz', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    relay(res, await McpProxyService.forwardHealthz());
  } catch (error) {
    upstreamFailure(res, error, 'healthz');
  }
});

/**
 * GET /api/mcp/tools — the tool list (read-only metadata).
 * (Replaces the browser's direct GET /mcp/tools.)
 */
router.get('/tools', async (req: AuthenticatedRequest, res: Response) => {
  try {
    relay(res, await McpProxyService.forwardToolList(req.user?.username));
  } catch (error) {
    upstreamFailure(res, error, 'tools list');
  }
});

/**
 * POST /api/mcp/tools/:toolName — the tool-call passthrough.
 *
 * Classified any-authenticated because the WRITE question is answered one line down by
 * construction: only tools registered 'read' in the mcp-server's opRegistry can pass the
 * allow-list, so this POST route cannot mutate mcp-server state no matter who calls it.
 */
router.post(
  '/tools/:toolName',
  declareAnyAuthenticatedMayWrite(
    'passthrough restricted to the read-only MCP tool allow-list (mcpReadAllowlist, ' +
      'deny-by-default) with per-user project authorization — no write can pass it'
  ),
  async (req: AuthenticatedRequest, res: Response) => {
    const toolName = req.params.toolName;

    // Layer 2 — deny-by-default read allow-list.
    if (!isAllowedReadTool(toolName)) {
      logger.warn('[api/mcp] tool DENIED (not on the read allow-list)', {
        toolName,
        userId: req.user?.id,
      });
      res.status(403).json({
        success: false,
        error: 'Tool not permitted',
        message: `Tool '${toolName}' is not on the browser read allow-list (${MCP_READ_TOOL_ALLOWLIST.size} tools permitted).`,
      });
      return;
    }

    // Layer 3b — authorize any project reference carried IN THE ARGUMENTS.
    // (The X-Project-ID header door is enforced app-wide by projectContextMiddleware.)
    const args = (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).arguments : undefined) as
      | Record<string, unknown>
      | undefined;
    const projectRefs = [args?.projectId, args?.project].filter(
      (v): v is string => typeof v === 'string' && v.trim() !== ''
    );
    const authorizedRefIds: string[] = [];
    for (const ref of projectRefs) {
      try {
        const resolved = await ProjectAccessService.resolveProjectId(ref.trim());
        if (!resolved) {
          // Unresolvable reference: fail closed. Never forward a scope we could not check.
          res.status(403).json({
            success: false,
            error: 'Project access denied',
            message: 'Unknown project reference in tool arguments',
          });
          return;
        }
        const user = req.user;
        if (!user) {
          res.status(401).json({ success: false, error: 'Authentication required' });
          return;
        }
        const allowed = await ProjectAccessService.userHasProjectAccess(
          { id: user.id, role: (user as { role?: string | null }).role },
          resolved
        );
        if (!allowed) {
          logger.warn('[api/mcp] project scope DENIED in tool arguments', {
            toolName,
            userId: user.id,
            projectId: resolved,
          });
          res.status(403).json({
            success: false,
            error: 'Project access denied',
            message: 'You do not have access to the requested project',
          });
          return;
        }
        authorizedRefIds.push(resolved);
      } catch (error) {
        // C1: the check could not run — its own branch, never mapped onto allow.
        logger.error('[api/mcp] project access check failed', {
          error: error instanceof Error ? error.message : error,
        });
        res.status(500).json({ success: false, error: 'Project access check failed' });
        return;
      }
    }

    // Layer 4 — ambient scope binding: decide the ONE project this
    // call is scoped to upstream, or refuse. A ref-less project-scoped call can no
    // longer reach the mcp-server's shared connection slot.
    let decision: ScopeDecision;
    try {
      decision = await resolveScopeBinding(req, toolName, authorizedRefIds);
    } catch (error) {
      // C1 again: the grants lookup could not run — 500, never allow, never deny.
      logger.error('[api/mcp] scope binding resolution failed', {
        error: error instanceof Error ? error.message : error,
      });
      res.status(500).json({ success: false, error: 'Project scope resolution failed' });
      return;
    }
    if (decision.kind === 'refuse') {
      logger.warn('[api/mcp] ambient scope REFUSED', {
        toolName,
        userId: req.user?.id,
        status: decision.status,
        reason: decision.body.error,
      });
      res.status(decision.status).json(decision.body);
      return;
    }

    // Layers passed — forward with the INTERNAL token + human attribution + the
    // project binding (X-Mandrel-Project) when one was resolved.
    try {
      relay(
        res,
        await McpProxyService.forwardToolCall(
          toolName,
          req.body ?? {},
          req.user?.username,
          decision.kind === 'bind' ? decision.projectId : undefined
        )
      );
    } catch (error) {
      upstreamFailure(res, error, `tool ${toolName}`);
    }
  }
);

export default router;
