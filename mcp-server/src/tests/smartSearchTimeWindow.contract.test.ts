/**
 * smart_search TIME WINDOW — contract test (dogfood finding 6).
 *
 * "What happened overnight on 2026-10-22 with the Backstory test-flake punch?" ignored the
 * date and ranked another night's identically-titled punch first. Through the real
 * validateToolArguments → routeExecutor path, against the migrated test Postgres (embeddings
 * stubbed), with the search timezone UTC:
 *   P  'Widget test flake' — 1 informing context, 2026-03-09 05:00Z      (the night BEFORE)
 *   Q  'Widget test flake' — 4 informing contexts, 2026-03-10 01:00-07:00Z
 *   R  'Widget test flake' — 1 informing context 2026-03-10 03:00Z, 1 on 2026-03-12
 * All three tasks were CREATED 2026-01-01, so only the activity can place them in the window.
 * R is written to OUTRANK Q on relevance (asserted on the date-free query first), so Q-first under
 * the date can only come from the in-window activity order. No fixture text contains the date.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding, activeEmbeddingColumn } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding(), dimensions: embedDim(), model: 'mock' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { SEARCH_TIME_ZONE } from '../config/searchConfig.js';
import { TASK_NOTE_LOG_KEY } from '../config/taskNotes.js';

const STAMP = Date.now();
const CONN = `search-window-conn-${STAMP}`;
let projectId: string;
const task: Record<'P' | 'Q' | 'R' | 'S' | 'W', string> = { P: '', Q: '', R: '', S: '', W: '' };
const decision: Record<'in' | 'out', string> = { in: '', out: '' };
const ctxCreated = new Map<string, string>(); // context id → created_at ISO

/** The query's own vector (cosine 1.0) or a deliberately weaker one (cosine < 1) — what makes R outrank Q. */
function taskVector(aligned: boolean): string {
  const v = patternEmbedding();
  return `[${(aligned ? v : v.map((x, i) => (i % 2 === 0 ? x : 0))).join(',')}]`;
}
async function addTask(title: string, description: string, createdAt = '2026-01-01T00:00:00Z', noteAt?: string, aligned = false): Promise<string> {
  const metadata = noteAt ? { [TASK_NOTE_LOG_KEY]: [{ at: noteAt, text: 'checked the flake again' }] } : {};
  return (await db.query(
    `INSERT INTO tasks (project_id, title, description, type, status, priority, created_at, updated_at, metadata, ${activeEmbeddingColumn()})
     VALUES ($1,$2,$3,'general','todo','medium',$4,$4,$5::jsonb,$6::vector) RETURNING id`,
    [projectId, title, description, createdAt, JSON.stringify(metadata), taskVector(aligned)])).rows[0].id;
}
async function addInformingContext(taskId: string, at: string, n: number): Promise<void> {
  const id = (await db.query(
    `INSERT INTO contexts (project_id, context_type, content, created_at, ${activeEmbeddingColumn()})
     VALUES ($1,'note',$2,$3,$4::vector) RETURNING id`,
    [projectId, `Widget test flake observation number ${n}`, at, `[${patternEmbedding().join(',')}]`])).rows[0].id;
  ctxCreated.set(id, at);
  await db.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
     VALUES ($1,'context',$2,'task','informs',$3,'test','link-tool')`, [id, taskId, projectId]);
}
async function addDecision(title: string, at: string): Promise<string> {
  return (await db.query(
    `INSERT INTO technical_decisions (project_id, decision_type, title, description, rationale, impact_level, status, decision_date)
     VALUES ($1,'database',$2,'widget test flake policy','because the widget test flakes','medium','active',$3) RETURNING id`,
    [projectId, title, at])).rows[0].id;
}

async function search(query: string): Promise<any> {
  const validated = validateToolArguments('smart_search', { query, projectId, limit: 30 });
  return routeExecutor('smart_search', validated, { connectionId: CONN });
}
const idsOf = (resp: any, type: string): string[] =>
  resp.structuredContent.results.filter((r: any) => r.type === type).map((r: any) => r.id);
const absentOf = (resp: any): string[] => (resp.structuredContent.absentTerms ?? []).map((a: any) => String(a.term).toLowerCase());

const DATED = 'what happened overnight on 2026-03-10 with the widget test flake';

describe('smart_search reads a time window from the query', () => {
  beforeAll(async () => {
    expect(SEARCH_TIME_ZONE).toBe('UTC'); // the scenario is stated in UTC
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1,'search window') RETURNING id`, [`search-window-${STAMP}`],
    )).rows[0].id;
    const plain = 'The widget test flakes intermittently';
    const rich = 'widget test flake. The widget test flake again: widget test flake in the widget test suite, widget test flake';
    task.P = await addTask('Widget test flake', plain);
    task.Q = await addTask('Widget test flake', plain);
    task.R = await addTask('Widget test flake: widget flake in widget test suite', rich, undefined, undefined, true);
    await addInformingContext(task.P, '2026-03-09T05:00:00Z', 1);
    for (const [i, h] of ['01', '03', '05', '07'].entries()) await addInformingContext(task.Q, `2026-03-10T${h}:00:00Z`, i + 2);
    await addInformingContext(task.R, '2026-03-10T03:00:00Z', 6);
    await addInformingContext(task.R, '2026-03-12T03:00:00Z', 7);
    task.S = await addTask('Widget test flake note-only', plain, '2026-01-01T00:00:00Z', '2026-03-10T04:00:00Z');
    task.W = await addTask('Widget test flake created-only', plain, '2026-03-10T02:00:00Z');
    decision.in = await addDecision('Widget test flake policy inside', '2026-03-10T02:00:00Z');
    decision.out = await addDecision('Widget test flake policy outside', '2026-03-20T02:00:00Z');
  });

  afterAll(async () => {
    try { await db.query('DELETE FROM links WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    await db.end();
  });

  test('without a date R outranks Q on relevance and every task is returned (the control)', async () => {
    const ids = idsOf(await search('what happened overnight with the widget test flake'), 'task');
    expect(ids).toEqual(expect.arrayContaining([task.P, task.Q, task.R]));
    expect(ids.indexOf(task.R)).toBeLessThan(ids.indexOf(task.Q));
  });

  test('the dated query: Q first (activity), R second, P absent, nothing outside the window, date not an absent term', async () => {
    const resp = await search(DATED);
    const ids = idsOf(resp, 'task');
    expect(ids.slice(0, 2)).toEqual([task.Q, task.R]);
    expect(ids).not.toContain(task.P);

    const start = Date.parse('2026-03-09T18:00:00Z'), end = Date.parse('2026-03-11T12:00:00Z');
    const returnedContexts = resp.structuredContent.results.filter((r: any) => r.type === 'context');
    expect(returnedContexts.length).toBeGreaterThan(0); // not vacuous
    for (const c of returnedContexts) {
      const t = Date.parse(ctxCreated.get(c.id)!);
      expect(t >= start && t < end).toBe(true);
    }

    const absent = absentOf(resp);
    expect(absent).not.toContain('2026-03-10');
    expect(absent).not.toContain('overnight');
  });

  test('the absent-term probe is live under a window: a date-free term missing from the corpus IS reported', async () => {
    const resp = await search(`${DATED} zzqxunobtainium`);
    const absent = absentOf(resp);
    expect(absent).toContain('zzqxunobtainium');
    expect(absent).not.toContain('2026-03-10');
    expect(absent).not.toContain('overnight');
  });

  test('a date alone (no night word) is a bare day: the 2026-03-10 02:00Z decision is inside, 2026-03-09 05:00Z context is not', async () => {
    const resp = await search('widget test flake on 2026-03-10');
    expect(idsOf(resp, 'decision')).toContain(decision.in);
    for (const c of idsOf(resp, 'context')) expect(ctxCreated.get(c)!.startsWith('2026-03-10')).toBe(true);
  });

  test('decisions: the one created inside the window is returned, the one outside is not', async () => {
    const ids = idsOf(await search(DATED), 'decision');
    expect(ids).toContain(decision.in);
    expect(ids).not.toContain(decision.out);
  });

  test('tasks S (noteLog entry in window) and W (created in window) are returned; S ranks by its entry above W', async () => {
    const ids = idsOf(await search(DATED), 'task');
    expect(ids).toContain(task.S);
    expect(ids).toContain(task.W);
    expect(ids.indexOf(task.S)).toBeLessThan(ids.indexOf(task.W));
    expect(ids.indexOf(task.Q)).toBeLessThan(ids.indexOf(task.S));
  });
});
