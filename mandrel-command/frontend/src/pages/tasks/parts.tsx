/**
 * Small shared Tasks building blocks: the relative-time formatter, the id8 helper, and
 * a stable actor→dot-colour hash. Pure + unit-friendly; no data access here.
 */
import { TASKS_CONFIG } from './config';

/**
 * Compact "now / 38m / 2h / 3d" relative time.
 *
 * Re-exported, not reimplemented: this function was copy-pasted
 * VERBATIM into six pages/*\/parts.tsx files. The one implementation now lives in
 * utils/datetime.ts alongside the timezone-aware formatters; re-exporting keeps every
 * existing `from './parts'` import site working unchanged.
 */
export { formatRelative } from '../../utils/datetime';

/** A task's display title, trimmed to the config preview length. */
export function taskTitle(title: string | undefined | null): string {
  if (!title) return '(untitled task)';
  return title.slice(0, TASKS_CONFIG.titlePreviewChars);
}

/** The short 8-char id used everywhere ids are surfaced. */
export function id8(id: string | undefined | null): string {
  return id ? id.replace(/-/g, '').slice(0, 8) : '';
}

/**
 * A stable dot colour for an actor chip — deterministic hash of the actor name into the
 * palette token set. This is only a visual affordance (never identity/authz), so a
 * hash-to-token is honest: same actor → same colour, no fabricated attribution.
 */
const ACTOR_DOT_VARS = ['--teal', '--violet', '--blue', '--green', '--amber'] as const;

export function actorDotVar(actor: string | undefined | null): string {
  if (!actor) return '--tx-4';
  let h = 0;
  for (let i = 0; i < actor.length; i += 1) {
    h = (h * 31 + actor.charCodeAt(i)) >>> 0;
  }
  return ACTOR_DOT_VARS[h % ACTOR_DOT_VARS.length];
}
