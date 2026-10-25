/**
 * DaySummary render + wiring tests. Mounts the day-summary card into jsdom
 * (createRoot + async act — the repo pattern) behind a QueryClientProvider + a
 * MemoryRouter (the /r/<id8> links are react-router <Link>s), with the UNIFIED `api`
 * client MOCKED (the client, never the card's own rendering — no lying mocks).
 *
 * Proves: every section renders from a representative payload; ids render as
 * clickable /r/<id8> links; the quiet-day state; loading + error; the PNG-export
 * wiring; and — the load-bearing regression guard — the request carries the LOCAL
 * yyyy-mm-dd of the clicked day and does NOT shift to the UTC next day for an
 * evening-local Date (an earlier task local-date contract).
 *
 * NB: the card renders through a PORTAL to document.body, so assertions read
 * document.body, not the mount container.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api', () => ({
  api: {
    daySummary: { get: vi.fn() },
  },
}));
// The card reads the ONE central project list for its scope LABEL — it no longer issues
// its own `/api/projects` fetch (page-scope epic §D).
vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined,
    allProjects: [
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'riverbend' },
      { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'daisy' },
    ],
    loading: false,
  }),
}));
vi.mock('../../utils/domToPng', () => ({
  downloadNodeAsPng: vi.fn().mockResolvedValue(undefined),
}));

import { DaySummary } from './DaySummary';
import { api } from '../../api';
import { downloadNodeAsPng } from '../../utils/domToPng';
import type { DaySummaryData } from '../../api/domains/daySummary';

const mockApi = api as unknown as {
  daySummary: { get: ReturnType<typeof vi.fn> };
};

/**
 * The card is handed the CALENDAR's per-request scope; it has no scope of its own by
 * design (page-scope epic §E). A recognisable stand-in so the assertions can prove the card
 * PASSES IT THROUGH rather than quietly calling unscoped.
 */
const INHERITED_SCOPE = { headers: { 'X-Project-ID': 'inherited-from-calendar' } };
const pageScope = () => INHERITED_SCOPE;
const mockDownload = downloadNodeAsPng as unknown as ReturnType<typeof vi.fn>;

const HL_ID = '76959999-aaaa-bbbb-cccc-1234567890ab';
const DEC_ID = '9879f00d-0000-1111-2222-333344445555';
const TASK_ID = 'e889f00d-dddd-eeee-ffff-000011112222';

function populated(): DaySummaryData {
  const kpi = (value: number, delta: number) => ({ value, delta });
  return {
    date: '2026-07-15',
    tz: 'America/New_York',
    project: 'all',
    headline: 'Shipped actor attribution end-to-end + the Contexts grid.',
    momentum: { score: 83, delta: 18, breakdown: { output: 90, followThrough: 70, depth: 88 } },
    kpis: {
      sessions: kpi(2, 0),
      activeMinutes: kpi(348, 114),
      contexts: kpi(30, 11),
      decisions: kpi(3, 2),
      tasksDone: kpi(9, 5),
      filesTouched: kpi(24, 7),
    },
    ribbon: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: h >= 9 && h <= 22 ? h : 0 })),
    highlights: [
      { type: 'milestone', text: 'Actor attribution live across the Command UI.', id: HL_ID },
    ],
    decisions: [{ title: 'Session identity: one normalized actor per session.', id: DEC_ID }],
    tasksCompleted: {
      count: 9,
      items: [{ title: 'Thread actor through callMcpEndpoint', id: TASK_ID }],
    },
    byActor: [
      { actor: 'coordinator', count: 6 },
      { actor: 'builder', count: 4 },
    ],
  };
}

