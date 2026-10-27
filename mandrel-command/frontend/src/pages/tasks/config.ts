/**
 * Tasks configuration — the single, named home for every Tasks-screen tunable (no magic
 * numbers/strings in the components; house rule configs-not-hardcoded). The board column
 * definitions, the status→tint / type→tint / priority→dot maps, the view options, and
 * the typed-edge label vocabulary all live here so the parts stay declarative.
 *
 * The status values are the REAL Postgres enum the backend stores
 * (`todo | in_progress | blocked | completed | cancelled`) — grounded against
 * backend/src/services/task.ts, NOT the stale generated `TaskEntity` (`pending`).
 */
import type { BadgeVariant } from '../../components/ui';
import type { TaskStatus } from '../../types/task';
import { TASKS_TITLE } from '../../config/fieldLimits';

export const TASKS_CONFIG = {
  /** Max rows pulled per list read (the board loads the project's tasks). Passed as the
   *  `limit` query param — the backend now HONOURS it (GET /api/tasks is paginated), so this
   *  is a real server-side bound, not a client hint. Set to 2000 (== backend
   *  `TASK_LIST_CONFIG.defaultLimit`, byte-identical) so a full realistic project loads —
   *  the old 500 dropped the tail of a 590-task project (e.g. the 3rd in_progress task) from
   *  the board. The authoritative counts come from `/api/tasks/stats` (a COUNT, uncapped), so
   *  the progress bar never undercounts even beyond 2000; per-column pagination is the real
   *  long-term answer, 2000 is a soft-launch ceiling. */
  listLimit: 2000,
  /**
   * The Board's PER-COLUMN page size (an earlier task — PER-COLUMN PAGING). Each column
   * fetches its OWN rows server-side (`useTaskColumnPage`, a `status`/`stage` filter +
   * this `limit`), so a column's volume can never spend another column's row budget —
   * the failure mode the shared `listLimit` cap had once a project passed it (the
   * terminal-order fix, an earlier change, sorts every completed-implying row after every open
   * one, so the shared cap starved EXCLUSIVELY the terminal columns: Done / Merged /
   * Deployed). The header count is the column's REAL total (`COUNT(*) OVER()`,
   * services/task.ts), never this page length; "Load more" grows the page by another
   * `colCardCap`, clamped server-side at `TASK_LIST_CONFIG.maxLimit`.
   */
  colCardCap: 60,
  /** react-query staleTime for the Tasks reads. */
  staleTimeMs: 1000 * 60 * 2,
  /**
   * Max characters of a task title rendered by `taskTitle()` — DERIVED from the column,
   * not chosen. Was a free `140`, the seventh hand-copied instance of that number in this
   * client (batch 6 / lane M-10).
   *
   * ── WHY THIS IS *NOT* THE CONTEXTS-RAIL CARD-GEOMETRY DERIVATION ──────────────────
   * The Contexts rail derives its budget from what its card can DRAW —
   * `ceil(((--rail-width - 2*--sp-3) / narrowestGlyph) * line-clamp)` — because that card
   * is a fixed-width, line-clamped box over an UNBOUNDED `contexts.content` TEXT column.
   * Copying that number here would have been wrong twice over. MEASURED on this tree:
   *   - `Tasks.module.css` contains ZERO `-webkit-line-clamp` declarations, and `.tcTitle`
   *     has no `overflow`/`text-overflow` either — the board card WRAPS, so there is no
   *     clamp to multiply by and nothing the card refuses to draw;
   *   - the board column is `.board { grid-template-columns: repeat(4, 1fr) }` — a
   *     fraction of the viewport, not `--rail-width`, so there is no fixed px width to
   *     divide by;
   *   - `taskTitle()` also feeds `.rowTitle` (list view) and `.buildingArrow` (OpsBar),
   *     which are single-line `text-overflow: ellipsis` — the BROWSER truncates those by
   *     pixel, so a character budget cannot be their limit either.
   * Three render sites, no clamp, no fixed width. The card-geometry question has no
   * answer here; asserted in `titlePreview.test.ts`.
   *
   * ── WHAT DOES GOVERN IT ───────────────────────────────────────────────────────────
   * The other job the slice has: bound the DOM payload. Unlike `contexts.content`, a task
   * title is `character varying(500)` — the DATA is already bounded, so the honest bound
   * is the column itself. At `TASKS_TITLE.max` the slice can never remove a character any
   * of the three sites could have shown, and it is still a hard ceiling. `varcharColumn()`
   * sets `max === length`, and that length is pinned to the live `information_schema` by
   * the existing backend/frontend fieldLimits guards — so there is no free number here.
   */
  titlePreviewChars: TASKS_TITLE.max,
} as const;

