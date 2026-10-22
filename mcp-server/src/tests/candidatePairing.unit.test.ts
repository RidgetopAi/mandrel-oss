/**
 * candidatePairing (Stage-1 picker) — PURE unit tests, NO DB, NO LLM.
 *
 * Locks the ANTI-JUNK nomination logic added 2026-07-06 after the
 * decision-run (137c26bf) proved the PICKER — not the model — was the flag-storm source:
 * the raw nomination was dominated by periodic auto-records + near-identical restatements,
 * and the over-eager judge false-fired supersedes on that junk. Three config-driven guards
 * were added; these tests go RED if any is reverted:
 *
 *   1. AUTO-RECORD source exclusion — a source whose metadata->>'kind' is in
 *      cfg.pairExcludeAutoRecordKinds is dropped BEFORE any neighbour query (short-circuit).
 *   2. Neighbour BAND + auto-record exclusion — the neighbour query carries the cosine
 *      CEILING (pairMaxCosine, `<= $6`), the kind exclusion (`<> ALL($7)`), and the
 *      content-PREFIX exclusion (`NOT ... ILIKE ANY($8)`) alongside the floor, with the exact
 *      config values wired into the params.
 *   3. Empty exclude list is a genuine no-op (the documented OFF switch) — an auto-record
 *      source is NOT short-circuited when the list is empty.
 *   4. CONTENT-PREFIX source exclusion — a source whose CONTENT starts with a
 *      cfg.pairExcludeContentPrefixes entry (a legacy untagged auto-record, e.g. a "Picked by
 *      priority…" scoper snapshot) is dropped BEFORE any neighbour query, and the neighbour
 *      query carries the matching `ILIKE prefix||'%'` patterns as $8.
 *
 * Filtering itself runs IN Postgres (findCandidates delegates the band/exclusion to SQL),
 * so — with no live DB — these tests assert the CONTRACT the SQL is built from: the exact
 * predicates + params. Reverting any guard changes that contract → the assertion fails.
 */

import { describe, test, expect } from 'vitest';
import type { Pool } from 'pg';

import { findCandidates, BeliefPairingError } from '../services/belief/candidatePairing.js';
import type { PairingSource, PairingResult } from '../services/belief/candidatePairing.js';
import type { BeliefConfig } from '../config/beliefConfig.js';
import { BELIEF_CONFIG } from '../config/beliefConfig.js';

const SRC_ID = '11111111-1111-1111-1111-111111111111';
const N1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const N2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROJECT = '99999999-9999-9999-9999-999999999999';
const EMB = '[0.1,0.2,0.3]';

interface Captured {
  sql: string;
  params: unknown[];
}

/**
 * A fake pg Pool that captures every query. The FIRST query (the source read — its SQL
 * selects `AS kind`) returns the configured source embedding + kind; every subsequent
 * (neighbour) query returns the configured neighbour rows.
 */
function fakePool(opts: {
  sourceEmbedding: string | null;
  sourceKind: string | null;
  sourceContent?: string | null;
  neighbourRows?: Array<{ id: string; content: string; created_at: Date | null; cosine: number }>;
}): { pool: Pool; captured: Captured[] } {
  const captured: Captured[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      captured.push({ sql, params });
      if (sql.includes('AS kind')) {
        return {
          rows: [
            { embedding: opts.sourceEmbedding, kind: opts.sourceKind, content: opts.sourceContent ?? null },
          ],
        };
      }
      return { rows: opts.neighbourRows ?? [] };
    },
  } as unknown as Pool;
  return { pool, captured };
}

const source: PairingSource = { id: SRC_ID, type: 'context', projectId: PROJECT };

/** Config with explicit, env-independent anti-junk knobs. */
const cfg: BeliefConfig = {
  ...BELIEF_CONFIG,
  pairMinCosine: 0.6,
  pairMaxCosine: 0.95,
  pairExcludeAutoRecordKinds: ['tick-proposal', 'dispatch-proof', 'pick-log'],
  pairExcludeContentPrefixes: ['Picked by priority'],
  pairTopK: 8,
};

/** The neighbour query is the one whose SQL is NOT the source read. */
function neighbourQueries(captured: Captured[]): Captured[] {
  return captured.filter((c) => !c.sql.includes('AS kind'));
}

