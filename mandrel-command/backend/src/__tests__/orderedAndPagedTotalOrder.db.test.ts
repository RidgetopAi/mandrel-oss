/**
 * ORDERED-AND-PAGED SURFACES MUST CARRY A TOTAL ORDER — Command backend.
 *
 * The MCP-server half of this class shipped in batch 8
 * (mcp-server/src/tests/searchOrderTotal.contract.test.ts). This file is the Command-backend
 * sibling and reuses that file's construction deliberately.
 *
 * THE DEFECT. `ORDER BY <key> DESC` where `<key>` is not unique is a PARTIAL order: rows that
 * share the key have no defined relative position, so Postgres may return them in any order —
 * and does, depending on the plan and the heap. Consumed with LIMIT/OFFSET paging, page 1 and
 * page 2 are two INDEPENDENT sorts of the same tied block, so a reader paging through can see
 * one row twice and never see another. Nothing raises an error. Recall is the signature
 * product; a silently dropped row is a recall defect.
 *
 * THE FIX UNDER TEST, applied at five sites: append the PRIMARY KEY after the existing sort
 * key. Unique (the composite becomes total), STABLE (a PK does not move when the row is
 * updated, so a page boundary cannot shift under a concurrent write — which is why the
 * tiebreaker is never `updated_at`), and cheap (the PK btree already exists).
 *
 * ★ WHICH PROBES HAVE TEETH — measured under mutation (all five tiebreakers removed, product
 * restored to its pre-fix text), not assumed. Read this before trusting a green run.
 *   - `two physical orders` is the REPRODUCTION of the ORIGINAL symptom: the SAME logical pair
 *     seeded TWICE in opposite insertion sequence, asserting the same row ranks first both
 *     times. A single-order fixture cannot catch that at all — on a small tied population a
 *     scan returns rows in heap order, so one insertion order passes every time. MEASURED: 6
 *     of the 7 two-order probes go RED under mutation.
 *   - ★ THE SEVENTH DOES NOT, AND THAT IS A PROPERTY OF THE SITE, NOT OF THE FIXTURE.
 *     `GitService.queryCommitsByMetadata` runs `SELECT DISTINCT gc.*`, and the planner answers
 *     it with a HashAggregate (measured: `EXPLAIN` gives Index Scan -> HashAggregate -> Sort).
 *     A hash aggregate's output order is a function of the row HASHES, so insertion order is
 *     not a lever there at all: under mutation that probe returned the same label in both
 *     orders on one run and different labels on the next. It is retained for the symmetry of
 *     the population, but it is NOT what guards that site — `expectPkOrder` is.
 *   - `paging` probes assert BOTH exactly-once AND `expectPkOrder`. The exactly-once half
 *     alone is a REGRESSION FLOOR, not a reproduction — L3 measured the equivalent probes
 *     GREEN with the tiebreakers removed, and so did this file before `expectPkOrder` was
 *     added (5 of 5 GREEN under mutation). With `expectPkOrder` the paging probes go RED on
 *     all five sites, which is the only reason the GitService site is guarded at all.
 *   MEASURED TOTALS: mutant 12/12 RED · unmutated control 12/12 GREEN.
 *
 * ★ BOTH ASSERTIONS IN A TWO-ORDER PROBE ARE LOAD-BEARING. "same winner in both orders" alone
 * can pass under mutation by coincidence of the plan (see GitService above); the second
 * assertion — that the winner is the row the DECLARED tiebreaker picks — is what caught the
 * mutants in L3. Do not collapse them.
 *
 * ★ POPULATION, stated as a BOUNDARY rather than a list (a list goes stale silently).
 * IN: a surface that is ORDERED and then PAGED, by SQL LIMIT/OFFSET or an in-memory slice.
 * OUT: `ORDER BY <key> ... LIMIT n` with no paging ("newest wins", "top N"). A partial order
 * there makes the PICK arbitrary among equals — a weaker defect than a corrupted SET.
 * This file does NOT claim to enumerate every ORDER BY in the Command backend. It covers the
 * five sites named in an earlier task, each driven through its SHIPPED service entry point
 * (never a hand-rebuilt query) against a real migrated Postgres.
 *
 * EACH TWO-ORDER PROBE FIRST PROVES THE TIE IS REAL — a tiebreak assertion over a population
 * that does not actually tie asserts nothing. Every seeded pair shares one literal timestamp,
 * and the harness reads the sort key back OFF THE RETURNED ROWS and asserts it is equal.
 *
 * FRESH IDS AND A FRESH PROJECT PER SCENARIO. The two physical orders must be two genuinely
 * fresh writes into a fresh scope: reusing a pinned pair and DELETEing between scenarios lets
 * Postgres reuse the freed line pointers, so the second scenario's heap order is decided by
 * the vacuumed slots rather than by the insertion sequence. Minting new ids into a new project
 * keeps the heap append-only, so insertion order IS physical order for a two-row population.
 * Identity is carried by the LABEL (which of the pair sorts lower), not the literal uuid —
 * that is what makes the winner comparable ACROSS the two scenarios.
 *
 * Run against a disposable DB:
 *   bash scripts/provision-test-db.sh ci_x
 *   DATABASE_NAME=ci_x DATABASE_USER=... DATABASE_PASSWORD=... \
 *     npx jest src/__tests__/orderedAndPagedTotalOrder.db.test.ts
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { SessionDetailService } from '../services/sessionDetail';
import { GitService } from '../services/git/GitService';
import { ContextService } from '../services/context';
import { TaskService } from '../services/task';

/** One instant shared by every row in a tied population, so the sort key cannot break the tie. */
const TIED_AT = '2026-01-01T00:00:00.000Z';

