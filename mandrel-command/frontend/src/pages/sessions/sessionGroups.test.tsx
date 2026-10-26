/**
 * Sessions grouping — the heading must never contradict the pills.
 *
 * The operator, 2026-08-09, with a screenshot: a section headed "LIVE NOW 4" above four cards
 * each pilled "dormant". The page bucketed on `st === 'ended' ? ended : live`, so the
 * HEADING asked "is this session not ended?" while every PILL asked "was there recorded
 * activity in the last SESSIONS_CONFIG.liveWithinMs?". Two questions, one screen.
 *
 * WHAT THESE TESTS ANCHOR ON, AND WHY THAT SHAPE: not "does a Dormant heading exist" —
 * that would pass on a page that renders the heading and still files a dormant card under
 * Live now. They read the CARD IDS present in each rendered <section> and require them to
 * equal exactly the ids whose derived status is that section's status. A card can only be
 * in one section, so the assertion is total: any misfiling moves an id and fails here.
 *
 * The `deriveStatus` in the expectation is imported from the product, not restated, so a
 * change to the live/dormant RULE moves the test's expectation with it — this file guards
 * the AGREEMENT between grouping and pill, which is the defect, not the threshold.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SESSIONS_CONFIG } from './config';
import { deriveStatus, groupByStatus, liveWindowLabel, type StatusedRow } from './parts';
import type { SessionListRow } from './hooks';

vi.mock('../../api', () => ({
  api: {
    sessions: { list: vi.fn(), get: vi.fn(), update: vi.fn(), start: vi.fn() },
  },
}));

const PROJECT = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'riverbend' };

const projectList = vi.hoisted(() => ({
  value: [] as Array<{ id: string; name: string }>,
  unavailable: false,
}));
vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined,
    allProjects: projectList.value,
    loading: false,
    projectsUnavailable: projectList.unavailable,
  }),
}));
vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: PROJECT.id }),
}));

import Sessions from '../Sessions';
import { api } from '../../api';

const mockApi = api as unknown as {
  sessions: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
};

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Recorded activity inside the window → pill says `live`. */
const LIVE = {
  id: 'sess-live',
  display_id: 'live-01',
  project_id: PROJECT.id,
  project_name: PROJECT.name,
  title: 'Live work',
  actor: 'coordinator',
  started_at: iso(60_000),
  ended_at: null,
  last_activity_at: iso(60_000),
  contexts_created: 3,
  tasks_created: 1,
  total_tokens: '1000',
};
/**
 * THE ROW THE BUG WAS ABOUT: never ended, so the old code filed it under "Live now",
 * but its last recorded activity is well outside the window, so its pill says `dormant`.
 * Deliberately just over twice the threshold — derived from the config, not a literal,
 * so retuning `liveWithinMs` cannot silently turn this row live and hollow the test.
 */
const DORMANT = {
  ...LIVE,
  id: 'sess-dormant',
  display_id: 'dormant-01',
  title: 'Quiet work',
  actor: 'builder',
  started_at: iso(SESSIONS_CONFIG.liveWithinMs * 3),
  last_activity_at: iso(SESSIONS_CONFIG.liveWithinMs * 2),
};
const ENDED = {
  ...LIVE,
  id: 'sess-ended',
  display_id: 'ended-01',
  title: 'Old work',
  actor: null,
  started_at: iso(SESSIONS_CONFIG.liveWithinMs * 9),
  ended_at: iso(SESSIONS_CONFIG.liveWithinMs * 8),
  last_activity_at: iso(SESSIONS_CONFIG.liveWithinMs * 8),
};

const ROWS = [LIVE, DORMANT, ENDED];

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/sessions']}>
          <Sessions />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** The session ids of the stream cards rendered inside one titled section. */
function cardIdsInSection(label: string): string[] {
  const section = container.querySelector(`section[aria-label="${label}"]`);
  if (!section) return [];
  return Array.from(
    section.querySelectorAll<HTMLElement>('button[aria-controls^="session-stream-body-"]'),
  ).map((b) => b.getAttribute('aria-controls')!.replace('session-stream-body-', ''));
}

function sectionText(label: string): string {
  return container.querySelector(`section[aria-label="${label}"]`)?.textContent ?? '';
}

