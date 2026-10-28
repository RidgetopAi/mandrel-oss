/**
 * recall_thread DEFAULT WALK keeps related_to on a leash — contract (dogfood
 * finding 2). At default depth the walk followed related_to two hops and drowned in
 * unrelated neighbours (107 nodes, ~60% noise). Drives the REAL tool through
 * validateToolArguments → routeExecutor against the CI Postgres.
 *
 * Fixture: anchor task T; contexts A (older) and B (newer) inform T; context R related_to T;
 * context X related_to R; task U with B related_to U.
 *   default call (no edgeTypes): A, B, R — never X, never U; A, B before R; A before B.
 *   explicit edgeTypes [related_to, informs] depth 2: X and U ARE returned (arg unchanged).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const CONN = `recall-thread-dw-conn-${STAMP}`;
const PROJ_NAME = `recall-thread-dw-P-${STAMP}`;

const T_A = '2026-10-22T04:31:17.000Z'; // oldest
const T_B = '2026-10-22T07:16:42.000Z';
// R is the OLDEST of all, so a pass for A/B-before-R cannot come from time order.
const T_R = '2026-10-21T01:00:00.000Z';

let taskT: string;
let taskU: string;
let ctxA: string;
let ctxB: string;
let ctxR: string;
let ctxX: string;
let ctxY: string; // informs R — only reachable by EXPANDING R, which the default walk never does
let taskM: string; // subtask_of T: a rank-0 membership node NEWER than R

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}
const link = (from: string, fromType: string, to: string, toType: string, edgeType: string) =>
  viaTool('link', { from, fromType, to, toType, edgeType });
const idsOf = (resp: any): string[] => resp.structuredContent.nodes.map((n: any) => n.id);

describe('recall_thread default walk leashes related_to', () => {
  beforeAll(async () => {
    const projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'dw contract') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    taskT = (await viaTool('task_create', { title: `dw-anchor-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    taskU = (await viaTool('task_create', { title: `dw-U-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    const store = async (c: string) =>
      (await viaTool('context_store', { content: `${c}-${STAMP}`, type: 'planning' })).structuredContent.context.id;
    ctxA = await store('dw-A');
    ctxB = await store('dw-B');
    ctxR = await store('dw-R');
    ctxX = await store('dw-X');
    ctxY = await store('dw-Y');
    taskM = (await viaTool('task_create', { title: `dw-M-${STAMP}`, type: 'feature' })).structuredContent.task.id;

    // Newer informs edge first so a pass cannot come from insertion order.
    await link(ctxB, 'context', taskT, 'task', 'informs');
    await link(ctxA, 'context', taskT, 'task', 'informs');
    await link(ctxR, 'context', taskT, 'task', 'related_to');
    await link(ctxX, 'context', ctxR, 'context', 'related_to');
    await link(ctxB, 'context', taskU, 'task', 'related_to');
    await link(ctxY, 'context', ctxR, 'context', 'informs');
    await link(taskM, 'task', taskT, 'task', 'subtask_of');

    await db.query('UPDATE contexts SET created_at = $2 WHERE id = $1', [ctxA, T_A]);
    await db.query('UPDATE contexts SET created_at = $2 WHERE id = $1', [ctxB, T_B]);
    await db.query('UPDATE contexts SET created_at = $2 WHERE id = $1', [ctxR, T_R]);
  });

  afterAll(async () => {
    try {
      const pid = (await db.query('SELECT id FROM projects WHERE name = $1', [PROJ_NAME])).rows[0]?.id;
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* ignore */ }
    await db.end();
  });

  test('default call: A, B, R returned; X (via related_to R) and U (related_to out of B) are not', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskT, altitude: 'headline' });
    expect(resp.structuredContent.ok).toBe(true);
    const ids = idsOf(resp);
    expect(ids).toContain(ctxA);
    expect(ids).toContain(ctxB);
    expect(ids).toContain(ctxR);
    expect(ids).not.toContain(ctxX);
    expect(ids).not.toContain(taskU);
    expect(ids).not.toContain(ctxY); // R is a destination, not a corridor: its informs edge is not walked
    expect(ids).toContain(taskM);
  });

  test('default call order: causal/membership nodes (A then B) before the related_to-only node (R)', async () => {
    const ids = idsOf(await viaTool('recall_thread', { anchor: taskT, altitude: 'headline' }));
    expect(ids[0]).toBe(taskT);
    expect(ids.indexOf(ctxA)).toBeLessThan(ids.indexOf(ctxB));
    expect(ids.indexOf(ctxB)).toBeLessThan(ids.indexOf(ctxR));
    // M ties R on causal rank (0) and is NEWER, so only the membership-before-related_to rule
    // (not rank, not time) puts it ahead of R.
    expect(ids.indexOf(taskM)).toBeLessThan(ids.indexOf(ctxR));
  });

  test('explicit edgeTypes [related_to, informs] at depth 2 is unchanged: X and U are returned', async () => {
    const resp = await viaTool('recall_thread', {
      anchor: taskT,
      altitude: 'headline',
      depth: 2,
      edgeTypes: ['related_to', 'informs'],
    });
    const ids = idsOf(resp);
    for (const id of [ctxA, ctxB, ctxR, ctxX, ctxY, taskU]) expect(ids).toContain(id);
  });
});