let pool: Pool;
const createdProjects: string[] = [];

/**
 * A fresh pair of ids whose relative order is KNOWN. Postgres compares `uuid` by its 16
 * bytes; the canonical lowercase-hex text form sorts identically (hex digits precede a-f in
 * ASCII and the dashes sit at fixed positions), so a JS string sort agrees with the DB's.
 */
function idPair(): { low: string; high: string; label: (id: string) => string } {
  const [low, high] = [randomUUID(), randomUUID()].sort();
  return {
    low,
    high,
    label: (id: string) => (id === low ? 'LOW' : id === high ? 'HIGH' : `OTHER(${id})`),
  };
}

async function newProject(suffix: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO projects (id, name, status) VALUES ($1, $2, 'active')`, [
    id,
    `b9l1-total-order-${suffix}-${id.slice(0, 8)}`,
  ]);
  createdProjects.push(id);
  return id;
}

type Row = Record<string, unknown> & { id: string };

/**
 * THE REPRODUCTION HARNESS. Seeds the same logical pair twice, in opposite physical order,
 * each into its own fresh project, and reports which label ranked first each time.
 *
 * `seed` inserts ONE row with the given id into the given project; every row it writes ties
 * on the surface's sort key. `fetch` drives the SHIPPED service entry point. `tieKey` reads
 * the sort key back OFF THE RETURNED ROW, and the harness asserts the two rows are EQUAL on
 * it before it looks at the order — a tiebreak assertion over a population that does not
 * actually tie asserts nothing.
 */
async function twoPhysicalOrders(
  name: string,
  seed: (projectId: string, id: string) => Promise<void>,
  fetch: (projectId: string) => Promise<Row[]>,
  tieKey: (row: Row) => unknown,
): Promise<{ lowFirst: string; highFirst: string }> {
  const run = async (order: 'low-then-high' | 'high-then-low') => {
    const { low, high, label } = idPair();
    const projectId = await newProject(`${name}-${order}`);
    const seq = order === 'low-then-high' ? [low, high] : [high, low];
    // Sequential on purpose: the construction depends on insertion ORDER.
    for (const id of seq) {
      await seed(projectId, id);
    }
    const pairRows = (await fetch(projectId)).filter((r) => r.id === low || r.id === high);
    // The tie must be REAL and BOTH rows must be present, or the winner means nothing.
    expect(pairRows.map((r) => label(r.id)).sort()).toEqual(['HIGH', 'LOW']);
    expect(String(tieKey(pairRows[0]))).toBe(String(tieKey(pairRows[1])));

    const got = label(pairRows[0].id);
    // eslint-disable-next-line no-console
    console.log(`[probe:${name}] inserted ${order} -> first of pair = ${got}`);
    return got;
  };

  return { lowFirst: await run('low-then-high'), highFirst: await run('high-then-low') };
}

/** Assert the reproduction: stable across both physical orders AND equal to the declared pick. */
function expectStable(result: { lowFirst: string; highFirst: string }, declaredWinner: 'HIGH' | 'LOW') {
  expect(result.lowFirst).toBe(result.highFirst);
  expect(result.lowFirst).toBe(declaredWinner);
}

/** Page through a tied population with the surface's own paging params; return every id seen. */
async function pageAll(
  total: number,
  pageSize: number,
  fetchPage: (limit: number, offset: number) => Promise<string[]>,
): Promise<string[]> {
  const seen: string[] = [];
  for (let offset = 0; offset < total; offset += pageSize) {
    seen.push(...(await fetchPage(pageSize, offset)));
  }
  return seen;
}

function expectExactlyOnce(seen: string[], expected: string[]) {
  const counts = new Map<string, number>();
  for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const missing = expected.filter((id) => !counts.has(id));
  expect({ dupes, missing }).toEqual({ dupes: [], missing: [] });
  expect(seen.length).toBe(expected.length);
}

/**
 * ★ THE PROBE WITH TEETH ON EVERY SITE. Over a population where EVERY row ties on the sort
 * key, the declared total order reduces to the tiebreaker alone — so the paged sequence must
 * come back in exact primary-key order. Measured under mutation: with the tiebreakers removed
 * this fails on all five sites, including the one where the two-physical-orders construction
 * cannot discriminate (see the GitService note in the header). Asserting exactly-once alone
 * does NOT fail there, which is why this assertion exists next to it.
 */
function expectPkOrder(seen: string[], expected: string[], direction: 'desc' | 'asc' = 'desc') {
  const wanted = [...expected].sort();
  if (direction === 'desc') wanted.reverse();
  expect(seen).toEqual(wanted);
}

// ---------------------------------------------------------------------------
// Per-surface seeders, each writing rows that TIE on that surface's sort key.
// ---------------------------------------------------------------------------

async function seedSession(projectId: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, project_id, agent_type, started_at, status, title)
     VALUES ($1, $2, 'mcp-server', $3, 'active', $4)`,
    [id, projectId, TIED_AT, `tied session ${id.slice(0, 8)}`],
  );
}

