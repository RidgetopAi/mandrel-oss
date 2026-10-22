/**
 * POSITIONAL MEMBERSHIP — the PHASE 1 acceptance contract.
 * Driven through the FULL public path (validate → routeExecutor — the exact
 * path the HTTP bridge uses). Each numbered describe maps to the task's acceptance list:
 *
 *   1. INTEGRATION, per write type: branch open on a DECISION spine → context_store,
 *      task_create, decision_record EACH produce an edge row (created_by
 *      'auto:positional', edge_type informs) to the spine — asserted at the ROW level.
 *   2. INTERRUPT (the E2 scenario, an earlier task — re-aimed): positioned on A,
 *      branch_open B, write → edge to B only, ZERO new edges to A; pop back to A,
 *      write → edge to A only. This is the exact scripted interrupt→return trace E2 was
 *      designed to falsify the 24h anchor with; ground truth is free by construction.
 *   3. PARALLEL AGENTS: two connections, two branches, interleaved writes → zero
 *      cross-contamination edges.
 *   4. MULTI-NAME policy: a record naming 2 task ids → TRUNK (2 reference edges, NO
 *      membership); a positioned record naming 1 foreign id → membership + 1 weak ref.
 *      Matcher handles id8 AND uuid; an ambiguous id8 mints nothing (never first-match).
 *   6. (offer assertions for task_create / decision_record; context_store's offer is
 *      locked in noOrphanWrites.contract.test.ts case (d).)
 *   7. P0-METER integration: the freshly-minted positional edges classify DECLARED in the
 *      link_provenance view (migration 079) — read from the VIEW, the single source.
 *   b. BYPRODUCT position: task_claim and task_update(status:'in_progress') open the
 *      branch on that task.
 *   d. RE-AIMED by position NEVER mints `subtask_of` (a record-intrinsic
 *      structural claim needs declared intent); the explicit `parentTaskId` param on
 *      task_create is its only source.
 *
 * (Acceptance 5 — the D1 migration — lives in d1AnchorDemotion.contract.test.ts;
 *  acceptance 8 — the 9-record reachability check — runs against a prod-seeded
 *  disposable DB, outside vitest, with per-id results in the task report.)
 *
 * Embeddings mocked to zeros (similarity plays NO role in positional membership — that
 * is the point). DB target: the disposable migrated ci_* DB — never production.
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
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'P1 positional fixture') RETURNING id`,
      [`p1pos-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `p1pos-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** All edges from a record, at the ROW level (edge_type + created_by + target). */
async function edgeRows(fromId: string): Promise<Array<{ edgeType: string; createdBy: string | null; toId: string }>> {
  return (
    await db.query(
      `SELECT edge_type, created_by, to_id FROM links WHERE from_id = $1 ORDER BY edge_type, to_id`,
      [fromId]
    )
  ).rows.map((r) => ({ edgeType: r.edge_type, createdBy: r.created_by, toId: r.to_id }));
}
/** Edges from a record to ONE target. */
async function edgesTo(fromId: string, toId: string) {
  return (await edgeRows(fromId)).filter((e) => e.toId === toId);
}

