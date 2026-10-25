/**
 * Sessions manual start/stop controls — proves the previously-DEAD
 * lifecycle methods now have real CALL SITES:
 *   • "New session" → opens NewSessionModal → submits → api.sessions.start() fires.
 *   • a live stream card's "End session" → confirm → api.sessions.end(id) fires.
 *   • an ENDED session exposes NO end control (canEnd is false).
 *
 * This is the regression guard for the class the task names (stub-never-wired /
 * orphaned lifecycle client methods): if a future refactor unwires either button,
 * these call-site assertions go red. Raw react-dom + React.act harness, mirroring
 * Sessions.test.tsx; modal content lives in a portal, so those queries hit
 * document.body / the open [role="dialog"].
 *
 * ── AND, SINCE the page-scope epic, THE WRITE-SCOPE GUARD ──────────────────────────────────
 * "New session" is the one WRITE surface on this screen, and writes are the dangerous
 * half of this change set. A write carries no query param and the backend's write
 * precedence is HEADER > body, so an unscoped start is filed against the AMBIENT default
 * project — which is now, BY DESIGN, not necessarily the project the page is showing. The
 * user would be looking at project A, the session would be created in B, and nothing would
 * error, because both projects authorize.
 *
 * So the ambient project in localStorage below is deliberately set to a DIFFERENT project
 * from the one the page displays, and the start assertions read the `X-Project-ID` the
 * request would actually carry after the real axios interceptor has run. If the page ever
 * stops scoping this write, the ambient B shows up here instead of A.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    sessions: {
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      start: vi.fn(),
      end: vi.fn(),
    },
  },
}));

/** The project the page shows. */
const PROJECT_A = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'riverbend' };
/** The user's DEFAULT project, and the ambient header. A mis-scoped write lands here. */
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

import Sessions from './Sessions';
import { api } from '../api';
import { apiConfig } from '../config/apiConfig';
import { PROJECT_URL_PARAM } from '../hooks/usePageProject';

const mockApi = api as unknown as {
  sessions: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
};

/**
 * The `X-Project-ID` a config would ACTUALLY send, after the real request interceptor.
 * Reading the raw config instead would let an unscoped write pass, because the interceptor
 * silently supplies the ambient default — which is the bug.
 */
async function headerOnTheWire(config: unknown): Promise<unknown> {
  const { apiClient } = await import('../services/api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = (apiClient as any).instance ?? (apiClient as any)._instance;
  const handlers = instance.interceptors.request.handlers.filter(Boolean);
  const cfg = (config ?? {}) as Record<string, unknown>;
  let out = { ...cfg, headers: { ...((cfg.headers as object) ?? {}) }, url: '/x', method: 'post' };
  for (const h of handlers) {
    // eslint-disable-next-line no-await-in-loop
    out = await h.fulfilled(out);
  }
  return (out.headers as Record<string, unknown>)[apiConfig.projectHeader];
}

const NOW = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString();

const LIVE_SESSION = {
  id: 'sess-live-0001',
  display_id: 'live-01',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'Live work',
  actor: 'coordinator',
  started_at: NOW,
  ended_at: null,
  last_activity_at: NOW,
  contexts_created: 3,
  tasks_created: 1,
  total_tokens: '1000',
};
const ENDED_SESSION = {
  id: 'sess-ended-0002',
  display_id: 'ended-02',
  project_id: 'p-daisy',
  project_name: 'daisy',
  title: 'Old work',
  actor: 'coordinator',
  started_at: YESTERDAY,
  ended_at: YESTERDAY,
  last_activity_at: YESTERDAY,
  contexts_created: 5,
  tasks_created: 2,
  total_tokens: '2000',
};

const DETAIL = {
  id: 'x',
  project_id: 'p',
  contexts: [],
  decisions: [],
  tasks: [],
  linked_commits: [],
  contexts_created: 0,
  tasks_created: 0,
  decisions_created: 0,
  files_modified_count: 0,
  total_tokens: 0,
};

function setHappy() {
  mockApi.sessions.list.mockResolvedValue([LIVE_SESSION, ENDED_SESSION]);
  // get returns a detail keyed to whichever id the card requests.
  mockApi.sessions.get.mockImplementation(async (id: string) => ({ ...DETAIL, id }));
  mockApi.sessions.start.mockResolvedValue({ ...DETAIL, id: 'new-session' });
  mockApi.sessions.end.mockImplementation(async (id: string) => ({ ...DETAIL, id, ended_at: NOW }));
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount(initialUrl = '/sessions') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialUrl]}>
          <Sessions />
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

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** First <button> in `scope` whose visible text includes `text`. */
function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  ) as HTMLButtonElement | undefined;
}

function openDialog(): HTMLElement {
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
  expect(dialog, 'a modal dialog should be open').toBeTruthy();
  return dialog as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  settings.defaultProjectId = PROJECT_B.id;
  // THE AMBIENT SCOPE IS B, DELIBERATELY — see the header. Without this, "the write named
  // A" would be unfalsifiable, because nothing else could have supplied a project.
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id: PROJECT_B.id }));
  localStorage.setItem('aidis_current_project', JSON.stringify({ id: PROJECT_B.id }));
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
  // Portals attach to document.body — clear any leftover dialog between tests.
  document.querySelectorAll('[role="dialog"]').forEach((d) => d.remove());
});

