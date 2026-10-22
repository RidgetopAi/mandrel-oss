/**
 * Chart theme resolution + drift guard (P0.6).
 *
 * Proves the ONE anti-drift claim: every chart colour is resolved from the P0.2
 * token maps, and it resolves DIFFERENTLY per theme with no re-derivation. If a
 * token moves, the chart theme moves with it — asserted here.
 */
import { describe, it, expect } from 'vitest';
import { resolveChartTheme, CHART_THEMES, CHART_GEOMETRY } from './chartTheme';
import { dark, light } from '../../styles/tokens';

describe('resolveChartTheme — token-sourced, per-mode', () => {
  it('resolves dark colours straight from the dark token map', () => {
    const t = resolveChartTheme('dark');
    expect(t.accent).toBe(dark.teal);
    expect(t.accentDim).toBe(dark['teal-dim']);
    expect(t.grid).toBe(dark['line-soft']);
    expect(t.text).toBe(dark.tx);
    expect(t.textFaint).toBe(dark['tx-4']);
    expect(t.status).toEqual({ ok: dark.ok, warn: dark.warn, crit: dark.crit });
    expect(t.tooltip.background).toBe(dark.s2);
  });

  it('resolves light colours straight from the light token map', () => {
    const t = resolveChartTheme('light');
    expect(t.accent).toBe(light.teal);
    expect(t.grid).toBe(light['line-soft']);
    expect(t.text).toBe(light.tx);
  });

  it('dark and light actually differ (no naive shared palette)', () => {
    expect(resolveChartTheme('dark').accent).not.toBe(resolveChartTheme('light').accent);
    expect(resolveChartTheme('dark').text).not.toBe(resolveChartTheme('light').text);
  });

  it('the categorical series palette IS the token accent order (teal-led)', () => {
    expect(resolveChartTheme('dark').series).toEqual([
      dark.teal,
      dark.violet,
      dark.blue,
      dark.green,
      dark.amber,
      dark.rose,
    ]);
  });

  it('pre-resolved CHART_THEMES match resolveChartTheme', () => {
    expect(CHART_THEMES.dark).toEqual(resolveChartTheme('dark'));
    expect(CHART_THEMES.light).toEqual(resolveChartTheme('light'));
  });

  it('geometry config exposes the dataviz constants (named, not magic)', () => {
    expect(CHART_GEOMETRY.lineStrokeWidth).toBeGreaterThan(0);
    expect(CHART_GEOMETRY.areaFillOpacityTop).toBeGreaterThan(CHART_GEOMETRY.areaFillOpacityBottom);
    expect(CHART_GEOMETRY.donutInnerRatio).toBeGreaterThan(0);
    expect(CHART_GEOMETRY.donutInnerRatio).toBeLessThan(1);
  });
});
