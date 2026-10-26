/**
 * Analytics render tests (P3 pivot-surface rebuild) — mirrors the Decisions test style:
 * createRoot + async act into jsdom, behind QueryClientProvider, with the UNIFIED `api`
 * client mocked. Proves the required states (data / loading / empty / error), the KPI totals
 * DERIVED from the one live trends series, the metric toggle, the LIVE work-mix legend, the
 * BUILT productive + token-rhythm panels, and — critically — the LIVE by-actor panel with
 * its coverage line (bars + coverage from ONE payload, in ONE unit). Structural wiring
 * (no antd, unified client, reuse charts, no hex) is in Analytics.wiring.test.ts.
 *
 * ── PLUS, SINCE an earlier epic, THE PAGE'S OWN PROJECT SCOPE ──────────────────────────
 * Analytics used to open on `null` — every project — and pass that scope to its four
 * reads. It now opens on the user's DEFAULT project, keeps `?project=` in the URL as the
 * source of truth, and scopes ALL FOUR reads explicitly. Four is the number that matters:
 * a page with one scoped read and the rest ambient shows panels that disagree, and every
 * one of them looks plausible on its own. So the scope assertions below sweep the hooks
 * as a SET rather than checking a representative one.
 *
 * The ambient project in localStorage is deliberately a DIFFERENT project from the one the
 * page shows, and the assertions read the header the request would actually carry after
 * the real axios interceptor — so "named nothing" and "named the ambient default" are both
 * visible failures rather than silent passes.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    sessions: {
      trends: vi.fn(),
      productive: vi.fn(),
      tokenPatterns: vi.fn(),
      contextsByActor: vi.fn(),
    },
    tasks: { stats: vi.fn(), leadTime: vi.fn() },
  },
}));

/** The project the page shows. */
const PROJECT_A = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'riverbend' };
/** The user's DEFAULT project, and the ambient header. */
const PROJECT_B = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'daisy' };

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

import Analytics from './Analytics';
import { api } from '../api';
import { apiConfig } from '../config/apiConfig';
import { PROJECT_URL_PARAM } from '../hooks/usePageProject';
import { TASK_RATES, SESSION_RHYTHM } from './analytics/config';
import { currentHourInZone, hourLabel, rhythmRows } from './analytics/SessionRhythm';
import { getBrowserTimeZone } from '../utils/browserTimeZone';

const mockApi = api as unknown as {
  sessions: {
    trends: ReturnType<typeof vi.fn>;
    productive: ReturnType<typeof vi.fn>;
    tokenPatterns: ReturnType<typeof vi.fn>;
    contextsByActor: ReturnType<typeof vi.fn>;
  };
  tasks: { stats: ReturnType<typeof vi.fn>; leadTime: ReturnType<typeof vi.fn> };
};

/**
 * EVERY SCOPED READ THE PAGE MAKES, named so the sweep below cannot quietly shrink. Each
 * entry is (label, the mock, the params key that carries the project). A read added to
 * this page and not added here would go unswept — so this list is not trusted: the
 * `covers every scoped read` case below derives the true set from analytics/hooks.ts and
 * asserts it against this one. No count is written here on purpose; that derivation is
 * what states the population.
 */
const SCOPED_READS = [
  { label: 'sessions.trends', mock: () => mockApi.sessions.trends, key: 'projectId' },
  { label: 'tasks.stats', mock: () => mockApi.tasks.stats, key: 'project_id' },
  { label: 'tasks.leadTime', mock: () => mockApi.tasks.leadTime, key: 'project_id' },
  { label: 'sessions.productive', mock: () => mockApi.sessions.productive, key: 'projectId' },
  { label: 'sessions.tokenPatterns', mock: () => mockApi.sessions.tokenPatterns, key: 'projectId' },
  { label: 'sessions.contextsByActor', mock: () => mockApi.sessions.contextsByActor, key: 'projectId' },
] as const;

