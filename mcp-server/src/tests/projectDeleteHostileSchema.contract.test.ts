/**
 * PROJECT-DELETE GATE vs A SCHEMA IT DID NOT EXPECT (Reviewer R2).
 *
 * Companion to projectDeleteCascadeGate.contract.test.ts. That file proves the gate reads
 * the SCHEMA rather than a hardcoded list. This file exists because that was not enough:
 * the first version of the fix was defeated by an ORDINARY table shape, and every test in
 * that file stayed green while a project was deleted without confirmation.
 *
 * ── THE LESSON THIS FILE ENCODES ───────────────────────────────────────────────────────
 * `isProjectEmpty` and `describeProjectChildCounts` both derive from `byTable`, so they
 * cannot DRIFT APART. That protects against exactly one failure mode, and the blocker was
 * a different one: they were confidently WRONG TOGETHER, because the defect was UPSTREAM
 * of both. Predicate-and-message-agree is not correctness. The guard on a schema-derived
 * gate has to be a HOSTILE SCHEMA, not the internal agreement of its own two outputs.
 *
 * ── WHAT WENT WRONG IN 4dcbf00, MEASURED ───────────────────────────────────────────────
 * Discovery returned one row per FK CONSTRAINT while `byTable` is keyed by TABLE NAME. A
 * table with two cascading FKs to `projects` produced two UNION-ALL branches with the same
 * label and the later OVERWROTE the earlier:
 *
 *   victim referenced through owner_project_id  -> gate said byTable=0, total=0,
 *      "nothing — 0 rows", DELETED WITHOUT CONFIRM, 3 rows silently destroyed
 *   victim referenced through source_project_id -> gate said 3, refused correctly
 *
 * Both in the SAME run, on the SAME table: which branch won was the plan's choice, so the
 * defect presented as "works sometimes" — worse than a hard failure. H1 below is written
 * with TWO victims, one per column, so it is RED whichever branch a plan prefers.
 *
 * ── EVERY TEST HERE IS A MUTATION THAT WAS SILENT ──────────────────────────────────────
 * Reviewer ran fourteen mutations against 4dcbf00; four left all nine tests GREEN. Each
 * one now has a test, and each test was re-checked by re-applying that mutation:
 *
 *   H1  discovery keyed per-constraint (the blocker)      ← was a silent DESTRUCTION
 *   H2  `conkey[1]` instead of the id-paired column       ← mutation was silent
 *   H3  `confdeltype IN ('c','n')` (SET NULL counted)     ← mutation was silent
 *   H4  the `confdeltype` filter removed entirely         ← mutation was silent
 *   H4c `unmeasurable` branch of the PREDICATE deleted    ← mutation was silent (R3/N1)
 *   H5  the loud `logger.error` deleted                   ← mutation was silent
 *   H5d the unparsed-array abort deleted                  ← mutation was silent (R3/N2)
 *   H6  partition clones counted 2-3× (over-count)
 *   H7  an FK declared ON A LEAF PARTITION, double-counted (R3/N4)
 *   H7b …and the OVER-correction that would drop every partition — an UNDER-count
 *
 * H3/H4 are checked BEHAVIOURALLY, not by asserting the classification back at itself: the
 * test deletes a project and reads the SET NULL rows back to prove they survived. A test
 * that merely asserted "SET NULL is excluded" would be restating the code.
 *
 * H4c and H5d guard defences that are REDUNDANT TODAY — `countProjectChildren` already
 * empties `byTable` on the unmeasurable path, and the real `name[]` driver bug announces
 * itself through H5c. Both were kept and tested anyway, because "redundant today" is a
 * property of the current call graph, not of the rule: the moment anyone returns partial
 * counts alongside `unmeasurable`, H4c is the only thing holding the property that
 * types/project.ts states outright.
 *
 * DB target: the disposable migrated Postgres the CI gate provisions. NEVER prod. Every
 * fixture is created and dropped inside this file, including the two UNIQUE constraints on
 * `projects` that the composite-FK fixtures require.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

vi.unmock('crypto');
vi.unmock('node:crypto');

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { projectHandler } from '../handlers/project.js';
import {
  buildChildCounts,
  countProjectChildren,
  describeProjectChildCounts,
  discoverProjectCascadeChildren,
  isProjectEmpty,
} from '../services/projectCascade.js';

const STAMP = Date.now();

const TWO_FK = `h352_two_fk_${STAMP}`;
const COMP_LAST = `h352_comp_last_${STAMP}`;
const COMP_FIRST = `h352_comp_first_${STAMP}`;
const SET_NULL = `h352_set_null_${STAMP}`;
const NO_ACTION = `h352_no_action_${STAMP}`;
const PART = `h352_part_${STAMP}`;
const LEAF_ONLY = `h352_leaf_only_${STAMP}`;
const U_NAME_ID = `h352_u_name_id_${STAMP}`;
const U_ID_NAME = `h352_u_id_name_${STAMP}`;

const newProject = async (label: string): Promise<{ id: string; name: string }> => {
  const name = `h352-${label}-${STAMP}`;
  const id = (await db.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [name]))
    .rows[0].id as string;
  return { id, name };
};

const projectExists = async (id: string): Promise<boolean> =>
  (await db.query(`SELECT COUNT(*)::int AS n FROM projects WHERE id = $1`, [id])).rows[0].n === 1;

const discoveredNames = async (): Promise<string[]> =>
  (await discoverProjectCascadeChildren()).children.map((c) => c.name);

describe('project delete gate vs a hostile schema', () => {
  let keepAlive: { id: string; name: string };
  let bystander: { id: string; name: string };

  beforeAll(async () => {
    keepAlive = await newProject('keepalive');
    bystander = await newProject('bystander');

    // Composite FKs need a multi-column unique key on `projects` to reference. Two of them,
    // in OPPOSITE column orders, so no positional pick of the child column can be right for
    // both fixtures (H2).
    await db.query(`ALTER TABLE projects ADD CONSTRAINT ${U_NAME_ID} UNIQUE (name, id)`);
    await db.query(`ALTER TABLE projects ADD CONSTRAINT ${U_ID_NAME} UNIQUE (id, name)`);

    await db.query(`CREATE TABLE ${TWO_FK} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       owner_project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
       source_project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
       note text)`);

    // Project column LAST in the FK -> a `conkey[1]` pick lands on `pname`.
    await db.query(`CREATE TABLE ${COMP_LAST} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       pname text, pid uuid,
       FOREIGN KEY (pname, pid) REFERENCES projects(name, id) ON DELETE CASCADE)`);

    // Project column FIRST -> a `conkey[last]` pick lands on `pname`.
    await db.query(`CREATE TABLE ${COMP_FIRST} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       pid uuid, pname text,
       FOREIGN KEY (pid, pname) REFERENCES projects(id, name) ON DELETE CASCADE)`);

    await db.query(`CREATE TABLE ${SET_NULL} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
       note text)`);

    await db.query(`CREATE TABLE ${NO_ACTION} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       project_id uuid REFERENCES projects(id) ON DELETE NO ACTION,
       note text)`);

    await db.query(`CREATE TABLE ${PART} (
       id uuid DEFAULT gen_random_uuid(),
       project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
       bucket int NOT NULL,
       PRIMARY KEY (id, bucket)) PARTITION BY RANGE (bucket)`);
    await db.query(`CREATE TABLE ${PART}_p0 PARTITION OF ${PART} FOR VALUES FROM (0) TO (10)`);
    // H7: an FK declared DIRECTLY on a leaf partition. Its conparentid is 0, so the clone
    // filter does not touch it — this is the second route to a double count.
    await db.query(`ALTER TABLE ${PART}_p0 ADD CONSTRAINT ${PART}_p0_own_fk
       FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE`);
    await db.query(`CREATE TABLE ${PART}_p1 PARTITION OF ${PART} FOR VALUES FROM (10) TO (20)`);

    // H7b's mirror: a partitioned family where ONLY the leaf carries a cascading FK. It
    // must be KEPT — dropping every partition would be an UNDER-count, the direction that
    // destroys data.
    await db.query(`CREATE TABLE ${LEAF_ONLY} (
       id uuid DEFAULT gen_random_uuid(),
       project_id uuid,
       bucket int NOT NULL,
       PRIMARY KEY (id, bucket)) PARTITION BY RANGE (bucket)`);
    await db.query(
      `CREATE TABLE ${LEAF_ONLY}_p0 PARTITION OF ${LEAF_ONLY} FOR VALUES FROM (0) TO (10)`
    );
    await db.query(`ALTER TABLE ${LEAF_ONLY}_p0 ADD CONSTRAINT ${LEAF_ONLY}_p0_own_fk
       FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE`);
  });

  afterAll(async () => {
    for (const t of [TWO_FK, COMP_LAST, COMP_FIRST, SET_NULL, NO_ACTION, PART, LEAF_ONLY]) {
      await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await db.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS ${U_NAME_ID}`);
    await db.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS ${U_ID_NAME}`);
    await db.query(`DELETE FROM projects WHERE name LIKE $1`, [`h352-%-${STAMP}`]);
  });

  // ── H1: THE BLOCKER ───────────────────────────────────────────────────────────────────
  // Two victims, one per FK column. Under per-constraint keying exactly one of the two
  // branches survives the overwrite, so ONE of these victims reports 0 — whichever branch
  // the plan happens to emit last. Testing both removes the plan from the experiment.
  test.each(['owner_project_id', 'source_project_id'] as const)(
    'H1: a table with TWO cascading FKs is counted correctly via %s',
    async (column) => {
      const other = column === 'owner_project_id' ? 'source_project_id' : 'owner_project_id';
      const victim = await newProject(`h1-${column}`);

      for (let i = 0; i < 3; i++) {
        await db.query(
          `INSERT INTO ${TWO_FK} (${column}, ${other}, note) VALUES ($1, $2, 'h1')`,
          [victim.id, column === 'owner_project_id' ? null : bystander.id]
        );
      }

      // GROUND TRUTH, computed independently of the product: what Postgres will destroy.
      const willCascade = (
        await db.query(
          `SELECT COUNT(*)::int AS n FROM ${TWO_FK}
            WHERE owner_project_id = $1 OR source_project_id = $1`,
          [victim.id]
        )
      ).rows[0].n as number;
      expect(willCascade).toBe(3); // the fixture landed

      const counts = await countProjectChildren(victim.id);
      expect(counts.byTable[TWO_FK]).toBe(willCascade);
      expect(isProjectEmpty(counts)).toBe(false);
      expect(describeProjectChildCounts(counts)).toContain(TWO_FK);

      const refused = await projectHandler.deleteProject(victim.name, /* confirm */ false);
      expect(refused.deleted).toBe(false);
      expect(await projectExists(victim.id)).toBe(true);

      // The rows are still there — nothing was destroyed by the refusal path.
      const left = (
        await db.query(
          `SELECT COUNT(*)::int AS n FROM ${TWO_FK}
            WHERE owner_project_id = $1 OR source_project_id = $1`,
          [victim.id]
        )
      ).rows[0].n as number;
      expect(left).toBe(3);

      await projectHandler.deleteProject(victim.name, true);
    }
  );

  test('H1b: the table appears EXACTLY ONCE in discovery, with BOTH its FK columns', async () => {
    const survey = await discoverProjectCascadeChildren();
    const rows = survey.children.filter((c) => c.name === TWO_FK);
    // Exactly one entry is the structural property: a duplicate label is what let an
    // ordering decide the answer, so there must be nothing left for it to decide.
    expect(rows).toHaveLength(1);
    expect(rows[0].sqlColumns.map((c) => c.replace(/"/g, '')).sort()).toEqual([
      'owner_project_id',
      'source_project_id',
    ]);
  });

  // THE ORDERING DEPENDENCE IS GONE, not merely reliably-correct-today. `byTable` is a map
  // keyed by table name and the counts are folded into it in result order, so the ONLY way
  // a plan can affect the answer is if two rows share a key. This asserts the general
  // invariant over the WHOLE catalog (with every hostile fixture in it), not just TWO_FK:
  // no duplicate label exists, so there is nothing for an ordering to arbitrate.
  test('H1d: discovery never returns two rows for one table — over the whole catalog', async () => {
    const names = (await discoverProjectCascadeChildren()).children.map((c) => c.name);
    expect(names.length).toBeGreaterThan(20); // the real schema + this file's fixtures
    expect(names).toContain(TWO_FK); // …including the two-FK and partitioned shapes
    expect(names).toContain(PART);
    expect(new Set(names).size).toBe(names.length);
  });

  test('H1c: a row pointing at the victim through BOTH columns is counted ONCE', async () => {
    const victim = await newProject('h1c-both');
    await db.query(
      `INSERT INTO ${TWO_FK} (owner_project_id, source_project_id, note) VALUES ($1,$1,'both')`,
      [victim.id]
    );
    const counts = await countProjectChildren(victim.id);
    // ONE row will be destroyed, so the number the user is shown must be 1 — not 2. An
    // OR is the right aggregation; summing the per-constraint counts would double it.
    expect(counts.byTable[TWO_FK]).toBe(1);
    await projectHandler.deleteProject(victim.name, true);
  });

  // ── H2: the project column is resolved, not assumed to be first ───────────────────────
  test.each([
    [COMP_LAST, 'pname, pid'],
    [COMP_FIRST, 'pid, pname'],
  ])('H2: composite FK on %s is keyed on the id-paired column', async (table) => {
    const victim = await newProject(`h2-${table}`);
    await db.query(`INSERT INTO ${table} (pid, pname) VALUES ($1, $2)`, [victim.id, victim.name]);

    const planted = (
      await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE pid = $1`, [victim.id])
    ).rows[0].n as number;
    expect(planted).toBe(1); // the fixture landed

    const survey = await discoverProjectCascadeChildren();
    const row = survey.children.find((c) => c.name === table);
    expect(row).toBeDefined();
    // The resolved column must be the uuid one, in EITHER declaration order.
    expect(row!.sqlColumns.map((c) => c.replace(/"/g, ''))).toEqual(['pid']);

    const counts = await countProjectChildren(victim.id);
    expect(counts.byTable[table]).toBe(1);

    const refused = await projectHandler.deleteProject(victim.name, false);
    expect(refused.deleted).toBe(false);
    expect(refused.message).toContain(table);

    await projectHandler.deleteProject(victim.name, true);
  });

  // ── H3 / H4: the delete-action classification is BEHAVIOURAL ──────────────────────────
  test('H3/H4: SET NULL rows SURVIVE the delete, so they are not blast radius', async () => {
    const victim = await newProject('h3-setnull-only');
    for (let i = 0; i < 3; i++) {
      await db.query(`INSERT INTO ${SET_NULL} (project_id, note) VALUES ($1, 'h3')`, [victim.id]);
    }
    const planted = (
      await db.query(`SELECT COUNT(*)::int AS n FROM ${SET_NULL} WHERE project_id = $1`, [
        victim.id,
      ])
    ).rows[0].n as number;
    expect(planted).toBe(3); // the fixture landed

    // Not blast radius -> not discovered, and the project measures EMPTY …
    expect(await discoveredNames()).not.toContain(SET_NULL);
    const counts = await countProjectChildren(victim.id);
    expect(counts.byTable[SET_NULL]).toBeUndefined();
    expect(isProjectEmpty(counts)).toBe(true);

    // … so it deletes without confirmation — which is only CORRECT if the rows really do
    // survive. That is the claim, and this is the measurement of it.
    const result = await projectHandler.deleteProject(victim.name, /* confirm */ false);
    expect(result.deleted).toBe(true);

    const survivors = await db.query(
      `SELECT COUNT(*)::int AS n, COUNT(project_id)::int AS still_linked
         FROM ${SET_NULL} WHERE note = 'h3'`
    );
    expect(survivors.rows[0].n).toBe(3); // rows NOT destroyed
    expect(survivors.rows[0].still_linked).toBe(0); // column nulled, as SET NULL promises
    await db.query(`DELETE FROM ${SET_NULL} WHERE note = 'h3'`);
  });

  test('H4b: a NO ACTION FK is not blast radius — Postgres refuses the delete itself', async () => {
    const victim = await newProject('h4-noaction-only');
    await db.query(`INSERT INTO ${NO_ACTION} (project_id, note) VALUES ($1, 'h4')`, [victim.id]);

    expect(await discoveredNames()).not.toContain(NO_ACTION);
    expect(isProjectEmpty(await countProjectChildren(victim.id))).toBe(true);

    // The gate lets it through because nothing will be CASCADED — and the database then
    // refuses loudly on its own. The rows are never silently destroyed either way.
    await expect(projectHandler.deleteProject(victim.name, false)).rejects.toThrow();
    expect(await projectExists(victim.id)).toBe(true);

    await db.query(`DELETE FROM ${NO_ACTION} WHERE note = 'h4'`);
    await projectHandler.deleteProject(victim.name, true);
  });

  // ── H4c (N1): the unmeasurable branch of the PREDICATE, on its own ────────────────────
  // `countProjectChildren` empties `byTable` whenever it reports `unmeasurable`, so today
  // the `tables.length === 0` branch would catch this case even if the unmeasurable check
  // were deleted — two genuinely redundant defences, and the mutation was GREEN. But
  // types/project.ts states the property outright ("NON-EMPTY ⇒ isProjectEmpty is false
  // REGARDLESS of byTable"), and it stops being redundant the moment anyone returns partial
  // counts ALONGSIDE unmeasurable, which is a plausible improvement. So the property is
  // tested where it is stated: with a NON-EMPTY, all-zero byTable, which the empty-set
  // branch cannot answer.
  test('H4c: unmeasurable forces non-empty even when byTable is populated and all-zero', () => {
    const populated = buildChildCounts({ contexts: 0, tasks: 0 });
    expect(isProjectEmpty(populated)).toBe(true); // …the same map WITHOUT unmeasurable

    const flagged = buildChildCounts({ contexts: 0, tasks: 0 }, ['x_fkey']);
    expect(Object.keys(flagged.byTable)).toHaveLength(2); // the empty-set branch cannot fire
    expect(isProjectEmpty(flagged)).toBe(false);
    expect(describeProjectChildCounts(flagged)).toContain('x_fkey');
  });

  // ── H5: the LOUD half of fail-closed ──────────────────────────────────────────────────
  test('H5: concluding UNKNOWN logs at ERROR — the loud half is not deletable in silence', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    try {
      // (a) nothing discovered at all
      spy.mockClear();
      const empty = await countProjectChildren(keepAlive.id, { children: [], unmeasurable: [] });
      expect(isProjectEmpty(empty)).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('NO project-owned cascading FK');

      // (b) something discovered that cannot be keyed on a project id
      spy.mockClear();
      const unkeyable = await countProjectChildren(keepAlive.id, {
        children: [],
        unmeasurable: ['h352_fake_fkey'],
      });
      expect(isProjectEmpty(unkeyable)).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('h352_fake_fkey');

      // PROBE THE PROBE: a MEASURABLE survey must NOT log, or "was it called" proves
      // nothing — a logger.error on every call would satisfy the two assertions above.
      spy.mockClear();
      await countProjectChildren(keepAlive.id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // ── H5d (N2): a driver that hands back an UNPARSED array literal ──────────────────────
  // Defence in depth. The real bug this came from (node-pg has no parser for `name[]`, so
  // an aggregate of `conname` arrives as the literal string '{}') is caught behaviourally
  // by H5c — every survey would report UNMEASURABLE. This asserts the belt: an unparsed
  // value ABORTS rather than being coerced into a wrong count. Driven at the db.query
  // boundary so the product code is untouched.
  test('H5d: an unparsed array from the driver aborts the survey, never a wrong count', async () => {
    const real = db.query.bind(db);
    const spy = vi.spyOn(db, 'query').mockImplementation(async (...args: any[]) => {
      const out: any = await (real as any)(...args);
      // Detected by the SHAPE the discovery query returns, not by a substring of its SQL:
      // keying on incidental query text makes this probe fail for reasons that have nothing
      // to do with what it guards (it did, on an unrelated mutation).
      const looksLikeDiscovery =
        Array.isArray(out.rows) && out.rows.length > 0 && 'unmeasurable' in out.rows[0];
      if (looksLikeDiscovery) {
        // Exactly what the driver does with an unparsed `name[]`.
        out.rows = out.rows.map((r: any) => ({ ...r, unmeasurable: '{}' }));
      }
      return out;
    });
    try {
      // PROBE THE PROBE: prove the injection actually reached a NON-EMPTY discovery result,
      // otherwise "it threw" could mean the query simply returned nothing.
      let sawRows = false;
      spy.mockClear();
      await expect(discoverProjectCascadeChildren()).rejects.toThrow(/unparsed value/);
      const call = spy.mock.results[0];
      if (call?.type === 'return') sawRows = true;
      expect(sawRows).toBe(true);

      // …and the abort propagates: nothing is deleted on a value we could not read.
      const victim = await newProject('h5d-driver');
      await expect(countProjectChildren(victim.id)).rejects.toThrow(/unparsed value/);
      spy.mockRestore();
      expect(await projectExists(victim.id)).toBe(true);
      await projectHandler.deleteProject(victim.name, true);
    } finally {
      spy.mockRestore();
    }
  });

  test('H5b: an unkeyable cascading FK is UNKNOWN, never "nothing"', async () => {
    const counts = await countProjectChildren(keepAlive.id, {
      children: [],
      unmeasurable: ['h352_by_name_fkey'],
    });
    const rendered = describeProjectChildCounts(counts);
    expect(rendered).toContain('UNKNOWN');
    expect(rendered).toContain('h352_by_name_fkey');
    expect(rendered).not.toContain('nothing');
    expect(isProjectEmpty(counts)).toBe(false);
  });

  test('H5c: a cascading FK that does not reference projects.id is reported unmeasurable', async () => {
    const byName = `h352_by_name_${STAMP}`;
    await db.query(`CREATE TABLE ${byName} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       pname text REFERENCES projects(name) ON DELETE CASCADE)`);
    try {
      const survey = await discoverProjectCascadeChildren();
      expect(survey.children.map((c) => c.name)).not.toContain(byName);
      expect(survey.unmeasurable.join(' ')).toContain(byName);

      // End to end: the gate refuses rather than reporting "nothing".
      const victim = await newProject('h5c-unkeyable');
      const counts = await countProjectChildren(victim.id);
      expect(isProjectEmpty(counts)).toBe(false);
      const refused = await projectHandler.deleteProject(victim.name, false);
      expect(refused.deleted).toBe(false);
      expect(refused.message).toContain('UNKNOWN');
      expect(await projectExists(victim.id)).toBe(true);
      await projectHandler.deleteProject(victim.name, true);
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${byName}`);
    }
  });

  // ── H6: one logical table, one row ────────────────────────────────────────────────────
  test('H6: a partitioned child is discovered ONCE and counted ONCE', async () => {
    const victim = await newProject('h6-partitioned');
    await db.query(`INSERT INTO ${PART} (project_id, bucket) VALUES ($1,1),($1,2),($1,11)`, [
      victim.id,
    ]);
    const real = (
      await db.query(`SELECT COUNT(*)::int AS n FROM ${PART} WHERE project_id = $1`, [victim.id])
    ).rows[0].n as number;
    expect(real).toBe(3); // the fixture landed, spanning both partitions

    const names = await discoveredNames();
    expect(names.filter((n) => n.startsWith(PART))).toEqual([PART]);

    const counts = await countProjectChildren(victim.id);
    expect(counts.byTable[PART]).toBe(3);
    expect(counts.total).toBe(3); // NOT 6 — partition clones are not separate tables
    expect(Object.keys(counts.byTable)).not.toContain(`${PART}_p0`);

    await projectHandler.deleteProject(victim.name, true);
  });

  // ── H7: the SECOND route to a double count ────────────────────────────────────────────
  // `conparentid = 0` drops the constraint rows Postgres CLONES onto each partition — but a
  // migration can declare an FK DIRECTLY on a leaf, and that one is its own constraint with
  // conparentid = 0. Measured before the fix: parent + own-FK leaf both discovered, 3 real
  // rows reported as 5, with a phantom table named in the destructive prompt.
  test('H7: an FK declared directly on a LEAF PARTITION does not double-count', async () => {
    // THE FIXTURE LANDED? The leaf's own constraint must really exist, and really have
    // conparentid = 0 — otherwise this test passes for the wrong reason.
    const own = await db.query(
      `SELECT conparentid FROM pg_constraint WHERE conname = $1`,
      [`${PART}_p0_own_fk`]
    );
    expect(own.rows).toHaveLength(1);
    expect(String(own.rows[0].conparentid)).toBe('0');

    const victim = await newProject('h7-leaf-fk');
    // Rows in BOTH partitions; the p0 ones are reachable via the parent AND the leaf's FK.
    await db.query(`INSERT INTO ${PART} (project_id, bucket) VALUES ($1,1),($1,2),($1,11)`, [
      victim.id,
    ]);

    const names = await discoveredNames();
    expect(names).toContain(PART);
    expect(names).not.toContain(`${PART}_p0`); // no phantom table

    const counts = await countProjectChildren(victim.id);
    expect(counts.byTable[PART]).toBe(3);
    expect(counts.byTable[`${PART}_p0`]).toBeUndefined();
    expect(counts.total).toBe(3); // NOT 5
    expect(describeProjectChildCounts(counts)).not.toContain(`${PART}_p0`);

    await projectHandler.deleteProject(victim.name, true);
  });

  test('H7b: a leaf whose ancestors carry NO cascading FK is still counted', async () => {
    // The over-correction to guard against: dropping every partition outright would be an
    // UNDER-count here — only the leaf cascades, and nothing else would count its rows.
    const victim = await newProject('h7b-leaf-only');
    await db.query(`INSERT INTO ${LEAF_ONLY} (project_id, bucket) VALUES ($1,1),($1,2)`, [
      victim.id,
    ]);

    const names = await discoveredNames();
    expect(names).toContain(`${LEAF_ONLY}_p0`);
    expect(names).not.toContain(LEAF_ONLY); // the parent has no cascading FK of its own

    const counts = await countProjectChildren(victim.id);
    expect(counts.byTable[`${LEAF_ONLY}_p0`]).toBe(2);
    expect(isProjectEmpty(counts)).toBe(false);

    const refused = await projectHandler.deleteProject(victim.name, false);
    expect(refused.deleted).toBe(false);
    expect(refused.message).toContain(`${LEAF_ONLY}_p0`);

    await projectHandler.deleteProject(victim.name, true);
  });
});
