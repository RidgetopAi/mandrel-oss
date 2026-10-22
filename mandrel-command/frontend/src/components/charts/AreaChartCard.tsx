import React, { useId } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { ChartFrame } from './ChartFrame';
import {
  useChartTheme,
  CHART_GEOMETRY,
  type ThemeName,
} from './chartTheme';
import {
  AreaGradient,
  axisProps,
  gridProps,
  makeChartTooltip,
  resolveSeriesColors,
  Responsive,
  type SeriesDef,
  valueAxisConfig,
} from './parts';

/**
 * AreaChartCard (P0.6) — the session/context trend treatment from the design
 * doc: teal line, teal→transparent gradient fill, faint horizontal grid, and an
 * EMPHASIZED endpoint dot on the latest point (doc `.dotend`). Single-series is
 * the hero; multi-series stacks/overlaps with the categorical palette.
 */
export interface AreaChartCardProps {
  data: Array<Record<string, number | string>>;
  /** Category (x) key. */
  xKey: string;
  /** One or more area series (defaults to a single teal `value` series). */
  series?: SeriesDef[];
  theme?: ThemeName;
  title?: React.ReactNode;
  caption?: React.ReactNode;
  value?: React.ReactNode;
  valueTone?: 'default' | 'up' | 'down' | 'teal';
  height?: number;
  loading?: boolean;
  /** Force empty; otherwise derived from `data.length === 0`. */
  empty?: boolean;
  showGrid?: boolean;
  showAxes?: boolean;
  showLegend?: boolean;
  /** Emphasize the last data point with a filled dot (single-series only). */
  emphasizeEndpoint?: boolean;
  /** Real UI = true (fills parent). Tests pass false + width/height. */
  responsive?: boolean;
  width?: number;
  /**
   * Format the x-axis tick labels. Supply one for any DATE axis — recharts otherwise
   * prints the raw value, which for this backend's day buckets is a full ISO string
   * (`2026-07-13T00:00:00.000Z` was on the operator's screenshot). Use
   * `utils/datetime.formatDayShort`, which renders a day bucket WITHOUT shifting it into
   * the browser's zone.
   */
  xTickFormatter?: (value: unknown, index: number) => string;
  /**
   * Format the tooltip heading. Defaults to `xTickFormatter` when omitted, so a chart
   * cannot end up with a formatted axis and a raw tooltip. Pass a fuller formatter
   * (`formatDayLong`) when the tooltip has room for more than the axis does.
   */
  tooltipLabelFormatter?: (label: unknown) => React.ReactNode;
}

export const AreaChartCard: React.FC<AreaChartCardProps> = ({
  data,
  xKey,
  series,
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
  emphasizeEndpoint = true,
  responsive = true,
  width = 480,
  xTickFormatter,
  tooltipLabelFormatter,
}) => {
  const ct = useChartTheme(theme);
  const uid = useId().replace(/:/g, '');
  const resolved = resolveSeriesColors(
    series ?? [{ key: 'value', color: ct.accent }],
    ct.series,
  );
  const isEmpty = empty ?? data.length === 0;
  // A formatted axis with a raw tooltip is the failure this default removes: the tooltip
  // falls back to the tick formatter unless the caller deliberately supplies its own.
  const labelFormatter =
    tooltipLabelFormatter ??
    (xTickFormatter ? (label: unknown) => xTickFormatter(label, 0) : undefined);
  const ChartTooltip = makeChartTooltip(ct, labelFormatter);
  const lastIndex = data.length - 1;
  const singleSeries = resolved.length === 1;

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
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <defs>
            {resolved.map((s) => (
              <AreaGradient key={s.key} id={`area-${uid}-${s.key}`} color={s.color} />
            ))}
          </defs>
          {showGrid && <CartesianGrid {...gridProps(ct)} />}
          {showAxes && (
            <XAxis
              dataKey={xKey}
              {...axisProps(ct)}
              {...(xTickFormatter
                ? { tickFormatter: (value: unknown, index: number) => xTickFormatter(value, index) }
                : {})}
            />
          )}
          {showAxes && <YAxis {...axisProps(ct)} {...valueAxisConfig(axisProps(ct).tick.fontSize)} />}
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: ct.line }} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 12, color: ct.textMuted }} />}
          {resolved.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={CHART_GEOMETRY.lineStrokeWidth}
              fill={`url(#area-${uid}-${s.key})`}
              // Emphasized endpoint: draw a filled dot ONLY on the latest point
              // (single-series hero treatment). recharts calls this per point.
              dot={
                emphasizeEndpoint && singleSeries
                  ? (dotProps: { cx?: number; cy?: number; index?: number }) => {
                      const { cx, cy, index } = dotProps;
                      if (index !== lastIndex || cx == null || cy == null) {
                        return <g key={index} />;
                      }
                      return (
                        <circle
                          key={index}
                          cx={cx}
                          cy={cy}
                          r={CHART_GEOMETRY.endpointRadius}
                          fill={s.color}
                        />
                      );
                    }
                  : false
              }
              activeDot={{ r: CHART_GEOMETRY.endpointRadius, fill: s.color }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </Responsive>
    </ChartFrame>
  );
};

export default AreaChartCard;