/** The `X-Project-ID` a config would ACTUALLY send, after the real request interceptor. */
async function headerOnTheWire(config: unknown): Promise<unknown> {
  const { apiClient } = await import('../services/api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = (apiClient as any).instance ?? (apiClient as any)._instance;
  const handlers = instance.interceptors.request.handlers.filter(Boolean);
  const cfg = (config ?? {}) as Record<string, unknown>;
  let out = { ...cfg, headers: { ...((cfg.headers as object) ?? {}) }, url: '/x', method: 'get' };
  for (const h of handlers) {
    // eslint-disable-next-line no-await-in-loop
    out = await h.fulfilled(out);
  }
  return (out.headers as Record<string, unknown>)[apiConfig.projectHeader];
}

/**
 * Every counter is a DIFFERENT window sum, so a tile reading the wrong `trendKey` cannot
 * accidentally print the right number. `total_tasks_completed` (7+11+13 = 31) is
 * deliberately unequal to `total_tasks_created` (2+3+4 = 9): the two task metrics sit
 * side by side in the strip and are the pair most likely to be crossed.
 */
const TRENDS = [
  { date: '2026-07-01', session_count: 1, total_tokens_used: 1000, total_contexts: 10, total_tasks_created: 2, total_tasks_completed: 7 },
  { date: '2026-07-02', session_count: 2, total_tokens_used: 2000, total_contexts: 20, total_tasks_created: 3, total_tasks_completed: 11 },
  { date: '2026-07-03', session_count: 3, total_tokens_used: 3000, total_contexts: 30, total_tasks_created: 4, total_tasks_completed: 13 },
];

/**
 * The windowed cohort. `total` (565) is DELIBERATELY larger than the sum of the four
 * WORK_MIX statuses (525), by the 40 `cancelled` rows — because that is the shape prod
 * has (416 vs 376 over 30d) and it is the ONLY shape that can tell the two apart. A
 * fixture with no cancelled tasks makes `total` and the bar's sum the same number, and a
 * created-rate wired to the wrong one of them then renders identically. Measured: with
 * `cancelled` absent from this fixture, the mutation "read `total` instead of the bar's
 * sum" left every test in this file GREEN.
 */
const TASK_STATS = {
  total: 565,
  by_status: { completed: 399, in_progress: 5, blocked: 2, todo: 119, cancelled: 40 },
};

/**
 * The Work-mix FLOW block's read. `totalTasks` is the count of tasks whose
 * `completed_at` fell in the window — DELIBERATELY not equal to `TASK_STATS.by_status
 * .completed` (399), because the two are different populations and a fixture that made
 * them equal could not tell a panel that reads the right one from a panel that reads the
 * cohort figure and calls it a completion rate.
 */
const TASK_LEAD_TIME = {
  distribution: [],
  stats: { totalTasks: 420, averageLeadTime: 2.9, medianLeadTime: 0.5, p90LeadTime: 9.1 },
};

/**
 * Most-active-sessions fixture. Two DIFFERENT actors of two different kinds, because the
 * defect this panel carried was a who-column that printed the same string on every row —
 * a fixture whose rows share a "who" cannot tell a fixed panel from the broken one. One
 * row deliberately carries NO actor: `null` is the population that renders as the
 * fallback, and 4 of prod's 142 most recent sessions are in it.
 */
const PRODUCTIVE = [
  { id: '72aef00d-1111-2222-3333-444444444444', project_id: 'p1', project_name: 'riverbend', actor: 'coordinator-alert-sink', actor_kind: 'automation' as const, created_at: '2026-07-03', duration_minutes: 90, context_count: 40, tokens_used: 12000 }, // reserved-port-ok: token-count fixture, not a port
  { id: '0b7cdc5b-1111-2222-3333-444444444444', project_id: 'p2', project_name: 'daisy', actor: null, actor_kind: null, created_at: '2026-07-02', duration_minutes: 60, context_count: 22, tokens_used: 8000 },
];

/**
 * By-actor fixture. PARTIAL coverage on purpose — 8 of 10 contexts attributed — because
 * the partial case is the one where the bars and the coverage line can silently disagree.
 * The counts are shaped like prod's (a dominant actor, a tail), not round numbers.
 */
const BY_ACTOR = {
  actors: [
    { actor: 'coordinator-alert-sink', context_count: 4, kind: 'automation' as const },
    { actor: 'tick', context_count: 3, kind: 'automation' as const },
    { actor: 'coordinator', context_count: 1, kind: 'agent' as const },
  ],
  attributed_contexts: 8,
  unattributed_contexts: 2,
  total_contexts: 10,
  user_driven_contexts: 1,
  automated_contexts: 7,
  unknown_kind_contexts: 0,
  days: 30,
};

const TOKEN_PATTERNS = Array.from({ length: 24 }, (_, h) => ({
  hour: h,
  total_tokens: h * 100,
  session_count: h % 3,
  average_tokens_per_session: 100,
}));

/**
 * The UNWINDOWED `/api/tasks/stats` — what "Open now" reads. Its open
 * counts are DELIBERATELY larger than the 30d cohort's (323 vs 126): open work is a
 * property of the board, not of a window, and a fixture where the two agreed could not
 * tell a panel reading the unwindowed payload from one reading the windowed one.
 */
const ALL_TIME_TASK_STATS = {
  total: 3095,
  by_status: { completed: 2772, in_progress: 9, blocked: 14, todo: 300 },
};

function setHappy() {
  mockApi.sessions.trends.mockResolvedValue(TRENDS);
  // Keyed on the RANGE, because the page makes two calls to this one endpoint with
  // different windows and they must not be answered with the same payload.
  mockApi.tasks.stats.mockImplementation((params?: Record<string, unknown>) =>
    Promise.resolve(params?.range === 'all' ? ALL_TIME_TASK_STATS : TASK_STATS),
  );
  mockApi.tasks.leadTime.mockResolvedValue(TASK_LEAD_TIME);
  mockApi.sessions.productive.mockResolvedValue(PRODUCTIVE);
  mockApi.sessions.tokenPatterns.mockResolvedValue(TOKEN_PATTERNS);
  mockApi.sessions.contextsByActor.mockResolvedValue(BY_ACTOR);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount(initialUrl = '/analytics') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialUrl]}>
          <Analytics />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  settings.defaultProjectId = PROJECT_B.id;
  // THE AMBIENT SCOPE IS B, DELIBERATELY — see the header.
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id: PROJECT_B.id }));
  localStorage.setItem('aidis_current_project', JSON.stringify({ id: PROJECT_B.id }));
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Analytics — data state', () => {
  it('derives the KPI totals from the one live trends series', async () => {
    await mount();
    await settle();
    const tasksCompleted =
      container.querySelector('[data-metric="tasksCompleted"]')?.textContent ?? '';
    const contexts = container.querySelector('[data-metric="contexts"]')?.textContent ?? '';
    const sessions = container.querySelector('[data-metric="sessions"]')?.textContent ?? '';
    const tasks = container.querySelector('[data-metric="tasks"]')?.textContent ?? '';
    expect(tasksCompleted).toContain('31'); // 7+11+13
    expect(contexts).toContain('60'); // 10+20+30
    expect(sessions).toContain('6'); // 1+2+3
    expect(tasks).toContain('9'); // 2+3+4
    // The deleted metric leaves no tile behind — asserted on the tile's
    // own data-metric key AND on the label, because either alone could survive a partial
    // removal (a renamed label over the old trendKey, or the old label over a new key).
    expect(container.querySelector('[data-metric="tokens"]')).toBeNull();
    expect(container.textContent).not.toContain('MCP payload');
    // The KPI + hero both name the live trends source.
    expect(container.textContent).toContain('/api/sessions/trends');
    expect(container.textContent).toContain('Activity over time');
  });

  it('renders the LIVE work-mix legend from task stats (real counts)', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Work mix — tasks');
    expect(text).toContain('Done');
    expect(text).toContain('399');
    expect(text).toContain('To do');
    expect(text).toContain('119');
    expect(text).toContain('/api/tasks/stats');
  });

  it('renders the most-active-sessions + rhythm panels', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // Renamed with the metric it actually ranks by (item 3c).
    expect(text).toContain('Most active sessions');
    expect(text).not.toContain('Most productive sessions');
    expect(text).toContain('By contexts created, last 30 days');
    // The WHO is the actor, and a session without one says so rather than borrowing the
    // project name — which on a project-scoped page was the same string on every row.
    expect(text).toContain('coordinator-alert-sink');
    expect(text).toContain('unattributed');
    expect(text).toContain('40'); // the top row's CONTEXT COUNT, which is what it ranks on
    expect(text).toContain('/api/sessions/productive');
    expect(text).toContain('Sessions started — by hour');
    // The token framing is RETIRED, not renamed around: a start-time histogram must not
    // carry a token label anywhere on the panel (addition 4).
    expect(text).not.toContain('Token rhythm');
    expect(text).toContain('/api/sessions/token-patterns');
  });
});

