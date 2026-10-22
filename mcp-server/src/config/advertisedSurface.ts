/**
 * The ADVERTISED tool surface — one place that answers both
 *   "what does `tools/list` serve?"   (buildAdvertisedTools)
 *   "how big is it, in tools and in operations?" (countAdvertisedSurface)
 *
 * WHY THIS MODULE EXISTS. `buildAdvertisedTools` used to live in
 * server/registerMcpHandlers.ts, so anything OUTSIDE the server layer that wanted to state
 * the size of the surface (mandrel_help's header, discover.catalog's header) either had to
 * reach across the layering or — the bug we are fixing — re-derive it from a DIFFERENT source
 * and drift. It now lives in config/ beside the sources it composes; registerMcpHandlers
 * re-exports it verbatim so every existing importer (and the ListTools handler itself) keeps
 * reading the SAME function. There is exactly one assembler.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE DRIFT CLASS THIS CLOSES.
 *
 * `mandrel_help` printed "N Tools Available Across M Categories" from the FLAT catalog on
 * EVERY surface. Under MANDREL_TOOL_SURFACE=gateway the client's `tools/list` holds ~11 tools,
 * so help told an agent it had ~60 tools while it held 11 — orienting it against a surface it
 * was not on. (The same class had already bitten the prose: our own CLAUDE.md carried a
 * hand-copied "52", then "54", while live was 57.)
 *
 * The fix is NOT a second literal. BOTH numbers are computed here from the live advertised
 * array itself:
 *   tools      = buildAdvertisedTools(...).length          — literally the wire `tools/list` serves
 *   operations = Σ over those tools of its operation count — a gateway contributes its action
 *                count (actionsForGateway, the op-registry-derived resolver); any other tool is
 *                one operation.
 * So the counts cannot disagree with the surface: they are MEASURED off it, not asserted about
 * it. Ship a tool, ship a gateway action, or flip the surface flag and both numbers move on
 * their own. No count literal appears in this file, in the headers it feeds, or in the tests
 * that guard them (advertisedSurfaceCounts.contract.test.ts drives fixture surfaces of known,
 * DIFFERENT sizes and asserts the rendered numbers follow the fixture).
 *
 * On the LEGACY surface every advertised tool is exactly one operation, so operations == tools
 * — which is precisely why legacy keeps its historical "N Tools Available" phrasing and only
 * the gateway surface needs the two-number "N operations across M tools" framing.
 */

import { AIDIS_TOOL_DEFINITIONS, type ToolDefinition } from './toolDefinitions.js';
import {
  ADVERTISE_OUTPUT_SCHEMAS,
  getToolSurface,
  getToolListMode,
  type ToolSurface,
  type ToolListMode,
} from './toolSurfaceConfig.js';
import { buildGatewaySurface } from './gatewaySurface.js';
import { actionsForGateway, isGatewayName, resolveGatewayAction } from './gatewayResolver.js';
import { OP_BY_ID } from './opRegistry.js';

/**
 * Build the `tools/list` (ListTools) payload — the SINGLE place the advertised tool
 * surface is assembled, so the wire the handler serves and the wire the token-meter
 * test measures are the SAME code path (no reimplementation to drift).
 *
 * SURFACE SWITCH (MCP-2026 Phase 2): `surface` (default from config, DEFAULT `legacy`) selects
 * the advertised surface:
 *   - `legacy` (DEFAULT): the registry-derived flat tools, BYTE-IDENTICAL to HEAD. The Phase-0
 *     `advertiseOutputSchemas` flag still gates the outputSchema wire trim on this path
 *     (default ON = byte-identical).
 *   - `gateway`: the gateway surface (the gateway envelopes + the flat headline tools),
 *     lazy|full per `listMode`.
 *
 * NOTE (Phase-1 debt sweep): the historical `DISABLED_TOOLS` filter (the old code_ and complexity_
 * tool families) is GONE — those tools were removed from the op registry in Phase 1, so the
 * registry-derived AIDIS_TOOL_DEFINITIONS is already the closed op set and the filter had
 * nothing left to remove.
 */
export function buildAdvertisedTools(
  advertiseOutputSchemas: boolean = ADVERTISE_OUTPUT_SCHEMAS,
  surface: ToolSurface = getToolSurface(),
  listMode: ToolListMode = getToolListMode(),
): ToolDefinition[] {
  if (surface === 'gateway') {
    // The gateway surface is intrinsically lazy w.r.t. outputSchema (§1.2 — none on the list),
    // independent of the Phase-0 flag.
    return buildGatewaySurface(listMode);
  }
  // legacy (DEFAULT) — the registry-derived flat tools.
  const tools = AIDIS_TOOL_DEFINITIONS;
  if (advertiseOutputSchemas) return tools;
  // Strip ONLY the outputSchema advertisement; every other field is preserved verbatim.
  return tools.map(({ outputSchema: _outputSchema, ...rest }) => rest);
}

