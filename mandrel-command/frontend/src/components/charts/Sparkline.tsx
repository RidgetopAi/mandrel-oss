import React, { useId } from 'react';
import { AreaChart, Area } from 'recharts';
import { useChartTheme, CHART_GEOMETRY, type ThemeName } from './chartTheme';
import { AreaGradient, Responsive } from './parts';

/**
 * Sparkline (P0.6) — a tiny, chrome-less inline trend for KPI tiles (StatTile).
 * Area fill + line + emphasized endpoint dot, no axes/grid/tooltip. Renders bare
 * (no ChartFrame) so it drops straight into a stat tile. Colour from a token
 * (defaults to teal); pass `tone` to encode a status.
 */
export interface SparklineProps {
  data: Array<Record<string, number | string>>;
  /** Value key (defaults to `value`). */
  dataKey?: string;
  theme?: ThemeName;
  /** Which themed colour to draw in. */
  tone?: 'teal' | 'green' | 'blue' | 'violet' | 'amber' | 'rose';
  height?: number;
  /** Real UI = true (fills parent width). Tests pass false + width. */
  responsive?: boolean;
  width?: number;
  emphasizeEndpoint?: boolean;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data,
  dataKey = 'value',
  theme,
  tone = 'teal',
  height = CHART_GEOMETRY.sparklineHeight,
  responsive = true,
  width = 120,
  emphasizeEndpoint = true,
}) => {
  const ct = useChartTheme(theme);
  const uid = useId().replace(/:/g, '');
  const toneColor: Record<NonNullable<SparklineProps['tone']>, string> = {
    teal: ct.accent,
    green: ct.status.ok,
    blue: ct.series[2],
    violet: ct.series[1],
    amber: ct.status.warn,
    rose: ct.status.crit,
  };
  const color = toneColor[tone];
  const lastIndex = data.length - 1;

  return (
    <Responsive responsive={responsive} width={width} height={height}>
      <AreaChart data={data} margin={{ top: 3, right: 3, bottom: 0, left: 0 }}>
        <defs>
          <AreaGradient id={`spark-${uid}`} color={color} />
        </defs>
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={CHART_GEOMETRY.lineStrokeWidth}
          fill={`url(#spark-${uid})`}
          dot={
            emphasizeEndpoint
              ? (dotProps: { cx?: number; cy?: number; index?: number }) => {
                  const { cx, cy, index } = dotProps;
                  if (index !== lastIndex || cx == null || cy == null) {
                    return <g key={index} />;
                  }
                  return (
                    <circle key={index} cx={cx} cy={cy} r={CHART_GEOMETRY.endpointRadius} fill={color} />
                  );
                }
              : false
          }
          activeDot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </Responsive>
  );
};

export default Sparkline;
