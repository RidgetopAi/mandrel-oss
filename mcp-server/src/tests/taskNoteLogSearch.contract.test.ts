/**
 * Task event-log SEARCHABILITY — contract (dogfood finding 3).
 * Text that appears ONLY in a task's metadata.noteLog notes must find that task through
 * (a) smart_search (the task adapter's text gate AND the lexical channel) and (b) the lexical
 * search channel directly; a task without that note must not match.
 *
 * The embedder is made to FAIL so tasks are stored un-embedded and the search degrades to its
 * text gates: with a stub vector every embedded row is "admitted", which would make the
 * negative arm unfalsifiable. Real DB, real handlers.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => {
      throw new Error('embedder offline (test)');
    }),
  },
}));

import { db } from '../config/database.js';
import { tasksHandler } from '../handlers/tasks.js';
import { smartSearchHandler } from '../handlers/smartSearch.js';
import { TASK_NOTE_LOG_KEY } from '../config/taskNotes.js';

const STAMP = Date.now();
const PROJ_NAME = `task-notelog-search-${STAMP}`;
const WORD = 'zircon-gate';

let projectId: string;
let withNote: string;
let withoutNote: string;

describe('task noteLog is searchable', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'notelog search') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    const mk = async (title: string) =>
      (await tasksHandler.createTask(projectId, title, 'plain description about merges', 'feature', 'medium')).id;
    withNote = await mk(`alpha merge story ${STAMP}`);
    withoutNote = await mk(`beta merge story ${STAMP}`);
    await db.query(
      `UPDATE tasks SET metadata = jsonb_set(metadata, '{${TASK_NOTE_LOG_KEY}}', $2::jsonb) WHERE id = $1`,
      [withNote, JSON.stringify([
        { at: '2026-10-22T07:56:38.000Z', actor: null, note: 'MERGE START' },
        { at: '2026-10-22T08:16:07.000Z', actor: 'builder', note: `MERGE BLOCKED: the ${WORD} is RED` },
      ])],
    );
    await db.query(
      `UPDATE tasks SET metadata = jsonb_set(metadata, '{${TASK_NOTE_LOG_KEY}}', $2::jsonb) WHERE id = $1`,
      [withoutNote, JSON.stringify([{ at: '2026-10-22T07:56:38.000Z', actor: null, note: 'MERGE START' }])],
    );
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  test('premise: the word is in no title or description', async () => {
    const r = await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND (title || ' ' || description) ILIKE $2`, [projectId, `%${WORD}%`]);
    expect(r.rows[0].n).toBe(0);
  });

  test('smart_search returns the task whose note has the word, and not the one without', async () => {
    const results = await smartSearchHandler.smartSearch(projectId, WORD, undefined, 20);
    const ids = results.filter((r) => r.type === 'task').map((r) => r.id);
    expect(ids).toContain(withNote);
    expect(ids).not.toContain(withoutNote);
  });

  test('the task search source (text gate) matches note-only text', async () => {
    const rows = await tasksHandler.searchTasks({ projectId, query: WORD, limit: 20 });
    expect(rows.map((t) => t.id)).toEqual([withNote]);
  });

  test('the lexical columns carry the note text (migration 110)', async () => {
    const r = await db.query(
      `SELECT id FROM tasks WHERE project_id = $1 AND search_tsv @@ plainto_tsquery('english', 'blocked')`,
      [projectId],
    );
    expect(r.rows.map((x: any) => x.id)).toEqual([withNote]);
  });

  test('the SQL document key is held in lockstep with TASK_NOTE_LOG_KEY', async () => {
    const src = (await db.query(`SELECT prosrc FROM pg_proc WHERE proname = 'mandrel_task_search_text'`)).rows[0].prosrc;
    expect(src).toContain(`'${TASK_NOTE_LOG_KEY}'`);
  });
});
