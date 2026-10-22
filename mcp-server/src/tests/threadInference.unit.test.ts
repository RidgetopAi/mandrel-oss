/**
 * WRITE-TIME NO-ORPHAN INFERENCE — DB-backed contract test for inferAndMintRelatedTo
 * (branch:mandrel-reliability, task ST-4 b5dbcb94, spec §B2/B4).
 *
 * Proves the Component-B inference helper against a real migrated Postgres (the CI
 * disposable ci_* DB): the nearest NON-ORPHAN neighbor above INFERENCE_THRESHOLD earns
 * exactly one weak `related_to` edge; below-threshold and orphan/self candidates do not;
 * re-runs dedup; a source with no embedding never throws.
 *
 * R3 — THE EMBEDDING FIXTURE (why this test is honest):
 *   The house embedding stub returns an ALL-ZEROS vector — a degenerate cosine (0/NaN)
 *   that can't exercise a threshold at all. This suite instead SEEDS controllable active-dimensional
 *   vectors DIRECTLY into contexts.embedding and computes similarity in real pgvector.
 *   The helper reuses the row's ALREADY-STORED embedding (it never re-embeds), so seeding
 *   the column is exactly what production reads — no service mock is needed or wanted.
 *
 *   The knob: pgvector `<=>` is TRUE cosine (scale-invariant), and cosine of two vectors
 *   supported on the same two axes {0,1} is just the normalized dot product. So a source
 *   fixed on axis 0 and a candidate placed at [cos θ, sin θ] on axes {0,1} have cosine
 *   similarity EXACTLY cos θ — a dial we set per candidate. `vecAtCosine(0.9)` is a
 *   neighbor at 0.9 similarity to the axis-0 source; `vecAtCosine(0.4)` sits below the
 *   0.6 default floor. Deterministic, no randomness, threshold genuinely exercised.
 *
 * ISOLATION: the candidate pool is PROJECT-WIDE, so each test runs in its OWN fresh
 * project — one test's seeded contexts can never leak into another's neighbor search.
 *
 * DB target: the disposable migrated ci_* DB from the CI gate — never production.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';
import { db } from '../config/database.js';
import { mintEdge } from '../services/links.js';
import { inferAndMintRelatedTo } from '../services/threadInference.js';
import {
  INFERENCE_THRESHOLD,
  INFERENCE_CANDIDATE_LIMIT,
} from '../config/reliableThreadingConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const CREATED_BY = 'auto:inference-test';

/** The projects created across this suite — dropped (cascade) in afterAll. */
const projectIds: string[] = [];

/**
 * R3 fixture — an active-dimensional vector whose cosine similarity to the axis-0 SOURCE vector is
 * EXACTLY `cos`. Placed on axes {0,1}: [cos, sin]. pgvector's `<=>` is true cosine
 * (scale-invariant), so this is a precise, deterministic similarity dial per candidate.
 */
function vecAtCosine(cos: number): string {
  const v = new Array(embedDim()).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return `[${v.join(',')}]`;
}

/** The SOURCE vector every candidate's cosine is measured against: the unit vector on axis 0. */
function sourceVec(): string {
  const v = new Array(embedDim()).fill(0);
  v[0] = 1;
  return `[${v.join(',')}]`;
}

async function freshProject(label: string): Promise<string> {
  const id = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'ST-4 inference fixture') RETURNING id`,
      [`st4-infer-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(id);
  return id;
}

/** Insert a context with a controlled embedding (or NULL) and return its id. */
async function insertContext(
  projectId: string,
  content: string,
  embedding: string | null
): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
       VALUES ($1, 'discussion', $2, $3::vector)
       RETURNING id::text AS id`,
      [projectId, content, embedding]
    )
  ).rows[0].id;
}

/**
 * Make a context a NON-ORPHAN by minting one real edge (context → a task) via the same
 * mintEdge the helper's candidate filter (`EXISTS a row in links`) keys off. Returns the
 * task id (an irrelevant endpoint the inference query never surfaces — it only searches
 * contexts).
 */
async function makeNonOrphan(projectId: string, ctxId: string): Promise<void> {
  const taskId = (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'anchor task', 'general', 'medium', 'todo')
       RETURNING id::text AS id`,
      [projectId]
    )
  ).rows[0].id;
  await mintEdge(
    {
      fromId: ctxId,
      fromType: 'context',
      toId: taskId,
      toType: 'task',
      edgeType: 'informs',
      projectId,
      createdBy: 'test-setup',
      via: EDGE_MINT_VIA.tag,
    },
    db
  );
}

/** All `related_to` edges OUT of a context (the edges inference is allowed to mint). */
async function relatedToEdges(fromId: string): Promise<Array<{ to_id: string }>> {
  return (
    await db.query(
      `SELECT to_id FROM links WHERE from_id = $1 AND edge_type = 'related_to'`,
      [fromId]
    )
  ).rows;
}

