/**
 * SILENT ORPHAN: a degenerate (zero-norm) embedding — DB CONTRACT.
 *
 * Runs against the disposable migrated CI DB with REAL pgvector, because every claim here is
 * a claim about what pgvector does. Measured on this exact setup before the fix:
 *
 *   - `WHERE <col> IS NULL` (the ONE "already embedded" gate, shared by the CLI backfill and
 *     the self-heal worker) selected the NULL row and NOT the zero-vector row → the zero row
 *     looked embedded forever.
 *   - ranked against a healthy query vector: healthy row sim=1, neighbour sim=0.9,
 *     zero row sim=NaN → dropped by any min-similarity filter. Invisible to recall.
 *   - `inferAndMintRelatedTo` on a zero-embedding source, with a genuine 0.9-similar
 *     neighbour in the pool, returned
 *       {minted:false, candidateId:'an earlier change…', similarity:null, reason:'no-neighbor-above-threshold'}
 *     — it named a "best" candidate that was never ranked (every distance was NaN, so the row
 *     order was arbitrary), reported `similarity:null` over the wire, and blamed the
 *     neighbourhood for a defect in the capture's own vector.
 *   - the zero-candidate case (`!best`) returned that SAME reason string, so a broken
 *     candidate query was indistinguishable from an honest below-floor result.
 *
 * THE MOCKED EMBEDDER is only the source of replacement vectors for the heal test; every
 * predicate, query and reason under test is the real product code.
 */
import { vi, describe, test, expect, afterAll } from 'vitest';

// A working embedder for the HEAL half of the test (the backfill calls it to replace a
// degenerate vector). Returns a valid unit vector at the active geometry.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => {
      const { activeEmbedder } = await import('../config/embeddingConfig.js');
      const dims = activeEmbedder().dimensions;
      const v = new Array(dims).fill(0);
      v[1] = 1; // deliberately a DIFFERENT axis from the seeded fixtures, so a healed row is
      return { embedding: v, dimensions: dims, model: 'heal-mock' }; // provably new, not retained
    }),
  },
}));

import { db } from '../config/database.js';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';
import { degeneracyOf, degenerateEmbeddingSql } from '../services/embedding/degenerate.js';
import { inferAndMintRelatedTo } from '../services/threadInference.js';
import { backfillContexts } from '../services/reembedBackfill.js';
import { backfillOrphanThreads, unrescuableBreakdown } from '../services/orphanBackfill.js';
import { mintEdge } from '../services/links.js';
import { ContextRoutes } from '../routes/context.routes.js';
import { INFERENCE_THRESHOLD } from '../config/reliableThreadingConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const CREATED_BY = 'auto:degenerate-test';
const projectIds: string[] = [];

/** A vector at the active geometry from a per-index generator. */
const vec = (f: (i: number) => number): number[] => new Array(embedDim()).fill(0).map((_v, i) => f(i));
const literal = (v: number[]): string => `[${v.join(',')}]`;

/** The zero vector — NOT NULL, no direction, uncomparable. The subject of this file. */
const ZERO = vec(() => 0);
/** The unit vector on axis 0 — the SOURCE every cosine below is measured against. */
const AXIS0 = vec((i) => (i === 0 ? 1 : 0));
/** A vector whose cosine to AXIS0 is exactly `cos` (placed on axes {0,1}). */
const atCosine = (cos: number): number[] =>
  vec((i) => (i === 0 ? cos : i === 1 ? Math.sqrt(Math.max(0, 1 - cos * cos)) : 0));

