/**
 * Contexts configuration — the single, named home for every Contexts-screen tunable
 * (no magic numbers/strings in the components; house rule configs-not-hardcoded). The
 * list window, query staleness, the kind→tone map, the sort options, and the typed-
 * edge label vocabulary all live here so the parts stay declarative.
 *
 * NOTE: the rail/reader GEOMETRY is deliberately NOT here — those widths are shared with
 * the Decisions screen, so they live in the design-token layer (styles/tokens.ts:
 * --rail-width / --reader-width). A per-page copy is what drifted.
 */
import type { BadgeVariant } from '../../components/ui';
import { dark as TOKENS } from '../../styles/tokens';

/** A token's px value, e.g. 'rail-width' -> 320. Throws rather than returning NaN (C1). */
function tokenPx(name: string): number {
  const raw = TOKENS[name];
  const v = raw === undefined ? NaN : parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(
      `Design token '${name}' is missing or not a px length (got ${String(raw)}). The ` +
        'contexts title preview budget is derived from it; refusing to fall back to a ' +
        'number nobody chose.'
    );
  }
  return v;
}

/**
 * THE GEOMETRY THE TITLE PREVIEW IS DERIVED FROM — the CARD, not the record.
 *
 * `titlePreviewChars` below is NOT a headline budget and is deliberately not pinned to
 * mcp-server's RECORD_HEADLINE_CONFIG (which answers "how much of a record fits in one
 * line of consumed TEXT"). This slice answers a different question: how much of a record
 * can a `--rail-width`-wide, two-line, line-clamped card ever DRAW. It has exactly two
 * jobs — never cut a character the card could have rendered, and bound the DOM payload,
 * since `contexts.content`'s first line can run to millions of characters. Both are
 * properties of the card. Asserted in `titlePreview.test.ts`.
 */
export const TITLE_PREVIEW_GEOMETRY = {
  /** `--rail-width`: the record-list rail track width. Imported, never restated. */
  railWidthPx: tokenPx('rail-width'),
  /** `--sp-3`: `.item`'s padding, applied on BOTH sides (charged twice below). */
  itemPaddingPx: tokenPx('sp-3'),
  /**
   * `.itemTitle`'s `-webkit-line-clamp`. CSS is not importable, so this is the one value
   * here that is a copy — and `titlePreview.test.ts` reads the stylesheet off disk and
   * compares it, which is the only thing keeping the two honest.
   */
  lineClamp: 2,
  /**
   * The narrowest glyph advance at `--fs-body` (0.95rem ≈ 15.2px) in a UI sans: '.', 'i',
   * 'l' run about a quarter em. Used to compute the WIDEST character count the card could
   * possibly draw, so an all-narrow-glyph title is still not clipped early. It is an
   * estimate, and it is allowed to be: it only widens an upper bound on a payload clip, so
   * an error costs a few characters of DOM, never a character the user could have seen.
   */
  narrowestGlyphPx: 4,
} as const;

/**
 * The most characters `.itemTitle` could render before the clamp cuts it: the full
 * two-line run of the narrowest glyph the card can draw. The slice must be at least this.
 */
export const maxRenderableTitleChars = Math.ceil(
  ((TITLE_PREVIEW_GEOMETRY.railWidthPx - 2 * TITLE_PREVIEW_GEOMETRY.itemPaddingPx) /
    TITLE_PREVIEW_GEOMETRY.narrowestGlyphPx) *
    TITLE_PREVIEW_GEOMETRY.lineClamp,
);

export const CONTEXTS_CONFIG = {
  /**
   * Max rows pulled per list read (browse + semantic-search top-N) — the window the
   * scrollable rail shows. The rail scrolls this window rather than paging, matching the
   * Decisions ledger (DECISIONS_CONFIG.listLimit — kept in step with it); the grid's pager was
   * retired with the grid.
   */
  listLimit: 100,
  /** react-query staleTime for the Contexts reads. */
  staleTimeMs: 1000 * 60 * 2,
  /**
   * Max characters of a context's first line shown as its list title. DERIVED from the
   * card geometry above — see TITLE_PREVIEW_GEOMETRY for why this is not the
   * record-headline budget. Was a free 140, which is BELOW what the card can draw.
   */
  titlePreviewChars: maxRenderableTitleChars,
  /**
   * Bulk tag: the server's per-context tag cap. The bulk endpoint REPLACES the tag list
   * (ContextBulkUpdate.updates.tags — "Replacement tag list (max 10 tags)"), so "add tags"
   * is computed client-side as existing ∪ new per row, and a row whose union would exceed
   * this is refused before any request is sent rather than truncated silently.
   */
  maxTagsPerContext: 10,
} as const;

