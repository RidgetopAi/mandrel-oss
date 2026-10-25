/**
 * PROJECT BINDING — the precedence ladder + the fail-closed param accounting.
 * an earlier task (Amp-orb eval finding W5, client half; report lines 497-520).
 *
 * WHAT THIS GUARDS
 * ----------------
 * The failure is a SILENT wrong-project write: every fresh orb auto-selected `daily log`
 * even while running in `amp-exp-1`. So the property under test is not "the binding works"
 * — it is "a project that cannot be resolved UNAMBIGUOUSLY makes the call FAIL LOUDLY
 * rather than picking one."
 *
 * EVERY case below CALLS THE PRODUCT (`resolveProjectBinding` / `projectScopeParam` /
 * `classifyProjectParam` from services/projectBinding.ts) against REAL Postgres projects.
 * Nothing here re-states the ladder — a test carrying its own copy of the rule is a test
 * detached from the product (a past incident #3), and this file must go RED when the resolver
 * is weakened, which is exactly what the mutation probes in the task report measured.
 *
 * Run inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { z } from 'zod';
import { db } from '../config/database.js';
import {
  resolveProjectBinding,
  projectScopeParam,
  classifyProjectParam,
  PROJECT_PARAM_EXEMPTIONS,
  PROJECT_PARAM_PATTERN,
  ProjectBindingMismatchError,
  ProjectBindingUnresolvedError,
  ProjectBindingTargetUnresolvedError,
  ProjectArgUnresolvedError,
  ProjectBindingAmbiguousParamError,
  PROJECT_BINDING_ERROR_CODES,
} from '../services/projectBinding.js';
import { PROJECT_BINDING_ENV_VAR } from '../config/projectBindingConfig.js';
import { validationSchemas } from '../middleware/validation.js';

const STAMP = Date.now();
/** The project the autonomous client is BOUND to — the eval's `amp-exp-1`. */
const BOUND_PROJECT = `amp-exp-1-${STAMP}`;
/** The project a fresh orb wrongly auto-selected — the eval's `daily log`. */
const OTHER_PROJECT = `daily-log-${STAMP}`;

let boundId: string;
let otherId: string;

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
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[boundId, otherId]]);
});

// The env-leak guard (vitest.setup.ts) requires every file to leave process.env as it found
// it. MANDREL_PROJECT_ID is set per-test below and always removed here.
afterEach(() => {
  delete process.env[PROJECT_BINDING_ENV_VAR];
});

/**
 * SCOPE NOTE (amended by an earlier task). This block originally asserted that the ENTIRE
 * unbound path was byte-identical to pre-binding, INCLUDING rung 1 — i.e. that an unbound
 * client could name a nonexistent project and have the raw string passed through unvalidated.
 *
 * That property was measured to be a BUG, not a feature: the un-normalized identifier reached
 * `AND project_id = $n` against a uuid column, so a project NAME severed tag/link edge minting
 * (silently, blaming the referent) and hard-failed EVERY tool lacking its own name-aware
 * resolution with a raw Postgres cast error — at least twelve of them, measured on f9de00d;
 * see projectArgNormalizer.contract.test.ts for the enumeration and why it is a floor rather
 * than a definition. an earlier Task therefore NORMALIZES rung 1 for everyone and refuses an unresolvable
 * one. The guarantee that survives — and that this block now states exactly — is about rung 3:
 * a call with NO explicit project argument is still untouched, down to the DB round-trip.
 * See projectArgNormalizer.contract.test.ts for the rung-1 contract and its evidence.
 */
