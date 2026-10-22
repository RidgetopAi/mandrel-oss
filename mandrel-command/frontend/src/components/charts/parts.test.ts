/**
 * Category-axis tick geometry.
 *
 * WHY THESE ARE PURE-FUNCTION TESTS AND NOT DOM TESTS. The defect is "a bar renders
 * with no label" / "a label is clipped". The obvious guard — mount the chart and count
 * the rendered ticks — cannot fail here: measured in this repo's jsdom, SVG text has no
 * `getComputedTextLength` (it is `undefined`) and `getBoundingClientRect().width` is 0,
 * and recharts decides both tick-thinning and label overflow from MEASURED text. That
 * guard was written first, mutation-probed by deleting `interval={0}`, and stayed GREEN.
 * So the rendered outcome is proved in a real browser (screenshots under
 * reports/tasks-analytics/) and the CONFIGURATION is proved here.
 */
import { describe, it, expect } from 'vitest';
import { CATEGORY_TICK, categoryAxisConfig, tickCharBudget, truncateTick } from './parts';
import { CHART_GEOMETRY } from './chartTheme';

describe('categoryAxisConfig', () => {
  it('labels every band, at every gutter width a caller can ask for', () => {
    for (const width of [0, 1, CATEGORY_TICK.defaultWidth, 132, 400]) {
      expect(categoryAxisConfig(width).interval).toBe(0);
      expect(categoryAxisConfig(width).width).toBe(width);
    }
  });

  it('defaults to the historical gutter width when a caller asks for nothing', () => {
    expect(categoryAxisConfig().width).toBe(CATEGORY_TICK.defaultWidth);
  });

  it('formats ticks through the elider, sized to the gutter it was given', () => {
    const long = 'a'.repeat(200);
    const narrow = categoryAxisConfig(72).tickFormatter(long);
    const wide = categoryAxisConfig(400).tickFormatter(long);
    expect(narrow.length).toBeLessThan(wide.length);
    expect(wide.length).toBeLessThan(long.length);
  });

  it('survives the values a free-form assignee can actually be', () => {
    const f = categoryAxisConfig().tickFormatter;
    expect(f('')).toBe('');
    expect(f(0)).toBe('0');
    expect(f(null)).toBe('null');
    expect(f(undefined)).toBe('undefined');
  });
});

describe('tickCharBudget', () => {
  it('never returns a budget below the floor, however narrow the gutter', () => {
    for (const width of [-100, 0, 1, 6, 7]) {
      expect(tickCharBudget(width)).toBe(CATEGORY_TICK.minChars);
    }
  });

  it('grows with the gutter and shrinks as the font grows', () => {
    expect(tickCharBudget(200)).toBeGreaterThan(tickCharBudget(72));
    expect(tickCharBudget(200, CHART_GEOMETRY.tickFontSize * 2)).toBeLessThan(
      tickCharBudget(200, CHART_GEOMETRY.tickFontSize),
    );
  });

  /**
   * The budget must UNDER-estimate how many characters fit, never over-estimate: an
   * over-estimate is the clipping bug coming back. Measured in the browser at the 11px
   * tick font, the widest observed glyph advance was 5.86px/char ('Builder', 41px/7).
   */
  it('assumes a glyph advance no narrower than the widest one measured in the browser', () => {
    expect(CATEGORY_TICK.charWidthRatio * CHART_GEOMETRY.tickFontSize).toBeGreaterThanOrEqual(5.86);
  });
});

describe('truncateTick', () => {
  it('passes through anything that already fits', () => {
    expect(truncateTick('unassigned', 20)).toBe('unassigned');
    expect(truncateTick('unassigned', 10)).toBe('unassigned');
    expect(truncateTick('', 10)).toBe('');
  });

  it('fits the budget when it does not', () => {
    for (const budget of [5, 8, 13, 21]) {
      expect(truncateTick('a'.repeat(200), budget).length).toBeLessThanOrEqual(budget);
    }
  });

  /**
   * THE PROPERTY THAT PICKED MIDDLE-ELISION OVER TRAILING TRUNCATION. Generated actor
   * ids share a long prefix and differ only in the suffix, so trailing truncation
   * renders two different actors as the same string — two bars that are impossible to
   * tell apart, which is worse than one clipped bar.
   */
  it('keeps prefix-sharing ids distinguishable', () => {
    const ids = [
      'builder-a7e922bd-0000-4000-8000-000000000001',
      'builder-a7e922bd-0000-4000-8000-000000000002',
      'builder-a7e922bd-0000-4000-8000-000000000003',
    ];
    const shown = ids.map((id) => truncateTick(id, 13));
    expect(new Set(shown).size).toBe(ids.length);
  });

  it('signals that it elided', () => {
    expect(truncateTick('a'.repeat(50), 13)).toContain(CATEGORY_TICK.ellipsis);
  });
});
