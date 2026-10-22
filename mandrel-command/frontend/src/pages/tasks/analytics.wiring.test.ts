/**
 * Tasks · Analytics wiring guard (Phase 3). Source-level invariants
 * for the analytics view PART — cheap, deterministic, drift-proof:
 *   1. it REUSES the shared `src/components/charts` wrappers (never recharts directly, and
 *      NEVER the retired @ant-design/plots / G2 / plotly libs the old page used);
 *   2. it imports the shared Sparkline (KPI tile requirement);
 *   3. it carries NO hardcoded hex colour literal (tones resolve via chartTheme);
 *   4. it reads its tunables from config (RANGE_OPTIONS / ANALYTICS_CONFIG) — no magic
 *      thresholds inline (configs-not-hardcoded);
 *   5. the gap panels render an HONEST "not yet available" state (data policy 10397f65).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, f), 'utf8');
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ANALYTICS_FILES = [
  'Analytics.tsx',
  'AnalyticsKpis.tsx',
  'ThroughputChart.tsx',
  'StatusBreakdown.tsx',
  'PriorityBreakdown.tsx',
  'ActorBreakdown.tsx',
  'AgingList.tsx',
  'RangeSelector.tsx',
  'analyticsParts.ts',
];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('Analytics — reuses the shared charts layer, not a chart lib', () => {
  it.each(['ThroughputChart.tsx', 'StatusBreakdown.tsx', 'PriorityBreakdown.tsx', 'ActorBreakdown.tsx'])(
    '%s imports from components/charts (not recharts / plots / g2 / plotly)',
    (f) => {
      const src = read(f);
      expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/components\/charts['"]/);
      expect(src).not.toMatch(/from\s+['"]recharts['"]/);
      expect(src).not.toMatch(/@ant-design\/plots/);
      expect(src).not.toMatch(/from\s+['"]@antv\/g2['"]/);
      expect(src).not.toMatch(/from\s+['"]plotly/);
    },
  );

  it('the KPI row reuses the shared Sparkline', () => {
    expect(read('AnalyticsKpis.tsx')).toMatch(/Sparkline/);
    expect(read('AnalyticsKpis.tsx')).toMatch(/from\s+['"]\.\.\/\.\.\/components\/charts['"]/);
  });
});

describe('Analytics — no antd anywhere', () => {
  it.each(ANALYTICS_FILES)('%s does not import antd', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Analytics — token-sourced (no hex literals)', () => {
  it.each(ANALYTICS_FILES)('%s carries no hardcoded hex colour', (f) => {
    expect(strip(read(f)).match(HEX) ?? []).toEqual([]);
  });
});

describe('Analytics — tunables live in config (configs-not-hardcoded)', () => {
  it('config exposes the range options + analytics tunables', () => {
    const config = read('config.ts');
    expect(config).toMatch(/RANGE_OPTIONS/);
    expect(config).toMatch(/ANALYTICS_CONFIG/);
    expect(config).toMatch(/agingHotDays/);
  });
  it('the aging helper reads thresholds from config, not inline literals', () => {
    const parts = read('analyticsParts.ts');
    expect(parts).toMatch(/ANALYTICS_CONFIG\.agingHotDays/);
    expect(parts).toMatch(/ANALYTICS_CONFIG\.agingWarmDays/);
  });
});

describe('Analytics — real data or honest empty, never fabricated (data policy 10397f65)', () => {
  it('throughput + actor panels feed off REAL server props and drive a data-derived empty state', () => {
    const throughput = read('ThroughputChart.tsx');
    const actor = read('ActorBreakdown.tsx');
    // Both plot REAL props (series / actors) — not a hardcoded gap placeholder.
    expect(throughput).toMatch(/series/);
    expect(actor).toMatch(/actors/);
    // The empty state is DERIVED from the data (empty array), not a permanent "not yet" gap.
    expect(throughput).toMatch(/data\.length === 0/);
    expect(actor).toMatch(/empty=\{total === 0\}/);
    // The stale "not yet available" gap wording must be gone (the panels are wired now).
    expect(throughput).not.toMatch(/Not yet available/);
    expect(actor).not.toMatch(/Not yet available/);
  });
});
