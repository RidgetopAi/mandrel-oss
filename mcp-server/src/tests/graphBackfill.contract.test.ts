/**
 * SCHEDULED GRAPH BACKFILL — DB-backed contract test (PHASE 3).
 *
 * WHAT THIS FILE IS FOR: the acceptance criteria that can be EXECUTED. The staging-snapshot
 * run and the systemd timer proof are in the task's evidence log because they cannot live in
 * a suite; everything else about the job's behaviour is asserted here, against a real
 * migrated Postgres, so a later edit that blurs the two provenance classes goes RED rather
 * than being caught by someone re-reading a paragraph.
 *
 * THE PROPERTY THIS SUITE EXISTS TO DEFEND, above all others: a GUESS MUST NEVER LAND IN THE
 * DECLARED BUCKET. The Phase 0 meter was built to detect exactly that masquerade, and a
 * backfill is the single most likely thing to commit it — it can mint thousands of edges at
 * once and make a dashboard look healthy. Every assertion about buckets below reads the REAL
 * `link_provenance` view (migration 079/081), never a TypeScript re-spelling of it.
 *
 * EMBEDDING FIXTURE: the house embedding stub returns all-zeros (degenerate), so this suite
 * seeds controllable vectors directly into the active embedding column, exactly as
 * backfillOrphans.contract.test.ts does. The inference helper reuses the ALREADY-STORED
 * vector and never re-embeds, so what is seeded is what production reads.
 *
 * ISOLATION: every test runs in its OWN fresh project, because the candidate pool is
 * project-wide and the repair leg's population is global by stamp.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';
import { mintEdge } from '../services/links.js';
import { inferAndMintRelatedTo } from '../services/threadInference.js';
import { CREATED_BY as GUESSED_CREATED_BY } from '../services/orphanBackfill.js';
import {
  runGuessedLeg,
  runRepairLeg,
  runGraphBackfill,
  countOrphans,
} from '../services/graphBackfill.js';
import { EDGE_PROVENANCE, GUESS_METHOD } from '../config/graphBackfillConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';


const STAMP = Date.now();
const projectIds: string[] = [];

/** A vector on axes {0,1} whose cosine to the axis-0 anchor is EXACTLY `cos`. */
function vecAtCosine(cos: number): string {
  const v = new Array(embedDim()).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return `[${v.join(',')}]`;
}

/** Unit vector on a far axis → cosine 0 to every {0,1} vector. */
function farVec(): string {
  const v = new Array(embedDim()).fill(0);
  v[500] = 1;
  return `[${v.join(',')}]`;
}

async function freshProject(label: string): Promise<string> {
  const id = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'P3 graph-backfill fixture') RETURNING id::text AS id`,
      [`p3-${label}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`]
    )
  ).rows[0].id as string;
  projectIds.push(id);
  return id;
}

async function insertContext(projectId: string, content: string, embedding: string | null): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
       VALUES ($1, 'discussion', $2, $3::vector) RETURNING id::text AS id`,
      [projectId, content, embedding]
    )
  ).rows[0].id as string;
}

