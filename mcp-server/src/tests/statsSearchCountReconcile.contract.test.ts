/**
 * STATS-vs-SEARCH COUNT RECONCILIATION FUSE
 *
 * ── THE BUG THIS LOCKS SHUT ────────────────────────────────────────────────────────────
 * `decision_stats` counted ARCHIVED (soft-deleted) rows; `decision_search` excludes them
 * by default. Measured on live prod v0.17.1 on 2026-07-30, right after 428 machine-minted
 * decisions were archived:
 *
 *     decision_stats  -> total_decisions 556, by_impact.critical 22
 *     decision_search -> total           127, critical           12
 *
 * Two PUBLIC tools, one corpus, 4.4x apart, with nothing saying which was authoritative.
 * It is not cosmetic: `outcome_success_rate` is computed over the stats denominator, so
 * the archived machine records kept dragging the rate down after they were removed —
 * the cleanup's entire payoff was invisible (an earlier decision item 3).
 *
 * IT WAS NEVER JUST DECISIONS. Sweeping every aggregate over a soft-deletable table turned
 * up the SAME predicate omission on these surfaces, all fixed under an earlier task. This is
 * every instance FOUND by the sweeps described below — not a proof that none remains:
 *   · decision_stats        — all 9 aggregates                (this task)
 *   · context_stats         — all 4 aggregates, param added   (this task)
 *   · project_insights      — all 3 entity breakdowns, param added (this task)
 *   · task_progress_summary — closed earlier by pinned here too
 *   · session_status / session_get / session_list — the per-session contextCount /
 *     taskCount / decisionCount (found by an Reviewer, NOT by this guard — see the
 *     population section below for why, and what changed because of it)
 *   · project_info / project_list — `contextCount` per project
 *
 * This file is the CLASS-level fuse over the MCP tool surface. It does not test decisions;
 * it tests every declared count-reporting op against a search surface.
 *
 * ── WHAT IT ASSERTS ────────────────────────────────────────────────────────────────────
 * For every pair in RECONCILE_MATRIX below, against REAL seeded data with a known
 * live/archived split, driven through the SAME public path the bridge uses
 * (validate -> routeExecutor):
 *
 *   1. DEFAULT filter:          stats count == search count  (both = live only)
 *   2. includeArchived:true:    stats count == search count  (both = live + archived)
 *   3. the two differ by exactly the archived rows (proves the flag does something and
 *      the archived rows still EXIST — they were hidden, not lost)
 *
 * A pair declared `reconciles: false` is a KNOWN, REPORTED divergence that someone has
 * decided not to fix yet. It is asserted to STILL diverge — so it cannot be fixed, or
 * worsened, without this file going RED and forcing the entry to be updated. Nothing leaves
 * the matrix silently in either direction. That ratchet is how context_stats and
 * project_insights were held between "found" and "fixed": both were pinned false, and both
 * were FLIPPED to true when the fix landed. Neither entry was ever deleted, so there was no
 * window in which the surface was unguarded. **If you fix a pinned pair, FLIP THE FLAG —
 * deleting the entry passes the suite and leaves the surface with no guard at all, which is
 * strictly worse than the divergence you just fixed.**
 *
 * As of this commit NO pair is pinned false. The mechanism is therefore not exercised by the
 * matrix, so it is exercised directly by `assertPair` self-tests below — an unexercised
 * ratchet rots, and the next person to pin a divergence needs it to work.
 *
 * ── THE POPULATION THIS GUARD ENUMERATES — AND WHAT IT IS NOT ─────────────────────────
 * Stated narrowly on purpose. An earlier version of this header claimed the population was
 * "the whole one" and it was not: the enumeration was a NAME REGEX
 * (/(_stats|_insights|_progress_summary)$/) over OP_REGISTRY. An Reviewer wired two
 * schema-complete ops into the registry — `naming_stats` tripped this guard, and
 * `session_record_counts` PASSED SILENTLY. Meanwhile the real session_status / session_get /
 * session_list were counting archived rows on prod, invisible to this file, for no reason
 * other than what they are called. The claim was the defect; the regex was just its cause.
 *
 * WHAT IS ACTUALLY DERIVED (both asserted below, both with empty-population probes):
 *
 *   (a) SOFT-DELETABLE ENTITIES — read live from information_schema at test time
 *       (`column_name = 'archived_at'`), NOT a hardcoded list. Migration 046 added exactly
 *       three: contexts, technical_decisions, tasks. A fourth table gaining the column turns
 *       `every soft-deletable table is covered` RED.
 *
 *   (b) COUNT-REPORTING OPS — `OP_REGISTRY.filter(o => o.reportsCount)`. A DECLARED,
 *       DENY-BY-DEFAULT flag on the op, not a pattern over its name. A new count-reporting
 *       tool cannot ship without someone setting it, whatever the tool is called, and
 *       setting it obliges a matrix entry.
 *
 * WHAT THIS DOES NOT GUARANTEE, said plainly so the next reader does not over-trust it:
 *
 *   1. `reportsCount` is a HUMAN DECLARATION. Nothing proves an op that omits it truly
 *      reports no count. The flag moves the failure from "depends on the name" to "depends
 *      on someone answering a question at declaration time" — better, not automatic.
 *   2. It covers the MCP TOOL SURFACE only. The REST endpoints under /api/v2/sessions/*, the
 *      `v_session_summaries` view, and the Command UI backend are NOT in OP_REGISTRY and are
 *      not enumerated here. The session-count rule's three copies are guarded separately, by
 *      sessionCountRule.contract.test.ts and its backend twin.
 *   3. It reconciles COUNTS on the archived axis. It says nothing about whether the rows
 *      themselves match, nor about any other filter.
 *   4. Two of the session identity counts (decisions, tasks) have NO paired public search
 *      surface at all — decision_search and task_list accept no sessionId — so they are
 *      asserted directly against archived decoys, not reconciled.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';
import { dispatchGateway } from '../routes/gateway.js';
import { OP_REGISTRY } from '../config/opRegistry.js';
// Derived, never hardcoded (C4): the embedded-context aggregate reads the ACTIVE embedder's
// column, so the seeding below must write that same column at that same width. A literal
// `embedding` / `1536` here would pass under minilm and silently stop testing anything the
// day the gemma cutover flips MANDREL_EMBEDDER.
import { activeEmbedder } from '../config/embeddingConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `stats-reconcile-${STAMP}`;
// ONE CONNECTION, BOUND TO THE SEEDED PROJECT. Most reads here already name
// their project as an explicit rung-1 argument — see the `session_list` note below, which is
// this same defect fixed for that surface. `project_list` accepts NO project argument by
// design (it is a whole-database listing, and this file PAGES to the end of it precisely
// because other projects are expected to be there), so naming the scope in the args is not
// available for it and the CONNECTION has to say which project this file is about instead.
// Binding does not narrow project_list — the seeded project is still located by paging —
// it only stops route entry from resolving `projects[0] ORDER BY updated_at DESC`.
const CONN = `stats-reconcile-conn-${STAMP}`;
/** Tag carried by every seeded context so a tags-only context_search can enumerate them. */
const SEED_TAG = `reconcile-${STAMP}`;

