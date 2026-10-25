/**
 * rung-1 PROJECT ARGUMENT NORMALIZER — regression contract for an earlier task.
 *
 * THE BUG (reproduced before it was fixed; evidence an earlier note)
 * ------------------------------------------------------------------------------
 *   context_store({ projectId: '<project NAME>', tags: ['task:<id8>'] })
 *       → tagEdgesMinted: 0, tagEdgeSkips: [{ reason: 'task "<id8>" could not be resolved' }]
 *   context_store({ tags: ['task:<id8>'] })            // identical but no projectId
 *       → tagEdgesMinted: 1, edge informs → task
 *
 * `projectId` was documented as accepting a project NAME, and the WRITE path honoured that
 * (the handlers' own ensureProjectId resolves name→id), but the EDGE path did not: the raw
 * string went into `AND project_id = $n` against a `uuid` column, Postgres raised
 * `invalid input syntax for type uuid`, and links.ts's catch-all reported the REFERENT as
 * unresolvable. A FALSE NEGATIVE about the task, for a task that exists — the no-silent-orphan
 * guarantee (Treewalker) defeated by an argument the caller was told to pass.
 *
 * WHICH PATH WAS BROKEN (measured, not assumed)
 * ---------------------------------------------
 * ONLY the UNBOUND, explicit-argument path. A client BOUND via X-Mandrel-Project was already
 * safe: resolveProjectBinding resolves the binding through projectHandler.getProject (name OR
 * uuid) and routeExecutor materialises the canonical UUID into the tool's own scope argument,
 * so a name never reached SQL. The `bound path is unaffected` cases below PIN that, so the
 * fix cannot be "corrected" later into re-breaking it.
 *
 * WHAT IS GUARDED, AND HOW
 * -------------------------------------
 * The observable is THE EDGE ROW IN POSTGRES — `SELECT ... FROM links` — not a helper's
 * return value and not the response's self-report. A response field can be right while the
 * graph is wrong (that was an earlier task's bug, in the other direction), so the assertion is
 * made against the thing the product is actually for. Every case drives the REAL public path:
 * validateToolArguments → routeExecutor, exactly as the MCP surface does.
 *
 * MUTATION PROBE: deleting the `lookup()` normalization in services/projectBinding.ts's unbound
 * branch (or re-gating routeExecutor's materialisation on `binding.bound`) MUST turn the first
 * two describe blocks RED. Verified by hand at build time; re-verify if you touch either site.
 *
 * Run inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim } from './helpers/embedGeometry.js';

// Embeddings are irrelevant to project-scope resolution — a zero vector keeps the write
// path real without a model. (Zeros also keep similarity-driven inference from minting an
// extra edge, so the link counts below measure ONLY the tag path.)
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: new Array(embedDim()).fill(0),
      model: 'stub-zero',
      dimensions: embedDim(),
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { declaredParamKeys } from '../middleware/validation.js';
import { validationSchemas } from '../middleware/validation.js';
import {
  classifyProjectParam,
  PROJECT_PARAM_PATTERN,
  PROJECT_BINDING_ERROR_CODES,
  ProjectArgUnresolvedError,
  resolveProjectBinding,
} from '../services/projectBinding.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const PROJECT_NAME = `arg-normalizer-${STAMP}`;
const NO_SUCH_PROJECT = `no-such-project-${STAMP}`;

let projectId = '';
let taskId = '';

/** The REAL public path: validate exactly as the MCP surface does, then dispatch. */
async function viaTool(
  tool: string,
  rawArgs: Record<string, unknown>,
  conn: string,
  projectBinding?: string
): Promise<any> {
  const validated = validateToolArguments(tool, rawArgs);
  return routeExecutor(tool, validated, { connectionId: conn, projectBinding } as any);
}

const responseText = (r: any): string => r?.content?.map((c: any) => c.text).join('\n') ?? '';

