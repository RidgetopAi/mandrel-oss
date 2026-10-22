/**
 * Command charting layer (P0.6) — the consolidated, token-driven
 * chart foundation: recharts wrappers (2D charts), the @xyflow/react v12 graph
 * baseline, and a dependency-free SVG heatmap. Every colour resolves from the
 * P0.2 design tokens via the shared chartTheme (no literals — charts.guards.test.ts).
 *
 *   import { AreaChartCard, BarChartCard, useChartTheme } from '@/components/charts';
 *
 * Consolidation: recharts = the 2D-chart standard; xyflow v12
 * = node-graph views. The legacy plotly / @ant-design/plots (G2) / reactflow-v11
 * libs are removed per-screen as each screen migrates OFF them (NOT in this task).
 */

// Theme core
export {
  resolveChartTheme,
  useChartTheme,
  readDocumentTheme,
  CHART_THEMES,
  CHART_GEOMETRY,
} from './chartTheme';
export type { ChartTheme, ThemeName } from './chartTheme';

// Shared parts (for callers composing raw recharts)
export {
  gridProps,
  axisProps,
  AreaGradient,
  makeChartTooltip,
  resolveSeriesColors,
  Responsive,
  valueAxisConfig,
  compactNumber,
  VALUE_TICK,
} from './parts';
export type { SeriesDef } from './parts';

// Frame + state chrome
export { ChartFrame } from './ChartFrame';
export type { ChartFrameProps, ChartValueTone } from './ChartFrame';

// Recharts wrappers
export { AreaChartCard } from './AreaChartCard';
export type { AreaChartCardProps } from './AreaChartCard';
export { LineChartCard } from './LineChartCard';
export type { LineChartCardProps } from './LineChartCard';
export { BarChartCard } from './BarChartCard';
export type { BarChartCardProps } from './BarChartCard';
export { PieChartCard } from './PieChartCard';
export type { PieChartCardProps, PieDatum } from './PieChartCard';
export { Sparkline } from './Sparkline';
export type { SparklineProps } from './Sparkline';

// Graph (xyflow v12) baseline
export { GraphView, themedNodeStyle, xyflowCssVars } from './GraphView';
export type { GraphViewProps } from './GraphView';

// Heatmap (dependency-free SVG)
export { Heatmap } from './Heatmap';
export type { HeatmapProps } from './Heatmap';
export { interpolateColor, normalize, hexToRgb, rgbToHex } from './heatmapScale';