/** Orphan count scoped to one project — the suite's local version of the global predicate. */
async function orphansIn(projectId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM contexts c
      WHERE c.project_id = $1 AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_id = c.id OR l.to_id = c.id)`,
    [projectId]
  );
  return r.rows[0].n as number;
}

/**
 * Read the REAL 079/081 classification for one stamp. Never a local re-spelling.
 *
 * THROWS on an empty result rather than returning null. An absent stamp and an ambiguous one
 * are different facts, and both are different from "classified guessed" — a helper that maps
 * all three onto one value is the C1 third-state bug in miniature, and it is what made the
 * first run of this suite report `expected null to be 'declared'` for a stamp that simply had
 * no rows yet. The caller must plant an edge before asking.
 */
async function classOf(createdBy: string): Promise<string> {
  const r = await db.query(
    `SELECT DISTINCT provenance_class FROM link_provenance WHERE created_by = $1`,
    [createdBy]
  );
  if (r.rows.length === 0) {
    throw new Error(
      `classOf(${createdBy}): no edges carry this stamp, so the view classified nothing. ` +
        'Plant an edge with the stamp before asserting its bucket — an empty population ' +
        'cannot answer the question.'
    );
  }
  if (r.rows.length > 1) {
    throw new Error(`classOf(${createdBy}): stamp classifies to MORE THAN ONE bucket — the view is ambiguous.`);
  }
  return r.rows[0].provenance_class as string;
}

/**
 * The single mint_via carried by every edge with this stamp. Same empty/ambiguous guards as
 * classOf, and for the same reason: an empty population must not read as a passing case.
 */
async function viaOf(createdBy: string): Promise<string> {
  const r = await db.query(`SELECT DISTINCT mint_via FROM link_provenance WHERE created_by = $1`, [
    createdBy,
  ]);
  if (r.rows.length === 0) {
    throw new Error(`viaOf(${createdBy}): no edges carry this stamp — nothing to read a via from.`);
  }
  if (r.rows.length > 1) {
    throw new Error(`viaOf(${createdBy}): stamp carries MORE THAN ONE mint_via.`);
  }
  return r.rows[0].mint_via as string;
}

describe('PHASE 3 scheduled graph backfill', () => {
  afterAll(async () => {
    for (const id of projectIds) {
      await db.query(
        `DELETE FROM links WHERE from_id IN (SELECT id FROM contexts WHERE project_id = $1)
                              OR to_id   IN (SELECT id FROM contexts WHERE project_id = $1)`,
        [id]
      );
      await db.query(`DELETE FROM contexts WHERE project_id = $1`, [id]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
    }
    await db.end();
  });

  // ── THE RICH-GET-RICHER HOLE ─────────────────────────────────────────────────────────

  describe('the rich-get-richer hole is fixed FOR THE BACKFILL and kept FOR THE WRITE PATH', () => {
    test('an ALL-ORPHAN project is a fixed point under the write-path rule, and is healed without it', async () => {
      // THE FIXTURE IS THE POINT: a project in which EVERY context is an orphan. This is not
      // a contrived shape — `the-forge` on the 2026-08-13 prod snapshot is exactly this,
      // 1,425 contexts and 1,425 orphans, 20% of the entire backlog.
      const projectId = await freshProject('richgetricher');
      const a = await insertContext(projectId, 'orphan A', vecAtCosine(1));
      const b = await insertContext(projectId, 'orphan B', vecAtCosine(0.95));
      expect(await orphansIn(projectId)).toBe(2);

      // LEG 1 — the WRITE PATH's rule (candidate must already have an edge). The pool is
      // empty for every orphan here, so nothing can ever be rescued, no matter how often it
      // runs. This is the CONTROL that gives the next assertion teeth: without it, "the
      // backfill rescued them" could just mean the fixture was rescuable anyway.
      const underWritePathRule = await inferAndMintRelatedTo(
        { fromId: a, projectId, createdBy: GUESSED_CREATED_BY },
        db,
        { threshold: 0.6, dryRun: true, requireReachableCandidate: true }
      );
      expect(underWritePathRule.reason).toBe('no-candidates');
      expect(underWritePathRule.minted).toBe(false);

      // LEG 2 — the BACKFILL's rule. Same fixture, same helper, constraint lifted.
      const underBackfillRule = await inferAndMintRelatedTo(
        { fromId: a, projectId, createdBy: GUESSED_CREATED_BY },
        db,
        { threshold: 0.6, dryRun: true, requireReachableCandidate: false }
      );
      expect(underBackfillRule.reason).toBe('minted');
      expect(underBackfillRule.candidateId).toBe(b);
      // And it is HONEST about having built an island rather than joined the reachable graph.
      expect(underBackfillRule.candidateWasReachable).toBe(false);
    });

    test('the DEFAULT is the write-path rule — this change cannot have altered live stores', async () => {
      // The regression that matters most here is not the backfill misbehaving; it is the
      // live context_store path silently acquiring new behaviour because a default flipped.
      const projectId = await freshProject('defaultunchanged');
      await insertContext(projectId, 'lonely', vecAtCosine(1));
      const other = await insertContext(projectId, 'other orphan', vecAtCosine(0.99));
      const src = await insertContext(projectId, 'source', vecAtCosine(0.98));
      void other;

      // No requireReachableCandidate passed at all → must behave as it did before Phase 3.
      const res = await inferAndMintRelatedTo(
        { fromId: src, projectId, createdBy: GUESSED_CREATED_BY },
        db,
        { threshold: 0.6, dryRun: true }
      );
      expect(res.reason).toBe('no-candidates');
    });
  });

  // ── ACCEPTANCE #2 — THE TWO PROVENANCE CLASSES MUST NOT BLUR ─────────────────────────

  describe('acceptance #2 — every similarity-minted edge is a labeled, non-trust-bearing guess', () => {
    test('minted edges are related_to with provenance/method/similarity ON the edge, zero exceptions', async () => {
      const projectId = await freshProject('provenance');
      await insertContext(projectId, 'anchor', vecAtCosine(1));
      await insertContext(projectId, 'near', vecAtCosine(0.9));
      await insertContext(projectId, 'near2', vecAtCosine(0.85));

      const before = await orphansIn(projectId);
      expect(before).toBe(3);

      await runGuessedLeg({ dryRun: false, threshold: 0.6, maxOrphans: 0 }, db);

      const rows = await db.query(
        `SELECT l.edge_type, l.created_by, l.metadata
           FROM links l
           JOIN contexts c ON c.id = l.from_id
          WHERE c.project_id = $1 AND l.created_by = $2`,
        [projectId, GUESSED_CREATED_BY]
      );

      // CONTROL FIRST: a zero-violation count over an empty set proves nothing (C3 — probe
      // the empty population). Assert the population exists before asserting about it.
      expect(rows.rows.length).toBeGreaterThan(0);

      for (const r of rows.rows as Array<{ edge_type: string; metadata: Record<string, unknown> }>) {
        expect(r.edge_type).toBe('related_to');
        expect(r.metadata.provenance).toBe(EDGE_PROVENANCE.backfill);
        expect(r.metadata.method).toBe(GUESS_METHOD);
        expect(typeof r.metadata.similarity).toBe('number');
        // The recorded score must actually clear the floor the run was given — a labeled
        // guess whose own label contradicts the threshold would be worse than no label.
        expect(r.metadata.similarity as number).toBeGreaterThanOrEqual(0.6);
      }
    });

    test('a caller CANNOT overwrite the measured similarity with a claimed one', async () => {
      // The provenance stamp is only worth anything if the edge cannot be made to lie about
      // its own score. extraMetadata is spread UNDER the measured keys for this reason.
      const projectId = await freshProject('nolying');
      const target = await insertContext(projectId, 'target', vecAtCosine(1));
      await mintEdge(
        { fromId: target, fromType: 'context', toId: await insertContext(projectId, 'seed', farVec()),
          toType: 'context', edgeType: 'related_to', projectId, createdBy: 'link', via: EDGE_MINT_VIA.linkTool },
        db
      );
      const src = await insertContext(projectId, 'src', vecAtCosine(0.95));

      const res = await inferAndMintRelatedTo(
        { fromId: src, projectId, createdBy: GUESSED_CREATED_BY },
        db,
        {
          threshold: 0.6,
          requireReachableCandidate: false,
          extraMetadata: { provenance: 'declared', similarity: 0.999, method: 'a-lie' },
        }
      );
      expect(res.reason).toBe('minted');

      const row = await db.query(
        `SELECT metadata FROM links WHERE from_id = $1 AND created_by = $2`,
        [src, GUESSED_CREATED_BY]
      );
      const md = row.rows[0].metadata as Record<string, unknown>;
      // The MEASURED similarity wins over the claimed 0.999.
      expect(md.similarity).toBe(res.similarity);
      expect(md.similarity).not.toBe(0.999);
      // `provenance` and `method` are caller-supplied and therefore DO take the caller's
      // value — which is why the bucket does not depend on them. See the next describe.
      expect(md.provenance).toBe('declared');
    });
  });

  // ── ACCEPTANCE #5 — THE METER'S SPECIFICITY PROBE ────────────────────────────────────

  describe('acceptance #5 — the meter puts each leg in the right bucket, read from the REAL view', () => {
    test('the guessed leg\'s stamp classifies GUESSED, and metadata cannot move it', async () => {
      const projectId = await freshProject('meterguessed');
      await insertContext(projectId, 'm-anchor', vecAtCosine(1));
      await insertContext(projectId, 'm-near', vecAtCosine(0.9));
      await runGuessedLeg({ dryRun: false, threshold: 0.6, maxOrphans: 0 }, db);

      expect(await classOf(GUESSED_CREATED_BY)).toBe('guessed');

      // THE SPECIFICITY HALF, and the reason the previous test deliberately wrote
      // `provenance:'declared'` into an edge's metadata: the meter classifies on `created_by`
      // ALONE. So even an edge whose metadata SAYS "declared" is still counted GUESSED. A
      // backfill therefore cannot promote itself into the healthy bucket by relabelling its
      // own rows — which is precisely the masquerade Phase 0 exists to prevent.
      // `link_provenance` deliberately does not expose `metadata` — the classification has no
      // business reading it — so the join is to `links` for the metadata predicate while the
      // verdict still comes from the view.
      const mislabeled = await db.query(
        `SELECT lp.provenance_class
           FROM link_provenance lp
           JOIN links l ON l.id = lp.id
          WHERE lp.created_by = $1 AND l.metadata->>'provenance' = 'declared'`,
        [GUESSED_CREATED_BY]
      );
      // CONTROL: the earlier test planted exactly such an edge, so this must not be vacuous.
      expect(mislabeled.rows.length).toBeGreaterThan(0);
      for (const r of mislabeled.rows as Array<{ provenance_class: string }>) {
        expect(r.provenance_class).toBe('guessed');
      }
    });

    test('the declared backfill stamps classify DECLARED — the other side of the split', async () => {
      // These are the stamps the already-built task-edge backfill writes. They are DECLARED
      // because the target was named by a human at origin (a threading tag, the explicit
      // `dependencies` field); the backfill only materialises it late. Asserted against the
      // real view so a migration that reshuffles the CASE arms goes RED here.
      //
      // WHAT CARRIES THE DECLAREDNESS CHANGED IN SK4: it is now the
      // derivation path (mint_via = tag / task-dependencies), not the created_by stamp. The
      // two fixtures below therefore pass the via that the real backfill passes when it
      // mints through autoMintFromTags / autoMintFromTaskDependencies.
      const projectId = await freshProject('meterdeclared');
      const x = await insertContext(projectId, 'dx', vecAtCosine(1));
      const y = await insertContext(projectId, 'dy', vecAtCosine(0.9));
      const z = await insertContext(projectId, 'dz', vecAtCosine(0.8));
      // BOTH declared stamps must be planted before either is asked about: classOf throws on
      // an empty population precisely so a stamp nobody minted cannot read as a passing case.
      await mintEdge(
        { fromId: x, fromType: 'context', toId: y, toType: 'context', edgeType: 'related_to',
          projectId, createdBy: 'backfill:task_tags', via: EDGE_MINT_VIA.tag },
        db
      );
      await mintEdge(
        { fromId: x, fromType: 'context', toId: z, toType: 'context', edgeType: 'related_to',
          projectId, createdBy: 'backfill:task_deps', via: EDGE_MINT_VIA.taskDependencies },
        db
      );
      expect(await classOf('backfill:task_tags')).toBe('declared');
      expect(await classOf('backfill:task_deps')).toBe('declared');

      // AND THE DISCRIMINATION: the guessed leg's edges land in the OTHER bucket. Note what
      // no longer does the work — the stamps' shared `backfill:` prefix. Under SK4 the split
      // is the derivation path: these two were derived from at-origin-declared signals, the
      // guessed leg from a cosine nearest-neighbour pick, and that is the whole distinction.
      expect(await classOf(GUESSED_CREATED_BY)).toBe('guessed');
      expect(await viaOf(GUESSED_CREATED_BY)).toBe(EDGE_MINT_VIA.inference);
      expect(GUESSED_CREATED_BY.startsWith('backfill:')).toBe(true);
    });

    test('a guessed backfill leaves the DECLARED COUNT exactly unmoved', async () => {
      // NOTE ON THE CRITERION'S WORDING. Acceptance #5 says guessed edges must "not move the
      // declared rate". Taken literally that is unachievable and would be the wrong property:
      // declared_rate is declared/TOTAL, so adding any guessed edge necessarily lowers it.
      // That fall is the meter WORKING — a large guessed backfill should make the graph read
      // as measurably more guessed, not healthier. The invariant that actually protects
      // against masquerade, and the one asserted here, is that the DECLARED COUNT does not
      // move at all.
      const declaredBefore = (
        await db.query(`SELECT count(*)::int AS n FROM link_provenance WHERE provenance_class = 'declared'`)
      ).rows[0].n as number;

      const projectId = await freshProject('declaredunmoved');
      await insertContext(projectId, 'u1', vecAtCosine(1));
      await insertContext(projectId, 'u2', vecAtCosine(0.92));
      const minted = await runGuessedLeg({ dryRun: false, threshold: 0.6, maxOrphans: 0 }, db);
      expect(minted.minted).toBeGreaterThan(0); // control: something actually happened

      const declaredAfter = (
        await db.query(`SELECT count(*)::int AS n FROM link_provenance WHERE provenance_class = 'declared'`)
      ).rows[0].n as number;
      expect(declaredAfter).toBe(declaredBefore);
    });
  });

  // ── ACCEPTANCE #3 — IDEMPOTENCE ──────────────────────────────────────────────────────

  describe('acceptance #3 — an immediate second run mints ZERO new edges', () => {
    test('run 2 mints nothing, repairs nothing, and leaves the link count identical', async () => {
      const projectId = await freshProject('idempotent');
      await insertContext(projectId, 'i1', vecAtCosine(1));
      await insertContext(projectId, 'i2', vecAtCosine(0.93));
      await insertContext(projectId, 'i3', vecAtCosine(0.88));

      const run1 = await runGraphBackfill({ apply: true, maxOrphans: 0, maxRepairs: 0 }, db);
      expect(run1.guessed.minted).toBeGreaterThan(0);
      const linksAfter1 = (await db.query(`SELECT count(*)::int AS n FROM links`)).rows[0].n as number;

      const run2 = await runGraphBackfill({ apply: true, maxOrphans: 0, maxRepairs: 0 }, db);
      expect(run2.guessed.minted).toBe(0);
      expect(run2.repair.relabeled).toBe(0);
      expect(run2.repair.repointed).toBe(0);

      const linksAfter2 = (await db.query(`SELECT count(*)::int AS n FROM links`)).rows[0].n as number;
      expect(linksAfter2).toBe(linksAfter1);
    });
  });

  // ── THE REPAIR LEG ───────────────────────────────────────────────────────────────────

  describe('repair — make historical guesses honest, without moving anything between buckets', () => {
    test('an unlabeled historical guess is re-labeled with its MEASURED score, keeping created_by', async () => {
      const projectId = await freshProject('relabel');
      const from = await insertContext(projectId, 'r-from', vecAtCosine(1));
      const to = await insertContext(projectId, 'r-to', vecAtCosine(0.8));
      // A historical `auto:inference` edge with NO metadata at all — the shape the pre-Phase-3
      // corpus is full of: a guess that never recorded that it was one.
      await mintEdge(
        { fromId: from, fromType: 'context', toId: to, toType: 'context', edgeType: 'related_to',
          projectId, createdBy: 'auto:inference', via: EDGE_MINT_VIA.inference },
        db
      );

      await runRepairLeg({ dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: 0 }, db);

      const row = await db.query(
        `SELECT created_by, to_id::text AS to_id, metadata FROM links WHERE from_id = $1`,
        [from]
      );
      const md = row.rows[0].metadata as Record<string, unknown>;
      expect(md.provenance).toBe(EDGE_PROVENANCE.guess);
      expect(md.method).toBe(GUESS_METHOD);
      expect(typeof md.similarity).toBe('number');
      expect(md.similarity as number).toBeCloseTo(0.8, 5);

      // THE BUCKET-SAFETY ASSERTION. `created_by` is untouched, so the edge stays exactly
      // where the meter had it. If repair rewrote the stamp to `backfill:*`, a repair pass
      // would silently reclassify thousands of edges — a second route to the masquerade.
      expect(row.rows[0].created_by).toBe('auto:inference');
      expect(row.rows[0].to_id).toBe(to);
      // It is labeled 'guess', NOT 'backfill': this job measured the edge, it did not mint it.
      expect(md.provenance).not.toBe(EDGE_PROVENANCE.backfill);
    });

    test('an edge pointing at a MATERIALLY worse neighbour is re-pointed at the better one', async () => {
      const projectId = await freshProject('repoint');
      const from = await insertContext(projectId, 'p-from', vecAtCosine(1));
      const wrong = await insertContext(projectId, 'p-wrong', farVec()); // cosine 0 → below floor
      const right = await insertContext(projectId, 'p-right', vecAtCosine(0.95));

      await mintEdge(
        { fromId: from, fromType: 'context', toId: wrong, toType: 'context', edgeType: 'related_to',
          projectId, createdBy: 'auto:inference', via: EDGE_MINT_VIA.inference },
        db
      );

      const summary = await runRepairLeg(
        { dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: 0 },
        db
      );
      expect(summary.repointed).toBeGreaterThan(0);

      const row = await db.query(
        `SELECT to_id::text AS to_id, created_by, metadata FROM links WHERE from_id = $1`,
        [from]
      );
      expect(row.rows[0].to_id).toBe(right);
      expect(row.rows[0].created_by).toBe('auto:inference'); // still not rewritten
      expect((row.rows[0].metadata as Record<string, unknown>).repointedFrom).toBe(wrong);
    });

    test('an edge with an ARCHIVED endpoint is left entirely alone — both legs honour soft-delete', async () => {
      // WHY THIS FIXTURE IS CONSTRUCTED RATHER THAN FOUND. Measured on the prod snapshot at
      // 67ef00d: 19 archived contexts and ZERO edges in the repair population touching one.
      // So a guard that went looking for real archived edges would pass identically with or
      // without the predicate — it would be measuring an empty population, which is the
      // false green C3 names. The archived endpoint is therefore built here on purpose.
      //
      // THE DEFECT THIS PINS: ORPHAN_PREDICATE_SQL has always carried `archived_at IS NULL`,
      // but REPAIR_POPULATION_SQL did not. One leg of one job honoured a user's deletion
      // while the other re-labeled and re-pointed edges into deleted records.
      const projectId = await freshProject('archivedendpoint');
      const liveFrom = await insertContext(projectId, 'ar-live-from', vecAtCosine(1));
      const archivedTo = await insertContext(projectId, 'ar-archived-to', vecAtCosine(0.2));
      // A materially better LIVE neighbour exists, so the edge below is a genuine re-point
      // candidate. That is what gives this test teeth: without the predicate the repair leg
      // has both the motive (target below floor) and the means (a better target) to touch it.
      await insertContext(projectId, 'ar-better', vecAtCosine(0.98));

      await mintEdge(
        { fromId: liveFrom, fromType: 'context', toId: archivedTo, toType: 'context',
          edgeType: 'related_to', projectId, createdBy: 'auto:inference', via: EDGE_MINT_VIA.inference },
        db
      );
      await db.query(`UPDATE contexts SET archived_at = now() WHERE id = $1`, [archivedTo]);

      const s = await runRepairLeg(
        { dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: 0 },
        db
      );
      // The edge is not in the population at all — not examined, not deferred, not counted.
      expect(s.examined).toBe(0);
      expect(s.repointed).toBe(0);
      expect(s.relabeled).toBe(0);
      expect(s.remainingUnprocessed).toBe(0);

      // And the row itself is byte-for-byte untouched: still pointing at the archived record,
      // still carrying no repair metadata.
      const row = await db.query(
        `SELECT to_id::text AS to_id, created_by, metadata FROM links WHERE from_id = $1`,
        [liveFrom]
      );
      expect(row.rows[0].to_id).toBe(archivedTo);
      expect(row.rows[0].created_by).toBe('auto:inference');
      expect(row.rows[0].metadata).toEqual({});

      // THE CONTROL, and the thing that stops this passing for the wrong reason: un-archive
      // the endpoint and the SAME edge is immediately picked up and re-pointed. So the
      // exclusion above is the archived_at predicate doing its job, not the fixture simply
      // being ineligible for some other reason.
      await db.query(`UPDATE contexts SET archived_at = NULL WHERE id = $1`, [archivedTo]);
      const after = await runRepairLeg(
        { dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: 0 },
        db
      );
      expect(after.examined).toBeGreaterThan(0);
      expect(after.repointed).toBeGreaterThan(0);
    });

    test('successive CAPPED runs drain the repair population to zero (T1-1 starvation)', async () => {
      // ── WHY THIS TEST IS CAPPED, AND WHY THAT IS THE WHOLE POINT ──────────────────────
      // The original idempotence guard ran with maxRepairs: 0 (UNCAPPED). The scheduled job
      // runs CAPPED at MAX_REPAIRS_PER_RUN. Uncapped is the one configuration in which the
      // starvation defect CANNOT exist, so the guard's population excluded the only shape
      // that could fail — and 77% of the repairable corpus (6,739 of 8,739 edges, measured on
      // the prod snapshot) was permanently unreachable by any number of scheduled runs while
      // the suite stayed green.
      //
      // So this asserts the property in the PRODUCTION configuration: a cap smaller than the
      // population, run repeatedly, must strictly reduce the remaining count to zero.
      const projectId = await freshProject('cappedprogress');
      const anchor = await insertContext(projectId, 'cp-anchor', vecAtCosine(1));
      const targets: string[] = [];
      for (let i = 0; i < 7; i++) {
        targets.push(await insertContext(projectId, `cp-t${i}`, vecAtCosine(0.9 - i * 0.02)));
      }
      // Seven historical, unlabeled guesses — the shape the pre-Phase-3 corpus is full of.
      for (const t of targets) {
        await mintEdge(
          { fromId: anchor, fromType: 'context', toId: t, toType: 'context', edgeType: 'related_to',
            projectId, createdBy: 'auto:inference', via: EDGE_MINT_VIA.inference },
          db
        );
      }

      const CAP = 2; // deliberately far smaller than the 7 seeded rows
      const remainingSeries: number[] = [];
      let examinedTotal = 0;

      // Bound the loop well above the number of runs a correct implementation needs
      // (ceil(population/CAP)); a starving implementation would otherwise spin forever, and a
      // test that hangs is a worse failure report than one that asserts.
      for (let run = 0; run < 25; run++) {
        const s = await runRepairLeg(
          { dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: CAP },
          db
        );
        examinedTotal += s.examined;
        remainingSeries.push(s.remainingUnprocessed);
        if (s.examined === 0 && s.remainingUnprocessed === 0) break;
        // STRICT PROGRESS, asserted every single run — not merely "it got there eventually".
        // Under the old code this series was the constant [6739, 6739, 6739, ...].
        expect(s.examined).toBeGreaterThan(0);
      }

      // It converged, and it converged to ZERO remaining.
      expect(remainingSeries[remainingSeries.length - 1]).toBe(0);
      // The series never went back up and did in fact come down.
      for (let i = 1; i < remainingSeries.length; i++) {
        expect(remainingSeries[i]).toBeLessThanOrEqual(remainingSeries[i - 1]);
      }
      expect(remainingSeries[0]).toBeGreaterThan(0); // control: there WAS a backlog to drain
      // Every seeded edge was actually examined, and none was examined twice — the cap
      // batched the work rather than re-reading one frozen window.
      expect(examinedTotal).toBe(7);

      // And the population really is empty now: one more capped run is a genuine no-op.
      const settled = await runRepairLeg(
        { dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: CAP },
        db
      );
      expect(settled.examined).toBe(0);
      expect(settled.remainingUnprocessed).toBe(0);
    });

    test('an UNMEASURABLE edge leaves the population too, or it starves the cap forever', async () => {
      // The same starvation, in the one population that can never satisfy the honest-label
      // arm: an edge whose endpoint has no vector cannot be labeled with a measured score, so
      // without an explicit marker it would be re-fetched first by every capped run and block
      // everything behind it. It must be DEFERRED, not abandoned — the marker is narrow, so
      // the row re-qualifies once the re-embed worker gives it a usable vector.
      const projectId = await freshProject('unmeasurabledrain');
      const from = await insertContext(projectId, 'ud-from', null); // NO embedding
      const to = await insertContext(projectId, 'ud-to', vecAtCosine(0.9));
      // A genuinely BETTER neighbour exists. This is what gives "never re-pointed" teeth: if
      // the leg treated unmeasurable as merely below-floor, there is something here for it to
      // wrongly re-point to, so leaving the edge alone is a real result rather than a lack of
      // options.
      await insertContext(projectId, 'ud-better', vecAtCosine(1));
      await mintEdge(
        { fromId: from, fromType: 'context', toId: to, toType: 'context', edgeType: 'related_to',
          projectId, createdBy: 'auto:inference', via: EDGE_MINT_VIA.inference },
        db
      );

      const first = await runRepairLeg(
        { dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: 5 },
        db
      );
      expect(first.notComparable).toBeGreaterThan(0);

      // THE ASSERTION THAT MATTERS: the second run does NOT see it again.
      const second = await runRepairLeg(
        { dryRun: false, minSimilarity: 0.6, improvementMargin: 0.15, maxRepairs: 5 },
        db
      );
      expect(second.notComparable).toBe(0);
      expect(second.examined).toBe(0);

      // It was deferred, not silently dropped: the edge itself is untouched and the reason is
      // recorded on it, so an operator can find every edge the repair leg could not judge.
      const row = await db.query(`SELECT to_id::text AS to_id, metadata FROM links WHERE from_id = $1`, [from]);
      expect(row.rows[0].to_id).toBe(to);
      expect((row.rows[0].metadata as Record<string, unknown>).repairUnmeasurable).toBe(true);
    });

  });

  // ── THE CN2 GATE ─────────────────────────────────────────────────────────────────────

  describe('the CN2 gate on the declared leg is ENCODED, not documented', () => {
    test('the declared leg does not run unless it is explicitly opted in', async () => {
      // The systemd unit passes --apply and NOT --include-declared, so this default is what
      // stands between an unattended hourly timer and a trust-score-shifting mutation. A
      // rule that lives only in a comment is the weak version; this is the strong one.
      const withoutOptIn = await runGraphBackfill({ apply: false, maxOrphans: 0, maxRepairs: 0 }, db);
      expect(withoutOptIn.declared).toBeNull();
      expect(withoutOptIn.includedDeclared).toBe(false);

      const withOptIn = await runGraphBackfill(
        { apply: false, includeDeclared: true, maxOrphans: 0, maxRepairs: 0 },
        db
      );
      expect(withOptIn.declared).not.toBeNull();
      expect(withOptIn.includedDeclared).toBe(true);
    });
  });

  // ── DRY-RUN SAFETY ───────────────────────────────────────────────────────────────────

  describe('safe by default', () => {
    test('a dry run writes NOTHING while still reporting what it would do', async () => {
      const projectId = await freshProject('dryrun');
      await insertContext(projectId, 'd1', vecAtCosine(1));
      await insertContext(projectId, 'd2', vecAtCosine(0.9));

      const linksBefore = (await db.query(`SELECT count(*)::int AS n FROM links`)).rows[0].n as number;
      const orphansBefore = await countOrphans(db);

      const s = await runGraphBackfill({ maxOrphans: 0, maxRepairs: 0 }, db); // no apply
      expect(s.dryRun).toBe(true);
      expect(s.guessed.rescuable).toBeGreaterThan(0); // it DID evaluate
      expect(s.guessed.minted).toBe(0); // and wrote nothing

      const linksAfter = (await db.query(`SELECT count(*)::int AS n FROM links`)).rows[0].n as number;
      expect(linksAfter).toBe(linksBefore);
      expect(await countOrphans(db)).toBe(orphansBefore);
    });
  });
});