async function makeTask(conn: string, title: string): Promise<string> {
  const r = await viaTool('task_create', { title, type: 'feature' }, conn);
  return r.structuredContent.task.id;
}
async function makeDecision(conn: string, title: string): Promise<string> {
  const r = await viaTool(
    'decision_record',
    { decisionType: 'architecture', title, description: 'd', rationale: 'r', impactLevel: 'medium' },
    conn
  );
  return r.structuredContent.decision.id;
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

// ── ACCEPTANCE 1: all three write paths stamp the declared edge to a DECISION spine ──────
describe('acceptance 1 — every write path stamps auto:positional informs to a DECISION spine', () => {
  test('context_store + task_create + decision_record each mint the membership row', async () => {
    const { conn } = await freshCase('acc1');
    const spineDec = await makeDecision(conn, 'the governing decision (spine)');
    await viaTool('branch_open', { id: id8(spineDec) }, conn);

    const ctx = (await viaTool('context_store', { content: 'a capture on the decision branch', type: 'discussion' }, conn))
      .structuredContent.context.id;
    const task = (await viaTool('task_create', { title: 'a task born on the decision branch', type: 'feature' }, conn))
      .structuredContent.task.id;
    const dec = (await viaTool(
      'decision_record',
      { decisionType: 'architecture', title: 'a follow-up decision on the branch', description: 'd', rationale: 'r', impactLevel: 'low' },
      conn
    )).structuredContent.decision.id;

    // THE ROWS (acceptance 1's own words: "assert the rows").
    for (const [label, recordId] of [['context', ctx], ['task', task], ['decision', dec]] as const) {
      expect(await edgesTo(recordId, spineDec), `${label} → spine membership row`).toEqual([
        { edgeType: 'informs', createdBy: 'auto:positional', toId: spineDec },
      ]);
    }
  });
});

// ── ACCEPTANCE 2: the E2 interrupt→return trace (re-aimed from an earlier task) ────────────
describe('acceptance 2 — interrupt-and-return: writes follow the POSITION, never the history', () => {
  test('positioned on A → open B, write (B only) → pop back to A, write (A only)', async () => {
    const { conn } = await freshCase('acc2');
    const taskA = await makeTask(conn, 'task A (the original work)');
    const taskB = await makeTask(conn, 'task B (the interrupt)');

    // Work A.
    await viaTool('branch_open', { id: id8(taskA) }, conn);
    const w1 = (await viaTool('context_store', { content: 'working A, step 1', type: 'discussion' }, conn))
      .structuredContent.context.id;
    expect(await edgesTo(w1, taskA)).toHaveLength(1);

    // THE INTERRUPT: open B mid-session, write. The 24h anchor mis-attributed exactly this
    // write to A (E2's prediction); position must give it to B ONLY.
    await viaTool('branch_open', { id: id8(taskB) }, conn);
    const w2 = (await viaTool('context_store', { content: 'handling the interrupt on B', type: 'error' }, conn))
      .structuredContent.context.id;
    expect(await edgesTo(w2, taskB)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: taskB },
    ]);
    expect(await edgesTo(w2, taskA), 'ZERO new edges to A from the interrupt write').toEqual([]);

    // THE RETURN: pop back to A, write → edge to A only.
    await viaTool('branch_open', { id: id8(taskA) }, conn);
    const w3 = (await viaTool('context_store', { content: 'back on A, resuming', type: 'discussion' }, conn))
      .structuredContent.context.id;
    expect(await edgesTo(w3, taskA)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: taskA },
    ]);
    expect(await edgesTo(w3, taskB), 'ZERO edges to B after the return').toEqual([]);

    // A WRONG STRONG EDGE is an automatic fail regardless of recall (E2's grading rule):
    // sweep every write's full row set for a strong edge to the wrong task.
    for (const [w, wrong] of [[w1, taskB], [w2, taskA], [w3, taskB]] as const) {
      const strongToWrong = (await edgesTo(w, wrong)).filter((e) => e.edgeType === 'informs');
      expect(strongToWrong).toEqual([]);
    }
  });
});

