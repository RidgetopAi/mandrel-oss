/**
 * AUTO-OPEN POSITIONS — the acceptance contract ( * design an earlier note). The 11 checks the design names, in order, each runnable.
 *
 * EVERY check drives the FULL PUBLIC PATH — validateToolArguments -> routeExecutor, the
 * exact path the HTTP bridge uses. That matters most for the three mutation probes (6/7/8):
 * their CONTROL leg must run the production invocation, or a green control proves only that
 * something else was green somewhere else (C4). There is no direct-service shortcut in this
 * file; the service is never imported for exercise, only its config-free behaviour observed.
 *
 * Embeddings are mocked to zeros. Similarity plays no part in positional membership — that
 * is the point of the whole mechanism — so a zero embedding is the honest fixture, and it
 * also means the B1 inference fallback cannot rescue anything and cannot flatter a result.
 *
 * DB target: the disposable migrated ci_* DB, never production.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { THREAD_CONFIG } from '../config/threadConfig.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const projectIds: string[] = [];

/** THE PRODUCTION INVOCATION. Nothing in this file talks to a service directly. */
async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshProject(label: string): Promise<string> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'auto-open fixture') RETURNING id`,
      [`autoopen-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  return projectId;
}
/** A connection switched onto a project — one agent's session. */
async function connectionOn(projectId: string, label: string): Promise<string> {
  const conn = `autoopen-conn-${label}-${STAMP}`;
  await bindConnectionToProject(conn, projectId);
  return conn;
}
/**
 * A READER connection on a project — a second agent opening the same thread.
 *
 * It must be bound for the SAME reason a writer must: `recall_thread` scopes
 * its traversal to the CALLING connection's current project, and an unbound connection takes
 * `initializeSession`'s Priority-4 `projects[0]` — whichever project the database happened to
 * touch last. Measured: with one decoy project carrying a newer `updated_at`, the two reads in
 * this file returned `ok:false` / no nodes and failed with `expected false to be true`, which
 * reads as a recall_thread defect and is not one.
 */
async function readerOn(projectId: string, label: string): Promise<string> {
  const conn = `autoopen-reader-${label}-${STAMP}`;
  await bindConnectionToProject(conn, projectId);
  return conn;
}
async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = await freshProject(label);
  return { projectId, conn: await connectionOn(projectId, label) };
}

// ── Observation helpers: the GRAPH and the POSITION ROW, read at row level ───────────────
async function edgeRows(fromId: string) {
  return (
    await db.query(
      `SELECT edge_type, created_by, to_id FROM links WHERE from_id = $1 ORDER BY edge_type, to_id`,
      [fromId]
    )
  ).rows.map((r) => ({ edgeType: r.edge_type, createdBy: r.created_by, toId: r.to_id }));
}
async function edgesTo(fromId: string, toId: string) {
  return (await edgeRows(fromId)).filter((e) => e.toId === toId);
}
/** Every edge row inside ONE fixture project (the scope every count in this file uses). */
async function projectEdges(projectId: string) {
  return (
    await db.query(
      `SELECT from_id, from_type, to_id, to_type, edge_type, created_by
         FROM links WHERE project_id = $1`,
      [projectId]
    )
  ).rows;
}
async function positionRow(projectId: string) {
  const r = await db.query(
    `SELECT session_key, spine_id, spine_type, origin, tip_id, tip_type, member_writes
       FROM branch_positions WHERE project_id = $1`,
    [projectId]
  );
  return r.rows;
}

// ── Write shorthands ─────────────────────────────────────────────────────────────────────
async function createTask(conn: string, title: string) {
  const r = await viaTool('task_create', { title, type: 'feature' }, conn);
  return { id: r.structuredContent.task.id as string, positional: r.structuredContent.task.positional, resp: r };
}
async function recordDecision(conn: string, title: string) {
  const r = await viaTool(
    'decision_record',
    { decisionType: 'architecture', title, description: 'd', rationale: 'r', impactLevel: 'medium' },
    conn
  );
  return { id: r.structuredContent.decision.id as string, positional: r.structuredContent.decision.positional, resp: r };
}
async function storeContext(conn: string, content: string, type = 'completion') {
  const r = await viaTool('context_store', { content, type }, conn);
  return { id: r.structuredContent.context.id as string, positional: r.structuredContent.context.positional, resp: r };
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

// =========================================================================================
// CHECK 1 — THE RIVET CANARY. The floor. If this ever goes red the feature is not doing
// the one thing it exists to do.
//
// The replay is the EXACT measured session shape from `rivet-weather` against v0.22.0
// prod: create task -> record decision -> capture -> complete the task -> five more
// completions. NO claims, NO threading tags, NO links arg, and nothing that depends on the
// agent reading a response line — because the agent that produced the gap read none.
// v0.22.0's outcome: the decision AND the task each ended with ZERO inbound edges.
// =========================================================================================

/** The canary session, replayed. Returns the ids so the assertions can name them. */
async function replayRivetSession(label: string) {
  const { projectId, conn } = await freshCase(label);

  const task = await createTask(conn, 'Build the weather app');
  const decision = await recordDecision(conn, 'Use the OpenWeather API rather than scraping');
  const first = await storeContext(conn, 'Scaffolded the project and pinned the API client', 'discussion');
  await viaTool('task_update', { taskId: id8(task.id), status: 'completed' }, conn);
  const completions: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const c = await storeContext(conn, `Completion note ${i}: shipped another slice of the weather app`);
    completions.push(c.id);
  }
  return { projectId, conn, task, decision, first, completions };
}

