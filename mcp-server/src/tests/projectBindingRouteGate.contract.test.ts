/**
 * PROJECT BINDING at the ROUTE CHOKE POINT — end-to-end, real Postgres, real tools.
 * an earlier task (Amp-orb eval finding W5, client half; report acceptance 518-520).
 *
 * The sibling file (projectBinding.contract.test.ts) proves the RULE. This file proves the
 * rule is actually WIRED — that a real `context_store` from a bound client lands in the bound
 * project, that a mismatched call is rejected before anything is written, and that the write
 * audit carries the project id. It drives `routeExecutor` (the single seam both the flat
 * /mcp/tools/* surface and the gateway dispatcher pass through), not a route method, so it
 * exercises the same path a live orb does.
 *
 * THE DENY-BY-DEFAULT SWEEP (the guard that cannot rot)
 * ----------------------------------------------------
 * The mismatch case is not asserted for a hand-picked tool or two. It is asserted for EVERY
 * member of `ACTION_TOOLS` — the product's OWN single source of truth for "this tool persists
 * user-authored content". Adding a write tool to that set automatically puts it under this
 * guard; there is no list here to forget to update (a past incident / a past incident #1).
 *
 * Run inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { patternEmbedding } from './helpers/embedGeometry.js';

// Distinct ids per real create (global setup mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Embeddings are stubbed offline (native transformers unavailable in CI); the DB write path
// and the project resolution under test still run for real.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding() })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor, ACTION_TOOLS } from '../routes/index.js';
import { projectHandler } from '../handlers/project.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { logger } from '../utils/logger.js';
import {
  PROJECT_AUDIT_PREFIX,
  PROJECT_BINDING_ERROR_CODES,
  projectScopeParam,
  resolveProjectBinding,
  classifyProjectParam,
} from '../services/projectBinding.js';
import { validationSchemas } from '../middleware/validation.js';
import { PROJECT_BINDING_ENV_VAR } from '../config/projectBindingConfig.js';

const STAMP = Date.now();
const BOUND_PROJECT = `rg-amp-exp-1-${STAMP}`;
const OTHER_PROJECT = `rg-daily-log-${STAMP}`;

let boundId: string;
let otherId: string;

/** Minimal valid arguments for each ACTION tool, so the sweep can call them for real. */
function minimalArgsFor(tool: string): Record<string, unknown> {
  switch (tool) {
    case 'context_store':
      return { content: `sweep ${tool} ${STAMP}`, type: 'completion' };
    case 'task_create':
      return { title: `sweep ${tool} ${STAMP}` };
    case 'decision_record':
      return {
        title: `sweep ${tool} ${STAMP}`,
        description: `sweep decision for ${tool}`,
        rationale: 'binding sweep',
        decisionType: 'process',
        impactLevel: 'low',
      };
    default:
      // FAIL LOUD: a new ACTION tool with no arguments declared here must RED this sweep,
      // not silently skip. An untested write tool is exactly the hole this sweep exists
      // to prevent.
      throw new Error(
        `ACTION tool '${tool}' has no minimal args in projectBindingRouteGate.contract.test.ts — ` +
          `add them so the binding sweep actually calls it.`
      );
  }
}

/**
 * The table each ACTION tool writes, so the "ZERO rows written" assertion observes the row
 * the tool would actually have created. A Proxy rather than a plain object so an ACTION tool
 * added tomorrow without an entry THROWS here (fail-closed) instead of silently reading
 * `undefined` and producing a nonsense query.
 */
const WRITE_TABLE_FOR: Record<string, string> = new Proxy(
  {
    context_store: 'contexts',
    task_create: 'tasks',
    decision_record: 'technical_decisions',
  } as Record<string, string>,
  {
    get(target, prop: string) {
      if (!(prop in target)) {
        throw new Error(
          `ACTION tool '${prop}' has no write table in projectBindingRouteGate.contract.test.ts — ` +
            `add it so the "zero rows written" assertion observes the right table.`
        );
      }
      return target[prop];
    },
  }
);

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

