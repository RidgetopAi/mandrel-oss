/**
 * DEPRECATED ANCHOR ALIASES — thread_set / thread_current / thread_clear.
 *
 * PHASE 1 positional membership RETIRED the
 * active-thread anchor: it was a 24h-TTL, similarity-gated GUESS that starved to death on
 * 2026-07-28 (set in 25 of 288 sessions) and whose historical strong mints migration 080's
 * D1 demoted to the weak tier. Its replacement is the BRANCH POSITION
 * (branch_open / branch_current / branch_close — routes/branch.routes.ts): declared,
 * per-session, no TTL, no gate.
 *
 * These three actions survive ONE phase as WARN-and-delegate aliases so existing habits
 * and scripts do not break cold:
 *   thread_set({task})        → branch_open(task)     [task preferred when both given]
 *   thread_set({decision})    → branch_open(decision)
 *   thread_current            → branch_current
 *   thread_clear              → branch_close
 * Every response is PREFIXED with a deprecation warning naming the replacement. The
 * anchor's merge/replace semantics are GONE (a position is one spine); a thread_set naming
 * both task and decision opens the branch on the TASK and says so.
 */

import { formatMcpError } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { branchRoutes } from './branch.routes.js';

/** Prepend the deprecation warning to a delegated response's text channel. */
function withDeprecationWarning(response: McpResponse, oldTool: string, newForm: string): McpResponse {
  const warning =
    `⚠️  DEPRECATED: ${oldTool} is retired — use ${newForm} (positional membership, ` +
    `an earlier decision). Delegated for you this time.`;
  const content = [{ type: 'text' as const, text: warning }, ...(response.content ?? [])];
  return {
    ...response,
    content,
    structuredContent: {
      ...(response.structuredContent ?? {}),
      deprecated: true,
      replacement: newForm,
    },
  };
}

class ThreadRoutes {
  /**
   * thread_set — DEPRECATED alias for branch_open. Accepts the old task/decision params;
   * opens the branch on the task when both are given (a position is ONE spine).
   */
  async handleSet(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const task = args.task !== undefined && args.task !== null && args.task !== '' ? String(args.task) : undefined;
      const decision =
        args.decision !== undefined && args.decision !== null && args.decision !== ''
          ? String(args.decision)
          : undefined;
      // `replace` is ACCEPTED-BUT-INERT (a position is always a whole replacement) —
      // read it so the intent is acknowledged in the deprecation note rather than dropped.
      const replaceRequested = args.replace === true;

      if (!task && !decision) {
        return {
          content: [{
            type: 'text',
            text:
              '❌ thread_set (DEPRECATED) requires at least one of `task` or `decision`.\n\n' +
              '💡 Use branch_open(id) instead — the spine may be a context, decision, or task.',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected', deprecated: true, replacement: 'branch_open' },
        };
      }

      const spineId = task ?? decision!;
      const delegated = await branchRoutes.handleOpen(
        { id: spineId, projectId: args.projectId },
        context
      );
      const note =
        (task && decision
          ? ` (both task and decision were given — a position is ONE spine, so the branch opened on the TASK; ` +
            `open the decision explicitly with branch_open ${String(decision).substring(0, 8)} if that was the intent)`
          : '') +
        (replaceRequested ? ' (replace is inert — a position is always a whole replacement)' : '');
      return withDeprecationWarning(delegated, 'thread_set', `branch_open(${spineId.substring(0, 8)})${note}`);
    } catch (error) {
      return formatMcpError(error as Error, 'thread_set');
    }
  }

  /** thread_current — DEPRECATED alias for branch_current. */
  async handleCurrent(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const delegated = await branchRoutes.handleCurrent(args, context);
      return withDeprecationWarning(delegated, 'thread_current', 'branch_current');
    } catch (error) {
      return formatMcpError(error as Error, 'thread_current');
    }
  }

  /** thread_clear — DEPRECATED alias for branch_close. */
  async handleClear(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const delegated = await branchRoutes.handleClose(args, context);
      return withDeprecationWarning(delegated, 'thread_clear', 'branch_close');
    } catch (error) {
      return formatMcpError(error as Error, 'thread_clear');
    }
  }
}

export const threadRoutes = new ThreadRoutes();
