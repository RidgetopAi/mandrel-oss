/**
 * ResolveRedirectPage — the /r/:id landing.
 *
 * WHAT THIS PINS, and why it exists at all: the page is the surface a HUMAN actually
 * meets when a short link fails. The requirement is that a dead id explains itself
 * rather than showing a generic dead end, and the explanation is authored by the
 * BACKEND (which alone knows what it searched and whether a project scope narrowed
 * it). So the thing worth testing is not "some not-found UI appears" — it is that the
 * backend's sentence reaches the screen VERBATIM.
 *
 * That matters because the page used to render its own hardcoded literal, "No
 * decision, task, or context matches …", which silently went stale the moment the
 * resolver learned two more types. Asserting the rendered text comes from the response
 * is what makes that class of drift impossible to reintroduce quietly.
 *
 * Harness style mirrors SessionDetail.test.tsx (createRoot + act into jsdom behind
 * QueryClientProvider + a real MemoryRouter route so useParams resolves), with the
 * resolve client mocked — this is a render test, not a network test.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../api/resolveClient', () => ({
  resolveNavRecord: vi.fn(),
}));

import ResolveRedirectPage from './ResolveRedirectPage';
import { resolveNavRecord } from '../api/resolveClient';

const mockResolve = resolveNavRecord as unknown as ReturnType<typeof vi.fn>;

const ID8 = 'deadbeef';

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
        <MemoryRouter initialEntries={[`/r/${ID8}`]}>
          <Routes>
            <Route path="/r/:id" element={<ResolveRedirectPage />} />
            {/* Real destinations so a unique match has somewhere to land. */}
            <Route path="/sessions/:id" element={<div>SESSION PAGE</div>} />
            <Route path="/projects/:id" element={<div>PROJECT PAGE</div>} />
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

beforeEach(() => {
  mockResolve.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ResolveRedirectPage — a dead id explains itself', () => {
  it('renders the backend not-found MESSAGE verbatim (not a hardcoded sentence)', async () => {
    const message =
      'No record matches id "deadbeef". Searched every context, task, decision, session, ' +
      'or project in any project. Nothing has an id starting with this.';
    mockResolve.mockResolvedValue({ status: 'notfound', message });
    await mount();
    await settle();
    expect(container.textContent).toContain(message);
    // Every searched type is named on screen — the user can see what was looked for.
    for (const t of ['context', 'task', 'decision', 'session', 'project']) {
      expect(container.textContent).toContain(t);
    }
  });

  it('renders the backend INVALID message, so the user learns which rule they broke', async () => {
    const message =
      '"bbbb" is not a full UUID or a valid short id. A short id must be at least 8 hex characters';
    mockResolve.mockResolvedValue({ status: 'invalid', message });
    await mount();
    await settle();
    expect(container.textContent).toContain(message);
  });

  it('surfaces the project-scope explanation when a scope narrowed the search', async () => {
    // The distinguishable case: "no such record" vs "right record, wrong project".
    const message =
      'No record matches id "deadbeef". Searched every context, task, decision, session, or ' +
      'project within the project you scoped to (the record may exist in another project — ' +
      'retry without ?project_id). Nothing has an id starting with this.';
    mockResolve.mockResolvedValue({ status: 'notfound', message });
    await mount();
    await settle();
    expect(container.textContent).toContain('project you scoped to');
  });

  it('falls back to its own copy when the response carried NO message (transport failure)', async () => {
    // The absent-value probe. Rendering `undefined` on screen is the failure mode a
    // message-passing UI invites, so the empty case is asserted explicitly.
    mockResolve.mockResolvedValue({ status: 'notfound' });
    await mount();
    await settle();
    expect(container.textContent).toContain(`Nothing matches "${ID8}"`);
    expect(container.textContent).not.toContain('undefined');
  });
});

describe('ResolveRedirectPage — the new types navigate', () => {
  it('a SESSION match navigates to the session detail page in the same tab', async () => {
    mockResolve.mockResolvedValue({
      status: 'unique',
      record: { type: 'session', id: 'sid', title: 'A session', url: '/sessions/sid' },
    });
    await mount();
    await settle();
    expect(container.textContent).toContain('SESSION PAGE');
  });

  it('a PROJECT match navigates to the project detail page in the same tab', async () => {
    mockResolve.mockResolvedValue({
      status: 'unique',
      record: { type: 'project', id: 'pid', title: 'A project', url: '/projects/pid' },
    });
    await mount();
    await settle();
    expect(container.textContent).toContain('PROJECT PAGE');
  });
});
