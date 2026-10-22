/**
 * Shared typed-edge (TreeWalker) vocabulary — the ONE home for how a graph edge reads in
 * each direction and how each endpoint kind is coloured. The Contexts + Tasks screens each
 * carry their own historical copy of this map (pre-dating this module); the Decisions
 * screen (P2) consumes THIS shared module rather than adding a third copy.
 * Collapsing the two older copies onto this module is a clean follow-up.
 *
 * CSS var NAMES only (resolved with `var(--x)` at the callsite) — no hex ever lands in a
 * component. The label vocabulary is derived from the edge-type domain
 * (mcp-server/src/config/edgeTypes.ts).
 */

/**
 * kind → the CSS custom-property that paints its typed-edge target dot. A decision is blue,
 * a context violet (or its own context_type hue), a task green. Superset of both older
 * copies so it can resolve any endpoint kind.
 */
export const KIND_DOT_VAR: Record<string, string> = {
  handoff: '--teal',
  milestone: '--violet',
  completion: '--green',
  decision: '--blue',
  planning: '--amber',
  reflections: '--amber',
  discussion: '--tx-3',
  code: '--tx-3',
  lessons: '--tx-3',
  note: '--tx-3',
  error: '--rose',
  context: '--violet',
  task: '--green',
} as const;

/** kind → dot CSS var, defaulting to a muted text token for an unknown/blank kind. */
export function kindDotVar(kind: string | undefined | null): string {
  if (!kind) return '--tx-3';
  return KIND_DOT_VAR[kind] ?? '--tx-3';
}

/**
 * TYPED-EDGE LABEL VOCABULARY — how each edge type reads in each direction (the mock's
 * "decided ←" / "caused →" / "informs →" rows). `outgoing` reads the edge forward (this
 * record → target); `incoming` reads its reverse (target → this record). Covers the full
 * v1 domain so a new edge type never renders as a raw slug; `edgeLabel` falls back to a
 * humanized slug if an unknown edge ever appears.
 */
export const EDGE_LABELS: Record<string, { outgoing: string; incoming: string }> = {
  decided_by: { outgoing: 'decided by', incoming: 'decides' },
  informs: { outgoing: 'informs', incoming: 'informed by' },
  supersedes: { outgoing: 'supersedes', incoming: 'superseded by' },
  possibly_supersedes: { outgoing: 'may supersede', incoming: 'may be superseded by' },
  related_to: { outgoing: 'related to', incoming: 'related to' },
  learned_from: { outgoing: 'learned from', incoming: 'informed' },
  caused: { outgoing: 'caused', incoming: 'caused by' },
  built_by: { outgoing: 'built by', incoming: 'builds' },
  proposed_by: { outgoing: 'proposed by', incoming: 'proposes' },
  produced_outcome: { outgoing: 'produced', incoming: 'outcome of' },
} as const;

/** The human label for an edge as read in a direction (humanized slug fallback). */
export function edgeLabel(edgeType: string, direction: 'outgoing' | 'incoming'): string {
  const spec = EDGE_LABELS[edgeType];
  if (spec) return spec[direction];
  return edgeType.replace(/_/g, ' ');
}
