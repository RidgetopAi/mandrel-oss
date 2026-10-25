/**
 * DEGENERATE-EMBEDDING CHOKE POINT — unit contract.
 *
 * THE DEFECT: an all-zero embedding is NOT NULL, so it satisfies every "already embedded"
 * check we have and is never re-embedded, while pgvector returns NaN similarity for it
 * against every query — permanently un-retrievable, permanently un-retried. A state that
 * reads as success while the guarantee is not met.
 *
 * WHAT THIS FILE PROVES (no DB — the vector-production side):
 *   1. `degeneracyOf` classifies the values that actually slip through: absent, empty,
 *      all-zero, underflow-to-zero, NaN, Infinity — AND does not flag healthy vectors.
 *   2. `normalizeEmbedding` REFUSES to manufacture a dead vector, on all three paths that
 *      used to produce one silently (empty source, zero source, downsample aliasing).
 *   3. `EmbeddingService.generateEmbedding` refuses one at the CHOKE POINT.
 *
 * WHY THIS FILE PINS GEMMA: prod runs `MANDREL_EMBEDDER=gemma`, whose spec has
 * `padToDimensions: false` — so `generateWithActiveEmbedder` returns the backend's vector
 * VERBATIM and `normalizeEmbedding` is never called on the live path. The post-condition in
 * generateEmbedding is therefore the ONLY guard standing between a degenerate model output
 * and the database in production. Testing it under minilm would prove nothing about prod,
 * because normalize's guard would fire first. (Same vi.hoisted pin + restore as
 * gemmaEmbedderSwap.contract.test.ts, so MANDREL_EMBEDDER does not leak to later files.)
 *
 * THE BACKEND IS MOCKED, THE GUARD IS NOT: CI has no Ollama daemon, and the point is not
 * "can a model emit zeros" — it is "if anything upstream ever hands us a vector with no
 * direction, does it reach the column?". The mock is the upstream; every line under test
 * (EmbeddingService, normalize, degenerate) is the real one.
 */
import { vi, describe, test, expect, afterAll } from 'vitest';

// Select gemma BEFORE embeddingConfig is imported anywhere, and capture the prior value so
// afterAll restores it (the suite runs single-fork; a leak would repoint activeEmbeddingColumn()
// for every later file). Mirrors gemmaEmbedderSwap.contract.test.ts exactly.
const PRIOR_EMBEDDER = vi.hoisted(() => {
  const previous = process.env.MANDREL_EMBEDDER;
  process.env.MANDREL_EMBEDDER = 'gemma';
  return previous;
});

/** What the mocked backend hands back. Set per test. */
const backendControl = vi.hoisted(() => ({ embedding: [] as number[] }));

vi.mock('../services/embedding/ollamaModel.js', () => ({
  generateOllamaEmbedding: vi.fn(async () => ({
    embedding: backendControl.embedding,
    dimensions: backendControl.embedding.length,
    model: 'mocked-backend',
  })),
  isOllamaAvailable: vi.fn(async () => true),
}));

import { EmbeddingService } from '../services/embedding/EmbeddingService.js';
import { degeneracyOf, isDegenerateEmbedding, assertUsableEmbedding } from '../services/embedding/degenerate.js';
import { normalizeEmbedding, applyTargetDimensions } from '../services/embedding/normalize.js';
import { activeEmbedder } from '../config/embeddingConfig.js';
import { EmbeddingError } from '../services/embedding/types.js';

const DIM = activeEmbedder().dimensions;
/** A healthy vector at the active geometry (unit on axis 0). */
const healthy = (): number[] => {
  const v = new Array(DIM).fill(0);
  v[0] = 1;
  return v;
};

afterAll(() => {
  if (PRIOR_EMBEDDER === undefined) delete process.env.MANDREL_EMBEDDER;
  else process.env.MANDREL_EMBEDDER = PRIOR_EMBEDDER;
});

