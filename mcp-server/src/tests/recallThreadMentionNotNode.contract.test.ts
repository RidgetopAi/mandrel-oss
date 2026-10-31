/**
 * recall_thread MENTION-NOT-NODE — contract. In the DEFAULT walk an inbound
 * auto:positional related_to from a member of a DIFFERENT spine is a mention (mentionedBy),
 * not a node. Declared links, no-other-spine records and explicit edgeTypes are unchanged.
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

import { mintEdge } from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const CONN = `recall-thread-mnn-conn-${STAMP}`;
const PROJ_NAME = `recall-thread-mnn-P-${STAMP}`;

let taskT: string;
let taskV: string;
let ctxM: string;
let ctxD: string;
let ctxL: string;
let ctxP: string;

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}
const link = (from: string, fromType: string, to: string, toType: string, edgeType: string) =>
  viaTool('link', { from, fromType, to, toType, edgeType });
const ids = (r: any) => r.structuredContent.nodes.map((n: any) => n.id);

describe('recall_thread mention-not-node', () => {
  beforeAll(async () => {
    const projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'mnn contract') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
    taskT = (await viaTool('task_create', { title: `mnn-anchor-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    taskV = (await viaTool('task_create', { title: `mnn-V-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    const store = async (content: string) =>
      (await viaTool('context_store', { content, type: 'planning' })).structuredContent.context.id;
    ctxM = await store(`mnn-M names ${taskT.slice(0, 8)} ${STAMP}`);
    ctxD = await store(`mnn-D declared ${STAMP}`);
    ctxL = await store(`mnn-L names ${taskT.slice(0, 8)} ${STAMP}`);
    ctxP = await store(`mnn-P member ${STAMP}`);
    await link(ctxM, 'context', taskV, 'task', 'informs');
    await link(ctxD, 'context', taskV, 'task', 'informs');
    await link(ctxP, 'context', taskT, 'task', 'informs');
    await link(ctxD, 'context', taskT, 'task', 'related_to'); // declared (created_by not auto:positional)
    // The name-scan's edges: stamped exactly as positionalMint stamps them.
    for (const c of [ctxM, ctxL]) {
      await mintEdge(
        {
          fromId: c, fromType: 'context', toId: taskT, toType: 'task', edgeType: 'related_to',
          projectId, createdBy: 'auto:positional', via: EDGE_MINT_VIA.namedRef,
        },
        db
      );
    }
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

  test('default walk: P, D and L are nodes; M (auto:positional + other spine) is not and is in mentionedBy', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskT, altitude: 'headline' });
    const got = ids(resp);
    expect(got).toContain(ctxP);
    expect(got).toContain(ctxD);
    expect(got).toContain(ctxL);
    expect(got).not.toContain(ctxM);
    expect(resp.structuredContent.mentionedBy.map((m: any) => m.id)).toContain(ctxM);
    expect(resp.content[0].text).toContain('Mentioned by other threads');
  });

  test('explicit edgeTypes naming related_to: M is a node', async () => {
    const resp = await viaTool('recall_thread', {
      anchor: taskT,
      altitude: 'headline',
      edgeTypes: ['related_to', 'informs'],
    });
    expect(ids(resp)).toContain(ctxM);
  });
});
