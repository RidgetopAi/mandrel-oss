/**
 * Calendar render tests — mirrors the Dashboard/Sessions test style: createRoot +
 * async act into jsdom, behind QueryClientProvider + MemoryRouter, with the UNIFIED
 * `api` client mocked. Proves the reworked shell: Month (default) / Week / Day views
 * + a view switcher, view-aware nav, the day-summary click boundary, the four states
 * (data / loading / empty / error), and that the old Unscheduled backlog rail is GONE.
 * Structural wiring (no antd, unified client, no hex) is in Calendar.wiring.test.ts.
 *
 * The Calendar's `'all'`-on-the-wire contract — the thing this page is most able to break
 * invisibly — has its own file: `Calendar.allContract.test.tsx`, with the backend half in
 * `backend/src/__tests__/calendarUnscopedContract.db.test.ts`.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    momentumSeries: { get: vi.fn() },
    tasks: { list: vi.fn() },
    daySummary: { get: vi.fn() },
  },
}));

const DEFAULT_PROJECT = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'daisy' };
const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));
vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined,
    allProjects: [
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'riverbend' },
      { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'daisy' },
    ],
    loading: false,
  }),
}));
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: settings.defaultProjectId }),
}));

import Calendar from './Calendar';
import { api } from '../api';
import {
  startOfWeek,
  toDateKey,
  formatWeekRange,
  formatMonthLabel,
  formatDayLabel,
  addMonths,
} from './calendar/dates';
import { CALENDAR_CONFIG } from './calendar/config';

const mockApi = api as unknown as {
  momentumSeries: { get: ReturnType<typeof vi.fn> };
  tasks: { list: ReturnType<typeof vi.fn> };
  daySummary: { get: ReturnType<typeof vi.fn> };
};

/**
 * A minimal quiet-day payload so the real <DaySummary/> (which replaced the old
 * placeholder stub) renders its card when a day cell is clicked.
 * The shell test only needs the click BOUNDARY to open the card; the card's own
 * rendering is covered by pages/calendar/DaySummary.test.tsx.
 */
const kpi0 = { value: 0, delta: 0 };
const QUIET_SUMMARY = {
  date: '2026-01-01', // unused by the card header (which reads the `date` prop)
  tz: 'UTC',
  project: 'all',
  headline: null,
  momentum: { score: 50, delta: 0, breakdown: { output: 0, followThrough: 0, depth: 0 } },
  kpis: {
    sessions: kpi0,
    activeMinutes: kpi0,
    contexts: kpi0,
    decisions: kpi0,
    tasksDone: kpi0,
    filesTouched: kpi0,
  },
  ribbon: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
  highlights: [],
  decisions: [],
  tasksCompleted: { count: 0, items: [] },
  byActor: [],
};

const NOW = new Date();
const TODAY_KEY = toDateKey(NOW);
const WEEK_START = startOfWeek(NOW, CALENDAR_CONFIG.weekStartsOn);

const MOMENTUM_POINTS = [
  {
    date: TODAY_KEY,
    momentum: { score: 83, delta: 18 },
    sessions: 3,
    contexts: 12,
    tasks: 4,
    hasData: true,
  },
];

const SCHEDULED_TASK = {
  id: 'task-sched-0001',
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  project_id: 'p-coordinator',
  title: 'Ship the calendar screen',
  type: 'feature',
  status: 'in_progress',
  priority: 'high',
  due_date: TODAY_KEY,
};
// A task with NO due_date — under the OLD design this was the "Unscheduled" backlog;
// the rail is deleted, so it must NOT render anywhere now.
const UNSCHEDULED_TASK = {
  id: 'task-backlog-0002',
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  project_id: 'p-coordinator',
  title: 'Serialize actor on read',
  type: 'feature',
  status: 'pending',
  priority: 'medium',
};

function setHappy() {
  mockApi.momentumSeries.get.mockResolvedValue(MOMENTUM_POINTS);
  mockApi.tasks.list.mockResolvedValue({ tasks: [SCHEDULED_TASK, UNSCHEDULED_TASK], total: 2 });
  mockApi.daySummary.get.mockResolvedValue(QUIET_SUMMARY);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Calendar />
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

function clickViewButton(label: 'Month' | 'Week' | 'Day') {
  const btn = Array.from(
    container.querySelectorAll('[role="group"][aria-label="Calendar view"] button'),
  ).find((b) => (b.textContent ?? '').trim() === label) as HTMLButtonElement;
  return act(async () => {
    btn.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  settings.defaultProjectId = DEFAULT_PROJECT.id;
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  // The DaySummary renders through a portal to document.body — clear any leftovers.
  document.body.innerHTML = '';
});

describe('Calendar — Month view (default)', () => {
  it('defaults to Month: renders the month label, weekday header, and a 42-cell grid', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Calendar');
    expect(text).toContain(formatMonthLabel(NOW));
    // Weekday header row.
    expect(text).toContain('Sun');
    // Month is the pressed view.
    const pressed = container.querySelector('button[aria-pressed="true"]') as HTMLButtonElement;
    expect(pressed.textContent).toBe('Month');
    // 42 clickable day cells.
    const cells = container.querySelectorAll('button[aria-label^="Open day summary for"]');
    expect(cells.length).toBe(42);
    // The due-dated task shows as a per-day task count on its cell.
    expect(text).toContain('1 task');
  });
});

describe('Calendar — backlog rail is GONE', () => {
  it('renders no Unscheduled rail and never surfaces an un-due-dated task', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).not.toContain('Unscheduled');
    expect(text).not.toContain('Serialize actor on read');
  });
});

