/**
 * SSE configuration — single, named home for the live-update tunables
 * (configs-not-hardcoded). These govern how the client coalesces bursty
 * server-sent DB events into cache invalidations so a storm of same-entity
 * events cannot thrash the UI into constant refetch/flashing (
 * live/polling UI needs single-flight coalescing).
 */

/** Parse a non-negative integer from an env string, falling back on any bad value. */
const parseNonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export const sseConfig = {
  /**
   * Coalescing window (ms) for cache invalidations triggered by SSE events. The
   * first event of a burst invalidates immediately (leading edge — the UI stays
   * responsive to a real change); any further same-entity events inside the
   * window are collapsed into AT MOST one trailing invalidation when the window
   * closes. So a rapid burst of N same-entity events causes at most one refetch
   * per window instead of N, which is what stops the Contexts page flashing.
   * Override with VITE_SSE_INVALIDATION_DEBOUNCE_MS.
   */
  invalidationDebounceMs: parseNonNegativeInt(
    import.meta.env.VITE_SSE_INVALIDATION_DEBOUNCE_MS,
    300
  ),
} as const;

export type SseConfig = typeof sseConfig;
