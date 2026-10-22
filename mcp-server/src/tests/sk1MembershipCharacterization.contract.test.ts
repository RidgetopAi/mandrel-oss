/**
 * SK1 STEP 0 — CHARACTERIZATION, not a fix.
 *
 * THE CLAIM UNDER TEST (task text): "context_store computes namedTaskIds from tags but
 * task_create came back empty given the same two tags — the two paths MUST compute
 * membership identically."
 *
 * This file MEASURES that claim instead of assuming it. It drives the three write paths
 * through the FULL public tool surface (validate → routeExecutor, the path the HTTP bridge
 * uses) under four input shapes and records what `structuredContent.positional` actually
 * reports:
 *
 *   (i)   TAGS ONLY   — two `task:<id8>` tags, no ids anywhere in the body
 *   (ii)  BODY ONLY   — the same two id8s in the body text, no tags
 *   (iii) BOTH        — tags AND body
 *   (iv)  NEITHER     — control
 *
 * The truth table it prints is the deliverable of Step 0. The assertions below pin what was
 * measured, so this file is also the regression guard for the unification: if a later change
 * makes one path read tags and another not, a row of the table diverges and this goes RED.
 *
 * Embeddings mocked to zeros — similarity plays no role in any of this.
 * DB target: the disposable migrated ci_* DB, never production.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'SK1 characterization fixture') RETURNING id`,
      [`sk1char-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `sk1char-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* teardown noise */ }
  }
  await db.end();
});

type Cell = { namedTaskIds: number; trunk: boolean };
const cell = (resp: any, key: 'context' | 'task' | 'decision'): Cell => {
  const p = resp.structuredContent[key].positional;
  return { namedTaskIds: p.namedTaskIds.length, trunk: p.trunk };
};

/** vitest intercepts console.log inside a test; write the table where it survives. */
function emit(line: string) {
  process.stdout.write(`${line}\n`);
}

