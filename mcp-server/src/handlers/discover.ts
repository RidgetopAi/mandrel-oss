/**
 * `discover` — the model-facing progressive-disclosure front door. MCP-2026 rebuild PHASE 2
 * (plan §1.5/§3). ONE gateway tool that answers "what can Mandrel do, and
 * what's the exact contract for X" so the lazy `tools/list` never has to ship every schema.
 *
 * Actions (all DERIVED from the op registry — no second hand-maintained catalog to drift):
 *   catalog  {query?}        → grouped {tool, action, oneLine} across every gateway + flat tool.
 *   explain  {tool, op?}     → full JSON-Schema-2020-12 contract. `op` given → that one branch;
 *                              `op` omitted → the whole tool as an action-discriminated `oneOf`.
 *                              THIS is where explain "walks the oneOf branches".
 *   examples {tool, op?}     → curated usage snippets (ported from the mandrel_examples corpus).
 *   contract                 → the AGENT CAPTURE CONTRACT: the record shapes to write, the op
 *                              that writes each, and the `metadata.capture` status vocabulary
 *                              (P4 L1). Also generated — never hand-written.
 *   ping     {message?}      → delegates to the mandrel_ping op.
 *   status                   → delegates to the mandrel_status op.
 *
 * Reuses the existing schema builders (buildInputSchema / buildOutputSchema) and the navigation
 * example corpus UNCHANGED — the gateway is a thin adapter, not a reimplementation.
 */

import type { McpResponse } from '../utils/mcpFormatter.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor, type RouteContext } from '../routes/index.js';
import { OP_BY_ID } from '../config/opRegistry.js';
import { buildInputSchema } from '../config/toolDefinitions.js';
import { buildGatewayBranchSchema } from '../config/gatewaySurface.js';
import { countAdvertisedSurface, describeAdvertisedSurface } from '../config/advertisedSurface.js';
import { buildOutputSchema, type OutputSchemaToolName } from '../config/outputSchemas.js';
import {
  isGatewayName,
  resolveGatewayAction,
  actionsForGateway,
  FLAT_OP_IDS,
} from '../config/gatewayResolver.js';
import {
  GATEWAY_ORDER,
  GATEWAY_DESCRIPTIONS,
  type GatewayName,
} from '../config/gatewayConfig.js';
import { navigationHandler } from './navigation.js';

const JSON_SCHEMA_2020 = 'https://json-schema.org/draft/2020-12/schema';

/** Entry point: fan a `discover` gateway call out to its action. */
export async function dispatchDiscover(args: any, ctx?: RouteContext): Promise<McpResponse> {
  const action = args?.action;
  if (typeof action !== 'string' || action.length === 0) {
    return discoverActionError(action, 'missing');
  }
  switch (action) {
    case 'catalog':
      return discoverCatalog(args);
    case 'explain':
      return discoverExplain(args);
    case 'examples':
      return discoverExamples(args);
    // THE AGENT CAPTURE CONTRACT (P4 L1). Delegated, not rendered here: the
    // ONE renderer is navigationHandler.getCaptureContract, reached through the routeExecutor
    // by both this action and the flat `mandrel_contract`.
    case 'contract':
      return delegate('mandrel_contract', args, ctx);
    case 'ping':
      return delegate('mandrel_ping', args, ctx);
    case 'status':
      return delegate('mandrel_status', args, ctx);
    default:
      return discoverActionError(action, 'unknown');
  }
}

/* ─────────────────────────── catalog ─────────────────────────── */

