/**
 * recall_thread record kind + superseded history + trust legend — contract.
 * Display-only: kinds ride on nodes, superseded records are listed as history, the header
 * states what the trust band means. Trust bands/scores/abstain are NOT moved.
 * Drives validateToolArguments → routeExecutor against the CI Postgres.
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
import { THREAD_CONFIG, THREAD_SUPERSEDED_SECTION_TITLE } from '../config/threadConfig.js';
import { trustForRecord } from '../services/trust.js';

const STAMP = Date.now();
const CONN = `recall-thread-kind-conn-${STAMP}`;
const PROJ_NAME = `recall-thread-kind-P-${STAMP}`;

let projectId: string;
let taskId: string;
const ids: Record<string, string> = {};

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

async function mkContext(key: string, content: string, type: string, metadata?: unknown) {
  const id = (await viaTool('context_store', { content, type })).structuredContent.context.id;
  if (metadata !== undefined) {
    await db.query(`UPDATE contexts SET metadata = $2::jsonb WHERE id = $1`, [id, JSON.stringify(metadata)]);
  }
  ids[key] = id;
  await viaTool('link', { from: id, fromType: 'context', to: taskId, toType: 'task', edgeType: 'informs' });
  return id;
}

describe('recall_thread record kind / superseded history / trust legend', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'kind contract') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
    taskId = (await viaTool('task_create', { title: `kind-anchor-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    await mkContext('fail', `critic verdict FAIL ${STAMP}`, 'discussion', { kind: 'walkthrough-verdict', verdict: 'FAIL' });
    await mkContext('merge', `merged ${STAMP}`, 'completion', { kind: 'punch-merge' });
    await mkContext('revert', `reverted ${STAMP}`, 'completion', { kind: 'punch-revert' });
    await mkContext('bad', `malformed kind ${STAMP}`, 'note', { kind: 'Bad Kind!' });
    await mkContext('none', `no kind ${STAMP}`, 'note');
    await mkContext('h1', `HANDOFF ONE ${STAMP}`, 'handoff', { kind: 'handoff-morning' });
    await mkContext('h2', `HANDOFF TWO ${STAMP}`, 'handoff');
    // H2 supersedes H1 by the product's own handoff supersession mint (no hand-written edge);
    // asserted here so a fixture that failed to supersede cannot pass by vacuity.
    const edge = await db.query(
      `SELECT 1 FROM links WHERE from_id = $1 AND to_id = $2 AND edge_type = 'supersedes'`,
      [ids.h2, ids.h1]
    );
    expect(edge.rows.length, 'H2 must supersede H1').toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM links WHERE from_id = ANY($1) OR to_id = ANY($1)', [Object.values(ids)]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  test('kinds appear exactly as given; malformed and missing are absent (structured + text)', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskId, altitude: 'summary' });
    const node = (k: string) => resp.structuredContent.nodes.find((n: any) => n.id === ids[k]);
    expect(node('fail').kind).toBe('walkthrough-verdict');
    expect(node('merge').kind).toBe('punch-merge');
    expect(node('revert').kind).toBe('punch-revert');
    expect(node('bad')).toBeDefined();
    expect(node('bad')).not.toHaveProperty('kind');
    expect(node('none')).not.toHaveProperty('kind');
    expect(resp.structuredContent.nodes.find((n: any) => n.id === taskId)).not.toHaveProperty('kind');

    const text: string = resp.content[0].text;
    const lineOf = (k: string) => text.split('\n').find((l) => l.includes(`(${ids[k]})`))!;
    expect(lineOf('fail')).toMatch(/\[context walkthrough-verdict verdict:FAIL\]/);
    expect(lineOf('merge')).toContain('[context punch-merge]');
    expect(lineOf('revert')).toContain('[context punch-revert]');
    expect(lineOf('bad')).toContain('[context]');
    expect(lineOf('none')).toContain('[context]');
  });

  test('superseded H1 is history: structured list + text section, with supersededBy H2', async () => {
    for (const altitude of ['summary', 'full'] as const) {
      const resp = await viaTool('recall_thread', { anchor: taskId, altitude });
      const sup = resp.structuredContent.superseded;
      expect(sup.map((s: any) => s.id)).toEqual([ids.h1]);
      expect(sup[0]).toMatchObject({ id: ids.h1, kind: 'handoff-morning', supersededBy: ids.h2 });
      expect(sup[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sup[0].title).toContain('HANDOFF ONE');
      const text: string = resp.content[0].text;
      const at = text.indexOf(THREAD_SUPERSEDED_SECTION_TITLE);
      expect(at).toBeGreaterThan(-1);
      const section = text.slice(at).split('\n\n')[0].split('\n').filter((l) => l.includes(ids.h1));
      expect(section).toHaveLength(1);
      expect(section[0]).toContain('handoff-morning');
      expect(section[0]).toContain('HANDOFF ONE');
      expect(section[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/);
    }
  });

  test('headline may omit the section; abstain still names H1', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskId, altitude: 'headline' });
    expect(resp.content[0].text).not.toContain(THREAD_SUPERSEDED_SECTION_TITLE);
    expect(resp.structuredContent.abstain).toContain(ids.h1);
  });

  test('the trust legend appears exactly once, in the header', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskId, altitude: 'summary' });
    const text: string = resp.content[0].text;
    expect(text.split(THREAD_CONFIG.trustLegendLine).length - 1).toBe(1);
    expect(text.split('\n').indexOf(THREAD_CONFIG.trustLegendLine)).toBeLessThanOrEqual(2);
  });

  test('trust band and score of every node equal the independently computed trust; abstain is H1 only', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskId, altitude: 'summary' });
    for (const n of resp.structuredContent.nodes) {
      const expected = await trustForRecord({ id: n.id, type: n.type });
      // The wire rounds the score; compare band exactly and score to the wire's precision.
      expect(n.trust.band, n.id).toBe(expected.band);
      expect(n.trust.score, n.id).toBeCloseTo(expected.score ?? 0, 2);
      // ...and the text channel's band for that node says the same thing.
      const line = resp.content[0].text.split('\n').find((l: string) => /^\d+\. /.test(l) && l.includes(`(${n.id})`))!;
      expect(line, n.id).toContain(`trust:${expected.band}`);
    }
    expect(resp.structuredContent.abstain).toEqual([ids.h1]);
  });
});
