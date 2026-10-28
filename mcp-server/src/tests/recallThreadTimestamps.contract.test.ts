/**
 * recall_thread NODES CARRY THEIR RECORD TIME — contract (dogfood finding 1).
 *
 * A blind agent asked "what happened overnight" anchored recall_thread on a task at every
 * altitude and got nodes with no time, so the timeline had to be rebuilt by opening each
 * record. This drives the REAL tool through validateToolArguments → routeExecutor (the path
 * the HTTP bridge uses) against the CI Postgres: three records inform one task anchor at
 * known, DISTINCT created_at values, and at every altitude asserts
 *   - STRUCTURED: each node's `createdAt` equals the stored value (ISO-8601 UTC),
 *   - TEXT: each node's line contains that node's minute-precision UTC timestamp,
 *   - ORDER: two contexts of equal causal rank (both inform the anchor) appear oldest first.
 *
 * EVERY EXPECTED STRING IS A LITERAL — an oracle computed by the code under test would
 * prove only that the code agrees with itself.
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
const CONN = `recall-thread-ts-conn-${STAMP}`;
const PROJ_NAME = `recall-thread-ts-P-${STAMP}`;

// Distinct, literal times. Seconds are non-zero so the minute-precision text is a
// TRUNCATION of the stored value, not an accident of round numbers.
const T_DISPATCH = '2026-10-22T04:31:17.000Z'; // oldest
const T_LATER = '2026-10-22T07:16:42.000Z';
const T_TASK_ANCHOR = '2026-10-22T09:05:09.000Z';
const M_DISPATCH = '2026-10-22T04:31Z';
const M_LATER = '2026-10-22T07:16Z';
const M_TASK_ANCHOR = '2026-10-22T09:05Z';
const M_DECISION = '2026-10-22T05:45Z';
const T_DECISION = '2026-10-22T05:45:30.000Z';

let projectId: string;
let taskId: string;
let ctxOld: string;
let ctxNew: string;
let decId: string;

const TITLE_OLD = `ts-dispatch-old-${STAMP}`;
const TITLE_NEW = `ts-later-new-${STAMP}`;
const TITLE_DEC = `ts-decision-${STAMP}`;
const TITLE_TASK = `ts-anchor-task-${STAMP}`;

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}
const textOf = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';

/** Every node a response carries, whichever answer shape the altitude uses. */
function allNodes(sc: any): any[] {
  if (sc.nodes) return sc.nodes;
  const cs = sc.currentState;
  const out: any[] = cs.root ? [cs.root] : [];
  for (const k of ['activeTasks', 'blockers', 'latestTrustedOutcomes', 'recentContexts', 'currentDecisions']) {
    out.push(...(cs[k]?.items ?? []));
  }
  return out;
}

describe('recall_thread nodes carry their record time', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'ts contract') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    taskId = (await viaTool('task_create', { title: TITLE_TASK, type: 'feature' })).structuredContent.task.id;
    ctxOld = (await viaTool('context_store', { content: TITLE_OLD, type: 'planning' })).structuredContent.context.id;
    ctxNew = (await viaTool('context_store', { content: TITLE_NEW, type: 'planning' })).structuredContent.context.id;
    decId = (
      await viaTool('decision_record', {
        decisionType: 'architecture',
        title: TITLE_DEC,
        description: 'd',
        rationale: 'r',
        impactLevel: 'medium',
      })
    ).structuredContent.decision.id;

    // Insert the NEWER context's edge first so a pass cannot come from insertion order.
    await viaTool('link', { from: ctxNew, fromType: 'context', to: taskId, toType: 'task', edgeType: 'informs' });
    await viaTool('link', { from: ctxOld, fromType: 'context', to: taskId, toType: 'task', edgeType: 'informs' });
    await viaTool('link', { from: decId, fromType: 'decision', to: taskId, toType: 'task', edgeType: 'informs' });

    await db.query('UPDATE contexts SET created_at = $2 WHERE id = $1', [ctxOld, T_DISPATCH]);
    await db.query('UPDATE contexts SET created_at = $2 WHERE id = $1', [ctxNew, T_LATER]);
    await db.query('UPDATE technical_decisions SET decision_date = $2 WHERE id = $1', [decId, T_DECISION]);
    await db.query('UPDATE tasks SET created_at = $2 WHERE id = $1', [taskId, T_TASK_ANCHOR]);
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  const EXPECT = () => [
    { id: ctxOld, title: TITLE_OLD, iso: T_DISPATCH, minute: M_DISPATCH },
    { id: ctxNew, title: TITLE_NEW, iso: T_LATER, minute: M_LATER },
    { id: decId, title: TITLE_DEC, iso: T_DECISION, minute: M_DECISION },
    { id: taskId, title: TITLE_TASK, iso: T_TASK_ANCHOR, minute: M_TASK_ANCHOR },
  ];

  for (const altitude of ['headline', 'summary', 'full', 'current']) {
    test(`altitude ${altitude}: structured createdAt and text-line minute stamp on every node`, async () => {
      const resp = await viaTool('recall_thread', { anchor: taskId, altitude });
      const sc = resp.structuredContent;
      expect(sc.ok).toBe(true);
      const nodes = allNodes(sc);
      const text = textOf(resp);
      const lines = text.split('\n');

      for (const e of EXPECT()) {
        const node = nodes.find((n) => n.id === e.id);
        expect(node, `${altitude}: node ${e.title} present`).toBeDefined();
        expect(node.createdAt, `${altitude}: ${e.title} createdAt`).toBe(e.iso);
        const line = lines.find((l) => l.includes(e.title));
        expect(line, `${altitude}: text line for ${e.title}`).toBeDefined();
        expect(line, `${altitude}: ${e.title} line carries ${e.minute}`).toContain(e.minute);
      }
      // No node anywhere lacks a time.
      for (const n of nodes) expect(typeof n.createdAt, `${altitude}: ${n.id}`).toBe('string');
    });
  }

  for (const altitude of ['headline', 'summary', 'full']) {
    test(`altitude ${altitude}: equal-rank contexts appear oldest first`, async () => {
      const resp = await viaTool('recall_thread', { anchor: taskId, altitude });
      const ids = resp.structuredContent.nodes.map((n: any) => n.id);
      expect(ids.indexOf(ctxOld)).toBeGreaterThan(-1);
      expect(ids.indexOf(ctxOld)).toBeLessThan(ids.indexOf(ctxNew));
      // and the text channel lists them in that same order
      const text = textOf(resp);
      expect(text.indexOf(TITLE_OLD)).toBeLessThan(text.indexOf(TITLE_NEW));
    });
  }
});
