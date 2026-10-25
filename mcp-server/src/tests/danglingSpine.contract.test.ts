/**
 * A POSITION MAY NEVER NAME A SPINE THAT RESOLVES TO NOTHING —  * SIGNAL 2, measured by Coordinator on its own session 2026-09-03:
 *
 *   graph({action:'branch_current'})
 *     -> {"ok":true,"position":null,"atTrunk":true,
 *         "revertedFrom":{"spineId":"f50bf00d-...","spineType":"task"}}
 *   task({action:'details', taskId:'2b3c4d5e'})  -> {"ok":true,"found":false}
 *   context({action:'search', id:'2b3c4d5e'})    -> "❌ Context not found"
 *
 * The API asserted `spineType: "task"` for an id that is not a task and is not anything.
 *
 * ── HOW A POSITION BECOMES DANGLING ─────────────────────────────────────────────────
 * `branch_open` validates its spine (services/spineResolver.ts), so a position is REAL at
 * the moment it is taken. `branch_positions.spine_id` is then a SOFT reference — migration
 * 080 says so in as many words ("no FK; endpoints span three tables") — and nothing deletes
 * the row when the record goes. Delete the spine record and the position outlives it.
 *
 * That is not a theoretical window: the id in signal 2 is one of the `delete me` probe tasks,
 * i.e. exactly the create-position-delete sequence below, performed by hand on prod.
 *
 * ── WHY IT IS WORSE THAN AN UNTIDY ROW ──────────────────────────────────────────────
 * Position is DECLARED membership. Every write made from one stamps a trust-bearing
 * `informs` edge onto the spine. A dangling position therefore does not degrade to "no
 * membership" — it mints high-confidence edges pointing at nothing, and `branch_current`
 * renders it as an ordinary open branch whose title merely happens to be null, because
 * `spineTitle()` returns null both for "no title" and for "no record" (C1's third state:
 * could-not-resolve sharing a value with a real answer).
 *
 * ── THE CONTRACT PINNED HERE ────────────────────────────────────────────────────────
 * THREE observables must be mutually distinguishable, because a caller branches on them:
 *   ABSENT   — no row at all.
 *   TRUNK    — a row that mints nothing, whose spine_id is provenance.
 *   DANGLING — a row whose spine cannot be resolved. NEVER silently carried, NEVER
 *              rendered as a live position, and NEVER a mint target.
 *
 * Driven through the FULL public path (validate -> routeExecutor) against the disposable
 * migrated ci_* DB. Embeddings mocked to zeros — similarity plays no part in positions.
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

async function viaTool(toolName: string, rawArgs: any, conn: string, actor?: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn, actor });
}

async function freshProject(label: string): Promise<string> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'dangling-spine fixture') RETURNING id`,
      [`dsp-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  return projectId;
}

/** The stored position row, read straight from the table — the thing the API renders FROM. */
async function positionRow(projectId: string) {
  const r = await db.query(
    `SELECT spine_id, spine_type, origin FROM branch_positions WHERE project_id = $1`,
    [projectId]
  );
  return r.rows[0] ?? null;
}

/**
 * Does this id exist as a record of ANY spine type, anywhere in the schema? The
 * "its own by-id lookup" of the DONE WHEN, asked at the lowest layer available (C1: read
 * the DB, not a type alias and not the code that is under test).
 */
async function resolvesToAnyRecord(id: string): Promise<boolean> {
  const r = await db.query(
    `SELECT
       (SELECT count(*) FROM tasks               WHERE id = $1) +
       (SELECT count(*) FROM technical_decisions WHERE id = $1) +
       (SELECT count(*) FROM contexts            WHERE id = $1) AS n`,
    [id]
  );
  return Number(r.rows[0].n) > 0;
}

/** Every link row from one record to one target, whatever the type or creator. */
async function linksBetween(fromId: string, toId: string) {
  return (
    await db.query(`SELECT edge_type, created_by FROM links WHERE from_id = $1 AND to_id = $2`, [
      fromId,
      toId,
    ])
  ).rows;
}

/**
 * Stand on a REAL task, then delete the task out from under the position — the exact
 * sequence that produced signal 2. Returns the ids plus the two witnesses that the
 * mutation LANDED (C3 assertion 1: not "the edit is in the file" but "the mutated state
 * is really in the DB").
 */