describe('CHECK 1 — RIVET CANARY (the floor)', () => {
  test('the decision AND the task each end with >=1 DECLARED inbound edge', async () => {
    const { projectId, task, decision, first, completions } = await replayRivetSession('canary');

    // Read the CLASSIFICATION from link_provenance (migration 079) — the single source —
    // and scope it to THIS fixture's project. Fleet-wide counts would be polluted by other
    // writers and could not be asserted on.
    const inbound = async (recordId: string, recordType: string) =>
      (
        await db.query(
          `SELECT created_by, edge_type, from_id
             FROM link_provenance
            WHERE project_id = $1 AND to_id = $2 AND to_type = $3 AND provenance_class = 'declared'`,
          [projectId, recordId, recordType]
        )
      ).rows;

    const decInbound = await inbound(decision.id, 'decision');
    const taskInbound = await inbound(task.id, 'task');

    // The measured failure was ZERO on both. This is the assertion that fails if it returns.
    expect(decInbound.length, 'declared inbound edges on the DECISION').toBeGreaterThanOrEqual(1);
    expect(taskInbound.length, 'declared inbound edges on the TASK').toBeGreaterThanOrEqual(1);

    // And they are the right SHAPE, not just a count: the six captures inform the DECISION
    // (Q2's ruling — that is what makes "what this decision shaped" populate structurally),
    // and the decision informs the TASK (which is what keeps the task reachable as root).
    const capturesOnDecision = decInbound.filter((r) => [first.id, ...completions].includes(r.from_id));
    expect(capturesOnDecision).toHaveLength(6);
    expect(taskInbound.map((r) => r.from_id)).toContain(decision.id);
  });

  test('recall_thread(task) at DEFAULT depth returns every completion', async () => {
    const { projectId, task, decision, first, completions } = await replayRivetSession('canary-recall');

    // NO depth argument: the product's own default governs. Derived from the config the
    // product reads, never hardcoded here (C4) — and asserted, so a config change that
    // would break the R3 mint-to-ROOT decision fails loudly rather than silently.
    expect(THREAD_CONFIG.defaultDepth).toBeGreaterThanOrEqual(2);
    const reader = await readerOn(projectId, 'recall');
    const thread = await viaTool('recall_thread', { anchor: task.id }, reader);
    expect(thread.structuredContent.ok).toBe(true);
    expect(thread.structuredContent.depthUsed).toBe(THREAD_CONFIG.defaultDepth);

    const ids: string[] = thread.structuredContent.nodes.map((n: any) => n.id);
    expect(ids).toContain(decision.id);
    for (const c of [first.id, ...completions]) {
      expect(ids, `completion ${c.slice(0, 8)} reachable from the task at default depth`).toContain(c);
    }
  });

  test('the meter delta for the canary project is 100% DECLARED', async () => {
    const { projectId } = await replayRivetSession('canary-meter');

    // Scoped to the fixture's own project, read from link_provenance directly. NOT the
    // provenance ALARM: its floor leg is a fleet-wide 7-day count with ~97% headroom, so it
    // is a death detector and cannot fail on a partial regression here.
    const rows = (
      await db.query(
        `SELECT provenance_class, count(*)::int AS n
           FROM link_provenance WHERE project_id = $1 GROUP BY 1`,
        [projectId]
      )
    ).rows;
    const byClass = Object.fromEntries(rows.map((r: any) => [r.provenance_class, r.n]));

    expect(byClass.guessed ?? 0, 'guessed edges in the canary project').toBe(0);
    expect(byClass.unclassified ?? 0, 'unclassified edges in the canary project').toBe(0);
    expect(byClass.declared ?? 0, 'declared edges in the canary project').toBeGreaterThan(0);

    // The SOURCE-grain signal: auto-open is what minted them. A class-level rollup alone
    // would still read 100% declared if positional minting died and something else covered
    // for it — that is exactly the collapse the 079 meter was built after.
    const bySource = (
      await db.query(
        `SELECT created_by, count(*)::int AS n
           FROM link_provenance WHERE project_id = $1 GROUP BY 1`,
        [projectId]
      )
    ).rows;
    const positional = bySource.find((r: any) => r.created_by === 'auto:positional');
    expect(positional?.n ?? 0, 'edges minted by auto:positional').toBeGreaterThanOrEqual(7);
  });

  test('running the canary TWICE produces an identical edge multiset', async () => {
    const runA = await replayRivetSession('canary-idem-a');
    const runB = await replayRivetSession('canary-idem-b');

    // Ids differ between runs, so compare the STRUCTURE: each edge as
    // (fromRole -> toRole, type, source), with roles resolved symbolically. Two runs of the
    // same session shape must produce the same graph, or the rules are order/timing
    // dependent and nothing else in this file means anything.
    const signature = async (run: Awaited<ReturnType<typeof replayRivetSession>>) => {
      const role = new Map<string, string>([
        [run.task.id, 'TASK'],
        [run.decision.id, 'DECISION'],
        [run.first.id, 'CAPTURE'],
      ]);
      run.completions.forEach((c) => role.set(c, 'CAPTURE'));
      return (await projectEdges(run.projectId))
        .map((e: any) =>
          `${role.get(e.from_id) ?? '?'}:${e.from_type} -${e.edge_type}/${e.created_by}-> ${role.get(e.to_id) ?? '?'}:${e.to_type}`
        )
        .sort();
    };

    const sigA = await signature(runA);
    const sigB = await signature(runB);
    expect(sigA.length).toBeGreaterThan(0);
    expect(sigA).toEqual(sigB);
    // No unresolved role: an edge pointing outside the replayed records would mean the
    // session attached to something it never created.
    expect(sigA.filter((s) => s.includes('?:'))).toEqual([]);
  });
});

