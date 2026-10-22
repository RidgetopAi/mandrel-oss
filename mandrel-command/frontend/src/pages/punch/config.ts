/**
 * Punch List configuration — the single, named home for every Punch-screen tunable
 * (configs-not-hardcoded). The stage columns in pipeline order, the blocked lane, the
 * proof-kind vocabulary, the phone/desktop breakpoint, and the client-side photo
 * downscale limits all live here so the parts stay declarative.
 *
 * The stage values are lane A's REAL enum:
 * `draft | ready | claimed | verifying | evidence | merged | deployed`.
 */
import type { BadgeVariant } from '../../components/ui';
import type { TaskStage, PunchProofKind, TaskStatus } from '../../types/task';

export const PUNCH_CONFIG = {
  /**
   * The desktop breakpoint: at/above this width every stage column renders side by side;
   * below it the board shows ONE column at a time behind a horizontal stage picker, and
   * the detail is a full page rather than a Drawer. 1024 is the brief's number.
   */
  desktopMinWidthPx: 1024,
  /**
   * The board's PER-COLUMN page size (an earlier task — PER-COLUMN PAGING, mirrors the
   * Tasks board's `TASKS_CONFIG.colCardCap`). Each stage column and the blocked lane
   * fetch their OWN rows server-side, so one column's volume can never starve another —
   * see the Tasks config for the full mechanism note. The header count is the column's
   * REAL total, never this page length; "Load more" grows the page by another
   * `colCardCap`, clamped server-side at `TASK_LIST_CONFIG.maxLimit`.
   */
  colCardCap: 60,
  /** react-query staleTime for the attachment reads. */
  attachmentsStaleTimeMs: 1000 * 60 * 2,
  /** How long the just-filed card stays highlighted on the board after a submit. */
  createdHighlightMs: 6000,
  /** Photos above this size are downscaled client-side before upload (phone photos are 3–8 MB). */
  downscaleAboveBytes: 5 * 1024 * 1024,
  /** Longest edge after a downscale. */
  downscaleMaxEdgePx: 1600,
  /** JPEG quality for the downscaled encode. */
  downscaleJpegQuality: 0.85,
  /** Notes textarea rows. */
  notesRows: 4,
  /** Touches / Dependencies textarea rows — short freeform lists, not prose. */
  listFieldRows: 3,
} as const;

/** The media query the board + detail switch layout on. Derived from the breakpoint. */
export const DESKTOP_MEDIA_QUERY = `(min-width: ${PUNCH_CONFIG.desktopMinWidthPx}px)`;

/**
 * The stage columns, in PIPELINE ORDER. `dotVar` is a CSS custom-property NAME resolved
 * with `var(--x)` at the callsite — no hex ever lands in a component (guarded by the
 * wiring test). The order is also what the detail's stage timeline walks.
 */
export const STAGE_COLUMNS: ReadonlyArray<{
  stage: TaskStage;
  label: string;
  dotVar: string;
}> = [
  { stage: 'draft', label: 'Draft', dotVar: '--tx-4' },
  { stage: 'ready', label: 'Ready', dotVar: '--blue' },
  { stage: 'claimed', label: 'Claimed', dotVar: '--teal' },
  { stage: 'verifying', label: 'Verifying', dotVar: '--amber' },
  { stage: 'evidence', label: 'Evidence', dotVar: '--violet' },
  { stage: 'merged', label: 'Merged', dotVar: '--green' },
  { stage: 'deployed', label: 'Deployed', dotVar: '--green' },
] as const;

/** The ordered stage values (single source: STAGE_COLUMNS). */
export const STAGES: ReadonlyArray<TaskStage> = STAGE_COLUMNS.map((c) => c.stage);

/**
 * The BLOCKED lane — NOT a stage. A task whose `status === 'blocked'` sits here whatever
 * its stage, shown distinctly. Its droppable id is this sentinel; dropping a card on it
 * writes `status:'blocked'`, and dragging out of it writes the target stage plus the
 * status that stage implies (see `stage.ts`).
 */
export const BLOCKED_LANE = 'blocked' as const;
export const BLOCKED_LANE_LABEL = 'Blocked';
export const BLOCKED_LANE_DOT_VAR = '--rose';

/** A board column id: a real stage, or the blocked lane. */
export type PunchColumnId = TaskStage | typeof BLOCKED_LANE;

/** Every droppable column, in render order: the seven stages then the blocked lane. */
export const PUNCH_COLUMNS: ReadonlyArray<{ id: PunchColumnId; label: string; dotVar: string }> = [
  ...STAGE_COLUMNS.map((c) => ({ id: c.stage, label: c.label, dotVar: c.dotVar })),
  { id: BLOCKED_LANE, label: BLOCKED_LANE_LABEL, dotVar: BLOCKED_LANE_DOT_VAR },
];

/** stage → human label (single source; card, picker, detail all read it). */
export const STAGE_LABEL: Record<TaskStage, string> = Object.fromEntries(
  STAGE_COLUMNS.map((c) => [c.stage, c.label]),
) as Record<TaskStage, string>;

/**
 * LEGACY BACKFILL MIRROR. A task the backend has not stamped (`stage == null`) is placed
 * by its status, exactly as lane A's backfill does, so the board is never empty against
 * an un-migrated backend. `blocked` rows land in the blocked lane by status regardless;
 * `cancelled` rows are not on the board at all (same as the Tasks board).
 */
