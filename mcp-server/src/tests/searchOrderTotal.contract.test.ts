// GUARDS-CLASS: paged-order-no-tiebreaker
/**
 * ORDERED-AND-PAGED SURFACES MUST CARRY A TOTAL ORDER — Contract Test
 *
 * THE DEFECT. `ORDER BY <score> DESC` with no tiebreaker is a PARTIAL order: rows that share
 * the score have no defined relative position, so Postgres is free to return them in any
 * order — and does, depending on the plan, the heap, and the LIMIT. Two consequences, and
 * the second is the one that does not need an exotic input:
 *   1. an unstable rank #1 whenever two rows tie on the score;
 *   2. ★ OFFSET PAGINATION OVER EQUAL SCORES CAN REPEAT OR DROP ROWS — page 1 and page 2 are
 *      two independent sorts of the same tied block, so a reader paging through can see one
 *      row twice and never see another. Recall is the signature product; a silently dropped
 *      row is a recall defect that raises no error.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS — a single-order fixture CANNOT catch this.
 * On a small tied population a seq scan returns heap order, so one insertion order passes
 * every time and a tally of green runs "proves" the sort is fine. That is exactly how this
 * defect survived: the b7 gate went RED on it, isolated re-runs were 3/3 and 5/5 green, and
 * the discriminator turned out to be the TWO-ORDER construction, never a run count (an earlier task
 * , found during the batch-7 merge-candidate repair).
 *
 * ★ WHICH PROBES HAVE TEETH, measured under mutation — do not read past this. The
 * `twoPhysicalOrders` probes seed the SAME logical pair TWICE in opposite sequence; the PAGING
 * probes do NOT — they seed one population in one order and assert exactly-once, and every one
 * of them was measured GREEN with the tiebreakers removed. The paging probes are a REGRESSION
 * FLOOR, not a reproduction, and this header used to claim otherwise ("every probe below seeds
 * the same logical pair twice"), which overstated the guard's teeth to its next reader.
 *
 * ★ AND WITHIN A TWO-ORDER PROBE, BOTH ASSERTIONS ARE LOAD-BEARING. `expect(a).toBe(b)` alone
 * is NOT sufficient: under mutation, context_search and task_list returned the same row in
 * both physical orders, so only the second assertion — that the winner is the one the DECLARED
 * tiebreaker picks (`HIGH`) — caught them. Collapsing the two into one would hollow 2 of the 4.
 *
 * ★ THE POPULATION, STATED AS A BOUNDARY rather than a list, because a list goes stale silently.
 * IN: a surface that is ORDERED and then PAGED — SQL `LIMIT/OFFSET`, or an in-memory slice over
 * a full result set (project_list does the latter; a grep for `OFFSET $` cannot see it, which is
 * how this file missed it in its first round). For those, a partial order can repeat or drop a
 * row across pages, and the caller is never told.
 * OUT: `ORDER BY <key> ... LIMIT n` with no paging — "newest wins", "top N". A partial order
 * there makes the PICK arbitrary among equals, which is a different and weaker defect: the
 * caller gets one of several equally-valid answers, never a corrupted set. Several such sites
 * were nonetheless fixed in this lane where the arbitrary pick was itself the bug (a moving
 * `ref:` anchor, an inferred edge, a duplicate report); that was a judgement per site, not a
 * rule, and the rest are deliberately left alone. If you are adding a surface here, ask which
 * side of that line it is on before you ask what to assert.
 *
 * It does NOT claim to enumerate every ORDER BY in the tree; it drives each surface it names
 * through that surface's shipped entry point (validator → routeExecutor/route → real migrated
 * Postgres in the disposable ci_* DB), never a hand-rebuilt query.
 *
 * EACH TWO-ORDER PROBE FIRST PROVES THE TIE IS REAL. A tie-break assertion over a population
 * that does not actually tie asserts nothing, so where the surface exposes its sort key we
 * assert the scores are EQUAL before asserting the order is stable.
 */

import { randomUUID } from 'node:crypto';

import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

import { activeEmbedder } from '../config/embeddingConfig.js';

const DIM = activeEmbedder().dimensions;