describe('SK1 step 0 — what the three write paths ACTUALLY compute for namedTaskIds/trunk', () => {
  test('truth table: tags-only vs body-only vs both vs neither, per write path', async () => {
    // SETUP CONNECTION, deliberately separate: creating the two target tasks is itself a
    // pair of writes that MOVES a position (R1 auto-open, then R2 fan-out revert). Doing it
    // on the measuring connection would make the table a measurement of that history rather
    // than of the rule. Each measurement below then runs on its OWN virgin connection.
    const { projectId } = await freshCase('table');
    const setup = `sk1char-setup-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: setup });
    const tA = (await viaTool('task_create', { title: 'named target A', type: 'feature' }, setup))
      .structuredContent.task.id;
    const tB = (await viaTool('task_create', { title: 'named target B', type: 'feature' }, setup))
      .structuredContent.task.id;
    const a8 = id8(tA);
    const b8 = id8(tB);

    const tags = [`task:${a8}`, `task:${b8}`];
    const bodyWithIds = `work touching ${a8} and ${b8} together`;
    const bodyClean = 'work touching nothing in particular';

    let n = 0;
    /** A fresh, unpositioned connection per measurement — one cell, one clean slate. */
    async function virginConn(): Promise<string> {
      const c = `sk1char-cell-${STAMP}-${n++}`;
      await routeExecutor('project_switch', { project: projectId }, { connectionId: c });
      return c;
    }

    const rows: Array<{ shape: string; path: string; namedTaskIds: number; trunk: boolean }> = [];
    async function measure(
      shape: string,
      path: 'context_store' | 'task_create' | 'decision_record',
      withTags: boolean,
      body: string
    ) {
      const conn = await virginConn();
      const t = withTags ? { tags } : {};
      let c: Cell;
      if (path === 'context_store') {
        c = cell(await viaTool('context_store', { content: body, type: 'discussion', ...t }, conn), 'context');
      } else if (path === 'task_create') {
        c = cell(await viaTool('task_create', { title: shape, description: body, type: 'feature', ...t }, conn), 'task');
      } else {
        c = cell(await viaTool('decision_record', {
          decisionType: 'architecture', title: shape, description: body,
          rationale: 'r', impactLevel: 'low', ...t,
        }, conn), 'decision');
      }
      rows.push({ shape, path, namedTaskIds: c.namedTaskIds, trunk: c.trunk });
    }

    const PATHS = ['context_store', 'task_create', 'decision_record'] as const;
    for (const p of PATHS) await measure('tags-only', p, true, bodyClean);
    for (const p of PATHS) await measure('body-only', p, false, bodyWithIds);
    for (const p of PATHS) await measure('both', p, true, bodyWithIds);
    for (const p of PATHS) await measure('neither', p, false, bodyClean);

    // THE DELIVERABLE OF STEP 0 — emitted so the measurement is in the run output, not only
    // in an assertion someone has to read backwards.
    emit('\n=== SK1 STEP 0 TRUTH TABLE (namedTaskIds count / trunk) ===');
    emit('shape      | path            | namedTaskIds | trunk');
    emit('-----------+-----------------+--------------+------');
    for (const r of rows) {
      emit(`${r.shape.padEnd(10)} | ${r.path.padEnd(15)} | ${String(r.namedTaskIds).padEnd(12)} | ${r.trunk}`);
    }
    emit('=== END TRUTH TABLE ===\n');

    // WHAT IS PINNED. Two properties, and they are the whole point of the table:
    //   1. every path agrees with every other path, shape for shape (the unification
    //      contract SK1 exists to hold);
    //   2. the rule is BODY-driven, not tag-driven.
    const byShape = (shape: string) => rows.filter((r) => r.shape === shape);
    for (const shape of ['tags-only', 'body-only', 'both', 'neither']) {
      const cells = byShape(shape).map((r) => `${r.namedTaskIds}/${r.trunk}`);
      expect(new Set(cells).size, `all three write paths must agree for shape "${shape}" (got ${cells.join(', ')})`).toBe(1);
    }
    for (const r of byShape('tags-only')) {
      expect(r.namedTaskIds, `${r.path}: a task: TAG must not feed namedTaskIds`).toBe(0);
      expect(r.trunk, `${r.path}: tags alone must not trunk-revert`).toBe(false);
    }
    for (const r of byShape('body-only')) {
      expect(r.namedTaskIds, `${r.path}: two id8s in the BODY must both resolve`).toBe(2);
      expect(r.trunk, `${r.path}: two named ids in the body IS the trunk rule`).toBe(true);
    }
    for (const r of byShape('neither')) {
      expect(r.namedTaskIds).toBe(0);
      expect(r.trunk).toBe(false);
    }
  });

  /**
   * THE DIVERGENCE THAT IS REAL — and it is NOT per-write-path. Identical input to the
   * SAME tool gives a different namedTaskIds/trunk answer depending on WHERE THE SESSION
   * IS STANDING, because mintPositional excludes `position.spineId` from the named scan.
   * Standing on task A, a record naming A and B is a 1-name record (member of A + weak ref
   * to B); unpositioned, the same text is a 2-name TRUNK record. Since task_create and
   * decision_record MUTATE the position as a byproduct (R1 auto-open, R2 revert), two calls
   * with byte-identical arguments in one session land in different states — which is what a
   * live observer reads as "context_store trunk-reverted and task_create did not".
   */
  test('namedTaskIds depends on the session POSITION, not on the write path', async () => {
    const { projectId } = await freshCase('posdep');
    const setup = `sk1char-posdep-setup-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: setup });
    const tA = (await viaTool('task_create', { title: 'A', type: 'feature' }, setup)).structuredContent.task.id;
    const tB = (await viaTool('task_create', { title: 'B', type: 'feature' }, setup)).structuredContent.task.id;
    const body = `naming ${id8(tA)} and ${id8(tB)}`;

    const unpositioned = `sk1char-posdep-un-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: unpositioned });
    const off = cell(await viaTool('context_store', { content: body, type: 'discussion' }, unpositioned), 'context');

    const onA = `sk1char-posdep-onA-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: onA });
    await viaTool('branch_open', { id: id8(tA) }, onA);
    const standing = cell(await viaTool('context_store', { content: body, type: 'discussion' }, onA), 'context');

    emit(`\n=== SK1 POSITION-DEPENDENCE (same tool, same body) ===`);
    emit(`unpositioned      : namedTaskIds=${off.namedTaskIds} trunk=${off.trunk}`);
    emit(`standing on task A: namedTaskIds=${standing.namedTaskIds} trunk=${standing.trunk}`);
    emit('=== END ===\n');

    expect(off).toEqual({ namedTaskIds: 2, trunk: true });
    expect(standing).toEqual({ namedTaskIds: 1, trunk: false });
  });

  /**
   * THE SUSPECTED REAL MECHANISM behind the 2026-08-13 field observation, isolated: the
   * three handlers compose the scanned BODY from different fields. context_store scans the
   * whole content; task_create scans title + description; decision_record scans
   * title + description + rationale + problemStatement. So a session that put the two ids
   * in a context's content and then created a task whose title/description did NOT repeat
   * them measures "context_store trunk-reverted, task_create did not" — with no divergence
   * in the RULE at all.
   */
  test('the composed BODY differs per handler — the same ids in an unscanned field are invisible', async () => {
    const { conn } = await freshCase('body');
    const tA = (await viaTool('task_create', { title: 'target A', type: 'feature' }, conn)).structuredContent.task.id;
    const tB = (await viaTool('task_create', { title: 'target B', type: 'feature' }, conn)).structuredContent.task.id;
    const ids = `${id8(tA)} and ${id8(tB)}`;

    // decision_record: ids in `rationale` — a SCANNED field for decisions.
    const inRationale = cell(await viaTool('decision_record', {
      decisionType: 'architecture', title: 'x', description: 'y', rationale: ids, impactLevel: 'low',
    }, conn), 'decision');
    expect(inRationale.trunk, 'decision body includes rationale').toBe(true);

    // decision_record: ids ONLY in `successCriteria` — a field NO handler scans.
    const inSuccess = cell(await viaTool('decision_record', {
      decisionType: 'architecture', title: 'x2', description: 'y2', rationale: 'r2',
      impactLevel: 'low', successCriteria: ids,
    }, conn), 'decision');
    expect(inSuccess.trunk, 'successCriteria is not part of any composed body').toBe(false);
    expect(inSuccess.namedTaskIds).toBe(0);
  });
});
