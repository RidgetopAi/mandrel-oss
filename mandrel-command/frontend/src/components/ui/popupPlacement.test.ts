/**
 * Guard for the popup placement RULE.
 *
 * SCOPE, stated up front: this exercises the pure decision function only. It cannot prove
 * the defect is fixed, because the defect is overflow clipping and jsdom has no layout —
 * every rect it reports is zero. That is precisely why 431 passing frontend tests did not
 * catch the original bug, and why the real proof for this fix is a browser measurement.
 * What this file locks down is the part that IS decidable without a layout engine: given
 * measured space, which side is chosen — including that a popup which fits below is left
 * alone, so the fix cannot degrade into "always flip".
 *
 * The fixture numbers are the ones measured in a real browser on the task drawer, kept
 * here so a future change to the rule has to argue with the actual case that broke.
 */
import { describe, it, expect } from 'vitest';
import { choosePopupPlacement, readPxCustomProperty } from './popupPlacement';

/** Real geometry read off the drawer: the assignee row with the popup open. */
const DRAWER_CASE = {
  anchor: { top: 576, bottom: 615 },
  popupHeight: 50,
  offset: 4,
  bounds: { top: 57, bottom: 648 },
};

describe('choosePopupPlacement', () => {
  it('flips UP when the clipping container leaves no room below (the measured defect)', () => {
    // 33px below vs 54px needed — the popup was sliced at the drawer body's edge.
    expect(DRAWER_CASE.bounds.bottom - DRAWER_CASE.anchor.bottom).toBeLessThan(
      DRAWER_CASE.popupHeight + DRAWER_CASE.offset,
    );
    expect(choosePopupPlacement(DRAWER_CASE)).toBe('top');
  });

  it('stays DOWN when there is room below — a flip that always flips is the same bug', () => {
    expect(
      choosePopupPlacement({ ...DRAWER_CASE, anchor: { top: 312, bottom: 351 } }),
    ).toBe('bottom');
  });

  it('stays DOWN when the space below is exactly enough (boundary is inclusive)', () => {
    expect(
      choosePopupPlacement({
        ...DRAWER_CASE,
        anchor: { top: 100, bottom: DRAWER_CASE.bounds.bottom - 54 },
      }),
    ).toBe('bottom');
  });

  it('keeps the roomier side when the popup fits on neither', () => {
    // Squeezed both ways: 20px below, 10px above, 54px needed.
    expect(
      choosePopupPlacement({
        ...DRAWER_CASE,
        anchor: { top: 110, bottom: 180 },
        bounds: { top: 100, bottom: 200 },
      }),
    ).toBe('bottom');
  });

  it('does not flip on a degenerate/unmeasurable box (all-zero rects)', () => {
    expect(
      choosePopupPlacement({
        anchor: { top: 0, bottom: 0 },
        popupHeight: 0,
        offset: 0,
        bounds: { top: 0, bottom: 0 },
      }),
    ).toBe('bottom');
  });
});

describe('readPxCustomProperty', () => {
  it('returns 0 for an absent element rather than inventing an offset', () => {
    expect(readPxCustomProperty(null, '--nope')).toBe(0);
  });

  it('returns 0 for an unset property rather than NaN', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(readPxCustomProperty(el, '--definitely-unset')).toBe(0);
    el.remove();
  });
});
