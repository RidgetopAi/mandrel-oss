/**
 * ONE-TIME ORPHAN BACKFILL — DB-backed contract test for scripts/backfill-orphan-threads.ts
 * (branch:mandrel-reliability, task ST-6, spec §C1/C2/C3, §X4).
 *
 * Proves the Component-C backfill against a real migrated Postgres (the CI disposable ci_*
 * DB): it enumerates a project's orphan contexts and drives the SAME ST-4 inference helper
 * per orphan. Asserts the four required behaviors:
 *   (a) --dry-run mints ZERO edges and reports the correct projected counts;
 *   (b) a live run mints related_to to the rescuable orphans and drops the orphan count;
 *   (c) a re-run is a no-op (idempotent — 0 new edges);
 *   (d) an orphan with no neighbor ≥ threshold is REPORTED as un-rescuable, not silently dropped.
 * Plus: the --threshold override flows through to the inference floor; parseArgs' safe-by-default
 * (dry-run unless --apply) posture; project resolution by id and name.
 *
 * EMBEDDING FIXTURE (same honest approach as threadInference.unit.test.ts, R3):
 *   The house embedding stub returns all-zeros (degenerate cosine). This suite SEEDS
 *   controllable active-dimensional vectors directly into the active embedding column; the helper reuses the
 *   ALREADY-STORED embedding (never re-embeds), so seeded == what production reads.
 *   - vecAtCosine(c): on axes {0,1} → cosine EXACTLY c to the axis-0 anchor/source.
 *   - orthogonalVec(): a unit vector on a distinct axis → cosine 0 to every {0,1} vector,
 *     so a genuinely-far orphan stays un-rescuable EVEN AFTER other orphans are rescued
 *     (reachability grows within the {0,1} plane; the orthogonal one never joins it).
 *
 * ISOLATION: every test runs in its OWN fresh project (the candidate pool is project-wide),
 * so seeded contexts never leak across tests. DB target: the disposable migrated ci_* DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';
import { db } from '../config/database.js';
import { mintEdge } from '../services/links.js';
import { INFERENCE_THRESHOLD } from '../config/reliableThreadingConfig.js';
import {
  parseArgs,
  resolveProjectRef,
  backfillOrphanThreads,
} from '../services/orphanBackfill.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

/** An active-dimensional vector on axes {0,1} whose cosine to the axis-0 anchor is EXACTLY `cos`. */
function vecAtCosine(cos: number): string {
  const v = new Array(embedDim()).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return `[${v.join(',')}]`;
}

/** The anchor/source vector every candidate's cosine is measured against: unit on axis 0. */
function anchorVec(): string {
  const v = new Array(embedDim()).fill(0);
  v[0] = 1;
  return `[${v.join(',')}]`;
}

/** A unit vector on a distinct axis → cosine 0 to every {0,1} vector (a truly-far orphan). */
function orthogonalVec(): string {
  const v = new Array(embedDim()).fill(0);
  v[500] = 1;
  return `[${v.join(',')}]`;
}

async function freshProject(label: string): Promise<{ id: string; name: string }> {
  const name = `st6-backfill-${label}-${STAMP}`;
  const id = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'ST-6 backfill fixture') RETURNING id::text AS id`,
      [name]
    )
  ).rows[0].id;
  projectIds.push(id);
  return { id, name };
}

async function insertContext(projectId: string, content: string, embedding: string | null): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
       VALUES ($1, 'discussion', $2, $3::vector)
       RETURNING id::text AS id`,
      [projectId, content, embedding]
    )
  ).rows[0].id;
}

/** Make a context a NON-ORPHAN by minting one real edge (context → a task). */
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
    { fromId: ctxId, fromType: 'context', toId: taskId, toType: 'task', edgeType: 'informs', projectId, createdBy: 'test-setup', via: EDGE_MINT_VIA.tag },
    db
  );
}

async function countRelatedTo(projectId: string): Promise<number> {
  return (
    await db.query(
      `SELECT count(*)::int AS n FROM links WHERE project_id = $1 AND edge_type = 'related_to'`,
      [projectId]
    )
  ).rows[0].n;
}

