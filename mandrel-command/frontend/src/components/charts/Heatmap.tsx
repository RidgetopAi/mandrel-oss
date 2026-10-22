import React, { useMemo } from 'react';
import { Empty, Spinner } from '../ui';
import { useChartTheme, type ThemeName } from './chartTheme';
import { interpolateColor, normalize } from './heatmapScale';

/**
 * Heatmap (P0.6) — a dependency-free, token-themed SVG cell grid. This is the
 * DECIDED replacement for plotly's SimilarityHeatmap (embedding/insight phase):
 * a similarity matrix is just an N×N grid of coloured <rect>s + a lerp'd colour
 * scale (heatmapScale.ts), so no plotly/visx dependency is warranted — an SVG
 * grid is ~zero weight, fully token-driven and theme-aware.
 *
 * Colour scale defaults to a token-derived ramp (soft surface → teal) resolved
 * per active theme; override with `colorStops` (hex from tokens). Cells carry a
 * native <title> for accessible hover; the Embedding phase can layer a richer
 * tooltip on this baseline.
 */
export interface HeatmapProps {
  /** row-major matrix of values. */
  matrix: number[][];
  xLabels?: string[];
  yLabels?: string[];
  theme?: ThemeName;
  /** Ordered colour stops (low→high). Defaults to a themed surface→teal ramp. */
  colorStops?: string[];
  /** Fixed value domain; defaults to the matrix min/max. */
  min?: number;
  max?: number;
  cellSize?: number;
  cellGap?: number;
  /** Format a cell value for its hover title. */
  formatValue?: (v: number) => string;
  loading?: boolean;
  emptyTitle?: React.ReactNode;
  className?: string;
}

export const Heatmap: React.FC<HeatmapProps> = ({
  matrix,
  xLabels,
  yLabels,
  theme,
  colorStops,
  min,
  max,
  cellSize = 26,
  cellGap = 2,
  formatValue = (v) => v.toFixed(2),
  loading = false,
  emptyTitle = 'No matrix data',
  className,
}) => {
  const ct = useChartTheme(theme);
  const rows = matrix.length;
  const cols = rows > 0 ? matrix[0].length : 0;
  const stops = colorStops ?? [ct.surface.s3, ct.accentDim, ct.accent];

  const { lo, hi } = useMemo(() => {
    if (rows === 0) return { lo: 0, hi: 1 };
    let l = Infinity;
    let h = -Infinity;
    for (const row of matrix) {
      for (const v of row) {
        if (v < l) l = v;
        if (v > h) h = v;
      }
    }
    return { lo: min ?? l, hi: max ?? h };
  }, [matrix, rows, min, max]);

  if (loading) {
    return (
      <div className={className} style={{ display: 'grid', placeItems: 'center', minHeight: 120 }}>
        <Spinner label="Loading heatmap" />
      </div>
    );
  }
  if (rows === 0 || cols === 0) {
    return <Empty title={emptyTitle} />;
  }

  const labelGutter = 68;
  const step = cellSize + cellGap;
  const gridW = cols * step - cellGap;
  const gridH = rows * step - cellGap;
  const svgW = gridW + (yLabels ? labelGutter : 0);
  const svgH = gridH + (xLabels ? 22 : 0);

  return (
    <svg
      className={className}
      viewBox={`0 0 ${svgW} ${svgH}`}
      width="100%"
      style={{ maxWidth: svgW, fontFamily: 'var(--mono)' }}
      role="img"
      aria-label="Similarity heatmap"
    >
      {matrix.map((row, r) =>
        row.map((v, c) => {
          const t = normalize(v, lo, hi);
          const x = (yLabels ? labelGutter : 0) + c * step;
          const y = r * step;
          return (
            <rect
              key={`${r}-${c}`}
              x={x}
              y={y}
              width={cellSize}
              height={cellSize}
              rx={3}
              fill={interpolateColor(stops, t)}
            >
              <title>
                {(yLabels?.[r] ?? `row ${r}`) + ' × ' + (xLabels?.[c] ?? `col ${c}`) + ' = ' + formatValue(v)}
              </title>
            </rect>
          );
        }),
      )}
      {yLabels?.map((lbl, r) => (
        <text
          key={`y-${r}`}
          x={labelGutter - 8}
          y={r * step + cellSize / 2}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill={ct.textFaint}
        >
          {lbl}
        </text>
      ))}
      {xLabels?.map((lbl, c) => (
        <text
          key={`x-${c}`}
          x={(yLabels ? labelGutter : 0) + c * step + cellSize / 2}
          y={gridH + 14}
          textAnchor="middle"
          fontSize={10}
          fill={ct.textFaint}
        >
          {lbl}
        </text>
      ))}
    </svg>
  );
};

export default Heatmap;
