import React from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { ChartFrame } from './ChartFrame';
import { useChartTheme, CHART_GEOMETRY, type ThemeName } from './chartTheme';
import { makeChartTooltip, Responsive } from './parts';

/** One slice. `color` optional → assigned from the categorical palette. */
export interface PieDatum {
  name: string;
  value: number;
  /** Explicit slice colour (resolved hex) — else palette by index. */
  color?: string;
}

/**
 * PieChartCard (P0.6) — task-status / context-type mix. Donut by default (doc's
 * calm treatment); pass `donut={false}` for a full pie. Slice colours come from
 * the datum or the categorical palette — never a literal.
 */
export interface PieChartCardProps {
  data: PieDatum[];
  theme?: ThemeName;
  title?: React.ReactNode;
  caption?: React.ReactNode;
  height?: number;
  loading?: boolean;
  empty?: boolean;
  donut?: boolean;
  showLegend?: boolean;
  responsive?: boolean;
  width?: number;
}

export const PieChartCard: React.FC<PieChartCardProps> = ({
  data,
  theme,
  title,
  caption,
  height = 220,
  loading = false,
  empty,
  donut = true,
  showLegend = true,
  responsive = true,
  width = 320,
}) => {
  const ct = useChartTheme(theme);
  const isEmpty = empty ?? (data.length === 0 || data.every((d) => d.value === 0));
  const ChartTooltip = makeChartTooltip(ct);
  const colored = data.map((d, i) => ({ ...d, _color: d.color ?? ct.series[i % ct.series.length] }));
  // Outer radius keyed to the stage so the donut never clips; inner from config.
  const outer = Math.max(40, Math.min(height, responsive ? height : height) / 2 - 24);
  const inner = donut ? outer * CHART_GEOMETRY.donutInnerRatio : 0;

  return (
    <ChartFrame
      title={title}
      caption={caption}
      height={height}
      loading={loading}
      empty={isEmpty}
    >
      <Responsive responsive={responsive} width={width} height={height}>
        <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <Tooltip content={<ChartTooltip />} />
          {showLegend && (
            <Legend wrapperStyle={{ fontSize: 12, color: ct.textMuted }} verticalAlign="middle" align="right" layout="vertical" />
          )}
          <Pie
            data={colored}
            dataKey="value"
            nameKey="name"
            outerRadius={outer}
            innerRadius={inner}
            paddingAngle={donut ? 2 : 0}
            stroke={ct.surface.s1}
            strokeWidth={2}
            isAnimationActive={false}
          >
            {colored.map((d, i) => (
              <Cell key={i} fill={d._color} />
            ))}
          </Pie>
        </PieChart>
      </Responsive>
    </ChartFrame>
  );
};

export default PieChartCard;
