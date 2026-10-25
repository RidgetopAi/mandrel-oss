/**
 * EPIC REACHABILITY — PHASE 2 acceptance 6 (folded from an earlier change).
 *
 * THE PROD FINDING: an earlier epic (`EPIC: Command UI redesign BUILD`) has ZERO
 * task→task structural edges — measured on prod 2026-08-13, its edges group entirely
 * into context→task rows stamped auto:active_thread (24, the RETIRED anchor) and
 * auto:context_store (10). When those age out of relevance, the epic falls off the map.
 * (Command: SELECT created_by, from_type||'->'||to_type, count(*) FROM links WHERE
 * to_id='<epic>' OR from_id='<epic>' GROUP BY 1,2.)
 *
 * THE CONTRACT (re-aimed by an earlier task): an epic's child task reaches it via the
 * STRUCTURAL parent edge (`subtask_of`, migration 080) minted by the DECLARED
 * `parentTaskId` param on task_create — no anchor, no guess, and NOT by position (a
 * structural claim needs explicit intent). This test SEEDS THE PROD COPY (the epic under
 * its real UUID) into the disposable DB, drives the real public path (branch_open on the
 * epic → task_create with parentTaskId), and asserts the path at the ROW level, plus its
 * provenance class in the 079/081 view.
 *
 * Embeddings mocked to zeros (structure, not similarity, is the mechanism under test).
 * DB target: the disposable migrated ci_* DB — never production.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';

/** The PROD epic's real id — seeded here as the prod copy (acceptance 6's subject). */
const EPIC_ID = '886df00d-c6e3-4584-888a-1ecfffe35b74';

const STAMP = Date.now();
let projectId: string;

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}

afterAll(async () => {
  if (projectId) {
    await db.query(`DELETE FROM branch_positions WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM links WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }
  await db.end?.();
});

describe('PHASE 2 acceptance 6 — the epic is reachable via the STRUCTURAL parent edge', () => {
  test('branch_open on the seeded prod epic + task_create(parentTaskId) → subtask_of row, DECLARED, epic reachable', async () => {
    // Seed the prod copy: the epic under its REAL uuid, in a fresh project.
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'acceptance-6 fixture') RETURNING id`,
        [`p2epic-${STAMP}`],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO tasks (id, project_id, title, status, type, tags)
       VALUES ($1, $2, 'EPIC: Command UI redesign BUILD (Vite shell + 13-screen port)', 'completed', 'feature',
               ARRAY['epic','command-redesign'])`,
      [EPIC_ID, projectId],
    );

    const conn = `p2epic-conn-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });

    // Stand on the epic (the P1 positional model) AND declare it as the parent — the
    // exact flow an agent runs. Position carries membership; the `parentTaskId` param is
    // what carries structural parenthood (position alone must NOT).
    const open = await viaTool('branch_open', { id: EPIC_ID }, conn);
    expect(open.structuredContent?.ok).toBe(true);

    const created = await viaTool(
      'task_create',
      { title: `child subtask of the epic ${STAMP}`, type: 'feature', parentTaskId: EPIC_ID },
      conn,
    );
    const subtaskId = created.structuredContent?.task?.id as string;
    expect(subtaskId).toBeTruthy();

    // THE PATH, at the row level: subtask --subtask_of--> epic (task→task, structural).
    const parentEdge = (
      await db.query(
        `SELECT from_type, to_type, edge_type, created_by FROM links
          WHERE from_id = $1 AND to_id = $2 AND edge_type = 'subtask_of'`,
        [subtaskId, EPIC_ID],
      )
    ).rows;
    expect(parentEdge).toEqual([
      { from_type: 'task', to_type: 'task', edge_type: 'subtask_of', created_by: 'links:task_parent' },
    ]);

    // Its provenance is DECLARED in the meter view — structural, not a guess, and not
    // dependent on any retired anchor stamp.
    const cls = (
      await db.query(
        `SELECT provenance_class FROM link_provenance
          WHERE from_id = $1 AND to_id = $2 AND edge_type = 'subtask_of'`,
        [subtaskId, EPIC_ID],
      )
    ).rows;
    expect(cls).toEqual([{ provenance_class: 'declared' }]);

    // REACHABILITY over the links graph alone: from the subtask, one hop over the
    // structural edge reaches the epic — with ZERO auto:active_thread edges in the
    // project (the retired mechanism cannot be what connects them here).
    const anchorEdges = (
      await db.query(
        `SELECT count(*)::int AS n FROM links WHERE project_id = $1 AND created_by = 'auto:active_thread'`,
        [projectId],
      )
    ).rows[0].n;
    expect(anchorEdges).toBe(0);
    const reachable = (
      await db.query(
        `SELECT 1 FROM links
          WHERE from_id = $1 AND to_id = $2 AND edge_type = 'subtask_of'`,
        [subtaskId, EPIC_ID],
      )
    ).rows.length;
    expect(reachable).toBe(1);
  });
});