describe('Sessions — manual start control', () => {
  it('"New session" opens the modal and submitting calls api.sessions.start', async () => {
    await mount();
    await settle();

    const newBtn = buttonByText(container, 'New session');
    expect(newBtn, 'the New session button should render in the header').toBeTruthy();
    await act(async () => click(newBtn!));
    await settle();

    const dialog = openDialog();
    const startBtn = buttonByText(dialog, 'Start session');
    expect(startBtn, 'the modal should offer a Start session button').toBeTruthy();

    await act(async () => click(startBtn!));
    await settle();

    expect(mockApi.sessions.start).toHaveBeenCalledTimes(1);
  });

  it('files the new session in the PAGE\'s project, not the ambient default', async () => {
    // The page is showing A. The user's default — and therefore the ambient header — is B.
    await mount(`/sessions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    await settle();

    await act(async () => click(buttonByText(container, 'New session')!));
    await settle();
    await act(async () => click(buttonByText(openDialog(), 'Start session')!));
    await settle();

    expect(mockApi.sessions.start).toHaveBeenCalledTimes(1);
    const [, config] = mockApi.sessions.start.mock.calls[0];
    const sent = await headerOnTheWire(config);
    // Three ways, so no failure mode reads as a pass:
    expect(sent).toBe(PROJECT_A.id); // it named A…
    expect(sent).not.toBe(PROJECT_B.id); // …not the ambient default, which is the bug…
    expect(sent).toBeDefined(); // …and not "no project", which the backend would guess at.
  });

  it('MUTATION — an UNSCOPED start would have carried the ambient default instead', async () => {
    // Proof the assertion above is earned rather than vacuous: the interceptor really does
    // supply B for a request that says nothing, so "it named A" could only come from the
    // page having scoped the write itself.
    await mount(`/sessions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    await settle();
    expect(await headerOnTheWire({})).toBe(PROJECT_B.id);
  });

  it('an explicit project chosen in the form wins over the page scope', async () => {
    // The form's Project field names the session's project. When the user picks one, THAT
    // is what the write is scoped to — the page selection is only the fallback for
    // "Auto-detect / unassigned".
    await mount(`/sessions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    await settle();

    await act(async () => click(buttonByText(container, 'New session')!));
    await settle();

    const dialog = openDialog();
    const projectTrigger = dialog.querySelector('[aria-label="Session project"]') as HTMLElement;
    expect(projectTrigger, 'the modal should offer a project field').toBeTruthy();
    await act(async () => click(projectTrigger));
    await settle();

    const option = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => (el.textContent ?? '').trim() === PROJECT_B.name,
    );
    expect(option, `an option for ${PROJECT_B.name} should be offered`).toBeTruthy();
    await act(async () => click(option as Element));
    await settle();

    await act(async () => click(buttonByText(openDialog(), 'Start session')!));
    await settle();

    const [input, config] = mockApi.sessions.start.mock.calls[0];
    expect((input as { projectId?: string }).projectId).toBe(PROJECT_B.id);
    expect(await headerOnTheWire(config)).toBe(PROJECT_B.id);
  });
});

describe('Sessions — manual end control', () => {
  it('a live card End session + confirm calls api.sessions.end with the session id', async () => {
    await mount();
    await settle();

    // Cards mount collapsed, so expand the live one first; its detail resolves → the
    // End control renders in the card action row (NOT inside a dialog yet).
    const liveHead = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Live work'),
    );
    expect(liveHead, 'the live card header should render').toBeTruthy();
    await act(async () => click(liveHead!));
    await settle();

    const cardEnd = buttonByText(container, 'End session');
    expect(cardEnd, 'a live card should expose an End session control').toBeTruthy();

    await act(async () => click(cardEnd!));
    await settle();

    const dialog = openDialog();
    const confirmEnd = buttonByText(dialog, 'End session');
    expect(confirmEnd, 'the confirm dialog should offer End session').toBeTruthy();

    await act(async () => click(confirmEnd!));
    await settle();

    expect(mockApi.sessions.end).toHaveBeenCalledTimes(1);
    expect(mockApi.sessions.end).toHaveBeenCalledWith('sess-live-0001');
  });

  it('an ended session exposes no End session control', async () => {
    await mount();
    await settle();

    // Expand the ended card. Its header button carries the session title; clicking it
    // toggles the accordion open. The check is scoped to that card's OWN subtree so a
    // live card's End control elsewhere on the page cannot answer for it.
    const endedHead = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Old work'),
    );
    expect(endedHead, 'the ended card header should render').toBeTruthy();
    await act(async () => click(endedHead!));
    await settle();

    const endedCard = endedHead!.parentElement as HTMLElement;
    // Sanity: the card is expanded (its action row rendered Edit/Open).
    expect(buttonByText(endedCard, 'Edit'), 'ended card should be expanded').toBeTruthy();
    // But an already-ended session offers NO End session control.
    expect(buttonByText(endedCard, 'End session')).toBeUndefined();
  });
});