/** One fixed direction: every seeded row gets the SAME vector, so every cosine is identical. */
function fixedVector(): number[] {
  const v = new Array(DIM).fill(0);
  v[3] = 1;
  return v;
}

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: fixedVector(),
      dimensions: DIM,
      model: 'fixed-direction-mock',
    })),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { contextRoutes } from '../routes/context.routes.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { resolveAnchor } from '../services/recallThread.js';
import { routeExecutor } from '../routes/index.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const VEC = `[${fixedVector().join(',')}]`;

/**
 * A FRESH PAIR OF IDS PER SCENARIO, with their relative order KNOWN.
 *
 * The two physical orders must be two genuinely fresh writes. An earlier revision reused one
 * pinned pair and DELETEd between scenarios — and that quietly destroyed the construction:
 * Postgres reuses the freed line pointers, so the second scenario's heap order was decided by
 * the vacuumed slots rather than by the insertion sequence, and both orders returned the same
 * row while the sort was still partial. Minting a new pair keeps the heap append-only, so
 * insertion order IS physical order on a fresh two-row population under a seq scan.
 *
 * Identity is then carried by the LABEL (which of the pair sorts lower), not by the literal
 * uuid — that is what makes the winner comparable ACROSS the two scenarios.
 */
function idPair(): { low: string; high: string; label: (id: string) => string } {
  const [low, high] = [randomUUID(), randomUUID()].sort();
  return {
    low,
    high,
    label: (id: string) => (id === low ? 'LOW' : id === high ? 'HIGH' : `OTHER(${id})`),
  };
}

/** One instant shared by every row in a tied population, so `created_at` cannot break the tie. */
const TIED_AT = '2026-01-01T00:00:00.000Z';

// UNIQUE PER RUN, not per PID. `projects.name` carries a UNIQUE constraint, and every
// name this suite writes is built from this prefix — so the prefix is the only thing
// keeping two runs from colliding on it. process.pid is NOT sufficient for that job:
// the CI gate drives the vitest suite more than once against ONE disposable database (stage 1
// and stage 1b), PIDs are recycled by the OS, and a recycled PID reproduces a previous
// run's exact names against rows that are still there. The failure that follows is a
// `duplicate key value violates unique constraint "projects_name_key"` raised from an
// INSERT — which surfaces as a DatastoreError from a test that reads as though it were
// asserting about sort order, so it does not look like a naming problem at all.
//
// OBSERVED 2026-08-30: this suite failed the clean gate on ref bd3750ba with exactly that
// error, then PASSED on the immediately following run of the same gate — twice-seen,
// nondeterministic, and it turns the authoritative gate RED at random.
//
// The prefix below was applied for that, WITHOUT a reproduction, under an explicit bound
// saying a recurrence should be traced. It recurred on ref 0d0ce0d2 (v0.52.0), and the
// trace on 2026-08-31 found a DIFFERENT cause, which the prefix could not have covered:
// the collision was BETWEEN this test's own four fixture rows, in one process, not
// between two runs. `${PROJ_PREFIX}plist-${id.slice(0, 8)}` took the first 8 hex of a
// MOCKED randomUUID (vitest.setup.ts) whose high segment was
// `procSeed ^ (Date.now() & 0xffff) ^ counter` — not injective. Both that segment and
// this name are fixed; see vitest.setup.ts for the measurement.
//
// The prefix stays anyway: it is what makes the names distinct ACROSS runs sharing one
// disposable CI database, which is a real and separate requirement.
const PROJ_PREFIX = `ord-total-${process.pid}-${randomUUID().slice(0, 8)}-`;
const createdProjects: string[] = [];

