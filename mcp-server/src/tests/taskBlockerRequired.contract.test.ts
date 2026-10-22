/**
 * "A BLOCK WITH NO NAMED BLOCKER IS NOT A BLOCK" Contract Test
 * (gap 2.)
 *
 * ═══ THE DEFECT ═══
 * MEASURED on prod 2026-09-05: all 13 tasks with `status='blocked'` carried `blocked_on:
 * null`; after the re-triage 6 remained, still all null. The field is documented, first-class
 * on `task_create` and `task_update`, and `project_briefing` selects on it with a live WHERE
 * clause. Zero rows had ever been written. "Is this blocker still valid?" was unanswerable
 * from structured data — which is how 25 tasks (16% of the open backlog) sat behind a freeze
 * that had expired 9 days earlier, and how 7 of those sat blocked on nothing at all.
 *
 * ═══ THE FIRST DESCRIBE BLOCK IS A REFUTATION, AND IT IS THE POINT OF THIS FILE ═══
 * The task record asked, correctly, whether this was a FALSE-GREEN SURFACE rather than merely
 * a data gap: if `blocked_on` is null on every row and the briefing selects on it, then the
 * "Waiting on a human" section may have been rendering EMPTY this whole time while looking
 * like a working feature — and an empty section that reads as "nothing is waiting" is worse
 * than a missing one.
 *
 * IT WAS TESTED AND IT IS FALSE, and these are the executed assertions rather than a
 * paragraph claiming so. With `blocked_on` null on every blocked task, the section does NOT
 * render an empty "nothing is waiting": it returns `source: 'fallback-unpopulated'`, serves
 * the labelled interim fallback, and reports that no task carries a value so the question has
 * never been answered. services/waitingOnHuman.ts separates "a real zero" from "nobody has
 * populated the column" with a deliberate second COUNT for exactly this reason.
 *
 * So the READ side was already honest. The defect is entirely on the WRITE side — an exact
 * selector that nothing ever feeds — and that is what the rest of this file locks shut.
 *
 * ═══ ROUND 2: THE RULE IS "A NAMED BLOCKER", NOT "A `blocked_on`" ═══
 * The first cut of this rule required `blocked_on` specifically. Coordinator's fleet measurement
 * killed it, and the reason is now the most important thing this file
 * tests: the enum is `['human','agent','external']` and THERE IS NO VALUE MEANING "waiting on
 * another task". Requiring it would force an author whose honest answer is "task X must land
 * first" to pick a wrong party — and `project_briefing` selects `blocked_on='human'`, so the
 * forced value manufactures FALSE ENTRIES in the surface a human reads first. A wrong value is
 * worse than a null: a null is visibly missing, a wrong value is silently believed.
 *
 * Two channels now satisfy the rule — `blocked_on` (a PARTY) or `dependencies` (a TASK) — and
 * the second had to be made writable at all: it was WRITE-ONCE AT CREATE, which is why it is
 * empty on every row fleet-wide. The tests below cover both channels, the interaction between
 * them, and the erasure of each.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { gatherWaitingOnHuman } from '../services/waitingOnHuman.js';
import { BLOCKED_ON_HUMAN } from '../config/blockedOnConfig.js';

const STAMP = Date.now();
let projectId: string;
const OPEN_STATUSES = ['todo', 'in_progress', 'blocked'];

async function callTool(toolName: string, rawArgs: any): Promise<any> {
  return routeExecutor(toolName, validateToolArguments(toolName, rawArgs));
}

/** Call the tool and REQUIRE it to have succeeded. */
async function mustSucceed(toolName: string, rawArgs: any): Promise<any> {
  const res = await callTool(toolName, rawArgs);
  if (res?.isError) {
    throw new Error(`${toolName} unexpectedly FAILED: ${res.content?.[0]?.text}`);
  }
  return res;
}

/** Call the tool and REQUIRE it to have been refused; returns the message. */
async function mustRefuse(toolName: string, rawArgs: any): Promise<string> {
  let text: string;
  try {
    const res = await callTool(toolName, rawArgs);
    if (!res?.isError) {
      throw new Error(`${toolName} was ACCEPTED but should have been refused`);
    }
    text = res.content?.[0]?.text ?? '';
  } catch (e) {
    // Some paths surface as a thrown error rather than an isError envelope; both are a
    // refusal, and which one it is must not be what this assertion turns on.
    if ((e as Error).message.includes('should have been refused')) throw e;
    text = (e as Error).message;
  }
  return text;
}

