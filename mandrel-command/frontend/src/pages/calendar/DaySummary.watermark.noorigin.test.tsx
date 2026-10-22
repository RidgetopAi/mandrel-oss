/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "about:blank" }
 */
/**
 * DaySummary watermark — the EMPTY POPULATION (CLASSES.md C3: probe the
 * empty/zero/absent values, they are the ones that slip through).
 *
 * When the origin is unknown, `window.location.origin` is the string "null" (jsdom and
 * browsers both do this for an opaque origin), which is NOT parseable as a URL — so
 * `watermarkHost` is ''. The requirement in that state is that the watermark degrades to
 * "Mandrel · generated <date>" and belongs to NOBODY. The tempting failure — and the one
 * this pins — is a fallback that reaches for a default hostname when the derivation comes
 * up empty, which would put OUR host back into a tenant's PNG through the back door.
 *
 * This lives in its own file because the origin must be set BEFORE module eval (see the
 * sibling DaySummary.watermark.test.tsx for why a stub after import proves nothing).
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
import { DAY_SUMMARY_UI } from './daySummaryConfig';
import type { DaySummaryData } from '../../api/domains/daySummary';

const mockApi = api as unknown as {
  daySummary: { get: ReturnType<typeof vi.fn> };
};

function quiet(): DaySummaryData {
  const z = { value: 0, delta: 0 };
  return {
    date: '2026-07-15',
    tz: 'UTC',
    project: 'all',
    headline: null,
    momentum: { score: 50, delta: 0, breakdown: { output: 0, followThrough: 0, depth: 0 } },
    kpis: { sessions: z, activeMinutes: z, contexts: z, decisions: z, tasksDone: z, filesTouched: z },
    ribbon: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
    highlights: [],
    decisions: [],
    tasksCompleted: { count: 0, items: [] },
    byActor: [],
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function mountCard(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DaySummary date={new Date(2026, 6, 15, 20, 30)} tz="UTC" project="all" scope={() => ({})} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Poll until the card is actually in the DOM rather than flushing a fixed number of
  // microtasks: the query resolves on a macrotask, so a microtask-only flush is a race
  // (it passed alone and failed in-suite before this). Throws on timeout — a render
  // test that silently reads an empty DOM is a hollow guard.
  for (let i = 0; i < 50 && !document.querySelector('[class*="card"]'); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  if (!document.querySelector('[class*="card"]')) {
    throw new Error('day-summary card never rendered within the settle budget');
  }
}

function exportedText(): string {
  const card = document.querySelector('[class*="card"]');
  if (!card) throw new Error('day-summary card did not render — nothing to read');
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-export-exclude="true"]').forEach((el) => el.remove());
  return clone.textContent ?? '';
}

describe('DaySummary watermark when the origin is unknown', () => {
  beforeEach(() => {
    mockApi.daySummary.get.mockReset().mockResolvedValue(quiet());
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    // The card renders through a PORTAL to document.body — clear it so one test's
    // markup can never satisfy the next test's assertion.
    document.body.innerHTML = '';
    root = undefined;
    container = undefined;
  });

  it('the premise: this environment has an opaque origin and no derivable host', () => {
    expect(window.location.host).toBe('');
    expect(DAY_SUMMARY_UI.watermarkHost).toBe('');
  });

  it('degrades to a host-less watermark rather than falling back to any hostname', async () => {
    await mountCard();
    const text = exportedText();

    expect(text).toContain('Mandrel · generated');
    // No stray separator left behind by an empty host.
    expect(text).not.toContain('Mandrel ·  · generated');
    // And nobody else's host smuggled in as a fallback.
    expect(text).not.toMatch(/[A-Za-z0-9-]+\.(?:net|com|org|io|ai|dev|app|co)\b/);
  });
});
