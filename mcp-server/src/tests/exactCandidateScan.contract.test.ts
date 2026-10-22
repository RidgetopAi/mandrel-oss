/**
 * EVERY CANDIDATE SCAN IS EXACT, NOT APPROXIMATE — regression contract for an earlier task and
 * 94e4fae9.
 *
 * ── THE POPULATION THIS GUARD ENUMERATES, AND WHY IT IS NOW THE WHOLE ONE (C3) ───────
 * Every statement in the product whose ORDER BY is a bare pgvector distance over a column that
 * carries an ivfflat/hnsw index. As of 2026-09-03 that is TWO builders, both imported here from
 * the modules that ship them:
 *   1. `inferenceCandidateSql`  (threadInference)   — 2 shapes
 *   2. `beliefCandidateSql`     (belief/candidatePairing) — 1 shape per embedded table
 * Derived by: `grep -rn '<=>' mcp-server/src --include=*.ts | grep -v /tests/` → 7 files, of
 * which only these two order by a bare distance; the other five compute a similarity column and
 * order by a composite score, which is not index-orderable.
 *
 * WHEN THIS FILE COVERED ONLY #1, #2 SHIPPED THE DEFECT. The 2026-08-02 fix fenced the inference
 * query and this guard's population was "both shapes inferenceCandidateSql can emit" — correct
 * about its own module and silent about the identical statement belief pairing added later. It
 * cost a non-deterministic clean gate (same ref 65c57ac7, one FAILURE and one
 * SUCCESS) and, on any instance whose contexts table is big enough for autoanalyze to tilt the
 * planner, silently dropped real candidate pairs in production. If you add a third such
 * statement, it belongs in the `shapes` array below.
 *
 * THE DEFECT THIS LOCKS OUT (measured, disposable ci_* DB, 2026-08-02):
 *   `inferAndMintRelatedTo`'s candidate query was written as the plain
 *   `... ORDER BY <embedding column> <=> $1::vector ASC LIMIT n`, which makes it eligible for
 *   the APPROXIMATE ivfflat index `contexts_embedding_1536_idx`. pgvector's ivfflat scan
 *   returns ONLY the rows in the `ivfflat.probes` lists it visits, and that index is created at
 *   migrate time on an EMPTY table, so its centroids carry no signal and rows scatter across
 *   all 100 lists. Measured on 602 embedded rows in one migrated ci_* DB:
 *
 *       probes=1   ->   1 of 602 rows returned
 *       probes=10  -> 116 of 602
 *       probes=100 -> 602 of 602
 *
 *   With a single genuinely-qualifying candidate present, the shipped query returned ZERO rows
 *   under both probes=1 and probes=10 while an exact scan returned it — so the helper answered
 *   `reason:'no-candidates'`, a DEFINITIVE claim that the project has nothing to attach to.
 *   Whether the planner chose that index depends on table statistics, i.e. on whether
 *   autoanalyze happened to have run, so the same code on the same data fabricated that verdict
 *   on roughly one full-suite run in five, with no concurrency at all (measured: 3 fabricated
 *   REDs in 18 consecutive clean-gate-equivalent runs of the mcp-server suite on healthy code).
 *
 * WHY THIS IS NOT A RECALL TRADE-OFF: the query does not ask for a good top-K, it asks "does
 * ANY attachable neighbour exist", and an empty result is read as a definitive NO that ends the
 * no-orphan guarantee for that capture. "The probed lists were empty" and "the project has
 * nothing to attach to" are different facts and must not share a return value.
 *
 * WHY THIS GUARD ASSERTS THE PLAN AND NOT A ROW COUNT. A behavioural fixture has to make the
 * approximate scan actually lose the one real row, which depends on how the fill vectors happen
 * to land across the index's lists — measured non-deterministic while building this test (one
 * 400-row fill returned every row, another 600-row fill returned 1 of 602). A guard whose RED
 * depends on luck is worse than none. The RULE is exact and checkable: this statement must not
 * be planned onto a vector index. So the guard EXPLAINs the real statement under the planner
 * settings that made the index attractive and requires that no vector index appears.
 *
 * THE POPULATION IS ENUMERATED FROM THE CATALOG, NOT REMEMBERED. The vector indexes are read
 * from pg_am/pg_index at run time (every ivfflat OR hnsw index on `contexts`), so renaming
 * `contexts_embedding_1536_idx`, adding the gemma index, or adopting hnsw later cannot quietly
 * shrink what this checks. The guard also fails if that population is EMPTY — a zero-index
 * database would make the assertion vacuously true, which is the classic hollow guard.
 *
 * DB target: the disposable migrated ci_* DB from the CI gate — never production.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { activeEmbeddingColumn, embedDim } from './helpers/embedGeometry.js';
import { db } from '../config/database.js';
import { inferenceCandidateSql } from '../services/threadInference.js';
import { beliefCandidateSql } from '../services/belief/candidatePairing.js';

/**
 * The tables a guarded statement scans. `technical_decisions` is here because belief pairing
 * nominates decisions as well as contexts (candidatePairing's EMBEDDED_TABLES) and migrations
 * 045/056 put ivfflat indexes on that table too — a guard that read only `contexts` would have
 * declared the decision half clean without looking at it.
 */