async function seedContext(projectId: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at, relevance_score)
     VALUES ($1, $2, 'planning', 'tied row', ARRAY['b9l1']::text[], $3, 5)`,
    [id, projectId, TIED_AT],
  );
}

async function seedTask(projectId: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, type, status, priority, created_at)
     VALUES ($1, $2, $3, 'general', 'todo', 'high', $4)`,
    [id, projectId, `tied task ${id.slice(0, 8)}`, TIED_AT],
  );
}

async function seedCommit(projectId: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO git_commits
       (id, project_id, commit_sha, message, author_name, author_email, author_date,
        committer_name, committer_email, committer_date)
     VALUES ($1, $2, $3, 'tied commit', 'A', 'a@example.com', $4, 'A', 'a@example.com', $4)`,
    [id, projectId, id.replace(/-/g, '').padEnd(40, '0'), TIED_AT],
  );
}

describeDb('ordered-and-paged surfaces carry a TOTAL order', () => {
  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });
  });

  afterAll(async () => {
    if (!pool) return;
    for (const p of createdProjects) {
      await pool.query('DELETE FROM git_commits WHERE project_id = $1', [p]);
      await pool.query('DELETE FROM contexts WHERE project_id = $1', [p]);
      await pool.query('DELETE FROM tasks WHERE project_id = $1', [p]);
      await pool.query('DELETE FROM sessions WHERE project_id = $1', [p]);
      await pool.query('DELETE FROM projects WHERE id = $1', [p]);
    }
    await pool.end();
  });

  // --- services/sessionAnalytics.ts — getSessionsList (ORDER BY s.started_at DESC + OFFSET) ---
  describe('sessionAnalytics.getSessionsList', () => {
    test('two physical orders rank the same session first', async () => {
      const r = await twoPhysicalOrders(
        'getSessionsList',
        seedSession,
        async (projectId) => {
          const res = await SessionAnalyticsService.getSessionsList({
            scope: projectsScope([projectId]),
            limit: 10,
            offset: 0,
          });
          return res.sessions as Row[];
        },
        (row) => row.started_at,
      );
      expectStable(r, 'HIGH');
    });

    test('paging a tied population returns every session exactly once, in primary-key order', async () => {
      const projectId = await newProject('getSessionsList-paging');
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID();
        ids.push(id);
        await seedSession(projectId, id);
      }
      const seen = await pageAll(12, 3, async (limit, offset) => {
        const res = await SessionAnalyticsService.getSessionsList({
          scope: projectsScope([projectId]),
          limit,
          offset,
        });
        return res.sessions.map((s: { id: string }) => s.id);
      });
      expectExactlyOnce(seen, ids);
      expectPkOrder(seen, ids);
    });
  });

  // --- services/sessionDetail.ts — getSessionSummaries (ORDER BY s.started_at DESC + OFFSET) ---
  describe('sessionDetail.getSessionSummaries', () => {
    test('two physical orders rank the same session first', async () => {
      const r = await twoPhysicalOrders(
        'getSessionSummaries',
        seedSession,
        async (projectId) =>
          (await SessionDetailService.getSessionSummaries(projectsScope([projectId]), 10, 0)) as unknown as Row[],
        (row) => row.started_at,
      );
      expectStable(r, 'HIGH');
    });

    test('paging a tied population returns every session exactly once, in primary-key order', async () => {
      const projectId = await newProject('getSessionSummaries-paging');
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID();
        ids.push(id);
        await seedSession(projectId, id);
      }
      const seen = await pageAll(12, 3, async (limit, offset) => {
        const rows = await SessionDetailService.getSessionSummaries(
          projectsScope([projectId]),
          limit,
          offset,
        );
        return (rows as Array<{ id: string }>).map((s) => s.id);
      });
      expectExactlyOnce(seen, ids);
      expectPkOrder(seen, ids);
    });
  });

  // --- services/git/GitService.ts — queryCommitsByMetadata (ORDER BY gc.author_date DESC) ---
  describe('GitService.queryCommitsByMetadata', () => {
    test('two physical orders rank the same commit first', async () => {
      const r = await twoPhysicalOrders(
        'queryCommitsByMetadata',
        seedCommit,
        async (projectId) =>
          (await GitService.queryCommitsByMetadata({ project_id: projectId, limit: 10 }))
            .commits as unknown as Row[],
        (row) => row.author_date,
      );
      expectStable(r, 'HIGH');
    });

    test('paging a tied population returns every commit exactly once, in primary-key order', async () => {
      const projectId = await newProject('queryCommitsByMetadata-paging');
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID();
        ids.push(id);
        await seedCommit(projectId, id);
      }
      const seen = await pageAll(12, 3, async (limit, offset) => {
        const res = await GitService.queryCommitsByMetadata({ project_id: projectId, limit, offset });
        return (res.commits as Array<{ id: string }>).map((c) => c.id);
      });
      expectExactlyOnce(seen, ids);
      expectPkOrder(seen, ids);
    });
  });

  // --- services/context.ts — searchContexts browse (ORDER BY <sortColumn> + LIMIT/OFFSET) ---
  describe('ContextService.searchContexts (browse)', () => {
    test('two physical orders rank the same context first', async () => {
      const r = await twoPhysicalOrders(
        'searchContexts',
        seedContext,
        async (projectId) =>
          (
            await ContextService.searchContexts({
              scope: projectsScope([projectId]),
              limit: 10,
              offset: 0,
            })
          ).contexts as unknown as Row[],
        (row) => row.created_at,
      );
      // Default sort_order is `desc`, and the tiebreaker mirrors it -> the HIGH id wins.
      expectStable(r, 'HIGH');
    });

    test('the relevance_score sort — a coarse bucket that ties constantly — is also total', async () => {
      const r = await twoPhysicalOrders(
        'searchContexts-relevance',
        seedContext,
        async (projectId) =>
          (
            await ContextService.searchContexts({
              scope: projectsScope([projectId]),
              sort_by: 'relevance',
              limit: 10,
              offset: 0,
            })
          ).contexts as unknown as Row[],
        (row) => row.relevance_score,
      );
      expectStable(r, 'HIGH');
    });

    test('an ASCENDING browse is total too, and the tiebreaker follows the caller sort_order', async () => {
      const r = await twoPhysicalOrders(
        'searchContexts-asc',
        seedContext,
        async (projectId) =>
          (
            await ContextService.searchContexts({
              scope: projectsScope([projectId]),
              sort_order: 'asc',
              limit: 10,
              offset: 0,
            })
          ).contexts as unknown as Row[],
        (row) => row.created_at,
      );
      expectStable(r, 'LOW');
    });

    test('paging a tied population returns every context exactly once, in primary-key order', async () => {
      const projectId = await newProject('searchContexts-paging');
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID();
        ids.push(id);
        await seedContext(projectId, id);
      }
      const seen = await pageAll(12, 3, async (limit, offset) => {
        const res = await ContextService.searchContexts({
          scope: projectsScope([projectId]),
          limit,
          offset,
        });
        return (res.contexts as Array<{ id: string }>).map((c) => c.id);
      });
      expectExactlyOnce(seen, ids);
      expectPkOrder(seen, ids);
    });
  });

  // --- services/task.ts — getTasks (ORDER BY priority CASE, t.created_at DESC + LIMIT/OFFSET) ---
  describe('TaskService.getTasks', () => {
    test('two physical orders rank the same task first', async () => {
      const r = await twoPhysicalOrders(
        'getTasks',
        seedTask,
        async (projectId) =>
          (await TaskService.getTasks({ scope: projectsScope([projectId]), limit: 10 })).tasks as unknown as Row[],
        // Both keys of the composite primary sort must tie for the probe to mean anything.
        (row) => `${row.priority}|${row.created_at}`,
      );
      expectStable(r, 'HIGH');
    });

    test('paging a tied population returns every task exactly once, in primary-key order', async () => {
      const projectId = await newProject('getTasks-paging');
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID();
        ids.push(id);
        await seedTask(projectId, id);
      }
      const seen = await pageAll(12, 3, async (limit, offset) => {
        const { tasks: rows } = await TaskService.getTasks({ scope: projectsScope([projectId]), limit, offset });
        return (rows as Array<{ id: string }>).map((t) => t.id);
      });
      expectExactlyOnce(seen, ids);
      expectPkOrder(seen, ids);
    });
  });
});
