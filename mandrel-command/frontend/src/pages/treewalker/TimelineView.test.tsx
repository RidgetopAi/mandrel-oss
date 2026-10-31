/** TimelineView — renders the pure layout; a marker click targets the Story beat. */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TimelineView } from './TimelineView';
import { TIMELINE_IDS, TIMELINE_THREAD } from './timelineBranch.fixture';
import { URL_PARAMS } from './config';
import { SPAWNED_IDS, SPAWNED_THREAD } from './spawnedTasksBranch.fixture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mount = () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      <MemoryRouter initialEntries={['/treewalker?view=timeline&anchor=abc']}>
        <TimelineView graph={TIMELINE_THREAD} unavailable={false} isLoading={false} />
      </MemoryRouter>,
    );
  });
  return { container };
};

describe('TimelineView', () => {
  it('draws only populated lanes, bands, a fold marker and day ticks', () => {
    const { container } = mount();
    expect(container.querySelectorAll('[data-testid="tw-tl-lane"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-testid="tw-tl-lane"]').length).toBeLessThanOrEqual(7);
    expect(container.querySelectorAll('[data-testid="tw-tl-band"]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="tw-tl-gap"]')!.textContent).toMatch(/^\d+ h gap$/);
    expect(container.querySelectorAll('[data-testid="tw-tl-tick"]').length).toBeGreaterThan(0);
  });

  it('every marker has a role + title + time name and links to its Story beat', () => {
    const { container } = mount();
    const points = [...container.querySelectorAll<HTMLAnchorElement>('[data-testid="tw-tl-point"]')];
    expect(points.length).toBeGreaterThan(0);
    const decision = points.find((p) => p.getAttribute('href')!.includes(TIMELINE_IDS.firstReview))!;
    expect(decision.getAttribute('aria-label')).toMatch(/^Review: Review: licence headers, Oct 25/);
    const url = new URL(decision.getAttribute('href')!, 'http://x');
    expect(url.searchParams.get('view')).toBe('story');
    expect(url.searchParams.get(URL_PARAMS.beat)).toBe(TIMELINE_IDS.firstReview);
    expect(url.searchParams.get('anchor')).toBe('abc');
  });
});

describe('TimelineView Task lane', () => {
  const mountSpawned = () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        <MemoryRouter initialEntries={['/treewalker?view=timeline&anchor=abc']}>
          <TimelineView graph={SPAWNED_THREAD} unavailable={false} isLoading={false} />
        </MemoryRouter>,
      );
    });
    return container;
  };

  it('plots every task, a task click opens Why, and the key explains the three statuses', () => {
    const c = mountSpawned();
    const tasks = [...c.querySelectorAll<HTMLAnchorElement>('[data-testid="tw-tl-point"][data-role="task"]')];
    expect(tasks).toHaveLength(4);
    const spawned = tasks.find((p) => p.getAttribute('href')!.includes(SPAWNED_IDS.done))!;
    expect(spawned.getAttribute('aria-label')).toContain('decided by');
    const url = new URL(spawned.getAttribute('href')!, 'http://x');
    expect(url.searchParams.get('view')).toBe('why');
    expect(url.searchParams.get(URL_PARAMS.record)).toBe(SPAWNED_IDS.done);
    expect(new Set(tasks.map((p) => p.getAttribute('data-state')))).toEqual(new Set(['done', 'open', 'cancelled']));
    expect(c.querySelectorAll('[data-testid="tw-tl-key"] li[data-state]')).toHaveLength(3);
    // the marker CLASS draws the status (shape/fill); data-state alone does not
    const classByState = (sel: string) =>
      new Map([...c.querySelectorAll<HTMLElement>(sel)].map((el) => [el.getAttribute('data-state'), el.className]));
    for (const sel of ['[data-testid="tw-tl-point"][data-role="task"]', '[data-testid="tw-tl-key"] li[data-state]']) {
      const m = classByState(sel);
      expect(new Set(m.values()).size).toBe(3);
      expect(m.get('done')).not.toBe(m.get('open'));
      expect(m.get('cancelled')).not.toBe(m.get('open'));
      expect(m.get('cancelled')).not.toBe(m.get('done'));
    }
    const decision = c.querySelector<HTMLAnchorElement>(`[data-testid="tw-tl-point"][href*="${SPAWNED_IDS.decision}"]`)!;
    expect(new URL(decision.getAttribute('href')!, 'http://x').searchParams.get('view')).toBe('story');
  });
});
