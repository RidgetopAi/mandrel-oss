/**
 * Unit tests for the UNIFIED navigation id resolver (utils/idResolver.ts).
 *
 * These exercise the REAL resolver logic — shape validation, the three-case
 * fail-closed contract, the redirect-url format, and the "never short-circuit a
 * full UUID" rule — with an INJECTED fake pool so the case classification is proven
 * deterministically without a live Postgres. The SQL itself (does the prefix LIKE
 * match the right rows) is proven separately against a real DB in
 * resolveNav.route.db.test.ts. No lying stubs: the fake pool only stands in for the
 * pg driver's row payload; every branch under test is the resolver's own code.
 */

import type { Pool } from 'pg';
import {
  resolveNavId,
  navQueryLimit,
  urlForRecord,
  isResolvableNavId,
  navIdRejectionReason,
  buildNavResolveSql,
  describeResolvableTypes,
  RESOLVABLE_TYPES,
  InvalidNavIdError,
  NavIdNotFoundError,
  AmbiguousNavIdError,
} from '../utils/idResolver';
import { allProjects, projectsScope } from '../services/projectListScope';

/** Build a fake pg Pool that records the last query and returns canned rows. */
function fakePool(rows: Array<{ id: string; type: string; title: string; is_punch?: boolean }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

const FULL_UUID = 'b822dfcb-1111-4111-8111-111111111111';

describe('urlForRecord', () => {
  it('builds /<type>s/<id> for EVERY resolvable type (matches the frontend detail routes)', () => {
    // Iterating RESOLVABLE_TYPES rather than listing three literals is the point: a
    // sixth type added to the enumeration is covered here automatically instead of
    // being silently untested.
    for (const type of RESOLVABLE_TYPES) {
      expect(urlForRecord(type, FULL_UUID)).toBe(`/${type}s/${FULL_UUID}`);
    }
    // Pin the concrete expectations too, so a rename of a type is a visible diff.
    expect(urlForRecord('decision', FULL_UUID)).toBe(`/decisions/${FULL_UUID}`);
    expect(urlForRecord('task', FULL_UUID)).toBe(`/tasks/${FULL_UUID}`);
    expect(urlForRecord('context', FULL_UUID)).toBe(`/contexts/${FULL_UUID}`);
    expect(urlForRecord('session', FULL_UUID)).toBe(`/sessions/${FULL_UUID}`);
    expect(urlForRecord('project', FULL_UUID)).toBe(`/projects/${FULL_UUID}`);
  });

  it('defaults to /tasks/<id> when isPunch is omitted (backward compatible)', () => {
    expect(urlForRecord('task', FULL_UUID)).toBe(`/tasks/${FULL_UUID}`);
  });

  it('routes a punch task to /punch/<id>', () => {
    expect(urlForRecord('task', FULL_UUID, true)).toBe(`/punch/${FULL_UUID}`);
  });

  it('a non-punch task still lands on /tasks/<id> — the control case', () => {
    expect(urlForRecord('task', FULL_UUID, false)).toBe(`/tasks/${FULL_UUID}`);
  });

  it('isPunch is ignored for every type but task (only a task can be a punch)', () => {
    for (const type of RESOLVABLE_TYPES) {
      if (type === 'task') continue;
      expect(urlForRecord(type, FULL_UUID, true)).toBe(`/${type}s/${FULL_UUID}`);
    }
  });
});

/**
 * THE POPULATION GUARD.
 *
 * The whole point of making the type list data was that the SQL must cover exactly the
 * enumeration — no type declared-but-unqueried (an id that silently 404s) and no table
 * queried-but-undeclared (a type the not-found message never admits to searching).
 * Reading the emitted SQL is the only way to assert that; the DB suites prove the rows
 * come back, this proves nothing was left out of the query in the first place.
 */
describe('buildNavResolveSql — the query covers EXACTLY the declared population', () => {
  const sql = () =>
    buildNavResolveSql({ projectScoped: false, snippetLen: 60, queryLimit: 25 });

  it('emits one branch per declared type, and no others', () => {
    const emitted = [...sql().matchAll(/'([a-z]+)' AS type/g)].map((m) => m[1]);
    expect(emitted.sort()).toEqual([...RESOLVABLE_TYPES].sort());
    expect(emitted).toHaveLength(RESOLVABLE_TYPES.length);
  });

  it('queries the real table for each type (sessions and projects included)', () => {
    for (const table of ['contexts', 'tasks', 'technical_decisions', 'sessions', 'projects']) {
      expect(sql()).toContain(`FROM ${table}`);
    }
  });

  it('every branch prefix-matches on the SAME bound $1 — no branch resolves by another rule', () => {
    const matches = sql().match(/REPLACE\(id::text, '-', ''\) LIKE \$1 \|\| '%'/g) ?? [];
    expect(matches).toHaveLength(RESOLVABLE_TYPES.length);
  });

  it('scopes PROJECTS on its own id, and every other type on project_id', () => {
    // The regression this pins: `projects` has NO project_id column, so a uniform
    // `AND project_id = $2` on every branch is a hard SQL error (a 500), not a miss.
    const scoped = buildNavResolveSql({ projectScoped: true, snippetLen: 60, queryLimit: 25 });
    const projectBranch = scoped
      .split('UNION ALL')
      .find((b) => b.includes("'project' AS type")) as string;
    expect(projectBranch).toContain('FROM projects');
    // `= ANY($2::uuid[])` since the scope is the caller's GRANT SET, not a
    // single project, and an EMPTY set is legitimately empty rather than unrestricted.
    expect(projectBranch).toContain('AND id = ANY($2::uuid[])');
    expect(projectBranch).not.toContain('project_id = ANY($2::uuid[])');

    // Every non-project branch still scopes on project_id.
    const others = scoped.split('UNION ALL').filter((b) => !b.includes("'project' AS type"));
    expect(others).toHaveLength(RESOLVABLE_TYPES.length - 1);
    for (const b of others) expect(b).toContain('AND project_id = ANY($2::uuid[])');
  });

  it('emits NO scope clause at all when unscoped (cross-project is the default)', () => {
    expect(sql()).not.toContain('$2');
  });

  it('computes is_punch from metadata.punch for task, and FALSE for every other type', () => {
    // The regression this pins: only a task can be a punch, so every
    // other branch must be a hardcoded FALSE, never accidentally derived from its own
    // (nonexistent) metadata column.
    const branches = sql().split('UNION ALL');
    const taskBranch = branches.find((b) => b.includes("'task' AS type")) as string;
    expect(taskBranch).toContain(`(metadata -> 'punch') IS NOT NULL AS is_punch`);

    const others = branches.filter((b) => !b.includes("'task' AS type"));
    expect(others).toHaveLength(RESOLVABLE_TYPES.length - 1);
    for (const b of others) expect(b).toContain('FALSE AS is_punch');
  });
});

describe('describeResolvableTypes — the not-found message names the real population', () => {
  it('renders the full enumeration as an English list', () => {
    expect(describeResolvableTypes()).toBe('context, task, decision, session, or project');
  });
  it('handles the degenerate populations without producing a broken sentence', () => {
    expect(describeResolvableTypes([])).toBe('no record type');
    expect(describeResolvableTypes(['task'])).toBe('task');
    expect(describeResolvableTypes(['task', 'context'])).toBe('task, or context');
  });
});

describe('NavIdNotFoundError — explains itself instead of being a bare 404', () => {
  it('names every searched type by default', () => {
    const err = new NavIdNotFoundError('deadbeef');
    for (const t of RESOLVABLE_TYPES) expect(err.detail).toContain(t);
    expect(err.searchedTypes).toEqual(RESOLVABLE_TYPES);
    expect(err.projectScoped).toBe(false);
    expect(err.detail).toContain('in any project');
  });

  it('says so when a project scope narrowed the search (the distinguishable case)', () => {
    const err = new NavIdNotFoundError('deadbeef', RESOLVABLE_TYPES, true);
    expect(err.projectScoped).toBe(true);
    expect(err.detail).toContain('project you scoped to');
    expect(err.detail).toContain('retry without ?project_id');
  });
});

describe('navIdRejectionReason — a rejected id says WHICH rule it broke', () => {
  it('returns null for resolvable shapes', () => {
    expect(navIdRejectionReason(FULL_UUID)).toBeNull();
    expect(navIdRejectionReason('b822dfcb')).toBeNull();
    expect(navIdRejectionReason('b822dfcb-1111')).toBeNull();
  });

  it('classifies too-short, not-hex, and empty distinctly', () => {
    expect(navIdRejectionReason('bbbb')).toBe('too-short');
    expect(navIdRejectionReason('zzzzzzzz')).toBe('not-hex');
    expect(navIdRejectionReason('')).toBe('empty');
    expect(navIdRejectionReason('   ')).toBe('empty'); // whitespace-only trims to ''
  });

  it('an all-dashes id is EMPTY, not too-short (do not send the user hunting for characters)', () => {
    expect(navIdRejectionReason('--------')).toBe('empty');
  });

  it('non-string input is rejected, not crashed on', () => {
    expect(navIdRejectionReason(undefined)).toBe('empty');
    expect(navIdRejectionReason(null)).toBe('empty');
    expect(navIdRejectionReason(12345678)).toBe('empty');
  });

  it('InvalidNavIdError carries the reason and an actionable sentence', () => {
    expect(new InvalidNavIdError('bbbb', 'too-short').detail).toContain('at least');
    expect(new InvalidNavIdError('zzzz', 'not-hex').detail).toContain('hexadecimal');
    expect(new InvalidNavIdError('', 'empty').detail).toContain('No id was supplied');
  });
});

describe('navQueryLimit (ambiguity floor — fail-open guard)', () => {
  it('floors the query limit at 2 so ambiguity is ALWAYS detectable, independent of the display cap', () => {
    // The correctness property: >1 match must be detectable. Coupling the query
    // LIMIT to the display-cap knob (maxCandidates) would let a cap of 0/1 return a
    // single row for an ambiguous prefix → a silent wrong-resolve (fail-open).
    expect(navQueryLimit(0)).toBe(2);
    expect(navQueryLimit(1)).toBe(2);
    expect(navQueryLimit(2)).toBe(2);
  });
  it('respects a larger display cap unchanged', () => {
    expect(navQueryLimit(25)).toBe(25);
    expect(navQueryLimit(100)).toBe(100);
  });
});

describe('resolveNavId wires the floored limit into the SQL', () => {
  it('emits a numeric LIMIT of at least 2', async () => {
    const { pool, calls } = fakePool([
      { id: FULL_UUID, type: 'decision', title: 'x' },
    ]);
    await resolveNavId(FULL_UUID, { pool, scope: allProjects });
    const m = calls[0].sql.match(/LIMIT\s+(\d+)/i);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(2);
  });
});

describe('isResolvableNavId (shape gate)', () => {
  it('accepts a full UUID', () => {
    expect(isResolvableNavId(FULL_UUID)).toBe(true);
  });
  it('accepts an 8-hex short id (the reference form) and a dashed partial', () => {
    expect(isResolvableNavId('b822dfcb')).toBe(true);
    expect(isResolvableNavId('b822dfcb-1111')).toBe(true);
  });
  it('rejects a too-short prefix (< 8 hex)', () => {
    expect(isResolvableNavId('b822df')).toBe(false);
  });
  it('rejects non-hex garbage and empty', () => {
    expect(isResolvableNavId('zzzzzzzz')).toBe(false);
    expect(isResolvableNavId('not-a-real-id!!')).toBe(false);
    expect(isResolvableNavId('')).toBe(false);
  });
});

describe('resolveNavId — fail-closed on malformed input (never touches the DB)', () => {
  it('throws InvalidNavIdError for non-hex garbage and does NOT query', async () => {
    const { pool, calls } = fakePool([]);
    await expect(resolveNavId('zzzzzzzz', { pool, scope: allProjects })).rejects.toBeInstanceOf(InvalidNavIdError);
    expect(calls).toHaveLength(0);
  });
  it('throws InvalidNavIdError for a too-short prefix and does NOT query', async () => {
    const { pool, calls } = fakePool([]);
    await expect(resolveNavId('abc123', { pool, scope: allProjects })).rejects.toBeInstanceOf(InvalidNavIdError);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveNavId — three-case contract', () => {
  it('0 matches → NavIdNotFoundError', async () => {
    const { pool } = fakePool([]);
    await expect(resolveNavId('deadbeef', { pool, scope: allProjects })).rejects.toBeInstanceOf(NavIdNotFoundError);
  });

  it('exactly 1 match (decision) → resolved with /decisions/<uuid> url', async () => {
    const { pool } = fakePool([{ id: FULL_UUID, type: 'decision', title: 'A decision' }]);
    const rec = await resolveNavId('b822dfcb', { pool, scope: allProjects });
    expect(rec).toEqual({
      type: 'decision',
      id: FULL_UUID,
      title: 'A decision',
      url: `/decisions/${FULL_UUID}`,
    });
  });

  it('exactly 1 match (task) → /tasks/<uuid>', async () => {
    const { pool } = fakePool([{ id: FULL_UUID, type: 'task', title: 'A task' }]);
    const rec = await resolveNavId('b822dfcb', { pool, scope: allProjects });
    expect(rec.type).toBe('task');
    expect(rec.url).toBe(`/tasks/${FULL_UUID}`);
  });

  it('exactly 1 match (task WITHOUT a punch contract) → /tasks/<uuid> — the control case', async () => {
    const { pool } = fakePool([
      { id: FULL_UUID, type: 'task', title: 'A plain task', is_punch: false },
    ]);
    const rec = await resolveNavId('b822dfcb', { pool, scope: allProjects });
    expect(rec.url).toBe(`/tasks/${FULL_UUID}`);
  });

  it('exactly 1 match (task carrying metadata.punch) → /punch/<uuid>, not /tasks/<uuid>', async () => {
    const { pool } = fakePool([
      { id: FULL_UUID, type: 'task', title: 'A punch', is_punch: true },
    ]);
    const rec = await resolveNavId('b822dfcb', { pool, scope: allProjects });
    expect(rec.type).toBe('task');
    expect(rec.url).toBe(`/punch/${FULL_UUID}`);
  });

  it('exactly 1 match (context) → /contexts/<uuid>', async () => {
    const { pool } = fakePool([{ id: FULL_UUID, type: 'context', title: 'milestone: hi' }]);
    const rec = await resolveNavId('b822dfcb', { pool, scope: allProjects });
    expect(rec.type).toBe('context');
    expect(rec.url).toBe(`/contexts/${FULL_UUID}`);
  });
});

describe('resolveNavId — ambiguity NEVER silently picks', () => {
  const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const ID_B = 'aaaaaaaa-2222-4222-8222-222222222222';

  it('>1 match → throws AmbiguousNavIdError listing ALL candidates (no resolved record)', async () => {
    const { pool } = fakePool([
      { id: ID_A, type: 'task', title: 'Task A' },
      { id: ID_B, type: 'decision', title: 'Decision B' },
    ]);

    // It must THROW — proving it does not return one of the matches.
    const result = await resolveNavId('aaaaaaaa', { pool, scope: allProjects }).then(
      (rec) => ({ resolved: rec }),
      (err) => ({ err }),
    );
    expect('resolved' in result).toBe(false);

    const err = (result as { err: unknown }).err;
    expect(err).toBeInstanceOf(AmbiguousNavIdError);
    const amb = err as AmbiguousNavIdError;
    expect(amb.candidates).toHaveLength(2);
    // Both candidates surfaced with their full id + correct per-type url.
    expect(amb.candidates).toEqual([
      { type: 'task', id: ID_A, title: 'Task A', url: `/tasks/${ID_A}` },
      { type: 'decision', id: ID_B, title: 'Decision B', url: `/decisions/${ID_B}` },
    ]);
  });

  it('a punch task among ambiguous candidates still gets its /punch/<id> url', async () => {
    const { pool } = fakePool([
      { id: ID_A, type: 'task', title: 'Punch A', is_punch: true },
      { id: ID_B, type: 'task', title: 'Plain task B', is_punch: false },
    ]);
    const err: AmbiguousNavIdError = await resolveNavId('aaaaaaaa', {
      pool,
      scope: allProjects,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousNavIdError);
    expect(err.candidates).toEqual([
      { type: 'task', id: ID_A, title: 'Punch A', url: `/punch/${ID_A}` },
      { type: 'task', id: ID_B, title: 'Plain task B', url: `/tasks/${ID_B}` },
    ]);
  });
});

describe('resolveNavId — a full UUID is NOT short-circuited (type must be discovered)', () => {
  it('queries the DB even for a full UUID, and binds the normalized (dash-stripped, lowercased) prefix', async () => {
    const { pool, calls } = fakePool([{ id: FULL_UUID, type: 'task', title: 'T' }]);
    await resolveNavId(FULL_UUID.toUpperCase(), { pool, scope: allProjects });
    expect(calls).toHaveLength(1); // proves no short-circuit
    // The bound $1 is the dash-stripped, lowercased hex of the full uuid.
    expect(calls[0].params[0]).toBe(FULL_UUID.replace(/-/g, '').toLowerCase());
  });

  it('adds the project scope as a bound param when projectId is given', async () => {
    const { pool, calls } = fakePool([{ id: FULL_UUID, type: 'task', title: 'T' }]);
    await resolveNavId('b822dfcb', { pool, scope: projectsScope(['proj-123']) });
    // The scope is bound as a uuid ARRAY now, so the param is the array, not the string.
    expect(calls[0].params).toEqual(['b822dfcb', ['proj-123']]);
    expect(calls[0].sql).toContain('project_id = ANY($2::uuid[])');
  });
});