// ── ACCEPTANCE 3: two parallel sessions, zero cross-contamination ────────────────────────
describe('acceptance 3 — parallel agents: per-session positions never bleed', () => {
  test('two connections on two branches, interleaved writes → each edge lands on its own branch', async () => {
    const { conn: connX } = await freshCase('acc3');
    // SECOND agent: same project, DIFFERENT connection (its own session slot).
    const connY = `p1pos-conn-acc3-second-${STAMP}`;
    await routeExecutor('project_switch', { project: projectIds[projectIds.length - 1] }, { connectionId: connY });

    const taskX = await makeTask(connX, 'agent X branch');
    const taskY = await makeTask(connX, 'agent Y branch');
    await viaTool('branch_open', { id: id8(taskX) }, connX);
    await viaTool('branch_open', { id: id8(taskY) }, connY);

    // Interleave writes X, Y, X, Y.
    const x1 = (await viaTool('context_store', { content: 'X write 1', type: 'discussion' }, connX)).structuredContent.context.id;
    const y1 = (await viaTool('context_store', { content: 'Y write 1', type: 'discussion' }, connY)).structuredContent.context.id;
    const x2 = (await viaTool('context_store', { content: 'X write 2', type: 'discussion' }, connX)).structuredContent.context.id;
    const y2 = (await viaTool('context_store', { content: 'Y write 2', type: 'discussion' }, connY)).structuredContent.context.id;

    for (const [w, own, other] of [
      [x1, taskX, taskY], [x2, taskX, taskY],
      [y1, taskY, taskX], [y2, taskY, taskX],
    ] as const) {
      expect(await edgesTo(w, own)).toEqual([{ edgeType: 'informs', createdBy: 'auto:positional', toId: own }]);
      expect(await edgesTo(w, other), 'zero cross-contamination').toEqual([]);
    }
  });
});

