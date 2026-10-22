import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { ChartFrame } from './ChartFrame';
import { useChartTheme, CHART_GEOMETRY, type ThemeName } from './chartTheme';
import {
  axisProps,
  gridProps,
  makeChartTooltip,
  resolveSeriesColors,
  Responsive,
  type SeriesDef,
  valueAxisConfig,
} from './parts';

/**
 * LineChartCard (P0.6) — multi-series line trends (e.g. tokens/day by actor)
 * with the shared axis/grid/tooltip language and the categorical palette.
 */
export interface LineChartCardProps {
  data: Array<Record<string, number | string>>;
  xKey: string;
  series: SeriesDef[];
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

export const LineChartCard: React.FC<LineChartCardProps> = ({
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
  showLegend = true,
  responsive = true,
  width = 480,
}) => {
  const ct = useChartTheme(theme);
  const resolved = resolveSeriesColors(series, ct.series);
  const isEmpty = empty ?? data.length === 0;
  const ChartTooltip = makeChartTooltip(ct);

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
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          {showGrid && <CartesianGrid {...gridProps(ct)} />}
          {showAxes && <XAxis dataKey={xKey} {...axisProps(ct)} />}
          {showAxes && <YAxis {...axisProps(ct)} {...valueAxisConfig(axisProps(ct).tick.fontSize)} />}
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: ct.line }} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 12, color: ct.textMuted }} />}
          {resolved.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={CHART_GEOMETRY.lineStrokeWidth}
              dot={false}
              activeDot={{ r: CHART_GEOMETRY.endpointRadius, fill: s.color }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </Responsive>
    </ChartFrame>
  );
};

export default LineChartCard;