describe('rung 3 — UNBOUND with no explicit argument is byte-identical to today', () => {
  test('no header + no env ⇒ not bound, no project imposed, nothing validated', async () => {
    const r = await resolveProjectBinding('context_store', {}, undefined);
    expect(r.bound).toBe(false);
    expect(r.source).toBe('interactive');
    expect(r.projectId).toBeUndefined();
  });

  test('an unbound client naming a NONEXISTENT project is refused, not passed through', async () => {
    const err = await resolveProjectBinding('context_store', { projectId: 'no-such-project' }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ProjectArgUnresolvedError);
    expect(err.code).toBe(PROJECT_BINDING_ERROR_CODES.ARG_UNRESOLVED);
    expect(err.message).toContain('no-such-project');
  });

  test('an unbound client naming a REAL project by name gets the canonical UUID', async () => {
    const r = await resolveProjectBinding('context_store', { projectId: OTHER_PROJECT });
    expect(r.bound).toBe(false);
    expect(r.source).toBe('explicit');
    expect(r.projectId).toBe(otherId);
  });
});

describe('rung 2 — a BOUND client starts in its project and never auto-selects', () => {
  test('binding by NAME, no explicit arg ⇒ pinned to the bound project (rung 3 not consulted)', async () => {
    const r = await resolveProjectBinding('context_store', {}, BOUND_PROJECT);
    expect(r.bound).toBe(true);
    expect(r.source).toBe('binding');
    expect(r.projectId).toBe(boundId);
    expect(r.projectName).toBe(BOUND_PROJECT);
    expect(r.scopeParam).toBe('projectId');
  });

  test('binding by UUID resolves to the same project as binding by name', async () => {
    const byId = await resolveProjectBinding('context_store', {}, boundId);
    expect(byId.projectId).toBe(boundId);
  });

  test('the ENV surface binds too (MANDREL_PROJECT_ID, no header)', async () => {
    process.env[PROJECT_BINDING_ENV_VAR] = BOUND_PROJECT;
    const r = await resolveProjectBinding('context_store', {}, undefined);
    expect(r.bound).toBe(true);
    expect(r.projectId).toBe(boundId);
    expect(r.bindingOrigin).toBe('env');
  });

  test('sub-ladder: the per-connection HEADER beats the process-wide ENV', async () => {
    process.env[PROJECT_BINDING_ENV_VAR] = OTHER_PROJECT;
    const r = await resolveProjectBinding('context_store', {}, BOUND_PROJECT);
    expect(r.projectId).toBe(boundId);
    expect(r.bindingOrigin).toBe('header');
  });

  test('a BLANK header is absent, not a binding to "" (falls through to env)', async () => {
    process.env[PROJECT_BINDING_ENV_VAR] = BOUND_PROJECT;
    const r = await resolveProjectBinding('context_store', {}, '   ');
    expect(r.projectId).toBe(boundId);
    expect(r.bindingOrigin).toBe('env');
  });
});

describe('rung 1 — an EXPLICIT project may only win if it PROVABLY agrees', () => {
  test('explicit == binding (by name vs by id) ⇒ allowed, source is explicit', async () => {
    const r = await resolveProjectBinding('context_store', { projectId: boundId }, BOUND_PROJECT);
    expect(r.bound).toBe(true);
    expect(r.source).toBe('explicit');
    expect(r.projectId).toBe(boundId);
  });

  test('explicit != binding ⇒ THROWS, and the error NAMES BOTH projects', async () => {
    const err = await resolveProjectBinding(
      'context_store',
      { projectId: otherId },
      BOUND_PROJECT
    ).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ProjectBindingMismatchError);
    expect(err.code).toBe(PROJECT_BINDING_ERROR_CODES.MISMATCH);
    // BOTH candidates, by name AND by id — the report's "fails clearly".
    expect(err.message).toContain(BOUND_PROJECT);
    expect(err.message).toContain(boundId);
    expect(err.message).toContain(OTHER_PROJECT);
    expect(err.message).toContain(otherId);
  });

  test('the mismatch is symmetric — swapping which side is bound still throws', async () => {
    await expect(
      resolveProjectBinding('context_store', { projectId: boundId }, OTHER_PROJECT)
    ).rejects.toBeInstanceOf(ProjectBindingMismatchError);
  });
});