// =========================================================================================
// CHECK 2 — COORDINATOR. Five rapid creates: zero edges among them, TRUNK after #2.
// =========================================================================================
describe('CHECK 2 — COORDINATOR (task_create x5)', () => {
  test('zero edges among the five, and the session is at TRUNK after #2', async () => {
    const { projectId, conn } = await freshCase('coord');

    const made: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const t = await createTask(conn, `Batched task ${i}`);
      made.push(t.id);
      if (i === 1) expect(t.positional.autoOpened, 'the FIRST create auto-opens').toBe(true);
      if (i === 2) {
        expect(t.positional.revertedToTrunk, 'the SECOND same-type create is fan-out').toBe(true);
        expect(t.positional.edges, 'R2 mints NOTHING — the wrong edge never exists').toEqual([]);
      }
      if (i > 2) {
        expect(t.positional.atTrunk, `create ${i} is at trunk`).toBe(true);
        expect(t.positional.edges, `create ${i} mints nothing at trunk`).toEqual([]);
      }
    }

    // ZERO edges among them — the whole point of reverting BEFORE minting.
    for (const from of made) {
      for (const to of made) {
        if (from !== to) expect(await edgesTo(from, to), `${from.slice(0, 8)} -> ${to.slice(0, 8)}`).toEqual([]);
      }
    }
    expect(await projectEdges(projectId), 'no edges at all in a pure fan-out session').toEqual([]);

    // The position row says TRUNK, and branch_current does NOT report a branch (saying
    // "current branch: <spine>" here would describe a position that mints nothing as one
    // that mints).
    const rows = await positionRow(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('trunk');
    const cur = await viaTool('branch_current', {}, conn);
    expect(cur.structuredContent.position).toBeNull();
    expect(cur.structuredContent.atTrunk).toBe(true);
    expect(responseText(cur)).toContain('TRUNK');
  });
});

// =========================================================================================
// CHECK 3 — BATCH-DECISION. The same shape through decision_record: the rule is about the
// session, not about tasks.
// =========================================================================================
describe('CHECK 3 — BATCH-DECISION (decision_record x5)', () => {
  test('zero edges among the five decisions, and TRUNK after #2', async () => {
    const { projectId, conn } = await freshCase('batchdec');

    const made: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const d = await recordDecision(conn, `Batched decision ${i}`);
      made.push(d.id);
      if (i === 1) expect(d.positional.autoOpened).toBe(true);
      if (i === 2) expect(d.positional.revertedToTrunk).toBe(true);
      if (i >= 2) expect(d.positional.edges).toEqual([]);
    }
    expect(await projectEdges(projectId)).toEqual([]);
    expect((await positionRow(projectId))[0].origin).toBe('trunk');
  });
});

// =========================================================================================
// CHECK 4 — INTERLEAVED-WORKER PIN. A worker who does real work between creates is NOT a
// coordinator: T2 informs T1. This is the case R2 must not eat.
// =========================================================================================
describe('CHECK 4 — INTERLEAVED-WORKER PIN', () => {
  test('T1 -> capture -> T2: the position survives and T2 informs T1', async () => {
    const { projectId, conn } = await freshCase('worker');

    const t1 = await createTask(conn, 'T1 — the work the session is actually doing');
    expect(t1.positional.autoOpened).toBe(true);

    // ONE member write is all it takes to make the position non-virgin. That is the entire
    // difference between this session and check 2's, and it is the accepted risk boundary:
    // a worker who fans out two siblings BEFORE any member write is misread, deliberately.
    const c = await storeContext(conn, 'Working T1: wired the first slice', 'discussion');
    expect(await edgesTo(c.id, t1.id)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: t1.id },
    ]);

    const t2 = await createTask(conn, 'T2 — the next piece of the same work');
    expect(t2.positional.revertedToTrunk, 'NOT fan-out: the position was no longer virgin').toBe(false);
    expect(t2.positional.atTrunk).toBe(false);

    // THE PIN: T2 informs T1. Asserted on the row, filtered to `informs` — the structural
    // parent edge is deliberately not part of this contract.
    const t2ToT1 = (await edgesTo(t2.id, t1.id)).filter((e) => e.edgeType === 'informs');
    expect(t2ToT1).toEqual([{ edgeType: 'informs', createdBy: 'auto:positional', toId: t1.id }]);

    // R3: the branch EXTENDED — T2 is the new tip, T1 is still the root — so a following
    // capture attaches to T2 while T2 itself attached to the ROOT.
    const row = (await positionRow(projectId))[0];
    expect(row).toMatchObject({ origin: 'auto', spine_id: t1.id, tip_id: t2.id, tip_type: 'task' });
    const c2 = await storeContext(conn, 'Working T2 now', 'discussion');
    expect(await edgesTo(c2.id, t2.id)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: t2.id },
    ]);
  });
});

