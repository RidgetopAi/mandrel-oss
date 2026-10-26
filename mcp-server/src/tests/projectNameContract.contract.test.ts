/**
 * THE PROJECT-REFERENCE NAME CONTRACT.
 *
 * THE DEFECT THIS GUARDS (measured, not recalled)
 * ----------------------------------------------
 * `config/opRegistry.ts` documented `projectId` as "Project ID or name" on 31 parameters
 * while a name reached `AND project_id = $n` against a `uuid` column on at least twelve of
 * them (`invalid input syntax for type uuid`). an earlier Task closed the BEHAVIOURAL half at
 * the routeExecutor choke point. Two halves were still open when this file was written:
 *
 *   1. NOTHING TIED THE DOCUMENTATION TO THE BEHAVIOUR, in either direction. The
 *      coverage sweep walks the params the RESOLVER handles (`classifyProjectParam ===
 *      'scoped'`). A parameter can promise "or name" and sit OUTSIDE that population — the
 *      three `exempt` administration params (project_info/project_update/project_delete
 *      `.project`) do exactly that, resolving names only because each handler happens to call
 *      projectHandler.getProject. Nothing made that a requirement, so a fourth exemption added
 *      tomorrow would advertise a capability with no obligation to have it.
 *   2. FIFTEEN project-reference params UNDERSTATED the capability, which costs an agent the
 *      same turn as overstating it — it just fails in the direction of not trying.
 *      `task_bulk_update.projectId` read "Project ID to validate ownership against";
 *      `decision_update.projectId` and `task_update.projectId` documented NOTHING at all.
 *
 * So the guard is an IFF over the whole population, and it is deny-by-default in both
 * directions: a documented promise with no proven resolution is RED, and a resolving param
 * with no documented promise is RED.
 *
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3)
 * -----------------------------------------------
 * `projectRefParams(op)` — every declared parameter of an op that matches
 * PROJECT_PARAM_PATTERN and is not an all-projects `override` flag; i.e. the union of the
 * `scoped` write-scope params and the `exempt` administration-by-handle params. It is derived
 * per-op from that op's OWN zod schema plus `classifyProjectParam`, the same single source the
 * resolver reads, so there is no second list to keep in step and a new op is inside the guard
 * the day it is born.
 *
 * That the population is WHOLE rests on three facts, each asserted below rather than asserted
 * in prose (`the population is closed` describe block):
 *   (a) every op in OP_REGISTRY has a validation schema and vice versa, except the five
 *       deprecated `aidis_*` aliases — NONE of which declares a project-ish parameter, so the
 *       registry and the schema registry yield the SAME project-reference population;
 *   (b) no declared parameter name is a NEAR MISS of the token — nothing matches
 *       /proj|scope|tenant|workspace/ without also matching /project/ — so anchoring on
 *       `project` does not silently exclude a project reference spelled another way
 *       (a pattern narrowed to the shapes we happen to have);
 *   (c) the sweep is non-empty and of the expected order of magnitude — a coverage test that
 *       silently checks zero cases is the allow-list it replaced.
 *
 * MUTATION PROBE (the three assertions; transcript in the task record)
 * -------------------------------------------------------------------
 *   · REGISTER A FAKE OP that claims "Project ID or name" and does NOT resolve — an op whose
 *     project param is `exempt` (so the choke point ignores it) with no exerciser — and this
 *     file goes RED naming it. Removing it returns GREEN. Exercised by
 *     `__c13ba669_fake_*` in the "a NEW op that claims the contract without honouring it"
 *     block, which injects into the REAL registries the product reads.
 *   · DELETE the `PROJECT_REF_CONTRACT_PHRASE` from any one param's description → RED naming
 *     that param.
 *   · DELETE `assertProjectRefsNamed`'s call in resolveProjectBinding → the blank blocks RED.
 *
 * Runs inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { z } from 'zod';
import { embedDim } from './helpers/embedGeometry.js';

// Project-scope resolution is independent of embeddings; a zero vector keeps the real write
// path without a model.
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
import { validateToolArguments, validationSchemas, declaredParamKeys } from '../middleware/validation.js';
import { OP_REGISTRY } from '../config/opRegistry.js';
import { PROJECT_REF_CONTRACT_PHRASE } from '../config/projectParamContract.js';
import {
  PROJECT_PARAM_EXEMPTIONS,
  PROJECT_PARAM_PATTERN,
  PROJECT_BINDING_ERROR_CODES,
  ProjectArgBlankError,
  ProjectArgUnresolvedError,
  classifyProjectParam,
  projectRefParams,
  resolveProjectBinding,
} from '../services/projectBinding.js';

const STAMP = Date.now();
const PROJECT_NAME = `name-contract-${STAMP}`;
const NO_SUCH = `no-such-project-${STAMP}`;

let projectId = '';

const text = (r: any): string => r?.content?.map((c: any) => c.text).join('\n') ?? '';

/** The REAL public path: validate exactly as the MCP surface does, then dispatch. */
async function viaTool(tool: string, rawArgs: Record<string, unknown>, conn: string): Promise<any> {
  const validated = validateToolArguments(tool, rawArgs);
  return routeExecutor(tool, validated, { connectionId: conn } as any);
}

