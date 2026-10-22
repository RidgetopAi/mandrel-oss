/**
 * momentumCells — the single, NAMED home for the Calendar per-cell momentum treatment
 *: the colour BANDS + the mini-ring geometry + the
 * small pure helpers that turn a momentum-series point into what a day cell renders.
 *
 * COLOUR IS NOT FINAL — the operator iterates it live. That is exactly why every band colour lives
 * HERE and nowhere else: a later palette tweak is a ONE-FILE edit (configs-not-hardcoded).
 * The colours are applied via inline `style` at the callsite (not the stylesheet), so the
 * Calendar CSS stays 100% token-driven / hex-free while the tunable band ramp lives in code.
 *
 * BANDS (current teal-intensity ramp, keyed off the 0-100 score vs the user's 7-day baseline):
 *   score >= 80 → teal        (well above baseline)
 *   60 – 79     → teal-dim    (above)
 *   45 – 59     → muted teal  (~on par)
 *   < 45        → dim teal    (below baseline — reads dim)
 * `color` paints the ring arc + the right-edge band; `valColor` paints the momentum number.
 */

export interface MomentumBand {
  /** Inclusive lower bound of the band (checked high→low). */
  min: number;
  /** Stable class-ish key for tests / debugging (e.g. 'hi', 'good', 'mid', 'low'). */
  key: 'hi' | 'good' | 'mid' | 'low';
  /** Ring arc + right-edge band colour (token var or hex — a one-file tweak point). */
  color: string;
  /** The momentum number's text colour. */
  valColor: string;
}

/** Highest band first — `momentumBand` returns the first whose `min` the score meets. */
export const MOMENTUM_BANDS: readonly MomentumBand[] = [
  { min: 80, key: 'hi', color: 'var(--teal)', valColor: 'var(--teal)' },
  { min: 60, key: 'good', color: 'var(--teal-dim)', valColor: '#5fe0d2' },
  { min: 45, key: 'mid', color: '#2f6d67', valColor: 'var(--tx-2)' },
  { min: 0, key: 'low', color: '#294f4b', valColor: 'var(--tx-3)' },
] as const;

/** The band a score falls into (never undefined — the last band is a 0-floor catch-all). */
export function momentumBand(score: number): MomentumBand {
  return MOMENTUM_BANDS.find((b) => score >= b.min) ?? MOMENTUM_BANDS[MOMENTUM_BANDS.length - 1];
}

/**
 * Mini-ring geometry (SVG units), matching the mock. `viewBox` is the coordinate space;
 * `size` is the rendered px box; `radius`/`stroke` drive the arc. The track uses a token so
 * only the ACTIVE arc carries a band colour. Structural (not colour) — kept beside the bands
 * so the whole cell treatment is tunable from one file.
 */
export const MOMENTUM_RING = {
  size: 44,
  viewBox: 40,
  radius: 16,
  stroke: 4,
  trackColor: 'var(--s2)',
} as const;

/**
 * The compact top-right counts label for a cell: "2s·9c" (sessions·contexts), or "·9c" when
 * there were no sessions that day — matching the mock. Contexts are always shown (they're the
 * densest signal); sessions only when present.
 */
export function momentumCountsLabel(point: { sessions: number; contexts: number }): string {
  const s = point.sessions > 0 ? `${point.sessions}s` : '';
  return `${s}·${point.contexts}c`;
}
