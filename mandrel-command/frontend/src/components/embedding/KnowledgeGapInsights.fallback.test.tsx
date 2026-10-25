/**
 * Embedding panel scope test — REWRITTEN for the page-owned selector (page-scope epic §E).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS USED TO ASSERT, AND WHY IT COULD NOT SURVIVE
 * ════════════════════════════════════════════════════════════════════════════════════
 * It asserted the panel resolved its own project from `useEffectiveProjectId()` — i.e. that
 * it read the GLOBAL switcher and, under "All Projects", substituted the default project's
 * uuid so the uuid-validated route never saw the `'all'` sentinel. Every clause of that is
 * now gone by design: the global switcher is deleted, `'all'` never reaches this page, and a
 * panel resolving its own scope is the defect (seven panels, seven answers, no single
 * control). The guard is not deleted — the behaviour it protected is renamed, not dropped:
 *
 *   OLD: the panel resolves a REAL uuid, never the sentinel, and empties honestly when none.
 *   NEW: the panel uses the project THE PAGE GAVE IT, reaches for nothing else, and empties
 *        honestly when it has none.
 *
 * The last clause is the one that still bites. `embeddingsClient.requireProjectId` falls
 * back to `resolveProjectHeader()` — the ambient default — for a caller that names nothing.
 * So a panel that ignored its prop would NOT throw and would NOT render an error; it would
 * quietly render the default project's numbers. Hence the negative assertion below is on
 * the outgoing call, not on what the component renders.
 *
 * KnowledgeGapInsights is the representative single-panel case (the other six take the same
 * `EmbeddingPanelProps`). The FAN-OUT — that all seven receive the same project and follow
 * the selector together — is proven against the real page in `pages/Embedding.fanout.test.tsx`.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PAGE_PROJECT = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_PROJECT = 'bbbbbbbb-2222-4222-8222-222222222222';

const gapsSpy = vi.hoisted(() => vi.fn<[unknown], void>());

vi.mock('../../hooks/useEmbeddings', () => ({
  useEmbeddingKnowledgeGapsQuery: (projectId: unknown) => {
    gapsSpy(projectId);
    return { isLoading: false, isFetching: false, error: null, data: null, refetch: vi.fn() };
  },
}));

import KnowledgeGapInsights from './KnowledgeGapInsights';

let container: HTMLDivElement;
let root: Root;

function mount(projectId: string | undefined) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<KnowledgeGapInsights projectId={projectId} />);
  });
}

beforeEach(() => {
  gapsSpy.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('KnowledgeGapInsights — scoped by the PAGE, not by itself', () => {
  it('queries with the project the page passed in', () => {
    mount(PAGE_PROJECT);
    expect(gapsSpy).toHaveBeenCalledWith(PAGE_PROJECT);
  });

  it('follows the prop when it changes — it holds no scope of its own', () => {
    mount(OTHER_PROJECT);
    expect(gapsSpy).toHaveBeenCalledWith(OTHER_PROJECT);
    // The failure this rules out is a panel that read an ambient value once and kept it.
    expect(gapsSpy).not.toHaveBeenCalledWith(PAGE_PROJECT);
  });

  it('THE EMPTY POPULATION — with no project it queries with NOTHING and says so', () => {
    mount(undefined);
    // Not "some default it found somewhere": the panel must pass its absent prop through,
    // so the query's own `enabled` gate can refuse. Substituting an ambient project here
    // is precisely the silent-wrong-project bug — it renders plausibly and never errors.
    expect(gapsSpy).toHaveBeenCalledWith(undefined);
    expect(container.textContent).toContain('Select a project');
  });

  it('never invents the `all` sentinel for a uuid-validated route', () => {
    mount(PAGE_PROJECT);
    expect(gapsSpy).not.toHaveBeenCalledWith('all');
  });
});
