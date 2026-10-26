/**
 * TreeWalker configuration — the single named home for every TreeWalker tunable (house rule
 * configs-not-hardcoded). Holds the NEW trust vocabulary (proven / soaking / unproven /
 * stale), the record-kind colour order (colour ENCODES the kind, fixed categorical order),
 * the graph-layout geometry, and the backend-readiness flag that gates the live data path.
 *
 * The typed-EDGE vocabulary (decided_by / informs / caused / supersedes labels + endpoint
 * dots) is REUSED from the shared `config/graphEdges` module — NOT re-copied here
 * (one home for the edge vocab). Only the trust vocab is new, and it lives here.
 */
import type { RecordKind, TrustLevel } from '../../api/domains/treewalker';

// Re-export the shared typed-edge vocabulary so the parts import it from the module home.
export { edgeLabel, kindDotVar, EDGE_LABELS, KIND_DOT_VAR } from '../../config/graphEdges';

export const TREEWALKER_CONFIG = {
  /**
   * Whether the Command backend exposes the whole-thread graph + recall_thread story
   * endpoint (GET /api/treewalker/thread + /api/treewalker/:anchorId/thread). LIVE
   * 2026-07-15: real BFS traversal over the `links` graph + a
   * grounded trust read. The screen reads live; a genuinely-empty thread still renders the
   * honest empty state and NEVER fabricates a thread.
   */
  backendReady: true,
  /** react-query staleTime for the thread read. */
  staleTimeMs: 1000 * 60 * 2,
  /** Canvas height (px) — the graph viewport (mock `.canvas` = 600px). */
  canvasHeight: 600,
  /** Grid layout geometry for the deterministic node placement (see graph.ts). */
  layout: {
    /** Columns in the deterministic grid layout. */
    columns: 3,
    /** Horizontal spacing between lane columns (px). */
    columnGap: 210,
    /** Vertical spacing between depth rows (px). */
    rowGap: 96,
    /** Top/left padding of the laid-out graph (px). */
    padX: 40,
    padY: 30,
  },
  /**
   * The character budget for an UNNAMED drawer's rendered label (P2).
   * A named drawer shows its full `branch:<name>` tag untruncated — it was
   * chosen by hand, so it is trusted to be short. An unnamed one falls back to the spine's
   * own title, which carries no such guarantee, so it is truncated to this budget (plus an
   * ellipsis) before it ever reaches the DOM — the CSS `text-overflow: ellipsis` on
   * `.branchName` still applies underneath as a second line of defense for edge widths.
   */
  branchTitleMaxChars: 40,
} as const;

/**
 * TRUST VOCABULARY — the CANONICAL bands (PHASE 2 item e), one per
 * mcp-server trust band so the same record reads the same on every screen. `dotVar` is a
 * CSS custom-property NAME (resolved with `var(--x)` at the callsite) — no hex ever lands
 * in a component (guard-tested). `ring` keys the CSS-module ring class.
 *
 *   trusted      — green : outcome evidence puts it at/above trusted_at — rely on it.
 *   ok           — teal  : has outcome evidence, below trusted-grade.
 *   unproven     — amber : cold-start; recorded, no outcome evidence yet.
 *   stale        — grey  : too old/weak to lean on.
 *   superseded   — rose  : a newer record declared-replaced it — don't act on it.
 *   contradicted — rose  : a live record asserts the opposite — don't act on it.
 */
export const TRUST_META: Record<TrustLevel, { label: string; dotVar: string; ring: TrustLevel }> = {
  trusted: { label: 'trusted', dotVar: '--green', ring: 'trusted' },
  ok: { label: 'ok', dotVar: '--teal', ring: 'ok' },
  unproven: { label: 'unproven', dotVar: '--amber', ring: 'unproven' },
  stale: { label: 'stale', dotVar: '--tx-4', ring: 'stale' },
  superseded: { label: 'superseded', dotVar: '--rose', ring: 'superseded' },
  contradicted: { label: 'contradicted', dotVar: '--rose', ring: 'contradicted' },
} as const;

/** The FIXED categorical order trust reads render in (legend + trust bar) — most→least trustworthy, the canonical TRUST_BANDS order. */
export const TRUST_ORDER: readonly TrustLevel[] = [
  'trusted',
  'ok',
  'unproven',
  'stale',
  'superseded',
  'contradicted',
] as const;

export function trustLabel(trust: TrustLevel | undefined | null): string {
  if (!trust) return '—';
  return TRUST_META[trust]?.label ?? trust;
}
export function trustDotVar(trust: TrustLevel | undefined | null): string {
  if (!trust) return '--tx-4';
  return TRUST_META[trust]?.dotVar ?? '--tx-4';
}

/**
 * RECORD-KIND VOCABULARY — kind → { label, colour token }. Colour encodes the record kind
 * on the node body dot + the story kind tag (decision=blue, task=teal, context=violet,
 * handoff=teal). FIXED categorical order (the legend renders in this order).
 */
export const KIND_META: Record<RecordKind, { label: string; dotVar: string }> = {
  decision: { label: 'decision', dotVar: '--blue' },
  task: { label: 'task', dotVar: '--teal' },
  context: { label: 'context', dotVar: '--violet' },
  handoff: { label: 'handoff', dotVar: '--teal' },
} as const;

/** The fixed categorical kind order (the canvas legend's `record` row). */
export const KIND_ORDER: readonly RecordKind[] = ['decision', 'task', 'context', 'handoff'] as const;

export function kindLabel(kind: RecordKind | undefined | null): string {
  if (!kind) return 'record';
  return KIND_META[kind]?.label ?? kind;
}
export function kindColorVar(kind: RecordKind | undefined | null): string {
  if (!kind) return '--tx-3';
  return KIND_META[kind]?.dotVar ?? '--tx-3';
}

/**
 * The typed edges the legend documents, in fixed order, with the CSS-module edge class that
 * paints each (informs=teal, decided=blue, caused=violet, supersedes=dashed rose). The label
 * text itself comes from the shared `edgeLabel(edgeType,'outgoing')` — not re-typed here.
 */
export const EDGE_LEGEND: readonly { edgeType: string; klass: string }[] = [
  { edgeType: 'decided_by', klass: 'decided' },
  { edgeType: 'informs', klass: 'informs' },
  { edgeType: 'caused', klass: 'caused' },
  { edgeType: 'supersedes', klass: 'supersedes' },
] as const;

/** edgeType → the CSS-module edge class that colours it (default = neutral `informs` tint). */
export const EDGE_CLASS: Record<string, string> = {
  decided_by: 'decided',
  informs: 'informs',
  caused: 'caused',
  supersedes: 'supersedes',
} as const;

export function edgeClass(edgeType: string): string {
  return EDGE_CLASS[edgeType] ?? 'informs';
}

/** The Graph / Story view toggle values. */
export type TreeWalkerView = 'graph' | 'story';
