/**
 * REPROJECT — the canary an earlier task asked for, plus the edge policy's three branches.
 *
 * THE ACCEPTANCE CRITERION, verbatim from the task: "a canary that creates a record in
 * project A, moves it to project B via the new action, and asserts … that the id is
 * unchanged, createdAt/sessionId are preserved, it is absent from A, present in B, and its
 * inbound edges resolved per whatever policy is chosen."
 *
 * EVERY MOVE HERE GOES THROUGH THE PUBLIC TOOL PATH — `validateToolArguments` then
 * `routeExecutor`, the exact two steps the HTTP bridge performs. A test that called
 * `moveRecord()` directly would prove the service works and prove NOTHING about whether the
 * op is reachable, validated, or dispatched: it would pass with the registry entry, the zod
 * schema and the `routes/index.ts` case all deleted.
 *
 * WHAT WOULD MAKE THIS SUITE HOLLOW, and what stops it:
 *   - "the record moved" is asserted by READING BOTH PROJECTS — absent from the source AND
 *     present in the destination. Asserting only presence-in-B passes for a COPY, which is
 *     the exact workaround the task explicitly rejects.
 *   - "edges survived" is asserted through `get_links` (the public read) AND on the `links`
 *     rows' project_id, because the re-stamp is invisible to get_links (it does not filter
 *     by project) and yet is the thing branch/handoff reads depend on. Only checking
 *     get_links would pass with the entire edge policy deleted.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { mintEdge } from '../services/links.js';
import {
  RECORD_CREATED_AT_COLUMN,
  type ReprojectRecordType,
} from '../config/reprojectConfig.js';

const STAMP = Date.now();
const CONN = `reproject-conn-${STAMP}`;
const A_NAME = `reproject-A-${STAMP}`;
const B_NAME = `reproject-B-${STAMP}`;
const C_NAME = `reproject-C-${STAMP}`;

let projectA: string;
let projectB: string;
let projectC: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
function parseId(resp: any): string {
  const m = textOf(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from: ${textOf(resp).slice(0, 300)}`);
  return m[1];
}

/** The FULL public path: validate, then dispatch. */
async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** Create a context in `project`, returning its id. */
async function makeContext(project: string, content: string): Promise<string> {
  await routeExecutor('project_switch', { project }, { connectionId: CONN });
  await routeExecutor('branch_close', {}, { connectionId: CONN });
  const resp = await viaTool('context_store', { content, type: 'code', projectId: project });
  return parseId(resp);
}

/**
 * Read a record row's membership + provenance. The created-at column is NOT `created_at` on
 * all three tables — `technical_decisions` calls it `decision_date` and has no `created_at`
 * at all — so it is taken from the SAME declared map the service reads, not guessed here.
 */