function discoverCatalog(args: any): McpResponse {
  const q = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
  const match = (s: string) => q === '' || s.toLowerCase().includes(q);

  const gateways = GATEWAY_ORDER.map((gw) => ({
    tool: gw,
    description: GATEWAY_DESCRIPTIONS[gw],
    actions: actionsForGateway(gw)
      .map((action) => {
        const res = resolveGatewayAction(gw, action)!;
        const op = OP_BY_ID.get(res.opId)!;
        // `opId` is the name the flat /mcp/tools/{opId} route serves. Carried, RENDERED and
        // MATCHED-ON for the same reason mandrel_help carries it: the flat
        // routes are live on every instance whatever MANDREL_TOOL_SURFACE says, and a
        // catalog that only prints the gateway call form makes the flat name unfindable —
        // `discover({action:'catalog', query:'mandrel_contract'})` returned nothing at all.
        return { action, opId: res.opId, oneLine: op.description };
      })
      .filter((a) => match(`${gw} ${a.action} ${a.opId} ${a.oneLine}`)),
  })).filter((g) => g.actions.length > 0 || match(`${g.tool} ${g.description}`));

  const flat = FLAT_OP_IDS.map((opId) => {
    const op = OP_BY_ID.get(opId)!;
    return { tool: opId, oneLine: op.description };
  }).filter((f) => match(`${f.tool} ${f.oneLine}`));

  const totalActions =
    gateways.reduce((n, g) => n + g.actions.length, 0) + flat.length;

  // SURFACE HEADER. The catalog is the front door an agent uses to orient, so it
  // states the size of the surface that agent is actually holding. Both numbers are MEASURED off
  // the array `tools/list` serves (config/advertisedSurface.ts) — no literal, and nothing to
  // hand-copy. `totalActions` above is the count of what is RENDERED below (filter-sensitive);
  // the header describes the whole surface, which is why the filtered case reports both.
  const surfaceCounts = countAdvertisedSurface();

  let text = '🧭 **Mandrel — capability catalog**';
  text += ` — ${describeAdvertisedSurface(surfaceCounts)}`;
  if (q) text += `; showing ${totalActions} matching "${args.query}"`;
  text += `\n\n`;
  for (const g of gateways) {
    text += `## ${g.tool} — ${g.description}\n`;
    for (const a of g.actions) {
      text += `• \`${g.tool}({action:'${a.action}'})\` \`${a.opId}\` — ${a.oneLine}\n`;
    }
    text += '\n';
  }
  if (flat.length > 0) {
    text += `## flat tools (called directly)\n`;
    for (const f of flat) text += `• \`${f.tool}\` — ${f.oneLine}\n`;
    text += '\n';
  }
  text += `💡 Full contract for any op: \`discover({action:'explain', tool:'<tool>', op:'<action>'})\`.`;

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      ok: true,
      gateways,
      flat,
      totalActions,
      // The MEASURED advertised surface — the same numbers the header prints,
      // on the machine channel. `totalActions` stays the RENDERED (filter-sensitive) count.
      surface: surfaceCounts.surface,
      advertisedTools: surfaceCounts.tools,
      advertisedOperations: surfaceCounts.operations,
    },
  };
}

/* ─────────────────────────── explain ─────────────────────────── */

function discoverExplain(args: any): McpResponse {
  const tool = args?.tool;
  if (typeof tool !== 'string' || tool.length === 0) {
    return formatMcpError(
      `discover.explain requires a 'tool' (a gateway name like 'context', or a flat tool like ` +
        `'recall_thread'). Call discover({action:'catalog'}) to list them.`,
      'discover.explain',
    );
  }
  const op: string | undefined = typeof args?.op === 'string' && args.op.length > 0 ? args.op : undefined;

  // Gateway tool.
  if (isGatewayName(tool)) {
    if (op) {
      const res = resolveGatewayAction(tool, op);
      if (!res) {
        return formatMcpError(
          `Unknown action '${op}' for the '${tool}' gateway. Valid actions: ` +
            `${actionsForGateway(tool).join(', ')}.`,
          'discover.explain',
        );
      }
      const branch = buildGatewayBranchSchema(tool, op, res.opId, res.nestedAction);
      const payload = {
        tool,
        op,
        description: OP_BY_ID.get(res.opId)!.description,
        inputSchema: { $schema: JSON_SCHEMA_2020, ...branch },
        outputSchema: buildOutputSchema(res.opId as OutputSchemaToolName),
        notes: gatewayNotes(tool),
      };
      return explainResponse(payload);
    }
    // Whole-tool: the action-discriminated oneOf (explain walks every branch). The gateway's
    // full outputSchema is likewise the oneOf of its branches' output schemas (plan §1.4c).
    const inOneOf = actionsForGateway(tool).map((a) => {
      const res = resolveGatewayAction(tool, a)!;
      return buildGatewayBranchSchema(tool, a, res.opId, res.nestedAction);
    });
    const outOneOf = actionsForGateway(tool).map((a) => {
      const res = resolveGatewayAction(tool, a)!;
      return buildOutputSchema(res.opId as OutputSchemaToolName);
    });
    const payload = {
      tool,
      description: GATEWAY_DESCRIPTIONS[tool as GatewayName],
      inputSchema: { $schema: JSON_SCHEMA_2020, type: 'object', oneOf: inOneOf },
      outputSchema: { oneOf: outOneOf },
      notes: gatewayNotes(tool),
    };
    return explainResponse(payload);
  }

  // Flat tool (recall_thread / smart_search / get_recommendations) or a raw flat opId.
  const entry = OP_BY_ID.get(tool);
  if (!entry) {
    return formatMcpError(
      `Unknown tool '${tool}'. Call discover({action:'catalog'}) to see every tool and action.`,
      'discover.explain',
    );
  }
  const payload = {
    tool,
    description: entry.description,
    inputSchema: {
      $schema: JSON_SCHEMA_2020,
      ...buildInputSchema(entry.opId as any, entry.humanDescriptions),
    },
    outputSchema: buildOutputSchema(entry.opId as OutputSchemaToolName),
    notes: 'Flat tool — call it directly by name (no action discriminator).',
  };
  return explainResponse(payload);
}