let projectId: string;
let sessionId: string;
// The session fixture lives in its OWN project: seeded into the shared one it would inflate
// every project-scoped expectation above and the two fixtures would silently interfere.
let sessionProjectId: string;

// Deliberately DIFFERENT per entity, and deliberately with MORE archived than live for
// decisions — the prod shape that made this a 4.4x lie rather than a rounding error.
// A single shared number would let an off-by-entity bug pass.
const LIVE_DECISIONS = 7;
const ARCHIVED_DECISIONS = 23; // 30 total; live/total = 7/30, the prod-shaped ratio
const LIVE_CONTEXTS = 5;
const ARCHIVED_CONTEXTS = 11;
// SESSION-SCOPED fixture (Reviewer F2). Its own numbers so a session count cannot be
// accidentally right by matching the project-wide ones.
const SESSION_TAG = `reconcile-sess-${STAMP}`;
const SESSION_LIVE_CONTEXTS = 6;
const SESSION_ARCHIVED_CONTEXTS = 8;
const SESSION_LIVE_DECISIONS = 4;
const SESSION_ARCHIVED_DECISIONS = 9;
const SESSION_LIVE_TASKS = 3;
const SESSION_ARCHIVED_TASKS = 7;

const LIVE_TASKS = 9;
const LIVE_TASKS_DONE = 3; // of the 9 live tasks; the rest are todo
const ARCHIVED_TASKS = 4;  // all todo — see seedTasks call for why the split matters

type Pair = {
  /** Human name used in the failure message. */
  name: string;
  /** The soft-deletable table whose rows both sides count. */
  entity: string;
  /** STATS-side opIds this entry covers (checked against OP_REGISTRY for completeness). */
  ops: string[];
  /**
   * SEARCH-side opIds this entry exercises as its reference. Also counts toward coverage:
   * a search tool's `total` is itself a count of soft-deletable records (so it carries
   * reportsCount), and it is guarded here by being the number the stats side is held to.
   */
  searchOps?: string[];
  /**
   * Does the STATS side accept `includeArchived`? Default true. The session identity tools
   * do NOT (they have no such param), so their entry runs the default-filter assertion only
   * — asserting the flag-dependent behaviour of a param that does not exist would be a test
   * of nothing dressed as coverage.
   */
  statsSupportsIncludeArchived?: boolean;
  /**
   * true  = the two surfaces MUST agree (fixed / verified).
   * false = a KNOWN divergence, reported and out of scope for an earlier task. Asserted to
   *         still diverge, so fixing it forces an update here rather than silently
   *         drifting out of the matrix.
   */
  reconciles: boolean;
  /** Why, when reconciles === false. Required — a bare `false` is not a reason. */
  knownDivergenceReason?: string;
  liveCount: number;
  archivedCount: number;
  /** Ask the STATS surface for its headline count under the given filter. */
  statsCount: (includeArchived: boolean) => Promise<number>;
  /** Ask the SEARCH/LIST surface for its total under the same filter. */
  searchCount: (includeArchived: boolean) => Promise<number>;
};

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** Both response channels are in play across these tools: `data` (legacy) and `structuredContent`. */
function structured(resp: any): any {
  return resp?.structuredContent ?? resp?.data ?? {};
}

/**
 * project_list PAGINATES (default 20, max 100), so a first-page lookup would find the seeded
 * project only by luck and would start failing as the CI DB accumulates projects. Page to the
 * end. Returns undefined if genuinely absent — which is itself an assertion the caller makes.
 */
async function findInProjectList(name: string): Promise<any> {
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const sc = structured(await viaPublicTool('project_list', { includeStats: true, limit: 100, offset }));
    const rows = (sc.results ?? []) as any[];
    const hit = rows.find((p) => p.name === name);
    if (hit) return hit;
    offset += rows.length;
    if (rows.length === 0 || offset >= Number(sc.total ?? 0)) return undefined;
  }
  return undefined;
}

