import React from 'react';
import { ResponsiveContainer, type TooltipProps } from 'recharts';
import { CHART_GEOMETRY, type ChartTheme } from './chartTheme';

/**
 * Wrap a recharts chart element either in a ResponsiveContainer (real UI — fills
 * the parent) or, when `responsive={false}`, render it at an explicit pixel size.
 * The fixed path is what makes the charts unit-testable: jsdom has no layout, so
 * ResponsiveContainer measures 0×0 and recharts renders nothing — a fixed size
 * gives the test a real SVG to assert against.
 */
export const Responsive: React.FC<{
  responsive: boolean;
  width: number;
  height: number;
  children: React.ReactElement;
}> = ({ responsive, width, height, children }) => {
  if (responsive) {
    return (
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    );
  }
  return React.cloneElement(children, { width, height });
};

/**
 * Shared recharts building blocks (P0.6) — all styled from the resolved
 * ChartTheme (concrete hex), so axes/grid/tooltip look identical across every
 * wrapper and re-theme together. No literal colours (charts.guards.test.ts).
 */

/**
 * One plotted series. `color` is optional — when omitted the wrapper assigns
 * the next colour from the theme's categorical palette (so callers never hardcode
 * a hex; colour still ENCODES the series).
 */
export interface SeriesDef {
  /** Data key on each row. */
  key: string;
  /** Legend/tooltip label (defaults to `key`). */
  name?: string;
  /** Explicit colour — a resolved hex or, preferably, a ChartTheme field. */
  color?: string;
}

/** Assign palette colours to any series that didn't specify one. */
export function resolveSeriesColors(series: SeriesDef[], palette: string[]): Required<SeriesDef>[] {
  return series.map((s, i) => ({
    key: s.key,
    name: s.name ?? s.key,
    color: s.color ?? palette[i % palette.length],
  }));
}

/** Props for the faint CartesianGrid (doc `.gl` — soft rule, horizontal only). */
export function gridProps(theme: ChartTheme) {
  return {
    stroke: theme.grid,
    strokeWidth: CHART_GEOMETRY.gridStrokeWidth,
    vertical: false,
  } as const;
}

/** Shared axis styling: muted mono ticks, hairline axis line, no tick marks. */
export function axisProps(theme: ChartTheme) {
  return {
    stroke: theme.line,
    tick: { fill: theme.textFaint, fontSize: CHART_GEOMETRY.tickFontSize },
    tickLine: false,
    axisLine: { stroke: theme.line },
  } as const;
}

/**
 * VALUE-axis (numeric) tick geometry + formatting. Named, not inlined
 * (configs-not-hardcoded), and shared by every chart wrapper.
 *
 * ── THE DEFECT THIS FIXES (addition 3) ────────────────────────────────
 * Every wrapper rendered its numeric axis as `width={36}` with NO tick formatter, so a
 * tick was printed in full and then CLIPPED by the 36px gutter. On the Analytics rhythm
 * panel against prod data the y-axis read `00000` four times — the tails of four
 * eight-digit token ticks — which is not a small number and not a large one; it is no
 * number at all. Four green browserless test suites could not see it, because jsdom has
 * no layout and a clipped tick is a layout fact.
 *
 * The fix is the formatter: `24M` fits where `24000000` did not. `width` is a budget
 * derived from the SAME character estimate the category axis uses, so the two cannot
 * drift apart.
 */
export const VALUE_TICK = {
  /** Longest formatted tick we budget for, e.g. "-1234.5M". */
  maxChars: 8,
  /** Right-hand gap (px) between the longest tick and the axis line. */
  gutterPadding: 6,
  /** Never narrower than this, however small the numbers. */
  minWidth: 30,
} as const;

/**
 * Compact number rendering: `1234567 -> 1.2M`, `1500 -> 1.5k`, `42 -> 42`.
 *
 * ONE implementation. `pages/analytics/parts.tsx` re-exports this rather than keeping
 * its own copy, so a KPI tile and the axis of the chart beneath it can never round the
 * same figure two different ways.
 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  // One decimal, trailing ".0" dropped — the exact rule pages/analytics/parts.tsx carried
  // before it started delegating here, so no KPI tile's rendering changed.
  const trim = (v: number) => (Math.round(v * 10) / 10).toString();
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

/**
 * The recharts props a NUMERIC (value) axis needs to stay legible. Spread it onto the
 * value axis of every wrapper.
 */
export function valueAxisConfig(fontSize: number = CHART_GEOMETRY.tickFontSize) {
  const perChar = fontSize * CATEGORY_TICK.charWidthRatio;
  return {
    width: Math.max(
      VALUE_TICK.minWidth,
      Math.ceil(VALUE_TICK.maxChars * perChar) + VALUE_TICK.gutterPadding,
    ),
    tickFormatter: (v: unknown) =>
      typeof v === 'number' ? compactNumber(v) : String(v),
  };
}