async function newProject(suffix: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'total-order fuse') RETURNING id`,
    [`${PROJ_PREFIX}${suffix}`],
  );
  createdProjects.push(r.rows[0].id);
  return r.rows[0].id;
}

async function seedContext(opts: {
  projectId: string;
  id?: string;
  content?: string;
  tags?: string[];
  createdAt?: string;
}): Promise<string> {
  const cols = ['project_id', 'context_type', 'content', activeEmbeddingColumn(), 'relevance_score', 'tags', 'created_at'];
  const vals: any[] = [
    opts.projectId,
    'planning',
    opts.content ?? 'tied row',
    VEC,
    5.0,
    opts.tags ?? [],
    opts.createdAt ?? TIED_AT,
  ];
  if (opts.id) {
    cols.unshift('id');
    vals.unshift(opts.id);
  }
  const ph = vals.map((_, i) => (cols[i] === activeEmbeddingColumn() ? `$${i + 1}::vector` : `$${i + 1}`));
  const r = await db.query(
    `INSERT INTO contexts (${cols.join(', ')}) VALUES (${ph.join(', ')}) RETURNING id::text AS id`,
    vals,
  );
  return r.rows[0].id;
}

async function seedTask(opts: { projectId: string; id?: string; title?: string; createdAt?: string }): Promise<string> {
  const cols = ['project_id', 'title', 'status', 'priority', 'created_at'];
  const vals: any[] = [opts.projectId, opts.title ?? 'tied task', 'todo', 'medium', opts.createdAt ?? TIED_AT];
  if (opts.id) {
    cols.unshift('id');
    vals.unshift(opts.id);
  }
  const r = await db.query(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`,
    vals,
  );
  return r.rows[0].id;
}

const searchContexts = async (args: any) =>
  contextRoutes.handleSearch(validateToolArguments('context_search', args));
const listTasks = async (args: any) =>
  tasksRoutes.handleList(validateToolArguments('task_list', args));

const ctxRows = (resp: any): any[] => resp?.structuredContent?.results ?? [];
const taskRows = (resp: any): any[] => resp?.structuredContent?.tasks ?? resp?.structuredContent?.results ?? [];

/**
 * Page a surface with a small page size and return every id it yielded, IN ORDER, with
 * repeats preserved — the caller asserts exactly-once itself, because "how many times did a
 * row appear" is the whole question and a Set would destroy the answer.
 */
async function pageAll(
  fetch: (limit: number, offset: number) => Promise<string[]>,
  pageSize: number,
  pages: number,
): Promise<string[]> {
  const seen: string[] = [];
  for (let p = 0; p < pages; p++) {
    seen.push(...(await fetch(pageSize, p * pageSize)));
  }
  return seen;
}

/**
 * RUN ONE SCENARIO IN BOTH PHYSICAL ORDERS and report which of the pair came first each time.
 *
 * `seedPair` writes the two rows in the given sequence; `topId` asks the surface who ranks #1.
 * Returns the two LABELS, which is the only form in which the answer is comparable across the
 * two scenarios (the uuids themselves differ by construction — see idPair).
 */
async function twoPhysicalOrders(opts: {
  probe: string;
  seedPair: (projectId: string, ids: string[]) => Promise<void>;
  topId: (projectId: string) => Promise<string>;
}): Promise<[string, string]> {
  const out: string[] = [];
  for (const first of ['LOW', 'HIGH'] as const) {
    const { low, high, label } = idPair();
    const order = first === 'LOW' ? [low, high] : [high, low];
    const projectId = await newProject(`${opts.probe}-${first}first`);
    await opts.seedPair(projectId, order);
    const top = await opts.topId(projectId);
    out.push(label(top));
    // process.stdout.write, not console.log: vitest attaches console output to the test that
    // produced it and a failing test's log is easy to lose in the reporter's diff block. This
    // probe's OUTPUT is the deliverable, so it must reach the terminal unconditionally.
    process.stdout.write(
      `[probe:${opts.probe}] inserted ${order.map(label).join(' then ')} -> rank#1 = ${label(top)}\n`,
    );
  }
  return [out[0], out[1]];
}

