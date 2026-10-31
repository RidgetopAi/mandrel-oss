/**
 * recall_thread "Mentioned by other threads" — contract (dogfood finding 4).
 * A record that names the anchor but belongs to ANOTHER task's thread (an earlier change ← an earlier change
 * "already fixed on main by an earlier change") must surface as `mentionedBy` + a text section.
 * Drives validateToolArguments → routeExecutor against the CI Postgres.
 *
 * Fixture: anchor task T; task V; context M informs V, M related_to T, content names T's id8;
 * context N related_to T with NO informs edge; context P informs T.
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
const CONN = `recall-thread-mb-conn-${STAMP}`;
const PROJ_NAME = `recall-thread-mb-P-${STAMP}`;

let taskT: string;
let taskV: string;
let ctxM: string;
let ctxN: string;
let ctxP: string;
let ctxM2: string;

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}
const link = (from: string, fromType: string, to: string, toType: string, edgeType: string) =>
  viaTool('link', { from, fromType, to, toType, edgeType });

describe('recall_thread mentionedBy', () => {
  beforeAll(async () => {
    const projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'mb contract') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    taskT = (await viaTool('task_create', { title: `mb-anchor-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    taskV = (await viaTool('task_create', { title: `mb-V-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    const store = async (content: string) =>
      (await viaTool('context_store', { content, type: 'planning' })).structuredContent.context.id;
    const id8 = taskT.slice(0, 8);
    ctxM = await store(`${'lead-in padding '.repeat(40)} The daemon-exit bug was already fixed on main by ${id8} (commit b05be2e). ${'trailing padding '.repeat(40)} ${STAMP}`);
    ctxM2 = await store(`mb-M2 also names ${id8} ${STAMP}`);
    ctxN = await store(`mb-N names ${id8} but belongs to no task ${STAMP}`);
    ctxP = await store(`mb-P is a member of the anchor ${STAMP}`);

    await link(ctxM, 'context', taskV, 'task', 'informs');
    await link(ctxM, 'context', taskT, 'task', 'related_to');
    await link(ctxM2, 'context', taskV, 'task', 'informs');
    await link(ctxM2, 'context', taskT, 'task', 'related_to');
    await link(ctxN, 'context', taskT, 'task', 'related_to');
    await link(ctxP, 'context', taskT, 'task', 'informs');

    await db.query('UPDATE contexts SET created_at = $2 WHERE id = $1', [ctxM, '2026-10-22T06:56:00.000Z']);
    await db.query('UPDATE contexts SET created_at = $2 WHERE id = $1', [ctxM2, '2026-10-22T05:00:00.000Z']);
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

  test('summary: mentionedBy is exactly M and M2 (oldest first), with task V and an id8 snippet; N and P absent', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskT, altitude: 'summary' });
    const mb = resp.structuredContent.mentionedBy;
    expect(mb.map((m: any) => m.id)).toEqual([ctxM2, ctxM]);
    const m = mb.find((x: any) => x.id === ctxM);
    expect(m.taskId).toBe(taskV);
    expect(m.createdAt).toBe('2026-10-22T06:56:00.000Z');
    expect(m.snippet).toContain(taskT.slice(0, 8));
    expect(m.snippet.length).toBeLessThanOrEqual(240 + 2);
    const ids = mb.map((x: any) => x.id);
    expect(ids).not.toContain(ctxN);
    expect(ids).not.toContain(ctxP);
    const text: string = resp.content[0].text;
    expect(text).toContain('Mentioned by other threads');
    expect(text).toContain(ctxM);
    expect(text).toContain(taskV);
  });

  test('headline: structured list present', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskT, altitude: 'headline' });
    expect(resp.structuredContent.mentionedBy.map((m: any) => m.id)).toEqual([ctxM2, ctxM]);
  });

  test('full: text section present', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskT, altitude: 'full' });
    expect(resp.content[0].text).toContain('Mentioned by other threads');
  });

  test('maxNodes:1 does not clip the list', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskT, altitude: 'summary', maxNodes: 1 });
    expect(resp.structuredContent.nodes.length).toBe(1);
    expect(resp.structuredContent.mentionedBy.map((m: any) => m.id)).toEqual([ctxM2, ctxM]);
    expect(resp.content[0].text).toContain(ctxM);
  });

  test('a non-task anchor has no mentionedBy', async () => {
    const resp = await viaTool('recall_thread', { anchor: ctxM, altitude: 'headline' });
    expect(resp.structuredContent.mentionedBy).toEqual([]);
  });
});