async function freshProject(label: string): Promise<string> {
  const id = (await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'degenerate-embedding fixture') RETURNING id`,
    [`degen-${label}-${STAMP}`],
  )).rows[0].id;
  projectIds.push(id);
  return id;
}

async function insertContext(projectId: string, content: string, embedding: number[] | null): Promise<string> {
  return (await db.query(
    `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
     VALUES ($1, 'discussion', $2, $3::vector) RETURNING id::text AS id`,
    [projectId, content, embedding === null ? null : literal(embedding)],
  )).rows[0].id;
}

/** Give a context one real edge so the inference candidate filter (EXISTS in links) admits it. */
async function makeNonOrphan(projectId: string, ctxId: string): Promise<void> {
  const taskId = (await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status)
     VALUES ($1, 'anchor task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
    [projectId],
  )).rows[0].id;
  await mintEdge(
    { fromId: ctxId, fromType: 'context', toId: taskId, toType: 'task',
      edgeType: 'informs', projectId, createdBy: 'test-setup', via: EDGE_MINT_VIA.tag },
    db,
  );
}

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* teardown noise */ }
  }
  await db.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('the JS predicate and the SQL predicate are ONE rule', () => {
  // The rule "this vector cannot be compared" is written twice — once in TypeScript to stop a
  // dead vector being WRITTEN, once in SQL to find the ones already written. Two copies that
  // agree today and can be weakened independently is the exact failure shape a past incident
  // describes. So: hand the SAME vectors to BOTH and require an identical verdict. Weaken
  // either side and this goes RED.
  // THE BOUNDARY FIXTURES ARE THE POINT. The first version of this set bottomed out at 1e-6 —
  // seventeen orders of magnitude away from where the two implementations actually part company
  // — so it "proved agreement" while sampling only the easy middle. `degeneracyOf` evaluated in
  // float64 and pgvector evaluates in float32, and every STORABLE vector between ~1e-23 and
  // ~1e-161 per component got opposite verdicts (Reviewer REJECT of 403ef00; the band is
  // reproduced in this file's sibling probe and documented in degenerate.ts).
  //
  // 1e-22 and 1e-23 STRADDLE the float32 underflow edge: (1e-22)² = 1e-44 is a representable
  // float32 subnormal, (1e-23)² = 1e-46 is below the smallest one (~1.4e-45) and becomes 0. So
  // these two adjacent fixtures pin the exact boundary from BOTH sides — move either
  // implementation's arithmetic and one of them flips.
  const fixtures: Array<{ label: string; v: number[] }> = [
    { label: 'all zeros', v: ZERO },
    { label: 'negative zeros', v: vec(() => -0) },
    { label: 'unit on axis 0', v: AXIS0 },
    { label: 'cos 0.4 neighbour', v: atCosine(0.4) },
    { label: 'tiny but real (1e-6 on one axis)', v: vec((i) => (i === 0 ? 1e-6 : 0)) },
    { label: 'dense small values', v: vec(() => 0.001) },
    { label: 'single negative component', v: vec((i) => (i === 0 ? -1 : 0)) },
    // ── the float32 underflow boundary, from both sides ──
    { label: 'BOUNDARY dense 1e-22 (product is a float32 subnormal → usable)', v: vec(() => 1e-22) },
    { label: 'BOUNDARY dense 1e-23 (product underflows float32 → zero-norm)', v: vec(() => 1e-23) },
    { label: 'BOUNDARY single 1e-22 component', v: vec((i) => (i === 0 ? 1e-22 : 0)) },
    { label: 'BOUNDARY single 1e-23 component', v: vec((i) => (i === 0 ? 1e-23 : 0)) },
    // Deep in the old disagreement band: the COMPONENT itself underflows float4, so the column
    // literally holds zeros while a float64 reader still sees a non-zero array.
    { label: 'BAND dense 1e-100 (stored as zeros by float4)', v: vec(() => 1e-100) },
    { label: 'BAND dense 1e-40 (stored, but every product underflows)', v: vec(() => 1e-40) },
  ];

  test('the fixture set contains BOTH degenerate and healthy vectors (anti-vacuous)', () => {
    // Without this, a fixture list that drifted to all-healthy would "prove agreement" while
    // never exercising the degenerate verdict at all — the empty-population trap.
    expect(fixtures.filter((f) => degeneracyOf(f.v) !== null).length).toBeGreaterThanOrEqual(2);
    expect(fixtures.filter((f) => degeneracyOf(f.v) === null).length).toBeGreaterThanOrEqual(4);
  });

  test('the set actually STRADDLES the float32 boundary (anti-vacuous, second axis)', () => {
    // The anti-vacuous check above counts degenerate-vs-healthy, which a set of easy fixtures
    // far from the boundary satisfies perfectly — that is exactly how the first version passed.
    // This pins the property that matters: two fixtures one order of magnitude apart, on
    // OPPOSITE sides of the edge. Drop either and this goes RED (probed).
    const near = fixtures.find((f) => f.label.startsWith('BOUNDARY dense 1e-22'));
    const past = fixtures.find((f) => f.label.startsWith('BOUNDARY dense 1e-23'));
    expect(near, 'the just-usable side of the float32 boundary must be covered').toBeDefined();
    expect(past, 'the just-degenerate side of the float32 boundary must be covered').toBeDefined();
    expect(degeneracyOf(near!.v)).toBeNull();
    expect(degeneracyOf(past!.v)).toBe('zero-norm');
  });

  test('the zero verdict does not depend on summation ORDER (why float32 parity is enough)', () => {
    // degeneracyOf sums sequentially; pgvector 0.8.3 sums with SIMD lane partials, so the two
    // do NOT produce the same number in the normal range. The agreement rests on a different
    // property: every term is a square, so the sum is 0 iff every term is 0 — order-independent.
    // Assert that property directly rather than asserting an equality that does not hold.
    for (const f of fixtures) {
      const forward = degeneracyOf(f.v);
      const reversed = degeneracyOf([...f.v].reverse());
      const shuffled = degeneracyOf([...f.v].sort((a, b) => a - b));
      expect(reversed, `verdict flipped when reversed: ${f.label}`).toBe(forward);
      expect(shuffled, `verdict flipped when reordered: ${f.label}`).toBe(forward);
    }
  });

  test('real pgvector agrees with degeneracyOf on every fixture', async () => {
    const pid = await freshProject('agreement');
    for (const f of fixtures) {
      const id = await insertContext(pid, `agreement fixture: ${f.label}`, f.v);
      const sqlVerdict: boolean = (await db.query(
        `SELECT ${degenerateEmbeddingSql(activeEmbeddingColumn())} AS degenerate FROM contexts WHERE id = $1`,
        [id],
      )).rows[0].degenerate;
      const jsVerdict = degeneracyOf(f.v) !== null;
      expect(sqlVerdict, `SQL and JS disagree on "${f.label}"`).toBe(jsVerdict);
    }
  });

  test('a degenerate vector really IS invisible to semantic recall (the reason any of this matters)', async () => {
    const pid = await freshProject('recall');
    await insertContext(pid, 'healthy row', AXIS0);
    const deadId = await insertContext(pid, 'degenerate row', ZERO);

    const ranked = (await db.query(
      `SELECT id::text AS id, 1 - (${activeEmbeddingColumn()} <=> $1::vector) AS sim
         FROM contexts WHERE project_id = $2 AND ${activeEmbeddingColumn()} IS NOT NULL`,
      [literal(AXIS0), pid],
    )).rows;

    const dead = ranked.find((r) => r.id === deadId);
    expect(Number.isFinite(Number(dead.sim))).toBe(false); // NaN — no score at all
    const healthy = ranked.find((r) => r.id !== deadId);
    expect(Number(healthy.sim)).toBeCloseTo(1, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('DEFECT 1 — a degenerate row no longer "looks embedded forever"', () => {
  test('the needs-reembed gate SELECTS a degenerate row (it used to select only NULLs)', async () => {
    const pid = await freshProject('gate');
    await insertContext(pid, 'row with a NULL embedding', null);
    await insertContext(pid, 'row with a DEGENERATE embedding', ZERO);
    await insertContext(pid, 'row with a healthy embedding', AXIS0);

    // apply:false → pure SELECTION measurement, the embedder is never called.
    const stats = await backfillContexts(
      pid,
      { apply: false, force: false, batchSize: 100, allProjects: false, understandTarget: false },
      db,
    );
    // The NULL row and the degenerate row; NOT the healthy one. Pre-fix this was 1.
    expect(stats.total).toBe(2);
  });

  test('and it is then actually RE-EMBEDDED (detectable AND fixable, not just detectable)', async () => {
    const pid = await freshProject('heal');
    const deadId = await insertContext(pid, 'a capture whose vector died', ZERO);

    const before = (await db.query(
      `SELECT ${degenerateEmbeddingSql(activeEmbeddingColumn())} AS degenerate FROM contexts WHERE id = $1`,
      [deadId],
    )).rows[0].degenerate;
    expect(before).toBe(true);

    await backfillContexts(
      pid,
      { apply: true, force: false, batchSize: 100, allProjects: false, understandTarget: false },
      db,
    );

    const after = (await db.query(
      `SELECT ${degenerateEmbeddingSql(activeEmbeddingColumn())} AS degenerate,
              (${activeEmbeddingColumn()} IS NULL) AS is_null
         FROM contexts WHERE id = $1`,
      [deadId],
    )).rows[0];
    expect(after.is_null).toBe(false);
    expect(after.degenerate).toBe(false); // a real vector now — retrievable again
  });

  test('a healthy row is NOT churned by the gate (the fix did not widen into a re-embed-everything)', async () => {
    const pid = await freshProject('nochurn');
    await insertContext(pid, 'perfectly good row', AXIS0);
    const stats = await backfillContexts(
      pid,
      { apply: false, force: false, batchSize: 100, allProjects: false, understandTarget: false },
      db,
    );
    expect(stats.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('DEFECT 2 — the miss path reports what is TRUE', () => {
  test('a degenerate SOURCE is reported as degenerate, not as "no neighbour was close enough"', async () => {
    const pid = await freshProject('degen-source');
    // A genuinely close neighbour exists — so "no neighbour ≥ threshold" would be a lie about
    // the neighbourhood as well as about the comparison.
    const neighbour = await insertContext(pid, 'a very close reachable neighbour', atCosine(0.9));
    await makeNonOrphan(pid, neighbour);
    const source = await insertContext(pid, 'a capture whose own vector is dead', ZERO);

    const res = await inferAndMintRelatedTo({ fromId: source, projectId: pid, createdBy: CREATED_BY }, db);

    expect(res.reason).toBe('source-embedding-degenerate');
    expect(res.minted).toBe(false);
    // It must NOT name a "best" candidate it never actually ranked...
    expect(res.candidateId).toBeUndefined();
    // ...nor report a similarity. NaN serialises to null over the wire and would read as an
    // ordinary absent score — the precise shape of the measured lie.
    expect(res.similarity).toBeUndefined();
    expect(JSON.parse(JSON.stringify(res))).toEqual({
      minted: false,
      reason: 'source-embedding-degenerate',
    });
  });

  test('ZERO CANDIDATES gets its own reason (a broken pool is no longer disguised as a near-miss)', async () => {
    const pid = await freshProject('no-candidates');
    const lonely = await insertContext(pid, 'the only context in the project', AXIS0);

    const res = await inferAndMintRelatedTo({ fromId: lonely, projectId: pid, createdBy: CREATED_BY }, db);

    expect(res.reason).toBe('no-candidates');
    expect(res.candidateId).toBeUndefined();
    expect(res.similarity).toBeUndefined();
  });

  test('a degenerate CANDIDATE yields "not comparable", never a silent below-threshold', async () => {
    const pid = await freshProject('degen-candidate');
    const deadNeighbour = await insertContext(pid, 'a reachable neighbour with a dead vector', ZERO);
    await makeNonOrphan(pid, deadNeighbour);
    const source = await insertContext(pid, 'a perfectly healthy capture', AXIS0);

    const res = await inferAndMintRelatedTo({ fromId: source, projectId: pid, createdBy: CREATED_BY }, db);

    expect(res.reason).toBe('similarity-not-comparable');
    expect(res.minted).toBe(false);
    expect(res.similarity).toBeUndefined(); // no NaN → no fake "null score"
    // NaN sorts LAST in Postgres ASC, so reaching this branch means every candidate scored
    // non-finite and the top row is an arbitrary pick. Naming it would re-create the very lie
    // this task killed (a "best" candidate that no comparison chose), so it is not returned.
    expect(res.candidateId).toBeUndefined();
    expect(JSON.parse(JSON.stringify(res))).toEqual({
      minted: false,
      reason: 'similarity-not-comparable',
    });
  });

  test('an HONEST below-floor miss still reports below-floor, with its real score (floor untouched)', async () => {
    // The floor is not weakened and the ordinary case is not re-labelled: the new reasons name
    // situations that were never actually below-threshold, and nothing else moves.
    const pid = await freshProject('below-floor');
    const neighbour = await insertContext(pid, 'a distant but reachable neighbour', atCosine(0.4));
    await makeNonOrphan(pid, neighbour);
    const source = await insertContext(pid, 'a healthy but isolated capture', AXIS0);

    const res = await inferAndMintRelatedTo({ fromId: source, projectId: pid, createdBy: CREATED_BY }, db);

    expect(INFERENCE_THRESHOLD).toBe(0.6); // fixture assumption, stated not assumed
    expect(res.reason).toBe('no-neighbor-above-threshold');
    expect(res.candidateId).toBe(neighbour);
    expect(res.similarity).toBeCloseTo(0.4, 5);
  });

  test('a good neighbour STILL mints (the guard did not break the happy path)', async () => {
    const pid = await freshProject('happy');
    const neighbour = await insertContext(pid, 'a close reachable neighbour', atCosine(0.9));
    await makeNonOrphan(pid, neighbour);
    const source = await insertContext(pid, 'a healthy capture near it', AXIS0);

    const res = await inferAndMintRelatedTo({ fromId: source, projectId: pid, createdBy: CREATED_BY }, db);

    expect(res.reason).toBe('minted');
    expect(res.minted).toBe(true);
    expect(res.candidateId).toBe(neighbour);
    expect(res.similarity).toBeCloseTo(0.9, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('DEFECT 3 — distinct causes are no longer collapsed into one number', () => {
  test('the orphan backfill tallies a degenerate orphan separately from a below-floor one', async () => {
    const pid = await freshProject('tally');
    const projectName = `degen-tally-${STAMP}`;
    // A reachable neighbour at cos 0.4 → an honest below-floor miss for the healthy orphan.
    const neighbour = await insertContext(pid, 'a distant reachable neighbour', atCosine(0.4));
    await makeNonOrphan(pid, neighbour);

    await insertContext(pid, 'orphan A: healthy vector, nothing close enough', AXIS0);
    await insertContext(pid, 'orphan B: DEGENERATE vector', ZERO);
    await insertContext(pid, 'orphan C: no vector at all', null);

    const summary = await backfillOrphanThreads(
      { projectId: pid, projectName, dryRun: true, threshold: INFERENCE_THRESHOLD },
      db,
    );

    expect(summary.unrescuable).toBe(3);
    expect(summary.noNeighbor).toBe(1);          // orphan A — genuinely below the floor
    expect(summary.degenerateEmbedding).toBe(1); // orphan B — a BROKEN row, not a lonely one
    expect(summary.noEmbedding).toBe(1);         // orphan C — never embedded
    expect(summary.errors).toBe(0);
    // Pre-fix, A + B would BOTH have landed in noNeighbor via the catch-all `else`.
  });

  test('the OPERATOR REPORT accounts for every cause (it printed 3 of 6 before)', async () => {
    // Splitting the causes apart is only half the fix: the CLI's printer hand-listed three
    // buckets, so a summary with six would have shown "Un-rescuable: N" above a breakdown that
    // silently summed to less. The breakdown is now derived from the summary in one place.
    const pid = await freshProject('report');
    const neighbour = await insertContext(pid, 'a distant reachable neighbour', atCosine(0.4));
    await makeNonOrphan(pid, neighbour);
    await insertContext(pid, 'orphan: healthy but too far', AXIS0);
    await insertContext(pid, 'orphan: degenerate vector', ZERO);
    await insertContext(pid, 'orphan: no vector', null);

    const summary = await backfillOrphanThreads(
      { projectId: pid, projectName: `degen-report-${STAMP}`, dryRun: true, threshold: INFERENCE_THRESHOLD },
      db,
    );
    const parts = unrescuableBreakdown(summary);

    // Every cause the summary can report has a labelled line...
    expect(parts.length).toBe(6);
    // ...and the parts RECONCILE with the total, so nothing is silently unaccounted for.
    expect(parts.reduce((t, p) => t + p.count, 0)).toBe(summary.unrescuable);
    expect(parts.find((p) => p.label === 'degenerate embedding')?.count).toBe(1);
  });

  test('the reconciliation FAILS LOUD when a cause goes unaccounted for', () => {
    // Probe the guard, not just the product (a past incident rule 7): a breakdown that quietly
    // returned a subset would satisfy the test above's `.length` check only by luck. Hand it a
    // summary whose total exceeds its parts — the exact shape of a bucket the printer forgot.
    const orphaned = {
      unrescuable: 4, noNeighbor: 1, noCandidates: 0, noEmbedding: 1,
      degenerateEmbedding: 0, notComparable: 0, errors: 0,
    } as unknown as Parameters<typeof unrescuableBreakdown>[0];
    expect(() => unrescuableBreakdown(orphaned)).toThrow(/does not reconcile/);
  });

  test('a lonely project reports noCandidates, not "no neighbour was close enough"', async () => {
    const pid = await freshProject('tally-lonely');
    await insertContext(pid, 'the only context, and it is an orphan', AXIS0);

    const summary = await backfillOrphanThreads(
      { projectId: pid, projectName: `degen-lonely-${STAMP}`, dryRun: true, threshold: INFERENCE_THRESHOLD },
      db,
    );

    expect(summary.unrescuable).toBe(1);
    expect(summary.noCandidates).toBe(1);
    expect(summary.noNeighbor).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('what the CALLER is told (the sentence is the deliverable)', () => {
  // The route renders the reason into the line a human reads. A truthful reason that gets
  // rendered by a catch-all "no neighbor ≥ threshold" branch is still a lie at the surface.
  test('a degenerate source is described as uncomparable, and never as a threshold miss', () => {
    const line = ContextRoutes.inferenceLineFor({ minted: false, reason: 'source-embedding-degenerate' });
    expect(line).toMatch(/degenerate/i);
    expect(line).not.toMatch(/threshold \d/i);
  });

  test('zero candidates is described as nothing-to-compare, and never as a threshold miss', () => {
    const line = ContextRoutes.inferenceLineFor({ minted: false, reason: 'no-candidates' });
    expect(line).toMatch(/no candidate/i);
    expect(line).not.toMatch(/threshold \d/i);
  });

  test('a non-comparable similarity says so', () => {
    const line = ContextRoutes.inferenceLineFor({ minted: false, reason: 'similarity-not-comparable' });
    expect(line).toMatch(/could NOT be computed/i);
    expect(line).not.toMatch(/threshold \d/i);
  });

  test('an honest below-floor miss still names the threshold and the real best score', () => {
    const line = ContextRoutes.inferenceLineFor({
      minted: false, reason: 'no-neighbor-above-threshold', candidateId: 'abc', similarity: 0.42,
    });
    expect(line).toMatch(/no neighbor ≥ threshold 0\.6/);
    expect(line).toMatch(/best sim 0\.420/);
  });

  test('a NaN similarity is never rendered as a score, whatever the reason', () => {
    // Defence in depth: if a NaN ever reaches the renderer, it must not print "sim NaN" or
    // pretend a measurement happened.
    const line = ContextRoutes.inferenceLineFor({
      minted: false, reason: 'no-neighbor-above-threshold', similarity: NaN,
    });
    expect(line).not.toMatch(/NaN/);
    expect(line).not.toMatch(/sim /);
  });

  test('every reason renders a distinct, non-empty sentence (no reason falls into another\'s text)', () => {
    const reasons = [
      'minted', 'no-neighbor-above-threshold', 'no-candidates', 'source-has-no-embedding',
      'source-embedding-degenerate', 'similarity-not-comparable', 'error',
    ] as const;
    const lines = reasons.map((r) =>
      ContextRoutes.inferenceLineFor({ minted: false, reason: r, candidateId: 'abc' }),
    );
    for (const l of lines) expect(l.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(reasons.length);
  });
});