const RECONCILE_MATRIX: Pair[] = [
  {
    name: 'decision_stats.total_decisions vs decision_search.total',
    entity: 'technical_decisions',
    ops: ['decision_stats'],
    searchOps: ['decision_search'],
    reconciles: true, // FIXED by an earlier task — this is the assertion that was RED before.
    liveCount: LIVE_DECISIONS,
    archivedCount: ARCHIVED_DECISIONS,
    statsCount: async (includeArchived) =>
      structured(await viaPublicTool('decision_stats', { projectId, includeArchived })).total_decisions,
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('decision_search', { projectId, limit: 100, includeArchived })).total,
  },
  {
    name: 'task_progress_summary.totalTasks vs task_list.total',
    entity: 'tasks',
    ops: ['task_progress_summary'],
    searchOps: ['task_list'],
    reconciles: true, // FIXED earlier by an earlier task — pinned here at CLASS level too.
    liveCount: LIVE_TASKS,
    archivedCount: ARCHIVED_TASKS,
    statsCount: async (includeArchived) => {
      const sc = structured(await viaPublicTool('task_progress_summary', { projectId, groupBy: 'status', includeArchived }));
      const groups = (sc.groupedProgress ?? []) as any[];
      return groups.reduce((sum, g) => sum + Number(g.totalTasks ?? 0), 0);
    },
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('task_list', { projectId, limit: 100, includeArchived })).total,
  },
  {
    name: 'context_stats.totalContexts vs context_search.total',
    entity: 'contexts',
    ops: ['context_stats'],
    searchOps: ['context_search'],
    // FIXED by an earlier task (scope extended by Coordinator to close the whole class rather than
    // ship one instance of a three-instance identical defect). It was PINNED HERE as
    // reconciles:false first, then FLIPPED to true when the fix landed — the flip is the
    // point: the entry was never deleted, so the surface went straight from
    // guarded-as-divergent to guarded-as-reconciling with no unguarded window.
    reconciles: true,
    liveCount: LIVE_CONTEXTS,
    archivedCount: ARCHIVED_CONTEXTS,
    statsCount: async (includeArchived) =>
      Number(structured(await viaPublicTool('context_stats', { projectId, includeArchived })).totalContexts),
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('context_search', { projectId, tags: [SEED_TAG], limit: 100, includeArchived })).total,
  },
  // THE TAG CENSUS is a count surface like any other, and it is the newest way to get a
  // wrong population: it reports per-tag record counts, so if it stopped honouring the
  // archive predicate it would disagree with the very search ops callers use it to plan
  // against. Scoped to contexts because SEED_TAG is seeded on contexts only.
  {
    name: 'project_tags SEED_TAG count vs context_search.total',
    entity: 'contexts',
    ops: ['project_tags'],
    searchOps: ['context_search'],
    reconciles: true,
    liveCount: LIVE_CONTEXTS,
    archivedCount: ARCHIVED_CONTEXTS,
    statsCount: async (includeArchived) => {
      const sc = structured(
        await viaPublicTool('project_tags', {
          projectId,
          prefix: SEED_TAG,
          entities: ['context'],
          includeArchived,
        })
      );
      const row = (sc.tags as any[]).find((t) => t.tag === SEED_TAG);
      // A MISSING ROW IS ZERO, and that is a real answer here (the census ran and the tag
      // was not present in the population) — not an excuse to skip the assertion.
      return Number(row?.count ?? 0);
    },
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('context_search', { projectId, tags: [SEED_TAG], limit: 100, includeArchived })).total,
  },
  // project_insights aggregates ALL THREE soft-deletable entities, so it gets THREE entries,
  // not one. Guarding only its decision total would have left getContextInsights and
  // getTaskInsights unwatched — the same "fixed one, the others still count archived" shape
  // this whole file exists to prevent.
  {
    name: 'project_insights decisionsTotal vs decision_search.total',
    entity: 'technical_decisions',
    ops: ['project_insights'],
    searchOps: ['decision_search'],
    reconciles: true, // FIXED by an earlier task (getDecisionInsights). Flipped from a pin.
    liveCount: LIVE_DECISIONS,
    archivedCount: ARCHIVED_DECISIONS,
    statsCount: async (includeArchived) =>
      Number(structured(await viaPublicTool('project_insights', { projectId, includeArchived })).decisionsTotal),
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('decision_search', { projectId, limit: 100, includeArchived })).total,
  },
  {
    name: 'project_insights tasksTotal vs task_list.total',
    entity: 'tasks',
    ops: ['project_insights'],
    searchOps: ['task_list'],
    reconciles: true, // FIXED by an earlier task (getTaskInsights).
    liveCount: LIVE_TASKS,
    archivedCount: ARCHIVED_TASKS,
    statsCount: async (includeArchived) =>
      Number(structured(await viaPublicTool('project_insights', { projectId, includeArchived })).tasksTotal),
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('task_list', { projectId, limit: 100, includeArchived })).total,
  },
  {
    name: 'project_insights context total (text channel) vs context_search.total',
    entity: 'contexts',
    ops: ['project_insights'],
    searchOps: ['context_search'],
    reconciles: true, // FIXED by an earlier task (getContextInsights).
    liveCount: LIVE_CONTEXTS,
    archivedCount: ARCHIVED_CONTEXTS,
    statsCount: async (includeArchived) => {
      // project_insights publishes decisionsTotal/tasksTotal on the structured channel but
      // its CONTEXT total only in the rendered text. The text channel is still a public
      // surface a human reads, so that is what is compared. Parse defensively — a silent
      // regex miss would return NaN and make this entry vacuous.
      const resp = await viaPublicTool('project_insights', { projectId, includeArchived });
      const text: string = resp?.content?.[0]?.text ?? '';
      const m = text.match(/Contexts:\s*(\d+)/);
      expect(m, 'project_insights text channel no longer reports a "Contexts: N" count — update this probe').toBeTruthy();
      return Number(m![1]);
    },
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('context_search', { projectId, tags: [SEED_TAG], limit: 100, includeArchived })).total,
  },
  // ── SESSION IDENTITY COUNTS (Reviewer F2) ────────────────────────────────────────────
  // session_status / session_get / session_list report contextCount / taskCount /
  // decisionCount per session. They were counting ARCHIVED rows on prod (measured
  // 2026-07-30: 18 archived contexts, 429 decisions, 23 tasks) and this guard could not see
  // them AT ALL, because its population was a name pattern and none of them is named
  // `*_stats`. That is the hole `reportsCount` closes.
  //
  // The three share ONE SQL constant (SessionRepo.IDENTITY_SELECT — getIdentityRow serves
  // session_get and session_status, listIdentityRows serves session_list), and
  // sessionCountRule.contract.test.ts pins all three copies of the rule against each other.
  // So one entry covering the three ops is honest, not a shortcut — and session_list is
  // additionally exercised directly below.
  {
    name: 'session identity contextCount vs context_search(sessionId)',
    entity: 'contexts',
    ops: ['session_get', 'session_status', 'session_list'],
    searchOps: ['context_search'],
    // The session tools have NO includeArchived param, so only the default filter is
    // asserted. Pretending to exercise a param that does not exist would be coverage theatre.
    statsSupportsIncludeArchived: false,
    reconciles: true, // FIXED by an earlier task after the Reviewer found it.
    liveCount: SESSION_LIVE_CONTEXTS,
    archivedCount: SESSION_ARCHIVED_CONTEXTS,
    statsCount: async () =>
      Number(structured(await viaPublicTool('session_get', { sessionId })).identity.contextCount),
    // context_search is the ONLY public search surface that accepts a sessionId filter, which
    // is why contexts is the axis this pair can reconcile. decision_search and task_list have
    // no session filter, so the session decision/task counts have no paired surface at all —
    // they are asserted directly against seeded archived decoys further down instead of being
    // dressed up as a reconciliation.
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('context_search', { projectId: sessionProjectId, sessionId, tags: [SESSION_TAG], limit: 100, includeArchived })).total,
  },
  // project_info / project_list report contextCount per project. An earlier draft of this
  // file declared them "not a matrix pair" and gave them standalone tests — but the
  // reportsCount check rejected that, correctly: they ARE reconcilable (a project's
  // contextCount is exactly what context_search returns for that project), and a standalone
  // test is not the ratchet. Neither exposes includeArchived, so only the default filter
  // is asserted; the archived half is covered by the all-archived probe further down.
  {
    name: 'project_info.contextCount vs context_search.total',
    entity: 'contexts',
    ops: ['project_info'],
    searchOps: ['context_search'],
    statsSupportsIncludeArchived: false,
    reconciles: true, // FIXED by an earlier task (the LEFT JOIN condition).
    liveCount: LIVE_CONTEXTS,
    archivedCount: ARCHIVED_CONTEXTS,
    statsCount: async () =>
      Number(structured(await viaPublicTool('project_info', { project: PROJ_NAME })).project.contextCount),
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('context_search', { projectId, tags: [SEED_TAG], limit: 100, includeArchived })).total,
  },
  {
    name: 'project_list.contextCount vs context_search.total',
    entity: 'contexts',
    ops: ['project_list'],
    searchOps: ['context_search'],
    statsSupportsIncludeArchived: false,
    reconciles: true,
    liveCount: LIVE_CONTEXTS,
    archivedCount: ARCHIVED_CONTEXTS,
    statsCount: async () => Number((await findInProjectList(PROJ_NAME)).contextCount),
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('context_search', { projectId, tags: [SEED_TAG], limit: 100, includeArchived })).total,
  },
  {
    name: 'context_get_recent.total vs context_search.total',
    entity: 'contexts',
    ops: [],
    searchOps: ['context_get_recent'],
    reconciles: true,
    liveCount: LIVE_CONTEXTS,
    archivedCount: ARCHIVED_CONTEXTS,
    // context_get_recent's `total` is the size of its returned window BY CONSTRUCTION, so
    // with a limit above the corpus size it is the live count — and must therefore agree
    // with context_search on the same project. It carries reportsCount, so it needs real
    // coverage rather than a bare mention.
    statsCount: async (includeArchived) =>
      Number(structured(await viaPublicTool('context_get_recent', { projectId, limit: 20, includeArchived })).total),
    searchCount: async (includeArchived) =>
      structured(await viaPublicTool('context_search', { projectId, tags: [SEED_TAG], limit: 100, includeArchived })).total,
  },
];

