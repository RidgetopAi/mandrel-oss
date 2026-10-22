/**
 * POSITION IS PER-LOOP — the an earlier task contract.
 *
 * THE INCIDENT THIS REPRODUCES (measured on prod 2026-08-13, twice): two concurrent
 * Builders with DISTINCT X-Connection-IDs and the SAME X-Actor-ID resolved to ONE DB
 * session under MANDREL_SESSION_RESOLVER_MODE=actor (resolveSession keys sessions by
 * actor; ensureSessionForActor caches that one session under every calling connection).
 * Position keying then dereferenced the RAM-cached session id, so a branch position
 * opened by one Builder's task claim stamped false DECLARED-tier `informs` edges onto
 * the OTHER Builder's completion writes (prod edges cf9911a9, 2c8c796d — both pruned),
 * and one branch_close cleared both agents' positions.
 *
 * THE INVARIANT: a position belongs to a LOOP — the connection identity — in every
 * resolver mode. Same actor + different connection = different loop = isolated position.
 * Same connection = same loop = position behaves exactly as before (open, mint, close).
 *
 * Driven through the FULL public path (validate → routeExecutor) against the disposable
 * migrated ci_* DB, with resolverMode flipped to 'actor' — the prod configuration the
 * incident occurred under (C3: the guard runs the production CONFIGURATION, not just the
 * code path). Embeddings mocked to zeros (similarity plays no role in positions).
 */

import { describe, test, expect, afterAll, afterEach, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string, actor?: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn, actor });
}

async function freshProject(label: string): Promise<string> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'position-per-loop fixture') RETURNING id`,
      [`ppl-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  return projectId;
}

/** ALL link rows from one record to one target (any edge type, any creator). */
async function linksBetween(fromId: string, toId: string) {
  return (
    await db.query(`SELECT edge_type, created_by FROM links WHERE from_id = $1 AND to_id = $2`, [
      fromId,
      toId,
    ])
  ).rows;
}

const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode;
  ActiveSessionStore.clearAll();
});

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM analytics_events WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch {
      /* best-effort fixture teardown */
    }
  }
});

describe('position is per-loop: concurrent connections of ONE actor never share a position (actor mode)', () => {
  test('agent B inherits NOTHING from agent A: no positional edge, no visible position, independent close', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `qa-ppl-builder-${STAMP}`;
    const projectId = await freshProject('incident');
    const connA = `ppl-connA-${STAMP}`;
    const connB = `ppl-connB-${STAMP}`;
    await viaTool('project_switch', { project: projectId }, connA);
    await viaTool('project_switch', { project: projectId }, connB);

    // Agent A: create a task and start work on it — the byproduct opens A's position on T
    // (exactly how the prod Builders acquired theirs: task claim / in_progress).
    const taskResp = await viaTool('task_create', { title: 'A-owned task', type: 'feature' }, connA, actor);
    const taskId: string = taskResp.structuredContent.task.id;
    await viaTool('task_update', { taskId, status: 'in_progress' }, connA, actor);
    const currentA = await viaTool('branch_current', {}, connA, actor);
    expect(currentA.structuredContent.position?.spineId).toBe(taskId);

    // Agent B (SAME actor, DIFFERENT connection — actor mode resolves both to ONE DB
    // session): a plain completion write naming no ids. This is the exact prod write that
    // minted the false declared edge.
    const ctxResp = await viaTool(
      'context_store',
      { content: 'completion prose from agent B, naming no record ids at all', type: 'completion' },
      connB,
      actor
    );
    const ctxId: string = ctxResp.structuredContent.context.id;

    // THE INCIDENT ASSERTION: zero edges of any kind from B's context to A's task. Under
    // session-keyed positions this minted `informs` created_by 'auto:positional' (prod
    // edge 2c8c796d's shape).
    expect(await linksBetween(ctxId, taskId)).toEqual([]);

    // B's own view: whatever position B now holds (auto-open on its own record is fine),
    // it is NOT A's task.
    const currentB = await viaTool('branch_current', {}, connB, actor);
    expect(currentB.structuredContent.position?.spineId).not.toBe(taskId);

    // Probe (b) inverted: closing A's branch closes A ONLY — A reports the task it stood
    // on; a re-close on A is 'absent'; and B's state is untouched by A's close.
    const closeA = await viaTool('branch_close', {}, connA, actor);
    expect(closeA.structuredContent.action).toBe('closed');
    expect(closeA.structuredContent.closedPosition?.spineId).toBe(taskId);
    const closeB = await viaTool('branch_close', {}, connB, actor);
    // B closes its OWN position (the auto-open on its context) or had none — never A's task.
    expect(closeB.structuredContent.closedPosition?.spineId ?? null).not.toBe(taskId);
  });

  test('probes (c)/(d): a fresh connection under the same actor sees no position and closes nothing', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `qa-ppl-cleanup-${STAMP}`;
    const projectId = await freshProject('freshconn');
    const connC = `ppl-connC-${STAMP}`;
    const connFresh = `ppl-conn-fresh-${STAMP}`;
    await viaTool('project_switch', { project: projectId }, connC);
    await viaTool('project_switch', { project: projectId }, connFresh);

    const t = await viaTool('task_create', { title: 'C-owned task', type: 'feature' }, connC, actor);
    const taskId: string = t.structuredContent.task.id;
    await viaTool('task_update', { taskId, status: 'in_progress' }, connC, actor);

    // Fresh connection, same actor: no position visible (probe d)…
    const currentFresh = await viaTool('branch_current', {}, connFresh, actor);
    expect(currentFresh.structuredContent.position).toBeNull();
    // …and branch_close is a no-op that does NOT clear C's position (probe c, now correct
    // for the right reason: different loop, not RAM-cache luck).
    const closeFresh = await viaTool('branch_close', {}, connFresh, actor);
    expect(closeFresh.structuredContent.action).toBe('absent');
    const currentC = await viaTool('branch_current', {}, connC, actor);
    expect(currentC.structuredContent.position?.spineId).toBe(taskId);
  });

  test('single-loop flow is unchanged in actor mode: claim opens, write mints membership, close steps off', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `qa-ppl-solo-${STAMP}`;
    const projectId = await freshProject('solo');
    const conn = `ppl-conn-solo-${STAMP}`;
    await viaTool('project_switch', { project: projectId }, conn);

    const t = await viaTool('task_create', { title: 'solo task', type: 'feature' }, conn, actor);
    const taskId: string = t.structuredContent.task.id;
    await viaTool('task_update', { taskId, status: 'in_progress' }, conn, actor);

    const ctx = await viaTool(
      'context_store',
      { content: 'solo completion for the claimed task', type: 'completion' },
      conn,
      actor
    );
    const ctxId: string = ctx.structuredContent.context.id;

    // The SAME loop still mints positional membership onto its own claimed task.
    const edges = await linksBetween(ctxId, taskId);
    expect(edges).toContainEqual({ edge_type: 'informs', created_by: 'auto:positional' });

    const close = await viaTool('branch_close', {}, conn, actor);
    expect(close.structuredContent.action).toBe('closed');
    expect(close.structuredContent.closedPosition?.spineId).toBe(taskId);
  });
});
