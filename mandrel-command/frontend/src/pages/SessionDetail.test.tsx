/**
 * SessionDetail render tests (last-page rebuild) — mirrors the ProjectDetail test
 * style: createRoot + async act into jsdom, behind QueryClientProvider + MemoryRouter
 * (a real /sessions/:id Route so useParams resolves), with the UNIFIED `api` client
 * mocked. Proves: the header (title / id / status) + the deep-link read (get called
 * with the route id); the REAL vital tiles; each of the FIVE tabs rendering its REAL
 * data (Contexts/Tasks/Decisions from api.sessions.get, Files from api.sessions.files,
 * Timeline merged from all of them); the HONEST empty states (no fabricated rows); the
 * loading spinner; and the error Alert. Structural wiring (no antd, unified client, no
 * hex) is in SessionDetail.wiring.test.ts; the route guard in SessionDetail.uuid.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    sessions: {
      get: vi.fn(),
      files: vi.fn(),
    },
  },
}));

import SessionDetail from './SessionDetail';
import { api } from '../api';

const mockApi = api as unknown as {
  sessions: {
    get: ReturnType<typeof vi.fn>;
    files: ReturnType<typeof vi.fn>;
  };
};

const SID = 'c875b2af-9020-41b7-9595-d70221603464';
const NOW_ISO = new Date().toISOString();

const SESSION = {
  id: SID,
  project_id: 'pppppppp-1111-2222-3333-444444444444',
  project_name: 'mandrel',
  title: 'Session detail rebuild',
  session_goal: 'Bring the last page onto the token system',
  tags: ['redesign', 'command-ui'],
  ai_model: 'claude-opus',
  active_branch: 'fix/session-detail-rebuild',
  working_commit_sha: 'deadbeefcafef00d',
  status: 'active',
  started_at: NOW_ISO,
  created_at: NOW_ISO,
  last_activity_at: NOW_ISO,
  ended_at: null,
  contexts_created: 2,
  context_count: 2,
  decisions_created: 1,
  tasks_created: 1,
  tasks_completed: 1,
  files_modified_count: 1,
  total_tokens: '142000',
  lines_added: 412,
  lines_deleted: 87,
  productivity_score: 963.4,
  contexts: [
    {
      id: 'ctx11111-1111-2222-3333-444444444444',
      context_type: 'completion',
      content: 'Rebuilt the session detail page onto tokens.',
      created_at: NOW_ISO,
      tags: ['proof'],
    },
    {
      id: 'ctx22222-1111-2222-3333-444444444444',
      context_type: 'planning',
      content: 'Mapped the five tabs to real endpoints.',
      created_at: NOW_ISO,
    },
  ],
  tasks: [
    {
      id: 'task1111-1111-2222-3333-444444444444',
      title: 'Migrate reads to api.sessions',
      type: 'refactor',
      status: 'completed',
      priority: 'high',
      created_at: NOW_ISO,
    },
  ],
  decisions: [
    {
      id: 'dec11111-1111-2222-3333-444444444444',
      title: 'Reuse the Sessions timeline builder',
      decision_type: 'ui_ux',
      status: 'approved',
      impact_level: 'medium',
      created_at: NOW_ISO,
    },
  ],
  linked_commits: [
    {
      id: 'commit11-1111-2222-3333-444444444444',
      commit_sha: 'deadbeefcafef00d1234',
      short_sha: 'deadbeef',
      message: 'feat(command/ui): rebuild SessionDetail\n\nbody line',
      author_date: NOW_ISO,
    },
  ],
};

const FILES = [
  {
    id: 'file1111-1111-2222-3333-444444444444',
    session_id: SID,
    file_path: 'src/pages/SessionDetail.tsx',
    lines_added: 120,
    lines_deleted: 800,
    source: 'git',
    first_modified_at: NOW_ISO,
    last_modified_at: NOW_ISO,
  },
];

function setHappy() {
  mockApi.sessions.get.mockResolvedValue(SESSION);
  mockApi.sessions.files.mockResolvedValue(FILES);
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
        <MemoryRouter initialEntries={[`/sessions/${SID}`]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetail />} />
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

async function clickTab(label: string) {
  const el = Array.from(container.querySelectorAll('[role="tab"]')).find((b) =>
    (b.textContent ?? '').trim().startsWith(label),
  );
  if (!el) throw new Error(`tab "${label}" not found`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('SessionDetail — header + vitals from real data', () => {
  it('renders the header (title, id, live status) + reads the route id', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Session detail rebuild');
    expect(text).toContain(SID); // full id shown
    expect(text).toContain('live'); // derived status pill
    expect(text).toContain('mandrel'); // project meta
    expect(text).toContain('claude-opus'); // ai model meta
    expect(mockApi.sessions.get).toHaveBeenCalledWith(SID);
  });

  it('maps the vital tiles from REAL fields', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('142k'); // tokens formatted
    expect(text).toContain('+412 / -87'); // churn caption from lines added/deleted
    expect(text).toContain('Activity'); // activity-score tile present
    expect(text).toContain('963'); // productivity_score 963.4 rounded (unbounded, no /100)
  });
});

describe('SessionDetail — five tabs each render real data', () => {
  it('Contexts tab (default) renders the real contexts + type badge', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Rebuilt the session detail page onto tokens.');
    expect(text).toContain('completion');
  });

  it('Tasks tab renders the real task row', async () => {
    await mount();
    await settle();
    await clickTab('Tasks');
    const text = container.textContent ?? '';
    expect(text).toContain('Migrate reads to api.sessions');
    expect(text).toContain('completed');
  });

  it('Decisions tab renders the real decision row', async () => {
    await mount();
    await settle();
    await clickTab('Decisions');
    const text = container.textContent ?? '';
    expect(text).toContain('Reuse the Sessions timeline builder');
    expect(text).toContain('ui_ux');
  });

  it('Files tab reads api.sessions.files + renders the file row and total', async () => {
    await mount();
    await settle();
    await clickTab('Files');
    expect(mockApi.sessions.files).toHaveBeenCalledWith(SID);
    const text = container.textContent ?? '';
    expect(text).toContain('src/pages/SessionDetail.tsx');
    expect(text).toContain('+120');
    expect(text).toContain('-800');
  });

  it('Timeline tab merges contexts/decisions/tasks/commits (real, first-line only)', async () => {
    await mount();
    await settle();
    await clickTab('Timeline');
    const text = container.textContent ?? '';
    expect(text).toContain('commit'); // linked commit kind
    expect(text).toContain('decision'); // decision kind
    expect(text).toContain('rebuild SessionDetail'); // commit subject, first line
    expect(text).not.toContain('body line'); // multi-line body collapsed away
  });
});

describe('SessionDetail — honest empty states (no fabricated rows)', () => {
  it('shows an empty state per tab when the session has no records', async () => {
    mockApi.sessions.get.mockResolvedValue({
      ...SESSION,
      contexts: [],
      tasks: [],
      decisions: [],
      linked_commits: [],
    });
    mockApi.sessions.files.mockResolvedValue([]);
    await mount();
    await settle();
    expect(container.textContent).toContain('No contexts'); // default tab empty
    await clickTab('Files');
    expect(container.textContent).toContain('No files');
    await clickTab('Timeline');
    expect(container.textContent).toContain('No activity');
  });
});

describe('SessionDetail — loading + error', () => {
  it('shows a spinner while the detail read is in flight', async () => {
    mockApi.sessions.get.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('surfaces an Alert + a back action when the detail read fails', async () => {
    mockApi.sessions.get.mockImplementation(() => Promise.reject(new Error('session gone')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('Back to Sessions');
  });
});
