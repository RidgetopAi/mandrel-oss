/**
 * TreeWalker configuration — the single named home for every TreeWalker tunable (house rule
 * configs-not-hardcoded). Holds the NEW trust vocabulary (proven / soaking / unproven /
 * stale),
 * the view registry + story-role vocabulary, and the backend-readiness flag that gates the live data path.
 *
 * The typed-EDGE vocabulary (decided_by / informs / caused / supersedes labels + endpoint
 * dots) is REUSED from the shared `config/graphEdges` module — NOT re-copied here
 * (one home for the edge vocab). Only the trust vocab is new, and it lives here.
 */
import type { TrustLevel } from '../../api/domains/treewalker';

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

/** Copy for the one compact header row (title, branch selector, trunk / trust controls). */
export const HEADER_CONFIG = {
  selectLabel: 'Branch',
  /** Shown as the selected option when the walked anchor is not one of the listed branches. */
  currentOption: 'Current thread',
  loadingOption: 'Loading branches…',
  noBranchesOption: 'No branches yet',
  /** `{shown}` and `{total}` are filled from the served page. */
  cappedNote: '{shown} of {total} branches',
  jumpLabel: 'Jump to trunk',
  trustedLabel: 'Only trusted',
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
 * VIEW REGISTRY — the tab bar renders exactly the views registered here, in this order, and
 * nothing else (a view that is not registered has no tab and no route). `storyView` is the
 * first entry; Why (punch D) adds the second; the Timeline / Map punches each add one.
 * `defaultViewId` is what a URL with no (or an unknown) `view` param opens on.
 */
export const VIEW_REGISTRY = [
  { id: 'story', label: 'Story' },
  { id: 'why', label: 'Why' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'map', label: 'Map' },
] as const;
export type TreeWalkerViewId = (typeof VIEW_REGISTRY)[number]['id'];
export const DEFAULT_VIEW_ID: TreeWalkerViewId = 'story';
/** URL query keys carrying the page state, so a view + branch is linkable. */
export const URL_PARAMS = { view: 'view', anchor: 'anchor', record: 'record', beat: 'beat' } as const;

/** The view ids a record id / branch id navigates to (see WhyView + StoryView links). */
export const WHY_VIEW_ID: TreeWalkerViewId = 'why';
export const STORY_VIEW_ID: TreeWalkerViewId = 'story';

export function resolveViewId(raw: string | null | undefined): TreeWalkerViewId {
  return VIEW_REGISTRY.find((v) => v.id === raw)?.id ?? DEFAULT_VIEW_ID;
}

/** A role's marker shape on the story rail — roles differ by SHAPE, not hue alone. */
export type MarkerShape = 'square' | 'circle' | 'dot' | 'ring' | 'diamond';
export type StoryRoleKey = 'decision' | 'task' | 'outcome' | 'problem' | 'review' | 'plan' | 'work';

/** Every story role: label, colour TOKEN (a CSS custom-property name) and marker shape. Fixed order = the Key's order. */
export const STORY_ROLES: Record<StoryRoleKey, { label: string; colorVar: string; marker: MarkerShape }> = {
  decision: { label: 'Decision', colorVar: '--blue', marker: 'square' },
  outcome: { label: 'Outcome', colorVar: '--green', marker: 'diamond' },
  problem: { label: 'Problem', colorVar: '--rose', marker: 'ring' },
  task: { label: 'Task', colorVar: '--teal', marker: 'circle' },
  plan: { label: 'Plan', colorVar: '--amber', marker: 'ring' },
  review: { label: 'Review', colorVar: '--violet', marker: 'dot' },
  work: { label: 'Work', colorVar: '--tx-3', marker: 'dot' },
};
export const STORY_ROLE_ORDER = Object.keys(STORY_ROLES) as StoryRoleKey[];

/** context_type → role for context nodes; every other context_type (and handoffs) is `defaultContextRole`. */
export const CONTEXT_TYPE_ROLE: Record<string, StoryRoleKey> = {
  milestone: 'outcome',
  error: 'problem',
  reflections: 'review',
  planning: 'plan',
};

export const STORY_CONFIG = {
  /** Consecutive same-role beats in one chapter at/above this count collapse into one group. */
  collapseThreshold: 3,
  defaultContextRole: 'work' as StoryRoleKey,
  /** Edge type that makes a task a spawned-task chip under a decision (task --decided_by--> decision). */
  spawnEdgeType: 'decided_by',
  /** Task statuses that count as still open. */
  openTaskStatuses: ['todo', 'in_progress'] as readonly string[],
  /** Task statuses → the chip state it renders as. Anything else renders as `open`. */
  chipStatus: { done: 'done', completed: 'done', cancelled: 'cancelled' } as Record<string, 'done' | 'cancelled'>,
  /** Roles whose beats render as a bordered card. */
  cardRoles: ['decision', 'outcome'] as readonly StoryRoleKey[],
  /** A chapter's title comes from its first beat having one of these roles, in priority order. */
  chapterTitleRoles: ['outcome', 'decision', 'problem'] as readonly StoryRoleKey[],
  locale: 'en-US',
  dateFormat: { month: 'short', day: 'numeric' } as Intl.DateTimeFormatOptions,
  timeFormat: { hour: '2-digit', minute: '2-digit', hour12: false } as Intl.DateTimeFormatOptions,
} as const;

/** The Why view's copy + shape tunables (labels are the mockup's "D · Why" artboard). */
export const WHY_CONFIG = {
  columns: { because: 'Because of', series: 'Same series' },
  spawnedNote: 'one hop further',
  branchLabel: 'part of branch',
  beforeHeading: 'Just before, on this branch',
  beforeNote: 'Ordered by time, not by an edge.',
  seriesNote: 'Series links are suggested, never causal.',
  emptyCauses: 'No declared cause recorded.',
  emptySeries: 'Not part of a suggested series.',
  emptyBefore: 'Nothing earlier on a branch.',
  noRecord: 'Pick a record in Story — click its id — to see why it exists.',
  /** Kind → label for the record kind marker. */
  kindLabels: { decision: 'Decision', task: 'Task', context: 'Context', handoff: 'Handoff' } as Record<string, string>,
  locale: 'en-US',
  dateFormat: { month: 'short', day: 'numeric', year: 'numeric' } as Intl.DateTimeFormatOptions,
  timeFormat: { hour: '2-digit', minute: '2-digit', hour12: false } as Intl.DateTimeFormatOptions,
} as const;

/** The Timeline view's layout + copy tunables (the mockup's "B · Timeline" artboard). Pixel values feed the pure `timeline.ts`. */
export const TIMELINE_CONFIG = {
  /** A gap between consecutive records longer than this many hours is folded. */
  foldGapHours: 12,
  /** The fixed width a folded gap is drawn at. Must exceed twice `bandPadPx`. */
  foldedGapPx: 72,
  /** Floor for horizontal pixels per real hour. The plot picks the scale that fills the box, never below this; only the floor can make it scroll. */
  minPxPerHour: 12,
  /** Space before the first and after the last record. */
  edgePadPx: 24,
  /** How far a phase band reaches past its first / last record. */
  bandPadPx: 14,
  /** Estimated glyph width of a phase-band label, for the fit test and row packing. Errs wide. */
  bandLabelCharPx: 6.8,
  /** Clear space between a marker's centre and the start of its text label, for the right-edge flip test. */
  markerGapPx: 14,
  /** Horizontal padding inside a band label box (both sides together). */
  bandLabelPadPx: 16,
  /** Clear space kept between two labels sharing a row. */
  bandLabelGapPx: 8,
  /** Height of one band-label row; a label that does not fit its band moves up a row. */
  bandLabelRowPx: 22,
  /** A Decision / Outcome label wraps to at most this many lines, and only then ends in an ellipsis. */
  markerLabelMaxLines: 2,
  /** A label is not drawn when the room beside its marker holds fewer characters than this. */
  markerLabelMinChars: 4,
  /** Half the drawn width of a marker: a label never reaches nearer than this to another marker's centre. */
  markerHalfPx: 7,
  /** Clear space kept between a marker label and the neighbouring marker, label or plot edge. */
  markerLabelGapPx: 8,
  /** Phrase put before the decision title in a spawned task's name and hover title. */
  decidedByText: 'decided by',
  /** The Timeline key's explanation of each task status marker. */
  statusKey: [
    { state: 'done', label: 'done' },
    { state: 'open', label: 'open (todo / in progress)' },
    { state: 'cancelled', label: 'cancelled' },
  ] as const,
  /** Heading of the Timeline key. */
  keyHeading: 'Task status',
  /** Roles whose markers carry a text label. */
  labelledRoles: ['decision', 'outcome'] as readonly StoryRoleKey[],
  /** Height of one lane. */
  laneHeightPx: 44,
  /** Height of the day-tick strip below the lanes. */
  tickStripPx: 24,
  /** Width of the lane-label column. */
  laneLabelPx: 84,
  /** The plot's minimum width, so a short branch still fills its box. */
  minPlotPx: 320,
  locale: 'en-US',
  dayTickFormat: { month: 'short', day: 'numeric' } as Intl.DateTimeFormatOptions,
  whenFormat: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false } as Intl.DateTimeFormatOptions,
  emptyText: 'No records on this thread yet.',
  unavailableText: 'The thread read is not available yet.',
  loadingText: 'Loading the timeline…',
} as const;

