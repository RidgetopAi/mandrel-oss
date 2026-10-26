/**
 * Retrieval HONESTY FLOOR + DISPLAY CONSISTENCY — unit contract
 * (an earlier task honesty floor, an earlier change display consistency)
 *
 * THE TWO BEHAVIORS UNDER TEST (no DB; pure formatting/labeling logic):
 *
 *   1. HONESTY FLOOR: when the BEST result's relevance is below the
 *      configurable floor (MANDREL_SEARCH_MIN_SIMILARITY, default 0.35), the route
 *      response prepends an honest header ("⚠️ No strong match — best NN%; …").
 *      Above the floor → NO header. Rows are never suppressed (recall untouched).
 *
 *   2. DISPLAY CONSISTENCY: context_search displays `relevance` — the
 *      sort-key score the row actually ranked on — labeled "relevance: NN%", NOT raw
 *      vector "similarity". So row #1 always shows the HIGHEST number, in agreement
 *      with the order. (Ordering itself is UNCHANGED; only the displayed number.)
 *
 * These are exercised at the ROUTE layer (the user-facing text) with the heavy deps
 * (real searchContext / DB / project resolution) stubbed, so the test is fast and
 * deterministic and asserts on exactly the bytes a caller sees. `buildHonestyHeader`
 * is also unit-tested directly for the threshold edges.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// --- Stub the heavy collaborators the routes pull in, BEFORE importing routes. ---
// We keep buildHonestyHeader REAL (it carries the floor logic) but replace the
// DB-touching searchContext / smartSearch / project resolution with controllable fakes.

const { fakeSearchContext, fakeSmartSearchDetailed, fakeCountContext } = vi.hoisted(() => {
  const fakeSearchContext = vi.fn();
  return {
    fakeSearchContext,
    fakeSmartSearchDetailed: vi.fn(),
    // context_search's semantic branch now surfaces `total` via contextHandler.countContext
    //. This display-focused test stubs the DB-touching handler, so it must
    // stub countContext too. Keep the stub HONEST: return the count of rows searchContext
    // last resolved (the page == the whole set in these fixtures), never a lying constant.
    fakeCountContext: vi.fn(async () => {
      const last = fakeSearchContext.mock.results.at(-1);
      const val = last && last.type === 'return' ? await last.value : [];
      return Array.isArray(val) ? val.length : 0;
    }),
  };
});

vi.mock('../handlers/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/context.js')>();
  return {
    ...actual, // keep the REAL buildHonestyHeader
    contextHandler: { searchContext: fakeSearchContext, countContext: fakeCountContext },
  };
});

vi.mock('../handlers/smartSearch.js', () => ({
  smartSearchHandler: { smartSearchDetailed: fakeSmartSearchDetailed },
}));

vi.mock('../handlers/project.js', () => ({
  projectHandler: {
    initializeSession: vi.fn(async () => {}),
    getCurrentProjectId: vi.fn(async () => 'proj-1'),
    getProject: vi.fn(async () => ({ id: 'proj-1' })),
  },
}));

vi.mock('../config/database.js', () => ({ db: { query: vi.fn() } }));

import { contextRoutes } from '../routes/context.routes.js';
import { searchRoutes } from '../routes/search.routes.js';
import { buildHonestyHeader } from '../handlers/context.js';

function textOf(resp: any): string {
  return resp.content[0].text as string;
}

beforeEach(() => {
  fakeSearchContext.mockReset();
  fakeSmartSearchDetailed.mockReset();
  fakeCountContext.mockClear();
});

describe('buildHonestyHeader (an earlier change floor logic, default 0.35)', () => {
  test('fires below the floor and quotes the SAME number it was given', () => {
    const header = buildHonestyHeader(20); // 20% < 35%
    expect(header).not.toBeNull();
    expect(header).toContain('No strong match');
    expect(header).toContain('best 20%');
  });

  test('does NOT fire at/above the floor', () => {
    expect(buildHonestyHeader(35)).toBeNull(); // exactly at floor → strong enough
    expect(buildHonestyHeader(80)).toBeNull();
  });

  test('no header when there are no results (undefined best)', () => {
    expect(buildHonestyHeader(undefined)).toBeNull();
  });
});

describe('context_search route (an earlier change + an earlier change)', () => {
  test('ABOVE floor: no header, and displayed number == sort order (relevance, not raw similarity)', async () => {
    // Sorted DESC by the sort key (relevance). similarity is the raw vector value
    // and intentionally DISAGREES with the order (boost/blend can move it) — the
    // display must follow `relevance`, not `similarity`.
    fakeSearchContext.mockResolvedValue([
      { id: 'c1', contextType: 'decision', content: 'top row', tags: [], createdAt: new Date(), similarity: 62.0, relevance: 88.0 },
      { id: 'c2', contextType: 'code', content: 'second row', tags: [], createdAt: new Date(), similarity: 91.0, relevance: 71.0 },
      { id: 'c3', contextType: 'planning', content: 'third row', tags: [], createdAt: new Date(), similarity: 40.0, relevance: 55.0 },
    ]);

    const text = textOf(await contextRoutes.handleSearch({ query: 'q' }));

    // No honesty header (best relevance 88% ≥ 35%).
    expect(text).not.toContain('No strong match');

    // Labeled "relevance:" not "similarity:".
    expect(text).toContain('relevance: 88.0%');
    expect(text).not.toContain('similarity:');

    // Displayed numbers are MONOTONIC NON-INCREASING down the list == sort order,
    // and they are the `relevance` values, NOT the (disagreeing) `similarity` ones.
    const shown = [...text.matchAll(/relevance: ([\d.]+)%/g)].map(m => parseFloat(m[1]));
    expect(shown).toEqual([88.0, 71.0, 55.0]);
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]).toBeLessThanOrEqual(shown[i - 1]);
    }
    // #1's displayed number is the maximum.
    expect(shown[0]).toBe(Math.max(...shown));
  });

  test('BELOW floor: honest header prepended, using the SAME number as row #1; rows NOT suppressed', async () => {
    fakeSearchContext.mockResolvedValue([
      { id: 'c1', contextType: 'discussion', content: 'weak best', tags: [], createdAt: new Date(), similarity: 18.0, relevance: 22.0 },
      { id: 'c2', contextType: 'code', content: 'weaker', tags: [], createdAt: new Date(), similarity: 12.0, relevance: 15.0 },
    ]);

    const text = textOf(await contextRoutes.handleSearch({ query: 'q' }));

    // Header present and quotes row #1's relevance (22%), not its raw similarity (18%).
    expect(text).toContain('No strong match');
    expect(text).toContain('best 22%');
    expect(text).not.toContain('best 18%');

    // Rows are still all present (labeling, not suppression → recall untouched).
    expect(text).toContain('relevance: 22.0%');
    expect(text).toContain('relevance: 15.0%');
    expect(text).toContain('Found 2 matching contexts');
  });

  test('falls back to similarity when relevance is absent (baseline-mode shape)', async () => {
    fakeSearchContext.mockResolvedValue([
      { id: 'c1', contextType: 'code', content: 'x', tags: [], createdAt: new Date(), similarity: 90.0 },
    ]);
    const text = textOf(await contextRoutes.handleSearch({ query: 'q' }));
    expect(text).toContain('relevance: 90.0%');
    expect(text).not.toContain('No strong match');
  });
});

describe('smart_search route (an earlier change floor; already display-consistent)', () => {
  test('BELOW floor: honest header prepended using best relevanceScore', async () => {
    fakeSmartSearchDetailed.mockResolvedValue({ degradedSources: [], results: [
      { type: 'context', id: 's1', title: 'A', summary: 'a', relevanceScore: 0.20, metadata: {}, source: 'semantic_search' },
      { type: 'context', id: 's2', title: 'B', summary: 'b', relevanceScore: 0.10, metadata: {}, source: 'text_matching' },
    ] });
    const text = textOf(await searchRoutes.handleSmartSearch({ query: 'q', projectId: 'proj-1' }));
    expect(text).toContain('No strong match');
    expect(text).toContain('best 20%');
    // rows not suppressed
    expect(text).toContain('Smart Search Results (2)');
  });

  test('ABOVE floor: no header', async () => {
    fakeSmartSearchDetailed.mockResolvedValue({ degradedSources: [], results: [
      { type: 'decision', id: 's1', title: 'A', summary: 'a', relevanceScore: 0.85, metadata: {}, source: 'decision_search' },
    ] });
    const text = textOf(await searchRoutes.handleSmartSearch({ query: 'q', projectId: 'proj-1' }));
    expect(text).not.toContain('No strong match');
  });
});