describe('UNRESOLVABLE ⇒ loud, never a default', () => {
  test('a binding naming no real project THROWS instead of falling back to auto-select', async () => {
    const err = await resolveProjectBinding('context_store', {}, `ghost-${STAMP}`).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ProjectBindingUnresolvedError);
    expect(err.code).toBe(PROJECT_BINDING_ERROR_CODES.BINDING_UNRESOLVED);
    expect(err.message).toContain(`ghost-${STAMP}`);
  });

  test('an explicit target naming no real project, while bound, THROWS (agreement unprovable)', async () => {
    const err = await resolveProjectBinding(
      'context_store',
      { projectId: `ghost-${STAMP}` },
      BOUND_PROJECT
    ).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ProjectBindingTargetUnresolvedError);
    expect(err.code).toBe(PROJECT_BINDING_ERROR_CODES.TARGET_UNRESOLVED);
    expect(err.message).toContain(BOUND_PROJECT);
    expect(err.message).toContain(`ghost-${STAMP}`);
  });
});

describe('project_switch — the human rung, and what a BOUND client may do to it', () => {
  test('project_switch declares a scoped project param (`project`), not an exempt one', () => {
    expect(projectScopeParam('project_switch')).toBe('project');
    expect(classifyProjectParam('project_switch', 'project')).toBe('scoped');
  });

  /**
   * AMENDED by an earlier task. The property that matters for Coordinator's workflow is that an
   * UNBOUND human can still switch to ANY project — that is unchanged and asserted here. What
   * changed is the FORM the identifier arrives in: rung 1 is now normalized for everyone, so
   * the switch is performed against the canonical UUID rather than the raw string. Uniform
   * normalization is deliberate — carving `project_switch` out would be a second
   * classification of "which project params get canonicalised", i.e. a rule in two places that
   * agree today and drift later.
   */
  test('UNBOUND: project_switch to any project still succeeds, via the canonical id', async () => {
    const r = await resolveProjectBinding('project_switch', { project: OTHER_PROJECT });
    expect(r.bound).toBe(false);
    expect(r.source).toBe('explicit');
    expect(r.projectId).toBe(otherId);
    expect(r.scopeParam).toBe('project');
  });

  test('BOUND: switching AWAY from the bound project fails loudly (never silently lost)', async () => {
    await expect(
      resolveProjectBinding('project_switch', { project: OTHER_PROJECT }, BOUND_PROJECT)
    ).rejects.toBeInstanceOf(ProjectBindingMismatchError);
  });

  test('BOUND: switching TO the bound project is a legal no-op', async () => {
    const r = await resolveProjectBinding('project_switch', { project: BOUND_PROJECT }, boundId);
    expect(r.projectId).toBe(boundId);
    expect(r.source).toBe('explicit');
  });
});

