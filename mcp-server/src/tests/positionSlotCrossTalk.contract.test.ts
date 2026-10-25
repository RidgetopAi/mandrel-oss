/**
 * ONE TRANSPORT, MANY AGENTS — the an earlier task contract.
 *
 * THE INCIDENT THIS REPRODUCES (measured on prod 2026-08-26, four independent
 * confirmations in an earlier task's noteLog, plus a live re-measurement 2026-08-27).
 * Nine agents — Coordinator plus eight Builders — ran concurrently and their writes minted
 * DECLARED-tier `informs` membership edges onto EACH OTHER'S spines: a Builder working
 * `2b3c4d5e` became a member of `3c4d5e6f` on one call and `4d5e6f7a` on the next.
 *
 * WHY, measured rather than theorised (see the run report for the commands):
 *   - ALL of those agents live inside ONE `claude` process, which multiplexes them over
 *     THREE long-lived stdio bridge processes. There is no per-agent process.
 *   - Every one of those bridges declares the SAME `X-Connection-ID`, because the
 *     launcher exports `MANDREL_LOOP_ID` into the environment every descendant inherits.
 *   - Position was keyed on the connection id ALONE. So one `branch_positions` row was
 *     the position of nine agents at once, last-writer-wins: whoever claimed a task most
 *     recently decided which spine EVERYBODY ELSE's next write became a member of.
 *
 * THE INVARIANT THIS FILE ASSERTS: a branch position belongs to ONE AGENT LOOP. Two
 * agents that share a transport must not share a position, and — the part that matters
 * for the product — a write must mint its membership onto ITS OWN spine, never a
 * concurrent agent's. Every probe below asserts WHICH spine the edge points at; asserting
 * that "some edge exists" is exactly what let this ship (the intended explicit edge was
 * always present; the damage was ADDITIVE and invisible unless you read the target).
 *
 * SCOPE OF THIS GUARD, stated so nobody reads it as wider than it is (C3): it covers the
 * two discriminators that reach the server on a shared transport — the derived ACTOR, and
 * an explicitly declared LOOP ID. It does NOT and cannot cover two agents that present
 * BOTH the same connection id and the same actor and no loop id. For THEM the guarantee is
 * weaker but still sound: the slot refuses to hold either position, so neither write mints
 * a wrong DECLARED edge (PROBE 7). The positive form — each landing on its OWN spine —
 * is unreachable without a per-agent identity, and PROBE 8 executes that fact instead of
 * asserting it in prose.
 *
 * Driven through the FULL public path (validate → routeExecutor) against the disposable
 * migrated ci_* DB. Embeddings mocked to zeros (similarity plays no part in positions).
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

/** One call, as a named agent on a named transport. `loopId` is the new declared identity. */
async function viaTool(
  toolName: string,
  rawArgs: any,
  who: { conn: string; actor?: string; loopId?: string }
): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, {
    connectionId: who.conn,
    actor: who.actor,
    loopId: who.loopId,
  });
}

async function freshProject(label: string): Promise<string> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'position-slot-crosstalk fixture') RETURNING id`,
      [`pxt-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  return projectId;
}