beforeAll(async () => {
  boundId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'bound') RETURNING id`, [
      BOUND_PROJECT,
    ])
  ).rows[0].id;
  otherId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'other') RETURNING id`, [
      OTHER_PROJECT,
    ])
  ).rows[0].id;
});

afterAll(async () => {
  for (const t of ['contexts', 'tasks', 'technical_decisions', 'sessions']) {
    await db.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[boundId, otherId]]);
  }
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[boundId, otherId]]);
});

afterEach(() => {
  delete process.env[PROJECT_BINDING_ENV_VAR];
  vi.restoreAllMocks();
});

describe('ACCEPTANCE 1 — a client configured for `amp-exp-1` STARTS in that project', () => {
  test('a bound client’s very first context_store lands in the bound project, with no switch', async () => {
    const conn = `bind-first-write-${STAMP}`;
    // Pre-condition: this connection has NEVER switched. Left to auto-selection it would
    // land wherever `initializeSession` picks (the eval's `daily log` failure).
    expect(await projectHandler.getCurrentProjectId(conn)).toBeNull();

    const resp = await routeExecutor(
      'context_store',
      { content: `bound first write ${STAMP}`, type: 'completion' },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    expect(resp.isError).toBeFalsy();

    const row = await db.query(
      `SELECT project_id FROM contexts WHERE content = $1`,
      [`bound first write ${STAMP}`]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].project_id).toBe(boundId);
    ActiveSessionStore.clear(conn);
  });

  test('the binding survives an auto-selected current project (rung 2 beats rung 3)', async () => {
    const conn = `bind-beats-current-${STAMP}`;
    // Put the connection's INTERACTIVE current project on the WRONG project, the way a
    // fresh orb's auto-selection did.
    await routeExecutor('project_switch', { project: OTHER_PROJECT }, { connectionId: conn });
    expect(await projectHandler.getCurrentProjectId(conn)).toBe(otherId);

    const content = `bound over current ${STAMP}`;
    await routeExecutor(
      'context_store',
      { content, type: 'completion' },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    const row = await db.query(`SELECT project_id FROM contexts WHERE content = $1`, [content]);
    expect(row.rows[0].project_id).toBe(boundId);
    ActiveSessionStore.clear(conn);
  });

  test('the ENV binding works through the same seam (no header at all)', async () => {
    process.env[PROJECT_BINDING_ENV_VAR] = BOUND_PROJECT;
    const conn = `bind-env-${STAMP}`;
    const content = `bound via env ${STAMP}`;
    await routeExecutor('context_store', { content, type: 'completion' }, { connectionId: conn });
    const row = await db.query(`SELECT project_id FROM contexts WHERE content = $1`, [content]);
    expect(row.rows[0].project_id).toBe(boundId);
    ActiveSessionStore.clear(conn);
  });
});

describe('ACCEPTANCE 2 — a mismatched explicit project FAILS CLEARLY, naming both', () => {
  /**
   * DENY-BY-DEFAULT over the product's own write set. No hand-listed tools: iterate
   * ACTION_TOOLS itself, so a write tool added tomorrow is guarded today.
   */
  for (const tool of [...ACTION_TOOLS]) {
    test(`${tool}: bound + explicitly targeting another project ⇒ typed error, ZERO rows written`, async () => {
      const conn = `mismatch-${tool}-${STAMP}`;
      const scopeParam = projectScopeParam(tool);
      expect(scopeParam).toBeTruthy();

      // Observe the table THIS tool actually writes. The first draft counted `contexts` for
      // every action tool, so the task_create / decision_record cases asserted against a
      // table those tools never touch — the assertion could not have failed (the product was
      // independently verified correct, but the guard was not observing its own claim).
      const table = WRITE_TABLE_FOR[tool];
      const before = await db.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE project_id = $1`,
        [otherId]
      );

      const resp = await routeExecutor(
        tool,
        { ...minimalArgsFor(tool), [scopeParam!]: otherId },
        { connectionId: conn, projectBinding: BOUND_PROJECT }
      );

      expect(resp.isError).toBe(true);
      const text = textOf(resp);
      expect(text).toContain(PROJECT_BINDING_ERROR_CODES.MISMATCH);
      // NAMES BOTH — by name and by id, on both sides.
      expect(text).toContain(BOUND_PROJECT);
      expect(text).toContain(boundId);
      expect(text).toContain(OTHER_PROJECT);
      expect(text).toContain(otherId);

      // And nothing leaked into the other project — in THIS tool's own table.
      const after = await db.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE project_id = $1`,
        [otherId]
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
      ActiveSessionStore.clear(conn);
    });
  }

  test('a bound client cannot silently project_switch away (never "silently lost")', async () => {
    const conn = `mismatch-switch-${STAMP}`;
    const resp = await routeExecutor(
      'project_switch',
      { project: OTHER_PROJECT },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    expect(resp.isError).toBe(true);
    expect(textOf(resp)).toContain(PROJECT_BINDING_ERROR_CODES.MISMATCH);
    ActiveSessionStore.clear(conn);
  });

  test('an UNRESOLVABLE binding fails loudly rather than auto-selecting a project', async () => {
    const conn = `unresolvable-${STAMP}`;
    const resp = await routeExecutor(
      'context_store',
      { content: `never written ${STAMP}`, type: 'completion' },
      { connectionId: conn, projectBinding: `ghost-project-${STAMP}` }
    );
    expect(resp.isError).toBe(true);
    expect(textOf(resp)).toContain(PROJECT_BINDING_ERROR_CODES.BINDING_UNRESOLVED);
    const row = await db.query(`SELECT count(*)::int AS n FROM contexts WHERE content = $1`, [
      `never written ${STAMP}`,
    ]);
    expect(row.rows[0].n).toBe(0);
    ActiveSessionStore.clear(conn);
  });
});

describe('ACCEPTANCE 3 — the write audit records the project id', () => {
  test('a bound write emits one project-resolution audit carrying the project id and the rung', async () => {
    const seen: Array<{ msg: string; meta: any }> = [];
    vi.spyOn(logger, 'info').mockImplementation(((msg: string, meta?: any) => {
      seen.push({ msg, meta });
    }) as any);

    const conn = `audit-bound-${STAMP}`;
    await routeExecutor(
      'context_store',
      { content: `audited bound ${STAMP}`, type: 'completion' },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );

    const audits = seen.filter((e) => e.msg.startsWith(PROJECT_AUDIT_PREFIX));
    expect(audits).toHaveLength(1);
    expect(audits[0].msg).toContain(`projectId=${boundId}`);
    expect(audits[0].msg).toContain('source=binding');
    expect(audits[0].meta.metadata.projectId).toBe(boundId);
    expect(audits[0].meta.metadata.tool).toBe('context_store');
    expect(audits[0].meta.metadata.bindingOrigin).toBe('header');
    ActiveSessionStore.clear(conn);
  });

  test('an UNBOUND write is audited too — the project id is recorded from the interactive rung', async () => {
    const conn = `audit-unbound-${STAMP}`;
    await routeExecutor('project_switch', { project: OTHER_PROJECT }, { connectionId: conn });

    const seen: Array<{ msg: string; meta: any }> = [];
    vi.spyOn(logger, 'info').mockImplementation(((msg: string, meta?: any) => {
      seen.push({ msg, meta });
    }) as any);

    await routeExecutor(
      'context_store',
      { content: `audited unbound ${STAMP}`, type: 'completion' },
      { connectionId: conn }
    );

    const audits = seen.filter((e) => e.msg.startsWith(PROJECT_AUDIT_PREFIX));
    expect(audits).toHaveLength(1);
    expect(audits[0].meta.metadata.projectId).toBe(otherId);
    expect(audits[0].meta.metadata.source).toBe('interactive');
    expect(audits[0].meta.metadata.bound).toBe(false);
    ActiveSessionStore.clear(conn);
  });

  test('a PASSIVE (non-write) call emits no write audit', async () => {
    const seen: string[] = [];
    vi.spyOn(logger, 'info').mockImplementation(((msg: string) => {
      seen.push(msg);
    }) as any);
    await routeExecutor('project_current', {}, { connectionId: `audit-passive-${STAMP}` });
    expect(seen.filter((m) => m.startsWith(PROJECT_AUDIT_PREFIX))).toHaveLength(0);
  });
});

describe('LEGACY == TODAY — the unbound (human) path is untouched', () => {
  test('project_switch then context_store lands in the switched project, exactly as before', async () => {
    const conn = `legacy-human-${STAMP}`;
    const sw = await routeExecutor(
      'project_switch',
      { project: OTHER_PROJECT },
      { connectionId: conn }
    );
    expect(sw.isError).toBeFalsy();
    expect(textOf(sw)).toContain(OTHER_PROJECT);

    const content = `legacy human write ${STAMP}`;
    await routeExecutor('context_store', { content, type: 'completion' }, { connectionId: conn });
    const row = await db.query(`SELECT project_id FROM contexts WHERE content = $1`, [content]);
    expect(row.rows[0].project_id).toBe(otherId);

    // …and a subsequent switch BACK still works (no sticky binding was introduced).
    const back = await routeExecutor(
      'project_switch',
      { project: BOUND_PROJECT },
      { connectionId: conn }
    );
    expect(back.isError).toBeFalsy();
    expect(await projectHandler.getCurrentProjectId(conn)).toBe(boundId);
    ActiveSessionStore.clear(conn);
  });

  test('an unbound client may still explicitly write to any project it names', async () => {
    const conn = `legacy-explicit-${STAMP}`;
    const content = `legacy explicit write ${STAMP}`;
    const resp = await routeExecutor(
      'context_store',
      { content, type: 'completion', projectId: otherId },
      { connectionId: conn }
    );
    expect(resp.isError).toBeFalsy();
    const row = await db.query(`SELECT project_id FROM contexts WHERE content = $1`, [content]);
    expect(row.rows[0].project_id).toBe(otherId);
    ActiveSessionStore.clear(conn);
  });
});

/**
 * The number of tools the binding gate materialises into — i.e. `projectScopeParam(tool)` is
 * defined — MEASURED on this tree (43 as of 2026-07-26; it had drifted to 43
 * while the comment below still said 42). Adding a project-scoped tool is expected to move
 * this: bump it in the same commit, deliberately.
 */
// 43 → 46 (PHASE 1 positional membership): branch_open / branch_current /
// branch_close each declare a projectId scope param, so the gate materialises into them.
// 46 → 47 (WS2 living summary): project_briefing declares a `project` scope
// param (id-or-name, same shape as project_info), so the gate materialises into it — and it
// passes the differential UUID/name sweep like its siblings.
// 47 → 48 (SK2): branch_history declares a projectId scope param — it
// scopes BOTH the spine's short-id resolution and every hop of the member walk, so the
// gate materialises into it and it must accept the canonical UUID like its siblings.
// 48 → 50 (P3): branch_assign / branch_unassign each declare a projectId
// scope param — it scopes BOTH ids' short-id resolution AND the `AND project_id = $n` on the
// membership UPDATE/DELETE, so the gate materialises into them and they must accept the
// canonical UUID like their siblings. Declaring it is not cosmetic: without the param they
// would join the four ops an unidentified caller can never legally call (callerIdentityGuard).
// 50 -> 51: project_tags takes a `projectId`, so the binding gate
// materialises into it and it joins the gate's blast radius. Its project argument
// resolves by id OR name, which is what the discrimination test below requires.
// 51 -> 53: the decision inbox adds
// decision_answer / decision_discuss, each declaring a `projectId` scope param (it scopes
// the short-id resolution of `decisionId`) — both join the gate's blast radius.
// 53 -> 48: the five code-scan ops leave the registry.
const SWEPT_SCOPE_TOOL_COUNT = 48;

describe('MATERIALISATION COMPATIBILITY — every tool the gate injects into accepts a canonical UUID', () => {
  /**
   * BLOCKER 2 (Reviewer). The gate's premise is "every route already honours an explicit
   * project argument". True — but it has an UNSTATED second half: "…and every project-scope
   * argument accepts a canonical UUID." That half was written down nowhere, enforced by
   * nothing, and was FALSE for `session_start`, whose `resolveProject` matched `p.name` only.
   * A bound client's `session_start` therefore failed on a UUID it structurally could not match.
   *
   * The write-property sweep above iterates ACTION_TOOLS, which is the right choke point for
   * "what may be written" — but the WRONG set for this property. The gate's blast radius is
   * every tool where `projectScopeParam(tool)` is defined, so THAT is the set this guard
   * iterates. Derived from the product's own schemas: a tool that becomes project-scoped
   * tomorrow is swept the day it is born, with nothing for anyone to remember.
   *
   * THE COUNT IS PINNED, NOT NARRATED. This comment used to say "(42 today)"
   * while the live number was 43, and the only assertion was `> ACTION_TOOLS.size` — so the
   * number was PROSE that nothing enforced, and the set could have collapsed from 43 to 4
   * without a single test noticing. It is now asserted literally, below, against
   * SWEPT_SCOPE_TOOL_COUNT.
   *
   * HOW IT DECIDES, without modelling error text (don't assert *about* an
   * interpreter). It is DIFFERENTIAL and DIRECTIONAL, using the project NAME as the control:
   *
   *     if the BOUND call (gate materialises the UUID) fails
   *     but the same call with the project NAME succeeds
   *     ⇒ the tool discriminates against the canonical id ⇒ RED, naming the tool.
   *
   * A tool that fails BOTH ways fails for its own unrelated reason (a missing required arg)
   * and is not this guard's business. A tool that accepts the UUID and rejects the NAME (e.g.
   * task_list, whose projectId is a real uuid column) is fine — the gate only ever injects a
   * UUID. So the guard fires on exactly the direction that breaks materialisation, and the
   * `session_start` regression is the case it was built from.
   */

  /** Args that let a tool reach its project-resolution path. Absent ⇒ scope param only. */
  const SWEEP_ARGS: Record<string, Record<string, unknown>> = {
    context_store: { content: 'sweep', type: 'completion' },
    context_update: { contextId: '00000000-0000-0000-0000-000000000000', content: 'x' },
    context_delete: { contextId: '00000000-0000-0000-0000-000000000000' },
    context_restore: { contextId: '00000000-0000-0000-0000-000000000000' },
    context_search: { query: 'sweep' },
    context_artifact: { uri: 'https://example.com/a', kind: 'url' },
    task_create: { title: 'sweep' },
    task_update: { taskId: '00000000-0000-0000-0000-000000000000', status: 'todo' },
    task_details: { taskId: '00000000-0000-0000-0000-000000000000' },
    task_delete: { taskId: '00000000-0000-0000-0000-000000000000' },
    task_restore: { taskId: '00000000-0000-0000-0000-000000000000' },
    cancel_task: { taskId: '00000000-0000-0000-0000-000000000000' },
    task_claim: { taskId: '00000000-0000-0000-0000-000000000000' },
    task_renew: { taskId: '00000000-0000-0000-0000-000000000000' },
    task_release: { taskId: '00000000-0000-0000-0000-000000000000' },
    task_bulk_update: { taskIds: ['00000000-0000-0000-0000-000000000000'], status: 'todo' },
    decision_record: {
      title: 'sweep', description: 'd', rationale: 'r',
      decisionType: 'process', impactLevel: 'low',
    },
    decision_get: { decisionId: '00000000-0000-0000-0000-000000000000' },
    decision_update: { decisionId: '00000000-0000-0000-0000-000000000000', status: 'active' },
    decision_delete: { decisionId: '00000000-0000-0000-0000-000000000000' },
    decision_restore: { decisionId: '00000000-0000-0000-0000-000000000000' },
    decision_search: { query: 'sweep' },
    smart_search: { query: 'sweep' },
    link: { from: 'ctx:0', to: 'ctx:1', type: 'related_to' },
    unlink: { from: 'ctx:0', to: 'ctx:1', type: 'related_to' },
    get_links: { id: '00000000-0000-0000-0000-000000000000' },
    recall_thread: { id: '00000000-0000-0000-0000-000000000000' },
    thread_set: { task: '00000000-0000-0000-0000-000000000000' },
  };

  /** Every tool the binding gate materialises into — from the product's own schemas. */
  function sweptTools(): Array<{ tool: string; scopeParam: string }> {
    const out: Array<{ tool: string; scopeParam: string }> = [];
    for (const tool of Object.keys(validationSchemas)) {
      let p: string | undefined;
      try { p = projectScopeParam(tool); } catch { p = undefined; }
      if (p) out.push({ tool, scopeParam: p });
    }
    return out;
  }

  test('the swept set is the gate’s real blast radius, not a hand-picked few', () => {
    const swept = sweptTools();
    // Strictly more than the ACTION_TOOLS write set the sibling sweep covers — that gap IS
    // the hole Blocker 2 named. If this ever collapses toward ACTION_TOOLS, the guard has
    // quietly stopped covering the gate.
    expect(swept.length).toBeGreaterThan(ACTION_TOOLS.size);
    expect(swept.map((s) => s.tool)).toContain('session_start');

    // THE PIN. `> ACTION_TOOLS.size` is satisfied by any number above 3, so it could not
    // detect the sweep silently shrinking — and a bound relation like `swept.length ===
    // countScopedTools()` would widen in LOCKSTEP with the thing it pins (a past incident #7).
    // A literal makes a change to the gate's blast radius a two-file diff: a decision.
    expect(swept.length).toBe(SWEPT_SCOPE_TOOL_COUNT);
  });

  test('no tool rejects the canonical UUID the gate materialises while accepting its NAME', async () => {
    const discriminates: string[] = [];
    const exercised: string[] = [];

    for (const { tool, scopeParam } of sweptTools()) {
      const base = SWEEP_ARGS[tool] ?? {};
      const conn = `sweep-${tool}-${STAMP}`;

      // BOUND: no explicit project — the gate injects the canonical UUID.
      const boundResp = await routeExecutor(tool, { ...base }, {
        connectionId: conn,
        projectBinding: BOUND_PROJECT,
      });
      ActiveSessionStore.clear(conn);

      if (!boundResp.isError) {
        exercised.push(tool);
        continue;
      }

      // CONTROL: same call, unbound, naming the project by NAME.
      const nameConn = `sweep-name-${tool}-${STAMP}`;
      const nameResp = await routeExecutor(
        tool,
        { ...base, [scopeParam]: BOUND_PROJECT },
        { connectionId: nameConn }
      );
      ActiveSessionStore.clear(nameConn);

      if (!nameResp.isError) {
        // The NAME works and the materialised UUID does not ⇒ this tool cannot be bound.
        discriminates.push(`${tool} (${scopeParam}): UUID rejected — "${textOf(boundResp).slice(0, 160)}"`);
      } else {
        exercised.push(tool);
      }
    }

    expect(discriminates).toEqual([]);
    // Coverage is REPORTED, not assumed: every swept tool must have been decided one way or
    // the other, so a tool silently skipped can't masquerade as a pass.
    expect(exercised.length).toBe(sweptTools().length);
  }, 120_000);
});

describe('SCOPE OVERRIDE — an all-projects flag NARROWS to the binding, and is audited', () => {
  /**
   * Reviewer item 3 + the coordinator's addendum. `session_list` declares
   * BOTH `project` and `allProjects`. `allProjects` contains the `project` token, so without
   * a dedicated class it would be read as a SECOND scope selection and `projectScopeParam`
   * would throw ambiguity — a BOUND client's `session_list` would fail outright.
   *
   * The `override` class fixes that STRUCTURALLY, from the param's own name, with no entry in
   * the central exemption map: `project` stays the sole scope param, so the binding
   * materialises into `args.project` and the handler's `if (args.project)` branch wins — the
   * coordinator's chosen precedence (a bound client's binding beats "show me everything").
   *
   * The narrowing is NOT silent: it is stamped on the write audit. The class we keep killing
   * is the silent override, not the override itself.
   *
   * The schema injected here is the EXACT shape the session-identity change declares, so this is measured
   * against the real thing rather than a convenient stand-in — but note it is still an
   * INJECTION, not the merged ref. The merged-ref verification is the coordinator's gate.
   */
  const SESSION_LIST = 'session_list';
  const preexisting = (validationSchemas as any)[SESSION_LIST];

  beforeAll(() => {
    (validationSchemas as any)[SESSION_LIST] = z.object({
      project: z.string().optional(),
      allProjects: z.boolean().optional(),
      actor: z.string().optional(),
      limit: z.number().optional(),
    });
  });
  afterAll(() => {
    if (preexisting === undefined) delete (validationSchemas as any)[SESSION_LIST];
    else (validationSchemas as any)[SESSION_LIST] = preexisting;
  });

  test('`project` is the SOLE scope param — no ambiguity error for a bound client', () => {
    expect(classifyProjectParam(SESSION_LIST, 'project')).toBe('scoped');
    expect(classifyProjectParam(SESSION_LIST, 'allProjects')).toBe('override');
    expect(projectScopeParam(SESSION_LIST)).toBe('project');
  });

  test('BOUND + allProjects:true ⇒ binding WINS (materialises into project) and is recorded', async () => {
    const r = await resolveProjectBinding(SESSION_LIST, { allProjects: true }, BOUND_PROJECT);
    expect(r.bound).toBe(true);
    expect(r.scopeParam).toBe('project');
    expect(r.projectId).toBe(boundId);
    // The narrowing is auditable, not silent.
    expect(r.overriddenScopeParams).toEqual(['allProjects']);
  });

  test('BOUND + allProjects:false ⇒ nothing was narrowed', async () => {
    const r = await resolveProjectBinding(SESSION_LIST, { allProjects: false }, BOUND_PROJECT);
    expect(r.projectId).toBe(boundId);
    expect(r.overriddenScopeParams).toEqual([]);
  });

  test('UNBOUND + allProjects:true ⇒ completely untouched', async () => {
    const r = await resolveProjectBinding(SESSION_LIST, { allProjects: true }, undefined);
    expect(r.bound).toBe(false);
    expect(r.projectId).toBeUndefined();
  });

  /**
   * NEGATIVE CONTROL — and it is ONLY that. Retitled 2026-09-03 because the
   * old title, "the audit line carries the narrowed flag so an operator can see it", claimed
   * the POSITIVE property while asserting the negative one: `context_store` declares no
   * override param, so `narrowedScopeOverrides` on this call can only ever be `[]`, and no
   * input to this subject makes it otherwise.
   *
   * MEASURED, so the distinction is not theoretical (three mutations of the stamp in
   * auditProjectResolution, run against this file):
   *   · stamp DELETED outright        → this test goes RED   (absence IS caught)
   *   · stamp hardcoded to `[]`       → this test stayed GREEN, 20/20
   *   · unmutated control             → GREEN
   * So the guard covered ABSENT and was blind to PRESENT-BUT-HOLLOW — two different
   * directions (a past incident #6). An operator would have been told "nothing was narrowed" on
   * every call forever, and nothing would have gone red. The live assertion below is the
   * other direction; the two are kept adjacent on purpose so neither can be read as the whole.
   */
  test('an UN-narrowed write stamps an EMPTY list — present, never absent', async () => {
    const seen: Array<{ msg: string; meta: any }> = [];
    vi.spyOn(logger, 'info').mockImplementation(((msg: string, meta?: any) => {
      seen.push({ msg, meta });
    }) as any);
    const conn = `narrow-audit-${STAMP}`;
    await routeExecutor(
      'context_store',
      { content: `narrow audit ${STAMP}`, type: 'completion' },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    const audits = seen.filter((e) => e.msg.startsWith(PROJECT_AUDIT_PREFIX));
    expect(audits).toHaveLength(1);
    // Present and empty rather than absent, so "nothing was narrowed" can never be mistaken
    // for "narrowing was not checked".
    expect(audits[0].meta.metadata.narrowedScopeOverrides).toEqual([]);
    expect(audits[0].msg).not.toContain('narrowed=');
    ActiveSessionStore.clear(conn);
  });

  /**
   * THE LIVE ASSERTION — the stamp is exercised on an input that actually narrows a WRITE.
   *
   * WHY A SCHEMA INJECTION IS NECESSARY AND NOT A CONVENIENCE. The write audit is emitted
   * only for `ACTION_TOOLS` members, and every param the override classifier matches today
   * belongs to a READ tool — so no argument to any shipped tool can make this field
   * non-empty. The subject had to be constructed. This is the same technique the sibling
   * describe above uses for `session_list`, and the same one
   * `tests/projectScopeNarrowingNotice.contract.test.ts` uses for its derived-population
   * test, so it is the file's established way of testing a property that is reachable but
   * not yet instantiated.
   *
   * REACHABILITY IS MEASURED, NOT ASSUMED. The alternative disposition considered for this
   * guard was "the property is unreachable by construction, so the stamp is dead code —
   * delete both". That premise is FALSE: with an override param injected onto a write tool,
   * the stamp fires and is CORRECT (`narrowed=allProjects`, field `['allProjects']`). It is
   * live, working code that had simply never been reached by a test. Deleting correct
   * product code because no shipped tool instantiates it yet would remove the protection
   * that makes a future write tool's narrowing visible in the line an operator greps for
   * writes — which is precisely the argument for landing such a guard BEFORE the tool that
   * needs it, the reason the override classifier itself was landed early.
   */
  describe('a narrowed WRITE — the stamp on an input that actually exercises it', () => {
    const WRITE_TOOL = 'context_store';
    const preexistingWrite = (validationSchemas as any)[WRITE_TOOL];

    beforeAll(() => {
      // The shape a write tool would declare if it ever gained a widening flag. Replaced
      // wholesale rather than extended because the shipped schema is a ZodEffects, and
      // `declaredParamKeys` — the classifier's only input — reads the unwrapped key set.
      (validationSchemas as any)[WRITE_TOOL] = z.object({
        content: z.string(),
        type: z.string().optional(),
        projectId: z.string().optional(),
        allProjects: z.boolean().optional(),
      });
    });
    afterAll(() => {
      if (preexistingWrite === undefined) delete (validationSchemas as any)[WRITE_TOOL];
      else (validationSchemas as any)[WRITE_TOOL] = preexistingWrite;
    });

    test('the audit line CARRIES the narrowed flag, in both the message and the metadata', async () => {
      // Pre-condition, asserted rather than assumed: the injection really did put this write
      // tool in the override classifier's population. Without this, a silently-failed
      // injection would leave the test asserting `[]` again and passing for the wrong reason.
      expect(classifyProjectParam(WRITE_TOOL, 'allProjects')).toBe('override');
      expect(projectScopeParam(WRITE_TOOL)).toBe('projectId');

      const seen: Array<{ msg: string; meta: any }> = [];
      vi.spyOn(logger, 'info').mockImplementation(((msg: string, meta?: any) => {
        seen.push({ msg, meta });
      }) as any);

      const conn = `narrow-audit-write-${STAMP}`;
      const resp = await routeExecutor(
        WRITE_TOOL,
        { content: `narrowed write ${STAMP}`, type: 'completion', allProjects: true },
        { connectionId: conn, projectBinding: BOUND_PROJECT }
      );
      // The write still SUCCEEDS and still lands in the bound project — the binding narrows,
      // it does not refuse. Asserting this keeps the guard honest about what it is guarding:
      // the visibility of the narrowing, not a change to the narrowing itself.
      expect(resp.isError).toBeFalsy();

      const audits = seen.filter((e) => e.msg.startsWith(PROJECT_AUDIT_PREFIX));
      expect(audits).toHaveLength(1);
      expect(audits[0].meta.metadata.narrowedScopeOverrides).toEqual(['allProjects']);
      // The greppable half: an operator reading the log text, not the structured metadata,
      // must see it too. This is the assertion a hardcoded-`[]` stamp cannot satisfy.
      expect(audits[0].msg).toContain('narrowed=allProjects');
      expect(audits[0].meta.metadata.projectId).toBe(boundId);

      ActiveSessionStore.clear(conn);
    });
  });
});
