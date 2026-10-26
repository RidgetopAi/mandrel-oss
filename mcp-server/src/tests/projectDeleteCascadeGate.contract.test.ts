/**
 * PROJECT-DELETE CONFIRMATION GATE — the blast radius is measured from the SCHEMA
 *.
 *
 * ── WHAT SHIPPED, AND WHAT THIS FILE HOLDS ─────────────────────────────────────────────
 * `deleteProject` refuses to destroy a non-empty project without `confirm: true`. That
 * refusal used to be `counts.total > 0`, where `total` was a sum over FOUR hardcoded
 * COUNTs (contexts / technical_decisions / tasks / sessions) while the failure message
 * named those same four by hand — a past incident's tell: a count-shaped predicate paired with
 * a message naming specific items, agreeing today, either weakenable without the other
 * noticing.
 *
 * It was not merely weakenable, it was ALREADY WRONG: the migrated schema has TWENTY-FOUR
 * tables whose FK to `projects` is ON DELETE CASCADE. Measured on the pre-fix code
 * (2026-07-27), a project owning three `analytics_events` rows reported
 * `{contexts:0, decisions:0, tasks:0, sessions:0, total:0}` and was DELETED on
 * `confirm:false`, cascading them away.
 *
 * The gate now derives its table set from `pg_constraint` — the choke point every
 * project-owned table must pass through, because creating the cascading FK IS how a table
 * becomes project-owned. The tests below are written to fail if that regresses:
 *
 *   T1  a project owning rows ONLY in an uncounted real table (analytics_events) is
 *       REFUSED, and the message names that table. RED against the shipped-before code.
 *   T2  THE ONE THAT MATTERS. A cascading child table is CREATED at runtime — it does not
 *       exist anywhere in the source — and a project owning only a row of that type is
 *       REFUSED, with the new table NAMED in the message. Covered the moment it exists,
 *       with no code change. A registry-based fix cannot pass this test.
 *       SCOPE OF THAT CLAIM: this table is the SIMPLE shape — one cascading FK, on
 *       `project_id`, referencing `projects.id`. "Covered the moment it exists" held for
 *       this shape in 4dcbf00 and was FALSE for an ordinary two-FK table, which was
 *       deleted without confirmation while all nine tests here stayed green. The shapes
 *       that broke it — two FKs, composite keys, partitions, an FK that does not reference
 *       `projects.id` — are covered in projectDeleteHostileSchema.contract.test.ts, and
 *       this file alone is NOT evidence for the general claim.
 *   T3  ONE SOURCE: mutate the source (the schema), and BOTH the predicate and the message
 *       move together — plus the structural invariant that every table named in the
 *       message is a key the predicate reads, and vice versa.
 *   T4  PROBE THE PROBE. An empty table set is the value that slips through: `[].every()`
 *       is vacuously TRUE, so a naive predicate would call an UNMEASURABLE project empty
 *       and wave the delete through. The empty set must produce a loud refusal, and this
 *       test asserts the naive answer differs from the shipped one so it cannot pass by
 *       accident.
 *   T5  the handler itself refuses when the counts are unmeasurable (fail closed).
 *   T6  no regression: a genuinely empty project still deletes without confirm, and a
 *       confirmed delete of a non-empty project still works.
 *   T7  the COMPILE-TIME half of the guard: `ProjectChildCounts` is branded, so a
 *       hand-written child-table literal cannot reach the gate. Enforced by `tsc --noEmit`
 *       (the CI gate STAGE 2) via `@ts-expect-error`, which becomes an ERROR ITSELF if the brand
 *       is removed — the guard fails loud when weakened, rather than going quiet.
 *
 * DB target: the disposable migrated Postgres the CI gate provisions. NEVER prod.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// Real UUIDs (the global vitest.setup.ts mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

// The module is mocked ONLY so T5 can hand the handler an unmeasurable counts object; every
// export keeps its real implementation, and every other test in this file runs the real path.
vi.mock('../services/projectCascade.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/projectCascade.js')>();
  return { ...actual, countProjectChildren: vi.fn(actual.countProjectChildren) };
});

import { db } from '../config/database.js';
import { projectHandler } from '../handlers/project.js';
// T6c reads the ROUTE's structuredContent — the machine channel the Command UI backend
// consumes over HTTP. The handler alone cannot prove that contract.
import { projectRoutes } from '../routes/project.routes.js';
import {
  buildChildCounts,
  countProjectChildren,
  describeProjectChildCounts,
  discoverProjectCascadeChildren,
  isProjectEmpty,
} from '../services/projectCascade.js';

const STAMP = Date.now();

/** The four tables the pre-fix gate counted. Pinned LITERALLY, on purpose: a guard that
 *  read the product's own list would widen in lockstep with it (a past incident rule 7). */