async function rowOf(table: string, id: string, type: ReprojectRecordType): Promise<any> {
  const r = await db.query(
    `SELECT project_id::text AS project_id, ${RECORD_CREATED_AT_COLUMN[type]} AS created_at,
            session_id::text AS session_id
       FROM ${table} WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function linkRow(fromId: string, toId: string): Promise<any> {
  const r = await db.query(
    `SELECT id::text AS id, project_id::text AS project_id, metadata
       FROM links WHERE from_id = $1 AND to_id = $2`,
    [fromId, toId],
  );
  return r.rows[0];
}

describe('project_move_record — reproject a record, preserving identity', () => {
  beforeAll(async () => {
    for (const [name, set] of [
      [A_NAME, (v: string) => (projectA = v)],
      [B_NAME, (v: string) => (projectB = v)],
      [C_NAME, (v: string) => (projectC = v)],
    ] as const) {
      const r = await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'reproject contract') RETURNING id::text AS id`,
        [name],
      );
      set(r.rows[0].id);
    }
  });

  afterAll(async () => {
    try {
      for (const pid of [projectA, projectB, projectC]) {
        if (!pid) continue;
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM branch_memberships WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      }
    } catch {
      /* best effort */
    }
    await db.end();
  });

  // ── THE CANARY ────────────────────────────────────────────────────────────────────
  test('C1: a context moves A→B with its id, created_at and session_id intact, and is GONE from A', async () => {
    const id = await makeContext(projectA, `reproject canary ${STAMP}`);
    const before = await rowOf('contexts', id, 'context');
    expect(before.project_id, 'precondition: the record starts in A').toBe(projectA);

    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: id,
      toProject: B_NAME,
    });
    const sc = resp.structuredContent;
    expect(sc.ok, textOf(resp)).toBe(true);
    expect(sc.action).toBe('moved');

    const after = await rowOf('contexts', id, 'context');
    // THE ID IS THE SAME ROW — not a copy. (`rowOf` found it by that id at all.)
    expect(sc.recordId, 'the op reports the SAME id it was given').toBe(id);
    expect(after.project_id, 'present in B').toBe(projectB);
    // ABSENT FROM A — the assertion a store+delete "move" would fail.
    const stillInA = await db.query(
      `SELECT count(*)::int AS c FROM contexts WHERE id = $1 AND project_id = $2`,
      [id, projectA],
    );
    expect(stillInA.rows[0].c, 'absent from A').toBe(0);
    // PROVENANCE PRESERVED.
    expect(new Date(after.created_at).toISOString()).toBe(new Date(before.created_at).toISOString());
    expect(after.session_id).toBe(before.session_id);
    expect(after.session_id, 'the canary needs a real session_id to be meaningful').not.toBeNull();
    expect(sc.preserved.sessionId).toBe(before.session_id);
  });

  // ── EDGE POLICY, BRANCH 1: both endpoints end up in the destination ───────────────
  test('C2: an edge whose BOTH endpoints land in B is RE-STAMPED to B (and readable via get_links)', async () => {
    const a1 = await makeContext(projectA, `edge tail ${STAMP}-c2a`);
    const a2 = await makeContext(projectA, `edge head ${STAMP}-c2b`);
    await mintEdge({
      fromId: a1,
      fromType: 'context',
      toId: a2,
      toType: 'context',
      edgeType: 'related_to',
      projectId: projectA,
      via: 'link-tool',
    });
    expect((await linkRow(a1, a2)).project_id, 'precondition: edge stamped A').toBe(projectA);

    await viaTool('project_move_record', { recordType: 'context', recordId: a1, toProject: B_NAME });
    // After ONE move the other endpoint is still in A → cross-project branch.
    const mid = await linkRow(a1, a2);
    expect(mid.project_id, 'other endpoint still in A → writer stamp kept').toBe(projectA);
    expect(mid.metadata.cross_project, 'and marked as crossing').toBe(true);

    await viaTool('project_move_record', { recordType: 'context', recordId: a2, toProject: B_NAME });
    const after = await linkRow(a1, a2);
    expect(after.project_id, 'both endpoints in B → re-stamped to B').toBe(projectB);
    // The now-false marker is cleared, so an audit of cross_project does not lie.
    expect(after.metadata.cross_project, 'stale cross-project marker cleared').toBeUndefined();

    // The edge is still reachable through the PUBLIC read, in both directions.
    const links = await viaTool('get_links', { id: a1 });
    expect(textOf(links)).toContain(a2);
  });

  // ── EDGE POLICY, BRANCH 2: the other endpoint stays behind ────────────────────────
  test('C3: an edge to a record left in A SURVIVES, keeps its writer stamp, and is marked cross-project', async () => {
    const mover = await makeContext(projectA, `stayer-edge mover ${STAMP}`);
    const stayer = await makeContext(projectA, `stayer-edge stayer ${STAMP}`);
    await mintEdge({
      fromId: stayer,
      fromType: 'context',
      toId: mover,
      toType: 'context',
      edgeType: 'informs',
      projectId: projectA,
      via: 'link-tool',
    });

    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: mover,
      toProject: B_NAME,
    });
    const edges = resp.structuredContent.edges;
    expect(edges.touched, 'the inbound edge is in the policy population').toBeGreaterThanOrEqual(1);
    expect(edges.crossProject).toBeGreaterThanOrEqual(1);

    const row = await linkRow(stayer, mover);
    expect(row, 'THE EDGE STILL EXISTS — a move never deletes one').toBeTruthy();
    expect(row.project_id, 'writer-project stamp is a historical fact, left intact').toBe(projectA);
    expect(row.metadata.cross_project).toBe(true);
    expect(row.metadata.cross_project_via).toBe('reproject');
  });

  // ── EDGE POLICY, BRANCH 3: the other endpoint does not resolve ────────────────────
  test('C4: a DANGLING edge is counted as dangling and left exactly as it was', async () => {
    const mover = await makeContext(projectA, `dangling mover ${STAMP}`);
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    // mintEdge guards endpoints, so the dangling row is inserted directly — the point of
    // this case is a row the guard would refuse to create today but which EXISTS in the
    // wild (see resolveMintEndpoint's header: dangling edges are a known repair class).
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, mint_via)
       VALUES ($1,'context',$2,'context','related_to',$3,'link-tool')`,
      [mover, ghost, projectA],
    );

    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: mover,
      toProject: B_NAME,
    });
    expect(resp.structuredContent.edges.dangling).toBe(1);

    const row = await linkRow(mover, ghost);
    expect(row.project_id, 'a dangling edge is NOT re-stamped').toBe(projectA);
    expect(row.metadata.cross_project, 'and NOT mislabelled cross-project').toBeUndefined();
  });

  // ── THE FOLLOWERS ─────────────────────────────────────────────────────────────────
  test('C5: branch_memberships follows the record — the row branch reads are keyed on', async () => {
    const spine = await makeContext(projectA, `membership spine ${STAMP}`);
    // NOT makeContext: it closes the position first (so every other case starts unpositioned),
    // and a membership only mints for a write made WHILE standing on the branch.
    await routeExecutor('branch_open', { id: spine }, { connectionId: CONN });
    const member = parseId(
      await viaTool('context_store', {
        content: `membership member ${STAMP}`,
        type: 'code',
        projectId: projectA,
      }),
    );
    await routeExecutor('branch_close', {}, { connectionId: CONN });

    const bm = await db.query(
      `SELECT project_id::text AS project_id FROM branch_memberships WHERE record_id = $1`,
      [member],
    );
    expect(bm.rows.length, 'precondition: the member has a membership row').toBe(1);
    expect(bm.rows[0].project_id).toBe(projectA);

    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: member,
      toProject: B_NAME,
    });
    const after = await db.query(
      `SELECT project_id::text AS project_id FROM branch_memberships WHERE record_id = $1`,
      [member],
    );
    expect(after.rows[0].project_id, 'the membership row followed the record').toBe(projectB);
    expect(
      resp.structuredContent.satellites.map((s: any) => s.table),
      'and the move REPORTS which satellites followed',
    ).toContain('branch_memberships');
  });

  test('C5b: task_attachments follows a moved task — the column the Command backend authorizes attachment reads by', async () => {
    const taskId = parseId(
      await viaTool('task_create', { title: `attachment carrier ${STAMP}`, projectId: projectA }),
    );
    // No MCP tool writes this table (the Command backend's upload route does), so the row
    // is seeded the way migration 102 shapes it: bytes in-row, project_id denormalized.
    const seeded = await db.query(
      `INSERT INTO task_attachments (task_id, project_id, kind, filename, mime, byte_size, data, created_by)
       VALUES ($1, $2, 'before', 'before.png', 'image/png', 4, '\\x89504e47'::bytea, 'reproject-test')
       RETURNING id::text AS id, project_id::text AS project_id`,
      [taskId, projectA],
    );
    expect(seeded.rows[0].project_id, 'precondition: filed under A').toBe(projectA);

    const resp = await viaTool('project_move_record', {
      recordType: 'task',
      recordId: taskId,
      toProject: B_NAME,
    });
    expect(resp.structuredContent.moved).toBe(true);

    const after = await db.query(
      `SELECT project_id::text AS project_id FROM task_attachments WHERE id = $1`,
      [seeded.rows[0].id],
    );
    expect(after.rows[0].project_id, 'the attachment followed its task to B').toBe(projectB);
    // A project-scoped read under A — the shape taskAttachmentAuthz keys on — no longer sees it.
    const underA = await db.query(
      `SELECT 1 FROM task_attachments WHERE id = $1 AND project_id = $2`,
      [seeded.rows[0].id, projectA],
    );
    expect(underA.rows).toHaveLength(0);
    expect(
      resp.structuredContent.satellites.map((s: any) => s.table),
      'and the move REPORTS it',
    ).toContain('task_attachments');
  });

  // ── TASKS AND DECISIONS, not just contexts ───────────────────────────────────────
  test('C6: a task and a decision move by the same op, keeping id and created_at', async () => {
    await routeExecutor('project_switch', { project: projectA }, { connectionId: CONN });
    await routeExecutor('branch_close', {}, { connectionId: CONN });

    const taskResp = await viaTool('task_create', {
      title: `reproject task ${STAMP}`,
      projectId: projectA,
    });
    const taskId = parseId(taskResp);
    await routeExecutor('branch_close', {}, { connectionId: CONN });
    const decResp = await viaTool('decision_record', {
      decisionType: 'process',
      title: `reproject decision ${STAMP}`,
      description: 'moved by the reproject contract test',
      rationale: 'exercising the decision path of the same op',
      impactLevel: 'low',
      projectId: projectA,
    });
    const decId = parseId(decResp);
    await routeExecutor('branch_close', {}, { connectionId: CONN });

    for (const [type, table, id] of [
      ['task', 'tasks', taskId],
      ['decision', 'technical_decisions', decId],
    ] as const) {
      const before = await rowOf(table, id, type);
      const resp = await viaTool('project_move_record', {
        recordType: type,
        recordId: id,
        toProject: B_NAME,
      });
      expect(resp.structuredContent.ok, textOf(resp)).toBe(true);
      const after = await rowOf(table, id, type);
      expect(after.project_id, `${type} present in B`).toBe(projectB);
      expect(new Date(after.created_at).toISOString(), `${type} created_at preserved`).toBe(
        new Date(before.created_at).toISOString(),
      );
    }
  });

  // ── REFUSALS AND NO-OPS ──────────────────────────────────────────────────────────
  test('C7: moving to a project that does not exist changes NOTHING and says why', async () => {
    const id = await makeContext(projectA, `no-such-project ${STAMP}`);
    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: id,
      toProject: `no-such-project-${STAMP}`,
    });
    expect(textOf(resp)).toContain('REPROJECT_REFUSED');
    expect((await rowOf('contexts', id, 'context')).project_id, 'still in A').toBe(projectA);
  });

  test('C8: moving a record to the project it is already in is a reported NO-OP, not an error', async () => {
    const id = await makeContext(projectA, `already-there ${STAMP}`);
    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: id,
      toProject: A_NAME,
    });
    expect(resp.structuredContent.ok).toBe(true);
    expect(resp.structuredContent.action).toBe('already_there');
    expect(resp.structuredContent.moved).toBe(false);
    expect((await rowOf('contexts', id, 'context')).project_id).toBe(projectA);
  });

  test('C9: a record id that matches nothing is an actionable not-found, and nothing moves', async () => {
    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: '00000000-0000-4000-8000-00000000dead',
      toProject: B_NAME,
    });
    expect(textOf(resp).toLowerCase()).toContain('not found');
  });

  test('C10: a SHORT id resolves ACROSS projects — the record being rescued is never in yours', async () => {
    const id = await makeContext(projectC, `cross-project short id ${STAMP}`);
    const short = id.replace(/-/g, '').slice(0, 8);
    // The caller's connection is left pointing at C's neighbour; the op must not need it.
    await routeExecutor('project_switch', { project: projectA }, { connectionId: CONN });
    const resp = await viaTool('project_move_record', {
      recordType: 'context',
      recordId: short,
      toProject: B_NAME,
    });
    expect(resp.structuredContent.ok, textOf(resp)).toBe(true);
    expect(resp.structuredContent.recordId, 'the short id resolved to the full id').toBe(id);
    expect((await rowOf('contexts', id, 'context')).project_id).toBe(projectB);
  });
});