describe('findCandidates — auto-record SOURCE exclusion (guard 1)', () => {
  test('an excluded-kind source short-circuits to [] and issues NO neighbour query', async () => {
    const { pool, captured } = fakePool({ sourceEmbedding: EMB, sourceKind: 'tick-proposal' });
    const out = await findCandidates(source, cfg, pool);

    expect(out).toEqual({ ok: true, candidates: [] });
    // Only the source read ran — the auto-record was dropped before any neighbour lookup.
    expect(neighbourQueries(captured)).toHaveLength(0);
  });

  test('a normal (null-kind) source is NOT short-circuited', async () => {
    const { pool, captured } = fakePool({ sourceEmbedding: EMB, sourceKind: null });
    await findCandidates(source, cfg, pool);
    expect(neighbourQueries(captured).length).toBeGreaterThan(0);
  });

  test('a non-excluded kind is NOT short-circuited', async () => {
    const { pool, captured } = fakePool({ sourceEmbedding: EMB, sourceKind: 'milestone' });
    await findCandidates(source, cfg, pool);
    expect(neighbourQueries(captured).length).toBeGreaterThan(0);
  });
});

describe('findCandidates — neighbour BAND + auto-record exclusion (guard 2)', () => {
  test('neighbour SQL carries the cosine ceiling, kind exclusion AND content-prefix exclusion', async () => {
    const { pool, captured } = fakePool({ sourceEmbedding: EMB, sourceKind: null });
    await findCandidates(source, cfg, pool);

    const q = neighbourQueries(captured)[0];
    expect(q.sql).toContain('>= $5'); // floor
    expect(q.sql).toContain('<= $6'); // CEILING (reverting the ceiling removes this)
    expect(q.sql).toContain('<> ALL($7::text[])'); // auto-record kind exclusion
    expect(q.sql).toContain('ILIKE ANY($8::text[])'); // content-prefix exclusion (reverting removes this)
  });

  test('neighbour query params wire the exact config band + exclude list + prefix patterns + topK', async () => {
    const { pool, captured } = fakePool({ sourceEmbedding: EMB, sourceKind: null });
    await findCandidates(source, cfg, pool);

    const p = neighbourQueries(captured)[0].params;
    // [ emb, projectId, srcId, srcType, minCosine, maxCosine, excludeKinds, prefixPatterns, topK ]
    expect(p[4]).toBe(0.6); // pairMinCosine
    expect(p[5]).toBe(0.95); // pairMaxCosine
    expect(p[6]).toEqual(['tick-proposal', 'dispatch-proof', 'pick-log']); // kind exclude list
    expect(p[7]).toEqual(['Picked by priority%']); // prefix → ILIKE pattern (with trailing %)
    expect(p[8]).toBe(8); // topK
  });
});

describe('findCandidates — content-PREFIX exclusion (guard 4)', () => {
  test('a source whose CONTENT starts with an excluded prefix short-circuits to [] (no neighbour query)', async () => {
    const { pool, captured } = fakePool({
      sourceEmbedding: EMB,
      sourceKind: null, // legacy untagged auto-record — no structured kind
      sourceContent: 'Picked by priority; 62 ready. v1 helper [PROXY size]: ~5 slice(s) …',
    });
    const out = await findCandidates(source, cfg, pool);

    expect(out).toEqual({ ok: true, candidates: [] });
    expect(neighbourQueries(captured)).toHaveLength(0);
  });

  test('the prefix match is case-insensitive', async () => {
    const { pool, captured } = fakePool({
      sourceEmbedding: EMB,
      sourceKind: null,
      sourceContent: 'PICKED BY PRIORITY; 3 ready.',
    });
    const out = await findCandidates(source, cfg, pool);
    expect(out).toEqual({ ok: true, candidates: [] });
    expect(neighbourQueries(captured)).toHaveLength(0);
  });

  test('a record that only MENTIONS the prefix mid-body (does not START with it) is NOT excluded', async () => {
    const { pool, captured } = fakePool({
      sourceEmbedding: EMB,
      sourceKind: null,
      sourceContent: 'ADJUDICATOR DECISION RUN … the scoper says "Picked by priority" each tick',
    });
    await findCandidates(source, cfg, pool);
    // A prefix, not a substring: this real record proceeds to neighbour nomination.
    expect(neighbourQueries(captured).length).toBeGreaterThan(0);
  });

  test('empty prefix list is a no-op — a "Picked by priority" source is NOT short-circuited', async () => {
    const offCfg: BeliefConfig = { ...cfg, pairExcludeContentPrefixes: [] };
    const { pool, captured } = fakePool({
      sourceEmbedding: EMB,
      sourceKind: null,
      sourceContent: 'Picked by priority; 5 ready.',
    });
    await findCandidates(source, offCfg, pool);
    expect(neighbourQueries(captured).length).toBeGreaterThan(0);
    // …and the empty pattern array is still passed to SQL (a vacuous `ILIKE ANY('{}')`).
    expect(neighbourQueries(captured)[0].params[7]).toEqual([]);
  });
});