/** The Map view's layout + copy tunables (the mockup's "C · Map" artboard). Pixel values feed the pure `map.ts`. */
export const MAP_CONFIG = {
  /** Horizontal pixels per day of the window on the linear scale. */
  pxPerDay: 24,
  /** The plot's minimum width, so a short window still fills its box. */
  minPlotPx: 360,
  /** Space left of the window start / right of the window end (labels never cross the right one). */
  padLeftPx: 24,
  padRightPx: 24,
  /** Space above the topmost / below the bottommost branch row. */
  padTopPx: 20,
  padBottomPx: 40,
  /** Vertical distance between branch rows on one side of the trunk, and from the trunk to the first row. */
  rowHeightPx: 46,
  /** Height reserved for the trunk band (the line, its ticks and its caption). */
  trunkBandPx: 56,
  /** A branch line is at least this long, so a single-day branch is still visible. */
  minSpanPx: 10,
  /** Clear space kept between two branches packed on one row. */
  rowGapPx: 16,
  /** Estimated glyph width of a branch label, for placement and row packing. */
  labelCharPx: 6.6,
  /** A branch name is cut to this many characters in its label. */
  nameMaxChars: 28,
  /** Distance of a label's baseline above its line. */
  labelRaisePx: 8,
  /** A tick is drawn every this many days from the window start. */
  tickEveryDays: 7,
  /** Colour TOKENS (CSS custom-property names) cycled over the branches, in order. */
  branchPalette: ['--blue', '--teal', '--amber', '--violet', '--green', '--rose'] as readonly string[],
  youAreHereLabel: 'you are here',
  locale: 'en-US',
  tickFormat: { month: 'short', day: 'numeric' } as Intl.DateTimeFormatOptions,
  emptyText: 'No branches were active in this window.',
  unavailableText: 'The branch map is not available yet.',
  loadingText: 'Loading the map…',
  /** Copy of the unbranched strip; `{pct}` and `{days}` are filled from the served share. */
  unbranchedText: 'Not on any branch: {pct}% of records in the last {days} days',
  unbranchedNoneText: 'No records in the last {days} days.',
} as const;