/** Every (op, param) pair in the guarded population, derived — never listed. */
function population(): Array<{ op: string; param: string; cls: string; doc?: string }> {
  const out: Array<{ op: string; param: string; cls: string; doc?: string }> = [];
  for (const op of OP_REGISTRY as any[]) {
    for (const param of projectRefParams(op.opId)) {
      out.push({
        op: op.opId,
        param,
        cls: classifyProjectParam(op.opId, param),
        doc: op.humanDescriptions?.[param],
      });
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE THREE FINDERS.
 *
 * Each real assertion below and each mutation probe call the SAME finder — that is what makes
 * the probe evidence about the guard rather than a second, parallel implementation that could
 * be right while the guard is wrong (a past incident #7: a probe against a copy proves nothing).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Project references whose description does not carry the contract phrase. */
function undocumentedRefs(): string[] {
  return population()
    .filter(({ doc }) => !doc || !doc.includes(PROJECT_REF_CONTRACT_PHRASE))
    .map(({ op, param, doc }) => `${op}.${param} → ${doc === undefined ? '(NO DESCRIPTION)' : JSON.stringify(doc)}`);
}

/** Params that PROMISE the contract but sit outside the population that can honour it. */
function rogueClaims(): string[] {
  const out: string[] = [];
  for (const op of OP_REGISTRY as any[]) {
    const guarded = new Set(projectRefParams(op.opId));
    for (const [param, doc] of Object.entries(op.humanDescriptions ?? {})) {
      if (typeof doc !== 'string') continue;
      if (!doc.includes(PROJECT_REF_CONTRACT_PHRASE)) continue;
      if (!guarded.has(param)) out.push(`${op.opId}.${param}`);
    }
  }
  return out;
}

/**
 * The exempt-param accounting, both directions. Takes its two populations as ARGUMENTS
 * precisely so the mutation probe can hand it a synthetic exemption map: the real
 * PROJECT_PARAM_EXEMPTIONS is Object.freeze'd (correctly — it is a source of truth), so it
 * cannot be injected into the way OP_REGISTRY can.
 */
function unaccountedExemptions(
  exemptions: Readonly<Record<string, string>>,
  exercisers: Readonly<Record<string, unknown>>
): string[] {
  const ex = Object.keys(exemptions);
  const run = Object.keys(exercisers);
  return [
    ...ex.filter((k) => !run.includes(k)).map((k) => `exemption with NO end-to-end exerciser: ${k}`),
    ...run.filter((k) => !ex.includes(k)).map((k) => `exerciser for a param that is not exempt: ${k}`),
  ].sort();
}

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'an earlier change name-contract fixture') RETURNING id`,
      [PROJECT_NAME]
    )
  ).rows[0].id;
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
describe('an earlier change — the population is closed (so the sweeps below mean something)', () => {
  test('OP_REGISTRY and validationSchemas yield the SAME project-reference population', () => {
    const regOps = new Set((OP_REGISTRY as any[]).map((o) => o.opId));
    // Every registry op is validated, and every extra schema is a deprecated alias with no
    // project parameter — otherwise a project reference could exist outside the doc sweep.
    for (const op of regOps) {
      expect(validationSchemas as any, `${op} declares no zod schema`).toHaveProperty(op as string);
    }
    const outside = Object.keys(validationSchemas).filter((t) => !regOps.has(t));
    for (const t of outside) {
      const declared = declaredParamKeys(t);
      const projectish = declared ? [...declared].filter((k) => PROJECT_PARAM_PATTERN.test(k)) : [];
      expect(
        projectish,
        `${t} is outside OP_REGISTRY yet declares project-reference param(s) ${projectish.join(', ')} — ` +
          `it would carry an undocumentable, unguarded project reference`
      ).toEqual([]);
    }
  });

  test('no declared parameter is a NEAR MISS of the project token', () => {
    const near = /proj|scope|tenant|workspace/i;
    const misses: string[] = [];
    for (const tool of Object.keys(validationSchemas)) {
      const declared = declaredParamKeys(tool);
      if (!declared) continue;
      for (const p of declared) {
        if (near.test(p) && !PROJECT_PARAM_PATTERN.test(p)) misses.push(`${tool}.${p}`);
      }
    }
    expect(
      misses,
      `these params look like project references but do not match PROJECT_PARAM_PATTERN, so they ` +
        `are invisible to BOTH the resolver and this guard: ${misses.join(', ')}`
    ).toEqual([]);
  });

  test('the sweep is non-empty and covers the whole surface', () => {
    const pop = population();
    // 47 project-ish params exist today; one (session_list.allProjects) is an override and is
    // deliberately outside the population. A floor, not a pin: adding ops must not turn this red.
    expect(pop.length).toBeGreaterThan(40);
    expect(pop.filter((p) => p.cls === 'exempt').length).toBeGreaterThan(0);
    expect(pop.filter((p) => p.cls === 'scoped').length).toBeGreaterThan(35);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an earlier change — DOC ⇒ every project reference DOCUMENTS that it accepts a name', () => {
  test('every project-reference param carries the canonical contract phrase', () => {
    const undocumented = undocumentedRefs();
    expect(
      undocumented,
      `these project-reference params do not carry "${PROJECT_REF_CONTRACT_PHRASE}" verbatim. ` +
        `They all ACCEPT a name; a description narrower than the behaviour teaches an agent not ` +
        `to try. Fix the description in config/opRegistry.ts:\n  ${undocumented.join('\n  ')}`
    ).toEqual([]);
  });

  test('nothing claims the contract on a param outside the guarded population', () => {
    // The inverse direction. A description promising "Project ID or name" on a parameter the
    // resolver does not recognise as a project reference is the contract lie in its purest
    // form: advertised, unresolvable, and invisible to every sweep anchored on the token.
    const rogue = rogueClaims();
    expect(
      rogue,
      `these params PROMISE "${PROJECT_REF_CONTRACT_PHRASE}" but are not in projectRefParams(), ` +
        `so nothing resolves a name for them: ${rogue.join(', ')}`
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an earlier change — BEHAVIOUR ⇒ a scoped project reference really resolves a NAME', () => {
  test('every scoped param canonicalises the NAME to the project UUID at the choke point', async () => {
    const checked: string[] = [];
    for (const { op, param, cls } of population()) {
      if (cls !== 'scoped') continue;
      const res = await resolveProjectBinding(op, { [param]: PROJECT_NAME });
      expect(res.source, `${op}.${param}`).toBe('explicit');
      expect(res.projectId, `${op}.${param} must resolve the NAME to the canonical UUID`).toBe(
        projectId
      );
      checked.push(`${op}.${param}`);
    }
    expect(checked.length).toBeGreaterThan(35);
  });

  test('an unresolvable NAME is a typed refusal on every scoped param — never a raw DB error', async () => {
    for (const { op, param, cls } of population()) {
      if (cls !== 'scoped') continue;
      const err = await resolveProjectBinding(op, { [param]: NO_SUCH }).then(
        () => null,
        (e) => e
      );
      expect(err, `${op}.${param} accepted a nonexistent project`).toBeInstanceOf(
        ProjectArgUnresolvedError
      );
      expect(err.message).not.toMatch(/invalid input syntax for type uuid/i);
      expect(err.message).toContain(NO_SUCH);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * The `exempt` administration params are the ones the choke point deliberately does NOT
 * normalise (naming a project to inspect/rename/delete it is not choosing a write scope), so
 * their name resolution is HANDLER-LOCAL and can only be proven end-to-end.
 *
 * DENY-BY-DEFAULT: the exerciser map's keys must equal `PROJECT_PARAM_EXEMPTIONS`' keys
 * exactly. A new exemption therefore cannot be added without an end-to-end proof that it
 * resolves a name — the missing entry is a RED, not a skip. That is the hole this whole file
 * exists to close: a promise with no obligation.
 */
/**
 * THE OBSERVABLE for an exempt param is the project UUID the handler ECHOES BACK. Asserting
 * the name appears in the response would only prove the name was quoted; asserting the UUID
 * proves the reference resolved to the RIGHT project — which is the claim being made.
 * `expectId` is the id the response must name when `ref` is a valid handle.
 */
const EXEMPT_EXERCISERS: Record<
  string,
  (ref: string, conn: string) => Promise<{ expectId: string; raw: string; isError: boolean }>
> = {
  'project_info.project': async (ref, conn) => {
    const r = await viaTool('project_info', { project: ref }, conn);
    return { expectId: projectId, raw: text(r), isError: r?.isError === true };
  },
  'project_update.project': async (ref, conn) => {
    const r = await viaTool(
      'project_update',
      { project: ref, description: `exercised by name @${STAMP}` },
      conn
    );
    return { expectId: projectId, raw: text(r), isError: r?.isError === true };
  },
  // project_delete is exercised against a DISPOSABLE project of its own, created inside the
  // exerciser: proving "the handle resolved" must not consume the shared fixture the other
  // cases read. It is also the destructive member of the population, which is exactly why it
  // must be proven rather than assumed to behave like its siblings.
  'project_delete.project': async (ref, conn) => {
    let target = ref;
    let expectId = '';
    if (ref === PROJECT_NAME) {
      target = `${PROJECT_NAME}-deletable`;
      expectId = (
        await db.query(
          `INSERT INTO projects (name, description) VALUES ($1,'disposable') RETURNING id`,
          [target]
        )
      ).rows[0].id;
    }
    const r = await viaTool('project_delete', { project: target, confirm: true }, conn);
    await db.query('DELETE FROM projects WHERE name = $1', [target]).catch(() => {});
    return { expectId, raw: text(r), isError: r?.isError === true };
  },
  // project_move_record.toProject is the DESTINATION of a record move.
  // Exercised against a DISPOSABLE record created in a DISPOSABLE source project,
  // for the same reason project_delete is: proving the handle resolved must not consume or
  // relocate the shared fixture the other cases read. On success the handler names the
  // destination project's UUID, which is the observable this file asserts on.
  'project_move_record.toProject': async (ref, conn) => {
    const srcName = `${PROJECT_NAME}-move-src-${Math.random().toString(36).slice(2, 8)}`;
    const srcId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1,'move source') RETURNING id`,
        [srcName]
      )
    ).rows[0].id;
    const recordId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content)
         VALUES ($1,'code',$2) RETURNING id`,
        [srcId, `move exerciser @${STAMP}`]
      )
    ).rows[0].id;
    const r = await viaTool(
      'project_move_record',
      { recordType: 'context', recordId, toProject: ref },
      conn
    );
    await db.query('DELETE FROM contexts WHERE id = $1', [recordId]).catch(() => {});
    await db.query('DELETE FROM projects WHERE id = $1', [srcId]).catch(() => {});
    return { expectId: projectId, raw: text(r), isError: r?.isError === true };
  },
};

describe('an earlier change — BEHAVIOUR ⇒ the EXEMPT admin params resolve a NAME end-to-end', () => {
  test('every exemption has an end-to-end exerciser (deny-by-default)', () => {
    expect(
      unaccountedExemptions(PROJECT_PARAM_EXEMPTIONS, EXEMPT_EXERCISERS),
      'an exemption is a project reference the choke point does NOT normalise, so its name ' +
        'resolution exists only in its handler and must be proven end-to-end. Add an exerciser ' +
        'to EXEMPT_EXERCISERS in this file.'
    ).toEqual([]);
  });

  test('each exempt param resolves a project NAME through the real tool path', async () => {
    for (const [key, run] of Object.entries(EXEMPT_EXERCISERS)) {
      const out = await run(PROJECT_NAME, `exempt-ok-${key}-${STAMP}`);
      expect(out.isError, `${key} errored on a valid project NAME: ${out.raw.slice(0, 200)}`).toBe(
        false
      );
      expect(
        out.raw,
        `${key} did not resolve the NAME to the right project (expected id ${out.expectId})`
      ).toContain(out.expectId);
      expect(out.raw).not.toMatch(/invalid input syntax for type uuid/i);
      expect(out.raw).not.toMatch(/not found/i);
    }
  });

  test('each exempt param fails HONESTLY on a nonexistent name — no raw DB error', async () => {
    for (const [key, run] of Object.entries(EXEMPT_EXERCISERS)) {
      const out = await run(NO_SUCH, `exempt-bad-${key}-${STAMP}`);
      expect(out.raw, `${key} did not name the unresolvable value back`).toContain(NO_SUCH);
      expect(out.raw, `${key} leaked a Postgres cast error`).not.toMatch(
        /invalid input syntax for type uuid/i
      );
      expect(out.raw, `${key} leaked the datastore boundary's misleading advice`).not.toContain(
        'DATASTORE_ERROR'
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * THE EMPTY / ZERO POPULATION (C3 — the values that slip through). A whitespace-only project
 * reference was NOT blank enough to trip the old `raw.trim() !== ''` check, so it fell through
 * as "no project named" and travelled raw into `AND project_id = $n`. Measured on v0.15.0
 * (9930f00): task_list({projectId:'   '}) → [DATASTORE_ERROR] with the advice "This is a
 * server-side fault, not a problem with the arguments you sent" — false, and unretryable.
 */
