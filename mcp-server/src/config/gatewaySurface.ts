/**
 * Gateway advertised-surface builder — MCP-2026 rebuild, PHASE 2 (plan §1.2).
 *
 * Builds the `tools/list` payload for the GATEWAY surface (surface=gateway): the 8 action-
 * discriminated gateway envelopes + the 3 deliberately-FLAT headline tools. Two representations,
 * ONE source (OP_REGISTRY, via the resolver):
 *   - lazy  (default, "lazy+core"): each gateway = name + one-line description + a MINIMAL honest
 *     input schema: the `{action:{enum:[…]}}` discriminator PLUS registry-derived required-param
 *     hints (names + small closed enums) for the gateway's un-guessable WRITE actions (liftCore-
 *     Params) — the context win, tuned to close the first-call gap (the auditor rec b53c213f).
 *   - full: each gateway = the whole-tool action-discriminated `oneOf` (same branch composition
 *     discover.explain serves — shared via buildGatewayBranchSchema, so they cannot drift).
 *
 * The lazy list carries NO `outputSchema` (Phase 0 gated it off the legacy list too). The flat
 * tools advertise their real registry description + zod-derived input schema (also outputSchema-
 * stripped) so client-side tool-search can match the moat directly.
 *
 * DARK: this is only served when a human sets MANDREL_TOOL_SURFACE=gateway. At the `legacy`
 * default (buildAdvertisedTools) none of this reaches the wire.
 */

import { AIDIS_TOOL_DEFINITIONS, buildInputSchema, type ToolDefinition } from './toolDefinitions.js';
import { OP_BY_ID } from './opRegistry.js';
import {
  GATEWAY_ORDER,
  GATEWAY_DESCRIPTIONS,
  FLAT_ADVERTISE_ORDER,
  FLAT_LAZY_DESCRIPTIONS,
  WRITE_ACTIONS,
  IDENTIFIER_PARAMS,
} from './gatewayConfig.js';
import { actionsForGateway, resolveGatewayAction } from './gatewayResolver.js';
import { getLazyCoreEnumMax, type ToolListMode } from './toolSurfaceConfig.js';

/**
 * Compose the JSON-Schema branch for a gateway (gateway, action): the op's zod-derived params
 * with an `action` const discriminator prepended. For session_pin sub-actions the op's OWN nested
 * `action` param is dropped from the presented schema (the gateway discriminator fixes it). Shared
 * by full-mode `tools/list` AND discover.explain so the two representations never diverge.
 */
export function buildGatewayBranchSchema(
  gateway: string,
  action: string,
  opId: string,
  nestedAction?: string,
): Record<string, any> {
  const entry = OP_BY_ID.get(opId)!;
  const base = buildInputSchema(opId as any, entry.humanDescriptions);
  const props: Record<string, any> = { ...base.properties };
  const required = new Set<string>(base.required ?? []);
  if (nestedAction !== undefined) {
    delete props.action;
    required.delete('action');
  }
  return {
    type: 'object',
    properties: {
      action: { const: action, description: `Discriminator — selects the ${gateway}.${action} operation.` },
      ...props,
    },
    required: ['action', ...[...required]],
    additionalProperties: false,
  };
}

/** A lazy+core lifted prop: its minimal schema (type [+ enum]) and the write actions requiring it. */
interface LiftedCoreProp {
  schema: Record<string, any>;
  actions: string[];
}

/**
 * lazy+CORE param lifting (Phase 3, the auditor rec b53c213f, plan §1.2).
 *
 * For a gateway, compute the MINIMAL set of REQUIRED-param hints to lift into the lazy envelope so
 * a blind first call to an UN-GUESSABLE write contract can succeed without a `discover.explain`
 * round-trip. Registry-derived END-TO-END — the write classification (WRITE_ACTIONS), the required
 * set (buildInputSchema, the SAME zod-derived source the full surface uses), and the enums all come
 * from OP_REGISTRY — so lazy+core CANNOT drift from the real per-branch contract.
 *
 * An action is lifted iff BOTH:
 *   (1) it is a WRITE action (WRITE_ACTIONS), AND
 *   (2) its required params (minus the `action` discriminator, incl. session_pin's own nested
 *       `action`) include ≥1 param that is NOT a guessable identifier (IDENTIFIER_PARAMS) — i.e.
 *       the contract is genuinely un-guessable (content, a closed enum, or a multi-param record).
 * For every lifted action, its UN-GUESSABLE required params — the required params that are NOT
 * identifiers — are advertised, each tagged "REQUIRED for action:<a>". Guessable required IDs (e.g.
 * graph.link's `from`/`to`) STAY lazy per rule (3): a "link" op's endpoints are self-evident, and
 * a missed one now self-heals via the strict-key error that names every required param (Change B).
 * A closed enum ≤ getLazyCoreEnumMax() values on a lifted param is inlined as an actual `enum` (the
 * strongest attention channel — legacy 100%±0 proves the model executes flawlessly when the enum is
 * IN the advertised schema). Larger enums (e.g. the 15-value decisionType) are lifted by NAME only.
 * Optional params STAY lazy (one discover.explain away). A param required by MULTIPLE write actions
 * is merged (its description lists every requiring action).
 */