/**
 * ── THE ACTOR PANEL IS LIVE NOW ────────────────────────────────────────
 * This block used to assert the honest-empty placeholder. The gap it described is closed,
 * so what is asserted instead is the property that replaces it: the bars and the coverage
 * sentence are drawn from ONE payload, in ONE unit, and the zero-attribution case reads as
 * an onboarding prompt rather than "no data".
 *
 * jsdom has no layout, so NOTHING here proves the bars are legible — that is proved by
 * browser screenshots (reports/artifacts/actor-bars-<id>/). These assert the TEXT.
 */
describe('Analytics — the actor panel is live, and states its own coverage', () => {
  it('names the real endpoint and draws a bar per attributed actor', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Activity by actor');
    expect(text).toContain('/api/sessions/contexts-by-actor');
    expect(text).not.toContain('Not yet available');
  });

  it('prints coverage in the SAME UNIT as the bars (contexts, never sessions)', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // 1 user-driven + 7 automated = 8 CLASSIFIED, of 10 total. The numerator is what the
    // BARS can account for, so an actor the registry does not know is in the remainder
    // alongside the two with no actor at all.
    expect(text).toContain('8 of 10 contexts');
    expect(text).toContain('80%');
    // The unit is the thing that must not drift. A coverage line counted in sessions
    // while the bars count contexts is individually true and jointly false.
    expect(text).not.toMatch(/of \d+ sessions attributed/);
  });

  it('ZERO ATTRIBUTED reads as an onboarding prompt, not an error or "no data"', async () => {
    mockApi.sessions.contextsByActor.mockResolvedValue({
      actors: [],
      attributed_contexts: 0,
      unattributed_contexts: 3013,
      total_contexts: 3013,
      user_driven_contexts: 0,
      automated_contexts: 0,
      unknown_kind_contexts: 0,
      days: 30,
    });
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('No known actor recorded on 3,013 contexts yet');
    expect(text).toContain('X-Actor-ID');
    // The records exist. Saying otherwise is the specific lie this design removes.
    expect(text).not.toContain('No contexts in this window');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('SPLITS the bars into user-driven and automated, each with its own subtotal', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('User-driven');
    expect(text).toContain('Automated');
    // The subtotals are the split the server computed, printed in the SAME unit as the
    // bars. `coordinator` is an agent (user-driven, 1); `tick` + `coordinator-alert-sink` are
    // automation (7). A group whose header disagreed with its bars would be the same
    // class of lie the coverage line exists to remove.
    expect(text).toContain('1 context ·');
    expect(text).toContain('7 contexts ·');
  });

  it('an EMPTY group is STATED, not hidden (a window with no automation is a real reading)', async () => {
    mockApi.sessions.contextsByActor.mockResolvedValue({
      actors: [{ actor: 'operator', context_count: 5, kind: 'human' as const }],
      attributed_contexts: 5,
      unattributed_contexts: 0,
      total_contexts: 5,
      user_driven_contexts: 5,
      automated_contexts: 0,
      unknown_kind_contexts: 0,
      days: 30,
    });
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('No automated actors in this window.');
  });

  /*
   * The "Other (N actors)" roll-up is NOT asserted here. Its label is an SVG axis TICK,
   * and jsdom gives ResponsiveContainer a 0x0 box, so recharts renders no axis at all —
   * an assertion on it passes or fails for reasons that have nothing to do with the
   * roll-up. The arithmetic is asserted as a pure function in analytics/actorBars.test.ts,
   * and the rendered bars are proved by browser screenshots (same split as an earlier task,
   * which deleted exactly this kind of jsdom tick assertion after it went green with the
   * fix reverted).
   */
});

