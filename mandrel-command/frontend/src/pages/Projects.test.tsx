/**
 * Projects render tests (P2 portfolio rebuild) — mirrors the Contexts/Tasks/Decisions test
 * style: createRoot + async act into jsdom, behind QueryClientProvider + MemoryRouter, with
 * the UNIFIED `api` client mocked. Proves the required states (data / loading / empty /
 * error), the vital-signs mapping (contexts from the list row; tasks + decisions from
 * insights), the recency-driven active/dormant split + its live segment counts, the
 * client-side search, navigation to the ProjectDetail route, create-from-portfolio, and —
 * critically — the HONEST active-work data-gap state (in-progress tasks stand in for the
 * un-served "active branches" telemetry; never fabricated branch names). Structural wiring
 * (no antd, unified client, no hex) is in Projects.wiring.test.ts.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    projects: {
      list: vi.fn(),
      insights: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import Projects from './Projects';
import { api } from '../api';

const mockApi = api as unknown as {
  projects: {
    list: ReturnType<typeof vi.fn>;
    insights: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days ago

const PA = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  name: 'riverbend',
  description: 'Agent First Company — the org, runtime & departments.',
  status: 'active',
  metadata: { is_primary: true },
  context_count: 1028,
  session_count: 40,
  last_activity: NOW_ISO,
  created_at: OLD_ISO,
  updated_at: NOW_ISO,
};
const PB = {
  id: 'bbbbbbbb-1111-2222-3333-444444444444',
  name: 'mandrel-stab',
  description: 'Stabilization & tester fleet.',
  status: 'active',
  metadata: {},
  context_count: 41,
  session_count: 3,
  last_activity: OLD_ISO,
  created_at: OLD_ISO,
  updated_at: OLD_ISO,
};

const INS_A = {
  project_id: PA.id,
  tasks: { total: 27, in_progress: 3, completed: 20, completion_percentage: 74 },
  contexts: { total: 1028 },
  decisions: { total: 41 },
  generated_at: NOW_ISO,
};
const INS_B = {
  project_id: PB.id,
  tasks: { total: 2, in_progress: 0, completed: 2, completion_percentage: 100 },
  contexts: { total: 41 },
  decisions: { total: 2 },
  generated_at: OLD_ISO,
};

function setHappy() {
  mockApi.projects.list.mockResolvedValue([PA, PB]);
  mockApi.projects.insights.mockImplementation((id: string) =>
    Promise.resolve(id === PA.id ? INS_A : INS_B),
  );
  mockApi.projects.create.mockResolvedValue({ ...PB, id: 'cccccccc-1111-2222-3333-444444444444', name: 'ra-new' });
}

let container: HTMLDivElement;
let root: Root;
let lastPath = '';

const LocationProbe: React.FC = () => {
  const loc = useLocation();
  lastPath = loc.pathname;
  return null;
};

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
        <MemoryRouter initialEntries={['/projects']}>
          <Projects />
          <LocationProbe />
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

function typeInto(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
  lastPath = '';
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Projects — data state + vital-signs mapping', () => {
  it('renders the grid from real project data with real vital signs', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('riverbend');
    expect(text).toContain('mandrel-stab');
    expect(text).toContain('1,028'); // context_count from the list row (localized)
    expect(text).toContain('27'); // tasks.total from insights (project A)
    expect(text).toContain('41'); // decisions.total from insights (project A)
    expect(mockApi.projects.list).toHaveBeenCalled();
    expect(mockApi.projects.insights).toHaveBeenCalledWith(PA.id);
  });

  it('marks the primary project (real metadata.is_primary), not the others', async () => {
    await mount();
    await settle();
    expect(container.textContent).toContain('PRIMARY');
    // only one PRIMARY tag
    const tags = (container.textContent ?? '').match(/PRIMARY/g) ?? [];
    expect(tags.length).toBe(1);
  });

  it('derives active vs dormant from recency (header + segment counts are live, not faked)', async () => {
    await mount();
    await settle();
    // PA is recent → active; PB is 30d stale → dormant. Header shows "2 · 1 active".
    expect(container.textContent).toContain('2 · 1 active');
  });
});

describe('Projects — the honest active-work data gap (no fabricated branches)', () => {
  it('shows the in-progress-task active-work signal, and the gap note, not branch names', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('3 in progress'); // PA insights.tasks.in_progress
    expect(text).toContain('no active work'); // PB has 0 in progress
    // the substitution is disclosed on-screen (Tooltip), never invented branch names
    expect(text).toContain('Per-branch git telemetry is not wired yet');
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    expect(text).not.toMatch(/active branch/i);
  });
});

describe('Projects — segment filter', () => {
  it('narrows to Active then Dormant using the recency split', async () => {
    await mount();
    await settle();
    clickText('Active');
    await settle();
    expect(container.textContent).toContain('riverbend');
    expect(container.textContent).not.toContain('mandrel-stab');
    clickText('Dormant');
    await settle();
    expect(container.textContent).toContain('mandrel-stab');
    expect(container.textContent).not.toContain('riverbend');
  });
});

describe('Projects — search', () => {
  it('filters client-side over name + description', async () => {
    await mount();
    await settle();
    const input = container.querySelector('input[aria-label="Search projects"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, 'stab');
    });
    await settle();
    expect(container.textContent).toContain('mandrel-stab');
    expect(container.textContent).not.toContain('riverbend');
  });
});

describe('Projects — navigation', () => {
  it('opens a project card into its ProjectDetail route', async () => {
    await mount();
    await settle();
    const card = container.querySelector(`button[aria-label="Open project riverbend"]`) as HTMLButtonElement;
    expect(card).not.toBeNull();
    await act(async () => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(lastPath).toBe(`/projects/${PA.id}`);
  });
});

describe('Projects — create from portfolio', () => {
  it('opens the create drawer and writes through api.projects.create', async () => {
    await mount();
    await settle();
    clickText('New project');
    await settle();
    // The Drawer renders in a portal (document.body), not inside `container`.
    const nameInput = document.querySelector('input[aria-label="Project name"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    await act(async () => {
      typeInto(nameInput, 'ra-new');
    });
    const submit = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim().startsWith('Create project'),
    );
    if (!submit) throw new Error('Create project button not found');
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(mockApi.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ra-new' }),
    );
  });
});

describe('Projects — loading state', () => {
  it('shows a spinner while the list query is in flight', async () => {
    mockApi.projects.list.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Projects — empty state', () => {
  it('shows Empty when there are no projects', async () => {
    mockApi.projects.list.mockResolvedValue([]);
    await mount();
    await settle();
    expect(container.textContent).toContain('No projects');
  });
});

describe('Projects — per-card insights error is honest (a dash, not a fake count)', () => {
  it('renders a dash for tasks/decisions when insights fails, list still renders', async () => {
    mockApi.projects.insights.mockImplementation(() => Promise.reject(new Error('insights down')));
    await mount();
    await settle();
    // the list vital signs still render; the insights-backed stats degrade to a dash
    expect(container.textContent).toContain('riverbend');
    expect(container.textContent).toContain('—');
  });
});

describe('Projects — error state', () => {
  it('surfaces an Alert when the list query fails', async () => {
    mockApi.projects.list.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
