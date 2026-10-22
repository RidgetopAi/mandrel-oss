/**
 * Small shared Contexts building blocks: the relative-time + first-line-title
 * formatters and the id8 helper. Pure + unit-friendly; no data access here.
 */
import { CONTEXTS_CONFIG } from './config';

/**
 * Compact "now / 38m / 2h / 3d" relative time.
 *
 * Re-exported, not reimplemented: this function was copy-pasted
 * VERBATIM into six pages/*\/parts.tsx files. The one implementation now lives in
 * utils/datetime.ts alongside the timezone-aware formatters; re-exporting keeps every
 * existing `from './parts'` import site working unchanged.
 */
export { formatRelative } from '../../utils/datetime';

/**
 * A context's display title = its first non-empty content line, trimmed to the config
 * preview length. Markdown heading/list markers are stripped so a `#`/`-` lead doesn't
 * bleed into the title. Empty content → a neutral placeholder.
 */
export function contextTitle(content: string | undefined | null): string {
  const line = (content ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!line) return '(untitled context)';
  const cleaned = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '');
  return cleaned.slice(0, CONTEXTS_CONFIG.titlePreviewChars);
}

/** The short 8-char id used everywhere ids are surfaced. */
export function id8(id: string | undefined | null): string {
  return id ? id.replace(/-/g, '').slice(0, 8) : '';
}