describe('Analytics — metric toggle', () => {
  it('switches the hero metric (segmented tab selection follows the click)', async () => {
    await mount();
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    const completedTab = tabs.find(
      (b) => (b.textContent ?? '').trim() === 'Tasks completed',
    ) as HTMLElement | undefined;
    expect(completedTab).toBeTruthy();
    // The removed metric is not an option any more.
    expect(tabs.some((b) => (b.textContent ?? '').trim() === 'MCP payload (est.)')).toBe(false);
    await act(async () => {
      completedTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    const nowSelected = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (b) =>
        b.getAttribute('aria-selected') === 'true' &&
        (b.textContent ?? '').trim() === 'Tasks completed',
    );
    expect(nowSelected).toBeTruthy();
  });
});

describe('Analytics — provenance', () => {
  it('names each panel’s endpoint and carries NO data-source legend', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // What survived the vocabulary's deletion: the request each panel makes.
    expect(text).toContain('/api/sessions/trends');
    expect(text).toContain('/api/tasks/stats');
    expect(text).toContain('/api/sessions/productive');
    expect(text).toContain('/api/sessions/contexts-by-actor');
    // What did not. Every one of these strings told a viewer something about this page
    // that was false by the time it rendered (item 2).
    expect(text).not.toContain('Data sources');
    expect(text).not.toContain('Live-wired today');
    expect(text).not.toContain('Built, unused');
    expect(text).not.toContain('endpoint exists, just turn it on');
    expect(text).not.toContain('Needs 1 small add');
    expect(text).not.toContain('serialize actor on read');
  });
});