/** The measured size of an advertised surface. Never asserted — always counted. */
export interface AdvertisedSurfaceCounts {
  /** Which surface these numbers describe. */
  surface: ToolSurface;
  /** How many TOOLS `tools/list` advertises — `buildAdvertisedTools(...).length`. */
  tools: number;
  /** How many callable OPERATIONS those tools reach (a gateway contributes its actions). */
  operations: number;
}

/** ONE callable operation on the advertised surface. */
export interface AdvertisedOperation {
  /** The advertised TOOL it is called on — a gateway name, or the flat tool's own name. */
  tool: string;
  /** The gateway action, when this operation is reached through a gateway envelope. */
  action?: string;
  /** The underlying op-registry id (what the category + description come from). */
  opId: string;
  /** How a caller invokes it ON THIS SURFACE, e.g. `context({action:'store'})` or `smart_search`. */
  label: string;
  /** The op registry's one-line description. */
  description: string;
}

/**
 * ENUMERATE every callable operation on the advertised surface — the list the counts are the
 * LENGTH of, and the list mandrel_help renders on the gateway surface.
 *
 * WHY ONE LIST AND NOT TWO NUMBERS (the reviewer finding on 22c79e9). The first cut counted
 * operations with a `reduce` and rendered the body from the FLAT catalog. Both were "derived", but
 * from DIFFERENT walks — and they disagreed by exactly the `session_pin` fan-out: one flat catalog
 * entry (`session_pin`) is THREE gateway actions (`session.pin_set` / `pin_get` / `pin_clear`), so
 * the header said 62 while the body enumerated 60. A header that contradicts its own body misleads
 * the very agent this task exists to stop misleading. Two derivations of the same fact is the
 * A past incident shape: they agree today and nothing makes them agree tomorrow.
 *
 * So there is now ONE walk. `countAdvertisedSurface().operations` is this array's LENGTH, and the
 * gateway body renders THIS array. Body and header cannot diverge because they are the same list —
 * not two things kept in sync.
 */
export function listAdvertisedOperations(
  surface: ToolSurface = getToolSurface(),
  listMode: ToolListMode = getToolListMode(),
): AdvertisedOperation[] {
  const advertised = buildAdvertisedTools(ADVERTISE_OUTPUT_SCHEMAS, surface, listMode);
  const ops: AdvertisedOperation[] = [];

  for (const tool of advertised) {
    if (isGatewayName(tool.name)) {
      // A gateway envelope fans out to its registry-derived action list.
      for (const action of actionsForGateway(tool.name)) {
        // An ADVERTISED action that the resolver cannot map is a contradiction the gatewaySurface
        // contract test already forbids. If it ever happened anyway, the two wrong answers are
        // (a) throw — which kills mandrel_help outright — and (b) drop the op, which silently
        // breaks the body-equals-header invariant this list exists to hold. So: keep the operation
        // (it is advertised, therefore it is part of the surface's size) under a synthetic opId,
        // which lands it in the visible `Uncategorized` bucket rather than vanishing.
        const opId = resolveGatewayAction(tool.name, action)?.opId ?? `${tool.name}.${action}`;
        ops.push({
          tool: tool.name,
          action,
          opId,
          label: `${tool.name}({action:'${action}'})`,
          description: OP_BY_ID.get(opId)?.description ?? tool.description,
        });
      }
      continue;
    }
    // Any other advertised tool — a legacy flat tool, or one of the deliberately-flat headline
    // tools on the gateway surface — is exactly one operation, called by its own name.
    ops.push({
      tool: tool.name,
      opId: tool.name,
      label: tool.name,
      description: OP_BY_ID.get(tool.name)?.description ?? tool.description,
    });
  }
  return ops;
}

/**
 * MEASURE the advertised surface. Both numbers are derived from the very array
 * `buildAdvertisedTools` hands the ListTools handler, so a header rendered from this cannot
 * describe a surface the client is not holding — and `operations` is the LENGTH of the operation
 * list the body renders, so the header cannot out-count its own body either.
 */
export function countAdvertisedSurface(
  surface: ToolSurface = getToolSurface(),
  listMode: ToolListMode = getToolListMode(),
): AdvertisedSurfaceCounts {
  return {
    surface,
    tools: buildAdvertisedTools(ADVERTISE_OUTPUT_SCHEMAS, surface, listMode).length,
    operations: listAdvertisedOperations(surface, listMode).length,
  };
}

/**
 * The ONE rendering of those counts as prose, so the header in mandrel_help and the header in
 * discover.catalog cannot phrase (or miscount) the surface differently — one sentence, one place.
 *
 * On the gateway surface the two numbers are genuinely different facts and BOTH are stated
 * ("N operations across M tools" — the framing locked for an earlier task). On legacy every tool is
 * exactly one operation, so restating the same number twice would be noise: it degrades to the
 * single count. The branch is on the measured surface, not on a literal.
 */
export function describeAdvertisedSurface(
  counts: AdvertisedSurfaceCounts = countAdvertisedSurface(),
): string {
  return counts.surface === 'gateway'
    ? `${counts.operations} operations across ${counts.tools} tools`
    : `${counts.tools} tools`;
}
