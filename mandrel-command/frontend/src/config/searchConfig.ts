/**
 * Context-search UI configuration — the single, named home for the search-box
 * tunables (configs-not-hardcoded; search consolidation).
 *
 * WHY THESE EXIST NOW: after consolidation, every free-text query is a REAL
 * semantic search — each keystroke that fires would cost a query EMBED on the
 * server (backend → MCP hop → embedder). So the input MUST debounce and enforce a
 * minimum query length before firing, or a fast typist hammers the embedder. These
 * were previously hardcoded (a bare 300ms); they now live here, env-overridable.
 */

/** Parse a non-negative integer from an env string, falling back on any bad value. */
const parseNonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export const searchConfig = {
  /**
   * Debounce (ms) applied to the search input before a query fires. Each fire now
   * costs a query embed, so a per-keystroke fire would hammer the embedder; the
   * debounce collapses a burst of keystrokes into one search.
   * Override with VITE_SEARCH_DEBOUNCE_MS.
   */
  debounceMs: parseNonNegativeInt(import.meta.env.VITE_SEARCH_DEBOUNCE_MS, 400),

  /**
   * Minimum query length before a semantic search fires. A 1–2 char fragment is
   * not a meaningful semantic query and would waste an embed; below this length the
   * box does not search (an empty box still clears back to browse). Clearing the
   * box (length 0) always takes effect immediately.
   * Override with VITE_SEARCH_MIN_QUERY_LENGTH.
   */
  minQueryLength: parseNonNegativeInt(import.meta.env.VITE_SEARCH_MIN_QUERY_LENGTH, 3),
} as const;

export type SearchConfig = typeof searchConfig;