// PUNCH-COMPLETE METADATA (an earlier task clause 10): both 'todo' and 'blocked' backfill to
// stage='ready' on a bare INSERT (tasks_sync_stage_status trigger). The completeness gate
// now keys on the MERGED row's stage, so a fixture that landed at 'ready' with no punch
// fields would have any subsequent title/metadata/dependencies-touching task_update
// correctly refused — a gate concern this file's blocker-required tests are not
// exercising. Seeding a well-formed punch here (rather than pinning `stage`) keeps
// `status` free for callers to set to 'blocked' without the trigger's "stage supplied
// wins" rule clobbering it back to 'todo'.
const FIXTURE_PUNCH = JSON.stringify({
  punch: { doneWhen: [{ text: 'fixture', owner: 'human' }], proofKind: 'look' },
});

async function seedTask(status: string, blockedOn: string | null = null): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, blocked_on, metadata)
     VALUES ($1, 'blocker-required fixture', 'general', 'medium', $2, $3, $4::jsonb) RETURNING id`,
    [projectId, status, blockedOn, FIXTURE_PUNCH]);
  return r.rows[0].id;
}

async function readBlockedOn(id: string): Promise<string | null> {
  const r = await db.query(`SELECT blocked_on FROM tasks WHERE id = $1`, [id]);
  return r.rows[0].blocked_on;
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1,'blocker required') RETURNING id`,
    [`blocker-required-${STAMP}`]);
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('gap 2 — REFUTING the false-green hypothesis: the briefing section is HONEST', () => {
  test('with blocked_on NULL on every blocked task (prod shape), the section does NOT claim "nothing is waiting"', async () => {
    // Reproduce prod exactly: blocked tasks, no blocker recorded on any of them.
    await seedTask('blocked');
    await seedTask('blocked');
    const w = await gatherWaitingOnHuman(projectId, OPEN_STATUSES, db);

    // THE ASSERTION THAT KILLS THE HYPOTHESIS. A false-green surface would be
    // `source: 'column-empty'` with zero items — "the column says nothing is waiting". What
    // it actually reports is that NOBODY HAS ANSWERED the question, which is a different
    // sentence and sends the reader to a different remedy.
    expect(w.source).toBe('fallback-unpopulated');
    expect(w.source).not.toBe('column-empty');
    // It serves the labelled interim fallback rather than rendering an empty section...
    expect(w.items.length).toBeGreaterThan(0);
    // ...and it states the fallback's precision measured on THESE rows, so the reader is told
    // how much to trust what they are looking at.
    expect(w.precision).not.toBeNull();
    expect(w.precision!.trulyHuman).toBe(0);
    expect(w.precision!.fallbackPopulation).toBeGreaterThan(0);
  });

  test('the WHERE clause is LIVE: seed one blocked_on=human row and the section selects exactly it', async () => {
    const seeded = await seedTask('blocked', BLOCKED_ON_HUMAN);
    const w = await gatherWaitingOnHuman(projectId, OPEN_STATUSES, db);
    // The source FLIPS to the exact selector, and the seeded row is the one returned. This is
    // the assertion the task record asked for by name — an empty section that renders because
    // nothing populates the field would fail it, and so would a dead WHERE clause.
    expect(w.source).toBe('column');
    expect(w.items.map((i) => i.id)).toContain(seeded);
    // And the OTHER blocked rows, which name no blocker, are NOT swept in. `status='blocked'`
    // and `blocked_on='human'` are different questions — measured at ~8% precision on our own
    // data — and the column path must not silently widen back to the fallback's population.
    expect(w.items.every((i) => i.blockedOn === BLOCKED_ON_HUMAN)).toBe(true);
    await db.query(`DELETE FROM tasks WHERE id = $1`, [seeded]);
  });
});

