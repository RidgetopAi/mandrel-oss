/**
 * MIGRATION 085 BACKFILL — DB-backed contract test (SK4).
 *
 * WHAT THIS PROVES, and why it cannot be proven any other way: after 085 runs, a row with a
 * NULL mint_via is unwritable, so the backfill's mapping has no live population to exercise
 * — the only rows it ever sees are the pre-085 ones, which no longer exist anywhere a test
 * can reach. So this suite RECREATES that population: it opens ONE client, drops the NOT
 * NULL inside a transaction, inserts rows shaped exactly like the historical ones (each
 * carrying one of the four old metadata keys, or only a created_by stamp, or nothing at
 * all), runs the migration's own backfill SQL, asserts the mapping, and ROLLS BACK. The
 * rollback is what makes the DDL safe: nothing outside this transaction ever observes a
 * links table without its NOT NULL.
 *
 * THE SQL IS NOT COPIED. It is read out of database/migrations/085_edge_mint_via_fail_closed.sql
 * between the @sk4-backfill markers and executed verbatim, so this test and the migration
 * cannot drift (C5 — one rule, one home). A missing marker is a hard failure, not a skip.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PoolClient } from 'pg';
import { db } from '../config/database.js';
import { EDGE_MINT_VIA, LEGACY_ONLY_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, '../../database/migrations/085_edge_mint_via_fail_closed.sql');

/** The migration's backfill statement, read from the file between its markers. */
function backfillSql(): string {
  const src = readFileSync(MIGRATION, 'utf8');
  const begin = src.indexOf('-- @sk4-backfill-begin');
  const end = src.indexOf('-- @sk4-backfill-end');
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `085 backfill markers not found in ${MIGRATION}. This test executes the migration's own ` +
        'SQL rather than a copy; if the markers were removed, restore them.'
    );
  }
  const sql = src.slice(begin + '-- @sk4-backfill-begin'.length, end).trim();
  if (!/^UPDATE links SET mint_via/.test(sql)) {
    throw new Error(`085 backfill block does not look like the backfill UPDATE:\n${sql.slice(0, 200)}`);
  }
  return sql;
}

let client: PoolClient;
let projectId: string;

async function newContext(content: string): Promise<string> {
  return (
    await client.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'discussion',$2) RETURNING id::text AS id`,
      [projectId, content]
    )
  ).rows[0].id;
}

/**
 * Insert a pre-085-shaped edge: mint_via NULL, plus whatever signal the historical row had.
 * Each case gets its OWN endpoint pair — links carries UNIQUE(from_id,to_id,edge_type), and
 * sharing one pair across cases would silently collapse two of them into a dedup.
 */
async function legacyEdge(
  label: string,
  createdBy: string | null,
  metadata: Record<string, unknown>
): Promise<string> {
  const from = await newContext(`085 from: ${label}`);
  const to = await newContext(`085 to: ${label}`);
  const r = await client.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, metadata)
     VALUES ($1, 'context', $2, 'context', 'informs', $3, $4, NULL, $5::jsonb) RETURNING id::text AS id`,
    [from, to, projectId, createdBy, JSON.stringify(metadata)]
  );
  return r.rows[0].id;
}

async function readEdge(id: string): Promise<{ mint_via: string; provenance_class: string }> {
  const r = await client.query(`SELECT mint_via, provenance_class FROM links WHERE id = $1`, [id]);
  return r.rows[0];
}

beforeAll(async () => {
  client = await db.connect();
  await client.query('BEGIN');
  // DDL is transactional in Postgres, so this is invisible outside the transaction and is
  // undone by the ROLLBACK in afterAll — including if an assertion throws.
  await client.query(`ALTER TABLE links ALTER COLUMN mint_via DROP NOT NULL`);
  projectId = (
    await client.query(
      `INSERT INTO projects (name, description) VALUES ($1, '085 backfill fixture') RETURNING id`,
      [`sk4-backfill-${Date.now()}`]
    )
  ).rows[0].id;
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
});

