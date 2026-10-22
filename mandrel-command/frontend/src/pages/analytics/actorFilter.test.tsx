/**
 * THE ACTOR SLICE MUST NOT SILENTLY DE-SYNC FROM THE FILTER IN EFFECT (reject 1).
 *
 * `actorOptions` is built from `useContextsByActor(...).data.actors` — a WINDOWED,
 * PROJECT-SCOPED list. The `actor` state is separate from it, so a Range (or Project)
 * change can empty the selected actor's bucket and drop it out of the option list. A
 * `<select>` whose `value` matches no `<option>` does not error: it falls back to
 * rendering the FIRST option, "Actor: all", while the page keeps sending
 * `?actor=operator` on every actor-aware read. Measured from the DOM before the fix:
 *
 *   BEFORE  value="operator"  selectedIndex=2  displayed="operator"
 *   AFTER   value=""       selectedIndex=0  displayed="Actor: all"  options=['', 'coordinator']
 *
 * i.e. the control asserted "all actors" over four KPI tiles and a hero chart that were
 * showing exactly one actor's (empty) slice, with the panel's own provenance line reading
 * `/api/sessions/trends?actor=operator` directly underneath. That is the same class — a
 * control making a false claim about the data on screen — the rest of this task removed.
 *
 * These tests mount the REAL page, not a model of it, and pin the two halves that were
 * free to disagree:
 *   (a) the selection SURVIVES a range change that empties its bucket;
 *   (b) WHAT THE CONTROL DISPLAYS IS WHAT THE READ ACTUALLY SENT — read off the rendered
 *       option text on one side and the arguments `api.sessions.trends` was called with on
 *       the other, so no assertion here can be satisfied by the two drifting together.
 *
 * Harness mirrors Sessions.controls.test.tsx: raw react-dom + React.act, api mocked at the
 * unified client, project context/settings stubbed so `usePageProject` resolves offline.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api', () => ({
  api: {
    sessions: {
      trends: vi.fn(),
      productive: vi.fn(),
      contextsByActor: vi.fn(),
      tokenPatterns: vi.fn(),
    },
    tasks: { stats: vi.fn() },
  },
}));

const PROJECT = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'riverbend' };

vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined, allProjects: [PROJECT], loading: false }),
}));
vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: PROJECT.id }),
}));

import Analytics from '../Analytics';
import { api } from '../../api';

const mockApi = api as unknown as {
  sessions: {
    trends: ReturnType<typeof vi.fn>;
    productive: ReturnType<typeof vi.fn>;
    contextsByActor: ReturnType<typeof vi.fn>;
    tokenPatterns: ReturnType<typeof vi.fn>;
  };
  tasks: { stats: ReturnType<typeof vi.fn> };
};

/**
 * The population that makes the defect reachable: `operator` has contexts in the 90d window
 * and NONE in the 7d one, so switching the range drops him out of the option list. `coordinator`
 * is present in both, so the list is never empty — an empty list would be a second,
 * different failure mode and would make a green here uninformative.
 */
const ACTORS_BY_DAYS: Record<number, string[]> = {
  7: ['coordinator'],
  30: ['coordinator', 'operator'],
  90: ['coordinator', 'operator'],
};