const LEGACY_COUNTED_TABLES = ['contexts', 'technical_decisions', 'tasks', 'sessions'] as const;

/** A cascading child table invented for T2/T3. Not in the source tree, not in any list. */
const ADHOC_TABLE = `f352_adhoc_child_${STAMP}`;

const newProject = async (label: string): Promise<{ id: string; name: string }> => {
  const name = `f352-${label}-${STAMP}`;
  const id = (await db.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [name]))
    .rows[0].id as string;
  return { id, name };
};

const projectExists = async (id: string): Promise<boolean> =>
  (await db.query(`SELECT COUNT(*)::int AS n FROM projects WHERE id = $1`, [id])).rows[0].n === 1;

describe('project delete gate: blast radius comes from the schema', () => {
  let keepAlive: { id: string; name: string };

  beforeAll(async () => {
    // The gate refuses to delete the LAST project; keep a decoy so that guard never
    // masks the one under test.
    keepAlive = await newProject('keepalive');
  });

  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS ${ADHOC_TABLE}`);
    await db.query(`DELETE FROM projects WHERE name LIKE $1`, [`f352-%-${STAMP}`]);
  });

  // ── T1 ────────────────────────────────────────────────────────────────────────────────
  test('T1: a project owning ONLY rows in an uncounted real table is REFUSED', async () => {
    const victim = await newProject('t1-analytics-only');

    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO analytics_events (actor, event_type, project_id) VALUES ('test', 'f352_probe', $1)`,
        [victim.id]
      );
    }

    // FIXTURE SELF-CHECK — before trusting any verdict below, prove the mutation LANDED
    // and that it is genuinely outside the four tables the old gate counted.
    expect(LEGACY_COUNTED_TABLES).not.toContain('analytics_events');
    const planted = await db.query(
      `SELECT COUNT(*)::int AS n FROM analytics_events WHERE project_id = $1`,
      [victim.id]
    );
    expect(planted.rows[0].n).toBe(3);

    const result = await projectHandler.deleteProject(victim.name, /* confirm */ false);

    expect(result.deleted).toBe(false);
    expect(await projectExists(victim.id)).toBe(true);
    // The refusal must NAME the table, not just report a number.
    expect(result.message).toContain('analytics_events');
    expect(result.counts.byTable['analytics_events']).toBe(3);
    // And the four legacy tables are all zero — i.e. the old predicate would have said 0.
    for (const t of LEGACY_COUNTED_TABLES) expect(result.counts.byTable[t]).toBe(0);
  });

  // ── T2 ────────────────────────────────────────────────────────────────────────────────
  test('T2: a cascading child table created AT RUNTIME is covered with no code change', async () => {
    const before = (await discoverProjectCascadeChildren()).children;
    expect(before.map((c) => c.name)).not.toContain(ADHOC_TABLE);

    await db.query(
      `CREATE TABLE ${ADHOC_TABLE} (
         id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         note text
       )`
    );

    // MUTATION LANDED? Assert the source moved by exactly one before trusting the verdict.
    const after = (await discoverProjectCascadeChildren()).children;
    expect(after.map((c) => c.name)).toContain(ADHOC_TABLE);
    expect(after.length).toBe(before.length + 1);

    const victim = await newProject('t2-adhoc-only');
    await db.query(`INSERT INTO ${ADHOC_TABLE} (project_id, note) VALUES ($1, 'only child')`, [
      victim.id,
    ]);
    const planted = await db.query(
      `SELECT COUNT(*)::int AS n FROM ${ADHOC_TABLE} WHERE project_id = $1`,
      [victim.id]
    );
    expect(planted.rows[0].n).toBe(1);

    const refused = await projectHandler.deleteProject(victim.name, /* confirm */ false);
    expect(refused.deleted).toBe(false);
    expect(await projectExists(victim.id)).toBe(true);
    expect(refused.message).toContain(ADHOC_TABLE);
    expect(refused.counts.byTable[ADHOC_TABLE]).toBe(1);

    // …and an explicit confirmation still gets through (the gate asks, it does not block).
    const confirmed = await projectHandler.deleteProject(victim.name, /* confirm */ true);
    expect(confirmed.deleted).toBe(true);
    expect(confirmed.message).toContain(ADHOC_TABLE);
    expect(await projectExists(victim.id)).toBe(false);
    const cascaded = await db.query(
      `SELECT COUNT(*)::int AS n FROM ${ADHOC_TABLE} WHERE project_id = $1`,
      [victim.id]
    );
    expect(cascaded.rows[0].n).toBe(0);
  });

  // ── T3 ────────────────────────────────────────────────────────────────────────────────
  test('T3: ONE SOURCE — mutate it and the predicate AND the message move together', async () => {
    // (a) Structural: message and predicate read the same map, on a real multi-table fixture.
    const victim = await newProject('t3-one-source');
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'completion', 'f352 t3')`,
      [victim.id]
    );
    await db.query(
      `INSERT INTO analytics_events (actor, event_type, project_id) VALUES ('test', 'f352_t3', $1)`,
      [victim.id]
    );

    const counts = await countProjectChildren(victim.id);
    const rendered = describeProjectChildCounts(counts);
    const nonZero = Object.keys(counts.byTable).filter((t) => counts.byTable[t]! > 0);

    expect(nonZero.sort()).toEqual(['analytics_events', 'contexts']);
    // Every table the predicate counts as non-empty is NAMED in the message …
    for (const t of nonZero) expect(rendered).toContain(t);
    // … and every table the message names is a key the predicate reads.
    for (const t of Object.keys(counts.byTable)) {
      if (rendered.includes(t)) expect(counts.byTable[t]).toBeGreaterThan(0);
    }
    expect(isProjectEmpty(counts)).toBe(false);

    // (b) Behavioural: ONE mutation of the source (the object both sides read) moves BOTH.
    const empty = buildChildCounts({ contexts: 0, [ADHOC_TABLE]: 0 });
    expect(isProjectEmpty(empty)).toBe(true);
    expect(describeProjectChildCounts(empty)).toContain('nothing');
    expect(describeProjectChildCounts(empty)).not.toContain(`1 ${ADHOC_TABLE}`);

    const mutated = buildChildCounts({ contexts: 0, [ADHOC_TABLE]: 1 });
    expect(isProjectEmpty(mutated)).toBe(false); // predicate moved
    expect(describeProjectChildCounts(mutated)).toContain(`1 ${ADHOC_TABLE}`); // message moved
    expect(mutated.total).toBe(1); // and `total` is derived from the same map

    await projectHandler.deleteProject(victim.name, true);
  });

  // ── T4 ────────────────────────────────────────────────────────────────────────────────
  test('T4: PROBE THE PROBE — the empty table set fails CLOSED, and loudly', () => {
    const unmeasurable = buildChildCounts({});

    // The value that slips through: this is what a naive `every(n => n === 0)` answers on
    // an empty set. Asserted explicitly so T4 cannot pass by agreeing with the naive
    // predicate — the two must DISAGREE here, which is the whole point.
    const naiveAnswer = Object.keys(unmeasurable.byTable).every(
      (t) => unmeasurable.byTable[t] === 0
    );
    expect(naiveAnswer).toBe(true);

    expect(isProjectEmpty(unmeasurable)).toBe(false);
    expect(describeProjectChildCounts(unmeasurable)).toContain('UNKNOWN');

    // And the ordinary directions still behave (so "always false" is not a passing answer).
    expect(isProjectEmpty(buildChildCounts({ contexts: 0, tasks: 0 }))).toBe(true);
    expect(isProjectEmpty(buildChildCounts({ contexts: 0, tasks: 1 }))).toBe(false);
  });

  test('T4b: countProjectChildren over an empty discovered set yields an unmeasurable object', async () => {
    const counts = await countProjectChildren(keepAlive.id, { children: [], unmeasurable: [] });
    expect(Object.keys(counts.byTable)).toHaveLength(0);
    expect(counts.total).toBe(0); // total is 0 — and that is exactly why total must not gate
    expect(isProjectEmpty(counts)).toBe(false);
  });

  // ── T5 ────────────────────────────────────────────────────────────────────────────────
  test('T5: the handler REFUSES an unmeasurable project (schema probe found nothing)', async () => {
    const victim = await newProject('t5-unmeasurable');

    vi.mocked(countProjectChildren).mockResolvedValueOnce(buildChildCounts({}));
    const result = await projectHandler.deleteProject(victim.name, /* confirm */ false);

    expect(result.deleted).toBe(false);
    expect(result.message).toContain('UNKNOWN');
    expect(await projectExists(victim.id)).toBe(true);

    // MUTATION-PROBE THE MOCK: prove the injection actually took effect for that ONE call
    // and that the real path is back (otherwise T5 could be "passing" on the real path
    // refusing for an unrelated reason).
    const real = await countProjectChildren(victim.id);
    expect(Object.keys(real.byTable).length).toBeGreaterThan(0);

    await projectHandler.deleteProject(victim.name, true);
  });

  // ── T6 ────────────────────────────────────────────────────────────────────────────────
  test('T6: a genuinely empty project still deletes without confirmation', async () => {
    const victim = await newProject('t6-empty');

    const counts = await countProjectChildren(victim.id);
    expect(Object.keys(counts.byTable).length).toBeGreaterThan(0); // measurable …
    expect(counts.total).toBe(0); // … and measured as empty

    const result = await projectHandler.deleteProject(victim.name, /* confirm */ false);
    expect(result.deleted).toBe(true);
    expect(await projectExists(victim.id)).toBe(false);
    expect(keepAlive.id).toBeTruthy();
  });

  // ── T6b ───────────────────────────────────────────────────────────────────────────────
  // The route (routes/project.routes.ts handleDelete) now prints `result.message` verbatim
  // with no footer of its own, because EVERY refusal the handler produces already describes
  // the blast radius. That is a UX contract, not the safety property — a refusal that
  // forgot the description would still have refused — but it is what stops the two
  // surfaces re-growing separate wordings, so it is measured rather than assumed.
  test('T6b: every refusal reason carries the schema-derived description', async () => {
    const victim = await newProject('t6b-refusals');
    await db.query(
      `INSERT INTO analytics_events (actor, event_type, project_id) VALUES ('test','f352_t6b',$1)`,
      [victim.id]
    );

    const nonEmpty = await projectHandler.deleteProject(victim.name, false);
    expect(nonEmpty.deleted).toBe(false);
    expect(nonEmpty.message).toContain('analytics_events');

    // ACTIVE-PROJECT refusal. The default session slot is process-global and shared with
    // every other file in this single-fork suite, so it is captured and restored exactly.
    const priorCurrent = await projectHandler.getCurrentProjectId();
    try {
      projectHandler.setCurrentProject(victim.id);
      const active = await projectHandler.deleteProject(victim.name, true);
      expect(active.deleted).toBe(false);
      expect(active.message).toContain('currently active project');
      expect(active.message).toContain('analytics_events');
    } finally {
      if (priorCurrent) projectHandler.setCurrentProject(priorCurrent);
    }

    // LAST-PROJECT refusal is driven through the same renderer; assert on the shape the
    // handler builds for it rather than emptying the shared CI database of projects.
    expect(describeProjectChildCounts(await countProjectChildren(victim.id))).toContain(
      'analytics_events'
    );

    await projectHandler.deleteProject(victim.name, true);
  });

  // ── T6c ───────────────────────────────────────────────────────────────────────────────
  // THE CROSS-SERVICE HALF. The Command UI's `DELETE /api/projects/:id` is
  // no longer a bare `DELETE FROM projects` — it delegates HERE, over HTTP, through
  // McpService. That consumer reads the MACHINE channel ONLY (`structuredContent`); the
  // prose `content[0].text` this route also returns is discarded before it ever sees it.
  //
  // So `structuredContent.message` is not decoration: it is the ONLY path by which the
  // schema-derived blast radius reaches a Command UI user. Delete that field and the
  // Command backend falls back to a generic "refused" sentence — it still REFUSES (the
  // safety property is intact), but the user is told a project cannot be deleted without
  // being told what deleting it would destroy, which is the whole point of the survey.
  // That is a silent degradation across a service boundary, and nothing on the Command
  // side can catch it: its own tests necessarily mock this transport. It is guarded here,
  // where the field is produced.
  //
  // Asserted against `result.message` from the handler rather than a hardcoded sentence, so
  // this pins the WIRING (same string, both channels) and cannot drift with the wording.
  test('T6c: a refusal carries its blast-radius sentence on the MACHINE channel, not only the prose one', async () => {
    const victim = await newProject('t6c-structured');
    await db.query(
      `INSERT INTO analytics_events (actor, event_type, project_id) VALUES ('test','faccf_t6c',$1)`,
      [victim.id]
    );

    // The route, not the handler — structuredContent is the route's to build.
    const response: any = await projectRoutes.handleDelete({ project: victim.name });

    expect(response.structuredContent.action).toBe('delete_refused');
    expect(response.structuredContent.deleted).toBe(false);
    expect(await projectExists(victim.id)).toBe(true); // refusing means refusing

    const prose = response.content[0].text as string;
    const machine = response.structuredContent.message as string;
    // ONE source, two channels — an echo, never a second rendering.
    expect(machine).toBe(prose);
    // …and it really is the schema-derived description, not a generic string that happens
    // to match on both channels.
    expect(machine).toContain('analytics_events');
    // The counts the consumer relays alongside it must describe the same table.
    expect(Object.keys(response.structuredContent.counts.byTable)).toContain('analytics_events');

    await projectHandler.deleteProject(victim.name, true);
  });

  // ── T6d ───────────────────────────────────────────────────────────────────────────────
  // The ACTIVE-PROJECT refusal is reached BEFORE the handler, in the route's own
  // session-scope guard, and it used to return the prose channel ONLY. A machine consumer
  // therefore got `ensureStructuredContent`'s synthesised `{ok:true}` — no action, no
  // reason — and could only fail closed into an opaque error. This asserts the refusal is
  // legible on the machine channel too, so the Command UI can tell the user the one thing
  // they can act on: switch project and retry.
  test('T6d: the ACTIVE-PROJECT refusal is machine-readable, not prose-only', async () => {
    const victim = await newProject('t6d-active');
    await db.query(
      `INSERT INTO analytics_events (actor, event_type, project_id) VALUES ('test','faccf_t6d',$1)`,
      [victim.id]
    );

    // The route reads the CONNECTION-scoped slot; drive it through the same default slot
    // the other tests use, captured and restored exactly (shared, process-global).
    const priorCurrent = await projectHandler.getCurrentProjectId();
    try {
      projectHandler.setCurrentProject(victim.id);
      const response: any = await projectRoutes.handleDelete({ project: victim.name });

      expect(response.structuredContent.action).toBe('delete_refused');
      expect(response.structuredContent.deleted).toBe(false);
      expect(response.structuredContent.reason).toBe('active_project');
      // Same string on both channels — no second rendering.
      expect(response.structuredContent.message).toBe(response.content[0].text);
      expect(response.structuredContent.message).toContain('active project for this session');
      // The blast radius is still measured and carried on this branch.
      expect(response.structuredContent.message).toContain('analytics_events');
      expect(Object.keys(response.structuredContent.counts.byTable)).toContain('analytics_events');
      expect(await projectExists(victim.id)).toBe(true);
    } finally {
      if (priorCurrent) projectHandler.setCurrentProject(priorCurrent);
    }

    await projectHandler.deleteProject(victim.name, true);
  });

  // ── T6e ───────────────────────────────────────────────────────────────────────────────
  // EVERY refusal says whether RETRYING CAN HELP. Only `needs_confirmation` can; the other
  // two are decided BEFORE the confirm gate, so `confirm: true` returns the identical
  // refusal. A consumer outside MCP (the Command UI) sets a
  // `requiresConfirmation` flag from this, and when the last-remaining-project branch
  // carried NO reason that consumer told users to retry with confirmation — measured
  // returning the same refusal on `confirm: true`. A missing reason is not a cosmetic gap;
  // it is a machine field that lies one layer downstream.
  //
  // The retryable case is asserted BEHAVIOURALLY (the confirmed retry actually deletes),
  // so 'needs_confirmation' cannot be a label that merely looks right.
  test('T6e: every refusal carries a reason, and only needs_confirmation is actually retryable', async () => {
    const victim = await newProject('t6e-reasons');
    await db.query(
      `INSERT INTO analytics_events (actor, event_type, project_id) VALUES ('test','faccf_t6e',$1)`,
      [victim.id]
    );

    // 1. RETRYABLE — non-empty without confirm.
    const unconfirmed = await projectHandler.deleteProject(victim.name, false);
    expect(unconfirmed.deleted).toBe(false);
    expect(unconfirmed.reason).toBe('needs_confirmation');

    // 2. FUTILE — active project. Asserted on the CONFIRMED call, because that is the one
    //    that proves confirming does not help.
    const priorCurrent = await projectHandler.getCurrentProjectId();
    try {
      projectHandler.setCurrentProject(victim.id);
      const active = await projectHandler.deleteProject(victim.name, true);
      expect(active.deleted).toBe(false);
      expect(active.reason).toBe('active_project');
    } finally {
      if (priorCurrent) projectHandler.setCurrentProject(priorCurrent);
    }

    // 3. The retryable one really is retryable — the label is not decoration.
    const confirmed = await projectHandler.deleteProject(victim.name, true);
    expect(confirmed.deleted).toBe(true);
    expect(confirmed.reason).toBeUndefined(); // success carries none
    expect(await projectExists(victim.id)).toBe(false);
  });

  // ── T6f ───────────────────────────────────────────────────────────────────────────────
  // THE LAST-REMAINING-PROJECT refusal — the branch that shipped with NO reason and became
  // the live victim of the old fail-open whitelist downstream (reported as retryable while
  // `confirm: true` returned the identical refusal).
  //
  // Driven by stubbing `listProjects` rather than by actually emptying the database: this
  // suite shares one CI Postgres with every other file, and deleting every project to reach
  // this branch would be a destructive, order-dependent side effect on all of them. The
  // stub targets exactly the input the guard reads (`allProjects.length <= 1`), and the
  // refusal it produces is the real one, from the real handler.
  test('T6f: the last-remaining-project refusal is reported as FUTILE, not as retryable', async () => {
    const victim = await newProject('t6f-last');
    await db.query(
      `INSERT INTO analytics_events (actor, event_type, project_id) VALUES ('test','faccf_t6f',$1)`,
      [victim.id]
    );

    const spy = vi
      .spyOn(projectHandler, 'listProjects')
      .mockResolvedValue([{ id: victim.id, name: victim.name }] as any);
    try {
      // Asserted on the CONFIRMED call: that is the one that proves confirming cannot help,
      // and it is the case the downstream flag got wrong.
      const refused = await projectHandler.deleteProject(victim.name, true);
      expect(refused.deleted).toBe(false);
      expect(refused.reason).toBe('last_project');
      expect(refused.reason).not.toBe('needs_confirmation');
      expect(refused.message).toContain('last remaining project');
      expect(await projectExists(victim.id)).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // ANTI-VACUOUS: with the stub gone the SAME call proceeds, so the refusal above was
    // produced by the guard under test and not by some unrelated failure.
    expect((await projectHandler.deleteProject(victim.name, true)).deleted).toBe(true);
    expect(await projectExists(victim.id)).toBe(false);
  });

  // ── T7 ────────────────────────────────────────────────────────────────────────────────
  test('T7: the compiler refuses a hand-written child-table list (brand)', () => {
    // THE PRE-FIX SHAPE. `ProjectChildCounts` is branded, so this literal — the exact thing
    // the old code built and the delete gate consumed — cannot be constructed outside
    // projectCascade.buildChildCounts(). If the brand is ever dropped, this line stops
    // erroring and `tsc --noEmit` reports the UNUSED @ts-expect-error: the guard turns RED
    // when it is weakened, instead of silently permitting the shape again.
    // @ts-expect-error — a hand-enumerated counts object must not typecheck.
    const forged: import('../types/project.js').ProjectChildCounts = {
      byTable: { contexts: 0, technical_decisions: 0, tasks: 0, sessions: 0 },
      total: 0,
      unmeasurable: [],
    };
    expect(isProjectEmpty(forged)).toBe(true); // (runtime shape is fine; the COMPILER is the guard)
  });
});
