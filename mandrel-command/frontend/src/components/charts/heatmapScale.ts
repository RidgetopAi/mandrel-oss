/**
 * Heatmap colour-scale util (P0.6) — pure, dependency-free, token-agnostic.
 *
 * It interpolates a value in [0,1] across an ORDERED list of colour STOPS
 * (concrete hex, supplied by the caller from the design tokens — never literals
 * here). This is why the P0.6 heatmap needs no plotly/visx: a similarity grid is
 * an SVG <rect> grid + this lerp, ~zero extra weight, fully token-driven and
 * theme-aware. See Heatmap.tsx.
 */

/** Parse `#rgb` / `#rrggbb` (with optional alpha, ignored) → [r,g,b] 0-255. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length >= 6) h = h.slice(0, 6);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r,g,b] 0-255 → `#rrggbb`. */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Interpolate `t` in [0,1] across `stops` (>=2 colours), evenly spaced. Linear
 * RGB lerp — cheap and perfectly adequate for a similarity heatmap.
 */
export function interpolateColor(stops: string[], t: number): string {
  if (stops.length === 0) return 'transparent';
  if (stops.length === 1) return stops[0];
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  if (i >= stops.length - 1) return stops[stops.length - 1];
  const [r1, g1, b1] = hexToRgb(stops[i]);
  const [r2, g2, b2] = hexToRgb(stops[i + 1]);
  return rgbToHex(r1 + (r2 - r1) * f, g1 + (g2 - g1) * f, b1 + (b2 - b1) * f);
}

/** Normalize a raw value into [0,1] given the matrix's min/max. */
export function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp01((value - min) / (max - min));
}