describe('degeneracyOf — the values that actually slip through', () => {
  // These are the cases a past incident names explicitly: zero-length, empty, absent. A guard
  // written against "the shape I had in mind" tends to cover NaN and miss all-zeros.
  const cases: Array<{ label: string; input: number[] | null | undefined; expect: string | null }> = [
    { label: 'undefined (absent)', input: undefined, expect: 'empty' },
    { label: 'null (absent)', input: null, expect: 'empty' },
    { label: 'empty array (zero-length)', input: [], expect: 'empty' },
    { label: 'all zeros', input: new Array(DIM).fill(0), expect: 'zero-norm' },
    { label: 'negative zeros', input: new Array(DIM).fill(-0), expect: 'zero-norm' },
    { label: 'underflow to zero norm', input: [1e-200, -1e-200], expect: 'zero-norm' },
    { label: 'contains NaN', input: [1, NaN, 0], expect: 'non-finite' },
    { label: 'contains Infinity', input: [1, Infinity, 0], expect: 'non-finite' },
    { label: 'healthy unit vector', input: healthy(), expect: null },
    { label: 'tiny but real (0.001 on one axis)', input: [0.001, 0, 0], expect: null },
    { label: 'single negative component', input: [-0.5], expect: null },
    // ── THE FLOAT32 BOUNDARY (Reviewer REJECT of 403f00d) ──────────────────────────────
    // This predicate must judge the vector as the float4 COLUMN will hold it and as pgvector's
    // float32 `<#>` will square it — not as float64. These four cases are the ones a float64
    // implementation gets wrong; the DB-side half of the proof is the agreement test in
    // degenerateEmbeddingOrphan.contract.test.ts, which stores the same magnitudes.
    { label: 'BOUNDARY 1e-22 (product is a float32 subnormal)', input: new Array(DIM).fill(1e-22), expect: null },
    { label: 'BOUNDARY 1e-23 (product underflows float32)', input: new Array(DIM).fill(1e-23), expect: 'zero-norm' },
    { label: 'BAND 1e-40 (storable, but every product underflows)', input: new Array(DIM).fill(1e-40), expect: 'zero-norm' },
    { label: 'BAND 1e-100 (the component itself underflows float4)', input: new Array(DIM).fill(1e-100), expect: 'zero-norm' },
    // Finite in float64, ±Infinity once rounded to float32 — pgvector rejects it on insert, so
    // it is uncomparable at the column's precision, not merely large.
    { label: 'overflows float32 (1e39)', input: [1e39, 0, 0], expect: 'non-finite' },
  ];

  // ANTI-VACUOUS: a table that had drifted to all-healthy or all-degenerate
  // would pass every assertion below while proving only one direction.
  test('the case table exercises BOTH verdicts (guard against a vacuous table)', () => {
    expect(cases.filter((c) => c.expect !== null).length).toBeGreaterThanOrEqual(6);
    expect(cases.filter((c) => c.expect === null).length).toBeGreaterThanOrEqual(3);
  });

  for (const c of cases) {
    test(`${c.label} → ${c.expect ?? 'usable'}`, () => {
      expect(degeneracyOf(c.input)).toBe(c.expect);
      expect(isDegenerateEmbedding(c.input)).toBe(c.expect !== null);
      if (c.expect === null) {
        expect(() => assertUsableEmbedding(c.input, 'test')).not.toThrow();
      } else {
        expect(() => assertUsableEmbedding(c.input, 'test')).toThrow(EmbeddingError);
      }
    });
  }
});

describe('normalizeEmbedding — refuses to MANUFACTURE a dead vector', () => {
  // Each of these returned an all-zero array with no throw and no warning before the fix.
  // Measured on the pre-fix code: normalizeEmbedding([],1536) → 1536 zeros, norm 0.
  test('an EMPTY source is not padded into a vector of zeros', () => {
    expect(() => normalizeEmbedding([], DIM)).toThrow(/DEGENERATE/);
  });

  test('an ALL-ZERO source does not pass through as an embedding', () => {
    expect(() => normalizeEmbedding(new Array(384).fill(0), DIM)).toThrow(/DEGENERATE/);
  });

  test('DOWNSAMPLE ALIASING: a HEALTHY source that samples to nothing is rejected', () => {
    // The strongest case: the INPUT is fine and the OUTPUT is dead. Downsample takes every
    // ⌊i·step⌋-th coordinate, so a source with TWICE the target width, carrying its signal on
    // the ODD indices, aliases to all zeros. Proves the guard checks the RESULT, not the input.
    //
    // The ALIASING RELATION is what this test is about, not any particular width — so the
    // source is derived from the target rather than written as a number. It used to say 768,
    // which is also a live embedder dimension, and read as a geometry claim it never made
    //.
    const TARGET_DIM = 384;
    const SOURCE_DIM = TARGET_DIM * 2;
    const source = new Array(SOURCE_DIM).fill(0);
    for (let i = 1; i < SOURCE_DIM; i += 2) source[i] = 1;
    expect(degeneracyOf(source)).toBeNull(); // the input really is healthy
    expect(() => normalizeEmbedding(source, TARGET_DIM)).toThrow(/DEGENERATE/);
  });

  test('applyTargetDimensions no longer labels an empty vector as N-dimensional', () => {
    // Pre-fix this returned { embedding: <1536 zeros>, dimensions: 1536 } — a row claiming
    // to be embedded at full geometry while carrying nothing.
    expect(() =>
      applyTargetDimensions({ embedding: [], dimensions: 0, model: 'probe' }, 'probe', DIM),
    ).toThrow(/DEGENERATE/);
  });

  test('a HEALTHY vector still normalizes to unit length (the fix did not break the path)', () => {
    const out = normalizeEmbedding([3, 4], 2);
    expect(Math.hypot(...out)).toBeCloseTo(1, 12);
    expect(out).toEqual([0.6, 0.8]);
  });
});