const SCANNED_TABLES = ['contexts', 'technical_decisions'] as const;

/** Every APPROXIMATE (ivfflat/hnsw) index on the scanned tables, read from the catalog. */
async function vectorIndexNames(): Promise<string[]> {
  const r = await db.query(
    `SELECT ci.relname::text AS name
       FROM pg_index i
       JOIN pg_class ci ON ci.oid = i.indexrelid
       JOIN pg_class ct ON ct.oid = i.indrelid
       JOIN pg_am am ON am.oid = ci.relam
      WHERE ct.relname = ANY($1::text[]) AND am.amname IN ('ivfflat', 'hnsw')`,
    [[...SCANNED_TABLES]]
  );
  return r.rows.map((row: { name: string }) => row.name);
}

describe('candidate scans are EXACT (an earlier task + 94e4fae9 — an ANN index cannot answer an existence question)', () => {
  let indexes: string[] = [];

  beforeAll(async () => {
    indexes = await vectorIndexNames();
  });

  afterAll(async () => {
    await db.end();
  });

  test('the migrated schema really does carry approximate vector indexes on the scanned tables', async () => {
    // The CONTROL for the assertion below: with no ivfflat/hnsw index present, "the plan names
    // no vector index" would be true for free and would prove nothing.
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.some((n) => n.includes(activeEmbeddingColumn()) || n.includes('embedding'))).toBe(true);
  });

  test('the candidate statement is NEVER planned onto a vector index, even when the planner is pushed at one', async () => {
    const client = await db.connect();
    try {
      // THE HOSTILE SETTING. `enable_sort = off` prices an explicit Sort out of the plan, so
      // any statement that CAN get its ordering from the vector index will. That is the same
      // choice the planner makes on its own once table statistics tilt — it is just made
      // deterministic here instead of waiting for autoanalyze. `probes = 1` mirrors the
      // pgvector default the inference path runs under.
      await client.query('SET enable_sort = off');
      await client.query('SET ivfflat.probes = 1');

      // MUST be at the ACTIVE geometry: a wrong-length literal makes the vector index
      // structurally inapplicable, which would make this assertion pass for the wrong reason.
      const probeVec = `[${new Array(embedDim()).fill(0).join(',')}]`;

      // BOTH SHAPES THE FUNCTION CAN EMIT — the population, stated (C3).
      // `inferenceCandidateSql` gained a second form in Phase 3: the backfill
      // runs it WITHOUT the reachability filter to fix the rich-get-richer hole. Guarding only
      // the default would leave the shape that runs over thousands of rows per scheduled pass
      // completely unguarded — and it is the MORE index-attractive of the two, because
      // dropping the EXISTS makes the CTE a plain filtered scan of the vector column.
      //
      // THE BELIEF SHAPES carry a DIFFERENT parameter list, so each shape
      // brings its own params rather than sharing one tuple — a shared tuple is how a new
      // statement gets quietly left out of a guard like this.
      const NIL = '00000000-0000-0000-0000-000000000000';
      const inferenceParams = [probeVec, NIL, NIL, 20];
      const beliefParams = (type: string) => [probeVec, NIL, NIL, type, 0.6, 0.95, [], [], 8];
      const shapes: Array<{ label: string; sql: string; params: unknown[] }> = [
        {
          label: 'inference write-path default (reachability required)',
          sql: inferenceCandidateSql(),
          params: inferenceParams,
        },
        {
          label: 'inference Phase 3 backfill (reachability filter lifted)',
          sql: inferenceCandidateSql(activeEmbeddingColumn(), { requireReachableCandidate: false }),
          params: inferenceParams,
        },
        {
          label: 'belief pairing — contexts',
          sql: beliefCandidateSql(
            { table: 'contexts', type: 'context', contentCol: 'content', createdCol: 'created_at' },
            activeEmbeddingColumn()
          ),
          params: beliefParams('context'),
        },
        {
          label: 'belief pairing — technical_decisions',
          sql: beliefCandidateSql(
            {
              table: 'technical_decisions',
              type: 'decision',
              contentCol: 'rationale',
              createdCol: 'decision_date',
            },
            activeEmbeddingColumn()
          ),
          params: beliefParams('decision'),
        },
      ];

      for (const shape of shapes) {
        const plan = await client.query(`EXPLAIN (FORMAT JSON) ${shape.sql}`, shape.params);
        const planText = JSON.stringify(plan.rows[0]);

        for (const name of indexes) {
          expect(
            planText.includes(name),
            `the "${shape.label}" candidate statement was planned onto the APPROXIMATE index ` +
              `"${name}". An ivfflat/hnsw scan returns only the rows in the lists it probes, so ` +
              'an empty result becomes a fabricated `no-candidates`. Keep the ' +
              'ORDER BY fenced behind the MATERIALIZED CTE.'
          ).toBe(false);
        }
      }
    } finally {
      client.release();
    }
  });

  test("the pre-fix statement shapes ARE attracted to that index — so the assertion above has teeth", async () => {
    // A guard that would pass on the BROKEN code proves nothing. This runs each statement as it
    // was written before its fix and requires that the planner DOES reach for the vector index,
    // which is what makes the previous test's `false` a real measurement rather than a
    // side-effect of these planner settings never favouring the index at all.
    //
    // BOTH pre-fix shapes are exercised, not just the inference one: the belief statement has a
    // different WHERE (two band comparisons on the same distance expression, an `<> ALL` and an
    // `ILIKE ANY`), and "some other statement is attracted" is not evidence about THIS one.
    const client = await db.connect();
    try {
      await client.query('SET enable_sort = off');
      await client.query('SET ivfflat.probes = 1');
      const col = activeEmbeddingColumn();
      const NIL = '00000000-0000-0000-0000-000000000000';
      const probeVec = `[${new Array(embedDim()).fill(0).join(',')}]`;

      const preFix: Array<{ label: string; sql: string; params: unknown[] }> = [
        {
          label: 'inference, as written before an earlier task',
          sql: `SELECT id, 1 - (${col} <=> $1::vector) AS similarity
                  FROM contexts
                 WHERE id <> $2
                   AND project_id = $3
                   AND ${col} IS NOT NULL
                   AND archived_at IS NULL
                   AND EXISTS (
                         SELECT 1 FROM links l
                          WHERE l.from_id = contexts.id OR l.to_id = contexts.id
                       )
                 ORDER BY ${col} <=> $1::vector ASC
                 LIMIT $4`,
          params: [probeVec, NIL, NIL, 20],
        },
        {
          label: 'belief pairing, as written before an earlier task',
          sql: `SELECT id::text AS id,
                       content AS content,
                       created_at AS created_at,
                       1 - (${col} <=> $1::vector) AS cosine
                  FROM contexts
                 WHERE ${col} IS NOT NULL
                   AND ($2::uuid IS NULL AND project_id IS NULL OR project_id = $2::uuid)
                   AND NOT (id = $3::uuid AND $4 = 'context')
                   AND 1 - (${col} <=> $1::vector) >= $5
                   AND 1 - (${col} <=> $1::vector) <= $6
                   AND coalesce(metadata->>'kind', '') <> ALL($7::text[])
                   AND NOT (coalesce(content, '') ILIKE ANY($8::text[]))
                 ORDER BY ${col} <=> $1::vector ASC
                 LIMIT $9`,
          params: [probeVec, NIL, NIL, 'context', 0.6, 0.95, [], [], 8],
        },
      ];

      for (const shape of preFix) {
        const plan = await client.query(`EXPLAIN (FORMAT JSON) ${shape.sql}`, shape.params);
        const planText = JSON.stringify(plan.rows[0]);
        expect(
          indexes.some((n) => planText.includes(n)),
          `the pre-fix shape "${shape.label}" was NOT planned onto any vector index under these ` +
            'settings, so this file is no longer measuring anything — re-derive the hostile ' +
            'planner settings before trusting the assertion above.'
        ).toBe(true);
      }
    } finally {
      client.release();
    }
  });
});
