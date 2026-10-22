/**
 * Isolated, testable chart config builders for the embedding analytics charts
 * (UsagePatterns + ClusterAnalysis).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These charts were carried over from @ant-design/plots v1 (G2 v4) config style.
 * Under the installed @ant-design/plots 2.6.5 / @antv/g2 5.4.1 the v4 keys below
 * are SILENTLY IGNORED (they don't error — they just do nothing):
 *
 *   - `meta: { field: { alias } }`      → axis titles never rendered
 *   - `yAxis: { min }` / `xAxis: {…}`   → the y-domain floor + grid never applied
 *   - `legend: { position, flipPage }`  → legend placement ignored
 *
 * The load-bearing dark-mode lever (`theme: classicDark` + `axis.*.labelFill`) was
 * already migrated to v5, so text stays legible — but the axis/legend/scale config
 * did nothing. This module migrates that config to the v5 spec so it TAKES EFFECT:
 *
 *   - field alias  → `axis.{x,y}.title`
 *   - y floor      → `scale.y.domainMin`
 *   - grid stroke  → `axis.{x,y}.grid` + `gridStroke` / `gridStrokeOpacity`
 *   - legend place → `legend.color.position` (per-channel, the v5 shape)
 *
 * Pulling the config out of the components (the task's "isolated chart config")
 * makes the migration unit-testable without rendering a <canvas> — see
 * chartConfigs.test.ts, which guards that the v5 keys are present and the dead v4
 * keys are gone so this can't silently regress.
 *
 * NOTE (scoped): the interaction / point-size / tooltip-formatter keys on the
 * cluster scatter are a SEPARATE, smaller v4→v5 migration (they need visual
 * verification against live data) and are intentionally left as-is here — this
 * task is the axis/legend/scale class the ticket named.
 */
import type { EmbeddingUsagePatterns } from '../../api/generated/models/EmbeddingUsagePatterns';
import type { EmbeddingClusterPoint } from '../../api/generated/models/EmbeddingClusterPoint';
import type { ChartThemeTokens } from '../../utils/chartTheme';

/** Shared height for the usage-pattern charts (named, not a magic literal). */
const USAGE_CHART_HEIGHT = 280;
/** Column width as a fraction of the band (kept from the original config). */
const COLUMN_WIDTH_RATIO = 0.6;

/**
 * v5 axis text fills. `classicDark` paints the base, but axis TITLE + label fills
 * still need to be set explicitly so they stay legible on a dark canvas.
 */
const axisText = (ct: ChartThemeTokens) => ({
  labelFill: ct.textColor,
  titleFill: ct.textColor,
});

// ─────────────────────────────────────────────────────────────────────────────
// UsagePatterns
// ─────────────────────────────────────────────────────────────────────────────

/** Daily activity line (30 days). */
export function dailyActivityConfig(
  data: EmbeddingUsagePatterns['dailyActivity'],
  ct: ChartThemeTokens,
) {
  return {
    data,
    xField: 'date',
    yField: 'contexts',
    height: USAGE_CHART_HEIGHT,
    smooth: true,
    theme: ct.theme,
    axis: {
      x: { title: 'Date', ...axisText(ct) },
      y: { title: 'Contexts', ...axisText(ct) },
    },
    // v5: y-domain floor is a SCALE config (was the ignored `yAxis.min`).
    scale: { y: { domainMin: 0 } },
  } as const;
}

/** Activity-by-hour column. */
export function hourlyActivityConfig(
  data: EmbeddingUsagePatterns['hourlyDistribution'],
  ct: ChartThemeTokens,
) {
  return {
    data,
    xField: 'hour',
    yField: 'contexts',
    columnWidthRatio: COLUMN_WIDTH_RATIO,
    height: USAGE_CHART_HEIGHT,
    theme: ct.theme,
    axis: {
      x: { title: 'Hour', ...axisText(ct) },
      y: { title: 'Contexts', ...axisText(ct) },
    },
    scale: { y: { domainMin: 0 } },
  } as const;
}

/** Context-types column. */
export function contextTypeConfig(
  data: EmbeddingUsagePatterns['contextsByType'],
  ct: ChartThemeTokens,
) {
  return {
    data,
    xField: 'type',
    yField: 'count',
    columnWidthRatio: COLUMN_WIDTH_RATIO,
    height: USAGE_CHART_HEIGHT,
    theme: ct.theme,
    axis: {
      x: { title: 'Type', ...axisText(ct) },
      y: { title: 'Contexts', ...axisText(ct) },
    },
    scale: { y: { domainMin: 0 } },
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// ClusterAnalysis
// ─────────────────────────────────────────────────────────────────────────────

/** k-means scatter of the projected embeddings, coloured by cluster. */
export function clusterScatterConfig(
  data: EmbeddingClusterPoint[],
  ct: ChartThemeTokens,
) {
  return {
    appendPadding: 10,
    data,
    xField: 'x',
    yField: 'y',
    colorField: 'cluster',
    size: 4,
    shape: 'circle',
    theme: ct.theme,
    axis: {
      // v5: grid moves onto the axis (was the ignored top-level `xAxis`/`yAxis`).
      x: { ...axisText(ct), grid: true, gridStroke: ct.gridColor, gridStrokeOpacity: 1 },
      y: { ...axisText(ct), grid: true, gridStroke: ct.gridColor, gridStrokeOpacity: 1 },
    },
    interactions: [
      { type: 'zoom-canvas', enable: true },
      { type: 'drag-canvas', enable: true },
    ],
    tooltip: {
      fields: ['label', 'cluster', 'x', 'y'],
      formatter: (datum: any) => ({
        name: `${datum.label}`,
        value: `Cluster ${datum.cluster}\n(${datum.x.toFixed(3)}, ${datum.y.toFixed(3)})`,
      }),
    },
    // v5: legend placement is per-channel (`legend.color`), was the ignored
    // top-level `legend.position` / `flipPage`.
    legend: {
      color: { position: 'right' as const },
    },
  } as const;
}
