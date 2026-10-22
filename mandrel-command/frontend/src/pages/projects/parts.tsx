/**
 * Small shared Projects building blocks: the relative-time formatter and the id8 helper.
 * Pure + unit-friendly; no data access here (mirrors decisions/parts.tsx).
 */

/**
 * Compact "now / 38m / 2h / 3d" relative time.
 *
 * Re-exported, not reimplemented: this function was copy-pasted
 * VERBATIM into six pages/*\/parts.tsx files. The one implementation now lives in
 * utils/datetime.ts alongside the timezone-aware formatters; re-exporting keeps every
 * existing `from './parts'` import site working unchanged.
 */
export { formatRelative } from '../../utils/datetime';

/** The short 8-char id used everywhere ids are surfaced. */
export function id8(id: string | undefined | null): string {
  return id ? id.replace(/-/g, '').slice(0, 8) : '';
}