/** Ids of the fixture rows whose DERIVED status (the product's rule) is `status`. */
function idsWithStatus(status: 'live' | 'dormant' | 'ended'): string[] {
  return ROWS.filter((r) => deriveStatus(r as unknown as SessionListRow) === status).map(
    (r) => r.id,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  projectList.value = [PROJECT];
  projectList.unavailable = false;
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id: PROJECT.id }));
  localStorage.setItem('aidis_current_project', JSON.stringify({ id: PROJECT.id }));
  mockApi.sessions.list.mockResolvedValue(ROWS);
  mockApi.sessions.get.mockResolvedValue({});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

describe('groupByStatus (unit)', () => {
  it('files every row under its own status and invents no others', () => {
    const rows: StatusedRow[] = [
      { row: { id: 'a' } as SessionListRow, status: 'dormant' },
      { row: { id: 'b' } as SessionListRow, status: 'live' },
      { row: { id: 'c' } as SessionListRow, status: 'ended' },
      { row: { id: 'd' } as SessionListRow, status: 'dormant' },
    ];
    const g = groupByStatus(rows);
    expect(g.live.map((e) => e.row.id)).toEqual(['b']);
    expect(g.dormant.map((e) => e.row.id)).toEqual(['a', 'd']);
    expect(g.ended.map((e) => e.row.id)).toEqual(['c']);
    // The invariant, stated as an invariant: a group's members all carry its status.
    for (const key of ['live', 'dormant', 'ended'] as const) {
      for (const entry of g[key]) expect(entry.status).toBe(key);
    }
  });

  it('returns three EMPTY groups for an empty list (the zero population)', () => {
    expect(groupByStatus([])).toEqual({ live: [], dormant: [], ended: [] });
  });

  it('names the same window the pill is decided by, from config', () => {
    expect(liveWindowLabel(30 * 60_000)).toBe('30m');
    expect(liveWindowLabel(60 * 60_000)).toBe('1h');
    expect(liveWindowLabel(90 * 60_000)).toBe('1.5h');
    // and the default is read from the config, not restated
    expect(liveWindowLabel()).toBe(liveWindowLabel(SESSIONS_CONFIG.liveWithinMs));
  });
});

describe('Sessions grouping — the heading agrees with the pills', () => {
  it('puts a never-ended-but-dormant session under Dormant, NOT under Live now', async () => {
    await mount();

    // Sanity: the fixture actually exercises all three statuses, or the test below is
    // asserting about a population it does not have.
    expect(idsWithStatus('live')).toEqual(['sess-live']);
    expect(idsWithStatus('dormant')).toEqual(['sess-dormant']);
    expect(idsWithStatus('ended')).toEqual(['sess-ended']);

    expect(cardIdsInSection('Live now')).toEqual(idsWithStatus('live'));
    expect(cardIdsInSection('Dormant')).toEqual(idsWithStatus('dormant'));
    expect(cardIdsInSection('Earlier')).toEqual(idsWithStatus('ended'));
  });

  it('never renders the word "dormant" inside the Live now section', async () => {
    await mount();
    // The pill is the only place a card says `dormant`. This is the screenshot the operator sent,
    // asserted directly.
    expect(sectionText('Live now')).not.toContain('dormant');
    expect(sectionText('Dormant')).toContain('dormant');
  });

  it("Live now's count equals the number of cards beneath it", async () => {
    await mount();
    const liveCards = cardIdsInSection('Live now');
    const head = sectionText('Live now');
    // The heading text carries the count; a count of 2 over 1 card is the reported bug.
    expect(head).toContain('Live now');
    expect(head.replace('Live now', '')).toContain(String(liveCards.length));
    expect(liveCards).toHaveLength(1);
  });

  it('says what "live" and "dormant" MEASURE, so a working-but-quiet agent is not read as idle', async () => {
    await mount();
    const w = liveWindowLabel();
    // BUG 2 of an earlier task is not fixable from the browser: `last_activity_at` only
    // advances on Mandrel WRITES, so an agent working without writing reads dormant. The
    // UI cannot make the signal better, but it must stop overstating it.
    expect(sectionText('Live now')).toContain(`recorded activity in the last ${w}`);
    expect(sectionText('Dormant')).toContain(`no recorded activity for ${w}+`);
    expect(sectionText('Dormant')).toContain('may still be working');
  });
});
