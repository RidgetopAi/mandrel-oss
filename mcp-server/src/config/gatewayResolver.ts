/**
 * Gateway (gateway, action) → opId resolver — MCP-2026 rebuild, PHASE 2.
 *
 * PURE + DERIVED. Builds — once, at module load, from OP_REGISTRY (the single source) — the two
 * lookup structures every gateway consumer needs:
 *   1. RESOLVE:  `${gateway}.${action}` → { opId, nestedAction? }  (dispatch + discover.explain)
 *   2. ACTIONS_BY_GATEWAY:  gateway → ordered action discriminator list  (lazy-envelope enums)
 *
 * This module imports NOTHING from routes/ or handlers/ (it is pure config), so both the gateway
 * dispatcher (routes/gateway.ts) and the discover handler (handlers/discover.ts) can depend on it
 * without a circular import.
 *
 * THE ONE nested-action op is session_pin (rebuild plan §1.1 "pin_* flattening"): its gateway
 * exposes pin_set/pin_get/pin_clear as FIRST-CLASS discriminator values, each resolving back to
 * the single `session_pin` op with the flat `action` param re-injected (set/get/clear). The base
 * `session.pin` is deliberately NOT a discriminator (removing the only nested-action precedent).
 */

import { OP_REGISTRY } from './opRegistry.js';
import { GATEWAY_ORDER, type GatewayName } from './gatewayConfig.js';

export interface GatewayResolution {
  /** The canonical op id (== flat tool name) the (gateway, action) pair resolves to. */
  opId: string;
  /**
   * session_pin ONLY: the nested `action` sub-value (set|get|clear) to re-inject into the
   * delegated branch args, because that op's zod schema declares its own `action` param.
   */
  nestedAction?: string;
}

const RESOLVE = new Map<string, GatewayResolution>();
const ACTIONS_BY_GATEWAY = new Map<string, string[]>();

for (const op of OP_REGISTRY) {
  if (op.kind !== 'gateway') continue;
  const gw = op.gateway;
  if (!ACTIONS_BY_GATEWAY.has(gw)) ACTIONS_BY_GATEWAY.set(gw, []);
  const actions = ACTIONS_BY_GATEWAY.get(gw)!;

  if (op.gatewayActions) {
    // Nested-action op (session_pin): expand into first-class discriminator actions; the base
    // op.action ('pin') is intentionally NOT itself a gateway discriminator.
    for (const [gatewayAction, nestedAction] of Object.entries(op.gatewayActions)) {
      RESOLVE.set(`${gw}.${gatewayAction}`, { opId: op.opId, nestedAction });
      actions.push(gatewayAction);
    }
  } else {
    // op.action is non-null for a plain gateway op.
    RESOLVE.set(`${gw}.${op.action}`, { opId: op.opId });
    actions.push(op.action as string);
  }
}

const GATEWAY_NAME_SET: ReadonlySet<string> = new Set(GATEWAY_ORDER);

/** The registry's FLAT ops (kind 'flat') — their own front-door tools, in registry order. */
export const FLAT_OP_IDS: readonly string[] = OP_REGISTRY.filter((o) => o.kind === 'flat').map(
  (o) => o.opId,
);

/** The gateway-FOLDED flat opIds (kind 'gateway') — the flat names FLAT_TOOLS=reject would block. */
export const FOLDED_OP_IDS: readonly string[] = OP_REGISTRY.filter((o) => o.kind === 'gateway').map(
  (o) => o.opId,
);

/** True iff `name` is one of the 8 action-discriminated gateway tools. */
export function isGatewayName(name: string): name is GatewayName {
  return GATEWAY_NAME_SET.has(name);
}

/** Resolve a (gateway, action) pair to its op, or undefined if the pair is unknown. */
export function resolveGatewayAction(gateway: string, action: string): GatewayResolution | undefined {
  return RESOLVE.get(`${gateway}.${action}`);
}

/** The ordered action discriminator list a gateway advertises (drives the lazy-envelope enum). */
export function actionsForGateway(gateway: string): readonly string[] {
  return ACTIONS_BY_GATEWAY.get(gateway) ?? [];
}

/** All resolvable `${gateway}.${action}` keys (for parity/coverage tests). */
export function allGatewayActionKeys(): readonly string[] {
  return [...RESOLVE.keys()];
}
