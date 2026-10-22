/**
 * getAvailableDatasets — the `allowedProjectIds` filter, against a real Postgres
 * (Reviewer F1 second half).
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 * `GET /api/embedding/list` is the one embedding route that may be UNSCOPED — the UI calls
 * it with no project to build its dataset picker. Unscoped used to mean EVERY project, so
 * any authenticated non-admin got a listing of every project's name and context count.
 * The fix added an `allowedProjectIds` argument and a `project_id = ANY($n::uuid[])`
 * branch.
 *
 * `grep -rln "getAvailableDatasets" src/__tests__` returned ONE file, and that was only a
 * jest.mock DEFINITION — so the SQL branch doing the actual filtering had zero coverage
 * anywhere. A route test cannot cover it: it stubs the service. Only a real query can.
 *
 * THE CASE THAT MATTERS MOST IS THE EMPTY ARRAY. `[]` and `null` are one keystroke apart
 * and mean opposite things:
 *     null → "all projects"          (an admin)
 *     []   → "no projects"           (a user with zero grants)
 * A truthiness test (`if (allowedProjectIds.length)`) would silently turn the second into
 * the first — a user with no grants seeing EVERYTHING. That is the exact shape of the bug
 * this whole task exists to close, so it is asserted directly rather than reasoned about.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getAvailableDatasets, ALL_PROJECTS } from '../services/embedding/datasets';
import { activeEmbeddingColumn, embedDim, vectorLiteral } from './helpers/embedGeometry';
import { describeDb } from './helpers/dbContractGate';

describeDb('getAvailableDatasets — allowedProjectIds filter (DB integration)', () => {
  let pool: Pool;
  const projectA = uuidv4();
  const projectB = uuidv4();
  const projectC = uuidv4();
  const nameA = `emb-scope-A-${projectA.slice(0, 8)}`;
  const nameB = `emb-scope-B-${projectB.slice(0, 8)}`;
  const nameC = `emb-scope-C-${projectC.slice(0, 8)}`;
  const USER = 'irrelevant-user-id'; // the service takes it but does not filter on it

  /** Ids of the projects this call actually returned. */
  const idsOf = async (
    scope: { projectId?: string },
    allowed: readonly string[] | typeof ALL_PROJECTS
  ): Promise<string[]> => {
    const rows = await getAvailableDatasets(USER, scope, allowed);
    return rows.map((r) => (r as unknown as { id: string }).id).sort();
  };

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { contractDbConfig, assertDbReachable } = require('./helpers/dbContractGate');
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);

    const col = activeEmbeddingColumn();
    // A non-null embedding is what makes a project appear as a dataset at all. Its geometry
    // comes from helpers/embedGeometry — never a length written by hand.
    const embedding = vectorLiteral();
    for (const [id, name] of [
      [projectA, nameA],
      [projectB, nameB],
      [projectC, nameC],
    ] as const) {
      await pool.query('INSERT INTO projects (id, name) VALUES ($1,$2)', [id, name]);
      await pool.query(
        `INSERT INTO contexts (id, project_id, context_type, content, ${col})
         VALUES ($1,$2,'discussion','embedding scope fixture',$3::vector)`,
        [uuidv4(), id, embedding]
      );
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM contexts WHERE project_id = ANY($1)', [
      [projectA, projectB, projectC],
    ]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1)', [[projectA, projectB, projectC]]);
    await pool.end();
  });

  it('ALL_PROJECTS (an admin) → every project with embeddings is visible', async () => {
    const ids = await idsOf({}, ALL_PROJECTS);
    expect(ids).toEqual(expect.arrayContaining([projectA, projectB, projectC]));
  });

  // T1: `dimensions` is rendered by the Command UI. It was a hardcoded literal until
  // 2026-08-19 and no test read the field, so the whole suite stayed green while it
  // reported a width no stored row has had since the gemma cutover.
  it('the dimensions field TRACKS the active embedder — it is not a constant', async () => {
    const rows = await getAvailableDatasets(USER, {}, ALL_PROJECTS);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.dimensions)).toBe(embedDim());
    }
  });

  it('a granted subset → ONLY those projects, and the others are absent', async () => {
    const ids = await idsOf({}, [projectA, projectC]);
    expect(ids).toEqual(expect.arrayContaining([projectA, projectC]));
    // The half that matters: the ungranted project must not merely be "not asserted", it
    // must be absent.
    expect(ids).not.toContain(projectB);
  });

  it('a single granted project → only that one', async () => {
    const ids = await idsOf({}, [projectB]);
    expect(ids).toContain(projectB);
    expect(ids).not.toContain(projectA);
    expect(ids).not.toContain(projectC);
  });

  it('THE EMPTY ARRAY → NOTHING. Zero grants must not mean "everything"', async () => {
    // `= ANY('{}'::uuid[])` is legitimately empty, so this needs no special case — but it
    // does need to not be written as `if (allowedProjectIds.length)`, which would fall
    // through to the unfiltered query. This assertion is the difference between a
    // zero-grant user seeing nothing and seeing every project on the box.
    const ids = await idsOf({}, []);
    expect(ids).toEqual([]);
  });

  it('empty [] and ALL_PROJECTS are NOT interchangeable — opposite meanings', async () => {
    const withAll = await idsOf({}, ALL_PROJECTS);
    const withEmpty = await idsOf({}, []);
    expect(withEmpty).toEqual([]);
    expect(withAll.length).toBeGreaterThan(0);
    expect(withEmpty).not.toEqual(withAll);
  });

  it('an explicit scope wins, and the allow-set does not widen it', async () => {
    // A scoped request already passed the resolver's authorization, so the scope is the
    // answer; the allow-set is only the fallback for an UNSCOPED read. Passing a wider
    // allow-set must not add projects back.
    const ids = await idsOf({ projectId: projectA }, [projectA, projectB, projectC]);
    expect(ids).toEqual([projectA]);
  });

  it('a scope the caller could not reach still returns only that scope, never a fallback', async () => {
    // Defensive: even with an allow-set that excludes it, an explicit scope does not
    // silently degrade to "show them their own projects instead" — it shows that project
    // or nothing. Authorization is the resolver's job and has already happened.
    const ids = await idsOf({ projectId: projectB }, [projectA]);
    expect(ids).toEqual([projectB]);
  });

  it('the unrestricted mode must be SPELLED — omission is a compile error, not a default (J3)', async () => {
    // WHAT USED TO BE HERE was a test asserting that omitting the third argument defaulted
    // to null, i.e. to "every project". That test was GUARDING THE BAD STATE: F1's entire
    // mechanism was the argument being dropped at the call site, and a default of null is
    // what made dropping it catastrophic instead of merely wrong. It is deleted.
    //
    // The parameter is now REQUIRED, so `getAvailableDatasets(USER, {})` does not compile —
    // which is the real assertion and cannot be made at runtime. What IS assertable here is
    // that the dangerous mode is a distinct, legible value rather than the absence of one,
    // and that it is not something an empty array can be mistaken for.
    expect(ALL_PROJECTS).toBe('ALL_PROJECTS');
    expect(ALL_PROJECTS).not.toEqual([]);
    const unrestricted = await idsOf({}, ALL_PROJECTS);
    const noGrants = await idsOf({}, []);
    expect(unrestricted.length).toBeGreaterThan(0);
    expect(noGrants).toEqual([]);
  });
});
