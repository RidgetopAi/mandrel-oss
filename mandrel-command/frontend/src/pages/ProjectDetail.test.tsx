/**
 * ProjectDetail render tests (P2 project-scoped dashboard rebuild) — mirrors the
 * Contexts/Tasks/Decisions/Projects test style: createRoot + async act into jsdom, behind
 * QueryClientProvider + MemoryRouter (a real /projects/:id Route so useParams resolves),
 * with the UNIFIED `api` client + the ProjectContext mocked. Proves the required states
 * (data / loading / not-found / per-section error), the hero + REAL vital-signs mapping
 * (contexts + sessions from the record; tasks/decisions/commits from insights), the task
 * mini-board, the recent-sessions + recent-decisions sections (real fields + the /r/:id
 * resolve link), the repository-activity substitute, the deep-link read (get called with
 * the route id), the Switch-to-project action, and — critically — the HONEST data-gap
 * disclosures (no fabricated token/actor/live session fields; no invented branch names).
 * Structural wiring (no antd, unified client, no hex) is in ProjectDetail.wiring.test.ts.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const setDefaultProjectId = vi.fn().mockResolvedValue(undefined);
const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));

vi.mock('../api', () => ({
  api: {
    projects: {
      get: vi.fn(),
      insights: vi.fn(),
      sessions: vi.fn(),
    },
    decisions: {
      search: vi.fn(),
    },
  },
}));

vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({
    defaultProjectId: settings.defaultProjectId,
    setDefaultProjectId,
  }),
}));

import ProjectDetail from './ProjectDetail';
import { api } from '../api';

const mockApi = api as unknown as {
  projects: {
    get: ReturnType<typeof vi.fn>;
    insights: ReturnType<typeof vi.fn>;
    sessions: ReturnType<typeof vi.fn>;
  };
  decisions: { search: ReturnType<typeof vi.fn> };
};

const PID = 'aaaaaaaa-1111-2222-3333-444444444444';
const NOW_ISO = new Date().toISOString();

const PROJECT = {
  id: PID,
  name: 'mandrel',
  description: 'The Mandrel dev tree — MCP server, the moat, and the Command UI.',
  status: 'active',
  metadata: { is_primary: true },
  context_count: 1054,
  session_count: 3,
  last_activity: NOW_ISO,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
};

const INSIGHTS = {
  project_id: PID,
  tasks: {
    total: 131,
    completed: 399,
    in_progress: 5,
    todo: 18,
    blocked: 2,
    cancelled: 0,
    completion_percentage: 75,
  },
  contexts: { total: 1054 },
  decisions: { total: 88 },
  git_activity: {
    total_commits: 640,
    total_insertions: 12045,
    total_deletions: 3187,
    files_changed: 512,
    latest_commit_date: NOW_ISO,
    latest_commit_message: 'feat(command/ui): P2 Projects portfolio rebuild\n\nbody line',
  },
  generated_at: NOW_ISO,
};

const SESSIONS = [
  {
    id: 'ssss1111-1111-2222-3333-444444444444',
    project_id: PID,
    context_count: 42,
    created_at: NOW_ISO,
    last_context_at: NOW_ISO,
    session_type: 'context-based',
  },
  {
    id: 'ssss2222-1111-2222-3333-444444444444',
    project_id: PID,
    context_count: 7,
    created_at: NOW_ISO,
    last_context_at: NOW_ISO,
    session_type: 'context-based',
  },
];

const DECISIONS = [
  {
    id: 'dddd3f55-1111-2222-3333-444444444444',
    project_id: PID,
    title: 'Command redesign — visual design language LOCKED',
    decision_type: 'ui_ux',
    created_at: NOW_ISO,
  },
];

function setHappy() {
  mockApi.projects.get.mockResolvedValue(PROJECT);
  mockApi.projects.insights.mockResolvedValue(INSIGHTS);
  mockApi.projects.sessions.mockResolvedValue(SESSIONS);
  mockApi.decisions.search.mockResolvedValue({ decisions: DECISIONS, total: DECISIONS.length });
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
        <MemoryRouter initialEntries={[`/projects/${PID}`]}>
          <Routes>
            <Route path="/projects/:id" element={<ProjectDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function clickText(label: string) {
  const el = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim().startsWith(label),
  );
  if (!el) throw new Error(`button "${label}" not found`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ProjectDetail — hero + vital signs from real data', () => {
  it('renders the hero (name, active status, description) + reads the route id', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('mandrel');
    expect(text).toContain('active');
    expect(text).toContain('The Mandrel dev tree');
    // deep-link: get() called with the /projects/:id route param
    expect(mockApi.projects.get).toHaveBeenCalledWith(PID);
  });

  it('maps the five vital tiles from REAL fields (record + insights)', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('1,054'); // contexts from the record
    expect(text).toContain('131'); // tasks.total from insights
    expect(text).toContain('88'); // decisions.total from insights
    expect(text).toContain('640'); // git_activity.total_commits from insights
    expect(text).toContain('399 / 131 done · 75%'); // the completion caption
  });
});

describe('ProjectDetail — task mini-board (real insights.tasks)', () => {
  it('renders each lane from the real status breakdown', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Todo');
    expect(text).toContain('In progress');
    expect(text).toContain('Blocked');
    expect(text).toContain('Done');
    expect(text).toContain('18'); // todo
    expect(text).toContain('5'); // in progress
  });
});

describe('ProjectDetail — recent sessions (real fields + honest gap)', () => {
  it('renders session rows from real context counts, discloses the token/actor/live gap', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(mockApi.projects.sessions).toHaveBeenCalledWith(PID);
    expect(text).toContain('42 ctx');
    expect(text).toContain('7 ctx');
    // no fabricated token counts or live pulse — the gap is disclosed
    expect(text).toContain('Per-session token counts');
    expect(text).not.toMatch(/\btok\b/);
  });
});

describe('ProjectDetail — recent decisions (real, resolve-linked)', () => {
  it('renders decisions from api.decisions.search with the id8 as a /r/:id link', async () => {
    await mount();
    await settle();
    expect(mockApi.decisions.search).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PID }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('visual design language LOCKED');
    // buildNavHref normalizes the full id (dashes stripped) under the /r base; the
    // visible text is the id8 slice.
    const link = container.querySelector('a[href^="/r/dddd3f55"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect((link?.textContent ?? '').trim()).toBe('dddd3f55');
  });
});

describe('ProjectDetail — repository activity (git substitute for un-served branches)', () => {
  it('renders the real git-activity signal + discloses the branch-telemetry gap, never fake branches', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('churn');
    expect(text).toContain('+12,045 / -3,187'); // insertions / deletions
    expect(text).toContain('P2 Projects portfolio rebuild'); // latest commit subject (first line only)
    expect(text).not.toContain('body line'); // multi-line body collapsed away
    expect(text).toContain('Per-branch git telemetry is not wired yet');
    expect(text).not.toMatch(/active branch/i);
  });
});

describe('ProjectDetail — "Set as my default" action (page-scope epic §C)', () => {
  beforeEach(() => {
    settings.defaultProjectId = undefined;
    setDefaultProjectId.mockClear();
  });

  it('writes the per-user default preference BY ID, not by name', async () => {
    await mount();
    await settle();
    await act(async () => {
      clickText('Set as my default');
    });
    await settle();
    // BY ID. The action it replaced passed a NAME to a global switcher — the two defects
    // this change closes at once (the hidden global, and the rename-breaks-it keying).
    expect(setDefaultProjectId).toHaveBeenCalledWith(PROJECT.id);
  });

  it('shows the project as already-default and does NOT re-write it', async () => {
    settings.defaultProjectId = PROJECT.id;
    await mount();
    await settle();
    await act(async () => {
      clickText('Your default project');
    });
    await settle();
    expect(setDefaultProjectId).not.toHaveBeenCalled();
  });
});

describe('ProjectDetail — Edit drawer', () => {
  it('opens the edit drawer pre-filled from the record', async () => {
    await mount();
    await settle();
    await act(async () => {
      clickText('Edit');
    });
    await settle();
    // Drawer renders in a portal (document.body), not inside `container`.
    const nameInput = document.querySelector('input[aria-label="Project name"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('mandrel');
  });
});

describe('ProjectDetail — loading state', () => {
  it('shows a spinner while the project record is in flight', async () => {
    mockApi.projects.get.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('ProjectDetail — not-found / record error', () => {
  it('surfaces an Alert + a back action when the record read fails', async () => {
    mockApi.projects.get.mockImplementation(() => Promise.reject(new Error('project gone')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('Back to Projects');
  });
});

describe('ProjectDetail — per-section insights error is honest (dashes, not fake zeros)', () => {
  it('shows em-dashes for insights-backed tiles + an unavailable board when insights fail', async () => {
    mockApi.projects.insights.mockImplementation(() => Promise.reject(new Error('insights down')));
    await mount();
    await settle();
    const text = container.textContent ?? '';
    // the hero + record-backed tiles still render
    expect(text).toContain('mandrel');
    expect(text).toContain('1,054'); // contexts from the record survives
    expect(text).toContain('—'); // insights-backed tiles degrade to a dash
    expect(text).toContain('Task breakdown unavailable.');
  });
});

describe('ProjectDetail — per-section sessions error is isolated', () => {
  it('shows a sessions Alert without taking down the rest of the page', async () => {
    mockApi.projects.sessions.mockImplementation(() => Promise.reject(new Error('sessions down')));
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('mandrel'); // page intact
    expect(text).toContain("Couldn't load sessions");
  });
});