describe('Calendar — Week view', () => {
  it('switches to the week grid with the week range + activity-by-date summary', async () => {
    await mount();
    await settle();
    await clickViewButton('Week');
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain(formatWeekRange(WEEK_START));
    // Today's cell renders the momentum score + the sessions·contexts counts.
    expect(text).toContain('83');
    expect(text).toContain('3s·12c');
    // Scheduled task appears as a card (title) in the week grid.
    expect(text).toContain('Ship the calendar screen');
  });
});

describe('Calendar — Day view', () => {
  it('switches to a single-day view labelled for today', async () => {
    await mount();
    await settle();
    await clickViewButton('Day');
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain(formatDayLabel(NOW));
    expect(text).toContain('83');
    expect(text).toContain('3s·12c');
  });
});

describe('Calendar — view-aware navigation', () => {
  it('steps by month in Month view and returns on Today', async () => {
    await mount();
    await settle();
    const next = container.querySelector('button[aria-label="Next month"]') as HTMLButtonElement;
    expect(next).not.toBeNull();
    await act(async () => {
      next.click();
    });
    await settle();
    expect(container.textContent).toContain(formatMonthLabel(addMonths(NOW, 1)));

    const buttons = Array.from(container.querySelectorAll('button'));
    const todayBtn = buttons.find((b) => (b.textContent ?? '').trim() === 'Today') as HTMLButtonElement;
    await act(async () => {
      todayBtn.click();
    });
    await settle();
    expect(container.textContent).toContain(formatMonthLabel(NOW));
  });
});

describe('Calendar — day-summary click boundary', () => {
  it('opens the DaySummary report card when a day cell is clicked', async () => {
    await mount();
    await settle();
    const cell = container.querySelector(
      `button[aria-label^="Open day summary for ${TODAY_KEY}"]`,
    ) as HTMLButtonElement;
    expect(cell).not.toBeNull();
    await act(async () => {
      cell.click();
    });
    await settle();
    // The real DaySummary renders as a modal overlay via a PORTAL to
    // document.body — assert the dialog opened for the clicked day, not the container.
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-label')).toContain('Day summary for');
    expect(document.body.textContent).toContain('Day Summary');
  });
});

describe('Calendar — loading state', () => {
  it('shows a spinner while the queries are in flight', async () => {
    mockApi.momentumSeries.get.mockImplementation(() => new Promise(() => {}));
    mockApi.tasks.list.mockImplementation(() => new Promise(() => {}));
    await mount();
    await settle();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Calendar — empty state', () => {
  it('still renders the month grid (no honest-empty panel) when there is no data', async () => {
    mockApi.momentumSeries.get.mockResolvedValue([]);
    mockApi.tasks.list.mockResolvedValue({ tasks: [], total: 0 });
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain(formatMonthLabel(NOW));
    const cells = container.querySelectorAll('button[aria-label^="Open day summary for"]');
    expect(cells.length).toBe(42);
  });
});

describe('Calendar — error state', () => {
  it('surfaces an Alert when a query fails', async () => {
    mockApi.momentumSeries.get.mockImplementation(() => Promise.reject(new Error("backend down")));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('Calendar — the page opens on the user default, not "all" (epic 41293984 §E)', () => {
  it('both reads name the DEFAULT project on first paint', async () => {
    await mount();
    await settle();
    const [seriesParams] = mockApi.momentumSeries.get.mock.calls.at(-1)!;
    expect((seriesParams as { project: string }).project).toBe(DEFAULT_PROJECT.id);
    // …and specifically NOT the 'all' this page used to open on. That sentinel still
    // works — it is now a CHOICE rather than the default. See Calendar.allContract.test.tsx.
    expect((seriesParams as { project: string }).project).not.toBe('all');

    const [taskParams] = mockApi.tasks.list.mock.calls.at(-1)!;
    expect((taskParams as Record<string, unknown>).project_id).toBe(DEFAULT_PROJECT.id);
  });

  it('the day card INHERITS that selection rather than having its own', async () => {
    await mount();
    await settle();
    const cell = container.querySelector(
      `button[aria-label^="Open day summary for ${TODAY_KEY}"]`,
    ) as HTMLButtonElement;
    await act(async () => cell.click());
    await settle();

    const [summaryParams] = mockApi.daySummary.get.mock.calls.at(-1)!;
    expect((summaryParams as { project: string }).project).toBe(DEFAULT_PROJECT.id);
    // The card offers no selector of its own — the grid behind it and the card can never
    // disagree about which project they are showing.
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.querySelector('[aria-label="Filter by project"]')).toBeNull();
  });
});
