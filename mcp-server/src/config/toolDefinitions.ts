/**
 * AIDIS Tool Definitions
 *
 * The advertised MCP tool surface — DERIVED, not hand-maintained. As of the MCP-2026
 * rebuild Phase 1 both the tool array AND the category grouping are
 * generated from the SINGLE source of truth, config/opRegistry.ts (`OP_REGISTRY`):
 *   - AIDIS_TOOL_DEFINITIONS  = OP_REGISTRY mapped to {name, description, inputSchema, outputSchema}
 *   - TOOL_CATEGORIES         = OP_REGISTRY grouped by each entry's `category`
 * There is no longer a second hand-kept list to drift from (the class fix). A byte-identical
 * snapshot test (src/tests/toolSurfaceGolden.contract.test.ts) proves this derivation changed
 * ZERO wire bytes vs the pre-refactor definitions.
 *
 * This module remains the single source both the main MCP server and the HTTP bridge read.
 *
 * Last Updated: 2026-07-19 (Phase 1 — registry-derived)
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { validationSchemas } from '../middleware/validation.js';
import {
  buildOutputSchema,
  outputZodSchemas,
  type OutputSchemaToolName,
  type JsonObjectSchema,
} from './outputSchemas.js';
import {
  OP_REGISTRY,
  CATEGORY_ORDER,
  type ToolCategory,
} from './opRegistry.js';

// Re-export the category vocabulary from its single source (opRegistry) so existing
// importers of these symbols from toolDefinitions keep working unchanged.
export { CATEGORY_ORDER };
export type { ToolCategory };

/**
 * Tool Definition Interface
 * Matches the MCP SDK Tool type structure
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /**
   * MCP dual-channel OUTPUT contract. The JSON Schema that a tool's
   * `structuredContent` conforms to. Attached table-driven (mirroring inputSchema)
   * from config/outputSchemas.ts — see attachOutputSchemas() below. Every tool gets
   * one; a contract test fails if any is missing.
   */
  outputSchema?: JsonObjectSchema;
}

/**
 * CLASS FIX (schema-drift keystone): generate the model-facing JSON inputSchema
 * DIRECTLY from the zod schema that actually gates the request in
 * middleware/validation.ts. The model can no longer be shown params the validator
 * silently drops (zod uses .parse(), not .strict(), so undeclared/divergent params
 * vanish without error). One source of truth → the two layers cannot diverge again.
 *
 * `humanDescriptions` lets us keep the friendly per-param help text (zod schemas
 * don't carry it). It is OVERLAY ONLY — it can never add/rename a param that zod
 * doesn't define, so it cannot reintroduce drift. A schema-match test asserts the
 * derived `properties` keyset == the zod keyset for every retrieval tool.
 *
 * The `humanDescriptions` now live beside their opId in config/opRegistry.ts (the single
 * source); this function is unchanged and still overlays them onto the zod-derived schema.
 */