export const LEGACY_STAGE_BY_STATUS: Record<TaskStatus, TaskStage | null> = {
  todo: 'ready',
  in_progress: 'claimed',
  completed: 'merged',
  blocked: 'ready',
  cancelled: null,
} as const;

/**
 * The status a stage IMPLIES — used only when a card leaves the blocked lane, where
 * `status` must change too or it would stay blocked. Mirrors LEGACY_STAGE_BY_STATUS.
 */
export const STATUS_FOR_STAGE: Record<TaskStage, TaskStatus> = {
  draft: 'todo',
  ready: 'todo',
  claimed: 'in_progress',
  verifying: 'in_progress',
  evidence: 'in_progress',
  merged: 'completed',
  deployed: 'completed',
} as const;

/** The proof-kind segmented control — Browser first because it is the default. */
export const PROOF_OPTIONS: ReadonlyArray<{ value: PunchProofKind; label: string }> = [
  { value: 'browser', label: 'Browser' },
  { value: 'test', label: 'Test' },
  { value: 'look', label: 'Look' },
] as const;

export const DEFAULT_PROOF_KIND: PunchProofKind = 'browser';

/** proofKind → Badge tint. */
export const PROOF_TINT: Record<PunchProofKind, BadgeVariant> = {
  browser: 'teal',
  test: 'violet',
  look: 'amber',
} as const;

export function proofTint(kind: PunchProofKind | undefined | null): BadgeVariant {
  if (!kind) return 'neutral';
  return PROOF_TINT[kind] ?? 'neutral';
}

/** The Kind segmented control → task `type`. Bug first: it is what a phone-filed punch usually is. */
export const KIND_OPTIONS: ReadonlyArray<{ value: 'bug' | 'feature'; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Change' },
] as const;

export const DEFAULT_PUNCH_KIND: 'bug' | 'feature' = 'bug';

/** The priority a phone-filed punch gets (CreateTaskRequest requires one). */
export const DEFAULT_PUNCH_PRIORITY = 'medium' as const;

/**
 * The punch fields the backend requires before `ready`, keyed by the name lane A
 * returns in `PUNCH_INCOMPLETE.missing`, with the label the form highlights. Single
 * source for the draft card's "missing:" line and the form's inline errors.
 */
export const PUNCH_REQUIRED_FIELDS: ReadonlyArray<{ key: 'doneWhen' | 'proofKind'; label: string }> = [
  { key: 'doneWhen', label: 'done-when' },
  { key: 'proofKind', label: 'proof' },
] as const;

/**
 * Secondary tags the picker stamps alongside a `reject:tag-excluded` verdict, naming
 * WHY the exclusion tag applies. Single source so `stage.ts` and any future reader
 * agree on the exact strings the picker publishes.
 */
export const PICKER_EXCLUSION_TAGS = {
  exhausted: 'picker:exhausted',
  riskGate: 'risk:gate',
} as const;

/**
 * Human wording for a card's `reject:*` verdict tag (published by the picker
 * — read verbatim off `task.tags`, never recomputed here). Draft's own
 * "missing: done-when, proof" line is generated by `missingLabels`, not this table;
 * `punch-incomplete` on a Ready/Claimed card reuses that same generator so the two
 * columns say the identical thing for the identical cause.
 */
export const PUNCH_REJECT_COPY = {
  /** `reject:tag-excluded` + `picker:exhausted` — the picker gave up after its retry budget. */
  exhausted: 'exhausted, 2 attempts failed',
  /** `reject:tag-excluded` + `risk:gate` — held for a human call, not a picker defect. */
  riskGate: 'waiting on the operator',
  /** `reject:tag-excluded` with neither known secondary tag — still excluded, cause unlabeled. */
  tagExcludedFallback: 'excluded',
  /** `reject:punch-incomplete` when, unexpectedly, nothing reads as missing. */
  punchIncompleteFallback: 'incomplete',
  /** `reject:not-ready` — claimed but its ready-gate contract isn't satisfied. */
  notReady: 'not a punch, no contract',
} as const;

/** The form's copy, in one place. */
export const PUNCH_COPY = {
  title: 'Punch List',
  tagline: 'See it, file it, watch it clear.',
  fileButton: '＋ Punch',
  goalLabel: 'Goal',
  goalPlaceholder: "What's wrong or what should change — one sentence",
  doneWhenLabel: 'Done when',
  doneWhenPlaceholder: "What you'd see when it's fixed",
  doneWhenAddLabel: '+ Add done-when',
  whereLabel: 'Where',
  proofLabel: 'Proof',
  photoLabel: 'Photo',
  photoHint: 'One is enough. Drop images here on desktop.',
  touchesLabel: 'Touches',
  touchesPlaceholder: 'repo-relative paths, one per line or comma-separated — optional',
  dependenciesLabel: 'Dependencies',
  dependenciesPlaceholder: 'task ids this depends on, one per line or comma-separated — optional',
  notesLabel: 'Notes',
  notesPlaceholder: 'Anything else — optional',
  kindLabel: 'Kind',
  submit: 'File punch',
  submitting: 'Filing…',
  filedTitle: 'Punch filed',
  filedDraft: 'Saved as a draft — fill in what is missing to make it ready.',
  noEvidence: 'no evidence yet',
  noBefore: 'no photo',
} as const;