describe('an earlier change — a BLANK project reference is refused loudly, everywhere', () => {
  test.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['tab + newline', '\t\n'],
  ])('%s is a typed PROJECT_ARG_BLANK on EVERY project-reference param', async (_label, blank) => {
    for (const { op, param } of population()) {
      const err = await resolveProjectBinding(op, { [param]: blank }).then(
        () => null,
        (e) => e
      );
      expect(err, `${op}.${param} accepted a blank project reference`).toBeInstanceOf(
        ProjectArgBlankError
      );
      expect(err.code).toBe(PROJECT_BINDING_ERROR_CODES.ARG_BLANK);
    }
  });

  test('an ABSENT reference is still absent — the blank rule did not become a fourth rung', async () => {
    for (const [args, label] of [
      [{ content: 'x' }, 'omitted'],
      [{ content: 'x', projectId: undefined }, 'explicit undefined'],
      [{ content: 'x', projectId: null }, 'explicit null'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await resolveProjectBinding('context_store', args);
      expect(res.source, `context_store with ${label} must fall to rung 3`).toBe('interactive');
      expect(res.projectId, `context_store with ${label}`).toBeUndefined();
    }
  });

  test('END-TO-END: the whitespace case returns the typed refusal, not [DATASTORE_ERROR]', async () => {
    const conn = `blank-e2e-${STAMP}`;
    for (const tool of ['task_list', 'context_stats', 'project_info'] as const) {
      const param = tool === 'project_info' ? 'project' : 'projectId';
      const r = await viaTool(tool, { [param]: '   ' }, conn).catch((e: any) => ({
        isError: true,
        content: [{ type: 'text', text: `${e?.name}: ${e?.message}` }],
      }));
      const body = text(r);
      expect(body, `${tool} still leaks the datastore boundary`).not.toContain('DATASTORE_ERROR');
      expect(body, `${tool} still leaks a Postgres cast error`).not.toMatch(
        /invalid input syntax for type uuid/i
      );
      expect(body, `${tool} did not return the typed blank refusal`).toContain(
        PROJECT_BINDING_ERROR_CODES.ARG_BLANK
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * THE MUTATION PROBE, LANDED AS A PERMANENT CASE. Rather than describing the probe in a
 * comment and asking the next reader to trust it, the fake op is INJECTED into the real
 * registries the product reads and the guard's own logic is run against it here. If someone
 * later narrows the doc sweep to a hand-kept list, or drops the exempt-exerciser accounting,
 * THIS block stops failing — and a permanently-passing probe is itself the signal.
 */
describe('an earlier change — a NEW op that claims the contract without honouring it is CAUGHT', () => {
  const STEM = `__c13ba669_probe_${STAMP}`;

  /** Inject a fake op into the REAL registries the product reads, run body, always clean up. */
  function withFakeOp(
    opId: string,
    schemaShape: Record<string, z.ZodTypeAny>,
    humanDescriptions: Record<string, string>,
    body: () => void
  ): void {
    (validationSchemas as any)[opId] = z.object(schemaShape);
    (OP_REGISTRY as any[]).push({
      opId,
      effect: 'read',
      kind: 'flat',
      category: 'System Health',
      description: 'fake op injected by the mutation probe',
      humanDescriptions,
    });
    try {
      body();
    } finally {
      delete (validationSchemas as any)[opId];
      const i = (OP_REGISTRY as any[]).findIndex((o) => o.opId === opId);
      if (i >= 0) (OP_REGISTRY as any[]).splice(i, 1);
    }
  }

  /**
   * PROBE 1 — the DOC half. A new op declares a project reference and does not document the
   * contract (here: no description at all, the state `decision_update`/`task_update` were
   * actually in). All three assertions in one test so they cannot drift apart.
   */
  test('an undocumented project reference on a NEW op: landed · RED · control GREEN', () => {
    const controlBefore = undocumentedRefs();
    expect(controlBefore, 'CONTROL (pre-mutation) must be GREEN').toEqual([]);

    withFakeOp(`${STEM}_undocumented`, { projectId: z.string().optional() }, {}, () => {
      // (1) THE MUTATION LANDED — the fake op is really inside the derived population.
      expect(projectRefParams(`${STEM}_undocumented`)).toEqual(['projectId']);
      expect(population().some((p) => p.op === `${STEM}_undocumented`)).toBe(true);
      // (2) THE GUARD WENT RED — and names the offender.
      const red = undocumentedRefs();
      expect(red.length).toBe(1);
      expect(red[0]).toContain(`${STEM}_undocumented.projectId`);
      expect(red[0]).toContain('(NO DESCRIPTION)');
    });

    // (3) THE UNMUTATED CONTROL IS GREEN — removing the mutation restores GREEN, so the RED
    //     above was caused by the mutation and nothing else.
    expect(undocumentedRefs(), 'CONTROL (post-mutation) must be GREEN again').toEqual([]);
  });

  /**
   * PROBE 2 — the INVERSE direction: a new op that PROMISES "Project ID or name" on a param
   * nothing recognises as a project reference. This is the contract lie in its purest form —
   * advertised, unresolvable, and invisible to any sweep anchored on the token.
   */
  test('a claim on an UNRECOGNISED param: landed · RED · control GREEN', () => {
    expect(rogueClaims(), 'CONTROL (pre-mutation) must be GREEN').toEqual([]);

    withFakeOp(
      `${STEM}_rogue`,
      { owner: z.string().optional() },
      { owner: `${PROJECT_REF_CONTRACT_PHRASE} of the owner` },
      () => {
        // (1) LANDED: the param exists, carries the phrase, and is NOT project-ish.
        expect(declaredParamKeys(`${STEM}_rogue`)).toContain('owner');
        expect(PROJECT_PARAM_PATTERN.test('owner')).toBe(false);
        expect(projectRefParams(`${STEM}_rogue`)).toEqual([]);
        // (2) RED.
        expect(rogueClaims()).toEqual([`${STEM}_rogue.owner`]);
      }
    );

    // (3) CONTROL GREEN again.
    expect(rogueClaims()).toEqual([]);
  });

  /**
   * PROBE 3 — the EXEMPT-accounting half: a new exemption added with no end-to-end proof.
   * PROJECT_PARAM_EXEMPTIONS is Object.freeze'd, so the mutation is applied to a COPY and fed
   * to the SAME finder the real assertion uses — the discrimination being proven is the
   * finder's, which is the thing the real assertion depends on.
   */
  test('an exemption with no exerciser: landed · RED · control GREEN', () => {
    expect(
      unaccountedExemptions(PROJECT_PARAM_EXEMPTIONS, EXEMPT_EXERCISERS),
      'CONTROL must be GREEN'
    ).toEqual([]);

    const key = `${STEM}_exempt.project`;
    const mutated = { ...PROJECT_PARAM_EXEMPTIONS, [key]: 'injected by the mutation probe' };
    // (1) LANDED.
    expect(Object.keys(mutated)).toContain(key);
    expect(Object.keys(mutated).length).toBe(Object.keys(PROJECT_PARAM_EXEMPTIONS).length + 1);
    // (2) RED, naming the unproven exemption.
    expect(unaccountedExemptions(mutated, EXEMPT_EXERCISERS)).toEqual([
      `exemption with NO end-to-end exerciser: ${key}`,
    ]);
    // (3) CONTROL still GREEN — the frozen source was not disturbed.
    expect(unaccountedExemptions(PROJECT_PARAM_EXEMPTIONS, EXEMPT_EXERCISERS)).toEqual([]);
  });
});