describe('Analytics — loading state', () => {
  it('shows loading chrome while the reads are in flight', async () => {
    mockApi.sessions.trends.mockImplementation(() => new Promise(() => {}));
    mockApi.tasks.stats.mockImplementation(() => new Promise(() => {}));
    mockApi.sessions.productive.mockImplementation(() => new Promise(() => {}));
    mockApi.sessions.tokenPatterns.mockImplementation(() => new Promise(() => {}));
    mockApi.sessions.contextsByActor.mockImplementation(() => new Promise(() => {}));
    await mount();
    await settle();
    // Hero AreaChartCard loading → ChartFrame Spinner (role=status).
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

/**
 * THE WORK-MIX FLOW BLOCK.
 *
 * The whole design risk here is a POPULATION MISMATCH: the bar above these figures is a
 * cohort (tasks CREATED in the window, by where they stand now) and the completed rate is
 * not (tasks that FINISHED in the window, whenever they were filed). The fixtures are
 * chosen so the two CANNOT be confused — `TASK_STATS.by_status.completed` is 399 while
 * `TASK_LEAD_TIME.stats.totalTasks` is 420 — so a panel that read the cohort's Done and
 * called it a completion rate renders a different number and fails here.
 */
describe('Analytics — Work mix flow rates', () => {
  it('COMPLETED/day comes from completed-in-window, NOT from the cohort Done', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // 420 completions / 30d = 14.0. The cohort's Done is 399, which would render 13.3.
    expect(text).toContain('14.0');
    expect(text).not.toContain('13.3');
    // And it says which population it counted, next to the number.
    expect(text).toContain('420 finished in 30d, whenever filed');
  });

  it('CREATED/day is the BAR\'s own total — cancelled excluded, and labelled so', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // 399 + 5 + 2 + 119 = 525 (the four WORK_MIX statuses); 525 / 30 = 17.5. The payload's
    // `total` is 565 — it counts the 40 cancelled rows the bar omits — and would render
    // 18.8. That is the cancelled decision, asserted rather than described.
    expect(text).toContain('17.5');
    expect(text).not.toContain('18.8');
    expect(text).toContain('525 filed in 30d, excl. cancelled');
  });

  it('NET/day carries its sign and says which way the backlog is moving', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // 17.5 created - 14.0 completed = +3.5.
    expect(text).toContain('+3.5');
    expect(text).toContain('backlog growing');
  });

  it('OPEN NOW reads the UNWINDOWED stats and says it is not the window', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // The board's open work is 9 + 14 + 300 = 323. The 30d cohort's open is 5 + 2 + 119 =
    // 126 — the number a panel reading the windowed payload would print under "now".
    expect(text).toContain('323');
    expect(text).not.toContain('126');
    expect(text).toContain('right now — not this window');
  });

  it('states the population difference IN WORDS, not just by layout', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Flow — per day over the last 30 days');
    expect(text).toContain(TASK_RATES.footnote);
  });

  it('the median is labelled with the window it was taken over', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('0.5d');
    expect(text).toContain('of the 420 completed in 30d');
  });

  it('EVERY figure is window-scoped: moving the range re-requests with the new window',
    async () => {
      await mount();
      await settle();
      mockApi.tasks.leadTime.mockClear();
      const sevenDay = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === '7d',
      );
      expect(sevenDay, 'the 7d range button').toBeDefined();
      await act(async () => {
        sevenDay!.click();
      });
      await settle();
      const [params] = mockApi.tasks.leadTime.mock.calls[
        mockApi.tasks.leadTime.mock.calls.length - 1
      ];
      expect((params as Record<string, unknown>).range).toBe('7d');
      // And the labels follow the window rather than staying pinned at 30.
      expect(container.textContent).toContain('Flow — per day over the last 7 days');
    });

  it('a FAILED flow read is stated, and does not take the cohort bar down with it', async () => {
    mockApi.tasks.leadTime.mockRejectedValue(new Error('backend down'));
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain("Couldn't load task flow rates");
    // The bar is a different read and is still good; blanking it would be the lie.
    expect(text).toContain('In progress');
    expect(text).not.toContain('14.0');
  });
});

