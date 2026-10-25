/**
 * Session-detail configuration — the single, named home for every tunable on the
 * session-scoped detail screen (house rule configs-not-hardcoded). Query staleness,
 * the live/dormant recency threshold, the tab set, and the per-tab list caps all live
 * here so the parts stay declarative.
 *
 * DATA MAP (the data-gap policy — show what's REAL, never fabricate). Every one of the five
 * tabs is wired to a REAL endpoint through the unified `api.sessions.*` client:
 *  - Contexts  → `api.sessions.get(id).contexts`   (GET /api/sessions/:id)
 *  - Tasks     → `api.sessions.get(id).tasks`       (GET /api/sessions/:id)
 *  - Decisions → `api.sessions.get(id).decisions`   (GET /api/sessions/:id)
 *  - Files     → `api.sessions.files(id)`           (GET /api/v2/sessions/:id/files)
 *  - Timeline  → contexts + decisions + tasks + linked_commits from the detail read,
 *                merged recent-first by `buildTimeline` (sessions/parts) — all REAL.
 * When a tab's array is empty we show an honest empty state (never a fabricated row).
 */
import type { BadgeVariant } from '../../components/ui';

export const SESSION_DETAIL_CONFIG = {
  /** react-query staleTime for the session detail read (contexts/tasks/decisions). */
  detailStaleMs: 1000 * 60 * 2,
  /** react-query staleTime for the files read (its own endpoint). */
  filesStaleMs: 1000 * 60 * 2,
  /**
   * A not-ended session whose last activity is newer than this reads "live"; older
   * reads "dormant". An ended session (ended_at set) is always "ended". Matches the
   * Sessions LIST threshold so the status pill agrees across both surfaces.
   */
  liveWithinMs: 1000 * 60 * 30,
  /** How many timeline events to show before the "show earlier" toggle. */
  timelineInitialCount: 12,
} as const;

/** The five tabs, in order. `key` selects the panel in SessionDetail.tsx. */
export type TabKey = 'contexts' | 'tasks' | 'decisions' | 'files' | 'timeline';

/** The task status → Badge tint (mirrors the Tasks screen colour coding). */
export const TASK_STATUS_TONE: Record<string, BadgeVariant> = {
  todo: 'neutral',
  in_progress: 'blue',
  completed: 'green',
  blocked: 'amber',
  cancelled: 'rose',
} as const;

/** The task type → Badge tint. */
export const TASK_TYPE_TONE: Record<string, BadgeVariant> = {
  feature: 'blue',
  bugfix: 'rose',
  refactor: 'amber',
  test: 'green',
  documentation: 'violet',
} as const;

/** The task priority → Badge tint. */
export const TASK_PRIORITY_TONE: Record<string, BadgeVariant> = {
  low: 'neutral',
  medium: 'blue',
  high: 'amber',
  urgent: 'rose',
} as const;

/** The file source → Badge tint. */
export const FILE_SOURCE_TONE: Record<string, BadgeVariant> = {
  tool: 'blue',
  git: 'green',
  manual: 'amber',
} as const;

/** A decision status → Badge tint (approved reads positive, else neutral/amber). */
export function decisionStatusTone(status: string | undefined): BadgeVariant {
  if (status === 'approved' || status === 'active') return 'green';
  if (status === 'superseded' || status === 'deprecated') return 'neutral';
  return 'amber';
}

/** A decision impact → Badge tint (high/critical read as alert). */
export function decisionImpactTone(impact: string | undefined): BadgeVariant {
  if (impact === 'high' || impact === 'critical') return 'rose';
  return 'blue';
}
