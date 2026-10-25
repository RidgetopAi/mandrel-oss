/**
 * Embedding — ONE selector, SEVEN panels (page-scope epic §E).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS GUARD EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * All seven panels used to call `useEffectiveProjectId()` independently, and the page had
 * no control at all. Two failure modes follow from that, and neither would show up on
 * screen: the page cannot be pointed anywhere (nothing owns the scope), and two panels
 * could answer for DIFFERENT projects while each renders its own plausible numbers side by
 * side under one heading. There is no visual tell for either.
 *
 * So the assertion is not "the page renders". It is:
 *
 *     ALL SEVEN PANELS PUT THE SAME PROJECT ON THE WIRE, AND THAT PROJECT IS THE ONE THE
 *     PAGE'S SELECTOR NAMES. CHANGE THE SELECTOR AND ALL SEVEN CHANGE.
 *
 * ── WHERE IT MEASURES ────────────────────────────────────────────────────────────────
 * At the generated `EmbeddingsService`, whose `xProjectId` argument IS the `X-Project-ID`
 * header (see api/generated/services/EmbeddingsService.ts — it is spliced straight into
 * `headers`). Everything above it runs for real: the real page, the real panels, the real
 * `useEmbeddings` hooks, the real `embeddingsClient`, the real `usePageProject`. Nothing
 * between the selector and the wire is stubbed, so a panel that quietly reads the ambient
 * project instead of its prop is visible here.
 *
 * That matters because `embeddingsClient.requireProjectId` FALLS BACK to
 * `resolveProjectHeader()` — the ambient default — when a caller names nothing. A panel
 * that lost its prop would not throw and would not render an error; it would silently show
 * the default project's embedding space next to six panels showing another. This suite is
 * what makes that loud.
 *
 * ── WHY IT DRIVES ONE TAB AT A TIME ──────────────────────────────────────────────────
 * antd `Tabs` mounts only the active pane, so a single render exercises exactly one panel.
 * The page is therefore mounted once per tab, driving the same `useEmbeddingStore` the
 * real tab strip drives. Seven mounts, seven panels, one assertion each — rather than one
 * mount that would silently only ever prove the first.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// `vi.hoisted` because the mock factory below is lifted above these declarations.
const ids = vi.hoisted(() => ({
  A: 'aaaaaaaa-1111-4111-8111-111111111111',
  /** The user's DEFAULT — the ambient project a panel that lost its prop falls back to. */
  B: 'bbbbbbbb-2222-4222-8222-222222222222',
}));
const PROJECT_A = ids.A;
const PROJECT_B = ids.B;

/**
 * Every `xProjectId` the generated client was handed, by method. This is the header, so
 * "what the panel asked for" and "what went on the wire" cannot diverge here.
 */
const seen = vi.hoisted(() => ({ calls: [] as Array<{ method: string; projectId: unknown }> }));

/**
 * SimilarityHeatmap renders `react-plotly.js`, which pulls the full plotly bundle and dies
 * in jsdom on `URL.createObjectURL` / `canvas.getContext` before any test can run. Stubbed
 * to an inert element: this suite is about which project the panel REQUESTS, and the chart
 * is downstream of that answer. Substituting it removes a jsdom limitation, not a
 * behaviour under test.
 */
vi.mock('react-plotly.js', () => ({
  default: () => React.createElement('div', { 'data-testid': 'plotly-stub' }),
}));

vi.mock('../api/generated', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  /**
   * Record the project, then REJECT. Deliberate: each panel then renders its own error
   * state, which needs no payload shape at all. The alternative — hand-modelling seven
   * different response schemas — would make this suite fail on a payload-shape change that
   * has nothing to do with project scope, and half of a hand-written oracle is where the
   * defects live. The call is recorded BEFORE the rejection, so the assertion is untouched.
   *
   * `getEmbeddingList` is the exception and must RESOLVE: four of the seven panels select a
   * dataset from it before they issue their own read, so a rejected list would mean those
   * four never reach the wire and the suite would silently prove nothing about them.
   */
  const record =
    (method: string, result?: unknown) =>
    (args: { xProjectId?: string }) => {
      seen.calls.push({ method, projectId: args?.xProjectId });
      return result === undefined
        ? Promise.reject(new Error(`stubbed ${method} failure`))
        : Promise.resolve(result);
    };
  const DATASET = [{ id: ids.A, name: 'dataset', count: 10 }];
  return {
    ...actual,
    EmbeddingsService: {
      getEmbeddingList: record('list', DATASET),
      getEmbeddingSimilarity: record('similarity'),
      getEmbeddingProjection: record('projection'),
      getEmbeddingCluster: record('cluster'),
      getEmbeddingMetrics: record('metrics'),
      getEmbeddingRelationships: record('relationships'),
      getEmbeddingKnowledgeGaps: record('knowledgeGaps'),
      getEmbeddingUsage: record('usage'),
    },
  };
});

/** SimilarityHeatmap reads the theme context; it throws outside a provider. */
vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', toggleTheme: () => {} }),
}));

const projectList = vi.hoisted(() => ({ value: [] as Array<{ id: string; name: string }> }));
const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));
vi.mock('../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context, so a test can move THE switch
  // (`useProjectSelectionStore.getState().select(id)`) and the page re-renders.
  const { useProjectSelectionStore } = await import('../stores/projectSelectionStore');
  return {
  useProjectContext: () => ({
    selectedProjectId: useProjectSelectionStore((st) => st.selectedProjectId),
    setSelectedProjectId: useProjectSelectionStore.getState().select, allProjects: projectList.value, loading: false }),
  };
});
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: settings.defaultProjectId }),
}));

import Embedding from './Embedding';
import { useEmbeddingStore } from '../stores/embeddingStore';