function liftCoreParams(gateway: string): Record<string, LiftedCoreProp> {
  const enumMax = getLazyCoreEnumMax();
  const lifted: Record<string, LiftedCoreProp> = {};

  for (const action of actionsForGateway(gateway)) {
    if (!WRITE_ACTIONS.has(action)) continue;
    const res = resolveGatewayAction(gateway, action)!;
    const base = buildInputSchema(res.opId as any, {}); // raw zod-derived shape, NO human prose
    // Drop the discriminator: for a normal gateway op `action` isn't a declared param; for the one
    // nested-action op (session_pin) its OWN `action` param is fixed by the gateway discriminator.
    const required = (base.required ?? []).filter((k) => k !== 'action');
    // The un-guessable required params — everything required that isn't a guessable identifier.
    const unguessable = required.filter((k) => !IDENTIFIER_PARAMS.has(k));
    // Gate (2): only lift a write action that carries an un-guessable required param.
    if (unguessable.length === 0) continue;

    for (const name of unguessable) {
      const src: any = (base.properties as any)[name] ?? {};
      if (!lifted[name]) {
        const schema: Record<string, any> = {};
        if (typeof src.type === 'string') schema.type = src.type;
        // Inline the enum ONLY if it is a small CLOSED enum (≤ the configured max).
        if (Array.isArray(src.enum) && src.enum.length > 0 && src.enum.length <= enumMax) {
          schema.enum = [...src.enum];
        }
        lifted[name] = { schema, actions: [] };
      }
      lifted[name].actions.push(action);
    }
  }
  return lifted;
}

/**
 * The lazy envelope for one gateway: the action-enum discriminator PLUS lazy+core required-param
 * hints for the gateway's un-guessable write actions (liftCoreParams). Optional/guessable params
 * stay lazy — the full per-action contract is one `discover.explain` call away (plan §1.2/§11).
 * Top-level `required` stays JUST `['action']`: the lifted params are CONDITIONALLY required per
 * action (stated in each description), not required of the envelope as a whole.
 */
function lazyGatewayTool(gateway: string): ToolDefinition {
  const properties: Record<string, any> = {
    action: {
      type: 'string',
      enum: [...actionsForGateway(gateway)],
    },
  };
  for (const [name, { schema, actions }] of Object.entries(liftCoreParams(gateway))) {
    properties[name] = {
      ...schema,
      description: `REQUIRED for ${actions.map((a) => `action:${a}`).join(', ')}.`,
    };
  }
  return {
    name: gateway,
    description: GATEWAY_DESCRIPTIONS[gateway as keyof typeof GATEWAY_DESCRIPTIONS],
    inputSchema: {
      type: 'object',
      properties,
      required: ['action'],
      // additionalProperties:true is deliberate + honest — branch params are accepted at the top
      // level and validated server-side, per-branch, strict-key (the envelope defers detail, never lies).
      additionalProperties: true,
    },
  };
}

/** The full envelope for one gateway: the whole-tool action-discriminated oneOf. */
function fullGatewayTool(gateway: string): ToolDefinition {
  const oneOf = actionsForGateway(gateway).map((a) => {
    const res = resolveGatewayAction(gateway, a)!;
    return buildGatewayBranchSchema(gateway, a, res.opId, res.nestedAction);
  });
  return {
    name: gateway,
    description: GATEWAY_DESCRIPTIONS[gateway as keyof typeof GATEWAY_DESCRIPTIONS],
    // A oneOf-shaped schema (no top-level `properties`) — valid MCP JSON Schema on a tool result-
    // adjacent surface. Cast because ToolDefinition.inputSchema is the object-properties shape.
    inputSchema: { type: 'object', oneOf } as unknown as ToolDefinition['inputSchema'],
  };
}

/**
 * A flat headline tool on the LAZY list: a TRIMMED description (plan §11 — "trim, never demote")
 * + the zod-DERIVED input schema with NO verbose per-param prose (buildInputSchema with an empty
 * human overlay), and no outputSchema. The tool stays flat + directly callable; the full param
 * contract is one discover.explain call away. This is the budget-critical path.
 */
function lazyFlatTool(opId: string): ToolDefinition {
  const description = FLAT_LAZY_DESCRIPTIONS[opId];
  if (!description) throw new Error(`[gatewaySurface] flat tool '${opId}' has no FLAT_LAZY_DESCRIPTIONS entry`);
  return { name: opId, description, inputSchema: buildInputSchema(opId as any, {}) };
}

/** A flat headline tool on the FULL list: the real registry definition verbatim, sans outputSchema. */
function fullFlatTool(opId: string): ToolDefinition {
  const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === opId);
  if (!def) throw new Error(`[gatewaySurface] flat tool '${opId}' missing from AIDIS_TOOL_DEFINITIONS`);
  const { outputSchema: _drop, ...rest } = def;
  return rest;
}

/**
 * Build the full GATEWAY-surface `tools/list` payload: 8 gateway envelopes (lazy|full) then the
 * 3 flat headline tools, in the plan §1.1 advertised order.
 */
export function buildGatewaySurface(mode: ToolListMode): ToolDefinition[] {
  const full = mode === 'full';
  const gateways = GATEWAY_ORDER.map((gw) => (full ? fullGatewayTool(gw) : lazyGatewayTool(gw)));
  const flats = FLAT_ADVERTISE_ORDER.map((opId) => (full ? fullFlatTool(opId) : lazyFlatTool(opId)));
  return [...gateways, ...flats];
}