describe('migration 085 backfill — every historical provenance shape maps to a mint_via', () => {
  /**
   * One row per pre-085 shape found in the tree, with the via it must map to. The shapes are
   * the four metadata keys the mint sites actually wrote (measured by reading every mintEdge
   * caller at 35aef00) plus the created_by-only shapes, plus the no-signal shape.
   */
  const CASES: Array<{
    name: string;
    createdBy: string | null;
    metadata: Record<string, unknown>;
    via: string;
    cls: 'declared' | 'guessed' | 'unclassified';
  }> = [
    // ── metadata.via — positionalMint + handoffSupersession (already this vocabulary)
    { name: "metadata.via 'position'", createdBy: 'auto:positional', metadata: { via: 'position', spineType: 'task' }, via: EDGE_MINT_VIA.position, cls: 'declared' },
    { name: "metadata.via 'trunk-ref'", createdBy: 'auto:positional', metadata: { via: 'trunk-ref' }, via: EDGE_MINT_VIA.trunkRef, cls: 'declared' },
    { name: "metadata.via 'named-ref'", createdBy: 'auto:positional', metadata: { via: 'named-ref' }, via: EDGE_MINT_VIA.namedRef, cls: 'declared' },
    { name: "metadata.via 'handoff-timeline'", createdBy: 'auto:handoff-supersession', metadata: { via: 'handoff-timeline' }, via: EDGE_MINT_VIA.handoffTimeline, cls: 'declared' },
    // ── metadata.source — links.ts / threadInference / tasks.routes (the rename)
    { name: "metadata.source 'links_param'", createdBy: 'links:context_store', metadata: { source: 'links_param' }, via: EDGE_MINT_VIA.linksParam, cls: 'declared' },
    { name: "metadata.source 'dependencies'", createdBy: 'auto:task_deps', metadata: { source: 'dependencies', ref: 'abc12345' }, via: EDGE_MINT_VIA.taskDependencies, cls: 'declared' },
    { name: "metadata.source 'decision_evidence'", createdBy: 'auto:decision_record', metadata: { source: 'decision_evidence', ref: 'abc12345' }, via: EDGE_MINT_VIA.decisionEvidence, cls: 'declared' },
    { name: "metadata.source 'superseded_by'", createdBy: 'auto:decision_update', metadata: { source: 'superseded_by' }, via: EDGE_MINT_VIA.decisionSupersededBy, cls: 'declared' },
    { name: "metadata.source 'parent_task_id_param'", createdBy: 'links:task_parent', metadata: { source: 'parent_task_id_param' }, via: EDGE_MINT_VIA.parentTaskParam, cls: 'declared' },
    { name: "metadata.source 'inference'", createdBy: 'auto:inference', metadata: { source: 'inference', similarity: 0.91 }, via: EDGE_MINT_VIA.inference, cls: 'guessed' },
    // ── metadata.source_tag — the tag path. The KEY is the evidence; the VALUE is raw text.
    { name: 'metadata.source_tag (tag path)', createdBy: 'auto:context_store', metadata: { source_tag: 'task:1a2b3c4d' }, via: EDGE_MINT_VIA.tag, cls: 'declared' },
    // THE CORRECTION 085 makes deliberately: backfillTypedEdges stamps 'backfill' (which 079
    // classified GUESSED) but mints through autoMintFromTags — an at-origin-DECLARED signal.
    // The tag evidence outranks the stamp, so this row moves to the declared bucket.
    { name: "created_by 'backfill' WITH a source_tag → declared, not guessed", createdBy: 'backfill', metadata: { source_tag: 'decision:9f8e7d6c' }, via: EDGE_MINT_VIA.tag, cls: 'declared' },
    // ── created_by only — the paths that wrote no metadata label at all
    { name: "created_by 'link' with EMPTY metadata (the bare-supersedes shape)", createdBy: 'link', metadata: {}, via: EDGE_MINT_VIA.linkTool, cls: 'declared' },
    { name: "created_by 'auto:belief-adjudicator'", createdBy: 'auto:belief-adjudicator', metadata: { confidence: 0.8 }, via: EDGE_MINT_VIA.beliefAdjudication, cls: 'guessed' },
    { name: "created_by 'backfill:orphan-threads'", createdBy: 'backfill:orphan-threads', metadata: { provenance: 'backfill', method: 'embedding-cosine-nn' }, via: EDGE_MINT_VIA.inference, cls: 'guessed' },
    { name: "created_by 'auto:active_thread' (retired anchor)", createdBy: 'auto:active_thread', metadata: {}, via: LEGACY_ONLY_MINT_VIA.anchor, cls: 'guessed' },
    // ── THE LEGACY CLASS: no metadata label, no unambiguous stamp
    { name: 'an ambiguous stamp with no metadata label', createdBy: 'auto:decision_record', metadata: {}, via: LEGACY_ONLY_MINT_VIA.legacyUnlabeled, cls: 'unclassified' },
    { name: 'a NULL stamp with no metadata at all', createdBy: null, metadata: {}, via: LEGACY_ONLY_MINT_VIA.legacyUnlabeled, cls: 'unclassified' },
  ];

  test('the backfill maps every historical shape, and invents nothing where there was no signal', async () => {
    const ids: string[] = [];
    for (const c of CASES) {
      ids.push(await legacyEdge(c.name, c.createdBy, c.metadata));
    }

    // CONTROL — before the backfill every fixture is genuinely unlabelled, so a passing
    // assertion below cannot be an artifact of the rows having arrived already labelled.
    const before = await client.query(
      `SELECT count(*)::int AS n FROM links WHERE id = ANY($1::uuid[]) AND mint_via IS NULL`,
      [ids]
    );
    expect(before.rows[0].n).toBe(CASES.length);

    await client.query(backfillSql());

    for (let i = 0; i < CASES.length; i++) {
      const got = await readEdge(ids[i]);
      expect(got.mint_via, CASES[i].name).toBe(CASES[i].via);
      expect(got.provenance_class, CASES[i].name).toBe(CASES[i].cls);
    }

    // AND NOTHING IS LEFT UNLABELLED — the property that lets the migration then add NOT NULL.
    const after = await client.query(
      `SELECT count(*)::int AS n FROM links WHERE id = ANY($1::uuid[]) AND mint_via IS NULL`,
      [ids]
    );
    expect(after.rows[0].n).toBe(0);
  });
});
