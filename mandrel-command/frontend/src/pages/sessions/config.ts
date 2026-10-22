/**
 * Sessions configuration — the single, named home for every Sessions-screen
 * tunable (no magic numbers in the components; see configs-not-hardcoded). Adjust
 * the list cap, the live/dormant threshold, the timeline page size, or query
 * staleness here and every part follows.
 */
import type { BadgeVariant } from '../../components/ui';

export const SESSIONS_CONFIG = {
  /** Max rows pulled from `/api/sessions` (the backend caps at this too). */
  listLimit: 1000,
  /**
   * A live (not-ended) session whose last activity is newer than this is shown
   * "live"; older than this it is "dormant". Ended sessions are always "ended".
   */
  liveWithinMs: 1000 * 60 * 30,
  /** How many timeline events an expanded stream shows before "show earlier". */
  timelineInitialCount: 6,
  /** react-query staleTime for the Sessions reads. */
  staleTimeMs: 1000 * 60 * 2,
} as const;

/**
 * Token-driven palette the project dot cycles through (deterministic per project
 * id). CSS custom-property names only — resolved with `var(--x)` at the callsite,
 * so no hex ever lands in the component or stylesheet.
 */
export const PROJECT_DOT_PALETTE = [
  '--teal',
  '--blue',
  '--violet',
  '--green',
  '--amber',
  '--rose',
] as const;

/** Deterministic palette index for a project id (stable dot colour per project). */
export function projectDotVar(seed: string | undefined | null): string {
  if (!seed) return PROJECT_DOT_PALETTE[0];
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PROJECT_DOT_PALETTE[h % PROJECT_DOT_PALETTE.length];
}

/**
 * Actor display constants + helpers now live in ONE shared source
 * (`src/config/actor.ts`) so the neutral label and the anonymous→unattributed
 * normalization can't drift across screens. Re-exported here for back-compat with
 * existing `./config` importers.
 */
export {
  UNATTRIBUTED_ACTOR,
  ANONYMOUS_ACTOR,
  isAttributed,
  actorLabel,
  ACTOR_DOT_PALETTE,
  actorDotVar,
} from '../../config/actor';

/** A session's derived lifecycle status (drives the StatusPill tone + grouping). */
export type SessionStatus = 'live' | 'dormant' | 'ended';

/** The timeline event kinds we render (mock `.kind` chips) → Badge variant. */
export type TimelineKind =
  | 'handoff'
  | 'milestone'
  | 'completion'
  | 'decision'
  | 'task'
  | 'context'
  | 'commit';

/** kind → Badge tint, matching the locked mock's colour coding. */
export const KIND_TONE: Record<TimelineKind, BadgeVariant> = {
  handoff: 'teal',
  milestone: 'violet',
  completion: 'green',
  decision: 'blue',
  task: 'green',
  context: 'violet',
  commit: 'neutral',
} as const;

/**
 * Map a raw context_type onto a timeline kind. Context rows carry the real Mandrel
 * context type (milestone / completion / handoff / …); anything else is a generic
 * "context" event.
 */
export function contextKind(contextType: string | undefined): TimelineKind {
  switch (contextType) {
    case 'handoff':
      return 'handoff';
    case 'milestone':
      return 'milestone';
    case 'completion':
      return 'completion';
    case 'decision':
      return 'decision';
    default:
      return 'context';
  }
}

/**
 * Status-filter options for the toolbar (client-side filter over the list).
 *
 * These values must line up with `deriveStatus`'s three outcomes, because the page
 * groups on the derived status. Before `dormant` existed here, "Live" meant "not
 * ended" and so rendered the Live now AND Dormant groups together — honest, but it
 * could not express the one question the split was built to answer. Adding the third
 * option is what makes the filter and the grouping speak the same language.
 */
export const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live now' },
  { value: 'dormant', label: 'Dormant' },
  { value: 'ended', label: 'Ended' },
] as const;

export type StatusFilterValue = (typeof STATUS_FILTERS)[number]['value'];