// =========================================================================================
// CHECK 5 — DEPTH BOUND. Everything the rules mint stays inside recall_thread's DEFAULT
// depth. This is the measured constraint R3 exists to respect: minting to the TIP instead
// of the ROOT would walk the branch one level deeper per record.
// =========================================================================================
describe('CHECK 5 — DEPTH BOUND', () => {
  /**
   * THE DISTINGUISHING CASE, isolated and named for its actual predicate.
   *
   * WHY IT EXISTS (Reviewer, reject round 1): the depth-bound case below originally had
   * exactly ONE create after the root. At that moment `tip_id` is still NULL, so
   * positionTarget() returns the root — root and tip COINCIDE, and mint-to-ROOT is
   * indistinguishable from mint-to-TIP. Inverting the single line the two behaviours differ
   * on (positionalMint.ts, the `isCreate ? root : positionTarget(pos)` target choice) left
   * all 22 checks GREEN. The guard could not observe the property it was written about.
   *
   * A THIRD create is what makes the property observable: by then the tip is the SECOND
   * record, so "attaches to the root" and "attaches to the tip" name different rows.
   */
  test('a create attaches to the ROOT, never to the TIP — the R3 rule that bounds recall depth', async () => {
    const { projectId, conn } = await freshCase('depth-root-vs-tip');

    const root = await createTask(conn, 'ROOT — the first act');           // R1: auto-open, tip NULL
    const dec = await recordDecision(conn, 'extends the branch');          // R3: tip is still NULL here
    const third = await createTask(conn, 'the third record — the tip is now the DECISION');

    // The tip really did move before the third create, or the case proves nothing.
    // Asserted on the row, so this is a fact about state and not about ordering luck.
    const rowBefore = await edgesTo(third.id, dec.id);
    const row = (await positionRow(projectId))[0];
    expect(row.spine_id, 'the ROOT is unchanged by extending').toBe(root.id);
    expect(row.tip_id, 'the tip advanced to the third record').toBe(third.id);

    // THE ASSERTION THE MUTATION FAILS: the third create informs the ROOT...
    expect((await edgesTo(third.id, root.id)).filter((e) => e.edgeType === 'informs')).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: root.id },
    ]);
    // ...and NOT the decision, which was the tip when it was written. Minting to the tip
    // here is what builds a chain and pushes recall past defaultDepth.
    expect(rowBefore, 'a create must not attach to the record that happened to be the tip').toEqual([]);
  });

  test('a long auto session stays reachable from its ROOT at default depth', async () => {
    const { projectId, conn } = await freshCase('depth');

    const root = await createTask(conn, 'ROOT — the first act');
    const dec = await recordDecision(conn, 'the decision that extends the branch');
    // A THIRD create, so the branch has a real chain to fail on: the tip is `dec` when this
    // is written, so a mint-to-TIP regression would put `second` one hop further out and the
    // captures below one hop further still.
    const second = await createTask(conn, 'a second task, created after real work');
    const captures: string[] = [];
    for (let i = 1; i <= 8; i++) {
      captures.push((await storeContext(conn, `capture ${i} on the extended branch`)).id);
    }

    const reader = await readerOn(projectId, 'depth');
    const thread = await viaTool('recall_thread', { anchor: root.id }, reader);
    expect(thread.structuredContent.depthUsed).toBe(THREAD_CONFIG.defaultDepth);
    expect(thread.structuredContent.truncated, 'not truncated at the default node cap').toBe(false);

    const ids: string[] = thread.structuredContent.nodes.map((n: any) => n.id);
    for (const id of [dec.id, second.id, ...captures]) {
      expect(ids, `${id.slice(0, 8)} within default depth of the root`).toContain(id);
    }

    // And the mechanism that makes it true, now actually exercised on a chain:
    //   • EVERY create sits ONE hop from the root — both of them, including the one written
    //     while another record was the tip;
    //   • every capture attaches to the CURRENT tip, which is itself one hop from the root.
    // So the deepest thing here is at depth 2, no matter how long the session runs.
    for (const create of [dec.id, second.id]) {
      expect(
        (await edgesTo(create, root.id)).filter((e) => e.edgeType === 'informs'),
        `${create.slice(0, 8)} informs the ROOT`
      ).toHaveLength(1);
    }
    expect(await edgesTo(second.id, dec.id), 'creates never chain tip-to-tip').toEqual([]);
    for (const c of captures) {
      expect(await edgesTo(c, second.id), 'captures attach to the CURRENT tip').toHaveLength(1);
      expect(await edgesTo(c, root.id), 'and not additionally to the root').toEqual([]);
    }
  });
});

// =========================================================================================
// MUTATION PROBES (checks 6/7/8).
//
// Each carries the three assertions: the mutation LANDED (re-read from the DB, not assumed
// from the UPDATE returning), the guard went RED, and the UNMUTATED CONTROL is GREEN — with
// the control running the SAME production invocation as the mutated leg, in the same test,
// so a green control cannot come from somewhere else.
//
// The mutations are applied to the POSITION ROW, which is the state the rules read. That is
// deliberate: it mutates the thing the guard is about, not the guard's own bookkeeping.
// =========================================================================================

/**
 * THE GUARD WENT RED — and red for the RIGHT REASON. A bare "it threw" is not enough: a
 * harness crash (a bad column name in the mutation, a dead pool, a TypeError in a helper)
 * also throws, and would make every probe below pass while proving nothing. So the
 * rejection must be an ASSERTION failure — the guard noticing — not any other error.
 */
function expectGuardRed(err: unknown): void {
  expect(err, 'GUARD RED: the mutated scenario must fail, not pass').not.toBeNull();
  expect(
    (err as Error)?.name,
    `GUARD RED for the right reason (got: ${(err as Error)?.name}: ${(err as Error)?.message?.slice(0, 200)})`
  ).toBe('AssertionError');
}

/** Apply a mutation and PROVE it landed by reading the row back. */
async function mutatePositionRow(
  projectId: string,
  patch: Record<string, string | number>
): Promise<Record<string, any>> {
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await db.query(`UPDATE branch_positions SET ${sets} WHERE project_id = $1`, [
    projectId,
    ...cols.map((c) => patch[c]),
  ]);
  const after = (await positionRow(projectId))[0];
  for (const c of cols) {
    expect(after?.[c], `MUTATION LANDED: ${c}`).toBe(patch[c]);
  }
  return after;
}