/**
 * THE CURRENT-HOUR MARK on Sessions started — by hour. The tint itself is
 * an SVG fill that jsdom will report but that says nothing on its own; what is asserted
 * here is that the mark is EXPLAINED — a colour with no key is the thing the operator would have
 * to ask about, which is the problem this was meant to solve.
 */
describe('Analytics — the rhythm chart marks the current hour', () => {
  it('carries a legend that names the tint AND says it is partial', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain(SESSION_RHYTHM.currentHourLegend);
    expect(SESSION_RHYTHM.currentHourLegend).toMatch(/partial/i);
  });

  it('the hour it marks is the CURRENT one in the request\'s own zone', async () => {
    await mount();
    await settle();
    // WHAT THIS CAN AND CANNOT SEE. recharts is wrapped in a ResponsiveContainer, which
    // measures 0x0 under jsdom and therefore draws NO bars at all (see charts/parts.tsx) —
    // so the painted fill is not assertable here and is verified in a real browser
    // instead. What IS assertable is that the bucket the panel would mark is a bucket the
    // chart actually has, and that it was chosen from the SAME tz expression the request
    // sends. The one-and-only-one property is proved on `rhythmRows` in taskRates.test.ts.
    const expected = hourLabel(currentHourInZone(getBrowserTimeZone()));
    expect(TOKEN_PATTERNS.map((p) => hourLabel(p.hour))).toContain(expected);
    const rows = rhythmRows(TOKEN_PATTERNS, expected, 'X');
    expect(rows.filter((r) => r.color !== undefined).map((r) => r.hour)).toEqual([expected]);
  });
});

