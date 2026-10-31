/**
 * recall_thread task-anchor EVENT LOG — contract (dogfood finding 3).
 * The causal step of a task's story lives in tasks.metadata.noteLog; recall_thread must carry
 * it as timed steps: structured `events` on the anchor node, one text line per step.
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
import { THREAD_CONFIG } from '../config/threadConfig.js';
import { eventLogOf } from '../services/recallThreadCore.js';

const STAMP = Date.now();
const CONN = `recall-thread-ev-conn-${STAMP}`;
const PROJ_NAME = `recall-thread-ev-P-${STAMP}`;

const NOTES = [
  `MERGE START repo:backstory main@5d38e0e45dbf ${STAMP}`,
  `MERGE GATE RED (1/2) systemctl --user is-active --quiet backstory ${STAMP}`,
  `MERGED builder/ev-branch ${STAMP}`,
];
const AT = ['2026-10-22T07:56:38.000Z', '2026-10-22T08:16:07.000Z', '2026-10-22T09:01:00.000Z'];

let taskId: string;
let emptyTaskId: string;

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

describe('recall_thread event log', () => {
  beforeAll(async () => {
    const projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'ev contract') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
    taskId = (await viaTool('task_create', { title: `ev-anchor-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    emptyTaskId = (await viaTool('task_create', { title: `ev-empty-${STAMP}`, type: 'feature' })).structuredContent.task.id;
    for (const note of NOTES) await viaTool('task_update', { taskId, notes: note });
    // Pin deterministic, distinct timestamps (the real appends are milliseconds apart).
    const log = (await db.query('SELECT metadata FROM tasks WHERE id = $1', [taskId])).rows[0].metadata.noteLog;
    log.forEach((e: any, i: number) => { e.at = AT[i]; });
    await db.query(`UPDATE tasks SET metadata = jsonb_set(metadata, '{noteLog}', $2::jsonb) WHERE id = $1`, [taskId, JSON.stringify(log)]);
  });

  afterAll(async () => {
    try {
      const pid = (await db.query('SELECT id FROM projects WHERE name = $1', [PROJ_NAME])).rows[0]?.id;
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* ignore */ }
    await db.end();
  });

  for (const altitude of ['summary', 'full'] as const) {
    test(`${altitude}: events are the three notes, oldest first, with at + actor; text shows each with its UTC minute`, async () => {
      const resp = await viaTool('recall_thread', { anchor: taskId, altitude });
      const anchor = resp.structuredContent.nodes.find((n: any) => n.id === taskId);
      expect(anchor.events.map((e: any) => e.note)).toEqual(NOTES);
      expect(anchor.events.map((e: any) => e.at)).toEqual(AT);
      for (const e of anchor.events) expect(e).toHaveProperty('actor');
      expect(anchor.eventsTotal).toBe(3);
      const text: string = resp.content[0].text;
      const stamps = ['2026-10-22T07:56Z', '2026-10-22T08:16Z', '2026-10-22T09:01Z'];
      NOTES.forEach((note, i) => {
        const line = text.split('\n').find((l) => l.includes(note));
        expect(line, `a line for note ${i}`).toBeDefined();
        expect(line).toContain(stamps[i]);
      });
      expect(text.indexOf(NOTES[0])).toBeLessThan(text.indexOf(NOTES[1]));
      expect(text.indexOf(NOTES[1])).toBeLessThan(text.indexOf(NOTES[2]));
    });
  }

  test('headline: no steps in either channel', async () => {
    const resp = await viaTool('recall_thread', { anchor: taskId, altitude: 'headline' });
    const anchor = resp.structuredContent.nodes.find((n: any) => n.id === taskId);
    expect(anchor.events).toBeUndefined();
    for (const note of NOTES) expect(resp.content[0].text).not.toContain(note);
  });

  test('a task with no notes carries no events and no Event log section', async () => {
    const resp = await viaTool('recall_thread', { anchor: emptyTaskId, altitude: 'summary' });
    expect(resp.structuredContent.nodes[0].events).toBeUndefined();
    expect(resp.content[0].text).not.toContain('Event log');
  });
});

describe('eventLogOf bounds (named config)', () => {
  const meta = {
    noteLog: Array.from({ length: 5 }, (_, i) => ({
      at: `2026-10-22T0${i}:00:00.000Z`,
      actor: i % 2 ? 'builder' : null,
      note: 'x'.repeat(10 * (i + 1)),
    })).concat([{ at: 'garbage', actor: null, note: 'dropped' } as any]),
  };
  const cfg = { ...THREAD_CONFIG, eventLogSummaryMaxSteps: 2, eventLogFullMaxSteps: 4, eventLogSummaryNoteWidth: 20 };

  test('summary: cap keeps the most recent steps, reports the real total, clips notes', () => {
    const r = eventLogOf(meta, 'summary', cfg)!;
    expect(r.total).toBe(5);
    expect(r.events.map((e) => e.at)).toEqual(['2026-10-22T03:00:00.000Z', '2026-10-22T04:00:00.000Z']);
    expect(r.events[1].note).toBe(`${'x'.repeat(20)}…`);
  });
  test('full: whole notes, own cap', () => {
    const r = eventLogOf(meta, 'full', cfg)!;
    expect(r.events).toHaveLength(4);
    expect(r.events[3].note).toHaveLength(50);
  });
  test('headline and malformed logs yield none', () => {
    expect(eventLogOf(meta, 'headline', cfg)).toBeNull();
    expect(eventLogOf({ noteLog: 'nope' }, 'summary', cfg)).toBeNull();
    expect(eventLogOf(null, 'full', cfg)).toBeNull();
  });
});
