// GUARDS-CLASS: backwards-belief-edge
/**
 * Migration 096 — `belief_adjudications.minted_edge_id` FOREIGN KEY contract test
 * (follow-on from the retraction).
 *
 * ── THE DEFECT THIS PINS ─────────────────────────────────────────────────────────────
 * `minted_edge_id` claimed to point at a `links` row and carried no foreign key, so
 * `unlinkEdge` — which deletes the links row and touches nothing else — left the pointer
 * behind. MEASURED on prod 2026-08-28: 30 adjudications pointed at links rows that no
 * longer existed (28 from the 2026-07-08 backfill, 1 on 08-16, 1 on 08-23).
 *
 * ── WHY IT DRIVES `unlinkEdge` AND NOT A RAW `DELETE FROM links` ─────────────────────
 * `unlinkEdge` IS the retraction path — reconcileBeliefEdge's sweep calls it, and it is
 * what produced the orphans. A raw DELETE would exercise the constraint while proving
 * nothing about the product; asserting through the shipped entry point is what makes this
 * a claim about Mandrel rather than about Postgres (CLASSES.md C3).
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────────────────
 * The first two tests only insert and delete their own rows. The third temporarily DROPs
 * the constraint to reproduce the pre-096 state, and does so inside a single client
 * transaction that always ROLLBACKs — so the shared disposable CI DB is left exactly as
 * migrate.ts produced it, constraint present, whether the test passes or fails.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { db } from '../config/database.js';
import { mintEdge, unlinkEdge } from '../services/links.js';
import { BELIEF_EDGE_CREATED_BY } from '../config/beliefConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/tests/ -> mcp-server/database/migrations/096_minted_edge_id_fk.sql
const MIGRATION_096 = resolve(__dirname, '../../database/migrations/096_minted_edge_id_fk.sql');
const MIG_SQL = readFileSync(MIGRATION_096, 'utf8');

const FK_NAME = 'belief_adjudications_minted_edge_id_fkey';
const STAMP = Date.now();
const PROJ_NAME = `mig096-minted-edge-fk-${STAMP}`;

let projectId: string;
let aId: string;
let bId: string;

/** Insert one adjudication row pointing at `edgeId` (or nowhere). Returns its id. */
async function seedAdjudication(
  edgeId: string | null,
  suffix: string,
  exec: { query: (q: string, v?: unknown[]) => Promise<{ rows: any[] }> } = db
): Promise<string> {
  const r = await exec.query(
    `INSERT INTO belief_adjudications
       (project_id, pair_key, a_id, a_type, b_id, b_type, same_subject,
        verdict, direction, mode, provider, model, derived_action, minted_edge_id)
     VALUES ($1, $2, $3, 'context', $4, 'context', true,
             'supersedes', 'a_supersedes_b', 'replaced', 'test', 'mig096', 'mint_supersedes', $5)
     RETURNING id`,
    [projectId, `${PROJ_NAME}-${suffix}`, aId, bId, edgeId]
  );
  return r.rows[0].id;
}

async function mintTheEdge(): Promise<string> {
  const minted = await mintEdge(
    {
      fromId: aId,
      fromType: 'context',
      toId: bId,
      toType: 'context',
      edgeType: 'possibly_supersedes',
      projectId,
      createdBy: BELIEF_EDGE_CREATED_BY,
      via: EDGE_MINT_VIA.beliefAdjudication,
      metadata: {},
    },
    db
  );
  expect(minted.created).toBe(true);
  expect(minted.edgeId).toBeTruthy();
  return minted.edgeId as string;
}

async function fkPresent(): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [FK_NAME]);
  return r.rows.length === 1;
}