/**
 * ASSIGNEE COMBOBOX tunables (an earlier task — the free-text-with-suggestions
 * Assignee field in TaskDrawer). Named here rather than inlined in the component
 * (configs-not-hardcoded).
 */
export const ASSIGNEE_COMBOBOX_CONFIG = {
  /**
   * Max suggestions RENDERED after filtering (Reviewer carryover N3). `getActorOptions`
   * has no server-side LIMIT — an unscoped admin gets every distinct assignee on the box —
   * so the bound lives here, at the surface that renders them. Applied AFTER the
   * case-insensitive filter, so typing narrows toward what you want instead of the cap
   * hiding it. 20 comfortably covers the largest real project measured on prod
   * (~14 distinct values in `riverbend` on 2026-08-09) while keeping the popup scannable.
   */
  maxVisible: 20,
  /** react-query staleTime for the suggestion read — it changes slowly. */
  staleTimeMs: 1000 * 60 * 5,
  /** Placeholder for the Assignee field (the honest empty state is "nobody"). */
  placeholder: 'unassigned',
  /** Shown when the typed value matches no suggestion. NOT an error — free text is legal. */
  emptyLabel: 'No match — free text is fine',
} as const;

/**
 * Analytics-view tunables (the Board / List / **Analytics** third toggle — Phase 3
 * "Insight"). Every magic number the analytics parts need lives here (configs-not-
 * hardcoded): the aging thresholds, the aging-list DOM cap, and the chart heights.
 */
export const ANALYTICS_CONFIG = {
  /** Age (days) at/above which an open task's age badge burns "hot" (rose). */
  agingHotDays: 21,
  /** Age (days) at/above which it turns "warm" (amber); below is neutral. */
  agingWarmDays: 7,
  /** Max rows in the "Oldest open tasks" aging list (a DOM cap). */
  agingListCap: 8,
  /** Full-width throughput chart stage height (px). */
  throughputChartHeight: 200,
  /** Breakdown (status/priority/actor) chart stage height (px). */
  breakdownChartHeight: 168,
  /** Days per week — the divisor turning the per-day completion rate into a /wk KPI. */
  throughputPerWeekDays: 7,
} as const;

/**
 * The analytics range selector (mock's `.range` — 7d / 30d / 90d / All). `days: null`
 * = unbounded ("All"). The range scopes the TIME-BASED panels (throughput trend,
 * cycle time, completed-by-actor); the snapshot panels (open-by-status/priority,
 * aging) are point-in-time and read the current set regardless.
 */
export const RANGE_OPTIONS = [
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
  { value: '90d', label: '90d', days: 90 },
  { value: 'all', label: 'All', days: null },
] as const;

export type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];

/** Default analytics range (mock highlights 30d). */
export const DEFAULT_RANGE: RangeValue = '30d';

/**
 * A semantic colour TONE name → the chart-theme field that paints it, resolved at
 * render time (`analyticsParts.toneHex`). Tones (never hex here — guarded) keep the
 * status/priority/actor series token-sourced like every other chart.
 */
export type AnalyticsTone = 'teal' | 'ok' | 'warn' | 'crit' | 'blue' | 'violet' | 'muted';

/**
 * "Open tasks by status" stacked-bar series — the OPEN statuses only (Done dwarfs the
 * bar, so it lives in the key, not the stack), in the mock's order. `completed` is the
 * key's Done entry (rendered in the legend, not stacked).
 */
export const ANALYTICS_STATUS_SERIES: ReadonlyArray<{
  key: TaskStatus;
  label: string;
  tone: AnalyticsTone;
  /** In the stacked bar? Done is key-only. */
  stacked: boolean;
}> = [
  { key: 'todo', label: 'Todo', tone: 'muted', stacked: true },
  { key: 'in_progress', label: 'In progress', tone: 'teal', stacked: true },
  { key: 'blocked', label: 'Blocked', tone: 'crit', stacked: true },
  { key: 'completed', label: 'Done', tone: 'ok', stacked: false },
] as const;

/** "Open by priority" horizontal bars — fixed categorical order + tone (mock's palette). */
export const ANALYTICS_PRIORITY_SERIES: ReadonlyArray<{
  key: string;
  label: string;
  tone: AnalyticsTone;
}> = [
  { key: 'urgent', label: 'Urgent', tone: 'crit' },
  { key: 'high', label: 'High', tone: 'warn' },
  { key: 'medium', label: 'Medium', tone: 'blue' },
  { key: 'low', label: 'Low', tone: 'muted' },
] as const;

/** The statuses considered "open" (excluded from Done; the aging + open counts). */
export const OPEN_STATUSES: ReadonlyArray<TaskStatus> = ['todo', 'in_progress', 'blocked'];

