/**
 * TASK STATUS → IMPORTANCE WEIGHT.
 *
 * THE RULE UNDER TEST: `tasks.status` reaches the unified score through the importance term
 * as a named per-status multiplier whose defaults are ALL 1.0. So:
 *   - at defaults, two tasks that differ ONLY in status score IDENTICALLY (the identity
 *     guarantee — the map's existence changes nothing until tuned);
 *   - with one non-default weight set through the real env var, the same two tasks REORDER,
 *     and the one whose status was down-weighted scores strictly lower.
 *
 * THE SMALLEST INPUT WHERE FIXED AND BROKEN DIVERGE: two tasks with byte-identical title,
 * description, type, priority and created_at, one `todo` and one `completed`. Everything the
 * blend reads is equal except the status, so a score difference can come from the status
 * map and from nothing else. The fixture is asserted equal-at-default BEFORE the weight is
 * flipped, so the reorder cannot be an artefact of the fixture.
 *
 * Drives the SHIPPED entry point (smartSearchHandler.smartSearchDetailed) with the lexical
 * channel pinned off, exactly as smartSearchTaskSource.contract.test.ts does and for the
 * same reason: this file guards the semantic blend's importance term, and rank fusion throws
 * the scale away. The embedder is the concept mock so cosine is real and identical texts get
 * identical vectors.
 *
 * DB target: the disposable migrated ci_* DB, never production.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, conceptEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptEmbedding(text),
      dimensions: embedDim(),
      model: 'mock-concept',
    })),
  },
}));

import { db } from '../config/database.js';
import { LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';
import { tasksHandler } from '../handlers/tasks.js';
import { smartSearchHandler } from '../handlers/smartSearch.js';
import { RANK_WEIGHTS } from '../config/rankingConfig.js';
import {
  TASK_IMPORTANCE_DEFAULT,
  TASK_STATUS_IMPORTANCE_ENV,
  TASK_STATUS_IMPORTANCE_WEIGHT_DEFAULT,
  taskImportance,
  taskStatusImportanceWeight,
} from '../config/searchMergeConfig.js';

const LEXICAL_ORIGINAL = LEXICAL_SEARCH_CONFIG.enabled;
const STAMP = Date.now();
const QUERY = 'expiring credentials review';
const TITLE = 'Renewal of the leased passwords before the compliance inspection';
const DESCRIPTION = 'Rotation work ahead of the scheduled inspection.';

let projectId: string;
let todoId: string;
let completedId: string;

/** Set one env var for the duration of `fn` and restore it — the ENV-LEAK guard demands it. */
async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

async function taskScores(): Promise<Record<string, number>> {
  const { results, degradedSources } = await smartSearchHandler.smartSearchDetailed(
    projectId, QUERY, ['task'], 10);
  expect(degradedSources).toEqual([]);
  const out: Record<string, number> = {};
  for (const r of results) out[r.id] = r.relevanceScore;
  return out;
}

describe('task status → importance weight', () => {
  beforeAll(async () => {
    (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = false;
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'status weight contract') RETURNING id`,
      [`status-weight-${STAMP}`]
    )).rows[0].id;
    todoId = (await tasksHandler.createTask(projectId, TITLE, DESCRIPTION)).id;
    completedId = (await tasksHandler.createTask(projectId, TITLE, DESCRIPTION)).id;
    // ONE instant for both, so the recency term cannot separate them; the status flip is a
    // plain column write so the vector (which excludes status by design) is untouched.
    await db.query(
      `UPDATE tasks SET created_at = NOW() - INTERVAL '10 days' WHERE id = ANY($1::uuid[])`,
      [[todoId, completedId]]
    );
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [completedId]);
  }, 60000);

  afterAll(async () => {
    (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = LEXICAL_ORIGINAL;
    if (projectId) {
      for (const t of ['tasks', 'sessions']) {
        try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]); } catch { /* ignore */ }
      }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('PRECONDITION: the two tasks differ in status and in nothing the blend reads', async () => {
    const r = await db.query(
      `SELECT id::text, status, title, description, type, priority, created_at
         FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY status`,
      [[todoId, completedId]]
    );
    expect(r.rows.map((x: any) => x.status)).toEqual(['completed', 'todo']);
    const [a, b] = r.rows;
    for (const col of ['title', 'description', 'type', 'priority']) expect(a[col]).toEqual(b[col]);
    expect(new Date(a.created_at).getTime()).toBe(new Date(b.created_at).getTime());
    // The map is really the identity at defaults, for every status in the vocabulary.
    for (const status of Object.keys(TASK_STATUS_IMPORTANCE_ENV)) {
      expect(process.env[TASK_STATUS_IMPORTANCE_ENV[status]]).toBeUndefined();
      expect(taskStatusImportanceWeight(status)).toBe(TASK_STATUS_IMPORTANCE_WEIGHT_DEFAULT);
      expect(taskImportance(status)).toBe(TASK_IMPORTANCE_DEFAULT);
    }
    expect(taskImportance(null)).toBe(TASK_IMPORTANCE_DEFAULT);
    expect(taskImportance('not-a-status')).toBe(TASK_IMPORTANCE_DEFAULT);
  });

  test('DEFAULTS: status moves nothing — the two tasks score identically', async () => {
    const scores = await taskScores();
    expect(Object.keys(scores).sort()).toEqual([todoId, completedId].sort());
    expect(scores[todoId]).toBe(scores[completedId]);
  });

  test('A NON-DEFAULT WEIGHT REORDERS: completed at 0.5 ranks below the otherwise-equal todo', async () => {
    await withEnv(TASK_STATUS_IMPORTANCE_ENV.completed, '0.5', async () => {
      expect(taskStatusImportanceWeight('completed')).toBe(0.5);
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['task'], 10);
      const order = results.map(r => r.id);
      expect(order.indexOf(todoId)).toBeLessThan(order.indexOf(completedId));
      const todo = results.find(r => r.id === todoId)!.relevanceScore;
      const completed = results.find(r => r.id === completedId)!.relevanceScore;
      expect(todo).toBeGreaterThan(completed);
      // The gap is EXACTLY the importance term's share of the halved base — the map reached
      // the score through that term and no other.
      const expectedGap = TASK_IMPORTANCE_DEFAULT * 0.5 * RANK_WEIGHTS.balanced.importance;
      expect(todo - completed).toBeCloseTo(expectedGap, 6);
    });
    // Restored: the identity holds again, so the flip was the env var and not the fixture.
    const after = await taskScores();
    expect(after[todoId]).toBe(after[completedId]);
  });

  test('the product is clamped to [0,1] and garbage falls back to 1.0', async () => {
    await withEnv(TASK_STATUS_IMPORTANCE_ENV.blocked, '5', async () => {
      expect(taskImportance('blocked')).toBe(1);
    });
    await withEnv(TASK_STATUS_IMPORTANCE_ENV.blocked, '-2', async () => {
      expect(taskImportance('blocked')).toBe(0);
    });
    await withEnv(TASK_STATUS_IMPORTANCE_ENV.blocked, 'banana', async () => {
      expect(taskImportance('blocked')).toBe(TASK_IMPORTANCE_DEFAULT);
    });
  });
});