beforeAll(async () => {
  // The test applies the EXACT migration string migrate.ts runs, so it is meaningful on a
  // DB provisioned before 096 existed and so a mutation of the migration FILE is what the
  // probe below actually mutates.
  await db.query(MIG_SQL);

  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'migration 096 minted_edge_id FK') RETURNING id`,
      [PROJ_NAME]
    )
  ).rows[0].id;

  // CHRONOLOGY: mintEdge refuses an edge whose direction contradicts its endpoints' order,
  // so A must be the LATER record. created_at is set explicitly — two inserts a microsecond
  // apart would leave the (created_at, id) order decided by a random uuid.
  const seed = async (content: string, ageMinutes: number): Promise<string> =>
    (
      await db.query(
        `INSERT INTO contexts (project_id, content, context_type, created_at)
         VALUES ($1, $2, 'completion', now() - ($3 || ' minutes')::interval) RETURNING id`,
        [projectId, content, String(ageMinutes)]
      )
    ).rows[0].id;
  aId = await seed(`mig096 A ${STAMP}`, 1);
  bId = await seed(`mig096 B ${STAMP}`, 2);
});

afterAll(async () => {
  await db.query('DELETE FROM belief_adjudications WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

describe('migration 096 — minted_edge_id cannot dangle', () => {
  test('the FK exists, references links(id), and is ON DELETE SET NULL', async () => {
    const { rows } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [FK_NAME]
    );
    expect(rows).toHaveLength(1);
    // The definition, not just the name: a FK to the wrong table, or with the wrong delete
    // action (CASCADE would destroy the audit row; RESTRICT would break retraction), would
    // pass a name-only check while being a different and wrong fix.
    expect(rows[0].def).toBe('FOREIGN KEY (minted_edge_id) REFERENCES links(id) ON DELETE SET NULL');
  });

  test('unlinkEdge — the retraction path that made the 30 orphans — now leaves the pointer NULL', async () => {
    const edgeId = await mintTheEdge();
    const adjId = await seedAdjudication(edgeId, 'retract');

    // CONTROL: the pointer really was set before the delete. Without this, a test that
    // only checks "NULL afterwards" passes against a column that was never populated.
    const before = await db.query(`SELECT minted_edge_id FROM belief_adjudications WHERE id = $1`, [
      adjId,
    ]);
    expect(before.rows[0].minted_edge_id).toBe(edgeId);

    // THE SHIPPED RETRACTION. Same call reconcileBeliefEdge's sweep makes: it deletes the
    // links row and writes nothing to belief_adjudications.
    const removed = await unlinkEdge(
      {
        fromId: aId,
        toId: bId,
        edgeType: 'possibly_supersedes',
        createdBy: BELIEF_EDGE_CREATED_BY,
      },
      db
    );
    expect(removed.removed).toBe(true);
    expect(removed.edgeId).toBe(edgeId);

    const after = await db.query(
      `SELECT minted_edge_id, verdict FROM belief_adjudications WHERE id = $1`,
      [adjId]
    );
    // The audit row SURVIVES — this is the reason for SET NULL over CASCADE, and a
    // regression to CASCADE would delete the row and fail here rather than silently.
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].verdict).toBe('supersedes');
    // ...and the pointer is gone rather than dangling.
    expect(after.rows[0].minted_edge_id).toBeNull();

    // The whole-population form of the same claim, on the real table: the exact prod query
    // that measured 30 must now be unable to return anything for this project.
    const dangling = await db.query(
      `SELECT count(*)::int AS c FROM belief_adjudications a
        WHERE a.project_id = $1 AND a.minted_edge_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM links l WHERE l.id = a.minted_edge_id)`,
      [projectId]
    );
    expect(dangling.rows[0].c).toBe(0);

    await db.query('DELETE FROM belief_adjudications WHERE id = $1', [adjId]);
  });

  test('a pointer at a links row that never existed is REJECTED on write', async () => {
    // The other half of the invariant: SET NULL closes the DELETE side, the FK itself
    // closes the INSERT side. A random uuid is the strongest case — nothing has ever
    // referenced it.
    const nowhere = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await expect(seedAdjudication(nowhere, 'nowhere')).rejects.toThrow();

    // TWO CONTROLS, so the rejection means "the FK fired" and not "this INSERT is malformed":
    // the same statement with a REAL edge id, and with NULL (the ordinary no-edge case,
    // which must stay legal — most of the 23,813 prod rows are exactly this).
    const edgeId = await mintTheEdge();
    const okReal = await seedAdjudication(edgeId, 'real-control');
    const okNull = await seedAdjudication(null, 'null-control');
    expect(okReal).toBeTruthy();
    expect(okNull).toBeTruthy();

    await db.query('DELETE FROM belief_adjudications WHERE id = ANY($1::uuid[])', [
      [okReal, okNull],
    ]);
    await unlinkEdge(
      {
        fromId: aId,
        toId: bId,
        edgeType: 'possibly_supersedes',
        createdBy: BELIEF_EDGE_CREATED_BY,
      },
      db
    );
  });

  test('the migration nulls pre-existing violators before adding the FK, and is idempotent', async () => {
    // Reproduces the PROD STATE the migration must survive: 30 rows already violating.
    // ADD CONSTRAINT validates immediately, so a migration that added the FK before the
    // null-out would abort here — this is the ordering proof, and it is the failure the
    // deploy would hit rather than a hypothetical.
    expect(await fkPresent()).toBe(true);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE belief_adjudications DROP CONSTRAINT ${FK_NAME}`);

      const violatorEdge = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      const violator = await seedAdjudication(violatorEdge, 'violator', client);
      const survivor = await seedAdjudication(null, 'survivor', client);

      const pre = await client.query(
        `SELECT count(*)::int AS c FROM belief_adjudications a
          WHERE a.project_id = $1 AND a.minted_edge_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM links l WHERE l.id = a.minted_edge_id)`,
        [projectId]
      );
      expect(pre.rows[0].c).toBe(1); // the pre-096 world, reconstructed

      // Run the real migration against it. It must not throw.
      await client.query(MIG_SQL);

      const post = await client.query(
        `SELECT id, minted_edge_id FROM belief_adjudications WHERE id = ANY($1::uuid[])`,
        [[violator, survivor]]
      );
      expect(post.rows).toHaveLength(2); // rows CLEANED, never deleted
      expect(post.rows.every((r: any) => r.minted_edge_id === null)).toBe(true);

      const conAfter = await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
        [FK_NAME]
      );
      expect(conAfter.rows).toHaveLength(1);
      expect(conAfter.rows[0].def).toBe(
        'FOREIGN KEY (minted_edge_id) REFERENCES links(id) ON DELETE SET NULL'
      );

      // IDEMPOTENT: a second application changes nothing and does not throw (the guarded
      // DO block sees the constraint, the index is IF NOT EXISTS, the UPDATE matches zero).
      await client.query(MIG_SQL);
      const conTwice = await client.query(
        `SELECT count(*)::int AS c FROM pg_constraint WHERE conname = $1`,
        [FK_NAME]
      );
      expect(conTwice.rows[0].c).toBe(1);
    } finally {
      // ALWAYS — the shared DB never sees the dropped constraint outside this transaction.
      await client.query('ROLLBACK');
      client.release();
    }

    expect(await fkPresent()).toBe(true);
  });
});