// ── CHECK 6 — DECLARED-INVARIANCE ────────────────────────────────────────────────────────
// The guarded property, stated as its own predicate: a position opened by a DECLARED act
// behaves exactly as it did in shipped P1 — a same-type create still mints its membership
// edge (it is never read as fan-out), and a capture attaches to the SPINE with no tip
// mechanics anywhere. This is R0, the single most important invariant in the change.
describe('CHECK 6 — DECLARED-INVARIANCE mutation probe', () => {
  /**
   * The GUARD, as one callable body so the control and the mutated leg run byte-identical
   * production calls. `mutate` runs after the declared branch_open and before the writes.
   */
  async function declaredPositionBehavesAsP1(
    label: string,
    mutate?: (projectId: string) => Promise<void>
  ): Promise<void> {
    const { projectId, conn } = await freshCase(label);
    const spine = await createTask(conn, 'the spine');
    // THE DECLARED ACT. It resets origin/tip/counter, which is what makes the P1 contract
    // hold regardless of anything the session did before it.
    await viaTool('branch_open', { id: id8(spine.id) }, conn);
    if (mutate) await mutate(projectId);

    // P1 property 1: a same-type create while positioned is a MEMBER, never fan-out.
    const child = await createTask(conn, 'a task created while standing on the spine');
    expect((await edgesTo(child.id, spine.id)).filter((e) => e.edgeType === 'informs')).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: spine.id },
    ]);

    // P1 property 2: a capture attaches to the SPINE — no tip mechanics on a declared
    // position, so the child above did not become a tip.
    const cap = await storeContext(conn, 'a capture on the declared branch', 'discussion');
    expect(await edgesTo(cap.id, spine.id)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: spine.id },
    ]);
    expect(await edgesTo(cap.id, child.id), 'a declared position has no tip to attach to').toEqual([]);
  }

  test('control GREEN, mutation LANDED, guard RED', async () => {
    // 1. THE UNMUTATED CONTROL — the production invocation, green.
    await expect(declaredPositionBehavesAsP1('inv-control')).resolves.toBeUndefined();

    // 2 + 3. THE MUTATION: force the declared position to be treated as AUTO. Landing is
    // asserted inside mutatePositionRow by reading the row back. With origin='auto' the row
    // is virgin, so the same-type create is read as fan-out and mints nothing — the guard
    // must go RED rather than shrug.
    const red = await declaredPositionBehavesAsP1('inv-mutant', async (projectId) => {
      await mutatePositionRow(projectId, { origin: 'auto' });
    }).then(() => null, (e) => e);
    expectGuardRed(red);
  });
});

// ── CHECK 7 — VIRGINITY GUARD ────────────────────────────────────────────────────────────
// The guarded property: fan-out is detected by VIRGINITY (zero member writes), not by
// anything else. If the counter stops meaning what it means, R2 fires on working sessions
// or stops firing on coordinators — and check 4 and check 2 become the same test.
describe('CHECK 7 — VIRGINITY GUARD mutation probe', () => {
  async function secondSameTypeCreateIsFanOut(
    label: string,
    mutate?: (projectId: string) => Promise<void>
  ): Promise<void> {
    const { projectId, conn } = await freshCase(label);
    const first = await createTask(conn, 'first of a batch');
    expect(first.positional.autoOpened).toBe(true);
    if (mutate) await mutate(projectId);

    const second = await createTask(conn, 'second of a batch');
    expect(second.positional.revertedToTrunk, 'the second same-type create is fan-out').toBe(true);
    expect(second.positional.edges, 'fan-out mints nothing').toEqual([]);
    expect(await edgesTo(second.id, first.id)).toEqual([]);
    expect((await positionRow(projectId))[0].origin).toBe('trunk');
  }

  test('control GREEN, mutation LANDED, guard RED', async () => {
    // 1. CONTROL — the real fan-out session, through the production path.
    await expect(secondSameTypeCreateIsFanOut('virgin-control')).resolves.toBeUndefined();

    // 2 + 3. MUTATION: forge a member write that never happened. The position is no longer
    // virgin, R2 must not fire, and the guard must notice.
    const red = await secondSameTypeCreateIsFanOut('virgin-mutant', async (projectId) => {
      await mutatePositionRow(projectId, { member_writes: 1 });
    }).then(() => null, (e) => e);
    expectGuardRed(red);
  });

  test('the ZERO population is the one that decides it — member_writes 0 vs 1, nothing else changed', async () => {
    // The empty/zero population C3 asks for, made explicit: two sessions identical in every
    // way except the counter, with opposite outcomes. This is what proves the predicate is
    // the counter and not some correlate of it (timing, ordering, record count).
    const virgin = await freshCase('virgin-zero');
    const t1 = await createTask(virgin.conn, 'A1');
    expect((await positionRow(virgin.projectId))[0].member_writes).toBe(0);
    const t2 = await createTask(virgin.conn, 'A2');
    expect(t2.positional.revertedToTrunk).toBe(true);

    const worked = await freshCase('virgin-one');
    const u1 = await createTask(worked.conn, 'B1');
    await mutatePositionRow(worked.projectId, { member_writes: 1 });
    const u2 = await createTask(worked.conn, 'B2');
    expect(u2.positional.revertedToTrunk).toBe(false);
    expect((await edgesTo(u2.id, u1.id)).filter((e) => e.edgeType === 'informs')).toHaveLength(1);
    expect(await edgesTo(t2.id, t1.id)).toEqual([]);
  });
});