/**
 * THE POPULATION, STATED (C3): the seven data panels the Embedding page renders — every
 * child of `tabItems` in pages/Embedding.tsx that is a component rather than a static
 * placeholder. The two omitted tabs ('3d', 'settings') render literal antd `Alert`
 * copy and issue no request; `emptyTabsAreStillPlaceholders` below pins that, so if one
 * of them ever grows a real read this suite fails instead of quietly under-covering.
 */
const PANEL_TABS = [
  'heatmap',
  'scatter',
  'cluster',
  'relationships',
  'knowledge',
  'usage',
  'metrics',
] as const;

const PLACEHOLDER_TABS = ['3d', 'settings'] as const;

let container: HTMLDivElement;
let root: Root;

async function mountTab(tab: string, url: string) {
  act(() => {
    useEmbeddingStore.setState({ activeTab: tab, selectedDatasetId: null });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Embedding />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Datasets resolve, the selection effect fires, then the panel's own query runs — the
  // dependent panels need more than one turn to reach the wire.
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function unmount() {
  act(() => root?.unmount());
  container?.remove();
}

beforeEach(() => {
  resetProjectSelection();
  seen.calls = [];
  // DEFAULT = B, page pointed at A. "A panel fell back to the ambient project" is
  // therefore always a distinct, named failure rather than an indistinguishable pass.
  settings.defaultProjectId = PROJECT_B;
  projectList.value = [
    { id: PROJECT_A, name: 'acme-widgets' },
    { id: PROJECT_B, name: 'the default project' },
  ];
});

afterEach(() => {
  unmount();
});

describe('Embedding — one selector, seven panels', () => {
  it('renders NO project selector of its own — THE switch is in the shell', async () => {
    await mountTab('heatmap', `/embedding?project=${PROJECT_A}`);
    expect(container.querySelectorAll('button[aria-label="Embedding project"]')).toHaveLength(0);
  });

  it('ALL SEVEN panels put the page project on the wire — none falls back to the default', async () => {
    const perPanel: Record<string, unknown[]> = {};
    for (const tab of PANEL_TABS) {
      seen.calls = [];
      // eslint-disable-next-line no-await-in-loop
      await mountTab(tab, `/embedding?project=${PROJECT_A}`);
      perPanel[tab] = seen.calls.map((c) => c.projectId);
      unmount();
    }

    for (const tab of PANEL_TABS) {
      // It reached the wire at all — a panel that renders nothing would otherwise pass
      // the "never named B" half trivially.
      expect(perPanel[tab].length, `panel "${tab}" issued no request at all`).toBeGreaterThan(0);
      for (const named of perPanel[tab]) {
        expect(named, `panel "${tab}" did not name the page project`).toBe(PROJECT_A);
        expect(named, `panel "${tab}" fell back to the ambient default`).not.toBe(PROJECT_B);
      }
    }

    // And the point of the whole exercise: they all agree. Seven panels showing numbers
    // for two different projects under one heading is the failure with no visual tell.
    const distinct = new Set(Object.values(perPanel).flat());
    expect(distinct).toEqual(new Set([PROJECT_A]));
  });

  it('CHANGING the page selector changes ALL SEVEN', async () => {
    const perPanel: Record<string, unknown[]> = {};
    for (const tab of PANEL_TABS) {
      seen.calls = [];
      // Same page, different selection — expressed through the ?project= URL state the
      // selector itself writes (§A4), so this is the same path a click takes.
      // eslint-disable-next-line no-await-in-loop
      await mountTab(tab, `/embedding?project=${PROJECT_B}`);
      perPanel[tab] = seen.calls.map((c) => c.projectId);
      unmount();
    }
    const distinct = new Set(Object.values(perPanel).flat());
    expect(distinct).toEqual(new Set([PROJECT_B]));
  });

  it('a change on THE switch moves the whole page, not just the visible panel', async () => {
    useProjectSelectionStore.getState().select(PROJECT_A);
    await mountTab('knowledge', '/embedding');
    expect(new Set(seen.calls.map((c) => c.projectId))).toEqual(new Set([PROJECT_A]));

    seen.calls = [];
    await act(async () => {
      useProjectSelectionStore.getState().select(PROJECT_B);
    });
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    expect(seen.calls.length).toBeGreaterThan(0);
    expect(new Set(seen.calls.map((c) => c.projectId))).toEqual(new Set([PROJECT_B]));
  });

  it("a leftover 'all' in the store is not a scope — the page shows the default (F2)", async () => {
    useProjectSelectionStore.getState().select('all');
    await mountTab('heatmap', '/embedding');
    expect(seen.calls.length).toBeGreaterThan(0);
    expect(new Set(seen.calls.map((c) => c.projectId))).toEqual(new Set([PROJECT_B]));
  });

  it('THE EMPTY POPULATION — with no project, no panel sends an unscoped request', async () => {
    projectList.value = [];
    settings.defaultProjectId = undefined;
    for (const tab of PANEL_TABS) {
      seen.calls = [];
      // eslint-disable-next-line no-await-in-loop
      await mountTab(tab, '/embedding');
      // `embeddingsClient` would otherwise fall through to the ambient localStorage
      // value here; the panels' `enabled` gates are what stop it.
      expect(seen.calls, `panel "${tab}" fired a request with no project selected`).toEqual([]);
      unmount();
    }
  });

  it('the two non-data tabs are still placeholders (so the population above is the whole one)', async () => {
    for (const tab of PLACEHOLDER_TABS) {
      seen.calls = [];
      // eslint-disable-next-line no-await-in-loop
      await mountTab(tab, `/embedding?project=${PROJECT_A}`);
      expect(seen.calls, `tab "${tab}" now issues requests — add it to PANEL_TABS`).toEqual([]);
      unmount();
    }
  });
});
