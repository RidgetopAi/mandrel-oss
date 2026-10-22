/**
 * Guards the G2-v4 → @ant-design/plots v2.6.5 (G2 v5) migration of the embedding
 * chart configs.
 *
 * The failure this locks down is SILENT: v4 keys (`meta`, top-level `yAxis`/`xAxis`,
 * `legend.position`) don't error under plots v2 — they're just ignored, so the axis
 * titles / y-floor / grid / legend placement quietly do nothing. These assertions
 * prove the config now speaks v5 (so the config TAKES EFFECT) and that the dead v4
 * keys are gone (so it can't regress back to a no-op).
 */
import { describe, it, expect } from 'vitest';
import {
  dailyActivityConfig,
  hourlyActivityConfig,
  contextTypeConfig,
  clusterScatterConfig,
} from './chartConfigs';
import type { ChartThemeTokens } from '../../utils/chartTheme';

const DARK: ChartThemeTokens = {
  theme: 'classicDark',
  textColor: 'rgba(255, 255, 255, 0.85)',
  gridColor: '#434343',
};

/** The v4 keys that plots v2 silently ignores — none may reappear at top level. */
const DEAD_V4_KEYS = ['meta', 'xAxis', 'yAxis'] as const;

describe('embedding chart configs — v5 migration', () => {
  describe('UsagePatterns configs', () => {
    const cases = [
      { name: 'dailyActivity', cfg: dailyActivityConfig([], DARK), xTitle: 'Date', yTitle: 'Contexts' },
      { name: 'hourlyActivity', cfg: hourlyActivityConfig([], DARK), xTitle: 'Hour', yTitle: 'Contexts' },
      { name: 'contextType', cfg: contextTypeConfig([], DARK), xTitle: 'Type', yTitle: 'Contexts' },
    ];

    for (const { name, cfg, xTitle, yTitle } of cases) {
      describe(name, () => {
        const c = cfg as Record<string, any>;

        it('carries no dead v4 keys (meta / xAxis / yAxis)', () => {
          for (const key of DEAD_V4_KEYS) {
            expect(c, `${name} still has v4 key "${key}"`).not.toHaveProperty(key);
          }
        });

        it('sets axis titles via v5 axis.{x,y}.title (was the ignored meta.alias)', () => {
          expect(c.axis.x.title).toBe(xTitle);
          expect(c.axis.y.title).toBe(yTitle);
        });

        it('sets the y floor via v5 scale.y.domainMin (was the ignored yAxis.min)', () => {
          expect(c.scale.y.domainMin).toBe(0);
        });

        it('keeps the load-bearing dark-mode theme + axis text fills', () => {
          expect(c.theme).toBe('classicDark');
          expect(c.axis.x.labelFill).toBe(DARK.textColor);
          expect(c.axis.y.titleFill).toBe(DARK.textColor);
        });
      });
    }
  });

  describe('ClusterAnalysis scatter config', () => {
    const c = clusterScatterConfig([], DARK) as Record<string, any>;

    it('carries no dead v4 keys (meta / xAxis / yAxis)', () => {
      for (const key of DEAD_V4_KEYS) {
        expect(c, `cluster config still has v4 key "${key}"`).not.toHaveProperty(key);
      }
    });

    it('places the legend via v5 per-channel legend.color.position (was legend.position)', () => {
      expect(c.legend.color.position).toBe('right');
      // The v4 top-level position/flipPage must be gone.
      expect(c.legend).not.toHaveProperty('position');
      expect(c.legend).not.toHaveProperty('flipPage');
    });

    it('draws grid via v5 axis.{x,y}.grid + gridStroke (was the ignored xAxis/yAxis.grid)', () => {
      expect(c.axis.x.grid).toBe(true);
      expect(c.axis.x.gridStroke).toBe(DARK.gridColor);
      expect(c.axis.y.grid).toBe(true);
      expect(c.axis.y.gridStroke).toBe(DARK.gridColor);
    });

    it('keeps the load-bearing dark-mode theme + axis text fills', () => {
      expect(c.theme).toBe('classicDark');
      expect(c.axis.x.labelFill).toBe(DARK.textColor);
      expect(c.axis.y.titleFill).toBe(DARK.textColor);
    });
  });
});