/**
 * The four board columns (the mock's To do / In progress / Blocked / Done), each keyed
 * to a real task status. `cancelled` tasks are intentionally not a column (they drop out
 * of the board, matching the mock); the progress bar still counts them in the total.
 * `dotVar` / `segVar` are CSS custom-property NAMES resolved with `var(--x)` at the
 * callsite — no hex ever lands in a component (guarded by the wiring test).
 */
export const STATUS_COLUMNS: ReadonlyArray<{
  status: TaskStatus;
  label: string;
  dotVar: string;
}> = [
  { status: 'todo', label: 'To do', dotVar: '--tx-4' },
  { status: 'in_progress', label: 'In progress', dotVar: '--teal' },
  { status: 'blocked', label: 'Blocked', dotVar: '--rose' },
  { status: 'completed', label: 'Done', dotVar: '--green' },
] as const;

/** The segmented progress bar order + colour var per status (mock's segbar legend). */
export const PROGRESS_SEGMENTS: ReadonlyArray<{
  status: TaskStatus;
  label: string;
  colorVar: string;
}> = [
  { status: 'completed', label: 'Done', colorVar: '--green' },
  { status: 'in_progress', label: 'In progress', colorVar: '--teal' },
  { status: 'blocked', label: 'Blocked', colorVar: '--rose' },
  { status: 'todo', label: 'To do', colorVar: '--tx-4' },
] as const;

/** status → Badge tint for the status pill on the thread detail. */
export const STATUS_TONE: Record<string, BadgeVariant> = {
  todo: 'neutral',
  in_progress: 'teal',
  blocked: 'rose',
  completed: 'green',
  cancelled: 'neutral',
} as const;

/** status → human label (single source; the pill + the detail read it). */
export const STATUS_LABEL: Record<string, string> = {
  todo: 'to do',
  in_progress: 'in progress',
  blocked: 'blocked',
  completed: 'done',
  cancelled: 'cancelled',
} as const;

export function statusTone(status: string | undefined | null): BadgeVariant {
  if (!status) return 'neutral';
  return STATUS_TONE[status] ?? 'neutral';
}

/**
 * The statuses selectable in the THREAD-DETAIL status control — the board columns' statuses
 * PLUS `cancelled`. `cancelled` is intentionally NOT a board column (a cancelled task drops
 * off the board), but the detail Select must be able to render a `cancelled` task's label
 * and move a task to/from `cancelled`. Single source (built from STATUS_COLUMNS + the real
 * `cancelled` enum) so the control never drifts from the backend's status set.
 */
export const DETAIL_STATUS_OPTIONS: ReadonlyArray<{ value: TaskStatus; label: string }> = [
  ...STATUS_COLUMNS.map((c) => ({ value: c.status, label: STATUS_LABEL[c.status] ?? c.status })),
  { value: 'cancelled', label: STATUS_LABEL.cancelled ?? 'cancelled' },
];

/**
 * The task PRIORITY enum — the SINGLE runtime source for the priority Select in the task
 * CRUD drawer. Kept byte-identical to `CreateTaskRequest.priority`
 * (`'low' | 'medium' | 'high' | 'urgent'`) and the backend zod `TaskPrioritySchema`; a
 * generated TS union can't be iterated at runtime, so this const IS the config home for it
 * (configs-not-hardcoded — the drawer never inlines its own list). Guarded by the drawer test.
 */
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** priority → {value,label} options for the drawer Select (full word, not the card short-form). */
export const PRIORITY_OPTIONS: ReadonlyArray<{ value: TaskPriority; label: string }> =
  TASK_PRIORITIES.map((p) => ({ value: p, label: p }));

/** The default priority for a NEW task (CreateTaskRequest requires priority; medium is the sane default). */
export const DEFAULT_TASK_PRIORITY: TaskPriority = 'medium';

/**
 * The task TYPE enum — the SINGLE runtime source for the type Select in the drawer. Kept
 * byte-identical to `CreateTaskRequest.type` and the backend zod `TaskTypeSchema`
 * (`general | feature | bug | refactor | test | docs | devops`). Same rationale as
 * TASK_PRIORITIES: config home for an enum a generated type can't enumerate at runtime.
 */
