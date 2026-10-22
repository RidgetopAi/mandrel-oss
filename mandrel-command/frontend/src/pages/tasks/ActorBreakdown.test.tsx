/**
 * ActorBreakdown — the "Completed by actor" panel.
 *
 * These cover the two properties that made the chart unreadable in the browser and that
 * a screenshot cannot regression-test: the unassigned bucket's tone must not depend on
 * its rank, and the chart must be tall enough to give every actor row a band.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach } from 'vitest';
import { actorTone, actorChartHeight, UNASSIGNED_ACTOR, ACTOR_CHART_GEOMETRY } from './ActorBreakdown';
import ActorBreakdown from './ActorBreakdown';
import { ANALYTICS_CONFIG } from './config';

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('actorTone', () => {
  /**
   * The population is "every rank the unassigned bucket can occupy". Ordering is
   * count DESC, so the bucket moves as work is assigned — and the previous code keyed
   * colour on that position, which is exactly why the bucket changed hue between loads.
   */
  it('pins the unassigned bucket to one tone at every rank it can occupy', () => {
    const tones = new Set(
      Array.from({ length: 20 }, (_, rank) => actorTone(UNASSIGNED_ACTOR, rank)),
    );
    expect([...tones]).toEqual(['muted']);
  });

  it('never gives a named actor the tone reserved for unassigned', () => {
    const reserved = actorTone(UNASSIGNED_ACTOR, 0);
    for (let rank = 0; rank < 40; rank++) {
      expect(actorTone(`actor-${rank}`, rank)).not.toBe(reserved);
    }
  });
});

describe('actorChartHeight', () => {
  it('never shrinks below the shared panel height', () => {
    for (const n of [0, 1, 2]) {
      expect(actorChartHeight(n)).toBe(ANALYTICS_CONFIG.breakdownChartHeight);
    }
  });

  it('gives every row its own band once the rows outgrow the panel height', () => {
    for (const n of [10, 14, 40]) {
      const perRow =
        (actorChartHeight(n) - ACTOR_CHART_GEOMETRY.axisChrome) / n;
      expect(perRow).toBeGreaterThanOrEqual(ACTOR_CHART_GEOMETRY.rowHeight);
    }
  });
});

describe('ActorBreakdown', () => {
  /**
   * WHAT THIS CATCHES: a gutter too narrow for the real actor set, which is what elided
   * `builder-a7e922bd` into an unreadable stub. Probed by setting `categoryWidth` back to
   * the shared 72px default — this goes RED.
   *
   * WHAT IT DOES NOT CATCH: tick THINNING. jsdom reports zero-width SVG text, so recharts
   * renders every tick here regardless of `interval` (see the note in parts.test.ts).
   * That half is proved in a browser, not here.
   */
  it('renders an unelided tick for every actor including unassigned', () => {
    const actors = [
      { actor: UNASSIGNED_ACTOR, count: 359 },
      { actor: 'builder', count: 266 },
      { actor: 'coordinator', count: 13 },
      { actor: 'Builder', count: 8 },
      { actor: 'auditor', count: 5 },
      { actor: 'Operator + Coordinator', count: 4 },
      { actor: 'builder (P3 Insight)', count: 4 },
      { actor: 'Coordinator', count: 3 },
      { actor: 'research', count: 2 },
      { actor: 'builder-779f5be8', count: 1 },
      { actor: 'builder-a7e922bd', count: 1 },
      { actor: 'ops-bot', count: 1 },
      { actor: 'Coordinator + Operator', count: 1 },
      { actor: 'system', count: 1 },
    ];
    mount(<ActorBreakdown actors={actors} rangeLabel="30d" responsive={false} />);
    const rendered = [
      ...container.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick-value'),
    ].map((t) => t.textContent ?? '');
    expect(rendered.length).toBe(actors.length);
    expect(rendered).toContain(UNASSIGNED_ACTOR);
    expect(rendered).toContain('builder-a7e922bd');
  });

  it('shows the honest empty state when nothing completed in the window', () => {
    mount(<ActorBreakdown actors={[]} rangeLabel="30d" responsive={false} />);
    expect(container.textContent).toMatch(/No data yet/i);
  });
});