// ── ACCEPTANCE 4: the multi-name policy ──────────────────────────────────────────────────
describe('acceptance 4 — multi-name: naming ≠ membership; standing there = membership', () => {
  // AMENDED BY THE SK1 PRECEDENCE GATE. This case originally asserted "NO
  // membership — not even to the branch we are standing on", and it was written from a
  // DELIBERATELY opened position. That is exactly the demotion the gate reverses: R0 in
  // positionalMint.ts states "explicit intent outranks every byproduct", and a branch_open
  // is the strongest statement of position the system has, so it must not lose to a
  // heuristic read out of the record's own prose. The multi-name REFERENCE behaviour — a
  // trunk-ref to EACH named task, in both id8 and full-uuid form — is unchanged and is still
  // asserted below; only the demotion moved. The unprotected origins keep the old behaviour,
  // which is asserted directly in sk1DeterministicMembership.contract.test.ts (a3).
  test('a record naming 2 task ids (id8 + uuid forms) → a ref to EACH; membership survives a DECLARED position', async () => {
    const { conn } = await freshCase('acc4-trunk');
    const spine = await makeTask(conn, 'the branch spine');
    const named1 = await makeTask(conn, 'named task one');
    const named2 = await makeTask(conn, 'named task two');
    await viaTool('branch_open', { id: id8(spine) }, conn);

    // One named by id8, one by full uuid — both forms must match.
    const resp = await viaTool('context_store', {
      content: `Batch summary touching ${id8(named1)} and ${named2} in one pass`,
      type: 'completion',
    }, conn);
    const ctxId = resp.structuredContent.context.id;

    // The multi-name FACT is still detected; the DEMOTION is what the declared position beats.
    expect(resp.structuredContent.context.positional.multiName).toBe(true);
    expect(resp.structuredContent.context.positional.trunk).toBe(false);
    // Reference edge to EACH named task (declared class via created_by, weak type) — unchanged.
    expect(await edgesTo(ctxId, named1)).toEqual([{ edgeType: 'related_to', createdBy: 'auto:positional', toId: named1 }]);
    expect(await edgesTo(ctxId, named2)).toEqual([{ edgeType: 'related_to', createdBy: 'auto:positional', toId: named2 }]);
    // AND the membership to the branch the writer explicitly opened is kept, not discarded.
    expect(await edgesTo(ctxId, spine)).toEqual([{ edgeType: 'informs', createdBy: 'auto:positional', toId: spine }]);
  });

  test('an UNPOSITIONED record naming 2 task ids is still TRUNK material: 2 refs, no membership', async () => {
    // The half of the original assertion that the gate does NOT touch, kept as its own case
    // so "naming >=2 tasks demotes you" still has a guard when no deliberate stance exists.
    const { projectId } = await freshCase('acc4-trunk-unpositioned');
    const setup = `p1pos-conn-acc4-setup-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: setup });
    const named1 = await makeTask(setup, 'named task one');
    const named2 = await makeTask(setup, 'named task two');

    const virgin = `p1pos-conn-acc4-virgin-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: virgin });
    const resp = await viaTool('context_store', {
      content: `Batch summary touching ${id8(named1)} and ${named2} in one pass`,
      type: 'completion',
    }, virgin);
    const ctxId = resp.structuredContent.context.id;

    expect(resp.structuredContent.context.positional.trunk).toBe(true);
    expect(await edgesTo(ctxId, named1)).toEqual([{ edgeType: 'related_to', createdBy: 'auto:positional', toId: named1 }]);
    expect(await edgesTo(ctxId, named2)).toEqual([{ edgeType: 'related_to', createdBy: 'auto:positional', toId: named2 }]);
  });

  test('a positioned record naming 1 foreign id → membership to position + ONE weak ref to the named', async () => {
    const { conn } = await freshCase('acc4-single');
    const spine = await makeTask(conn, 'the branch spine');
    const named = await makeTask(conn, 'the mentioned task');
    await viaTool('branch_open', { id: id8(spine) }, conn);

    const resp = await viaTool('context_store', {
      content: `Progress note that mentions ${id8(named)} in passing`,
      type: 'discussion',
    }, conn);
    const ctxId = resp.structuredContent.context.id;

    expect(resp.structuredContent.context.positional.trunk).toBe(false);
    expect(await edgesTo(ctxId, spine)).toEqual([{ edgeType: 'informs', createdBy: 'auto:positional', toId: spine }]);
    expect(await edgesTo(ctxId, named)).toEqual([{ edgeType: 'related_to', createdBy: 'auto:positional', toId: named }]);
  });

  test('an AMBIGUOUS id8 mints nothing and is surfaced (never first-match — the E3 caveat)', async () => {
    const { projectId, conn } = await freshCase('acc4-ambig');
    const spine = await makeTask(conn, 'the branch spine');
    await viaTool('branch_open', { id: id8(spine) }, conn);

    // Forge two tasks sharing an 8-hex id prefix so the id8 is genuinely ambiguous.
    const prefix = 'abcd1234';
    for (const suffix of ['-0000-4000-8000-000000000001', '-0000-4000-8000-000000000002']) {
      await db.query(
        `INSERT INTO tasks (id, project_id, title, type, priority, status)
         VALUES ($1::uuid, $2, 'ambiguous twin', 'general', 'medium', 'todo')`,
        [`${prefix}${suffix}`, projectId]
      );
    }

    const resp = await viaTool('context_store', {
      content: `This note references ${prefix} which two tasks share`,
      type: 'discussion',
    }, conn);
    const ctxId = resp.structuredContent.context.id;

    // No reference edge to EITHER twin — refusing to pick is the whole point.
    for (const suffix of ['-0000-4000-8000-000000000001', '-0000-4000-8000-000000000002']) {
      expect(await edgesTo(ctxId, `${prefix}${suffix}`)).toEqual([]);
    }
    const warnings: string[] = resp.structuredContent.context.positional.warnings;
    expect(warnings.some((w) => w.includes(prefix) && w.includes('AMBIGUOUS'))).toBe(true);
    // Still a member of its position (the ambiguity is about the REF, not the membership).
    expect(await edgesTo(ctxId, spine)).toHaveLength(1);
  });
});