async function danglingPosition(label: string, conn: string) {
  const projectId = await freshProject(label);
  await viaTool('project_switch', { project: projectId }, conn);
  const taskId: string = (
    await viaTool('task_create', { title: `spine to be deleted (${label})`, type: 'feature' }, conn)
  ).structuredContent.task.id;
  await viaTool('branch_open', { id: taskId }, conn);

  // Precondition: the position really is on that task BEFORE we break anything.
  const before = await positionRow(projectId);
  expect(before?.spine_id).toBe(taskId);

  // THE MUTATION: the spine record goes; the position row is untouched by it.
  await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);

  return { projectId, taskId, before };
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

describe('DANGLING SPINE — a position whose record no longer exists', () => {
  test('MUTATION LANDED — the row still names the task, and the task resolves to nothing', async () => {
    const conn = `dsp-landed-${STAMP}`;
    const { projectId, taskId } = await danglingPosition('landed', conn);

    // Witness 1: the position row SURVIVED the delete, still naming the dead id. If this
    // ever fails, the soft reference has become a real FK and the whole defect is gone —
    // which must show up as this probe going red, not as the probes below passing quietly.
    const after = await positionRow(projectId);
    expect(after?.spine_id).toBe(taskId);
    expect(after?.spine_type).toBe('task');

    // Witness 2: the id really is unresolvable, at the DB layer, in all three tables.
    expect(await resolvesToAnyRecord(taskId)).toBe(false);
  });

  test('GUARD — branch_current never reports a spineType its own by-id lookup cannot resolve', async () => {
    const conn = `dsp-current-${STAMP}`;
    const { taskId } = await danglingPosition('current', conn);

    const current = await viaTool('branch_current', {}, conn);
    const sc = current.structuredContent;

    // It must NOT be rendered as a live position ...
    expect(sc.position).toBeNull();
    // ... and it must not be smuggled out under the trunk path's provenance field either,
    // which is the exact shape signal 2 was observed in.
    expect(sc.revertedFrom ?? null).toBeNull();

    // Every id this response asserts a spineType for must resolve. Stated as a sweep over
    // the response rather than a list of field names, so a future field that carries a
    // spine cannot be added past this guard.
    for (const id of spineIdsAsserted(sc)) {
      expect(await resolvesToAnyRecord(id)).toBe(true);
    }

    // The dead id is still REPORTED — that is the point of surfacing rather than hiding,
    // and it is what lets the caller close the branch. What it must not be is reported
    // WITH A TYPE, under a key a client reads as a place it is standing.
    expect(sc.danglingSpine.spineId).toBe(taskId);
    expect(sc.danglingSpine.spineType).toBeUndefined();
  });

  test('GUARD — DANGLING is observably DIFFERENT from ABSENT (the two must not collapse)', async () => {
    const danglingConn = `dsp-vs-absent-d-${STAMP}`;
    await danglingPosition('vs-absent', danglingConn);
    const dangling = (await viaTool('branch_current', {}, danglingConn)).structuredContent;

    // A session in the same project that never opened anything: the ABSENT population.
    const absentConn = `dsp-vs-absent-a-${STAMP}`;
    const absentProject = await freshProject('absent');
    await viaTool('project_switch', { project: absentProject }, absentConn);
    const absent = (await viaTool('branch_current', {}, absentConn)).structuredContent;

    // Both correctly report "you are not standing anywhere" ...
    expect(dangling.position).toBeNull();
    expect(absent.position).toBeNull();
    // ... but a caller MUST be able to tell "nothing was ever opened" from "what you opened
    // is gone". If these two responses are equal, the defect is intact under a nicer render.
    expect(dangling).not.toEqual(absent);
    expect(dangling.danglingSpine).toBeTruthy();
    expect(absent.danglingSpine ?? null).toBeNull();
  });

  test('GUARD — a write from a dangling position mints NO edge to the dead spine, and says why', async () => {
    const conn = `dsp-mint-${STAMP}`;
    const { taskId } = await danglingPosition('mint', conn);

    const resp = await viaTool(
      'context_store',
      { content: 'ordinary completion prose, naming no record ids at all', type: 'completion' },
      conn
    );
    const ctxId: string = resp.structuredContent.context.id;

    // THE HARM, asserted directly: zero edges of ANY type to the record that is not there.
    expect(await linksBetween(ctxId, taskId)).toEqual([]);

    // And it is SURFACED, not silent — the no-orphan floor's promise is ">=1 edge or a
    // surfaced reason", and a vanished spine is a reason a caller has to be told.
    expect(JSON.stringify(resp.structuredContent)).toMatch(/dangling|spine-missing/i);
  });

  /**
   * THE SHAPE THE BUG WAS ACTUALLY FILED ON, which is NOT the deleted one.
   *
   * an earlier Task read `branch_current` naming an earlier task while `task details` answered
   * found:false, and inferred a dangling pointer. Measured on prod 2026-09-05:
   *   SELECT id, status, archived_at IS NOT NULL FROM tasks WHERE id::text LIKE '2b3c4d5e%';
   *   -> f50bf00d-... | todo | t   (archived_at 2026-09-02 00:58:52+00)
   * The row EXISTS. It was invisible to `task details` because includeArchived:false is the
   * default on the read ops. Two different causes, one observable — so a fix that only
   * handled deletion would have left the reported case behaving exactly as before while
   * every probe above went green. This probe is here so that cannot happen quietly.
   */
  test('ARCHIVED — the branch stays OPEN and still mints, but the state is SAID', async () => {
    const conn = `dsp-archived-${STAMP}`;
    const projectId = await freshProject('archived');
    await viaTool('project_switch', { project: projectId }, conn);
    const taskId: string = (
      await viaTool('task_create', { title: 'spine that gets archived', type: 'feature' }, conn)
    ).structuredContent.task.id;
    await viaTool('branch_open', { id: taskId }, conn);

    // THE MUTATION: archived, not deleted. The row stays.
    await db.query('UPDATE tasks SET archived_at = now() WHERE id = $1', [taskId]);
    expect(await resolvesToAnyRecord(taskId)).toBe(true); // witness: it really is still there

    const sc = (await viaTool('branch_current', {}, conn)).structuredContent;

    // It is NOT dangling — an archived spine is a real record and this must not be
    // confused with the deleted case, which has a different remedy.
    expect(sc.danglingSpine ?? null).toBeNull();
    expect(sc.position?.spineId).toBe(taskId);
    // ... and the caller is told, so it can reconcile this against a by-id lookup that
    // returns nothing instead of concluding one of the two responses is lying.
    expect(sc.position.spineArchived).toBe(true);

    // The branch still THREADS. Suppressing membership here would "fix" the report by
    // breaking the feature for every branch whose spine was ever tidied away.
    const ctxId: string = (
      await viaTool('context_store', { content: 'work done on an archived spine', type: 'completion' }, conn)
    ).structuredContent.context.id;
    expect((await linksBetween(ctxId, taskId)).map((e) => e.edge_type)).toContain('informs');
  });

  /**
   * THE TRUNK ARM — reject round 1's blocker, and the arm the report was filed on.
   *
   * The archived check was first written BELOW the trunk arm, which returns early, so an
   * archived spine at trunk emitted a `spineType` and no archived signal at all: Coordinator's
   * original observation, byte-for-byte, after two commits that claimed to address it.
   *
   * It is asserted SEPARATELY from the position-path probe on purpose. A single probe on the
   * position arm passed throughout and is exactly what hid this — a guard whose population is
   * "the arm I was editing" is the recurring shape of C3, and the two arms return from
   * different branches of the same function.
   */
  test('GUARD — an ARCHIVED spine AT TRUNK is signalled too, not just on the position arm', async () => {
    const conn = `dsp-trunk-arch-${STAMP}`;
    const projectId = await freshProject('trunk-arch');
    await viaTool('project_switch', { project: projectId }, conn);
    const taskId: string = (
      await viaTool('task_create', { title: 'spine reverted from, then archived', type: 'feature' }, conn)
    ).structuredContent.task.id;
    await viaTool('branch_open', { id: taskId }, conn);

    // SET origin='trunk' DIRECTLY, and this comment says so because the previous one claimed
    // the opposite ("driven through the store, so origin is the real thing rather than a value
    // this test asserted into existence") while doing exactly this UPDATE. It is a fixture,
    // not a fabrication: 'trunk' is a value the CHECK constraint in migration 082 permits and
    // the store itself writes via revertToTrunk, and the assertion below reads `atTrunk` back
    // OUT of the route rather than trusting the write. What it deliberately does NOT claim is
    // that the R2 fan-out sequence which normally produces this row was exercised — that is
    // autoOpenPositions.contract.test.ts's job, and this probe is about the RENDER of a trunk
    // row, not about how one comes to exist.
    await db.query(
      `UPDATE branch_positions SET origin = 'trunk' WHERE project_id = $1 AND spine_id = $2`,
      [projectId, taskId]
    );
    await db.query('UPDATE tasks SET archived_at = now() WHERE id = $1', [taskId]);

    const resp = await viaTool('branch_current', {}, conn);
    const sc = resp.structuredContent;

    // Precondition: we really are on the trunk arm, not the position arm. Without this the
    // probe could pass by never reaching the branch it exists to cover.
    expect(sc.atTrunk).toBe(true);
    expect(sc.position).toBeNull();

    // THE BLOCKER: provenance names an id AND a type, so it makes a claim a caller will look
    // up — and that lookup returns nothing while the record is really there.
    expect(sc.revertedFrom.spineId).toBe(taskId);
    expect(sc.revertedFrom.spineArchived).toBe(true);

    // THE HUMAN CHANNEL TOO, and asserted on the TEXT rather than on the serialized object:
    // the field is NAMED `spineArchived`, so a /archiv/i match against JSON.stringify passes
    // merely because the key exists — it would have been green with the value false. Caught
    // by this probe's own negative control below, which is what a control is for.
    expect(resp.content[0].text).toMatch(/ARCHIVED/);
  });

  test('CONTROL — a LIVE spine at trunk is not falsely marked archived', async () => {
    const conn = `dsp-trunk-live-${STAMP}`;
    const projectId = await freshProject('trunk-live');
    await viaTool('project_switch', { project: projectId }, conn);
    const taskId: string = (
      await viaTool('task_create', { title: 'live spine reverted from', type: 'feature' }, conn)
    ).structuredContent.task.id;
    await viaTool('branch_open', { id: taskId }, conn);
    await db.query(
      `UPDATE branch_positions SET origin = 'trunk' WHERE project_id = $1 AND spine_id = $2`,
      [projectId, taskId]
    );

    const resp = await viaTool('branch_current', {}, conn);
    expect(resp.structuredContent.atTrunk).toBe(true);
    expect(resp.structuredContent.revertedFrom.spineArchived).toBe(false);
    expect(resp.content[0].text).not.toMatch(/ARCHIVED/);
  });

  /**
   * THE SECOND PATH TO THE SAME VARIABLE (N4). project_briefing takes its spine from an
   * explicit argument OR from the ambient position, and only the explicit one validated —
   * while the AMBIENT one is what a COLD BOOT takes, because the boot hook asks for a
   * briefing without naming a spine. Both routes are driven here, same id, so the two can
   * never be fixed one at a time again.
   */
  describe('project_briefing — the ambient spine gets the same liveness rule as the explicit one', () => {
    const savedFlag = process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED;
    afterAll(() => {
      if (savedFlag === undefined) delete process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED;
      else process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED = savedFlag;
    });

    /** Both routes to a briefing spine, for one task id. */
    async function bothRoutes(taskId: string, conn: string) {
      const ambient = (await viaTool('project_briefing', {}, conn)).structuredContent.briefing;
      const explicit = (await viaTool('project_briefing', { spine: taskId }, conn)).structuredContent.briefing;
      return { ambient, explicit };
    }

    async function positionedOn(label: string): Promise<{ conn: string; taskId: string }> {
      // THE FLAG MUST BE ON OR THIS MEASURES NOTHING. Default-OFF is why the first review
      // could not reproduce the harm and correctly flagged it as believed rather than
      // measured; a probe that silently runs with the feature disabled is a false green.
      process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED = 'true';
      const conn = `dsp-brief-${label}-${STAMP}`;
      const projectId = await freshProject(`brief-${label}`);
      await viaTool('project_switch', { project: projectId }, conn);
      const taskId: string = (
        await viaTool('task_create', { title: `briefing spine ${label}`, type: 'feature' }, conn)
      ).structuredContent.task.id;
      await viaTool('branch_open', { id: taskId }, conn);
      return { conn, taskId };
    }

    test('a DELETED spine is refused on BOTH routes, with the SAME typed reason', async () => {
      const { conn, taskId } = await positionedOn('deleted');
      await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
      const { ambient, explicit } = await bothRoutes(taskId, conn);

      // The whole briefing must not be scoped to a record that does not exist ...
      expect(ambient.spineId).toBeNull();
      // ... and `spineRefusal: null` must not be what a boot hook reads, because null is
      // entitled to mean "nothing went wrong".
      expect(ambient.spineRefusal).toBe('spine-not-found');
      // ONE VOCABULARY: the reason a consumer already handles from the explicit route.
      expect(ambient.spineRefusal).toBe(explicit.spineRefusal);
      expect(ambient.spineId).toBe(explicit.spineId);
      // NULL, NOT FALSE, when there is no spine: "not archived" and "there is nothing to ask
      // about" are different answers and a caller branching on a bare false renders the
      // second as the first.
      expect(ambient.spineArchived).toBeNull();
    });

    test('an ARCHIVED spine is ACCEPTED on both routes — the divergence must not be re-created inverted', async () => {
      const { conn, taskId } = await positionedOn('archived');
      await db.query('UPDATE tasks SET archived_at = now() WHERE id = $1', [taskId]);
      const { ambient, explicit } = await bothRoutes(taskId, conn);

      expect(ambient.spineId).toBe(taskId);
      expect(ambient.spineRefusal).toBeNull();
      expect(explicit.spineId).toBe(taskId);
      // Same id, same verdict, whichever route it arrived by.
      expect(ambient.spineId).toBe(explicit.spineId);

      // N-b: ACCEPTED IS NOT THE SAME AS UNREMARKED. A cold boot takes the ambient route and
      // an archived record answers NOT FOUND to a by-id read under the default
      // includeArchived:false — so a briefing scoped to one, with no signal, is this task's
      // cause B arriving at the boot package with the reconciliation hint stripped. Parity
      // with branch_current, on BOTH routes so they cannot diverge on archived the way they
      // diverged on deleted.
      expect(ambient.spineArchived).toBe(true);
      expect(explicit.spineArchived).toBe(true);
    });

    test('CONTROL — a LIVE ambient spine reports spineArchived false, and is still used', async () => {
      const { conn, taskId } = await positionedOn('live');
      const { ambient } = await bothRoutes(taskId, conn);
      expect(ambient.spineId).toBe(taskId);
      expect(ambient.spineRefusal).toBeNull();
      expect(ambient.spineArchived).toBe(false);
    });
  });

  test('CONTROL — with the spine ALIVE, nothing about this changes (unmutated GREEN)', async () => {
    const conn = `dsp-control-${STAMP}`;
    const projectId = await freshProject('control');
    await viaTool('project_switch', { project: projectId }, conn);
    const taskId: string = (
      await viaTool('task_create', { title: 'spine that stays alive', type: 'feature' }, conn)
    ).structuredContent.task.id;
    await viaTool('branch_open', { id: taskId }, conn);

    // The position renders as an ordinary open branch, with its real title.
    const current = (await viaTool('branch_current', {}, conn)).structuredContent;
    expect(current.position?.spineId).toBe(taskId);
    expect(current.position?.spineType).toBe('task');
    expect(current.danglingSpine ?? null).toBeNull();
    expect(current.position.spineArchived).toBe(false);

    // And a write is still a MEMBER of it — the declared informs edge the whole mechanism
    // exists to mint. If the fix suppressed this, it would have closed the defect by
    // breaking the feature, and this control is what says so.
    const ctxId: string = (
      await viaTool(
        'context_store',
        { content: 'ordinary completion prose on a healthy branch', type: 'completion' },
        conn
      )
    ).structuredContent.context.id;
    const edges = await linksBetween(ctxId, taskId);
    expect(edges.map((e) => e.edge_type)).toContain('informs');
  });
});

/**
 * Collect every id in a branch_current response that the response also labels with a
 * spineType. A SWEEP rather than a field list: the claim being guarded is "no asserted
 * spineType is unresolvable", and enumerating `position` and `revertedFrom` by hand would
 * make that claim only as wide as the fields that existed the day it was written.
 */
function spineIdsAsserted(structured: any): string[] {
  const ids: string[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.spineId === 'string' && typeof node.spineType === 'string') {
      ids.push(node.spineId);
    }
    Object.values(node).forEach(walk);
  };
  walk(structured);
  return ids;
}