async function relatedToOut(fromId: string): Promise<number> {
  return (
    await db.query(
      `SELECT count(*)::int AS n FROM links WHERE from_id = $1 AND edge_type = 'related_to'`,
      [fromId]
    )
  ).rows[0].n;
}

/**
 * Seed a project with 1 non-orphan anchor (axis-0) + 2 near orphans (cos 0.9 / 0.85, both
 * ≥ the 0.6 default) + 1 orthogonal orphan (cos 0 to everything → un-rescuable). Returns ids.
 */
async function seedStandard(label: string) {
  const proj = await freshProject(label);
  const anchor = await insertContext(proj.id, 'the reachable anchor', anchorVec());
  await makeNonOrphan(proj.id, anchor);
  const nearA = await insertContext(proj.id, 'near orphan A', vecAtCosine(0.9));
  const nearB = await insertContext(proj.id, 'near orphan B', vecAtCosine(0.85));
  const far = await insertContext(proj.id, 'orthogonal orphan (unrescuable)', orthogonalVec());
  return { proj, anchor, nearA, nearB, far };
}

describe('backfill-orphan-threads — arg parsing (ST-6, no DB)', () => {
  test('safe default: no --apply → dry-run, config threshold', () => {
    const o = parseArgs(['--project', 'p']);
    expect(o.dryRun).toBe(true);
    expect(o.threshold).toBe(INFERENCE_THRESHOLD);
    expect(o.project).toBe('p');
  });

  test('--apply → live write; --dry-run → dry-run', () => {
    expect(parseArgs(['--project', 'p', '--apply']).dryRun).toBe(false);
    expect(parseArgs(['--project', 'p', '--dry-run']).dryRun).toBe(true);
  });

  test('--apply + --dry-run is a contradiction → throws', () => {
    expect(() => parseArgs(['--project', 'p', '--apply', '--dry-run'])).toThrow(/mutually exclusive/);
  });

  test('missing --project throws', () => {
    expect(() => parseArgs([])).toThrow(/--project/);
  });

  test('--threshold must be a cosine in [0,1]', () => {
    expect(() => parseArgs(['--project', 'p', '--threshold', '1.5'])).toThrow(/\[0, 1\]/);
    expect(() => parseArgs(['--project', 'p', '--threshold', 'abc'])).toThrow(/finite number/);
    expect(parseArgs(['--project', 'p', '--threshold', '0.55']).threshold).toBe(0.55);
  });

  test('--key=value form + --help', () => {
    const o = parseArgs(['--project=proj-x', '--threshold=0.3']);
    expect(o.project).toBe('proj-x');
    expect(o.threshold).toBe(0.3);
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('backfill-orphan-threads — DB-backed backfill (ST-6)', () => {
  beforeAll(() => {
    // Guard the fixture against a drifted default floor (assertions assume 0.6).
    expect(INFERENCE_THRESHOLD, 'test assumes the default 0.6 inference floor').toBe(0.6);
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

  test('resolveProjectRef resolves by id AND by name; unknown throws', async () => {
    const { proj } = await seedStandard('resolve');
    expect((await resolveProjectRef(proj.id)).id).toBe(proj.id);
    const byName = await resolveProjectRef(proj.name);
    expect(byName.id).toBe(proj.id);
    expect(byName.name).toBe(proj.name);
    await expect(resolveProjectRef(`no-such-project-${STAMP}`)).rejects.toThrow(/No project matches/);
  });

  test('(a) --dry-run mints ZERO edges and reports correct projected counts', async () => {
    const { proj, far } = await seedStandard('dry');

    const s = await backfillOrphanThreads(
      { projectId: proj.id, projectName: proj.name, dryRun: true, threshold: INFERENCE_THRESHOLD },
      db
    );

    // Wrote NOTHING.
    expect(await countRelatedTo(proj.id)).toBe(0);
    expect(s.minted).toBe(0);

    // Projected counts.
    expect(s.totalContexts).toBe(4); // anchor + 3 orphans (active)
    expect(s.orphansBefore).toBe(3);
    expect(s.rescuable).toBe(2); // near A (0.9) + near B (0.85)
    expect(s.unrescuable).toBe(1);
    expect(s.noNeighbor).toBe(1); // the orthogonal orphan
    expect(s.orphansAfter).toBe(1); // projected: 3 − 2
    expect(s.unrescuableIds).toEqual([far]); // (d) reported, not dropped
  });

  test('(b) live run mints related_to to rescuable orphans and drops the orphan count', async () => {
    const { proj, nearA, nearB, far } = await seedStandard('live');

    const s = await backfillOrphanThreads(
      { projectId: proj.id, projectName: proj.name, dryRun: false, threshold: INFERENCE_THRESHOLD },
      db
    );

    // Two NEW related_to edges (one per rescuable orphan).
    expect(s.minted).toBe(2);
    expect(s.rescuable).toBe(2);
    expect(await countRelatedTo(proj.id)).toBe(2);

    // Each rescuable orphan now has an outgoing related_to; the orthogonal one does not.
    expect(await relatedToOut(nearA)).toBe(1);
    expect(await relatedToOut(nearB)).toBe(1);
    expect(await relatedToOut(far)).toBe(0);

    // Orphan count actually dropped (re-queried), and the far one is still reported un-rescuable.
    expect(s.orphansAfter).toBe(1);
    expect(s.noNeighbor).toBe(1);
    expect(s.unrescuableIds).toEqual([far]);
  });

  test('(c) re-run is a no-op — idempotent (0 new edges)', async () => {
    const { proj } = await seedStandard('idem');

    const first = await backfillOrphanThreads(
      { projectId: proj.id, projectName: proj.name, dryRun: false, threshold: INFERENCE_THRESHOLD },
      db
    );
    expect(first.minted).toBe(2);
    const edgesAfterFirst = await countRelatedTo(proj.id);
    expect(edgesAfterFirst).toBe(2);

    // Second identical live run: rescued contexts are no longer orphans → only the far one
    // remains, still un-rescuable → nothing new minted.
    const second = await backfillOrphanThreads(
      { projectId: proj.id, projectName: proj.name, dryRun: false, threshold: INFERENCE_THRESHOLD },
      db
    );
    expect(second.orphansBefore).toBe(1); // only the orthogonal orphan is left
    expect(second.minted).toBe(0);
    expect(second.rescuable).toBe(0);
    expect(await countRelatedTo(proj.id)).toBe(edgesAfterFirst); // unchanged
  });

  test('(d) un-rescuable orphan is reported, never silently dropped', async () => {
    const { proj, far } = await seedStandard('unrescuable');

    const s = await backfillOrphanThreads(
      { projectId: proj.id, projectName: proj.name, dryRun: true, threshold: INFERENCE_THRESHOLD },
      db
    );

    expect(s.unrescuable).toBe(1);
    expect(s.noNeighbor).toBe(1);
    expect(s.unrescuableIds).toContain(far);
    // The count is honest: un-rescuable ids length == the un-rescuable tally.
    expect(s.unrescuableIds.length).toBe(s.unrescuable);
  });

  test('--threshold override flows through to the inference floor', async () => {
    const proj = await freshProject('threshold');
    const anchor = await insertContext(proj.id, 'the anchor', anchorVec());
    await makeNonOrphan(proj.id, anchor);
    const mid = await insertContext(proj.id, 'mid orphan at cos 0.4', vecAtCosine(0.4));

    // At the default 0.6 floor, the 0.4 orphan is NOT rescuable.
    const atDefault = await backfillOrphanThreads(
      { projectId: proj.id, projectName: proj.name, dryRun: true, threshold: 0.6 },
      db
    );
    expect(atDefault.rescuable).toBe(0);
    expect(atDefault.unrescuableIds).toEqual([mid]);

    // Lowering the threshold to 0.3 makes it rescuable (proves the override reaches the helper).
    const atLow = await backfillOrphanThreads(
      { projectId: proj.id, projectName: proj.name, dryRun: true, threshold: 0.3 },
      db
    );
    expect(atLow.rescuable).toBe(1);
    expect(atLow.minted).toBe(0); // still a dry-run
    expect(await countRelatedTo(proj.id)).toBe(0); // nothing written
  });
});