// ── CHECK 8 — TRUNK MINTS NOTHING ────────────────────────────────────────────────────────
// The guarded property: once at trunk, no membership edge is minted by any write, for the
// rest of the session's life. Probed with a CAPTURE so exactly ONE variable moves — the
// origin — with no virginity or same-type interaction in the way.
describe('CHECK 8 — TRUNK-MINTS-NOTHING mutation probe', () => {
  async function trunkMintsNothing(
    label: string,
    mutate?: (projectId: string) => Promise<void>
  ): Promise<void> {
    const { projectId, conn } = await freshCase(label);
    const first = await createTask(conn, 'first of a batch');
    await createTask(conn, 'second of a batch — reverts the session to trunk');
    expect((await positionRow(projectId))[0].origin).toBe('trunk');
    if (mutate) await mutate(projectId);

    const cap = await storeContext(conn, 'a capture made after the revert', 'discussion');
    expect(cap.positional.edges, 'a capture at trunk mints no membership edge').toEqual([]);
    expect(await edgesTo(cap.id, first.id)).toEqual([]);
    expect(await edgeRows(cap.id), 'no positional edge from a trunk capture at all').toEqual([]);
  }

  test('control GREEN, mutation LANDED, guard RED', async () => {
    // 1. CONTROL — a genuinely reverted session, production path, mints nothing.
    await expect(trunkMintsNothing('trunk-control')).resolves.toBeUndefined();

    // 2 + 3. MUTATION: un-revert the row (trunk -> auto) and nothing else. The capture then
    // attaches to the root, and the guard must go RED.
    const red = await trunkMintsNothing('trunk-mutant', async (projectId) => {
      await mutatePositionRow(projectId, { origin: 'auto' });
    }).then(() => null, (e) => e);
    expectGuardRed(red);
  });

  test('a DECLARED act is what exits trunk — and nothing else in the session does', async () => {
    const { projectId, conn } = await freshCase('trunk-exit');
    const first = await createTask(conn, 'first of a batch');
    await createTask(conn, 'second of a batch');
    await createTask(conn, 'third — still at trunk');
    await storeContext(conn, 'a capture — still at trunk', 'discussion');
    expect((await positionRow(projectId))[0].origin).toBe('trunk');

    // THE DECLARED ACT.
    await viaTool('branch_open', { id: id8(first.id) }, conn);
    const row = (await positionRow(projectId))[0];
    expect(row).toMatchObject({ origin: 'declared', spine_id: first.id, tip_id: null, member_writes: 0 });

    const cap = await storeContext(conn, 'a capture after standing on a branch deliberately', 'discussion');
    expect(await edgesTo(cap.id, first.id)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: first.id },
    ]);
  });
});

// =========================================================================================
// CHECK 9 — PARALLEL AGENTS. Two sessions in ONE project, each auto-opening its own
// position, interleaved. Isolation is inherited from P1's keying (R6) — this proves the new
// state (origin/tip/counter) is per-session too, which is where a shared-slot bug would live.
// =========================================================================================
describe('CHECK 9 — PARALLEL AGENTS', () => {
  test('two auto-opened sessions in one project never cross-contaminate', async () => {
    const projectId = await freshProject('parallel');
    const connX = await connectionOn(projectId, 'parallel-x');
    const connY = await connectionOn(projectId, 'parallel-y');

    const rootX = await createTask(connX, 'X root');
    const rootY = await createTask(connY, 'Y root');
    expect(rootX.positional.autoOpened).toBe(true);
    expect(rootY.positional.autoOpened).toBe(true);

    // Interleave X, Y, X, Y.
    const x1 = await storeContext(connX, 'X capture 1', 'discussion');
    const y1 = await storeContext(connY, 'Y capture 1', 'discussion');
    const x2 = await storeContext(connX, 'X capture 2', 'discussion');
    const y2 = await storeContext(connY, 'Y capture 2', 'discussion');

    for (const [cap, own, other] of [
      [x1, rootX, rootY], [x2, rootX, rootY],
      [y1, rootY, rootX], [y2, rootY, rootX],
    ] as const) {
      expect(await edgesTo(cap.id, own.id)).toEqual([
        { edgeType: 'informs', createdBy: 'auto:positional', toId: own.id },
      ]);
      expect(await edgesTo(cap.id, other.id), 'zero cross-contamination').toEqual([]);
    }

    // Two rows, two independent counters — not one shared slot.
    const rows = await positionRow(projectId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.origin).toBe('auto');
      expect(r.member_writes).toBe(2);
    }

    // And one session reverting to trunk does not move the other.
    await createTask(connX, 'X second create — but X is no longer virgin');
    const yRow = (await positionRow(projectId)).find((r: any) => r.spine_id === rootY.id);
    expect(yRow.origin).toBe('auto');
  });
});

// =========================================================================================
// CHECK 10 — RECONNECT. R6: a reconnect is a fresh session key, therefore fresh auto-open
// eligibility — including for a session that had reverted to trunk. The old session's state
// must survive untouched (a reconnect is not a reset of somebody else's position).
// =========================================================================================
describe('CHECK 10 — RECONNECT', () => {
  test('a reconnected agent is freshly eligible; the old session stays at trunk', async () => {
    const projectId = await freshProject('reconnect');
    const first = await connectionOn(projectId, 'reconnect-1');

    const t1 = await createTask(first, 'before the disconnect');
    await createTask(first, 'and another — this reverts session 1 to trunk');
    const rowsBefore = await positionRow(projectId);
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0].origin).toBe('trunk');

    // THE RECONNECT: a new connection id is a new session key.
    const second = await connectionOn(projectId, 'reconnect-2');
    const t3 = await createTask(second, 'after reconnecting');
    expect(t3.positional.autoOpened, 'a reconnect restores auto-open eligibility').toBe(true);
    expect(t3.positional.atTrunk).toBe(false);

    const cap = await storeContext(second, 'work on the reconnected session', 'discussion');
    expect(await edgesTo(cap.id, t3.id)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: t3.id },
    ]);

    // The ORIGINAL session is untouched — still at trunk, still reverted from its own root.
    const rowsAfter = await positionRow(projectId);
    expect(rowsAfter).toHaveLength(2);
    const old = rowsAfter.find((r: any) => r.spine_id === t1.id);
    expect(old.origin).toBe('trunk');
  });
});