/**
 * THE ASSERTION, factored out so the SELF-TEST below can drive both of its branches with
 * synthetic pairs. Resolves on success, throws the diagnostic on failure.
 */
async function assertDefaultFilter(pair: Pair): Promise<void> {
  const [stats, search] = await Promise.all([pair.statsCount(false), pair.searchCount(false)]);

  // The search side is the reference: it has excluded archived rows since an earlier task.
  expect(search, `${pair.name}: search side must see exactly the live rows`).toBe(pair.liveCount);

  if (pair.reconciles) {
    expect(
      stats,
      `${pair.name}: stats reported ${stats} but search reported ${search} for the SAME default filter. ` +
        `That is the decision_stats 556-vs-127 bug in a new place — a stats breakdown is ` +
        `counting archived rows the search surface hides.`,
    ).toBe(search);
  } else {
    expect(
      stats,
      `${pair.name}: this pair is declared KNOWN-DIVERGENT (${pair.knownDivergenceReason}) but now reports ` +
        `${stats}, matching search's ${search}. If you FIXED it: set reconciles:true and drop the reason. ` +
        `Do not delete the entry — a deleted entry passes and leaves the surface unguarded.`,
    ).toBe(pair.liveCount + pair.archivedCount);
  }
}

/**
 * THE POPULATION: every op that DECLARES it reports a count of soft-deletable records.
 *
 * This used to be `OP_REGISTRY.map(o => o.opId).filter(id => /(_stats|_insights|_progress_summary)$/.test(id))`.
 * That reads like a derivation from the registry and is actually a memory of the names we
 * had already seen. An Reviewer proved it: two schema-complete ops were wired into the
 * registry and `naming_stats` tripped the guard while `session_record_counts` PASSED
 * SILENTLY — and, correspondingly, the real session_status / session_get / session_list
 * counted archived rows on prod with this guard watching and seeing nothing.
 *
 * `reportsCount` is DENY-BY-DEFAULT and declared at the op, so a new count-reporting tool
 * cannot ship without someone answering the question, whatever it is named. See
 * OpRegistryEntry.reportsCount.
 */
function countReportingOpIds(): string[] {
  return OP_REGISTRY.filter((op: any) => op.reportsCount === true).map((op: any) => op.opId);
}

async function seedDecisions(count: number, archived: boolean) {
  if (count <= 0) return;
  await db.query(
    `INSERT INTO technical_decisions
       (project_id, decision_type, title, description, rationale, impact_level, status, archived_at)
     SELECT $1, 'architecture', $2 || g, 'seed', 'seed', 'medium', 'active', ${archived ? 'now()' : 'NULL'}
     FROM generate_series(1, $3) g`,
    [projectId, `dec-${archived ? 'arch' : 'live'}-${STAMP}-`, count],
  );
}

async function seedContexts(count: number, archived: boolean) {
  if (count <= 0) return;
  const { column, dimensions } = activeEmbedder();
  // EVERY seeded context gets an embedding, so `embeddedContexts` is a non-trivial number on
  // BOTH sides of the archived split (5 live / 16 all). Left NULL it would read 0/0 and that
  // aggregate would be asserted vacuously — exactly the "zero population" C3 warns about.
  await db.query(
    `INSERT INTO contexts (project_id, context_type, content, tags, ${column}, archived_at)
     SELECT $1, 'planning', $2 || g, ARRAY[$3]::text[],
            array_fill(0.01::real, ARRAY[${dimensions}])::vector,
            ${archived ? 'now()' : 'NULL'}
     FROM generate_series(1, $4) g`,
    [projectId, `ctx-${archived ? 'arch' : 'live'}-${STAMP}-`, SEED_TAG, count],
  );
}