/**
 * The client-side Export/Share formats offered on a context (ported from the old UI's
 * share dropdown). All are generated in-browser from the already-loaded record — no
 * endpoint call. `download` formats save a file; `copy` writes to the clipboard.
 */
export const SHARE_FORMATS = [
  { value: 'markdown', label: 'Markdown (.md)', mode: 'download' },
  { value: 'text', label: 'Copy as text', mode: 'copy' },
  { value: 'json', label: 'JSON (.json)', mode: 'download' },
] as const;

export type ShareFormat = (typeof SHARE_FORMATS)[number]['value'];

/**
 * The bulk-export formats offered on a SELECTION of contexts. Also built
 * in-browser from the already-loaded rows: the backend `GET /contexts/export` selects by
 * search filter, not by id, so it cannot export "these N rows" — see share.ts
 * `exportContexts`. Both formats download a single file.
 */
export const BULK_EXPORT_FORMATS = [
  { value: 'json', label: 'Export JSON' },
  { value: 'markdown', label: 'Export Markdown' },
] as const;

export type BulkExportFormat = (typeof BULK_EXPORT_FORMATS)[number]['value'];

/**
 * The context "kind" chips the reader/list colour-code, mapped to a Badge tint. Keys are
 * the real Mandrel context_type values (plus 'decision'/'task' for typed-edge targets).
 * Anything unmapped falls back to `neutral` via `kindTone`.
 */
export const KIND_TONE: Record<string, BadgeVariant> = {
  handoff: 'teal',
  milestone: 'violet',
  completion: 'green',
  decision: 'blue',
  planning: 'amber',
  reflections: 'amber',
  discussion: 'neutral',
  code: 'neutral',
  lessons: 'neutral',
  note: 'neutral',
  error: 'rose',
  task: 'green',
} as const;

/** kind → Badge tint, defaulting to neutral for an unknown/blank kind. */
export function kindTone(kind: string | undefined | null): BadgeVariant {
  if (!kind) return 'neutral';
  return KIND_TONE[kind] ?? 'neutral';
}

/**
 * kind → the CSS custom-property that paints its dot (the typed-edge target dot + the
 * facet dot). CSS var NAMES only, resolved with `var(--x)` at the callsite — no hex ever
 * lands in a component (guarded by the wiring test). Mirrors KIND_TONE's hues.
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
  task: '--green',
} as const;

/** kind → dot CSS var, defaulting to a muted text token for an unknown kind. */
export function kindDotVar(kind: string | undefined | null): string {
  if (!kind) return '--tx-3';
  return KIND_DOT_VAR[kind] ?? '--tx-3';
}

/**
 * The type facets shown in the filter bar (the mock's chips). Each filters the list by
 * `type`. Counts are wired from `api.contexts.stats()` (by_type) — never fabricated.
 */
export const TYPE_FACETS = [
  { value: 'handoff', label: 'handoff' },
  { value: 'decision', label: 'decision' },
  { value: 'milestone', label: 'milestone' },
  { value: 'completion', label: 'completion' },
  { value: 'planning', label: 'planning' },
  { value: 'note', label: 'note' },
] as const;

/** The list sort options (the mock's "Newest" control). Maps to the search params. */
export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest', sort_by: 'created_at', sort_order: 'desc' },
  { value: 'oldest', label: 'Oldest', sort_by: 'created_at', sort_order: 'asc' },
  { value: 'relevance', label: 'Relevance', sort_by: 'relevance', sort_order: 'desc' },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]['value'];

/**
 * TYPED-EDGE LABEL VOCABULARY — how each edge type reads in each direction (the mock's
 * "decided by →" / "informs →" / "supersedes →" rows). Derived from the edge-type domain
 * (mcp-server/src/config/edgeTypes.ts): `outgoing` reads the edge forward (this record →
 * target), `incoming` reads its reverse (target → this record). Covers the full v1 domain
 * so a new edge type never renders as a raw slug; `edgeLabel` falls back to a humanized
 * slug if an unknown edge ever appears.
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
