/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://contoso.mandrel.example.com/calendar" }
 */
/**
 * DaySummary PNG watermark — the TENANT case, at the surface the customer sees
 *.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM daySummaryConfig.test.ts
 * ------------------------------------------------------------
 * The config tests prove the derivation and scan the two source files for a baked-in
 * hostname. Both run under jsdom's DEFAULT origin (localhost:3000) — a host that is
 * not a tenant host and not ours, so they can only ever prove "not the literal". They
 * assert on the exported config OBJECT; nothing exercised the RENDERED footer, which
 * is the string that is rasterised into the shared PNG. A config value can be right
 * while the component still prints something else (it printed a bare literal, next to
 * a correct-looking config, for the entire life of the bug).
 *
 * So this file pins the consumer surface: mount the real card at a REAL TENANT ORIGIN
 * and read the watermark text out of the DOM node the exporter rasterises.
 *
 * THE ORIGIN IS THE ENVIRONMENT, NOT A STUB. `watermarkHost` is computed once at
 * module-eval time from window.location, so a location stubbed after import proves
 * nothing. The docblock above gives this file its own jsdom instance already sitting
 * on contoso's host before any import runs — the same way a tenant's browser does.
 * (The empty/unknown-origin population is covered in the sibling
 * DaySummary.watermark.noorigin.test.tsx, which boots on about:blank.)
 *
 * NOT MOCKED: daySummaryConfig, DaySummary, and the footer markup — the things under
 * test. Only the `api` client and the PNG rasteriser are mocked.
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

/** The tenant this file impersonates — must match the @vitest-environment-options url. */
const TENANT_HOST = 'contoso.mandrel.example.com';

/** A quiet day is enough: the footer renders in every non-loading, non-error state. */
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
    root = createRoot(container);
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

/**
 * The exact node the exporter rasterises: the `.card` subtree minus everything
 * carrying data-export-exclude. Returns the text that would appear IN THE PNG, so a
 * watermark that is correct on screen but excluded (or vice versa) cannot pass.
 */
function exportedText(): string {
  const card = document.querySelector('[class*="card"]');
  if (!card) throw new Error('day-summary card did not render — nothing to read');
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-export-exclude="true"]').forEach((el) => el.remove());
  return clone.textContent ?? '';
}

describe(`DaySummary watermark on a tenant instance (${TENANT_HOST})`, () => {
  beforeEach(() => {
    mockApi.daySummary.get.mockReset().mockResolvedValue(quiet());
  });

  afterEach(() => {
    // The premise test mounts nothing; tear down only what exists.
    if (root) act(() => root!.unmount());
    container?.remove();
    // The card renders through a PORTAL to document.body — clear it so one test's
    // markup can never satisfy the next test's assertion.
    document.body.innerHTML = '';
    root = undefined;
    container = undefined;
  });

  it('the environment really is the tenant origin (anti-vacuous: pins the premise)', () => {
    expect(window.location.host).toBe(TENANT_HOST);
    expect(DAY_SUMMARY_UI.watermarkHost).toBe(TENANT_HOST);
    expect(DAY_SUMMARY_UI.shareBase).toBe(`https://${TENANT_HOST}`);
  });

  it('renders the TENANT host in the exported watermark, not ours', async () => {
    await mountCard();
    const text = exportedText();

    // Positive: the tenant's own host is what a recipient of the PNG will read.
    expect(text).toContain(`Mandrel · ${TENANT_HOST} · generated`);
    // Negative: OUR instance appears nowhere in the artifact. `command.` is what
    // distinguishes it — TENANT_HOST legitimately ends in example.com.
    expect(text).not.toContain('command.example.com');
  });

  it('the watermark is INSIDE the export (not stripped with the action buttons)', async () => {
    await mountCard();
    // The buttons are excluded...
    expect(exportedText()).not.toContain('Copy link');
    // ...but the host survives the same filter. This is the assertion that catches a
    // future data-export-exclude landing on the footer and silently emptying the
    // watermark while every on-screen check still passes.
    expect(exportedText()).toContain(TENANT_HOST);
  });
});
