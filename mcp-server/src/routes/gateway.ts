/**
 * Gateway dispatcher — MCP-2026 rebuild, PHASE 2.
 *
 * A THIN resolver in front of the EXISTING per-op machinery — NOT a rewrite of it (plan §1.4).
 * A `tools/call` to a gateway tool (`context`, `task`, …) arrives here; we:
 *   1. read the `action` discriminator (missing/unknown → an actionable error naming discover),
 *   2. resolve (gateway, action) → opId via the registry-derived resolver (config/gatewayResolver),
 *   3. strip `action` → branchArgs (re-injecting the nested sub-action for session_pin),
 *   4. validate with the UNCHANGED per-op validator (`validateToolArguments`) — so strict-key
 *      per-branch, id-synonyms, and the actionable-error formatter all apply automatically,
 *   5. delegate to the UNCHANGED `routeExecutor(opId, …)` switch — whose ACTION-gate keys on the
 *      resolved opId, so gateway calls gate exactly like flat calls (no gate logic lives here).
 *
 * `discover` is a gateway too, but its actions are meta (catalog/explain/examples/ping/status)
 * and are handled by the dedicated discover handler.
 */

import type { McpResponse } from '../utils/mcpFormatter.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import { validateToolArguments } from '../middleware/validation.js';
import { OP_BY_ID } from '../config/opRegistry.js';
import {
  isGatewayName,
  resolveGatewayAction,
  actionsForGateway,
  FOLDED_OP_IDS,
} from '../config/gatewayResolver.js';
import { getFlatToolsPolicy } from '../config/toolSurfaceConfig.js';
import { routeExecutor, type RouteContext } from './index.js';
import { dispatchDiscover } from '../handlers/discover.js';

const FOLDED_OP_ID_SET: ReadonlySet<string> = new Set(FOLDED_OP_IDS);

/** True iff `name` is one of the 8 gateway tools (drives the dispatch fork in executeMcpTool). */
export function isGatewayTool(name: string): boolean {
  return isGatewayName(name);
}

/**
 * Dispatch a gateway `tools/call` to its resolved op. Returns a normal McpResponse (errors are
 * returned as `isError` responses, exactly like routeExecutor, rather than thrown).
 */
export async function dispatchGateway(
  gateway: string,
  args: any,
  ctx?: RouteContext,
): Promise<McpResponse> {
  // discover's meta-actions get bespoke handling (schemas/catalog/examples + ping/status).
  if (gateway === 'discover') {
    return dispatchDiscover(args ?? {}, ctx);
  }

  const action = args?.action;
  if (typeof action !== 'string' || action.length === 0) {
    return gatewayActionError(gateway, action, 'missing');
  }

  const resolution = resolveGatewayAction(gateway, action);
  if (!resolution) {
    return gatewayActionError(gateway, action, 'unknown');
  }
  const { opId, nestedAction } = resolution;

  // Strip the gateway discriminator; for session_pin re-inject the nested sub-action the flat
  // op's zod schema expects (its own `action` param: set|get|clear).
  const branchArgs: Record<string, any> = { ...(args ?? {}) };
  delete branchArgs.action;
  if (nestedAction !== undefined) branchArgs.action = nestedAction;

  // Reuse the per-op validator UNCHANGED (strict-key per branch, id-synonyms, actionable errors).
  let validated: any;
  try {
    validated = validateToolArguments(opId, branchArgs);
  } catch (err) {
    return formatMcpError(withDiscoverHint(err as Error, gateway, action), `${gateway}.${action}`);
  }

  // The ACTION-gate lives inside routeExecutor and keys on opId — so a gateway context.store
  // creates+attributes a session exactly like flat context_store, a passive gateway call
  // (context.search) creates none, and session.start does NOT pre-spawn (session_start ∉
  // ACTION_TOOLS). We deliberately add NO gate logic here.
  return routeExecutor(opId, validated, ctx);
}

/**
 * FLAT_TOOLS=reject policy: when a caller invokes a gateway-FOLDED flat opId directly (e.g.
 * `context_store`) and the policy is `reject`, return a deprecation error steering them to the
 * gateway form. Returns null when the call should proceed (policy=accept — the DEFAULT — or the
 * name is not a folded op, e.g. the always-flat recall_thread/smart_search/get_recommendations,
 * or a deprecated aidis_* alias). Kept here so the one policy decision has one home.
 */
export function flatRejectionError(toolName: string): McpResponse | null {
  if (getFlatToolsPolicy() !== 'reject') return null;
  if (!FOLDED_OP_ID_SET.has(toolName)) return null;
  const entry = OP_BY_ID.get(toolName);
  const gateway = entry?.gateway ?? 'the gateway';
  const action = entry?.action ?? '<action>';
  return formatMcpError(
    `Flat tool name '${toolName}' is deprecated on this instance (MANDREL_FLAT_TOOLS=reject). ` +
      `Call the '${gateway}' gateway instead: ${gateway}({action:'${action}', …}). ` +
      `Full contract: discover.explain — discover({action:'explain', tool:'${gateway}', op:'${action}'}).`,
    toolName,
  );
}

/** Build the missing/unknown-action error, listing the gateway's valid actions + the discover hint. */
function gatewayActionError(gateway: string, action: unknown, kind: 'missing' | 'unknown'): McpResponse {
  const valid = actionsForGateway(gateway).join(', ');
  const what =
    kind === 'missing'
      ? `The '${gateway}' tool requires a string 'action' discriminator.`
      : `Unknown action ${JSON.stringify(action)} for the '${gateway}' tool.`;
  const msg =
    `${what} Valid actions: ${valid}. ` +
    `Full contract: discover.explain — discover({action:'explain', tool:'${gateway}'}).`;
  return formatMcpError(msg, gateway);
}

/** Append the discover.explain self-heal hint to a validation error if it doesn't already carry one. */
function withDiscoverHint(err: Error, gateway: string, action: string): string {
  const base = err.message ?? String(err);
  if (base.includes('discover.explain')) return base;
  return (
    `${base}\n📎 Full contract: discover.explain — ` +
    `discover({action:'explain', tool:'${gateway}', op:'${action}'}).`
  );
}
