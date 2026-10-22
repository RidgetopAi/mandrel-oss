import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
} from 'recharts';
import { ChartFrame } from './ChartFrame';
import { useChartTheme, CHART_GEOMETRY, type ThemeName } from './chartTheme';
import {
  axisProps,
  gridProps,
  makeChartTooltip,
  resolveSeriesColors,
  Responsive,
  CATEGORY_TICK,
  categoryAxisConfig,
  valueAxisConfig,
  type SeriesDef,
} from './parts';

/**
 * BarChartCard (P0.6) — task-status / by-actor bars. Supports vertical (default)
 * or horizontal layout, single or multi (grouped/stacked) series, and per-datum
 * colours (via `colorKey`) so a status bar can paint each bar its semantic hue.
 */
export interface BarChartCardProps {
  data: Array<Record<string, number | string>>;
  xKey: string;
  series: SeriesDef[];
  /** 'horizontal' = vertical bars (x categories); 'vertical' = horizontal bars. */
  layout?: 'horizontal' | 'vertical';
  /** Stack all series into one bar. */
  stacked?: boolean;
  /**
   * For a SINGLE series: a data key holding a per-row colour (resolved hex).
   * Lets a status chart paint each bar its own semantic colour.
   */
  colorKey?: string;
  /**
   * Width (px) of the CATEGORY axis gutter in `layout="vertical"`. Labels wider than
   * this are middle-elided to fit instead of bleeding out of the chart frame.
   * Defaults to the historical fixed value, so existing callers are unchanged.
   */
  categoryWidth?: number;
  /**
   * Explicit `[min, max]` for the NUMERIC axis. Pass it when two charts are meant to be
   * read AGAINST each other: with each chart on its own auto-domain, equal bar lengths
   * mean different numbers, and the reader has no way to see it. Omitted ⇒ recharts'
   * per-chart auto domain, so every existing caller is unchanged.
   */
  valueDomain?: [number, number];
  /**
   * Rewrite the tooltip's HEADING (the category value). Mirrors AreaChartCard's prop of
   * the same name and reaches the same `makeChartTooltip` slot. Without it a caller that
   * needs to say something about ONE bucket — "this bar is the current hour and is still
   * filling" — has nowhere to say it, because the axis tick is too narrow to carry the
   * words. Omitted ⇒ recharts' raw label, i.e. every existing caller is unchanged.
   */
  tooltipLabelFormatter?: (label: unknown) => React.ReactNode;
  theme?: ThemeName;
  title?: React.ReactNode;
  caption?: React.ReactNode;
  value?: React.ReactNode;
  valueTone?: 'default' | 'up' | 'down' | 'teal';
  height?: number;
  loading?: boolean;
  empty?: boolean;
  showGrid?: boolean;
  showAxes?: boolean;
  showLegend?: boolean;
  responsive?: boolean;
  width?: number;
}

export const BarChartCard: React.FC<BarChartCardProps> = ({
  data,
  xKey,
  series,
  layout = 'horizontal',
  stacked = false,
  colorKey,
  categoryWidth = CATEGORY_TICK.defaultWidth,
  valueDomain,
  tooltipLabelFormatter,
  theme,
  title,
  caption,
  value,
  valueTone,
  height = 220,
  loading = false,
  empty,
  showGrid = true,
  showAxes = true,
  showLegend = false,
  responsive = true,
  width = 480,
}) => {
  const ct = useChartTheme(theme);
  const resolved = resolveSeriesColors(series, ct.series);
  const isEmpty = empty ?? data.length === 0;
  const ChartTooltip = makeChartTooltip(ct, tooltipLabelFormatter);
  const vertical = layout === 'vertical';
  const singleSeries = resolved.length === 1;

  const catAxis = { dataKey: xKey, ...axisProps(ct) };
  // The numeric axis gets its width AND its tick formatter from one place. It used to be
  // a bare `width: 36` with no formatter, which CLIPPED eight-digit ticks into a run of
  // trailing zeros; the compact formatter is what makes them fit.
  const valAxis = {
    ...axisProps(ct),
    ...valueAxisConfig(axisProps(ct).tick.fontSize),
    // Spread conditionally: passing `domain: undefined` is NOT the same as omitting it in
    // recharts, and would drop every unset caller off its auto-domain.
    ...(valueDomain ? { domain: valueDomain, allowDecimals: false } : {}),
  };
  // Font size is read off the axis props the axis itself renders with, not restated.
  const catConfig = categoryAxisConfig(categoryWidth, catAxis.tick.fontSize);

  return (
    <ChartFrame
      title={title}
      caption={caption}
      value={value}
      valueTone={valueTone}
      height={height}
      loading={loading}
      empty={isEmpty}
    >
      <Responsive responsive={responsive} width={width} height={height}>
        <BarChart
          data={data}
          layout={layout}
          margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
        >
          {showGrid && <CartesianGrid {...gridProps(ct)} vertical={vertical} horizontal={!vertical} />}
          {/* Axes are ALWAYS rendered so recharts can compute the bar scale with the
              correct per-layout types (vertical ⇒ number-X + category-Y); `showAxes={false}`
              only HIDES them (recharts `hide`) rather than omitting them — omitting left the
              chart with mismatched default axis types and a blank/zero-width bar. */}
          {vertical ? (
            <>
              <XAxis type="number" {...valAxis} hide={!showAxes} />
              <YAxis type="category" {...catAxis} {...catConfig} hide={!showAxes} />
            </>
          ) : (
            <>
              <XAxis type="category" {...catAxis} hide={!showAxes} />
              <YAxis type="number" {...valAxis} hide={!showAxes} />
            </>
          )}
          <Tooltip content={<ChartTooltip />} cursor={{ fill: ct.surface.s3, fillOpacity: 0.4 }} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 12, color: ct.textMuted }} />}
          {resolved.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.name}
              fill={s.color}
              stackId={stacked ? 'stack' : undefined}
              radius={CHART_GEOMETRY.barRadius}
              isAnimationActive={false}
            >
              {singleSeries && colorKey
                ? data.map((row, i) => (
                    <Cell key={i} fill={(row[colorKey] as string) ?? s.color} />
                  ))
                : null}
            </Bar>
          ))}
        </BarChart>
      </Responsive>
    </ChartFrame>
  );
};

export default BarChartCard;
