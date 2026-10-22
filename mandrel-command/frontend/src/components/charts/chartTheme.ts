/**
 * Chart theme — the ONE source of resolved chart styling for the Command redesign
 * (P0.6). Every recharts wrapper, the xyflow graph baseline and the
 * SVG heatmap read their colours from here. This kills the per-chart dark-mode
 * re-derivation drift that `src/utils/chartTheme.ts` (the legacy G2/plotly ternary)
 * represented.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CSS-VAR vs RESOLVED-HEX — the decision (documented, per the P0.6 brief)
 * ─────────────────────────────────────────────────────────────────────────────
 * Charts here resolve to CONCRETE HEX from the P0.2 typed token maps (`dark` /
 * `light` in ../../styles/tokens), keyed by an EXPLICIT theme name — NOT
 * `var(--token)`. Three reasons:
 *
 *   1. The `/dev/ui` gallery renders a DARK chart and a LIGHT chart side-by-side
 *      on ONE page. A `var(--…)` resolves to the single active `data-theme` on
 *      the document root, so it physically cannot show both themes at once.
 *      A resolved hex keyed by an explicit `theme` prop is the only way to paint
 *      two themes simultaneously.
 *   2. recharts is SVG (so a CSS var works in *some* SVG props), BUT the pieces
 *      that DON'T reliably take a CSS var need a concrete value anyway: the
 *      <linearGradient><stop stop-color> area fill, the portalled HTML tooltip's
 *      inline styles, xyflow node/edge inline styles, and the heatmap cell-colour
 *      INTERPOLATION (you can't lerp between two `var()`s). One resolution path
 *      (hex, always) avoids a "var here / hex there" split that is itself drift.
 *   3. Single source: colours trace to exactly one place — the P0.2 token maps.
 *      No literal hex lives in this file or any wrapper (enforced by
 *      charts.guards.test.ts). Change a token → every chart changes.
 *
 * Theme SWITCHING: `useChartTheme()` reads the active theme from the document
 * root's `data-theme` attribute (the same attribute ThemeContext + the gallery
 * set) via a subscription, so charts re-theme live on a theme toggle WITHOUT any
 * dependency on antd's ThemeContext (the new charts are antd-free). Pass an
 * explicit `theme` to override (the gallery's side-by-side uses this).
 *
 * NON-COLOUR tunables (opacities, stroke widths, radii, dot sizes) live in the
 * CHART_GEOMETRY config object below — named config, not magic numbers
 * (configs-not-hardcoded).
 */
import { useEffect, useState } from 'react';
import { dark, light, type ThemeName, type TokenMap } from '../../styles/tokens';

export type { ThemeName } from '../../styles/tokens';

/**
 * Non-colour chart geometry / opacity config. Values transcribed from the
 * dataviz treatment in command-design-language.html (`.chart` / `.area` /
 * `.lineC` / `.dotend` / `.gl`) + the analytics mocks. Named, in one place.
 */
export const CHART_GEOMETRY = {
  /** Area gradient: top stop opacity → bottom stop opacity (doc: 0.28 → 0). */
  areaFillOpacityTop: 0.26,
  areaFillOpacityBottom: 0,
  /** Line stroke width (doc `.lineC` = 2). */
  lineStrokeWidth: 2,
  /** Faint grid stroke width (doc `.gl` = 1). */
  gridStrokeWidth: 1,
  /** Emphasized endpoint dot radius (doc `.dotend` r=3.2). */
  endpointRadius: 3.6,
  /** Bar corner radius (px) — matches the token --r-xs rhythm. */
  barRadius: 4,
  /** Pie/donut inner radius as a fraction of outer (0 = full pie). */
  donutInnerRatio: 0.62,
  /** Axis tick font size (rem) — doc x-labels are ~0.6rem mono. */
  tickFontSize: 11,
  /** Sparkline default height (px) — doc `.chart` is 118px; sparkline is smaller. */
  sparklineHeight: 44,
} as const;

/** Fully-resolved chart theme for a single theme (dark or light). All hex. */
export interface ChartTheme {
  theme: ThemeName;
  /** Primary text (axis titles, tooltip label). */
  text: string;
  /** Muted text (axis ticks). */
  textMuted: string;
  /** Faintest text (captions, x-labels). */
  textFaint: string;
  /** Faint grid lines. */
  grid: string;
  /** Default hairline (axis line, tooltip border). */
  line: string;
  /** Brand teal — the primary single-series colour. */
  accent: string;
  /** Dimmer teal — gradient floor / secondary brand. */
  accentDim: string;
  /** Ordered categorical series palette (colour ENCODES, never decorates). */
  series: string[];
  /** Status → colour (semantic tokens). */
  status: { ok: string; warn: string; crit: string };
  /** Surfaces for tooltip / graph node / heatmap ground. */
  surface: { s1: string; s2: string; s3: string; bg: string };
  /** Tooltip styling bundle (concrete values for the portalled DOM node). */
  tooltip: { background: string; border: string; text: string; muted: string };
}

/**
 * Resolve the full chart theme from the P0.2 token map for a theme. Pure — no
 * literals; every colour is a token lookup. This is the anti-drift core.
 */
export function resolveChartTheme(theme: ThemeName): ChartTheme {
  const t: TokenMap = theme === 'dark' ? dark : light;
  return {
    theme,
    text: t.tx,
    textMuted: t['tx-2'],
    textFaint: t['tx-4'],
    grid: t['line-soft'],
    line: t.line,
    accent: t.teal,
    accentDim: t['teal-dim'],
    // The design-language categorical order: teal leads, then the accent hues.
    series: [t.teal, t.violet, t.blue, t.green, t.amber, t.rose],
    status: { ok: t.ok, warn: t.warn, crit: t.crit },
    surface: { s1: t.s1, s2: t.s2, s3: t.s3, bg: t.bg },
    tooltip: { background: t.s2, border: t.line, text: t.tx, muted: t['tx-2'] },
  };
}

/** Pre-resolved themes (cheap; avoids recomputing on every render). */
export const CHART_THEMES: Record<ThemeName, ChartTheme> = {
  dark: resolveChartTheme('dark'),
  light: resolveChartTheme('light'),
};

/** Read the theme currently pinned on the document root (defaults to dark). */
export function readDocumentTheme(): ThemeName {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

/**
 * The active chart theme. Pass `explicit` to force a theme (the gallery's
 * side-by-side dark/light). Otherwise it tracks the document root's `data-theme`
 * attribute live (via a MutationObserver) so charts re-theme on a theme toggle —
 * with no antd/ThemeContext coupling.
 */
export function useChartTheme(explicit?: ThemeName): ChartTheme {
  const [docTheme, setDocTheme] = useState<ThemeName>(() =>
    explicit ?? readDocumentTheme(),
  );

  useEffect(() => {
    if (explicit) return; // Pinned — don't subscribe.
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => setDocTheme(readDocumentTheme());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, [explicit]);

  return CHART_THEMES[explicit ?? docTheme];
}