describe('findCandidates — empty exclude list is a no-op OFF switch (guard 3)', () => {
  test('an auto-record source is NOT short-circuited when the exclude list is empty', async () => {
    const offCfg: BeliefConfig = { ...cfg, pairExcludeAutoRecordKinds: [] };
    const { pool, captured } = fakePool({ sourceEmbedding: EMB, sourceKind: 'tick-proposal' });
    await findCandidates(source, offCfg, pool);

    // With exclusion off, even a tick-proposal source proceeds to neighbour nomination.
    expect(neighbourQueries(captured).length).toBeGreaterThan(0);
    // …and the empty list is still passed to SQL (a vacuous `<> ALL('{}')`).
    expect(neighbourQueries(captured)[0].params[6]).toEqual([]);
  });
});

describe('findCandidates — base behaviour still holds', () => {
  test('no source embedding ⇒ [] (no neighbour query)', async () => {
    const { pool, captured } = fakePool({ sourceEmbedding: null, sourceKind: null });
    const out = await findCandidates(source, cfg, pool);
    expect(out).toEqual({ ok: true, candidates: [] });
    expect(neighbourQueries(captured)).toHaveLength(0);
  });

  test('nominated neighbours are returned sorted by cosine desc and capped at topK', async () => {
    const rows = [
      { id: N1, content: 'a', created_at: null, cosine: 0.7 },
      { id: N2, content: 'b', created_at: null, cosine: 0.9 },
    ];
    // findCandidates queries BOTH embedded tables; return the same rows for each and let
    // the global top-K cap trim. Use a topK of 2 to assert the cap.
    const { pool } = fakePool({ sourceEmbedding: EMB, sourceKind: null, neighbourRows: rows });
    const out = await findCandidates({ ...source }, { ...cfg, pairTopK: 2 }, pool);

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable — narrowing only');
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0].cosine).toBe(0.9); // sorted desc
    expect(out.candidates[0].id).toBe(N2);
    expect(out.candidates[1].cosine).toBe(0.9); // second copy from the other table (both >0.7)
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 5 — "no candidates" and "the query blew up" are DIFFERENT ANSWERS.
//
// The defect: a thrown query returned the same `[]` an empty band returns, so the whole
// neighbourhood was silently lost, the adjudicator was never consulted, and the attempt
// ledger booked the miss as `completed`. CLASSES.md C1: an instrument has three states —
// yes, no, and I-COULD-NOT-MEASURE — and folding the third onto one of the first two is the
// bug. Both directions are asserted here, and the SECOND one matters most: a fix that calls
// every empty neighbourhood a failure is worse than the bug it replaces.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe('findCandidates — a failed measurement is not an empty one (guard 5)', () => {
  /** A pool whose SOURCE read succeeds and whose NEIGHBOUR query throws (the observed flake). */
  function throwingNeighbourPool(err: Error): Pool {
    return {
      query: async (sql: string) => {
        if (sql.includes('AS kind')) {
          return { rows: [{ embedding: EMB, kind: null, content: 'a real record' }] };
        }
        throw err;
      },
    } as unknown as Pool;
  }

  test('a throwing candidate query returns ok:false naming the stage, the table and the error', async () => {
    const pool = throwingNeighbourPool(new Error('TRACE8063_FAIL'));
    const out = await findCandidates(source, cfg, pool);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable — narrowing only');
    expect(out.reason.stage).toBe('candidate_query');
    expect(out.reason.subject).toBe('contexts'); // the FIRST table, closest to the cause
    expect(out.reason.message).toContain('TRACE8063_FAIL');
    // …and the fail-open degrade is UNCHANGED: no throw, and the partial (here: nothing) is carried.
    expect(out.partial).toEqual([]);
  });

  test('a throwing SOURCE read returns ok:false at the source_row stage', async () => {
    const pool = {
      query: async () => {
        throw new Error('TRACE8063_FAIL_SOURCE');
      },
    } as unknown as Pool;
    const out = await findCandidates(source, cfg, pool);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable — narrowing only');
    expect(out.reason.stage).toBe('source_row');
    expect(out.reason.message).toContain('TRACE8063_FAIL_SOURCE');
  });

  test('the thrown ledger form carries the class + the failing table into its message', async () => {
    const e = new BeliefPairingError({
      stage: 'candidate_query',
      subject: 'technical_decisions',
      errorClass: 'error',
      message: 'relation does not exist',
    });
    expect(e.name).toBe('BeliefPairingError'); // -> belief_adjudication_attempts.error_class
    expect(e.message).toContain('candidate_query');
    expect(e.message).toContain('technical_decisions');
    expect(e.message).toContain('relation does not exist');
  });

  // THE HOLLOW DIRECTION. Every one of these is a MEASUREMENT THAT RAN and legitimately
  // found nothing. If any of them ever reports ok:false, the belief pipeline starts booking
  // healthy records as failures and the miss rate becomes noise.
  test.each([
    ['a genuinely empty band', { sourceEmbedding: EMB, sourceKind: null }],
    ['a source with no embedding', { sourceEmbedding: null, sourceKind: null }],
    ['an excluded auto-record kind', { sourceEmbedding: EMB, sourceKind: 'tick-proposal' }],
    [
      'an excluded content prefix',
      { sourceEmbedding: EMB, sourceKind: null, sourceContent: 'Picked by priority; 5 ready.' },
    ],
  ] as const)('%s is ok:true with an empty list — NOT a failure', async (_label, opts) => {
    const { pool } = fakePool({ ...opts, neighbourRows: [] });
    const out = await findCandidates(source, cfg, pool);
    expect(out).toEqual({ ok: true, candidates: [] });
  });

  test('a source row that does not exist at all is ok:true, not a failure', async () => {
    const pool = {
      query: async (sql: string) => (sql.includes('AS kind') ? { rows: [] } : { rows: [] }),
    } as unknown as Pool;
    expect(await findCandidates(source, cfg, pool)).toEqual({ ok: true, candidates: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 6 — THE COMPILER IS THE GATE, not caller discipline.
//
// Guard 5 proved the RESULT distinguishes a failed measurement from an empty one. That is
// only half the fix: while BOTH arms spelled the list `candidates`,
// `const { candidates } = await findCandidates(...)` type-checked with NO `.ok` test, so a
// call site could silently reproduce the ORIGINAL fail-open defect — a failed query reading
// exactly like an empty neighbourhood, which is the bug the whole task is about.
//
// The failure arm now names its list `partial`. This block asserts that in BOTH directions
// the compiler can check:
//   · the un-narrowed union has NO `candidates` — enforced by @ts-expect-error, which is a
//     REAL failure of `npm run type-check` (the gate's Stage 2 includes src/**) if the field
//     ever rides on both arms again;
//   · the shapes at runtime, so the assertion is not purely a comment about types.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe('findCandidates — reading the list without checking .ok does NOT compile (guard 6)', () => {
  const failingPool = {
    query: async (sql: string) => {
      if (sql.includes('AS kind')) {
        return { rows: [{ embedding: EMB, kind: null, content: 'a real record' }] };
      }
      throw new Error('TRACEA2A4_UNION_FAIL');
    },
  } as unknown as Pool;

  test('the un-narrowed union exposes no `candidates` — and the failure arm carries `partial`', async () => {
    const out: PairingResult = await findCandidates(source, cfg, failingPool);

    // THE ASSERTION. If `candidates` is ever restored to the failure arm, this destructure
    // starts compiling, the directive becomes unused, and tsc reports
    // "Unused '@ts-expect-error' directive" — a type-check RED. That is the guard.
    // @ts-expect-error — `candidates` must NOT be reachable without narrowing on `.ok`.
    const { candidates: leaked } = out;
    // …and at runtime it is genuinely absent, which is what made the old read silently empty.
    expect(leaked).toBeUndefined();

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable — narrowing only');
    expect(Object.prototype.hasOwnProperty.call(out, 'candidates')).toBe(false);
    expect(out.partial).toEqual([]);
  });

  test('the SUCCESS arm still exposes `candidates` after narrowing (the guard is not just a deletion)', async () => {
    const { pool } = fakePool({ sourceEmbedding: EMB, sourceKind: null, neighbourRows: [] });
    const out = await findCandidates(source, cfg, pool);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable — narrowing only');
    expect(out.candidates).toEqual([]);
  });
});