function quiet(): DaySummaryData {
  const z = { value: 0, delta: 0 };
  return {
    date: '2026-07-15',
    tz: 'UTC',
    project: 'all',
    headline: null,
    momentum: { score: 50, delta: 0, breakdown: { output: 0, followThrough: 0, depth: 0 } },
    kpis: {
      sessions: z,
      activeMinutes: z,
      contexts: z,
      decisions: z,
      tasksDone: z,
      filesTouched: z,
    },
    ribbon: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
    highlights: [],
    decisions: [],
    tasksCompleted: { count: 0, items: [] },
    byActor: [],
  };
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount(props: {
  date: Date;
  tz?: string;
  project?: string;
  onClose?: () => void;
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DaySummary
            date={props.date}
            tz={props.tz}
            project={props.project ?? 'all'}
            scope={pageScope}
            onClose={props.onClose}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
});

describe('DaySummary — populated card', () => {
  it('renders every section from a representative payload', async () => {
    mockApi.daySummary.get.mockResolvedValue(populated());
    await mount({ date: new Date(2026, 6, 15, 14, 0), tz: 'America/New_York' });
    await settle();
    const text = document.body.textContent ?? '';
    // header + scope + headline
    expect(text).toContain('Day Summary');
    expect(text).toContain('all projects');
    expect(text).toContain('Shipped actor attribution');
    // momentum ring value
    expect(text).toContain('83');
    // KPI tiles
    expect(text).toContain('Sessions');
    expect(text).toContain('Contexts');
    expect(text).toContain('Tasks done');
    // sections
    expect(text).toContain('What got done');
    expect(text).toContain('Actor attribution live');
    expect(text).toContain('Decisions');
    expect(text).toContain('Session identity');
    expect(text).toContain('Tasks completed');
    expect(text).toContain('Thread actor through');
    expect(text).toContain('By actor');
    expect(text).toContain('coordinator');
    // "+N more" collapse (9 total, 1 item shown)
    expect(text).toContain('8 more');
  });

  it('renders record ids as clickable /r/<id8> resolve links', async () => {
    mockApi.daySummary.get.mockResolvedValue(populated());
    await mount({ date: new Date(2026, 6, 15, 14, 0), tz: 'America/New_York' });
    await settle();
    // href is the dashless-normalized id under /r/; visible text is r/<id8>
    const hl = document.body.querySelector(`a[href="/r/${HL_ID.replace(/-/g, '')}"]`);
    expect(hl).not.toBeNull();
    expect(hl?.textContent).toBe('r/76959999');
    expect(document.body.querySelector(`a[href="/r/${DEC_ID.replace(/-/g, '')}"]`)).not.toBeNull();
    expect(document.body.querySelector(`a[href="/r/${TASK_ID.replace(/-/g, '')}"]`)).not.toBeNull();
  });
});

describe('DaySummary — local-date contract (no UTC shift)', () => {
  it('requests the LOCAL yyyy-mm-dd of the clicked day, not the UTC next day', async () => {
    mockApi.daySummary.get.mockResolvedValue(populated());
    // 8pm local on Jul 15 — toISOString() would be Jul 16 in a positive-UTC-offset
    // render, or could roll the day in either direction. The request MUST carry the
    // local calendar day the user clicked.
    await mount({ date: new Date(2026, 6, 15, 20, 0), tz: 'America/New_York', project: 'all' });
    await settle();
    expect(mockApi.daySummary.get).toHaveBeenCalledWith(
      {
        date: '2026-07-15',
        project: 'all',
        tz: 'America/New_York',
      },
      // …and it carries the CALENDAR's scope, not one of its own and not none. An
      // unscoped read here would inherit the ambient default project, so the card would
      // silently report a different project's day from the grid behind it.
      INHERITED_SCOPE,
    );
  });
});

describe('DaySummary — inherits the Calendar scope, has none of its own', () => {
  it('passes the page scope through on a project-scoped day, too', async () => {
    mockApi.daySummary.get.mockResolvedValue(populated());
    const PROJECT = 'aaaaaaaa-1111-4111-8111-111111111111';
    await mount({ date: new Date(2026, 6, 15, 20, 0), tz: 'UTC', project: PROJECT });
    await settle();
    const [params, config] = mockApi.daySummary.get.mock.calls.at(-1)!;
    expect((params as { project: string }).project).toBe(PROJECT);
    expect(config).toBe(INHERITED_SCOPE);
  });

  it('renders NO project selector — the selection is the Calendar\'s', async () => {
    mockApi.daySummary.get.mockResolvedValue(populated());
    await mount({ date: new Date(2026, 6, 15), tz: 'UTC', project: 'all' });
    await settle();
    expect(document.body.querySelector('[aria-label="Filter by project"]')).toBeNull();
  });
});

describe('DaySummary — quiet day', () => {
  it('renders the honest low-activity state (not an error, not the ribbon)', async () => {
    mockApi.daySummary.get.mockResolvedValue(quiet());
    await mount({ date: new Date(2026, 6, 15, 10, 0), tz: 'UTC' });
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain('A quiet day');
    expect(text).not.toContain('when the work happened'); // ribbon section omitted
    expect(document.body.querySelector('[role="alert"]')).toBeNull(); // NOT an error
  });
});

describe('DaySummary — loading + error', () => {
  it('shows a spinner while the day query is in flight', async () => {
    mockApi.daySummary.get.mockImplementation(() => new Promise(() => {}));
    await mount({ date: new Date(2026, 6, 15, 10, 0), tz: 'UTC' });
    expect(document.body.querySelector('[role="status"]')).not.toBeNull();
  });

  it('surfaces an honest Alert when the day query fails', async () => {
    mockApi.daySummary.get.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount({ date: new Date(2026, 6, 15, 10, 0), tz: 'UTC' });
    await settle();
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent ?? '').toContain('backend down');
  });
});

describe('DaySummary — PNG export wiring', () => {
  it('renders the card to a PNG named for the day when Export is clicked', async () => {
    mockApi.daySummary.get.mockResolvedValue(populated());
    await mount({ date: new Date(2026, 6, 15, 14, 0), tz: 'America/New_York' });
    await settle();

    const exportBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Export PNG'),
    );
    expect(exportBtn).toBeTruthy();

    await act(async () => {
      exportBtn!.click();
      await Promise.resolve();
    });
    await settle();

    expect(mockDownload).toHaveBeenCalledTimes(1);
    const [node, filename] = mockDownload.mock.calls[0];
    expect(node).toBeInstanceOf(HTMLElement);
    expect(filename).toContain('2026-07-15');
    expect(filename.endsWith('.png')).toBe(true);
  });
});