// ── ACCEPTANCE 6, SUPERSEDED BY R1 ────────────────────
// P1's acceptance 6 asserted that an unpositioned task_create / decision_record OFFERS
// `branch_open <id8>`. R1 DELETES that offer on creates and auto-opens the position
// instead — measured cause: the offer assumed a reader, and the first customer-shaped
// session (rivet, a small model) never read one, so both its create-records ended with
// zero inbound edges. The case is REWRITTEN here rather than deleted, so the replacement is
// asserted at the same place the old contract was.
// The offer itself is NOT gone — it still fires for an unpositioned CAPTURE, which is
// asserted below and in noOrphanWrites.contract.test.ts case (d).
describe('acceptance 6 (R1) — an unpositioned CREATE auto-opens instead of offering', () => {
  test('task_create and decision_record with no branch open each OPEN a position on themselves', async () => {
    const { conn } = await freshCase('acc6');

    const taskResp = await viaTool('task_create', { title: 'an unpositioned task', type: 'feature' }, conn);
    const taskId = taskResp.structuredContent.task.id;
    const taskPos = taskResp.structuredContent.task.positional;
    expect(taskPos.autoOpened).toBe(true);
    expect(taskPos.offer).toBeNull();
    expect(taskPos.position).toMatchObject({ spineId: taskId, spineType: 'task', origin: 'auto' });
    // Said VISIBLY in the text channel — R1's second half.
    expect(responseText(taskResp)).toContain(`Branch OPENED on this record (${id8(taskId)})`);
    // And it minted nothing: a spine does not link to itself.
    expect(taskPos.edges).toEqual([]);

    // A DECISION-first session opens on the decision (the spine may be any type).
    const { conn: conn2 } = await freshCase('acc6-dec');
    const decResp = await viaTool(
      'decision_record',
      { decisionType: 'architecture', title: 'an unpositioned decision', description: 'd', rationale: 'r', impactLevel: 'low' },
      conn2
    );
    const decId = decResp.structuredContent.decision.id;
    const decPos = decResp.structuredContent.decision.positional;
    expect(decPos.autoOpened).toBe(true);
    expect(decPos.offer).toBeNull();
    expect(decPos.position).toMatchObject({ spineId: decId, spineType: 'decision', origin: 'auto' });
    expect(responseText(decResp)).toContain(`Branch OPENED on this record (${id8(decId)})`);
  });

  test('an unpositioned CAPTURE still offers its OWN id8 (the offer is unchanged for captures)', async () => {
    const { conn } = await freshCase('acc6-capture');
    const resp = await viaTool('context_store', { content: 'a capture with nothing open', type: 'discussion' }, conn);
    const ctxId = resp.structuredContent.context.id;
    expect(resp.structuredContent.context.positional.offer).toBe(`branch_open ${id8(ctxId)}`);
    expect(resp.structuredContent.context.positional.autoOpened).toBe(false);
    expect(responseText(resp)).toContain(`branch_open ${id8(ctxId)}`);
  });
});

// ── ACCEPTANCE 7: the P0 meter classifies these edges DECLARED ───────────────────────────
describe('acceptance 7 — auto:positional lands in the DECLARED bucket of the 079 meter view', () => {
  test('a freshly-minted membership edge classifies declared in link_provenance', async () => {
    const { conn } = await freshCase('acc7');
    const spine = await makeTask(conn, 'meter spine');
    await viaTool('branch_open', { id: id8(spine) }, conn);
    const ctxId = (await viaTool('context_store', { content: 'a metered capture', type: 'discussion' }, conn))
      .structuredContent.context.id;

    // Read the CLASSIFICATION from the view itself — the single source (079).
    const row = await db.query(
      `SELECT created_by, provenance_class FROM link_provenance WHERE from_id = $1 AND to_id = $2`,
      [ctxId, spine]
    );
    expect(row.rows).toEqual([{ created_by: 'auto:positional', provenance_class: 'declared' }]);
  });
});