function byActorPayload(days: number) {
  const actors = ACTORS_BY_DAYS[days] ?? [];
  return {
    actors: actors.map((actor, i) => ({ actor, context_count: 10 - i })),
    attributed_contexts: actors.length * 10,
    unattributed_contexts: 0,
    total_contexts: actors.length * 10,
    user_driven_contexts: actors.length * 10,
    automated_contexts: 0,
    unknown_kind_contexts: 0,
    days,
  };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.sessions.contextsByActor.mockImplementation((params: { days: number }) =>
    Promise.resolve(byActorPayload(params.days)),
  );
  // The empty bucket is the whole point: the slice returns nothing, and the page must
  // still say WHOSE nothing it is.
  mockApi.sessions.trends.mockResolvedValue([]);
  mockApi.sessions.productive.mockResolvedValue([]);
  mockApi.sessions.tokenPatterns.mockResolvedValue([]);
  mockApi.tasks.stats.mockResolvedValue({ total: 0, byStatus: {}, byPriority: {}, byType: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <Analytics />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

/**
 * Poll until `ready()` holds, flushing react-query's promises and the renders they cause.
 *
 * A fixed number of microtask flushes is NOT enough here and was measured to be flaky: run
 * alone, the by-actor read had resolved and the control was enabled; run after its
 * siblings, the same number of flushes left the select still `disabled` with an empty
 * option list, and the test then asserted against a control that had not loaded yet.
 */
async function waitUntil(ready: () => boolean, label: string) {
  for (let i = 0; i < 50; i++) {
    if (ready()) return;
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * The page is settled when NOTHING is in flight and the control is interactive again.
 *
 * `isFetching() === 0` is read off react-query rather than off the assertion's own subject:
 * waiting for "the request carries the new actor" would make the wait circular with what
 * the tests below check. The three unconditional ticks first are because a state change
 * has not yet STARTED its refetch in the same tick — a bare `isFetching() === 0` is
 * trivially true at that moment and would wave the stale answer straight through.
 */
async function settle() {
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  await waitUntil(
    () => client.isFetching() === 0 && !actorSelect().disabled,
    'every analytics read to settle',
  );
}

function actorSelect(): HTMLSelectElement {
  const el = container.querySelector('[aria-label="Filter by actor"]') as HTMLSelectElement | null;
  expect(el, 'the actor select should be rendered').toBeTruthy();
  return el!;
}

/** What a user READS off the control — the text of the option the browser has selected. */
function displayedActor(): string {
  const sel = actorSelect();
  return (sel.selectedOptions[0]?.textContent ?? '').trim();
}

/** What the actor-aware read LAST put on the wire. `undefined` = no slice. */
function sentActor(): string | undefined {
  const calls = mockApi.sessions.trends.mock.calls;
  expect(calls.length, 'the trends read should have fired').toBeGreaterThan(0);
  return (calls[calls.length - 1][0] as { actor?: string }).actor;
}

async function chooseActor(value: string) {
  const sel = actorSelect();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

async function chooseRange(label: string) {
  const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
    (t) => (t.textContent ?? '').trim() === label,
  );
  expect(tab, `range option ${label} should exist`).toBeTruthy();
  await act(async () => {
    tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
  const days = Number(label.replace('d', ''));
  await waitUntil(
    () =>
      mockApi.sessions.contextsByActor.mock.calls.some(
        (c) => (c[0] as { days: number }).days === days,
      ),
    `the by-actor read for days=${days}`,
  );
}

describe('Analytics actor filter — the control and the request cannot disagree', () => {
  it('keeps the selected actor DISPLAYED after a range change empties its bucket', async () => {
    await mount();
    await chooseRange('90d');
    await chooseActor('operator');

    // Precondition: operator is genuinely selected and genuinely on the wire.
    expect(displayedActor()).toBe('operator');
    expect(sentActor()).toBe('operator');

    // The move that used to break it: 7d has no operator, so he leaves `actorOptions`.
    await chooseRange('7d');
    expect(
      mockApi.sessions.contextsByActor.mock.calls.some((c) => (c[0] as { days: number }).days === 7),
    ).toBe(true);

    // THE DEFECT: this read "Actor: all" while the request below still carried operator.
    expect(displayedActor()).toBe('operator');
    expect(actorSelect().value).toBe('operator');
  });

  it('displays exactly what it sends, across every range the control offers', async () => {
    await mount();
    await chooseRange('90d');
    await chooseActor('operator');

    for (const label of ['7d', '30d', '90d']) {
      // eslint-disable-next-line no-await-in-loop
      await chooseRange(label);
      // The invariant, stated as an equality between the two sides rather than as two
      // separate expected values: the label a user reads IS the slice the wire carries.
      const shown = displayedActor();
      const sent = sentActor();
      expect(shown === 'Actor: all' ? undefined : shown, `range=${label}`).toBe(sent);
      expect(sent, `range=${label}`).toBe('operator');
    }
  });

  it('still offers "Actor: all", and choosing it clears the slice from the wire', async () => {
    await mount();
    await chooseActor('operator');
    expect(sentActor()).toBe('operator');

    await chooseActor('');
    expect(displayedActor()).toBe('Actor: all');
    expect(sentActor()).toBeUndefined();

    // The absent-selection case: with no actor chosen, nothing is appended — the list is
    // exactly what the window returned.
    const values = Array.from(actorSelect().options).map((o) => o.value);
    expect(values).toEqual(['', 'coordinator', 'operator']);
  });
});