async function freshTask(projectId: string, title: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, status) VALUES ($1, $2, 'feature', 'todo') RETURNING id`,
      [projectId, `${title}-${STAMP}`]
    )
  ).rows[0].id;
}

/**
 * WHICH SPINE does this record claim membership of? The DECLARED, trust-bearing edge only
 * — `informs` created by the positional layer. Returns every such target, so a probe can
 * assert both what it IS and what it is NOT, and so a second, foreign membership cannot
 * hide behind a correct first one.
 */
async function membershipTargets(recordId: string): Promise<string[]> {
  const rows = (
    await db.query(
      `SELECT to_id FROM links
        WHERE from_id = $1 AND created_by = 'auto:positional' AND edge_type = 'informs'
        ORDER BY created_at`,
      [recordId]
    )
  ).rows;
  return rows.map((r: any) => r.to_id);
}

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_memberships WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM analytics_events WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch {
      /* best-effort fixture teardown */
    }
  }
});

/**
 * THE PROD SHAPE, in the prod ORDER. Three agents on ONE transport each start work on
 * their own task and then write their own note — claims first, writes after, exactly the
 * interleave nine parallel Builders produce. `identify` turns each agent into whatever the
 * probe is testing (distinct actors, or distinct declared loop ids).
 */
async function threeAgentsOnOneTransport(
  conn: string,
  identify: (n: 1 | 2 | 3) => { conn: string; actor?: string; loopId?: string }
) {
  const projectId = await freshProject(conn);
  await viaTool('project_switch', { project: projectId }, identify(1));

  const tasks = {
    1: await freshTask(projectId, 'agent1-own-task'),
    2: await freshTask(projectId, 'agent2-own-task'),
    3: await freshTask(projectId, 'agent3-own-task'),
  } as const;

  // Every agent starts work on its OWN task (the byproduct open — task_claim /
  // task_update(in_progress) is how every Builder in the incident acquired its position).
  for (const n of [1, 2, 3] as const) {
    await viaTool('task_update', { taskId: tasks[n], status: 'in_progress' }, identify(n));
  }

  // Then every agent writes its own note, naming NO record ids — the write whose only
  // possible membership signal is where its author is standing.
  const contexts: Record<1 | 2 | 3, string> = {} as any;
  for (const n of [1, 2, 3] as const) {
    const resp = await viaTool(
      'context_store',
      { content: `agent ${n} progress note, naming no record ids whatsoever`, type: 'completion' },
      identify(n)
    );
    contexts[n] = resp.structuredContent.context.id;
  }

  return { projectId, tasks, contexts };
}

describe('one transport, many agents: a position belongs to ONE loop', () => {
  test('PROBE 1 — three DISTINCT ACTORS on one connection each thread to their OWN spine', async () => {
    const conn = `pxt-shared-actors-${STAMP}`;
    const { tasks, contexts } = await threeAgentsOnOneTransport(conn, (n) => ({
      conn,
      actor: `pxt-agent${n}-${STAMP}`,
    }));

    // The whole defect in three assertions: each note is a member of its OWN author's
    // task and of NOTHING ELSE. Before the fix all three read [tasks[3]].
    expect(await membershipTargets(contexts[1])).toEqual([tasks[1]]);
    expect(await membershipTargets(contexts[2])).toEqual([tasks[2]]);
    expect(await membershipTargets(contexts[3])).toEqual([tasks[3]]);
  });

  test('PROBE 2 — three DECLARED LOOP IDS under ONE actor on one connection each thread to their OWN spine', async () => {
    const conn = `pxt-shared-loops-${STAMP}`;
    const actor = `pxt-builder-${STAMP}`; // the prod case: eight Builders, ONE actor value
    const { tasks, contexts } = await threeAgentsOnOneTransport(conn, (n) => ({
      conn,
      actor,
      loopId: `pxt-loop-${n}-${STAMP}`,
    }));

    expect(await membershipTargets(contexts[1])).toEqual([tasks[1]]);
    expect(await membershipTargets(contexts[2])).toEqual([tasks[2]]);
    expect(await membershipTargets(contexts[3])).toEqual([tasks[3]]);
  });

  test('PROBE 3 — each agent SEES its own position, not a neighbour\'s, and closes only its own', async () => {
    const conn = `pxt-current-${STAMP}`;
    const who = (n: 1 | 2 | 3) => ({ conn, actor: `pxt-cur-agent${n}-${STAMP}` });
    const { tasks } = await threeAgentsOnOneTransport(conn, who);

    for (const n of [1, 2, 3] as const) {
      const cur = await viaTool('branch_current', {}, who(n));
      expect(cur.structuredContent.position?.spineId).toBe(tasks[n]);
    }

    // Agent 1 stepping off must not move agents 2 and 3.
    const closed = await viaTool('branch_close', {}, who(1));
    expect(closed.structuredContent.closedPosition?.spineId).toBe(tasks[1]);
    expect((await viaTool('branch_current', {}, who(2))).structuredContent.position?.spineId).toBe(tasks[2]);
    expect((await viaTool('branch_current', {}, who(3))).structuredContent.position?.spineId).toBe(tasks[3]);
  });

  test('PROBE 4 — a subagent does NOT inherit its COORDINATOR\'s DECLARED position', async () => {
    // THE FIFTH CONFIRMATION, and the most diagnostic (measured 2026-08-27, and measured
    // again by this task's own Builder on itself): Coordinator ran `branch_open 1a2b3c4d` in the
    // coordinating session at 01:31:27Z with origin='declared' and then dispatched eight
    // subagents. A subagent working an unrelated task reported BOTH of its writes minting a
    // position edge to 1a2b3c4d — "a branch position I never opened" — and `branch_current`
    // from inside a subagent returned the coordinator's spine verbatim.
    //
    // THIS IS A STRONGER CLAIM THAN THE PEER-TO-PEER CASE, and it is why it gets its own
    // probe. The earlier confirmations had peers trading BYPRODUCT positions; here a
    // DECLARED one — documented as the strongest statement of position the system has —
    // was readable by an agent that never opened it. A fix that isolated siblings but let a
    // child inherit its parent would pass every other probe in this file and still be
    // broken in the configuration we run every day.
    const projectId = await freshProject('parent-child');
    const conn = `pxt-parentchild-${STAMP}`; // ONE transport: the launcher's MANDREL_LOOP_ID
    const coordinator = { conn, actor: `pxt-coordinator-${STAMP}` };
    const subagent = { conn, actor: `pxt-builder-${STAMP}` };
    await viaTool('project_switch', { project: projectId }, coordinator);

    // The coordinator DECLARES its position, then dispatches.
    const spine = await freshTask(projectId, 'batch-spine');
    const opened = await viaTool('branch_open', { id: spine }, coordinator);
    expect(opened.structuredContent.position?.origin).toBe('declared');

    // The subagent, freshly spawned, having opened nothing at all, writes its own note.
    const resp = await viaTool(
      'context_store',
      { content: 'subagent run report for a task with no relationship to the batch spine', type: 'completion' },
      subagent
    );

    // It is a member of NOTHING — and specifically not of the coordinator's spine.
    expect(await membershipTargets(resp.structuredContent.context.id)).toEqual([]);
    // And it cannot even SEE the coordinator's position, which is how the incident was
    // noticed: `branch_current` from inside the subagent returned the parent's spine.
    const cur = await viaTool('branch_current', {}, subagent);
    expect(cur.structuredContent.position).toBeNull();

    // The coordinator keeps standing exactly where it declared it stood.
    const parentCur = await viaTool('branch_current', {}, coordinator);
    expect(parentCur.structuredContent.position?.spineId).toBe(spine);
    expect(parentCur.structuredContent.position?.origin).toBe('declared');
  });

  // ── THE CASE THE DEFECT WAS FILED ON: SAME ACTOR, SAME CONNECTION ─────────────────
  //
  // All four confirmations in an earlier task's noteLog are Builder↔Builder, and all eight
  // Builders share ONE bridge process with MANDREL_ACTOR=builder and one inherited
  // MANDREL_LOOP_ID (measured 2026-08-27). Actor scoping cannot separate them and neither
  // can anything else on the wire: the MCP frame carries only a per-CALL
  // `claudecode/toolUseId` and a client-global `progressToken`. So these three probes are
  // the population the guard would otherwise be missing — the one we actually run.

  test('PROBE 6 — same-actor peers that DECLARE loop ids each thread to their OWN spine', async () => {
    // The identity-bearing case: when the agents CAN say who they are, full isolation is
    // available and every write lands where its author stood. This is what an X-Loop-ID
    // buys, and it is the only arrangement in which the positive guarantee holds.
    const conn = `pxt-peers-loops-${STAMP}`;
    const actor = `pxt-peer-builder-${STAMP}`;
    const projectId = await freshProject('peers-loops');
    const who = (n: 1 | 2) => ({ conn, actor, loopId: `pxt-peer-loop-${n}-${STAMP}` });
    await viaTool('project_switch', { project: projectId }, who(1));

    const tasks = { 1: await freshTask(projectId, 'peer1'), 2: await freshTask(projectId, 'peer2') } as const;
    for (const n of [1, 2] as const) {
      await viaTool('task_update', { taskId: tasks[n], status: 'in_progress' }, who(n));
    }
    const ctx: Record<1 | 2, string> = {} as any;
    for (const n of [1, 2] as const) {
      const r = await viaTool(
        'context_store',
        { content: `peer ${n} note, naming nothing`, type: 'completion' },
        who(n)
      );
      ctx[n] = r.structuredContent.context.id;
    }
    expect(await membershipTargets(ctx[1])).toEqual([tasks[1]]);
    expect(await membershipTargets(ctx[2])).toEqual([tasks[2]]);
  });

  test('PROBE 7 — THE PRODUCTION CASE: two same-actor peers, no loop ids, and NEITHER write lands on the other\'s spine', async () => {
    // Batch 2, exactly: two agents indistinguishable on the wire, each starting work on its
    // own task, each then writing a note that names nothing. Before this fix the second
    // claim silently took the slot and BOTH notes minted a DECLARED `informs` onto that
    // second task — one of them correct by luck, the other confidently wrong.
    //
    // WHAT IS GUARANTEED HERE, AND IT IS NOT THE POSITIVE FORM: the slot cannot say which
    // agent it belongs to, so it holds NEITHER position and mints NOTHING. No edge is lost
    // that was ever correct — each agent's own explicit thread still mints, which is what
    // CONTROL A and CONTROL D exercise — and no edge is minted that is wrong. That is the
    // whole product claim: a missing edge is recoverable, a confidently wrong DECLARED edge
    // is not (the task's own words: "It is worse than no edge").
    const conn = `pxt-peers-prod-${STAMP}`;
    const actor = `pxt-prod-builder-${STAMP}`;
    const projectId = await freshProject('peers-prod');
    const who = { conn, actor }; // NO loop id — the deployed configuration
    await viaTool('project_switch', { project: projectId }, who);

    const t1 = await freshTask(projectId, 'prodpeer1');
    const t2 = await freshTask(projectId, 'prodpeer2');
    await viaTool('task_update', { taskId: t1, status: 'in_progress' }, who);
    const second = await viaTool('task_update', { taskId: t2, status: 'in_progress' }, who);

    // The caller is TOLD, at the moment it happens — a silently moved slot is the failure
    // this whole area exists to prevent, so "we did nothing quietly" is not acceptable either.
    const said = String(second.content?.[0]?.text ?? '');
    expect(said).toContain('TRUNK');
    expect(said).toContain(t1.substring(0, 8));

    const a = await viaTool('context_store', { content: 'peer A note, naming nothing', type: 'completion' }, who);
    const b = await viaTool('context_store', { content: 'peer B note, naming nothing', type: 'completion' }, who);
    const aId: string = a.structuredContent.context.id;
    const bId: string = b.structuredContent.context.id;

    // THE ASSERTION THAT MATTERS: no DECLARED membership onto ANY spine, and in particular
    // not onto the peer's. Asserted on WHICH spine, not on "an edge exists".
    expect(await membershipTargets(aId)).toEqual([]);
    expect(await membershipTargets(bId)).toEqual([]);
    // And the slot itself is honest about where it is.
    const cur = await viaTool('branch_current', {}, who);
    expect(cur.structuredContent.atTrunk).toBe(true);
  });

  test.fails('PROBE 8 — PINNED RESIDUAL: without a declared loop id the POSITIVE guarantee is unreachable', async () => {
    // THIS PROBE IS EXPECTED TO FAIL, AND IT IS EXECUTED SO THAT THE FAILURE IS A MEASURED
    // FACT RATHER THAN A SENTENCE. Two agents that share a connection id and an actor and
    // declare no loop id cannot each be given their OWN position, because nothing in the
    // request distinguishes them — measured on the wire 2026-08-27:
    //   _meta = {"claudecode/toolUseId": <unique per CALL>, "progressToken": <client-global>}
    // PROBE 7 is the guarantee we can make (no WRONG edge). This is the one we cannot (the
    // RIGHT edge), and `test.fails` means the day someone makes it reachable — a per-agent
    // loop id from the client, most likely — this probe turns RED and forces the record to
    // be updated instead of quietly going stale.
    const conn = `pxt-residual-${STAMP}`;
    const actor = `pxt-residual-builder-${STAMP}`;
    const projectId = await freshProject('residual');
    const who = { conn, actor };
    await viaTool('project_switch', { project: projectId }, who);

    const t1 = await freshTask(projectId, 'res1');
    const t2 = await freshTask(projectId, 'res2');
    await viaTool('task_update', { taskId: t1, status: 'in_progress' }, who);
    await viaTool('task_update', { taskId: t2, status: 'in_progress' }, who);
    const a = await viaTool('context_store', { content: 'residual peer A note', type: 'completion' }, who);
    const b = await viaTool('context_store', { content: 'residual peer B note', type: 'completion' }, who);

    expect(await membershipTargets(a.structuredContent.context.id)).toEqual([t1]);
    expect(await membershipTargets(b.structuredContent.context.id)).toEqual([t2]);
  });

  // ── CONTROLS: the fix must not buy isolation by minting nothing ────────────────────

  test('CONTROL A — a lone agent still becomes a member of the task it claimed', async () => {
    const projectId = await freshProject('solo');
    const who = { conn: `pxt-solo-${STAMP}`, actor: `pxt-solo-agent-${STAMP}` };
    await viaTool('project_switch', { project: projectId }, who);

    const taskId = await freshTask(projectId, 'solo-own-task');
    await viaTool('task_update', { taskId, status: 'in_progress' }, who);
    const resp = await viaTool(
      'context_store',
      { content: 'solo completion note for the claimed task', type: 'completion' },
      who
    );

    // Membership is MINTED, DECLARED, and points at the claimed task — the behaviour a
    // "fix" that simply stopped minting would silently destroy.
    expect(await membershipTargets(resp.structuredContent.context.id)).toEqual([taskId]);
  });

  test('CONTROL B — an UNPOSITIONED write still falls through to its documented behaviour', async () => {
    const projectId = await freshProject('unpositioned');
    const who = { conn: `pxt-unpos-${STAMP}`, actor: `pxt-unpos-agent-${STAMP}` };
    await viaTool('project_switch', { project: projectId }, who);

    // A neighbour on the SAME transport is standing somewhere; this agent is not.
    const neighbour = { conn: who.conn, actor: `pxt-unpos-neighbour-${STAMP}` };
    const neighbourTask = await freshTask(projectId, 'neighbour-task');
    await viaTool('task_update', { taskId: neighbourTask, status: 'in_progress' }, neighbour);

    const resp = await viaTool(
      'context_store',
      { content: 'a note from an agent standing nowhere at all', type: 'completion' },
      who
    );
    const ctxId: string = resp.structuredContent.context.id;

    // The DOCUMENTED fall-through for an unpositioned CONTEXT write, unchanged by this
    // fix: `isCreateWrite` excludes contexts, so R1 never auto-opens for one — the write is
    // a member of nothing and the author is still standing nowhere. What DID change is the
    // first assertion: before the fix this note inherited the neighbour's spine off the
    // shared slot and minted a DECLARED membership onto it.
    expect(await membershipTargets(ctxId)).toEqual([]);
    const cur = await viaTool('branch_current', {}, who);
    expect(cur.structuredContent.position).toBeNull();

    // And the neighbour is untouched — isolation cuts both ways.
    const neighbourCur = await viaTool('branch_current', {}, neighbour);
    expect(neighbourCur.structuredContent.position?.spineId).toBe(neighbourTask);
  });

  test('CONTROL D — the PRICE of the contention rule, executed rather than described', async () => {
    // A LONE agent that claims A and then claims B without closing lands at TRUNK, not on
    // B. config/positionContentionConfig.ts states this cost; this probe is what makes the
    // statement checkable, and what will notice if the rule is ever widened past it.
    //
    // And the way back is one deliberate act — which is the half that makes the price
    // acceptable, so it is exercised here too rather than asserted in prose.
    const projectId = await freshProject('price');
    const who = { conn: `pxt-price-${STAMP}`, actor: `pxt-price-agent-${STAMP}` };
    await viaTool('project_switch', { project: projectId }, who);

    const a = await freshTask(projectId, 'price-a');
    const b = await freshTask(projectId, 'price-b');
    await viaTool('task_update', { taskId: a, status: 'in_progress' }, who);
    await viaTool('task_update', { taskId: b, status: 'in_progress' }, who);
    expect((await viaTool('branch_current', {}, who)).structuredContent.atTrunk).toBe(true);

    // One declared act restores a real position, and membership mints from it again.
    await viaTool('branch_open', { id: b }, who);
    const note = await viaTool('context_store', { content: 'back on a declared branch', type: 'completion' }, who);
    expect(await membershipTargets(note.structuredContent.context.id)).toEqual([b]);
  });

  test('CONTROL C — a caller that declares no loop id keys exactly as it always did', async () => {
    const projectId = await freshProject('legacy-key');
    const conn = `pxt-legacy-${STAMP}`;
    const actor = `pxt-legacy-agent-${STAMP}`;
    await viaTool('project_switch', { project: projectId }, { conn, actor });

    const taskId = await freshTask(projectId, 'legacy-task');
    await viaTool('task_update', { taskId, status: 'in_progress' }, { conn, actor });

    // Same connection + same actor + no loop id on BOTH calls = the same agent, so the
    // position persists across calls exactly as before this change.
    const cur = await viaTool('branch_current', {}, { conn, actor });
    expect(cur.structuredContent.position?.spineId).toBe(taskId);
  });

});