// ── SPEC ITEM b: byproduct position setting on work-start ────────────────────────────────
describe('spec item b — task_claim / task_update(in_progress) open the branch as a byproduct', () => {
  test('task_claim moves the position onto the claimed task', async () => {
    const { conn } = await freshCase('b-claim');
    const task = await makeTask(conn, 'claimable work');

    // The claim feature defaults dark (MANDREL_TASK_CLAIM_ENABLED=false); flip the live
    // config for this case exactly as taskAtomicClaimStress.contract.test.ts does.
    TASK_CLAIM_CONFIG.enabled = true;
    const claim = await viaTool('task_claim', { taskId: id8(task) }, conn);
    expect(claim.structuredContent.claimed).toBe(true);
    expect(claim.structuredContent.position).toEqual({ spineId: task, spineType: 'task' });

    const cur = await viaTool('branch_current', {}, conn);
    expect(cur.structuredContent.position.spineId).toBe(task);

    // And a subsequent write is a member of it.
    const ctxId = (await viaTool('context_store', { content: 'first note after the claim', type: 'discussion' }, conn))
      .structuredContent.context.id;
    expect(await edgesTo(ctxId, task)).toEqual([{ edgeType: 'informs', createdBy: 'auto:positional', toId: task }]);
    TASK_CLAIM_CONFIG.enabled = false;
  });

  test('task_update to in_progress moves the position; other statuses do NOT', async () => {
    const { conn } = await freshCase('b-update');
    const task = await makeTask(conn, 'update-started work');
    const other = await makeTask(conn, 'an unrelated task');

    // A non-in_progress update must NOT move position.
    await viaTool('task_update', { taskId: id8(other), priority: 'high' }, conn);
    let cur = await viaTool('branch_current', {}, conn);
    expect(cur.structuredContent.position).toBeNull();

    const upd = await viaTool('task_update', { taskId: id8(task), status: 'in_progress' }, conn);
    expect(upd.structuredContent.position).toEqual({ spineId: task, spineType: 'task' });
    cur = await viaTool('branch_current', {}, conn);
    expect(cur.structuredContent.position.spineId).toBe(task);
  });
});

// ── SPEC ITEM d (re-aimed): subtask_of is DECLARED-ONLY ───────────────────
describe('spec item d — subtask_of mints from parentTaskId, and NEVER from position', () => {
  test('parentTaskId mints exactly ONE subtask_of to the named parent (no position open)', async () => {
    const { conn } = await freshCase('d-parent-param');
    const parent = await makeTask(conn, 'EPIC: the declared parent');
    // Creating `parent` may have R1-auto-opened a position on it — step off so this case
    // proves the param alone, with NO position in play.
    await viaTool('branch_close', {}, conn);

    const sub = (await viaTool(
      'task_create',
      { title: 'a subtask declared via parentTaskId', type: 'feature', parentTaskId: id8(parent) },
      conn
    )).structuredContent.task.id;

    // Exactly one subtask_of, to the named parent, with the declared-bucket stamp — and
    // NOTHING ELSE from this task to the parent (no positional membership: no branch open).
    expect(await edgesTo(sub, parent)).toEqual([
      { edgeType: 'subtask_of', createdBy: 'links:task_parent', toId: parent },
    ]);
    // And exactly one subtask_of edge from the subtask in total.
    const subtaskEdges = (await edgeRows(sub)).filter((e) => e.edgeType === 'subtask_of');
    expect(subtaskEdges).toHaveLength(1);
  });

  test('a positioned session creating a task mints membership but NEVER subtask_of', async () => {
    const { conn } = await freshCase('d-position-never');
    const epic = await makeTask(conn, 'EPIC: the parent branch');
    await viaTool('branch_open', { id: id8(epic) }, conn);

    const sub = (await viaTool('task_create', { title: 'a subtask born on the epic', type: 'feature' }, conn))
      .structuredContent.task.id;

    // Membership yes — standing there is a session-scoped claim `informs` can carry.
    // Structural parenthood no — position cannot support a record-intrinsic claim.
    expect(await edgesTo(sub, epic)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: epic },
    ]);
    expect((await edgeRows(sub)).filter((e) => e.edgeType === 'subtask_of')).toHaveLength(0);
  });

  test('explicit parentTaskId beats position: informs to the spine, subtask_of ONLY to the named parent', async () => {
    const { conn } = await freshCase('d-param-beats-position');
    const spine = await makeTask(conn, 'the branch being worked');
    const parent = await makeTask(conn, 'the DECLARED parent (a different task)');
    await viaTool('branch_open', { id: id8(spine) }, conn);

    const sub = (await viaTool(
      'task_create',
      { title: 'positioned create with a declared parent', type: 'feature', parentTaskId: id8(parent) },
      conn
    )).structuredContent.task.id;

    expect(await edgesTo(sub, spine)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional', toId: spine },
    ]);
    expect(await edgesTo(sub, parent)).toEqual([
      { edgeType: 'subtask_of', createdBy: 'links:task_parent', toId: parent },
    ]);
  });
});