describe('inferAndMintRelatedTo — write-time no-orphan inference (ST-4)', () => {
  beforeAll(() => {
    // Guard the fixture against a drifted config: the whole test is written around the
    // 0.6 default floor + single-candidate default. If those move, the assertions below
    // (0.9 mints, 0.4 doesn't) must be re-derived — fail loudly rather than silently pass.
    expect(INFERENCE_THRESHOLD, 'test assumes the default 0.6 inference floor').toBe(0.6);
    expect(INFERENCE_CANDIDATE_LIMIT, 'test assumes the default single-candidate limit').toBe(1);
  });

  afterAll(async () => {
    for (const pid of projectIds) {
      try {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      } catch {
        /* ignore teardown noise */
      }
    }
    await db.end();
  });

  test('near non-orphan (cos 0.9 ≥ 0.6) → mints exactly ONE related_to to it', async () => {
    const pid = await freshProject('near');
    const neighbor = await insertContext(pid, 'the reachable neighbor', vecAtCosine(0.9));
    await makeNonOrphan(pid, neighbor);
    const source = await insertContext(pid, 'the freshly stored context', sourceVec());

    const res = await inferAndMintRelatedTo(
      { fromId: source, projectId: pid, createdBy: CREATED_BY },
      db
    );

    expect(res.reason).toBe('minted');
    expect(res.minted).toBe(true);
    expect(res.candidateId).toBe(neighbor);
    expect(res.similarity).toBeCloseTo(0.9, 5);

    // Exactly ONE related_to edge, pointing at the neighbor.
    const edges = await relatedToEdges(source);
    expect(edges.length).toBe(1);
    expect(edges[0].to_id).toBe(neighbor);
  });

  test('below threshold (cos 0.4 < 0.6) → NO edge, reason no-neighbor-above-threshold', async () => {
    const pid = await freshProject('below');
    const neighbor = await insertContext(pid, 'a distant but reachable neighbor', vecAtCosine(0.4));
    await makeNonOrphan(pid, neighbor);
    const source = await insertContext(pid, 'the freshly stored context (far away)', sourceVec());

    const res = await inferAndMintRelatedTo(
      { fromId: source, projectId: pid, createdBy: CREATED_BY },
      db
    );

    expect(res.minted).toBe(false);
    expect(res.reason).toBe('no-neighbor-above-threshold');
    // The best-below-floor candidate is still surfaced (for the honest "unthreaded" log).
    expect(res.candidateId).toBe(neighbor);
    expect(res.similarity).toBeCloseTo(0.4, 5);

    expect((await relatedToEdges(source)).length).toBe(0);
  });

  test('candidate pool EXCLUDES orphans and self (a nearer orphan is NOT chosen)', async () => {
    const pid = await freshProject('orphan');
    // A NEARER neighbor (cos 0.95) but an ORPHAN — must NOT be chosen despite being closer.
    const nearerOrphan = await insertContext(pid, 'nearer but orphan', vecAtCosine(0.95));
    // A slightly-farther NON-ORPHAN (cos 0.7 ≥ 0.6) — the correct, reachable pick.
    const reachable = await insertContext(pid, 'farther but reachable', vecAtCosine(0.7));
    await makeNonOrphan(pid, reachable);
    const source = await insertContext(pid, 'the source seeking a reachable neighbor', sourceVec());

    const res = await inferAndMintRelatedTo(
      { fromId: source, projectId: pid, createdBy: CREATED_BY },
      db
    );

    expect(res.reason).toBe('minted');
    expect(res.candidateId, 'must skip the nearer ORPHAN and pick the reachable one').toBe(reachable);
    expect(res.candidateId).not.toBe(nearerOrphan);
    expect(res.similarity).toBeCloseTo(0.7, 5);

    const edges = await relatedToEdges(source);
    expect(edges.length).toBe(1);
    expect(edges[0].to_id).toBe(reachable);
    // And never a self-edge (source excluded from its own candidate pool).
    expect(edges.some((e) => e.to_id === source)).toBe(false);
  });

  test('re-run is idempotent (no duplicate edge)', async () => {
    const pid = await freshProject('idem');
    const neighbor = await insertContext(pid, 'the reachable neighbor', vecAtCosine(0.9));
    await makeNonOrphan(pid, neighbor);
    const source = await insertContext(pid, 'the freshly stored context', sourceVec());

    const first = await inferAndMintRelatedTo(
      { fromId: source, projectId: pid, createdBy: CREATED_BY },
      db
    );
    expect(first.minted).toBe(true);

    // Second identical run: the edge already exists → dedup → minted:false, still 'minted' reason.
    const second = await inferAndMintRelatedTo(
      { fromId: source, projectId: pid, createdBy: CREATED_BY },
      db
    );
    expect(second.minted).toBe(false);
    expect(second.candidateId).toBe(neighbor);
    expect(second.reason).toBe('minted');

    // Still exactly ONE edge — no duplicate.
    expect((await relatedToEdges(source)).length).toBe(1);
  });

  test('source with no embedding → no throw, reason source-has-no-embedding', async () => {
    const pid = await freshProject('noembed');
    // A perfectly good non-orphan neighbor exists — but the SOURCE has no embedding.
    const neighbor = await insertContext(pid, 'a reachable neighbor', vecAtCosine(0.9));
    await makeNonOrphan(pid, neighbor);
    const source = await insertContext(pid, 'the source with no embedding', null);

    const res = await inferAndMintRelatedTo(
      { fromId: source, projectId: pid, createdBy: CREATED_BY },
      db
    );

    expect(res.minted).toBe(false);
    expect(res.reason).toBe('source-has-no-embedding');
    expect((await relatedToEdges(source)).length).toBe(0);
  });
});
