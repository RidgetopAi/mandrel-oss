/**
 * THE THREE EMPTY STATES — display contract (SEARCH P2b, BUILD 5).
 *
 * ═══ THE DEFECT ═══
 * routes/search.routes.ts rendered ONE sentence for every way of getting no rows:
 *     "No results found for: X — Try broader search terms or different data sources"
 * while only `structuredContent` distinguished them. A caller reading the TEXT channel — which
 * is every human and every LLM consuming the MCP tool — was told to rephrase a question that
 * had never been asked of a working search, because every source had thrown. That is not a
 * cosmetic difference: "try broader terms" is ACTIVELY WRONG ADVICE for two of the three.
 *
 * ═══ WHAT THIS FILE ASSERTS ═══
 * That the three states produce three DIFFERENT texts, each carrying its own decisive fact,
 * in BOTH channels — and that the one piece of advice that only applies to one of them
 * appears only there. Asserted on the BYTES a caller receives, because that is the surface
 * the consumer reads (C2); the handler is stubbed so each state can be produced on demand.
 *
 * The BUILD 3 half is here too: the absent-term report must appear on a NON-empty response,
 * in both channels. A fact that exists in only one of the two is a fact half the callers
 * cannot see — which is the same defect one level down.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { fakeSmartSearchDetailed } = vi.hoisted(() => ({ fakeSmartSearchDetailed: vi.fn() }));

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
vi.mock('../services/trust.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/trust.js')>();
  return { ...actual, trustForRecords: vi.fn(async (refs: unknown[]) => refs.map(() => undefined)) };
});

import { searchRoutes } from '../routes/search.routes.js';

const textOf = (r: { content: { text?: string }[] }): string => r.content[0].text ?? '';
const sc = (r: { structuredContent?: Record<string, unknown> }): Record<string, unknown> =>
  r.structuredContent ?? {};

const BASE = {
  results: [],
  degradedSources: [] as string[],
  absentTerms: [] as { term: string; kind: string; english: boolean }[],
  emptyReason: null as null | { kind: string; vetoedBy: readonly string[] },
  lexicalSkipped: null,
};

beforeEach(() => fakeSmartSearchDetailed.mockReset());

describe('smart_search empty states (BUILD 5)', () => {
  test('NOTHING MATCHED keeps the rephrase advice', async () => {
    fakeSmartSearchDetailed.mockResolvedValue({ ...BASE, emptyReason: { kind: 'no_match', vetoedBy: [] } });
    const r = await searchRoutes.handleSmartSearch({ query: 'zebra' });
    expect(textOf(r)).toContain('No results found');
    expect(textOf(r)).toContain('Try broader search terms');
    expect(sc(r).emptyReason).toBe('no_match');
    expect(sc(r).ok).toBe(true);
  });

  test('NO RECORD OF X names the term and does NOT tell the caller to rephrase', async () => {
    fakeSmartSearchDetailed.mockResolvedValue({
      ...BASE,
      absentTerms: [{ term: 'kubernetes', kind: 'prose', english: false }],
      emptyReason: { kind: 'absent_terms', vetoedBy: ['kubernetes'] },
    });
    const r = await searchRoutes.handleSmartSearch({ query: 'the kubernetes rollout' });
    const t = textOf(r);
    expect(t).toContain('kubernetes');
    // THE DECISIVE FACT: this is an ANSWER, not a failure, so the rephrase advice is absent.
    expect(t).not.toContain('Try broader search terms');
    expect(t).toMatch(/no record of/i);
    expect(sc(r).emptyReason).toBe('absent_terms');
    expect(sc(r).vetoedBy).toEqual(['kubernetes']);
    expect(sc(r).ok).toBe(true);
  });

  test('EVERYTHING BROKE says so in the TEXT channel, and is not ok:true', async () => {
    fakeSmartSearchDetailed.mockResolvedValue({
      ...BASE,
      degradedSources: ['context', 'decision', 'task'],
      emptyReason: { kind: 'all_degraded', vetoedBy: [] },
    });
    const r = await searchRoutes.handleSmartSearch({ query: 'anything' });
    const t = textOf(r);
    // This is the whole defect: before P2b this response's text was byte-identical to the
    // "nothing matched" one above.
    expect(t).not.toContain('Try broader search terms');
    expect(t).toContain('FAILED');
    expect(t).toContain('context, decision, task');
    expect(t).toMatch(/did not run/i);
    expect(sc(r).emptyReason).toBe('all_degraded');
    // A search that could not run is NOT a successful empty result.
    expect(sc(r).ok).toBe(false);
  });

  test('the three texts are pairwise DIFFERENT — the property the defect violated', async () => {
    const states = [
      { ...BASE, emptyReason: { kind: 'no_match', vetoedBy: [] } },
      { ...BASE, emptyReason: { kind: 'absent_terms', vetoedBy: ['kubernetes'] },
        absentTerms: [{ term: 'kubernetes', kind: 'prose', english: false }] },
      { ...BASE, degradedSources: ['context'], emptyReason: { kind: 'all_degraded', vetoedBy: [] } },
    ];
    const texts: string[] = [];
    for (const s of states) {
      fakeSmartSearchDetailed.mockResolvedValue(s);
      texts.push(textOf(await searchRoutes.handleSmartSearch({ query: 'q' })));
    }
    expect(new Set(texts).size).toBe(3);
  });

  test('BUILD 3: absent terms ride BOTH channels of a NON-empty response', async () => {
    fakeSmartSearchDetailed.mockResolvedValue({
      ...BASE,
      results: [{
        id: '11111111-1111-1111-1111-111111111111', type: 'context',
        title: 'CTX', summary: 'body', relevanceScore: 0.9, source: 'lexical_search',
        metadata: { semanticScore: 0.9 },
      }],
      absentTerms: [{ term: 'encyclopedia', kind: 'prose', english: true }],
    });
    const r = await searchRoutes.handleSmartSearch({ query: 'encyclopedia CTX' });
    // TEXT channel …
    expect(textOf(r)).toContain('No record of: "encyclopedia"');
    // … and STRUCTURED channel. One without the other is the defect this build fixes.
    expect(sc(r).absentTerms).toEqual([{ term: 'encyclopedia', kind: 'prose', english: true }]);
  });

  test('a SKIPPED lexical layer says so rather than answering as if it had run', async () => {
    fakeSmartSearchDetailed.mockResolvedValue({
      ...BASE,
      absentTerms: null,
      emptyReason: { kind: 'no_match', vetoedBy: [] },
      lexicalSkipped: { reason: 'query_too_long', length: 99999, cap: 4096 },
    });
    const r = await searchRoutes.handleSmartSearch({ query: 'x'.repeat(99999) });
    expect(textOf(r)).toMatch(/Keyword matching was SKIPPED/);
    expect(sc(r).lexicalSkipped).toEqual({ reason: 'query_too_long', length: 99999, cap: 4096 });
  });
});
