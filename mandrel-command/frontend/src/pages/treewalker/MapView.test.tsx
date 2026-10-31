/** MapView — renders the pure layout; a branch click targets Story on its spine. */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MapView } from './MapView';
import { MAP_FIXTURE_IDS, mapFixture } from './mapBranches.fixture';
import { URL_PARAMS } from './config';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const mount = () => {
  const { branches, trunk } = mapFixture(NOW);
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      <MemoryRouter initialEntries={['/treewalker?view=map&project=p1']}>
        <MapView
          branches={branches.branches}
          trunk={trunk}
          sinceDays={branches.sinceDays}
          unbranched={branches.unbranched}
          unavailable={false}
          isLoading={false}
          now={NOW}
        />
      </MemoryRouter>,
    );
  });
  return container;
};

describe('MapView', () => {
  it('draws the trunk with its handoff count and a you-are-here marker', () => {
    const c = mount();
    expect(c.querySelector('[data-testid="tw-map-trunk-count"]')!.textContent).toBe('trunk · 214 handoffs');
    expect(c.querySelector('[data-testid="tw-map-here"]')!.textContent).toBe('you are here');
  });

  it('draws every branch on its own row with two connectors, and stations on the milestone branch', () => {
    const c = mount();
    const branches = [...c.querySelectorAll('[data-testid="tw-map-branch"]')];
    expect(branches).toHaveLength(5);
    const overlappingRows = branches.slice(0, 3).map((b) => b.getAttribute('data-row'));
    expect(new Set(overlappingRows).size).toBe(3);
    expect(c.querySelectorAll('[data-testid="tw-map-connector"]')).toHaveLength(10);
    const backstory = c.querySelector(`[data-spine-id="${MAP_FIXTURE_IDS.backstory}"]`)!;
    expect(backstory.querySelectorAll('[data-testid="tw-map-station"]')).toHaveLength(2);
    expect(c.querySelectorAll('[data-testid="tw-map-station"]')).toHaveLength(3);
  });

  it('states the unbranched share as served', () => {
    expect(mount().querySelector('[data-testid="tw-map-unbranched"]')!.textContent).toBe(
      'Not on any branch: 41% of records in the last 60 days',
    );
  });

  it('clicking a branch opens Story anchored on its spine', () => {
    const c = mount();
    const a = c.querySelector<SVGAElement>(`[data-spine-id="${MAP_FIXTURE_IDS.ossPhases}"]`)!;
    const url = new URL(a.getAttribute('href')!, 'http://x');
    expect(url.searchParams.get(URL_PARAMS.view)).toBe('story');
    expect(url.searchParams.get(URL_PARAMS.anchor)).toBe(MAP_FIXTURE_IDS.ossPhases);
    expect(url.searchParams.get('project')).toBe('p1');
  });
});