export function buildInputSchema(
  toolName: keyof typeof validationSchemas,
  humanDescriptions: Record<string, string> = {}
): ToolDefinition['inputSchema'] {
  const zodSchema = validationSchemas[toolName];
  // $refStrategy:'none' flattens .refine()/nested shapes to a plain object schema
  // with top-level `properties` (verified for the refined context_search schema).
  const json = zodToJsonSchema(zodSchema as any, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as any;

  const properties: Record<string, any> = { ...(json.properties ?? {}) };

  // Overlay human-friendly descriptions onto params zod already defines.
  for (const [key, desc] of Object.entries(humanDescriptions)) {
    if (properties[key]) {
      properties[key] = { ...properties[key], description: desc };
    }
  }

  return {
    type: 'object',
    properties,
    required: Array.isArray(json.required) ? json.required : [],
    // STRICT MODE: emit additionalProperties:false so the model gets an
    // EXACT contract — exactly the params the zod validator declares, no more. This is
    // safe because it's derived at the SOURCE from the same zod schema that gates the
    // request, and the validator now ALSO rejects undeclared keys (validation.ts
    // strict-key check), so advertised == accepted. zodToJsonSchema already emits
    // additionalProperties:false for a plain zod object; we make the contract explicit
    // here rather than relying on it (and to cover the refined/$ref-flattened shapes).
    // SYNONYM SAFETY: decision tools accept AI-friendly synonyms (reasoning→rationale,
    // etc.); those are normalized to the canonical param BEFORE strict validation runs
    // (normalizeDecisionSynonyms in validation.ts), so strict mode never rejects a real
    // synonym call — the model is simply shown the canonical names.
    additionalProperties: false,
  };
}

/**
 * The advertised tool set — DERIVED from OP_REGISTRY (single source, ordered). Each entry
 * becomes {name, description, inputSchema}; attachOutputSchemas() then appends outputSchema
 * (byte-identical field order to the historical hand-written definitions).
 */
export const AIDIS_TOOL_DEFINITIONS: ToolDefinition[] = OP_REGISTRY.map((op) => ({
  name: op.opId,
  description: op.description,
  inputSchema: buildInputSchema(
    op.opId as keyof typeof validationSchemas,
    op.humanDescriptions,
  ),
}));

/**
 * DUAL-CHANNEL OUTPUT: attach the table-driven `outputSchema` to
 * EVERY tool definition from the single source of truth (config/outputSchemas.ts),
 * exactly mirroring how buildInputSchema feeds inputSchema. Done in ONE place so a
 * new tool can't ship without an output contract: if a definition's name has no
 * entry in outputZodSchemas this throws at import time (fail fast, not silently
 * shipping a tool with no machine-readable schema). The dualChannelOutput contract
 * test is the permanent guard around this invariant.
 */
function attachOutputSchemas(defs: ToolDefinition[]): void {
  for (const def of defs) {
    if (!(def.name in outputZodSchemas)) {
      throw new Error(
        `[toolDefinitions] tool '${def.name}' has no outputSchema entry in ` +
          `config/outputSchemas.ts — every tool MUST declare a dual-channel output ` +
          `contract. Add it to outputZodSchemas.`
      );
    }
    def.outputSchema = buildOutputSchema(def.name as OutputSchemaToolName);
  }
}

attachOutputSchemas(AIDIS_TOOL_DEFINITIONS);

/**
 * SINGLE SOURCE OF CATEGORY TRUTH (catalog-drift class fix, extended by the
 * Phase 1 registry refactor).
 *
 * THE BUG CLASS this closes: mandrel_help used to render from a SEPARATE hardcoded
 * catalog inside handlers/navigation.ts (`this.toolCatalog`). That second copy drifted
 * from AIDIS_TOOL_DEFINITIONS. Two hand-maintained lists of "what tools exist" inevitably
 * diverge. Phase 1 goes one further: TOOL_CATEGORIES is no longer even hand-written HERE —
 * it is DERIVED from OP_REGISTRY (each op carries its `category`), grouped in registry order
 * (which reproduces the historical intra-category order). `mandrel_help` derives its groups,
 * tool list, AND counts from these exports at runtime — there is no second catalog to drift.
 *
 *  - CATEGORY_ORDER     — the ordered category display names (re-exported from opRegistry).
 *  - TOOL_CATEGORIES    — categoryName → ordered list of tool names within that category,
 *                         grouped from OP_REGISTRY. The tool's name + description still come
 *                         from AIDIS_TOOL_DEFINITIONS (never re-typed here).
 *
 * INVARIANT, enforced fail-fast at import time by assertCategoryCoverage() below
 * (same spirit as attachOutputSchemas): every tool in AIDIS_TOOL_DEFINITIONS is mapped
 * to EXACTLY ONE category, and TOOL_CATEGORIES references no tool that doesn't exist.
 */
export const TOOL_CATEGORIES: Record<ToolCategory, string[]> = (() => {
  const grouped = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, [] as string[]]),
  ) as Record<ToolCategory, string[]>;
  for (const op of OP_REGISTRY) {
    grouped[op.category].push(op.opId);
  }
  return grouped;
})();

/**
 * Resolve the single-source category for a tool name (the same source mandrel_help and
 * mandrel_explain read). Returns undefined for an unknown tool.
 */
export function categoryForTool(toolName: string): ToolCategory | undefined {
  for (const category of CATEGORY_ORDER) {
    if (TOOL_CATEGORIES[category].includes(toolName)) {
      return category;
    }
  }
  return undefined;
}

/**
 * Fail-fast coverage guard (mirrors attachOutputSchemas). Asserts the category map and
 * the tool definitions describe EXACTLY the same set, each tool categorized once. Throws
 * at import time so a drift can never reach a running server or a green build.
 */
function assertCategoryCoverage(defs: ToolDefinition[]): void {
  // 1. CATEGORY_ORDER and TOOL_CATEGORIES keys agree (no category without a slot / order).
  const orderSet = new Set<string>(CATEGORY_ORDER);
  for (const key of Object.keys(TOOL_CATEGORIES)) {
    if (!orderSet.has(key)) {
      throw new Error(
        `[toolDefinitions] category '${key}' is in TOOL_CATEGORIES but missing from ` +
          `CATEGORY_ORDER — add it to the display order (single source).`
      );
    }
  }

  // 2. Each tool appears in exactly one category, and no category lists a phantom tool.
  const defNames = new Set(defs.map((d) => d.name));
  const seen = new Map<string, string>(); // toolName -> category it was found in
  for (const category of CATEGORY_ORDER) {
    for (const toolName of TOOL_CATEGORIES[category]) {
      if (!defNames.has(toolName)) {
        throw new Error(
          `[toolDefinitions] category '${category}' lists tool '${toolName}' which is ` +
            `not in AIDIS_TOOL_DEFINITIONS — remove it or fix the name (single source).`
        );
      }
      const prior = seen.get(toolName);
      if (prior) {
        throw new Error(
          `[toolDefinitions] tool '${toolName}' is categorized twice ('${prior}' and ` +
            `'${category}') — each tool must map to EXACTLY ONE category.`
        );
      }
      seen.set(toolName, category);
    }
  }

  // 3. Every defined tool is categorized (no tool silently falling out of mandrel_help).
  const uncategorized = defs.filter((d) => !seen.has(d.name)).map((d) => d.name);
  if (uncategorized.length > 0) {
    throw new Error(
      `[toolDefinitions] these tools have NO category in TOOL_CATEGORIES and would ` +
        `vanish from mandrel_help: ${uncategorized.join(', ')}. Add each to exactly ` +
        `one category in TOOL_CATEGORIES (the single source of catalog truth).`
    );
  }
}

assertCategoryCoverage(AIDIS_TOOL_DEFINITIONS);