describe('ordered-and-paged surfaces carry a TOTAL order', () => {
  beforeAll(() => {
    console.log(
      `[14dff41a] running under MANDREL_EMBEDDER=${activeEmbedder().key} ` +
      `(column=${activeEmbeddingColumn()}, dims=${DIM})`,
    );
  });

  afterAll(async () => {
    for (const pid of createdProjects) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [pid]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── context_search, semantic branch: the reported defect ──────────────────────────────

  test('context_search: two rows with IDENTICAL scores rank the same way in BOTH physical orders', async () => {
    const [a, b] = await twoPhysicalOrders({
      probe: 'context_search',
      seedPair: async (projectId, ids) => {
        for (const id of ids) await seedContext({ projectId, id, content: 'tied row' });
      },
      topId: async (projectId) => {
        const r = ctxRows(await searchContexts({ query: 'tied row', projectId, limit: 10 }));
        expect(r).toHaveLength(2);
        // THE TIE IS REAL — assert it before asserting anything about the order. Identical
        // vector + created_at + relevance_score + context_type ⇒ identical sort key. Without
        // this, a "stable order" assertion over a non-tied population proves nothing.
        expect(r[0].relevance).toBe(r[1].relevance);
        return r[0].id;
      },
    });
    // The assertion that would have caught the defect: the winner cannot depend on which row
    // was written first.
    expect(a).toBe(b);
    // And it is the tiebreaker's winner, not an accident: equal created_at ⇒ `id DESC`.
    expect(a).toBe('HIGH');
  });

  test('context_search: paging a tied population returns every row exactly once', async () => {
    const projectId = await newProject('ctx-page');
    const seeded: string[] = [];
    for (let i = 0; i < 8; i++) {
      seeded.push(await seedContext({ projectId, content: 'tied row' }));
    }

    const seen = await pageAll(
      async (limit, offset) =>
        ctxRows(await searchContexts({ query: 'tied row', projectId, limit, offset })).map((c) => c.id),
      2,
      4,
    );
    process.stdout.write(`[probe:context_search paging] pages of 2 x4 -> ${seen.length} rows, ${new Set(seen).size} distinct\n`);

    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect([...seen].sort()).toEqual([...seeded].sort());
  });

  test('context_search: the top row does not change when the PAGE SIZE changes', async () => {
    const projectId = await newProject('ctx-pagesize');
    for (let i = 0; i < 8; i++) await seedContext({ projectId, content: 'tied row' });

    const first = async (limit: number) =>
      ctxRows(await searchContexts({ query: 'tied row', projectId, limit }))[0]?.id;
    // A different LIMIT can select a different plan (top-N heapsort vs full sort) over the
    // SAME tied block — which is how a partial order leaks out even without an OFFSET.
    expect(await first(1)).toBe(await first(8));
  });

  // ── context_search, tags-only branch (routes/context.routes.ts) ───────────────────────

  test('context_search tags-only: same-timestamp rows resolve identically in BOTH physical orders', async () => {
    const [a, b] = await twoPhysicalOrders({
      probe: 'tags-only',
      seedPair: async (projectId, ids) => {
        for (const id of ids) await seedContext({ projectId, id, tags: ['ref:tie-probe'] });
      },
      topId: async (projectId) => {
        const r = ctxRows(await searchContexts({ tags: ['ref:tie-probe'], projectId, limit: 10 }));
        expect(r).toHaveLength(2);
        // The tie is structural on this branch: the sort key IS created_at, and both rows
        // carry the same one.
        expect(r[0].createdAt ?? r[0].created_at).toBe(r[1].createdAt ?? r[1].created_at);
        return r[0].id;
      },
    });
    expect(a).toBe(b);
    expect(a).toBe('HIGH');
  });

  test('context_search tags-only: paging a same-timestamp population returns every row exactly once', async () => {
    const projectId = await newProject('tag-page');
    const seeded: string[] = [];
    for (let i = 0; i < 6; i++) seeded.push(await seedContext({ projectId, tags: ['ref:tie-page'] }));

    const seen = await pageAll(
      async (limit, offset) =>
        ctxRows(await searchContexts({ tags: ['ref:tie-page'], projectId, limit, offset })).map((c) => c.id),
      2,
      3,
    );
    process.stdout.write(`[probe:tags-only paging] pages of 2 x3 -> ${seen.length} rows, ${new Set(seen).size} distinct\n`);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...seeded].sort());
  });

  // ── task_list ─────────────────────────────────────────────────────────────────────────

  test('task_list: same priority + same created_at ranks identically in BOTH physical orders', async () => {
    const [a, b] = await twoPhysicalOrders({
      probe: 'task_list',
      seedPair: async (projectId, ids) => {
        for (const id of ids) await seedTask({ projectId, id });
      },
      topId: async (projectId) => {
        const r = taskRows(await listTasks({ projectId, limit: 10 }));
        expect(r).toHaveLength(2);
        // Both sort keys are equal by construction: same priority, same created_at.
        expect(r[0].priority).toBe(r[1].priority);
        return r[0].id;
      },
    });
    expect(a).toBe(b);
    expect(a).toBe('HIGH');
  });

  test('task_list: paging a tied population returns every task exactly once', async () => {
    const projectId = await newProject('task-page');
    const seeded: string[] = [];
    for (let i = 0; i < 6; i++) seeded.push(await seedTask({ projectId, title: `tied task ${i}` }));

    const seen = await pageAll(
      async (limit, offset) => taskRows(await listTasks({ projectId, limit, offset })).map((t) => t.id),
      2,
      3,
    );
    process.stdout.write(`[probe:task_list paging] pages of 2 x3 -> ${seen.length} rows, ${new Set(seen).size} distinct\n`);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...seeded].sort());
  });

  // ── recall_thread's moving `ref:<slug>` anchor ────────────────────────────────────────

  test('recall_thread: a ref:<slug> with two same-timestamp contexts resolves identically in BOTH orders', async () => {
    const [a, b] = await twoPhysicalOrders({
      probe: 'recall_thread-anchor',
      seedPair: async (projectId, ids) => {
        for (const id of ids) await seedContext({ projectId, id, tags: ['ref:anchor-tie'] });
      },
      topId: async (projectId) => (await resolveAnchor('ref:anchor-tie', projectId, db as any)).id,
    });
    // A MOVING ref is "newest wins". When two handoffs share the newest timestamp, "newest"
    // is ambiguous — and an ambiguous boot anchor sends the next cold session to a different
    // handoff depending on write order. The tiebreaker makes the pick deterministic.
    expect(a).toBe(b);
    expect(a).toBe('HIGH');
  });

  // ── project_list: the IN-MEMORY SLICE shape ───────────────────────────────────────────
  //
  // ★ THIS IS A DIFFERENT PAGING MECHANISM, and that is the whole reason it is here. Every
  // probe above pages in SQL. project_list orders in SQL and then pages with a JS
  // `allProjects.slice(offset, offset + limit)` in the route — so a sweep for `OFFSET $`
  // cannot see it, and this file missed it in its first round. A slice-paged surface has the
  // same defect with one extra wrinkle worth stating honestly: a SINGLE page is
  // self-consistent (one query, one slice), and the exposure is ACROSS calls, because page 1
  // and page 2 are separate tool calls that each re-execute the query. Postgres is free to
  // return the tied block differently between them — measured on 400 tied rows, a
  // Sort/GroupAggregate → HashAggregate plan change flipped the whole order and put one
  // project on both pages.
  //
  // AND ON A SECOND, INDEPENDENT GROUND that needs no plan change at all: this list is ordered
  // by `updated_at`, which MOVES whenever a project is written. The page boundary therefore
  // shifts under ordinary concurrent activity even if the plan never changes. That is the same
  // reason the tiebreakers in this lane are primary keys and never timestamps.
  //
  // TWO FIXTURE CONSTRAINTS THIS FILE MUST RESPECT, both learned the hard way:
  //   - project_list is NOT project-scoped, so the response contains every other suite's rows.
  //     The assertions therefore FILTER to the ids this test seeded and assert their RELATIVE
  //     order, rather than assuming they occupy rank 0. That is also the stronger assertion.
  //   - the seeded rows are stamped in the PAST, never the future. A future `updated_at` makes
  //     the row `projects[0]` for every UNBOUND connection in the database — the documented
  //     decoy that turned four unrelated suites red (tests/helpers/projectBinding.ts). A probe
  //     must not become the ambient project.

  /** A connection bound to a real project, so the ambient-fallback guard does not reject the call. */
  let plistConnectionId: string;

  async function listProjectsPage(limit: number, offset: number): Promise<any[]> {
    const resp: any = await routeExecutor(
      'project_list',
      validateToolArguments('project_list', { limit, offset }),
      { connectionId: plistConnectionId },
    );
    expect(resp.isError, 'project_list returned an error').not.toBe(true);
    return resp?.structuredContent?.results ?? [];
  }

  test('project_list: two projects with an IDENTICAL updated_at rank the same way in BOTH physical orders', async () => {
    const bindingProject = `${PROJ_PREFIX}plist-binding`;
    createdProjects.push(
      (await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'binding') RETURNING id`, [bindingProject]))
        .rows[0].id,
    );
    plistConnectionId = `${PROJ_PREFIX}conn`;
    await bindConnectionToProject(plistConnectionId, bindingProject);

    const out: string[] = [];
    // Two scenarios, NO deletes between them (deleting is what breaks this construction — see
    // idPair). Distinct PAST timestamps per scenario so the two pairs never interleave, and
    // each pair shares ITS timestamp exactly so its own two rows genuinely tie.
    let year = 2001;
    for (const first of ['LOW', 'HIGH'] as const) {
      const { low, high, label } = idPair();
      const order = first === 'LOW' ? [low, high] : [high, low];
      const at = `${year++}-01-01T00:00:00.000Z`;
      for (const id of order) {
        await db.query(
          `INSERT INTO projects (id, name, description, updated_at)
           VALUES ($1, $2, 'slice-paging total-order fuse', $3)`,
          // The full id, never a prefix of it. `projects.name` is UNIQUE, and the id is
          // the only thing distinguishing these four rows; slicing it made the name's
          // uniqueness depend on a property of whatever generator is installed, which
          // the vitest.setup mock did not have (traced 2026-08-31 -- see that file).
          // 255-char column, ~70-char name.
          [id, `${PROJ_PREFIX}plist-${id}`, at],
        );
        createdProjects.push(id);
      }

      // Ask for everything, then FILTER to this scenario's pair — the list carries other
      // suites' projects and this probe is about the relative order of the two tied rows.
      const all = await listProjectsPage(100, 0);
      const mine = all.filter((p: any) => p.id === low || p.id === high);
      expect(mine).toHaveLength(2);
      // THE TIE IS REAL: both rows carry the same sort key.
      expect(new Date(mine[0].updatedAt ?? mine[0].updated_at).getTime())
        .toBe(new Date(mine[1].updatedAt ?? mine[1].updated_at).getTime());

      out.push(label(mine[0].id));
      process.stdout.write(
        `[probe:project_list] inserted ${order.map(label).join(' then ')} -> first of pair = ${label(mine[0].id)}\n`,
      );
    }
    // Both assertions carry weight — see the header. The first is the property that matters;
    // the second is the one that still bites when the mutant happens to be stable anyway.
    expect(out[0]).toBe(out[1]);
    expect(out[0]).toBe('HIGH');
  });

  test('project_list: slicing across SEPARATE calls returns every project exactly once', async () => {
    const at = '2000-01-01T00:00:00.000Z';
    const seeded: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await db.query(
        `INSERT INTO projects (name, description, updated_at)
         VALUES ($1, 'slice-paging total-order fuse', $2) RETURNING id::text AS id`,
        [`${PROJ_PREFIX}plist-page-${i}`, at],
      );
      seeded.push(r.rows[0].id);
      createdProjects.push(r.rows[0].id);
    }

    // Page the WHOLE list, because the seeded rows are not at rank 0 and the surface is not
    // project-scoped. Each page is its OWN tool call, which re-runs the query and re-slices —
    // the shape that makes a partial order observable on a slice-paged surface.
    const first: any = await routeExecutor(
      'project_list',
      validateToolArguments('project_list', { limit: 2, offset: 0 }),
      { connectionId: plistConnectionId },
    );
    const total: number = first?.structuredContent?.total ?? 0;
    expect(total).toBeGreaterThanOrEqual(6);

    const seen = await pageAll(
      async (limit, offset) => (await listProjectsPage(limit, offset)).map((p: any) => p.id),
      2,
      Math.ceil(total / 2),
    );
    const mine = seen.filter((id) => seeded.includes(id));
    process.stdout.write(
      `[probe:project_list slicing] paged ${total} projects in ${Math.ceil(total / 2)} calls of 2 -> ` +
      `${seen.length} rows, ${new Set(seen).size} distinct; of the 6 seeded, ${mine.length} sightings / ${new Set(mine).size} distinct\n`,
    );

    // Every seeded project appears EXACTLY once — none repeated across a page boundary, none
    // dropped between pages.
    expect(mine).toHaveLength(6);
    expect(new Set(mine).size).toBe(6);
    expect([...mine].sort()).toEqual([...seeded].sort());
    // And the property holds for the whole paged set, not just the seeded slice of it.
    expect(new Set(seen).size).toBe(seen.length);
  });
});