// =========================================================================================
// CHECK 11 — NO-CONFIG GREP. The design forbids a new config key, env var or TTL: nothing
// may be required of any customer agent, and nothing may be tunable into a different
// behaviour. This is a property of BYTES, so the instrument is grep over the diff — not a
// golden list of known knobs, which would drift and would only ever describe the knobs
// somebody remembered.
// =========================================================================================
describe('CHECK 11 — NO-CONFIG GREP', () => {
  /**
   * THE DIFF RANGE IS FIXED AT BOTH ENDS, ON PURPOSE.
   *
   * BASE_REF is the v0.23.0 release the auto-open branch was cut from; HEAD_REF is the
   * v0.24.0 release that merged it. CHECK 11 asserts a HISTORICAL FACT about ONE change —
   * "the auto-open change introduced no new env var, config key or TTL" — so it must measure
   * that change and nothing else.
   *
   * It used to read `git diff BASE_REF -- <paths>`, i.e. the base against the WORKING TREE.
   * That silently turned a claim about auto-open into a standing "no new config anywhere,
   * ever" rule policing every future commit. The first branch to touch it was Phase 3
   *, which tripped it by ADDING A CONFIG MODULE CORRECTLY — obeying the
   * standing `configs-not-hardcoded` rule — and went RED on the clean gate for it.
   *
   * The predicate below is deliberately NOT loosened to accommodate that. A repo-wide
   * "no new config" guard may well be worth having, but it is a different, deliberate
   * decision and must not be created by accident as a side effect of one release's check.
   */
  const BASE_REF = 'e2e93b1';
  const HEAD_REF = '6430317';
  const repoRoot = path.resolve(process.cwd(), '..');

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  }

  /**
   * Strip COMMENTS before matching. The claim under test is about code — a knob that
   * EXISTS — and prose is not a knob. Without this the guard fails on its own subject
   * matter: the first run flagged exactly two lines, both of them comments in this change
   * saying "NO TTL, NO new config key, NO new env var". A guard that a healthy run makes go
   * red gets deleted the first time it is inconvenient, which is worse than the hole.
   *
   * Fail-closed on purpose: `//` and `--` are stripped wherever they appear, so a URL or a
   * SQL string containing them loses its tail and can only make this check STRICTER, never
   * blinder. Block-comment bodies (` * …`) are dropped whole.
   */
  function codeOnly(lines: string[]): string[] {
    return lines
      .map((l) => l.replace(/^\+/, ''))
      .filter((l) => !/^\s*(\/\*|\*|\/\/|--)/.test(l))
      .map((l) => l.split('//')[0].split('--')[0]);
  }

  /** Every way this repo reads a knob. A TTL can only arrive through one of them. */
  const KNOB = /process\.env|envInt\(|envBool\(|envStr\(|envList\(|MANDREL_[A-Z0-9_]+|AIDIS_[A-Z0-9_]+|\bttl\b/i;

  /**
   * THE POPULATION, named: PRODUCT source and migrations under mcp-server — everything that
   * ships and everything a running server reads. That is the whole population the claim is
   * about, because "no new config, env var or TTL" is a claim about what a CUSTOMER AGENT
   * must supply, and nothing under src/tests is loaded by a server or shipped to anyone.
   *
   * Test files are excluded for a co-located, written reason rather than by an allow-list:
   * this very file must contain the strings `process.env` and `MANDREL_..._TTL` to probe
   * that KNOB is not hollow (see the probe below). A guard that forbids the mutation probe
   * of the feature it guards is a guard that gets deleted the first time it is inconvenient.
   * The narrowing is exactly one directory and it is asserted below that it does not empty
   * the population.
   */
  const isProduct = (f: string) => f.startsWith('mcp-server/') && !f.includes('/tests/');

  test('the base ref is reachable (an unmeasurable check must FAIL, never pass quietly)', () => {
    // C1's third state: "could not measure" gets its own branch and is a FAILURE here. A
    // grep that finds nothing because it ran against nothing is the false green this whole
    // check exists to avoid.
    // BOTH ends must be reachable now that the range is closed — an unreachable HEAD_REF
    // would otherwise surface as an empty diff, i.e. a passing check that measured nothing.
    expect(git(['cat-file', '-t', BASE_REF]).trim()).toBe('commit');
    expect(git(['cat-file', '-t', HEAD_REF]).trim()).toBe('commit');
  });

  test('the diff introduces no new env var, config key, or TTL', () => {
    const changed = git(['diff', '--name-only', BASE_REF, HEAD_REF, '--', 'mcp-server/src', 'mcp-server/database'])
      .split('\n')
      .filter(Boolean);
    const productFiles = changed.filter(isProduct);
    // The narrowing must not empty the population — if it did, this check would pass by
    // measuring nothing, which is the false green the whole check exists to prevent.
    expect(productFiles.length, 'product files this change touched').toBeGreaterThan(0);

    const diff = git(['diff', BASE_REF, HEAD_REF, '--', ...productFiles]);
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added.length, 'the diff must be non-empty or this check measured nothing').toBeGreaterThan(0);

    const offenders = codeOnly(added).filter((l) => KNOB.test(l));
    expect(offenders, 'added CODE lines introducing a knob').toEqual([]);
  });

  test('the knob pattern actually matches a knob (this guard is not hollow)', () => {
    // C3, one probe: the check above passes trivially if KNOB matches nothing or codeOnly()
    // eats everything. Feed it a line of each shape that MUST be caught, and one comment
    // that must not be — so a green above means the pattern looked and found nothing, not
    // that it could not look.
    expect(codeOnly(['+  const x = process.env.FOO;']).filter((l) => KNOB.test(l))).toHaveLength(1);
    expect(codeOnly(['+  ttlSeconds: envInt(\'MANDREL_THING_TTL\', 60),']).filter((l) => KNOB.test(l))).toHaveLength(1);
    expect(codeOnly(['+-- NO TTL, no new env var']).filter((l) => KNOB.test(l))).toHaveLength(0);
    expect(codeOnly(['+ * NO new config, NO env var, NO TTL.']).filter((l) => KNOB.test(l))).toHaveLength(0);
  });

  // DELETED 2026-08-15 (SK2): 'no untracked source file smuggles one in either'.
  // It scanned UNTRACKED files, and scripts/ci-clean-gate.sh refuses to run at all on a
  // checkout with any (`git status --porcelain` non-empty → die, before a single stage). So
  // its population was EMPTY BY CONSTRUCTION in every authoritative gate run: it could only
  // ever fire in a developer worktree, on whatever that developer happened to be writing.

  test('no new config MODULE was added', () => {
    const names = git(['diff', '--name-status', BASE_REF, HEAD_REF, '--', 'mcp-server/src/config'])
      .split('\n')
      .filter(Boolean);
    expect(names.filter((l) => l.startsWith('A')), 'added files under src/config').toEqual([]);
  });
});

// =========================================================================================
// THE Q3 METER (an earlier decision's Q3 ruling, migration 082). Inference-widening to
// decision/task targets is DEFERRED — a guess can never mint trust, so it cannot close the
// measured gap. What ships instead is the INSTRUMENT that decides whether widening ever
// earns a designed pass, and that shows whether the accepted R2 misclassification happens
// at a rate that matters. A meter nobody has read a number out of is not an instrument, so
// it is exercised here rather than merely created.
// =========================================================================================
describe('Q3 METER — zero-declared-inbound rate for decisions and tasks', () => {
  test('it separates a record nothing points at from one something declares', async () => {
    const { projectId, conn } = await freshCase('q3');

    // (a) THE RIVET SHAPE, which is what the meter exists to count: a fan-out session, so
    // both records end with nothing pointing at them.
    const orphanTask = await createTask(conn, 'nobody points at this');
    const orphanTask2 = await createTask(conn, 'nor at this — and now the session is at trunk');

    // (b) THE HEALTHY SHAPE, in its own session: a create that gets declared inbound.
    const conn2 = await connectionOn(projectId, 'q3-worker');
    const root = await createTask(conn2, 'the worked branch root');
    const dec = await recordDecision(conn2, 'a decision on that branch');

    const meter = async (recordId: string) =>
      (
        await db.query(
          `SELECT declared_inbound, guessed_inbound FROM record_declared_inbound
            WHERE project_id = $1 AND record_id = $2`,
          [projectId, recordId]
        )
      ).rows[0];

    expect(await meter(orphanTask.id), 'a fan-out record').toMatchObject({ declared_inbound: 0 });
    expect(await meter(orphanTask2.id)).toMatchObject({ declared_inbound: 0 });
    expect((await meter(root.id)).declared_inbound, 'the root the decision informs').toBeGreaterThanOrEqual(1);
    expect((await meter(dec.id)).declared_inbound, 'the decision is the TIP, nothing informs it yet').toBe(0);

    // The RATE grain, per record type — the number the Q3 ruling is actually about.
    const rows = (
      await db.query(
        `SELECT record_type, records, zero_declared, zero_declared_rate
           FROM zero_declared_inbound_weekly WHERE project_id = $1 ORDER BY record_type`,
        [projectId]
      )
    ).rows;
    const byType = Object.fromEntries(rows.map((r: any) => [r.record_type, r]));
    expect(byType.task).toMatchObject({ records: 3, zero_declared: 2 });
    expect(Number(byType.task.zero_declared_rate)).toBeCloseTo(2 / 3, 4);
    expect(byType.decision).toMatchObject({ records: 1, zero_declared: 1 });
  });

  test('a GUESSED inbound edge does NOT count as declared (the meter measures TRUST, not reachability)', async () => {
    // The specificity leg. If the meter counted any inbound edge, the weak inference
    // fallback would make the rate look healthy while the exact defect it exists to
    // measure — records with no DECLARED inbound — went on happening. This is the same
    // read-the-classifier failure that let a gate call `1 failed` a pass.
    const { projectId, conn } = await freshCase('q3-guessed');
    const task = await createTask(conn, 'a task reached only by a guess');
    const other = await createTask(conn, 'second create — session goes to trunk, nothing minted');

    // Mint a GUESSED edge by hand, stamped exactly as the inference fallback stamps its own.
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
       VALUES ($1, 'task', $2, 'task', 'related_to', $3, 'auto:inference', 'inference')`,
      [other.id, task.id, projectId]
    );

    const row = (
      await db.query(
        `SELECT declared_inbound, guessed_inbound FROM record_declared_inbound
          WHERE project_id = $1 AND record_id = $2`,
        [projectId, task.id]
      )
    ).rows[0];
    expect(row.guessed_inbound, 'the guess IS counted — separately').toBe(1);
    expect(row.declared_inbound, 'and it does NOT make the record look declared').toBe(0);
  });
});