function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`no id in response: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}
const id8 = (u: string) => u.replace(/-/g, '').slice(0, 8);

/**
 * THE OBSERVABLE. The edges the GRAPH actually holds out of this record, read straight from
 * Postgres — the side the bug was on. A store response claiming success proves nothing here.
 */
async function edgesInDb(fromId: string): Promise<Array<{ to_id: string; edge_type: string }>> {
  const r = await db.query(
    `SELECT to_id::text AS to_id, edge_type FROM links WHERE from_id = $1 ORDER BY edge_type`,
    [fromId]
  );
  return r.rows;
}

/** Store a capture tagged at `taskId`, scoped however the case says, and return its edges. */
async function storeTaggedAndReadGraph(
  label: string,
  scope: Record<string, unknown>,
  conn: string,
  projectBinding?: string
): Promise<{ resp: any; edges: Array<{ to_id: string; edge_type: string }> }> {
  const resp = await viaTool(
    'context_store',
    { content: `normalizer case: ${label}`, type: 'completion', tags: [`task:${id8(taskId)}`], ...scope },
    conn,
    projectBinding
  );
  expect(resp.isError, `${label}: store itself must succeed — ${responseText(resp).slice(0, 200)}`)
    .not.toBe(true);
  return { resp, edges: await edgesInDb(resp.structuredContent.context.id) };
}

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'rung-1 normalizer fixture') RETURNING id`,
      [PROJECT_NAME]
    )
  ).rows[0].id;

  const conn = `norm-setup-${STAMP}`;
  await bindConnectionToProject(conn, projectId);
  taskId = parseId(
    await viaTool('task_create', { title: `normalizer target ${STAMP}`, type: 'feature' }, conn)
  );
});