async function seedTasks(count: number, archived: boolean, status: string = 'todo') {
  if (count <= 0) return;
  await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, archived_at)
     SELECT $1, $2 || g, 'general', 'medium', $3, ${archived ? 'now()' : 'NULL'}
     FROM generate_series(1, $4) g`,
    [projectId, `task-${archived ? 'arch' : 'live'}-${status}-${STAMP}-`, status, count],
  );
}

describe('stats surfaces reconcile with their search surfaces', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'stats/search reconcile fuse') RETURNING id`, [
        PROJ_NAME,
      ])
    ).rows[0].id;
    await bindConnectionToProject(CONN, projectId);

    await seedDecisions(LIVE_DECISIONS, false);
    await seedDecisions(ARCHIVED_DECISIONS, true);
    await seedContexts(LIVE_CONTEXTS, false);
    await seedContexts(ARCHIVED_CONTEXTS, true);
    // Live tasks are deliberately MIXED-status and archived ones are all `todo`, so the
    // derived completion RATE differs between the two populations. With every task `todo`
    // the rate would be 0 either way and the teamEfficiency assertion below would pass
    // without testing anything — the same zero-population trap as embeddedContexts.
    await seedTasks(LIVE_TASKS - LIVE_TASKS_DONE, false, 'todo');
    await seedTasks(LIVE_TASKS_DONE, false, 'completed');
    await seedTasks(ARCHIVED_TASKS, true, 'todo');

    // SESSION-SCOPED fixture (Reviewer F2): one session carrying live AND archived rows on
    // all three child tables, so every session count has an archived decoy to trip over.
    sessionProjectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'session count fixture') RETURNING id`, [
        `stats-reconcile-sess-${STAMP}`,
      ])
    ).rows[0].id;
    sessionId = (
      await db.query(
        `INSERT INTO sessions (project_id, agent_type, actor, status, started_at)
         VALUES ($1, 'mcp-server', $2, 'active', now() - INTERVAL '30 minutes') RETURNING id`,
        [sessionProjectId, `reconcile-${STAMP}`],
      )
    ).rows[0].id;

    const { column, dimensions } = activeEmbedder();
    for (const [n, arch] of [[SESSION_LIVE_CONTEXTS, false], [SESSION_ARCHIVED_CONTEXTS, true]] as const) {
      if (!n) continue;
      await db.query(
        `INSERT INTO contexts (project_id, session_id, context_type, content, tags, ${column}, archived_at)
         SELECT $1, $2, 'planning', $3 || g, ARRAY[$4]::text[],
                array_fill(0.01::real, ARRAY[${dimensions}])::vector, ${arch ? 'now()' : 'NULL'}
         FROM generate_series(1, $5) g`,
        [sessionProjectId, sessionId, `sess-${arch ? 'arch' : 'live'}-${STAMP}-`, SESSION_TAG, n],
      );
    }
    for (const [n, arch] of [[SESSION_LIVE_DECISIONS, false], [SESSION_ARCHIVED_DECISIONS, true]] as const) {
      if (!n) continue;
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, session_id, decision_type, title, description, rationale, impact_level, status, archived_at)
         SELECT $1, $2, 'architecture', $3 || g, 's', 's', 'medium', 'active', ${arch ? 'now()' : 'NULL'}
         FROM generate_series(1, $4) g`,
        [sessionProjectId, sessionId, `sessdec-${arch ? 'arch' : 'live'}-${STAMP}-`, n],
      );
    }
    for (const [n, arch] of [[SESSION_LIVE_TASKS, false], [SESSION_ARCHIVED_TASKS, true]] as const) {
      if (!n) continue;
      await db.query(
        `INSERT INTO tasks (project_id, session_id, title, type, priority, status, archived_at)
         SELECT $1, $2, $3 || g, 'general', 'medium', 'todo', ${arch ? 'now()' : 'NULL'}
         FROM generate_series(1, $4) g`,
        [sessionProjectId, sessionId, `sesstask-${arch ? 'arch' : 'live'}-${STAMP}-`, n],
      );
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM technical_decisions WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    for (const pid of [projectId, sessionProjectId]) {
      await db.query(`DELETE FROM technical_decisions WHERE project_id = $1`, [pid]);
      await db.query(`DELETE FROM contexts WHERE project_id = $1`, [pid]);
      await db.query(`DELETE FROM tasks WHERE project_id = $1`, [pid]);
      await db.query(`DELETE FROM sessions WHERE project_id = $1`, [pid]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [pid]);
    }
  });

  // ── POPULATION COMPLETENESS — the guard's own scope, derived, not remembered ──────────

  test('every soft-deletable table (derived from information_schema) is covered by the matrix', async () => {
    const rows = (
      await db.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'archived_at'
         ORDER BY table_name`,
      )
    ).rows.map((r: any) => r.table_name);

    // Sanity: the sweep instrument itself must not silently return nothing (C3: probe the
    // empty population — an empty list would make the containment check below vacuous).
    expect(rows.length).toBeGreaterThan(0);

    const covered = new Set(RECONCILE_MATRIX.map((p) => p.entity));
    const uncovered = rows.filter((t: string) => !covered.has(t));
    expect(
      uncovered,
      `A table gained an archived_at column but no stats/search pair guards it: ${uncovered.join(', ')}. ` +
        `Add a RECONCILE_MATRIX entry (or, if it has no public stats surface, say so there).`,
    ).toEqual([]);
  });

  test('every op DECLARING reportsCount is covered by the matrix', () => {
    const declared = new Set(RECONCILE_MATRIX.flatMap((p) => [...p.ops, ...(p.searchOps ?? [])]));
    const registryOps = countReportingOpIds();

    // Empty-population probe: if the flag were dropped from every op the containment
    // assertion below would pass vacuously and guard nothing.
    expect(registryOps.length).toBeGreaterThan(0);

    const uncovered = registryOps.filter((id) => !declared.has(id));
    expect(
      uncovered,
      `Op(s) declaring reportsCount with no RECONCILE_MATRIX entry: ${uncovered.join(', ')}. ` +
        `Add each as a pair's stats side (ops) or its reference side (searchOps). A count ` +
        `surface that no search surface is checked against is exactly how decision_stats ` +
        `drifted to 4.4x and how the session counts went unnoticed entirely.`,
    ).toEqual([]);
  });

  test('reportsCount is DENY-BY-DEFAULT and the flag is actually discriminating', () => {
    // If every op carried the flag, "covered" would mean nothing; if none did, the check
    // above is vacuous. Both ends are asserted so the flag has to be a real classification.
    const total = OP_REGISTRY.length;
    const flagged = countReportingOpIds().length;
    expect(flagged).toBeGreaterThan(0);
    expect(flagged).toBeLessThan(total);
    // Deny-by-default: absent must read as false, never undefined-is-truthy.
    const unflagged = OP_REGISTRY.filter((op: any) => op.reportsCount !== true);
    expect(unflagged.length).toBe(total - flagged);
    for (const op of unflagged) expect(Boolean((op as any).reportsCount)).toBe(false);
  });

  test('every known-divergent entry carries a written reason', () => {
    const pinned = RECONCILE_MATRIX.filter((p) => !p.reconciles);
    for (const pair of pinned) {
      expect(pair.knownDivergenceReason, `${pair.name}: reconciles:false needs a reason`).toBeTruthy();
      expect((pair.knownDivergenceReason ?? '').length).toBeGreaterThan(40);
    }
    // Deliberately NOT asserting pinned.length === 0. Zero is today's state, but pinning a
    // newly-found divergence is a legitimate, encouraged move; a test that punished it would
    // push the next person to delete the entry instead — the exact failure mode the header
    // warns about.
  });

  // The ratchet mechanism itself, exercised directly. With no pinned pairs in the matrix the
  // reconciles:false branch of assertDefaultFilter would otherwise be dead code, and dead
  // guard code is guard code that has stopped working without telling anyone.
  test('SELF-TEST: the known-divergent branch fails BOTH ways (the ratchet is not dead code)', async () => {
    const synthetic = (reconciles: boolean, statsValue: number): Pair => ({
      name: 'synthetic', entity: 'contexts', ops: [], reconciles,
      knownDivergenceReason: reconciles ? undefined : 'synthetic pin used only to prove the ratchet still detects both directions',
      liveCount: 5, archivedCount: 11,
      statsCount: async () => statsValue,
      searchCount: async () => 5,
    });

    // A pinned pair that has been FIXED (stats now matches search) must FAIL, telling the
    // author to flip the flag — this is what makes deletion-instead-of-flip visible.
    await expect(assertDefaultFilter(synthetic(false, 5))).rejects.toThrow(/set reconciles:true/);
    // A pinned pair that is still divergent must PASS.
    await expect(assertDefaultFilter(synthetic(false, 16))).resolves.toBeUndefined();
    // A reconciling pair that REGRESSES to counting archived must FAIL.
    await expect(assertDefaultFilter(synthetic(true, 16))).rejects.toThrow(/556-vs-127/);
    // A reconciling pair that agrees must PASS.
    await expect(assertDefaultFilter(synthetic(true, 5))).resolves.toBeUndefined();
  });

  // ── THE FUSE ITSELF ──────────────────────────────────────────────────────────────────

  for (const pair of RECONCILE_MATRIX) {
    const verb = pair.reconciles ? 'AGREES with' : 'is KNOWN-DIVERGENT from';

    test(`${pair.name} — default filter: stats ${verb} search`, async () => {
      await assertDefaultFilter(pair);
    });

    if (pair.reconciles && pair.statsSupportsIncludeArchived !== false) {
      test(`${pair.name} — includeArchived:true: stats AGREES with search AND both grow by the archived rows`, async () => {
        const [stats, search] = await Promise.all([pair.statsCount(true), pair.searchCount(true)]);

        expect(stats).toBe(search);
        // Proves the flag is real and the rows still EXIST — hidden, never lost. (The 428
        // archived prod decisions must be recoverable, not deleted.)
        expect(stats).toBe(pair.liveCount + pair.archivedCount);
      });

      test(`${pair.name} — the two filters differ by exactly the archived rows`, async () => {
        const [dflt, all] = await Promise.all([pair.statsCount(false), pair.statsCount(true)]);
        expect(all - dflt).toBe(pair.archivedCount);
      });
    }
  }

  // ── decision_stats: EVERY breakdown, not just the headline (an earlier task item 2) ─────

  test('decision_stats: every breakdown sums to the VISIBLE total, not the archived-inclusive one', async () => {
    const sc = structured(await viaPublicTool('decision_stats', { projectId }));

    expect(sc.total_decisions).toBe(LIVE_DECISIONS);
    expect(sc.recent_decisions).toBe(LIVE_DECISIONS); // all seeded rows are "recent"
    expect(sc.include_archived).toBe(false);

    const sum = (m: Record<string, number>) => Object.values(m ?? {}).reduce((a, b) => a + Number(b), 0);

    // A partial fix that left ONE of these counting archived is the same defect in a
    // smaller hat — so each breakdown is asserted by name, not as a group.
    expect(sum(sc.by_status), 'by_status').toBe(LIVE_DECISIONS);
    expect(sum(sc.by_type), 'by_type').toBe(LIVE_DECISIONS);
    expect(sum(sc.by_impact), 'by_impact').toBe(LIVE_DECISIONS);
    expect(sum(sc.by_implementation_status), 'by_implementation_status').toBe(LIVE_DECISIONS);
    // by_project is GLOBAL (all projects), so assert THIS project's bucket, not the sum.
    expect(sc.by_project?.[PROJ_NAME], 'by_project').toBe(LIVE_DECISIONS);
  });

  test('decision_stats includeArchived:true reproduces the archived-inclusive numbers on every breakdown', async () => {
    const sc = structured(await viaPublicTool('decision_stats', { projectId, includeArchived: true }));
    const ALL = LIVE_DECISIONS + ARCHIVED_DECISIONS;

    expect(sc.include_archived).toBe(true);
    expect(sc.total_decisions).toBe(ALL);
    expect(sc.recent_decisions).toBe(ALL);

    const sum = (m: Record<string, number>) => Object.values(m ?? {}).reduce((a, b) => a + Number(b), 0);
    expect(sum(sc.by_status), 'by_status').toBe(ALL);
    expect(sum(sc.by_type), 'by_type').toBe(ALL);
    expect(sum(sc.by_impact), 'by_impact').toBe(ALL);
    expect(sum(sc.by_implementation_status), 'by_implementation_status').toBe(ALL);
    expect(sc.by_project?.[PROJ_NAME], 'by_project').toBe(ALL);
  });

  test('decision_stats: the includeArchived STRING form works (bridge sends JSON strings)', async () => {
    const sc = structured(await viaPublicTool('decision_stats', { projectId, includeArchived: 'true' as any }));
    expect(sc.include_archived).toBe(true);
    expect(sc.total_decisions).toBe(LIVE_DECISIONS + ARCHIVED_DECISIONS);
  });

  test('outcome_success_rate is computed over the VISIBLE denominator', async () => {
    // Give the LIVE rows a perfect record and the ARCHIVED rows a failing one. If the rate
    // is computed over the archived-inclusive population it cannot read 100.
    await db.query(
      `UPDATE technical_decisions SET outcome_status = 'successful'
       WHERE project_id = $1 AND archived_at IS NULL`,
      [projectId],
    );
    await db.query(
      `UPDATE technical_decisions SET outcome_status = 'failed'
       WHERE project_id = $1 AND archived_at IS NOT NULL`,
      [projectId],
    );

    const visible = structured(await viaPublicTool('decision_stats', { projectId }));
    const all = structured(await viaPublicTool('decision_stats', { projectId, includeArchived: true }));

    expect(visible.outcome_success_rate, 'live rows are all successful -> 100%').toBe(100);
    // 7 successful / 30 total = 23.33 -> 23. This is the number that was stuck at a
    // machine-record-dragged value on prod even after the records were archived.
    expect(all.outcome_success_rate).toBe(
      Math.round((LIVE_DECISIONS / (LIVE_DECISIONS + ARCHIVED_DECISIONS)) * 100),
    );
    expect(visible.outcome_success_rate).not.toBe(all.outcome_success_rate);

    // Restore so ordering between tests cannot matter.
    await db.query(`UPDATE technical_decisions SET outcome_status = 'unknown' WHERE project_id = $1`, [projectId]);
  });

  // ── context_stats: EVERY aggregate, not just the headline ────────────────────────────

  test('context_stats: all four aggregates describe the VISIBLE population', async () => {
    const sc = structured(await viaPublicTool('context_stats', { projectId }));

    expect(sc.includeArchived).toBe(false);
    expect(sc.totalContexts, 'totalContexts').toBe(LIVE_CONTEXTS);
    // All seeded rows were created just now, so the 24h window == the whole seeded set.
    expect(sc.recentContexts, 'recentContexts (24h)').toBe(LIVE_CONTEXTS);
    // Every seeded row carries an embedding, so this is a real number, not an incidental 0.
    expect(sc.embeddedContexts, 'embeddedContexts').toBe(LIVE_CONTEXTS);
    const byTypeSum = Object.values(sc.contextsByType ?? {}).reduce((a: any, b: any) => a + Number(b), 0);
    expect(byTypeSum, 'contextsByType').toBe(LIVE_CONTEXTS);
  });

  test('context_stats includeArchived:true reproduces the archived-inclusive numbers on all four', async () => {
    const sc = structured(await viaPublicTool('context_stats', { projectId, includeArchived: true }));
    const ALL = LIVE_CONTEXTS + ARCHIVED_CONTEXTS;

    expect(sc.includeArchived).toBe(true);
    expect(sc.totalContexts, 'totalContexts').toBe(ALL);
    expect(sc.recentContexts, 'recentContexts (24h)').toBe(ALL);
    expect(sc.embeddedContexts, 'embeddedContexts').toBe(ALL);
    const byTypeSum = Object.values(sc.contextsByType ?? {}).reduce((a: any, b: any) => a + Number(b), 0);
    expect(byTypeSum, 'contextsByType').toBe(ALL);
  });

  test('context_stats: the includeArchived STRING form works (bridge sends JSON strings)', async () => {
    const sc = structured(await viaPublicTool('context_stats', { projectId, includeArchived: 'true' as any }));
    expect(sc.includeArchived).toBe(true);
    expect(sc.totalContexts).toBe(LIVE_CONTEXTS + ARCHIVED_CONTEXTS);
  });

  // ── project_insights: ALL THREE entity breakdowns ────────────────────────────────────

  test('project_insights: all three entity totals describe the VISIBLE population', async () => {
    const resp = await viaPublicTool('project_insights', { projectId });
    const sc = structured(resp);
    const text: string = resp?.content?.[0]?.text ?? '';

    expect(sc.includeArchived).toBe(false);
    expect(sc.decisionsTotal, 'decisionsTotal').toBe(LIVE_DECISIONS);
    expect(sc.tasksTotal, 'tasksTotal').toBe(LIVE_TASKS);
    expect(text.match(/Contexts:\s*(\d+)/)?.[1], 'contexts (text channel)').toBe(String(LIVE_CONTEXTS));
    // The text and structured channels must not disagree with each other either.
    expect(text.match(/Decisions:\s*(\d+)/)?.[1]).toBe(String(sc.decisionsTotal));
    expect(text.match(/Tasks:\s*(\d+)/)?.[1]).toBe(String(sc.tasksTotal));
  });

  test('project_insights includeArchived:true reproduces the archived-inclusive totals on all three', async () => {
    const resp = await viaPublicTool('project_insights', { projectId, includeArchived: true });
    const sc = structured(resp);
    const text: string = resp?.content?.[0]?.text ?? '';

    expect(sc.includeArchived).toBe(true);
    expect(sc.decisionsTotal, 'decisionsTotal').toBe(LIVE_DECISIONS + ARCHIVED_DECISIONS);
    expect(sc.tasksTotal, 'tasksTotal').toBe(LIVE_TASKS + ARCHIVED_TASKS);
    expect(text.match(/Contexts:\s*(\d+)/)?.[1], 'contexts (text channel)').toBe(String(LIVE_CONTEXTS + ARCHIVED_CONTEXTS));
  });

  test('project_insights: teamEfficiency completion rate is computed over LIVE tasks', async () => {
    // The archived tasks are all `todo`, so if they leaked into the denominator the rate
    // DROPS. This is the project_insights analogue of decision_stats' outcome_success_rate —
    // a derived metric silently computed over the wrong population, which is the whole
    // reason an earlier task exists rather than being a cosmetic count fix.
    const visible = structured(await viaPublicTool('project_insights', { projectId }));
    const all = structured(await viaPublicTool('project_insights', { projectId, includeArchived: true }));

    const round2 = (n: number) => Math.round(n * 100) / 100;
    expect(round2(visible.teamEfficiency.completionRate), 'live: 3 of 9 complete').toBe(
      round2(LIVE_TASKS_DONE / LIVE_TASKS),
    );
    expect(round2(all.teamEfficiency.completionRate), 'archived-inclusive: 3 of 13').toBe(
      round2(LIVE_TASKS_DONE / (LIVE_TASKS + ARCHIVED_TASKS)),
    );
    expect(visible.teamEfficiency.completionRate).toBeGreaterThan(all.teamEfficiency.completionRate);
  });

  // ── project_info / project_list contextCount (same omission, not a stats/search pair) ──

  test('project_info + project_list contextCount count LIVE contexts only', async () => {
    const info = structured(await viaPublicTool('project_info', { project: PROJ_NAME }));
    expect(info.project?.contextCount, 'project_info.contextCount').toBe(LIVE_CONTEXTS);

    const mine = await findInProjectList(PROJ_NAME);
    expect(mine, 'seeded project must appear in project_list').toBeTruthy();
    expect(mine.contextCount, 'project_list.contextCount').toBe(LIVE_CONTEXTS);
  });

  test('a project whose contexts are ALL archived still APPEARS in project_list, with count 0', async () => {
    // The LEFT JOIN trap: putting the archived predicate in WHERE instead of the JOIN
    // condition would make this project vanish from the list entirely — a count fix that
    // silently deletes rows from a listing is worse than the miscount it replaced.
    const nm = `stats-reconcile-ctxarch-${STAMP}`;
    const pid = (await db.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [nm])).rows[0].id;
    try {
      const { column, dimensions } = activeEmbedder();
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content, ${column}, archived_at)
         SELECT $1, 'planning', 'gone-' || g, array_fill(0.01::real, ARRAY[${dimensions}])::vector, now()
         FROM generate_series(1, 4) g`,
        [pid],
      );
      const row = await findInProjectList(nm);
      expect(row, 'all-archived project must NOT disappear from project_list').toBeTruthy();
      expect(row.contextCount).toBe(0);

      const info = structured(await viaPublicTool('project_info', { project: nm }));
      expect(info.project?.contextCount).toBe(0);
    } finally {
      await db.query(`DELETE FROM contexts WHERE project_id = $1`, [pid]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [pid]);
    }
  });

  // ── SESSION IDENTITY COUNTS: the two axes with NO paired search surface (Reviewer F2) ─
  // decision_search and task_list accept no sessionId filter, so there is no public number
  // to reconcile these against. Rather than dress that up as a reconciliation, they are
  // asserted DIRECTLY against seeded archived decoys — the decoys are what make the
  // assertion discriminating, and their existence is asserted first so it cannot go vacuous.

  test('PRECONDITION: the fixture session carries ARCHIVED rows on all three child tables', async () => {
    const r = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM contexts            WHERE session_id = $1 AND archived_at IS NOT NULL) AS ctx,
              (SELECT COUNT(*)::int FROM tasks               WHERE session_id = $1 AND archived_at IS NOT NULL) AS tasks,
              (SELECT COUNT(*)::int FROM technical_decisions WHERE session_id = $1 AND archived_at IS NOT NULL) AS dec`,
      [sessionId],
    );
    expect(r.rows[0].ctx).toBe(SESSION_ARCHIVED_CONTEXTS);
    expect(r.rows[0].tasks).toBe(SESSION_ARCHIVED_TASKS);
    expect(r.rows[0].dec).toBe(SESSION_ARCHIVED_DECISIONS);
    for (const v of Object.values(r.rows[0])) expect(Number(v)).toBeGreaterThan(0);
  });

  test('session_get identity counts EXCLUDE archived rows on all three child tables', async () => {
    const id = structured(await viaPublicTool('session_get', { sessionId })).identity;
    expect(Number(id.contextCount), 'contextCount').toBe(SESSION_LIVE_CONTEXTS);
    expect(Number(id.taskCount), 'taskCount').toBe(SESSION_LIVE_TASKS);
    expect(Number(id.decisionCount), 'decisionCount').toBe(SESSION_LIVE_DECISIONS);
  });

  test('session_list reports the SAME counts as session_get (one read model, two surfaces)', async () => {
    // NAME THE PROJECT. `viaPublicTool` passes no connection, so an
    // unscoped session_list resolves through the SHARED default session slot →
    // `initializeSession` Priority 4 → `projects[0]`, ordered by `updated_at DESC`. This
    // assertion passed only because `sessionProjectId` is the LAST project this file's
    // beforeAll inserts and therefore happened to sort first. Measured with one decoy
    // project carrying a future `updated_at`: the fixture session vanished from the list and
    // the test failed with `expected undefined to be truthy`. `project` is rung 1 — an
    // explicit argument — and beats every ambient rung.
    const listed = structured(await viaPublicTool('session_list', { project: sessionProjectId, limit: 100 }));
    const rows = (listed.results ?? listed.sessions ?? []) as any[];
    const mine = rows.find((r: any) => r.id === sessionId || r.sessionId === sessionId);
    expect(mine, 'the fixture session must appear in session_list').toBeTruthy();
    expect(Number(mine.contextCount), 'contextCount').toBe(SESSION_LIVE_CONTEXTS);
    expect(Number(mine.taskCount), 'taskCount').toBe(SESSION_LIVE_TASKS);
    expect(Number(mine.decisionCount), 'decisionCount').toBe(SESSION_LIVE_DECISIONS);
  });

  // ── BOTH TOOL SURFACES (an earlier task acceptance 5) ──────────────────────────────────
  // Mandrel advertises TWO surfaces: the flat per-tool API (/mcp/tools/decision_stats, the
  // routeExecutor path used above) and the gateway (decision({action:'stats'}), what Coordinator
  // and the agents actually call). A fix applied to only one of them is C5 — two paths that
  // must do the same thing and one that quietly does not.

  test('gateway surface agrees with the flat surface — context_stats and project_insights too', async () => {
    const conn = `recon-x-${STAMP}`;
    // context.stats
    const gwCtx = await dispatchGateway('context', { action: 'stats', projectId }, { connectionId: conn });
    const gwCtxA = await dispatchGateway('context', { action: 'stats', projectId, includeArchived: true }, { connectionId: conn });
    expect(structured(gwCtx).totalContexts).toBe(
      structured(await viaPublicTool('context_stats', { projectId })).totalContexts,
    );
    expect(structured(gwCtxA).totalContexts).toBe(LIVE_CONTEXTS + ARCHIVED_CONTEXTS);
    expect(structured(gwCtxA).totalContexts).not.toBe(structured(gwCtx).totalContexts);

    // project.insights
    const gwPi = await dispatchGateway('project', { action: 'insights', projectId }, { connectionId: conn });
    const gwPiA = await dispatchGateway('project', { action: 'insights', projectId, includeArchived: true }, { connectionId: conn });
    expect(structured(gwPi).decisionsTotal).toBe(
      structured(await viaPublicTool('project_insights', { projectId })).decisionsTotal,
    );
    expect(structured(gwPiA).decisionsTotal).toBe(LIVE_DECISIONS + ARCHIVED_DECISIONS);
    expect(structured(gwPiA).tasksTotal).toBe(LIVE_TASKS + ARCHIVED_TASKS);
    expect(structured(gwPiA).decisionsTotal).not.toBe(structured(gwPi).decisionsTotal);
  });

  test('gateway surface agrees with the flat surface, on BOTH filters', async () => {
    const gwText = (resp: any) => (resp?.content?.[0]?.text ?? '') as string;
    const gwTotal = (resp: any) => {
      const m = gwText(resp).match(/Total Decisions:\s*(\d+)/);
      expect(m, 'gateway decision.stats no longer renders "Total Decisions: N"').toBeTruthy();
      return Number(m![1]);
    };

    const gwDefault = await dispatchGateway('decision', { action: 'stats', projectId }, { connectionId: `recon-${STAMP}` });
    const gwAll = await dispatchGateway(
      'decision',
      { action: 'stats', projectId, includeArchived: true },
      { connectionId: `recon-${STAMP}` },
    );

    const flatDefault = structured(await viaPublicTool('decision_stats', { projectId })).total_decisions;
    const flatAll = structured(await viaPublicTool('decision_stats', { projectId, includeArchived: true })).total_decisions;

    expect(gwTotal(gwDefault), 'gateway default').toBe(flatDefault);
    expect(gwTotal(gwAll), 'gateway includeArchived:true').toBe(flatAll);
    expect(gwTotal(gwDefault)).toBe(LIVE_DECISIONS);
    expect(gwTotal(gwAll)).toBe(LIVE_DECISIONS + ARCHIVED_DECISIONS);
    // The gateway must ACCEPT the param, not silently strip it (strict-mode rejection or a
    // dropped param would both show up as gwAll === gwDefault).
    expect(gwTotal(gwAll)).not.toBe(gwTotal(gwDefault));
  });

  // ── EMPTY / ZERO POPULATION (C3: the values that slip through) ────────────────────────

  test('a project with ZERO decisions reconciles too (0 == 0, no crash, no NaN)', async () => {
    const emptyId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'empty') RETURNING id`, [
        `stats-reconcile-empty-${STAMP}`,
      ])
    ).rows[0].id;
    try {
      const sc = structured(await viaPublicTool('decision_stats', { projectId: emptyId }));
      const se = structured(await viaPublicTool('decision_search', { projectId: emptyId, limit: 100 }));
      expect(sc.total_decisions).toBe(0);
      expect(se.total).toBe(0);
      expect(sc.outcome_success_rate).toBe(0); // not NaN
      expect(sc.by_project?.[`stats-reconcile-empty-${STAMP}`]).toBeUndefined();
    } finally {
      await db.query(`DELETE FROM projects WHERE id = $1`, [emptyId]);
    }
  });

  test('a project whose decisions are ALL archived disappears from by_project (and returns under the flag)', async () => {
    const allArchName = `stats-reconcile-allarch-${STAMP}`;
    const allArchId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'all archived') RETURNING id`, [allArchName])
    ).rows[0].id;
    try {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level, status, archived_at)
         SELECT $1, 'architecture', 'gone-' || g, 's', 's', 'medium', 'active', now()
         FROM generate_series(1, 3) g`,
        [allArchId],
      );

      // by_project is the breakdown most likely to be forgotten (it is the only GLOBAL,
      // JOINed one) — which is exactly why it is probed at its hardest value.
      const visible = structured(await viaPublicTool('decision_stats', { projectId }));
      expect(visible.by_project?.[allArchName], 'all-archived project must vanish from by_project').toBeUndefined();

      const all = structured(await viaPublicTool('decision_stats', { projectId, includeArchived: true }));
      expect(all.by_project?.[allArchName], 'and must come back under includeArchived').toBe(3);
    } finally {
      await db.query(`DELETE FROM technical_decisions WHERE project_id = $1`, [allArchId]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [allArchId]);
    }
  });
});
