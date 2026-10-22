/**
 * Punch board id-jump destination.
 *
 * ONE place decides where a resolved record opens: the backend resolver
 * (`idResolver.ts urlForRecord`, taught the `isPunchSql` bit by 6a0d2c9e). It already
 * routes a PUNCH task to `/punch/:id` and an ordinary (non-punch) task to `/tasks/:id`
 * in `record.url` — that decision rides in the resolve response itself, per record.
 *
 * The Punch board used to override that with a second, blanket rule
 * (`urlFor={(record) => record.type === 'task' ? /punch/<id> : record.url}`) which sent
 * EVERY task — punch or not — to `/punch/:id`. Once the backend fix landed, that made
 * the Punch board disagree with every other surface (`/r/` links, tool responses, the
 * Tasks page itself) for a non-punch task. This test drives the id-jump for BOTH cases
 * from the Punch board and asserts the actual navigation destination, so deleting the
 * override (or reintroducing it) is not invisible to the suite — the critic's T2 finding
 * on c72d70cf, closed: "no Punch.wiring/IdJumpResult assertion covers the search or the
 * urlFor override, so deleting the one line that makes clause (b) land on /punch/<id>
 * instead of /tasks/<id> leaves all 305 tests green".
 *
 * Harness matches Tasks.test.tsx / ResolveRedirectPage.test.tsx: createRoot + async act
 * into jsdom, QueryClientProvider + a real MemoryRouter with sibling routes so a resolved
 * jump has somewhere real to land, unified `api` + ProjectContext mocked. A `LocationProbe`
 * sibling reads the router's current pathname directly — the most direct assertion of
 * "where did it actually go", independent of which route component rendered.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    tasks: { list: vi.fn(), get: vi.fn() },
    resolve: { record: vi.fn() },
  },
}));

const TEST_PROJECT = { id: 'f0f0f0f0-1111-4111-8111-f0f0f0f0f0f0', name: 'Test Project' };

vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({
    selectedProjectId: undefined,
    setSelectedProjectId: () => undefined,
    currentProject: null,
    allProjects: [TEST_PROJECT],
    loading: false,
    projectsUnavailable: false,
  }),
  useEffectiveProjectId: () => TEST_PROJECT.id,
}));
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: TEST_PROJECT.id }),
}));

import Punch from './Punch';
import { api } from '../api';

const mockApi = api as unknown as {
  tasks: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  resolve: { record: ReturnType<typeof vi.fn> };
};

// The board itself is irrelevant to the id-jump destination — an empty board keeps the
// render cheap (no attachment thumbnails to fetch) while the search box + IdJumpResult
// still work off `api.resolve.record`.
function setHappy() {
  mockApi.tasks.list.mockResolvedValue({ tasks: [], total: 0 });
  mockApi.tasks.get.mockResolvedValue(null);
}

const NON_PUNCH_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const NON_PUNCH_RECORD = {
  type: 'task',
  id: NON_PUNCH_ID,
  title: 'An ordinary task, no punch metadata',
  // The backend resolver's own decision for a non-punch task (idResolver.ts urlForRecord).
  url: `/tasks/${NON_PUNCH_ID}`,
};

const PUNCH_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PUNCH_RECORD = {
  type: 'task',
  id: PUNCH_ID,
  title: 'A filed punch',
  // The backend resolver's own decision for a punch task (isPunchSql true).
  url: `/punch/${PUNCH_ID}`,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
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
        <MemoryRouter initialEntries={['/punch']}>
          <LocationProbe />
          <Routes>
            <Route path="/punch" element={<Punch />} />
            <Route path="/punch/:id" element={<Punch />} />
            {/* A real, distinct destination so the non-punch case has somewhere to land
                that is NOT the Punch route — proves it did not get pulled back onto
                /punch/:id by an override. */}
            <Route path="/tasks/:id" element={<div>TASK PAGE STUB</div>} />
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

function typeInto(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function currentPath(): string | null {
  return container.querySelector('[data-testid="loc"]')?.textContent ?? null;
}

function jumpButton(): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Jump to task'),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

async function searchAndJump(id: string) {
  const input = container.querySelector('input[aria-label="Search punches"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    typeInto(input, id);
  });
  await settle();
  const btn = jumpButton();
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.click();
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

describe('Punch board — id-jump lands where the BACKEND resolver said, for both cases', () => {
  it('a NON-PUNCH task resolves to /tasks/:id — the Punch board must not redirect it to /punch/:id', async () => {
    mockApi.resolve.record.mockResolvedValue({ status: 'unique', record: NON_PUNCH_RECORD });
    await mount();
    await settle();
    await searchAndJump(NON_PUNCH_ID.slice(0, 8));
    expect(currentPath()).toBe(`/tasks/${NON_PUNCH_ID}`);
    expect(container.textContent).toContain('TASK PAGE STUB');
  });

  it('a PUNCH task resolves to /punch/:id — the Punch board must land there too', async () => {
    mockApi.resolve.record.mockResolvedValue({ status: 'unique', record: PUNCH_RECORD });
    await mount();
    await settle();
    await searchAndJump(PUNCH_ID.slice(0, 8));
    expect(currentPath()).toBe(`/punch/${PUNCH_ID}`);
  });
});