describe('EmbeddingService.generateEmbedding — the CHOKE POINT every write passes through', () => {
  test('prod geometry confirms normalize CANNOT be the guard here (padToDimensions=false)', () => {
    // The premise of this describe block, asserted rather than assumed: under gemma the
    // backend vector is returned verbatim, so the post-condition in generateEmbedding is the
    // only thing standing between a dead vector and the database.
    expect(activeEmbedder().key).toBe('gemma');
    expect(activeEmbedder().backend).toBe('ollama');
    expect(activeEmbedder().padToDimensions).toBe(false);
  });

  test('POSITIVE CONTROL: a healthy backend vector is returned normally', async () => {
    backendControl.embedding = healthy();
    const svc = new EmbeddingService();
    const result = await svc.generateEmbedding({ text: 'a perfectly ordinary capture', role: 'document' });
    expect(result.embedding.length).toBe(DIM);
    expect(degeneracyOf(result.embedding)).toBeNull();
    expect(svc.getMetrics().successfulRequests).toBe(1);
    expect(svc.getMetrics().failedRequests).toBe(0);
  });

  test('an ALL-ZERO backend vector THROWS instead of being returned as an embedding', async () => {
    backendControl.embedding = new Array(DIM).fill(0);
    const svc = new EmbeddingService();
    await expect(
      svc.generateEmbedding({ text: 'a capture the model zeroed out', role: 'document' }),
    ).rejects.toThrow(/DEGENERATE/);
  });

  test('the refusal is counted as a FAILURE, not a success (metrics must not lie either)', async () => {
    backendControl.embedding = new Array(DIM).fill(0);
    const svc = new EmbeddingService();
    await expect(svc.generateEmbedding({ text: 'zeroed', role: 'document' })).rejects.toThrow();
    const m = svc.getMetrics();
    expect(m.successfulRequests).toBe(0);
    expect(m.failedRequests).toBe(1);
    expect(m.lastError).toMatch(/DEGENERATE/);
  });

  test('the thrown error is an EmbeddingError, so every call site degrades + alerts as usual', async () => {
    // This is what makes the fix whole-class: storeContext / updateContext / recordDecision /
    // updateDecision / backfillContexts / backfillDecisions already catch an embed throw and
    // run onEmbedFailure (LOUD warn + chat) + persist NULL + let the healer retry. The
    // guard needs no new call-site handling — only the right exception type.
    backendControl.embedding = new Array(DIM).fill(0);
    const svc = new EmbeddingService();
    await expect(svc.generateEmbedding({ text: 'zeroed', role: 'document' })).rejects.toBeInstanceOf(
      EmbeddingError,
    );
  });

  // DEFENCE IN DEPTH, NOT A REACHABLE PROD PATH (Reviewer N3): the real ollama client already
  // throws on an empty response before returning, so this state cannot arrive from the live
  // backend today. It is asserted because the choke point must not DEPEND on that upstream check
  // — zero-length is the classic slip-through, and a future backend need not reject it.
  test('an empty backend vector is refused too (zero-length is the classic slip-through)', async () => {
    backendControl.embedding = [];
    const svc = new EmbeddingService();
    await expect(svc.generateEmbedding({ text: 'nothing came back', role: 'document' })).rejects.toThrow(
      /DEGENERATE|empty/i,
    );
  });
});