function gatewayNotes(gateway: string): string {
  return (
    `Call as ${gateway}({action:'<action>', …}). The legacy flat tool names still work ` +
    `(MANDREL_FLAT_TOOLS=accept). Params are validated strict per-branch server-side.`
  );
}

function explainResponse(payload: Record<string, any>): McpResponse {
  const text =
    `🔧 **discover.explain — ${payload.tool}${payload.op ? '.' + payload.op : ''}**\n\n` +
    `${payload.description}\n\n` +
    '```json\n' +
    JSON.stringify(payload.inputSchema, null, 2) +
    '\n```';
  return { content: [{ type: 'text', text }], structuredContent: { ok: true, ...payload } };
}

/* ─────────────────────────── examples ─────────────────────────── */

async function discoverExamples(args: any): Promise<McpResponse> {
  const tool = args?.tool;
  if (typeof tool !== 'string' || tool.length === 0) {
    return formatMcpError(
      `discover.examples requires a 'tool' (and optional 'op'). Call discover({action:'catalog'}) first.`,
      'discover.examples',
    );
  }
  const op: string | undefined = typeof args?.op === 'string' && args.op.length > 0 ? args.op : undefined;

  let opId: string | undefined;
  if (isGatewayName(tool)) {
    if (!op) {
      return formatMcpError(
        `discover.examples for the '${tool}' gateway needs an 'op' (e.g. ` +
          `discover({action:'examples', tool:'${tool}', op:'${actionsForGateway(tool)[0]}'})).`,
        'discover.examples',
      );
    }
    const res = resolveGatewayAction(tool, op);
    if (!res) {
      return formatMcpError(
        `Unknown action '${op}' for the '${tool}' gateway. Valid actions: ${actionsForGateway(tool).join(', ')}.`,
        'discover.examples',
      );
    }
    opId = res.opId;
  } else if (OP_BY_ID.has(tool)) {
    opId = tool;
  } else {
    return formatMcpError(
      `Unknown tool '${tool}'. Call discover({action:'catalog'}) to see every tool and action.`,
      'discover.examples',
    );
  }

  // Reuse the curated example corpus UNCHANGED (keyed by flat opId).
  return navigationHandler.getExamples({ toolName: opId });
}

/* ─────────────────────────── ping / status ─────────────────────────── */

async function delegate(opId: string, args: any, ctx?: RouteContext): Promise<McpResponse> {
  const branchArgs: Record<string, any> = { ...(args ?? {}) };
  delete branchArgs.action;
  let validated: any;
  try {
    validated = validateToolArguments(opId, branchArgs);
  } catch (err) {
    return formatMcpError(err as Error, opId);
  }
  return routeExecutor(opId, validated, ctx);
}

/* ─────────────────────────── errors ─────────────────────────── */

function discoverActionError(action: unknown, kind: 'missing' | 'unknown'): McpResponse {
  // DERIVED, not typed (no-second-catalog, opRegistry.ts:10-16). This used to be the literal
  // 'catalog, explain, examples, ping, status', which is a hand-maintained copy of the action
  // list — the exact artifact that goes stale the first time an action ships. It shipped one
  // action stale within the hour on P4 L1, which is why it is now read from the registry.
  const valid = actionsForGateway('discover').join(', ');
  const what =
    kind === 'missing'
      ? `The 'discover' tool requires a string 'action' discriminator.`
      : `Unknown action ${JSON.stringify(action)} for 'discover'.`;
  return formatMcpError(`${what} Valid actions: ${valid}.`, 'discover');
}