describe('FAIL-CLOSED param accounting — no project-ish param may go unclassified', () => {
  /**
   * THE ACCOUNTING TRIPWIRE (a past incident / a past incident #1). It does NOT grep for the tools
   * we expect to be project-scoped — that is an allow-list whose default is a silent PASS.
   * It walks EVERY declared parameter of EVERY tool schema (the choke point every tool's
   * params pass through) and requires each one matching the concept token `project` to be
   * classified by the PRODUCT's own classifier as `scoped` or `exempt`, with an exemption
   * that carries a reason. A newly-added project-scoped param nobody classified shows up
   * here as a RED, not as a silent hole in the guard.
   */
  test('every declared project-ish param on every tool is classified, with reasons', () => {
    const unclassified: string[] = [];
    const reasonless: string[] = [];
    for (const toolName of Object.keys(validationSchemas)) {
      // Ask the PRODUCT for the declared keys — same derivation the resolver uses.
      const scopeParam = projectScopeParam(toolName);
      const schema: any = (validationSchemas as any)[toolName];
      let shape: any = schema;
      while (shape?._def?.typeName === 'ZodEffects') shape = shape._def.schema;
      const keys: string[] = shape?.shape ? Object.keys(shape.shape) : [];
      for (const key of keys.filter((k) => PROJECT_PARAM_PATTERN.test(k))) {
        const cls = classifyProjectParam(toolName, key);
        if (cls === 'exempt') {
          const reason = PROJECT_PARAM_EXEMPTIONS[`${toolName}.${key}`];
          if (!reason || reason.trim().length < 20) reasonless.push(`${toolName}.${key}`);
        } else if (cls === 'override') {
          // An all-projects flag: not a scope selection, and enforced by the scope-conflict
          // guard rather than by materialisation. Classified — nothing further required.
          continue;
        } else if (scopeParam !== key) {
          // scoped but not the resolver's chosen scope param ⇒ the resolver would ignore it.
          unclassified.push(`${toolName}.${key}`);
        }
      }
    }
    expect(reasonless).toEqual([]);
    expect(unclassified).toEqual([]);
  });

  test('an all-projects flag classifies as `override`, NEVER as a scope selection', () => {
    // Anchored on the classifier, not on a re-stated rule: `allProjects` contains the
    // `project` token, so without the override class it would be read as a place to write.
    expect(classifyProjectParam('any_tool', 'allProjects')).toBe('override');
    expect(classifyProjectParam('any_tool', 'all_projects')).toBe('override');
    expect(classifyProjectParam('any_tool', 'projectId')).toBe('scoped');
  });

  test('the exemption list has no dead entries (every key names a real tool.param)', () => {
    const dead: string[] = [];
    for (const key of Object.keys(PROJECT_PARAM_EXEMPTIONS)) {
      const idx = key.lastIndexOf('.');
      const tool = key.slice(0, idx);
      const param = key.slice(idx + 1);
      const schema: any = (validationSchemas as any)[tool];
      let shape: any = schema;
      while (shape?._def?.typeName === 'ZodEffects') shape = shape._def.schema;
      if (!shape?.shape || !(param in shape.shape)) dead.push(key);
    }
    expect(dead).toEqual([]);
  });

  test('a tool with no project param resolves to no scope param (nothing to pin)', () => {
    expect(projectScopeParam('mandrel_ping')).toBeUndefined();
    expect(projectScopeParam('not_a_real_tool')).toBeUndefined();
  });
});

describe('AMBIGUITY is refused for the BOUND client and INVISIBLE to the unbound one', () => {
  /**
   * A tool declaring TWO project-scope params has no single write target. This must fail
   * loudly for a bound client — and must NOT start throwing for the humans and unbound
   * clients that never asked for a binding (one branch adding such a tool
   * would otherwise break every caller of it).
   *
   * The ambiguous tool is INJECTED into the real `validationSchemas` object the product
   * reads, so this exercises the actual derivation rather than a stand-in.
   */
  const AMBIGUOUS_TOOL = `__fm753_ambiguous_${STAMP}`;

  beforeAll(() => {
    (validationSchemas as any)[AMBIGUOUS_TOOL] = z.object({
      projectId: z.string().optional(),
      projectScope: z.string().optional(),
    });
  });

  afterAll(() => {
    delete (validationSchemas as any)[AMBIGUOUS_TOOL];
  });

  test('BOUND + ambiguous tool ⇒ typed ambiguity error naming every candidate param', async () => {
    const err = await resolveProjectBinding(AMBIGUOUS_TOOL, {}, BOUND_PROJECT).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ProjectBindingAmbiguousParamError);
    expect(err.code).toBe(PROJECT_BINDING_ERROR_CODES.AMBIGUOUS_PARAM);
    expect(err.message).toContain('projectId');
    expect(err.message).toContain('projectScope');
  });

  test('UNBOUND + ambiguous tool ⇒ no throw at all (the human path cannot regress)', async () => {
    const r = await resolveProjectBinding(AMBIGUOUS_TOOL, { projectId: otherId }, undefined);
    expect(r.bound).toBe(false);
    expect(r.projectId).toBeUndefined();
  });
});