/**
 * Category-axis tick geometry. Named rather than inlined (configs-not-hardcoded).
 *
 * `charWidthRatio` converts the tick font size into an average glyph advance. It is
 * DELIBERATELY an over-estimate of the widest measured glyph run, so the budget errs
 * toward truncating one character early rather than letting a label bleed out of the
 * axis gutter and get clipped by the chart frame.
 */
export const CATEGORY_TICK = {
  /** Axis gutter (px) a caller gets if it asks for nothing. */
  defaultWidth: 72,
  /** Average glyph advance as a fraction of the tick font size. */
  charWidthRatio: 0.55,
  /** Right-hand gap (px) between the longest tick and the axis line. */
  gutterPadding: 6,
  /** Never truncate below this many characters, however narrow the gutter. */
  minChars: 5,
  ellipsis: '…',
} as const;

/**
 * How many characters fit in `width` px of axis gutter at `fontSize`.
 */
export function tickCharBudget(
  width: number,
  fontSize: number = CHART_GEOMETRY.tickFontSize,
): number {
  const usable = width - CATEGORY_TICK.gutterPadding;
  const perChar = fontSize * CATEGORY_TICK.charWidthRatio;
  return Math.max(CATEGORY_TICK.minChars, Math.floor(usable / perChar));
}

/**
 * The recharts props a CATEGORY axis needs in order to stay readable.
 *
 * This exists as one function, rather than as props written at the axis, so that
 * "label every band" and "elide rather than clip" cannot be set at one call site and
 * forgotten at another — there is no separate `interval` to omit. Spread it onto the
 * category axis.
 */
export function categoryAxisConfig(
  width: number = CATEGORY_TICK.defaultWidth,
  fontSize: number = CHART_GEOMETRY.tickFontSize,
) {
  const budget = tickCharBudget(width, fontSize);
  return {
    width,
    /**
     * Recharts' default thins ticks as bands get short, so a bar renders with NO label
     * and becomes unidentifiable. Measured in a browser on the by-actor chart at 14
     * categories in 168px: 5 of 14 ticks rendered, and the LARGEST bar was unlabelled.
     */
    interval: 0 as const,
    tickFormatter: (v: unknown) => truncateTick(String(v), budget),
  };
}

/**
 * Fit a category label into a character budget by removing characters from the MIDDLE.
 *
 * Middle-elision (not a trailing `foo…`) because the discriminating part of a generated
 * actor id is its SUFFIX: two ids sharing a long prefix collapse to the same string under
 * trailing truncation, and two bars that read identically are worse than one clipped bar.
 * The untruncated value stays reachable in the tooltip, which reads from the datum.
 */
export function truncateTick(label: string, budget: number): string {
  if (label.length <= budget) return label;
  const keep = budget - CATEGORY_TICK.ellipsis.length;
  if (keep < 2) return label.slice(0, Math.max(1, budget));
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return label.slice(0, head) + CATEGORY_TICK.ellipsis + (tail > 0 ? label.slice(-tail) : '');
}

/**
 * A vertical teal area-fill gradient (doc `#tealfill`), keyed to a unique id so
 * multiple charts on one page don't collide. Pass any accent colour.
 */
export const AreaGradient: React.FC<{ id: string; color: string }> = ({ id, color }) => (
  <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stopColor={color} stopOpacity={CHART_GEOMETRY.areaFillOpacityTop} />
    <stop offset="1" stopColor={color} stopOpacity={CHART_GEOMETRY.areaFillOpacityBottom} />
  </linearGradient>
);

/**
 * Token-themed tooltip — recharts renders this into a portalled DOM node, so it
 * needs concrete colours (resolved from the token map), not `var(--…)`.
 */
export function makeChartTooltip(
  theme: ChartTheme,
  /**
   * Render the tooltip's heading (the x value). Without one, recharts hands us the RAW
   * x value and we printed it verbatim — which is how the Workspace Activity tooltip came
   * to read `2026-07-13T00:00:00.000Z`. A chart whose axis is formatted
   * but whose tooltip is not is arguably worse than neither, so this is plumbed through
   * the same prop path as the tick formatter.
   */
  labelFormatter?: (label: unknown) => React.ReactNode,
) {
  const ChartTooltip: React.FC<TooltipProps<number | string, string>> = ({
    active,
    payload,
    label,
  }) => {
    if (!active || !payload || payload.length === 0) return null;
    const heading = labelFormatter ? labelFormatter(label) : (label as React.ReactNode);
    return (
      <div
        style={{
          background: theme.tooltip.background,
          border: `1px solid ${theme.tooltip.border}`,
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 12,
          color: theme.tooltip.text,
          minWidth: 96,
        }}
      >
        {label != null && (
          <div style={{ color: theme.tooltip.muted, marginBottom: 4, fontSize: 11 }}>{heading}</div>
        )}
        {payload.map((entry, i) => (
          <div
            key={i}
            style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: (entry.color as string) ?? theme.accent,
                flex: 'none',
              }}
            />
            <span style={{ color: theme.tooltip.muted }}>{entry.name}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{entry.value}</span>
          </div>
        ))}
      </div>
    );
  };
  ChartTooltip.displayName = 'ChartTooltip';
  return ChartTooltip;
}