describe('Analytics — empty state', () => {
  it('shows an honest empty work-mix when there are no tasks', async () => {
    mockApi.tasks.stats.mockResolvedValue({ total: 0, by_status: {} });
    await mount();
    await settle();
    expect(container.textContent).toContain('No tasks');
  });
});

describe('Analytics — error state', () => {
  it('surfaces the trends failure on the KPI strip + hero', async () => {
    mockApi.sessions.trends.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn't load activity trends");
    // KPI tiles fall back to a dash rather than a fabricated zero-total.
    const tasksCompleted =
      container.querySelector('[data-metric="tasksCompleted"]')?.textContent ?? '';
    expect(tasksCompleted).toContain('—');
  });
});

describe('Analytics — project scope (an earlier epic §E)', () => {
  it('opens on the USER DEFAULT project, not "every project"', async () => {
    await mount();
    await settle();
    for (const read of SCOPED_READS) {
      const calls = read.mock().mock.calls;
      expect(calls.length, `${read.label} should have been called`).toBeGreaterThan(0);
      const [params, config] = calls[calls.length - 1];
      expect((params as Record<string, unknown>)[read.key], read.label).toBe(PROJECT_B.id);
      // eslint-disable-next-line no-await-in-loop
      expect(await headerOnTheWire(config), read.label).toBe(PROJECT_B.id);
    }
  });

  it('ALL FOUR reads name the page project — not one of them, all of them', async () => {
    await mount(`/analytics?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    await settle();
    for (const read of SCOPED_READS) {
      const calls = read.mock().mock.calls;
      expect(calls.length, `${read.label} should have been called`).toBeGreaterThan(0);
      const [params, config] = calls[calls.length - 1];
      expect((params as Record<string, unknown>)[read.key], read.label).toBe(PROJECT_A.id);
      // eslint-disable-next-line no-await-in-loop
      const sent = await headerOnTheWire(config);
      expect(sent, read.label).toBe(PROJECT_A.id);
      expect(sent, `${read.label} must not carry the ambient default`).not.toBe(PROJECT_B.id);
      expect(sent, `${read.label} must not be unscoped`).toBeDefined();
    }
  });

  it('the sweep above covers every scoped read the page actually has', async () => {
    // The guard's own POPULATION, stated next to the enumeration (C3). SCOPED_READS is a
    // hand-written list, so it is derived-checked against the page source: every
    // `api.<domain>.<method>(` in analytics/hooks.ts must appear in it. A fifth read added
    // to the page without being added here fails HERE rather than going unguarded.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const hooks = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'analytics/hooks.ts'),
      'utf8',
    );
    const called = new Set(
      Array.from(hooks.matchAll(/\bapi\.(\w+)\.(\w+)\(/g)).map((m) => `${m[1]}.${m[2]}`),
    );
    expect([...called].sort()).toEqual([...SCOPED_READS.map((r) => r.label)].sort());
  });

  it('MUTATION — without the page scope the same requests carry the ambient default', async () => {
    // Proof the assertions above are earned: the interceptor really would have supplied B.
    await mount(`/analytics?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    await settle();
    expect(await headerOnTheWire({})).toBe(PROJECT_B.id);
  });

  it("a ?project=all deep link is IGNORED — every read names the default, never 'all' (F2)", async () => {
    await mount(`/analytics?${PROJECT_URL_PARAM}=all`);
    await settle();
    for (const read of SCOPED_READS) {
      const calls = read.mock().mock.calls;
      const [params, config] = calls[calls.length - 1];
      expect((params as Record<string, unknown>)[read.key], read.label).toBe(PROJECT_B.id);
      // eslint-disable-next-line no-await-in-loop
      expect(await headerOnTheWire(config), read.label).toBe(PROJECT_B.id);
    }
  });
});