export const TASK_TYPES = ['general', 'feature', 'bug', 'refactor', 'test', 'docs', 'devops'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** type → {value,label} options for the drawer Select. */
export const TYPE_OPTIONS: ReadonlyArray<{ value: TaskType; label: string }> = TASK_TYPES.map(
  (t) => ({ value: t, label: t }),
);

/** The default type for a NEW task (matches the backend `TaskTypeSchema` default). */
export const DEFAULT_TASK_TYPE: TaskType = 'general';

/**
 * task `type` → Badge tint (the mock's type badge). Keys are the real Mandrel task
 * types (`general | feature | bug | refactor | test | docs | devops`). Anything unmapped
 * falls back to `neutral`.
 */
export const TYPE_TINT: Record<string, BadgeVariant> = {
  feature: 'teal',
  bug: 'rose',
  refactor: 'blue',
  docs: 'violet',
  test: 'amber',
  devops: 'blue',
  general: 'neutral',
} as const;

export function typeTint(type: string | undefined | null): BadgeVariant {
  if (!type) return 'neutral';
  return TYPE_TINT[type] ?? 'neutral';
}

/**
 * priority → the CSS custom-property that paints its dot. CSS var NAMES only, resolved
 * with `var(--x)` at the callsite (no hex in a component). Mirrors the mock: high/urgent
 * = rose, medium = amber, low = muted.
 */
export const PRIORITY_DOT_VAR: Record<string, string> = {
  urgent: '--rose',
  high: '--rose',
  medium: '--amber',
  low: '--tx-4',
} as const;

export function priorityDotVar(priority: string | undefined | null): string {
  if (!priority) return '--tx-4';
  return PRIORITY_DOT_VAR[priority] ?? '--tx-4';
}

/** Short priority label used on the card ("med" etc. matching the mock). */
export const PRIORITY_LABEL: Record<string, string> = {
  urgent: 'urgent',
  high: 'high',
  medium: 'med',
  low: 'low',
} as const;

export function priorityLabel(priority: string | undefined | null): string {
  if (!priority) return '—';
  return PRIORITY_LABEL[priority] ?? priority;
}

/** The Board / List / Analytics view toggle (the mock's vtoggle). */
export const VIEW_OPTIONS = [
  { value: 'board', label: 'Board' },
  { value: 'list', label: 'List' },
  { value: 'analytics', label: 'Analytics' },
] as const;

export type ViewValue = (typeof VIEW_OPTIONS)[number]['value'];

/**
 * LIST-VIEW STATUS FILTER — the segmented chip control that scopes the List view to one
 * status. `all` shows everything (the current behaviour); each other option
 * maps 1:1 to a real task status. Ordered All · To do · In progress · Blocked · Done ·
 * Cancelled. Labels are DERIVED from the single-source `STATUS_LABEL` (title-cased) so they
 * can't drift from the pill/detail labels — `completed → Done`, `cancelled → Cancelled`.
 * `value: 'all'` is the no-filter sentinel; every other `value` is a real `TaskStatus`.
 * The chips' COUNTS come from the uncapped `/api/tasks/stats` (`by_status`), never the
 * capped list, and never hardcoded — resolved at render time in `StatusFilter`.
 */
export type ListStatusFilterValue = 'all' | TaskStatus | typeof ARCHIVED_FILTER_VALUE;

/**
 * The ARCHIVED view sentinel. NOT a status — `archived_at` is an
 * orthogonal soft-delete marker, so a task is archived AND still `todo`/`cancelled`/
 * whatever it was. It rides the same chip control because it answers the same user
 * question ("show me this slice"), but it maps to the list's `archived` scope rather
 * than to a `status=` filter. Named here so no component ever inlines the string.
 */
export const ARCHIVED_FILTER_VALUE = 'archived' as const;

/** Title-case a single-source status label ("to do" → "To do", "done" → "Done"). */
function titleCaseLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The ordered statuses the filter exposes (real enum order: open → done → cancelled). */
const LIST_FILTER_STATUSES: ReadonlyArray<TaskStatus> = [
  'todo',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
];

export const LIST_STATUS_FILTERS: ReadonlyArray<{
  value: ListStatusFilterValue;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  ...LIST_FILTER_STATUSES.map((status) => ({
    value: status,
    label: titleCaseLabel(STATUS_LABEL[status] ?? status),
  })),
  // LAST, and after a deliberate gap in meaning: this chip crosses from "which status"
  // to "deleted or not". Its count comes from `stats.archived`, not `by_status`.
  { value: ARCHIVED_FILTER_VALUE, label: 'Archived' },
];

/**
 * kind → the CSS custom-property that paints its typed-edge target dot (mirrors the
 * Contexts KIND_DOT_VAR — a decision is blue, a context violet, a task green, and a
 * context_type colours by its own hue). CSS var NAMES only.
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

export function kindDotVar(kind: string | undefined | null): string {
  if (!kind) return '--tx-3';
  return KIND_DOT_VAR[kind] ?? '--tx-3';
}

/**
 * TYPED-EDGE LABEL VOCABULARY — how each edge type reads in each direction (the mock's
 * "decided by →" / "produced →" / "informs →" rows). Mirrors the Contexts EDGE_LABELS
 * (single edge-type domain, mcp-server/src/config/edgeTypes.ts): `outgoing` reads the
 * edge forward (this task → target), `incoming` reads its reverse. `edgeLabel` falls
 * back to a humanized slug if an unknown edge ever appears.
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
