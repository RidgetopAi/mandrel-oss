/**
 * CLAIM-ACTOR COLUMN BOUND — pinning tests (item 4; the seam was built by
 * an earlier task / Reviewer N2 and is PINNED here because no test exercised it).
 *
 * THE SEAM: `tasks.claim_actor` is varchar(200). The caller-supplied `actor` ARGUMENT is
 * zod-capped at that width (validation.ts task claim schema, `cap('tasks.assigned_to')`)
 * and delimiter-handled by refineActor — but the DERIVED actor is not zod's to bound: a
 * composite `<encoded sub>/<handle>` from a long OAuth sub can exceed 200. Postgres varchar
 * does not truncate; it raises `22001 value too long` — a raw driver error on an
 * unrelated-looking write. tasks.routes.ts#claimActorTooLong turns that into an actionable
 * typed refusal BEFORE the statement runs, reading the bound from the SAME fieldLimits
 * registry the schema uses (one source, no second copy of 200).
 *
 * Pinned:
 *   (1) an over-long DERIVED actor (edge-derived context.actor) → the typed refusal, no
 *       claim taken, no raw 22001;
 *   (2) the refusal fires at exactly the column bound (bound+1 refused) — the empty/edge
 *       population probe (C3);
 *   (3) control: a normal actor claims fine (the guard does not over-block).
 *
 * DB-backed; drives task_claim through validate → routeExecutor (the real surface).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// Offline embeddings (unused by task_claim but keeps module import side-effects inert).
// The stub's WIDTH is derived, not written: an async factory so `zeroEmbedding` is resolved
// when the mock is used rather than at the hoisted call.
vi.mock('../services/embedding.js', async () => {
  const { zeroEmbedding } = await import('./helpers/embedGeometry.js');
  return {
    embeddingService: {
      generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
    },
  };
});

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { cap } from '../config/fieldLimits.js';

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PROJ_NAME = `claim-bound-P-${STAMP}`;
const CONN = `conn-claim-bound-${STAMP}`;

const SAVED = { ...TASK_CLAIM_CONFIG };

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

let projectId: string;

async function newTask(title: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, status) VALUES ($1, $2, 'general', 'todo') RETURNING id`,
    [projectId, title]
  );
  return r.rows[0].id;
}

async function claimAs(actor: string, taskId: string): Promise<any> {
  const validated = validateToolArguments('task_claim', { taskId, projectId });
  return routeExecutor('task_claim', validated, { connectionId: CONN, actor });
}

describe('claim_actor column bound (typed refusal before the statement — an earlier task item 4 pin)', () => {
  beforeAll(async () => {
    TASK_CLAIM_CONFIG.enabled = true;
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'claim-actor bound pin') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    Object.assign(TASK_CLAIM_CONFIG, SAVED);
    try {
      await db.query('DELETE FROM task_claim_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  test('(1) an over-long DERIVED actor is refused with the actionable message — no claim, no raw 22001', async () => {
    const max = cap('tasks.assigned_to');
    const taskId = await newTask('over-long derived actor');
    // The shape the bound exists for: a long verified principal + a handle (already derived
    // at the edge — context.actor arrives composite; the route must not shred or truncate it).
    const longActor = `${'a'.repeat(max)}@example.com/agent-handle`;
    expect(longActor.length).toBeGreaterThan(max);

    const resp = await claimAs(longActor, taskId);
    expect(resp.isError).toBe(true);
    const text = responseText(resp);
    expect(text).toContain(`${max}-character limit`);
    expect(text).not.toContain('22001'); // the raw driver error must never reach the caller

    // No claim was taken: the guarded row is untouched.
    const row = await db.query(`SELECT claim_id, claim_actor FROM tasks WHERE id = $1`, [taskId]);
    expect(row.rows[0].claim_id).toBeNull();
    expect(row.rows[0].claim_actor).toBeNull();
  });

  test('(2) the refusal fires at exactly the bound: length max claims fine, max+1 is refused', async () => {
    const max = cap('tasks.assigned_to');

    // Exactly AT the bound → allowed (the guard is `>`, matching varchar(200) semantics).
    const atBound = 'b'.repeat(max);
    const t1 = await newTask('actor at bound');
    const okResp = await claimAs(atBound, t1);
    expect(okResp.isError).not.toBe(true);
    expect((await db.query(`SELECT claim_actor FROM tasks WHERE id = $1`, [t1])).rows[0].claim_actor).toBe(atBound);

    // One PAST the bound → the typed refusal.
    const pastBound = 'b'.repeat(max + 1);
    const t2 = await newTask('actor past bound');
    const refuseResp = await claimAs(pastBound, t2);
    expect(refuseResp.isError).toBe(true);
    expect(responseText(refuseResp)).toContain(`${max + 1} characters`);
  });

  test('(3) control: a normal actor claims fine (the guard does not over-block)', async () => {
    const taskId = await newTask('normal actor');
    const resp = await claimAs('builder-e912b354', taskId);
    expect(resp.isError).not.toBe(true);
    expect(responseText(resp)).toContain('builder-e912b354');
    const row = await db.query(`SELECT claim_actor FROM tasks WHERE id = $1`, [taskId]);
    expect(row.rows[0].claim_actor).toBe('builder-e912b354');
  });
});