describe('gap 2 — the WRITE path now FAILS CLOSED', () => {
  test('task_create with status=blocked and NEITHER channel is REFUSED, and nothing is written', async () => {
    const before = await db.query(
      `SELECT count(*)::int n FROM tasks WHERE project_id = $1`, [projectId]);
    const msg = await mustRefuse('task_create', {
      projectId, title: 'a block with no named blocker', status: 'blocked' });
    // The message must offer BOTH channels and must STEER AWAY from blockedOn for the
    // task case — a rule that is satisfiable only by the poisoning answer is the defect.
    expect(msg).toMatch(/dependencies/);
    expect(msg).toMatch(/blockedOn/);
    expect(msg).toMatch(/DO NOT REACH FOR/);
    // NOTHING WAS WRITTEN — the gate runs before the INSERT, not after. A refusal that still
    // left a row behind would be the worst of both.
    const after = await db.query(
      `SELECT count(*)::int n FROM tasks WHERE project_id = $1`, [projectId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('task_create with status=blocked AND a blockedOn is ACCEPTED and stores it', async () => {
    // The unmutated control for the refusal above: if this also failed, the refusal would
    // prove nothing except that the path is broken.
    const res = await mustSucceed('task_create', {
      projectId, title: 'a properly named block', status: 'blocked', blockedOn: 'human' });
    const id = res.structuredContent?.task?.id ?? res.structuredContent?.id;
    expect(await readBlockedOn(id)).toBe('human');
  });

  test('task_update moving to blocked with NO blockedOn is REFUSED', async () => {
    const id = await seedTask('todo');
    const msg = await mustRefuse('task_update', { projectId, taskId: id, status: 'blocked' });
    expect(msg).toMatch(/dependencies/);
    // The status did NOT move. A gate that refused the field but let the status through would
    // produce exactly the state it exists to prevent.
    const r = await db.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].status).toBe('todo');
  });

  test('a task that ALREADY names a blocker can be re-saved to blocked without re-justifying', async () => {
    // Re-demanding the justification on every save would make the rule unusable, and would
    // break `task_update(priority)` on any blocked task.
    const id = await seedTask('blocked', 'agent');
    await mustSucceed('task_update', { projectId, taskId: id, status: 'blocked' });
    await mustSucceed('task_update', { projectId, taskId: id, priority: 'high' });
    expect(await readBlockedOn(id)).toBe('agent');
  });

  test('a status-less edit of a blocked task with NO blocker is still allowed', async () => {
    // The gate keys on MOVING TO blocked, not on BEING blocked. The 6 legacy prod rows must
    // stay editable — a rule that bricks existing data is not a fix.
    const id = await seedTask('blocked');
    await mustSucceed('task_update', { projectId, taskId: id, priority: 'low' });
  });
});

describe('gap 2 — the ABSENT direction: "no blocker" must not read as "blocker not recorded"', () => {
  test('an EXPLICIT blockedOn:null while moving to blocked is REFUSED, not treated as an answer', async () => {
    // This is the assertion the gap was really about. Mentioning the field is not naming a
    // blocker; clearing it while moving to blocked is precisely the state being made
    // unreachable. A gate written as `blockedOn !== undefined` passes this and is wrong.
    const id = await seedTask('todo');
    const msg = await mustRefuse('task_update', {
      projectId, taskId: id, status: 'blocked', blockedOn: null });
    expect(msg).toMatch(/dependencies/);
    const r = await db.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].status).toBe('todo');
  });

  test('DOOR (b): clearing the blocker while RE-ASSERTING blocked is refused', async () => {
    const id = await seedTask('blocked', 'human');
    await mustRefuse('task_update', {
      projectId, taskId: id, status: 'blocked', blockedOn: null });
    expect(await readBlockedOn(id)).toBe('human');
  });

  test('DOOR (c): clearing the blocker with NO `status` KEY AT ALL on an already-blocked row', async () => {
    // ⚠️ THE `status` KEY IS DELIBERATELY ABSENT, and that absence IS the test.
    //
    // This assertion exists because Reviewer proved the previous one hollow: deleting the
    // `!clearing` term from the gate left the suite GREEN 14/14, because the test named for
    // this door passed `status:'blocked'` explicitly — which makes `movingToBlocked` true and
    // re-exercises door (b). Driven end-to-end under that mutation, a task_update with no
    // status key and `blockedOn: null` returned accepted=true and left the row
    // {status:'blocked', blocked_on:null} — the forbidden state, through the one door nothing
    // was watching. A one-token guard on a customer-visible breaking rule had nothing holding
    // it. If you are tempted to add `status` here to make the intent clearer, you have just
    // deleted this test.
    const id = await seedTask('blocked', 'human');
    await mustRefuse('task_update', { projectId, taskId: id, blockedOn: null });
    const r = await db.query(`SELECT status, blocked_on FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].status).toBe('blocked');
    expect(r.rows[0].blocked_on).toBe('human');
  });

  test('DOOR (c) CONTROL: the same status-less clear on a NON-blocked row is ALLOWED', async () => {
    // The gate must not become "you may never clear a blocker". A todo row carrying a stale
    // blocker is exactly where clearing it is the correct edit, and a rule that refused this
    // would be over-reaching rather than fail-closed.
    const id = await seedTask('todo', 'human');
    await mustSucceed('task_update', { projectId, taskId: id, blockedOn: null });
    expect(await readBlockedOn(id)).toBeNull();
  });

  test('every OTHER status is unaffected — the gate is not a general write barrier', async () => {
    for (const status of ['todo', 'in_progress', 'completed', 'cancelled']) {
      const id = await seedTask('todo');
      await mustSucceed('task_update', { projectId, taskId: id, status });
    }
  });
});

describe('gap 2 — the BULK path (the twin site)', () => {
  test('a bulk move to blocked with NO blockedOn is REFUSED, and no row moves', async () => {
    const ids = [await seedTask('todo'), await seedTask('todo')];
    const msg = await mustRefuse('task_bulk_update', {
      projectId, task_ids: ids, status: 'blocked' });
    expect(msg).toMatch(/dependencies/);
    // The error reports HOW MANY rows are the problem — on a sweep that is the number the
    // caller needs, and reporting "some" would send them back to check by hand.
    expect(msg).toMatch(/2 task\(s\)/);
    for (const id of ids) {
      const r = await db.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
      expect(r.rows[0].status).toBe('todo');
    }
  });

  test('a bulk move to blocked WITH a blockedOn is accepted and stores it on every row', async () => {
    // The control, and also the reason `blockedOn` had to be added to the bulk schema: without
    // it the fail-closed rule would have been unsatisfiable here — a rule that closes the
    // product rather than a hole.
    const ids = [await seedTask('todo'), await seedTask('todo')];
    await mustSucceed('task_bulk_update', {
      projectId, task_ids: ids, status: 'blocked', blockedOn: 'external' });
    for (const id of ids) expect(await readBlockedOn(id)).toBe('external');
  });

  test('a bulk move to blocked is allowed when EVERY target already names a blocker', async () => {
    const ids = [await seedTask('blocked', 'human'), await seedTask('todo', 'agent')];
    await mustSucceed('task_bulk_update', { projectId, task_ids: ids, status: 'blocked' });
  });

  test('a MIXED bulk — one named, one not — is REFUSED as a whole and reports the count', async () => {
    // The partial case is the one a per-call check misses. All-or-nothing, and the count names
    // the offenders' number rather than the batch's.
    const named = await seedTask('todo', 'human');
    const unnamed = await seedTask('todo');
    const msg = await mustRefuse('task_bulk_update', {
      projectId, task_ids: [named, unnamed], status: 'blocked' });
    expect(msg).toMatch(/1 task\(s\)/);
    for (const id of [named, unnamed]) {
      const r = await db.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
      expect(r.rows[0].status).toBe('todo');
    }
  });
});

describe('gap 2 ROUND 2 — `dependencies` is the SECOND channel, and it had to become writable', () => {
  test('THE POISONING CASE: a task waiting on another TASK satisfies the rule WITHOUT touching blocked_on', async () => {
    // This is the whole correction. Before it, this author's only way to set `blocked` was to
    // pick one of human|agent|external — none of which is true — and `project_briefing`
    // selects blocked_on='human', so the forced value would have put a FALSE ENTRY in the
    // surface a human reads first.
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', {
      projectId, taskId: id, status: 'blocked', dependencies: [upstream] });

    const r = await db.query(
      `SELECT status, blocked_on, dependencies FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].status).toBe('blocked');
    expect(r.rows[0].dependencies).toEqual([upstream]);
    // AND blocked_on is STILL NULL. The rule was satisfied without corrupting the party
    // field — assert it explicitly, because "the call succeeded" would also be true if the
    // handler had helpfully defaulted something in.
    expect(r.rows[0].blocked_on).toBeNull();
  });

  test('the briefing does NOT pick up a task-blocked row — no false "waiting on a human" entry', async () => {
    // The consequence the poisoning argument rests on, asserted at the consumer rather than
    // argued in a comment. A row blocked on a TASK must be invisible to a section that means
    // "a person has to act next".
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', {
      projectId, taskId: id, status: 'blocked', dependencies: [upstream] });
    const w = await gatherWaitingOnHuman(projectId, OPEN_STATUSES, db);
    expect(w.items.map((i) => i.id)).not.toContain(id);
  });

  test('THE ENUM HAS NO "task" VALUE — pinned, because the whole rule shape depends on it', async () => {
    // If someone later adds a fourth value meaning "another task", the argument above stops
    // holding and this rule should be revisited rather than silently inherited. That is what
    // this assertion is for: it fails loudly on the change that would invalidate the design.
    const { BLOCKED_ON_VALUES } = await import('../config/blockedOnConfig.js');
    expect([...BLOCKED_ON_VALUES]).toEqual(['human', 'agent', 'external']);
  });

  test('dependencies are WRITABLE ON UPDATE at all — the channel was write-once at create', async () => {
    // The enabling defect: `dependencies` was absent from task_update's schema AND from the
    // handler's SET-clause builder, so no task could acquire one after it was filed. A task
    // becomes blocked LATER, by definition. This asserts the channel exists on the path that
    // needs it, independently of the blocked rule.
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', { projectId, taskId: id, dependencies: [upstream] });
    const r = await db.query(`SELECT dependencies FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].dependencies).toEqual([upstream]);
  });

  test('an update dependency accepts a SHORT ID and mints the depends_on edge, like create', async () => {
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', {
      projectId, taskId: id, status: 'blocked', dependencies: [upstream.substring(0, 8)] });
    // Resolved to the full UUID, not stored raw (the uuid[] cast defect an earlier task fixed
    // on the create path must not reappear here).
    const r = await db.query(`SELECT dependencies FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].dependencies).toEqual([upstream]);
    // And the graph learned about it — an edge minted only at create time would mean the
    // graph knows a dependency only when the author predicted it at filing.
    const e = await db.query(
      `SELECT count(*)::int n FROM links
        WHERE from_id = $1 AND to_id = $2 AND edge_type = 'depends_on'`, [id, upstream]);
    expect(e.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  test('an existing dependency satisfies a later move to blocked with no new args', async () => {
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', { projectId, taskId: id, dependencies: [upstream] });
    await mustSucceed('task_update', { projectId, taskId: id, status: 'blocked' });
  });

  test('ABSENT: CLEARING the dependencies of a task that stays blocked is REFUSED', async () => {
    // The second channel gets the same erasure guard as the first, or the rule would have a
    // hole exactly where the new channel is. `[]` is an erasure, not silence.
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', {
      projectId, taskId: id, status: 'blocked', dependencies: [upstream] });
    await mustRefuse('task_update', { projectId, taskId: id, dependencies: [] });
    const r = await db.query(`SELECT dependencies FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].dependencies).toEqual([upstream]);
  });

  test('ABSENT: clearing blocked_on is FINE when dependencies still justify the row', async () => {
    // The channels are a DISJUNCTION. Erasing one while the other still names something is a
    // legitimate correction, and a gate that refused it would be over-reaching — the reason
    // the predicate asks about the resulting state of BOTH rather than either alone.
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', {
      projectId, taskId: id, status: 'blocked', blockedOn: 'human', dependencies: [upstream] });
    await mustSucceed('task_update', { projectId, taskId: id, blockedOn: null });
    const r = await db.query(`SELECT blocked_on, dependencies FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].blocked_on).toBeNull();
    expect(r.rows[0].dependencies).toEqual([upstream]);
  });

  test('ABSENT: erasing BOTH channels at once is REFUSED', async () => {
    const upstream = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', {
      projectId, taskId: id, status: 'blocked', blockedOn: 'human', dependencies: [upstream] });
    await mustRefuse('task_update', {
      projectId, taskId: id, blockedOn: null, dependencies: [] });
  });

  test('task_create with status=blocked is satisfied by dependencies alone', async () => {
    const upstream = await seedTask('todo');
    const res = await mustSucceed('task_create', {
      projectId, title: 'blocked on a task, not a party', status: 'blocked',
      dependencies: [upstream] });
    const id = res.structuredContent?.task?.id ?? res.structuredContent?.id;
    const r = await db.query(`SELECT blocked_on, dependencies FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].dependencies).toEqual([upstream]);
    expect(r.rows[0].blocked_on).toBeNull();
  });
});

describe('gap 2 — CREATE IS NOT UPDATE: an empty dependencies array is silence, not erasure', () => {
  /**
   * REGRESSION FUSE for a defect that took the whole suite down (2026-09-05).
   *
   * `TasksHandler.createTask` declares `dependencies: string[] = []`, so EVERY create passes
   * an empty array, never undefined. The gate briefly shared one "is this call erasing a
   * channel?" predicate between create and update — which is TRUE on every create — so the
   * combined fast path never fired and every `task_create`, blocked or not, hit the refusal.
   * 181 tests across 58 files went RED.
   *
   * These assertions are the cheap permanent version of that discovery. They are deliberately
   * about the ORDINARY create, because that is the one nobody thinks to test when they are
   * writing a rule about blocked tasks — the blast radius was the entire product, reached
   * through the most common call in it.
   */
  test('a plain task_create with NO status and NO dependencies is ACCEPTED', async () => {
    await mustSucceed('task_create', { projectId, title: 'ordinary task, nothing special' });
  });

  test.each(['todo', 'in_progress', 'completed', 'cancelled'])(
    'task_create with status=%s and no dependencies is ACCEPTED',
    async (status) => {
      await mustSucceed('task_create', { projectId, title: `created as ${status}`, status });
    },
  );

  test('an EXPLICIT empty dependencies array on create is still silence, not an erasure', async () => {
    await mustSucceed('task_create', {
      projectId, title: 'explicitly no dependencies', dependencies: [] });
  });

  test('...and status=blocked with an empty dependencies array is STILL refused', async () => {
    // The control that keeps the three above from being satisfiable by simply deleting the
    // create-side rule. Silence must be accepted; silence on a BLOCKED create must not be.
    await mustRefuse('task_create', {
      projectId, title: 'blocked, naming nothing', status: 'blocked', dependencies: [] });
  });
});

describe('gap 2 — a dependency must name a task that EXISTS', () => {
  const DANGLING = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  test('task_update to blocked with a dangling full-UUID dependency is REFUSED and writes nothing', async () => {
    const id = await seedTask('todo');
    const msg = await mustRefuse('task_update', {
      projectId, taskId: id, status: 'blocked', dependencies: [DANGLING] });
    expect(msg).toMatch(/NOT EXIST/);
    expect(msg).toMatch(DANGLING);
    const r = await db.query(`SELECT status, dependencies FROM tasks WHERE id = $1`, [id]);
    expect(r.rows[0].status).toBe('todo');
    expect(r.rows[0].dependencies).toEqual([]);
  });

  test('task_create blocked with a dangling dependency is REFUSED', async () => {
    const before = await db.query(
      `SELECT count(*)::int n FROM tasks WHERE project_id = $1`, [projectId]);
    await mustRefuse('task_create', {
      projectId, title: 'blocked on a ghost', status: 'blocked', dependencies: [DANGLING] });
    const after = await db.query(
      `SELECT count(*)::int n FROM tasks WHERE project_id = $1`, [projectId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('a REAL dependency alongside a dangling one still satisfies the gate', async () => {
    const real = await seedTask('todo');
    const id = await seedTask('todo');
    await mustSucceed('task_update', {
      projectId, taskId: id, status: 'blocked', dependencies: [real, DANGLING] });
  });

  test('an already-blocked row justified only by a dangling stored dependency is not treated as justified', async () => {
    const id = await seedTask('todo');
    await db.query(
      `UPDATE tasks SET status = 'blocked', dependencies = ARRAY[$2]::uuid[] WHERE id = $1`,
      [id, DANGLING]);
    await mustRefuse('task_update', { projectId, taskId: id, status: 'blocked' });
  });

  test('the dangling message is DIFFERENT from the named-nothing message', async () => {
    const id = await seedTask('todo');
    const named = await mustRefuse('task_update', {
      projectId, taskId: id, status: 'blocked', dependencies: [DANGLING] });
    const nothing = await mustRefuse('task_update', { projectId, taskId: id, status: 'blocked' });
    expect(named).toMatch(/NOT EXIST/);
    expect(nothing).not.toMatch(/NOT EXIST/);
    expect(nothing).toMatch(/dependencies/);
  });
});