afterAll(async () => {
  try {
    if (projectId) {
      for (const t of ['links', 'contexts', 'technical_decisions', 'tasks', 'sessions']) {
        await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]);
      }
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
  } catch {
    /* best effort */
  }
  await db.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a project NAME in an explicit scope arg still mints the edge', () => {
  /**
   * THE EXACT FILED REPRODUCER. Pre-fix this produced ZERO rows in `links` and a skip
   * blaming the task; the task existed the whole time.
   */
  test('projectId as a NAME mints the tag edge (the bug)', async () => {
    const { resp, edges } = await storeTaggedAndReadGraph(
      'name',
      { projectId: PROJECT_NAME },
      `norm-name-${STAMP}`
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].to_id).toBe(taskId);
    expect(edges[0].edge_type).toBe('informs');
    // And the response must not blame the referent for a project-scope problem.
    expect(resp.structuredContent.context.tagEdgeSkips ?? []).toEqual([]);
  });

  /**
   * THE ACCEPTANCE from the task: all three forms of the argument are INDISTINGUISHABLE in
   * outcome. Asserted as one property so a future divergence between any two of them is RED,
   * rather than three independent snapshots that can drift apart.
   */
  test('NAME, UUID and OMITTED are identical in the graph', async () => {
    const name = await storeTaggedAndReadGraph('id-name', { projectId: PROJECT_NAME }, `n1-${STAMP}`);
    const uuid = await storeTaggedAndReadGraph('id-uuid', { projectId }, `n2-${STAMP}`);
    // THE OMITTED ARM MUST BE BOUND FIRST. "No scope argument" means "use the
    // connection's CURRENT project" — that is the third form this test claims is identical.
    // On an UNBOUND connection it means something else entirely: `initializeSession`'s
    // Priority-4 `projects[0]`, ordered by `updated_at DESC`, i.e. whichever project the
    // ambient database touched last. Measured with one decoy project carrying a future
    // `updated_at`: this case stored into the DECOY, minted no tag edge, and failed with
    // `expected [] to deeply equal [ Array(1) ]` — a fixture defect wearing the costume of a
    // normalizer defect. Binding makes the arm test the rung it is named for.
    const omittedConn = `n3-${STAMP}`;
    await bindConnectionToProject(omittedConn, PROJECT_NAME);
    const omitted = await storeTaggedAndReadGraph('id-omitted', {}, omittedConn);

    const shape = (e: Array<{ to_id: string; edge_type: string }>) =>
      e.map((x) => `${x.edge_type}->${x.to_id}`);
    expect(shape(name.edges)).toEqual([`informs->${taskId}`]);
    expect(shape(uuid.edges)).toEqual(shape(name.edges));
    expect(shape(omitted.edges)).toEqual(shape(name.edges));
  });

  /**
   * WHOLE-CLASS, not just the instance. The un-normalized name did not merely
   * sever edges — it hard-failed, outright, EVERY tool that put the argument into a
   * project-scoped predicate without name-aware resolution of its own, with the raw Postgres
   * cast error `invalid input syntax for type uuid`.
   *
   * AT LEAST twelve such tools were reproduced on f9de00d (2026-07-25) — task_create,
   * task_list, task_details, task_progress_summary, context_search, context_update,
   * decision_record, decision_search, decision_stats, recall_thread, thread_set,
   * and one stored-scan reader — sampled from 43 scoped project params. That enumeration is a FLOOR
   * and deliberately not a definition: the first count taken (seven) was later found short by
   * five, which is exactly why a list like this must never be read as complete. The property
   * is what is guarded, and the schema-derived sweep at the bottom of this file is what
   * guards it for tools nobody has enumerated — including ones that do not exist yet.
   *
   * task_create is the representative case dispatched end-to-end here: it WRITES, so a
   * regression is unambiguous in the database rather than in a response string.
   */
  test('a NAME works on a tool that had NO name-aware resolution of its own (task_create)', async () => {
    const resp = await viaTool(
      'task_create',
      { title: `named-scope task ${STAMP}`, type: 'feature', projectId: PROJECT_NAME },
      `norm-taskcreate-${STAMP}`
    );
    expect(responseText(resp)).not.toMatch(/invalid input syntax for type uuid/i);
    expect(resp.isError).not.toBe(true);

    // The row must land in THAT project — resolved, not merely "did not throw".
    const row = await db.query(`SELECT project_id::text AS pid FROM tasks WHERE id = $1`, [
      parseId(resp),
    ]);
    expect(row.rows[0].pid).toBe(projectId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an unresolvable project scope fails LOUD, never silently', () => {
  /**
   * The other half of the fix. Pre-fix an unresolvable value produced FOUR different
   * outcomes depending on which handler received it (a clean not-found, a raw Postgres cast
   * error, a NON-error response carrying ❌ in its prose, and a false skip about the
   * referent). One typed error now replaces all four — and critically it is an ERROR, so a
   * caller cannot mistake it for a successful scoped call.
   */
  test('a garbage project name is refused with the typed PROJECT_ARG_UNRESOLVED code', async () => {
    const resp = await viaTool(
      'context_store',
      { content: 'should never be stored', type: 'completion', projectId: NO_SUCH_PROJECT },
      `norm-bad-${STAMP}`
    );
    expect(resp.isError).toBe(true);
    expect(responseText(resp)).toContain(PROJECT_BINDING_ERROR_CODES.ARG_UNRESOLVED);
    expect(responseText(resp)).toContain(NO_SUCH_PROJECT);
  });

  test('the refusal happens BEFORE the write — nothing is persisted', async () => {
    const before = (await db.query('SELECT count(*)::int n FROM contexts')).rows[0].n;
    await viaTool(
      'context_store',
      { content: `must-not-persist-${STAMP}`, type: 'completion', projectId: NO_SUCH_PROJECT },
      `norm-bad2-${STAMP}`
    );
    const after = (await db.query('SELECT count(*)::int n FROM contexts')).rows[0].n;
    expect(after).toBe(before);
  });

  /**
   * LEGACY-BEHAVIOUR CHECK. Fail-loud normalization would be a real behaviour
   * BREAK if any handler today auto-created a project from an unresolved name. Measured
   * pre-fix across every scoped tool: none does (projects count unchanged). This pins that —
   * if someone later adds auto-vivification, this goes RED and the decision gets made
   * deliberately instead of discovered in prod.
   */
  test('an unresolved project name AUTO-CREATES nothing', async () => {
    const before = (await db.query('SELECT count(*)::int n FROM projects')).rows[0].n;
    for (const tool of ['context_store', 'task_create', 'context_search'] as const) {
      const args: Record<string, unknown> =
        tool === 'context_store'
          ? { content: 'x', type: 'completion' }
          : tool === 'task_create'
            ? { title: 'x', type: 'feature' }
            : { query: 'x' };
      await viaTool(tool, { ...args, projectId: NO_SUCH_PROJECT }, `norm-ac-${tool}-${STAMP}`);
    }
    const after = (await db.query('SELECT count(*)::int n FROM projects')).rows[0].n;
    expect(after).toBe(before);
    const vivified = await db.query(`SELECT name FROM projects WHERE name = $1`, [NO_SUCH_PROJECT]);
    expect(vivified.rows).toHaveLength(0);
  });

  /**
   * DO NOT "fix" this by making everything resolve. A referent that genuinely does not exist
   * must STILL be skipped and surfaced — the write succeeds, the edge does not, and the user
   * is told. This is the guard against a future normalizer that over-reaches.
   */
  test('a genuinely unresolvable REFERENT is still skipped and surfaced (under a valid NAME scope)', async () => {
    const resp = await viaTool(
      'context_store',
      {
        content: 'tagged at a task that does not exist',
        type: 'completion',
        projectId: PROJECT_NAME,
        tags: ['task:deadbeef'],
      },
      `norm-ghost-${STAMP}`
    );
    expect(resp.isError).not.toBe(true);
    const ctx = resp.structuredContent.context;
    expect(ctx.tagEdgesMinted).toBe(0);
    expect(ctx.tagEdgeSkips).toHaveLength(1);
    expect(ctx.tagEdgeSkips[0].ref).toBe('deadbeef');
    expect(await edgesInDb(ctx.id)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the BOUND path was already safe and must stay that way', () => {
  /**
   * Claim verified before the fix was written: a client bound BY NAME already got a canonical
   * UUID materialised into its scope argument, so its edges always minted. These two cases
   * exist so a future change to the normalizer cannot regress the path it was never on.
   */
  test('bound by NAME with no explicit argument still mints the edge', async () => {
    const { edges } = await storeTaggedAndReadGraph(
      'bound-name',
      {},
      `norm-bound-${STAMP}`,
      PROJECT_NAME
    );
    expect(edges.map((e) => e.to_id)).toEqual([taskId]);
  });

  test('bound by NAME plus an explicit NAME (agreeing) still mints the edge', async () => {
    const { edges } = await storeTaggedAndReadGraph(
      'bound-name-explicit',
      { projectId: PROJECT_NAME },
      `norm-bound2-${STAMP}`,
      PROJECT_NAME
    );
    expect(edges.map((e) => e.to_id)).toEqual([taskId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the normalizer is anchored on the schema, not on a tool list', () => {
  /**
   * FAIL-CLOSED COVERAGE. The fix must not be "the tools we thought of". The
   * normalizer keys off each tool's OWN declared scope parameter, so this walks EVERY tool in
   * the schema registry, and for every one that declares a `scoped` project param asserts the
   * resolver canonicalises a NAME passed in THAT param. A project-scoped tool added tomorrow
   * is covered the day it is born — and if someone narrows the normalizer to a hand-written
   * list, the tools left out turn this RED.
   *
   * This calls resolveProjectBinding directly (not routeExecutor) ON PURPOSE: it is the
   * per-tool sweep, and dispatching ~43 real tools would be asserting the handlers, not the
   * rule. The end-to-end proof that the resolution actually REACHES the database lives in the
   * graph-level cases above — the two together are the claim, and neither stands alone.
   */
  test('EVERY tool with a scoped project param canonicalises a NAME to the project UUID', async () => {
    const checked: string[] = [];
    for (const tool of Object.keys(validationSchemas)) {
      const declared = declaredParamKeys(tool);
      if (!declared) continue;
      for (const param of declared) {
        if (!PROJECT_PARAM_PATTERN.test(param)) continue;
        if (classifyProjectParam(tool, param) !== 'scoped') continue;

        const res = await resolveProjectBinding(tool, { [param]: PROJECT_NAME });
        expect(res.source, `${tool}.${param}`).toBe('explicit');
        expect(res.projectId, `${tool}.${param} must resolve the NAME to the canonical UUID`).toBe(
          projectId
        );
        expect(res.scopeParam, `${tool}.${param}`).toBe(param);
        checked.push(`${tool}.${param}`);
      }
    }
    // The sweep must actually have swept something — a coverage test that silently checks
    // zero cases is the allow-list it was meant to replace.
    expect(checked.length).toBeGreaterThan(20);
  });

  test('an unresolvable NAME throws the typed error for EVERY scoped param, not just the ones we tried', async () => {
    for (const tool of Object.keys(validationSchemas)) {
      const declared = declaredParamKeys(tool);
      if (!declared) continue;
      for (const param of declared) {
        if (!PROJECT_PARAM_PATTERN.test(param)) continue;
        if (classifyProjectParam(tool, param) !== 'scoped') continue;
        await expect(
          resolveProjectBinding(tool, { [param]: NO_SUCH_PROJECT }),
          `${tool}.${param}`
        ).rejects.toBeInstanceOf(ProjectArgUnresolvedError);
      }
    }
  });

  /**
   * THE UNTOUCHED PATH. A call with NO explicit project argument must still return
   * `interactive` with NO projectId imposed — the normalizer must not have quietly become a
   * third rung that pins every call. (It also must not cost that call a DB round-trip, which
   * is why the product returns before lookup(); this asserts the observable half of that.)
   */
  test('no explicit argument → rung 3, untouched', async () => {
    const res = await resolveProjectBinding('context_store', { content: 'x' });
    expect(res.source).toBe('interactive');
    expect(res.bound).toBe(false);
    expect(res.projectId).toBeUndefined();
  });

  /**
   * EXEMPT params are project ADMINISTRATION by handle (rename/inspect/delete a named
   * project). Normalising those to a UUID is not wrong, but treating them as a write SCOPE
   * is — this pins that the normalizer leaves them alone, so `project_update`'s handle
   * semantics cannot be silently converted into a scope selection.
   */
  test('exempt admin params are NOT treated as a scope to normalise', async () => {
    const res = await resolveProjectBinding('project_update', { project: PROJECT_NAME });
    expect(res.projectId).toBeUndefined();
    expect(res.source).toBe('interactive');
  });
});
