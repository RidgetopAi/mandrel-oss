/**
 * PROJECT BINDING resolver — the ONE place the project-precedence ladder is written down.
 * an earlier task (Amp-orb eval finding W5, client half; report lines 497-520).
 *
 * =============================================================================
 * THE LADDER (stated once, here; enforced once, at the routeExecutor choke point)
 * =============================================================================
 *   rung 1  EXPLICIT      — a per-call project-naming argument (`projectId`, or
 *                           `project` on project_switch).
 *   rung 2  BINDING       — the client's CONFIGURED default project
 *                           (`X-Mandrel-Project` header  >  `MANDREL_PROJECT_ID` env;
 *                           see config/projectBindingConfig.ts).
 *   rung 3  INTERACTIVE   — the connection's current project
 *                           (projectHandler.initializeSession → getCurrentProjectId),
 *                           i.e. what `project_switch` sets. THE HUMAN PATH.
 *
 * NO SILENT FALLBACK BETWEEN RUNGS. That is the whole point:
 *   - A BOUND client NEVER falls through to rung 3. If it is bound to `amp-exp-1` it
 *     starts in `amp-exp-1` and stays there — auto-selection can no longer reach it.
 *   - EXPLICIT + BINDING that name DIFFERENT projects is not a precedence question, it
 *     is a CONTRADICTION: the call fails with a typed error naming BOTH candidates
 *     (ProjectBindingMismatchError). It never silently wins and never silently loses.
 *   - A binding (or an explicit target, when a binding is in force) that does not
 *     resolve to a real project is UNRECOGNISED → a typed error, never a default
 *     (unrecognised must be a loud RED, not a silent pass).
 *   - An UNBOUND client (no header, no env — every human, every client today) never
 *     enters rung 2 or rung 3's machinery. rung 3 behaves byte-for-byte as before
 *. Its rung 1 is NORMALIZED — see the next paragraph.
 *
 * =============================================================================
 * rung 1 IS NORMALIZED FOR EVERYONE (an earlier task — a BUGFIX, not binding work)
 * =============================================================================
 * An EXPLICIT project argument is canonicalised name→UUID here for BOTH bound and unbound
 * callers, because the argument was accepted as a name by SOME consumers and not others.
 * an earlier Task shipped this module with the promise that the unbound path is "byte-identical
 * to pre-binding"; an earlier task DELIBERATELY breaks that promise for exactly the buggy case,
 * because pre-binding behaviour was itself broken (a name reached `AND project_id = $n`
 * verbatim and severed edge minting). It is scoped to the case and covered by its own
 * regression test — projectArgNormalizer.contract.test.ts — rather than smuggled in as
 * binding work. The no-explicit-argument path is still untouched, down to the DB round-trip.
 *
 * =============================================================================
 * WHY IT LIVES HERE AND NOWHERE ELSE
 * =============================================================================
 * There are NINE `resolveProjectId()` copies across `src/routes/*.ts`, each of which
 * already honours an explicit `args.projectId`. Re-implementing the ladder in nine
 * places is the exact "count the copies" failure a past incident is about. So the binding is
 * enforced ONCE, at `routeExecutor` — the single choke point every tool call passes
 * through on BOTH surfaces (flat `/mcp/tools/*` and the gateway `discover`/`context(...)`
 * dispatcher, which delegates to `routeExecutor(opId, …)`) — and materialised by setting
 * the tool's own project argument. Every downstream route then honours it through the
 * code path it already had. One home for the rule; zero new copies.
 *
 * NOT a replacement for the SERVER-side fix. an earlier Task ([Identity 2/3])
 * makes the connection's current project an ACTOR-KEYED PERSISTED default and
 * deletes the connection-keyed Map + the shared `http-default` slot. That is rung 3's
 * permanent fix and it stays the plan. This module deliberately does not touch rung 3's
 * storage at all — it only decides which rung wins — so the two compose instead of
 * becoming a third source of truth.
 */

import { projectHandler } from '../handlers/project.js';
import { logger } from '../utils/logger.js';
import { declaredParamKeys } from '../middleware/validation.js';
import { PROJECT_REF_CONTRACT_PHRASE } from '../config/projectParamContract.js';
import {
  configuredBinding,
  PROJECT_BINDING_ENV_VAR,
  PROJECT_BINDING_HEADER,
  type ConfiguredBinding,
  type ProjectBindingOrigin,
} from '../config/projectBindingConfig.js';
import { MandrelClassifiedError, type HttpErrorStatus } from '../utils/mcpErrorStatus.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Which argument names a project SCOPE?
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * THE CHOKE-POINT TOKEN. A tool's project-scope argument is found by asking the tool's
 * OWN declared zod schema for its parameter names and matching on the token every such
 * parameter must contain: `project`. Anchoring on the concept's token rather than on a
 * hand-maintained list of tool names is a past incident's result — a new project-scoped tool
 * is covered the day it is born, with no registry to update and no allow-list to rot.
 */
export const PROJECT_PARAM_PATTERN = /project/i;

/**
 * SCOPE-OVERRIDE params — a declared flag whose meaning is "ignore the project scope and
 * span ALL projects" (e.g. `allProjects`). Anchored on the concept token, like
 * PROJECT_PARAM_PATTERN, so a future tool that declares one is covered the day it is born.
 *
 * WHY THIS EXISTS (Reviewer item 3). For a BOUND client the gate materialises
 * the bound project into the tool's scope argument. A handler that checks its scope argument
 * BEFORE its all-projects branch — `if (args.project) {...} else if (args.allProjects) {...}`,
 * which is the natural way to write it — would then take the scoped branch and the caller's
 * explicit "span everything" flag would be SILENTLY IGNORED. Silent-ignore is the exact class
 * this whole task exists to kill, so the request is REFUSED LOUDLY instead: the two intents
 * genuinely contradict (a bound client asking to read outside its binding), and picking either
 * one for the caller is a guess.
 *
 * NOTE: no tool in this tree declares such a param today. `session_list` is
 * expected to add `allProjects`, and this guard is deliberately landed FIRST so the conflict
 * is structurally impossible on the day it merges rather than discovered afterwards. It is
 * proven now by an injected-schema test, not left as an untested claim.
 */
export const PROJECT_SCOPE_OVERRIDE_PATTERN = /all.*projects?/i;

/**
 * EXEMPTIONS — declared project-ish params that are NOT a write-scope selection, each
 * with the reason CO-LOCATED with the exemption (an exception co-located on
 * the read; forgetting one is a visible RED, not a silent hole).
 *
 * Keyed `<tool>.<param>` so an exemption can never bleed onto a sibling tool that has a
 * parameter of the same name. `project_switch.project` is deliberately NOT here: it IS a
 * scope selection (it moves rung 3), which is precisely what a bound client must not be
 * able to do silently.
 *
 * Anything project-ish and NOT listed here is SCOPED — see classifyProjectParam(). The
 * fail-closed accounting test (`tests/projectBinding.contract.test.ts`, describe block
 * "FAIL-CLOSED param accounting") walks every declared parameter of every tool and REDs on a
 * project-ish param nobody has classified.
 */
export const PROJECT_PARAM_EXEMPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'project_info.project':
    'reads one named project’s metadata. Naming a project to LOOK AT it is not choosing where a write lands.',
  'project_update.project':
    'project ADMINISTRATION by handle (rename/describe a specific project). Not a write-scope selection.',
  'project_delete.project':
    'project ADMINISTRATION by handle (delete a specific project). Not a write-scope selection.',
  'project_move_record.toProject':
    'the DESTINATION of a record move, named by handle and REQUIRED. ' +
    'It selects nothing ambiently — there is no fallback to the caller\'s project on either end ' +
    'of a move, so this call is fully self-describing and cannot land in the shared slot. ' +
    'Treating it as a write-scope selection would pin a bound client to moving records INTO its ' +
    'own project only, which forbids the half of the feature that gets a misfiled record OUT.',
  // NOTE: `project_insights` declares `projectId`, NOT `project`, so it is deliberately NOT
  // exempted — it is scoped like every other `projectId` tool (a bound client's insights read
  // is pinned to its own project). An earlier draft exempted a `project_insights.project` that
  // does not exist; the dead-entry assertion in projectBinding.contract.test.ts caught it.
});

export type ProjectParamClass = 'scoped' | 'override' | 'exempt';

/**
 * Classify a declared project-ish parameter. DENY-BY-DEFAULT in the safe direction:
 * anything neither exempted nor an all-projects override is SCOPED, i.e. a bound client's
 * binding is ENFORCED against it. An unrecognised project param therefore fails CLOSED at
 * runtime (enforced) and is surfaced by the coverage test, never silently unguarded.
 *
 * `override` is checked BEFORE the scoped default because a name like `allProjects` contains
 * the `project` token and would otherwise be read as a SCOPE SELECTION — which it is the
 * opposite of. (Found by this module's own scope-conflict test: the injected `allProjects`
 * tripped the two-scope-params ambiguity error instead of the conflict guard. A flag that
 * says "span everything" is not a choice of where to write.)
 */
export function classifyProjectParam(toolName: string, paramName: string): ProjectParamClass {
  if (`${toolName}.${paramName}` in PROJECT_PARAM_EXEMPTIONS) return 'exempt';
  if (PROJECT_SCOPE_OVERRIDE_PATTERN.test(paramName)) return 'override';
  return 'scoped';
}

/**
 * ALL scoped project params a tool declares. PURE and NEVER throws — this is the
 * observation. `projectScopeParam` below is the JUDGEMENT (there must be exactly one).
 * Separating them is what lets the UNBOUND path stay non-throwing for every tool that
 * will ever exist (see resolveProjectBinding).
 */
function scopedProjectParams(toolName: string): string[] {
  const declared = declaredParamKeys(toolName);
  if (!declared) return [];
  return [...declared]
    .filter((k) => PROJECT_PARAM_PATTERN.test(k))
    .filter((k) => classifyProjectParam(toolName, k) === 'scoped');
}

/**
 * The project params a tool declares that name a SPECIFIC EXISTING PROJECT as the call's
 * target rather than selecting a write SCOPE — i.e. the ones classified 'exempt'
 *.
 *
 * WHY THE UNIDENTIFIED-CALLER GUARD NEEDS THIS. G2 asks "would this write fall through to
 * the shared ambient slot?" For `project_delete`/`project_update` the answer is NO: the
 * target is `args.project`, resolved by handle, and the ambient slot plays no part. But
 * `projectScopeParam` deliberately returns undefined for them (that is what 'exempt' MEANS
 * — administration by handle is not a write-scope selection), so a guard reading only the
 * scope param would reject a call that is already fully self-describing, with no per-call
 * remedy. Measured: it would have broken the Command UI's Delete Project.
 *
 * Derived from PROJECT_PARAM_EXEMPTIONS via `classifyProjectParam` — the SAME single source
 * that decides exemption in the first place, so there is no second list that could disagree
 * with it (a past incident #5). PURE, never throws.
 */
export function explicitProjectTargetParams(toolName: string): string[] {
  const declared = declaredParamKeys(toolName);
  if (!declared) return [];
  return [...declared]
    .filter((k) => PROJECT_PARAM_PATTERN.test(k))
    .filter((k) => classifyProjectParam(toolName, k) === 'exempt');
}

/**
 * EVERY parameter of a tool that REFERENCES a project — the union of the `scoped` write-scope
 * params and the `exempt` administration-by-handle params.
 *
 * WHY THE UNION IS THE RIGHT POPULATION, and why it is not `scopedProjectParams`. Two
 * different questions are being asked of these parameters and they have different answers:
 *
 *   "where does this call WRITE?"        → `scoped` only. That is the binding ladder's
 *                                          question and `scopedProjectParams` is its answer.
 *   "does this value name a project?"    → `scoped` AND `exempt`. `project_delete.project`
 *                                          is exempt from the ladder because naming a
 *                                          project to DELETE it is not choosing a write
 *                                          scope — but it is still a project reference, and
 *                                          the caller is still told it accepts a name.
 *
 * The blank-reference rule below and the documented-contract gate
 * (src/tests/projectNameContract.contract.test.ts) both ask the SECOND question, so they read
 * THIS function. Deriving both from `classifyProjectParam` — the same single source that
 * decides exemption — is what stops the exempt trio from falling into the gap between the two
 * questions, which is exactly where they sat: unnormalised by the ladder AND unguarded by the
 * ladder's coverage test.
 *
 * `override` params are EXCLUDED, with the reason co-located: an `allProjects` flag is a
 * BOOLEAN that says "span everything", the opposite of a reference to one project. It can
 * never carry a name, so neither the blank rule nor the name contract applies to it.
 *
 * PURE, never throws — like its two siblings. Order follows the schema's declaration order.
 */
export function projectRefParams(toolName: string): string[] {
  const declared = declaredParamKeys(toolName);
  if (!declared) return [];
  return [...declared]
    .filter((k) => PROJECT_PARAM_PATTERN.test(k))
    .filter((k) => classifyProjectParam(toolName, k) !== 'override');
}

/**
 * A BLANK project reference — present in the arguments but naming nothing.
 *
 * THE HOLE THIS CLOSES, measured on v0.15.0 (9930f00) against a migrated DB:
 *   task_list({projectId:'   '})     → ❌ [DATASTORE_ERROR] … "This is a server-side fault,
 *                                        not a problem with the arguments you sent —
 *                                        re-sending the same call is reasonable."
 *   context_stats({projectId:'   '}) → ❌ Project     not found
 *   task_list({projectId:''})        → ✅ "No tasks found for this project"
 *
 * THREE outcomes for ONE input class, and the first is the worst of the three: the whitespace
 * string is not blank enough to trip the `raw.trim() !== ''` guard in the unbound branch
 * below, so rung 1 declares the call "not named", materialises nothing, and the raw `'   '`
 * travels down the route's own resolveProjectId into `AND project_id = $n` — the ORIGINAL
 * uuid-cast bug, surviving inside the fix for it, one input away. v0.15.0's datastore error
 * boundary (guardPool, merge a50af00) catches the leak, but its advice is then actively
 * wrong: it tells the caller their arguments are not what failed and that retrying is
 * reasonable, when the argument IS what failed and retrying fails identically forever.
 *
 * A blank project reference is a CALLER BUG in every case — an unset variable interpolated
 * into the call. It is refused LOUDLY rather than treated as "omitted", for the reason this
 * whole workstream exists: on a WRITE, silently reading a blank scope as "use the ambient
 * project" is precisely the silent wrong-project write of an earlier task. The caller believes
 * it named a project; the row lands somewhere else.
 *
 * CONSISTENT WITH THE OTHER PATH, not a new invention (C5 — name the paths). The Command
 * backend already rejects exactly this class with a 400: `requireWriteProjectId` throws
 * MissingWriteProjectScopeError for an empty-string OR whitespace project id
 * (mandrel-command/backend/src/__tests__/writeProjectScope.test.ts). The MCP surface was the
 * path that did not.
 *
 * `undefined` and `null` are ABSENT, not blank — both spell "no value supplied" in JS and
 * JSON, and `{projectId: undefined}` is an everyday JS call shape. A present value that is
 * not a non-blank string is blank: `''`, `'   '`, and (only reachable by an internal caller
 * bypassing zod) a number or object.
 */
function isBlankProjectRef(value: unknown): boolean {
  if (value === undefined || value === null) return false; // absent
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * THE BLANK RULE, enforced once for the whole population. Called first in
 * resolveProjectBinding, so it covers every tool call on both surfaces, every rung of the
 * ladder, and every project-reference param — INCLUDING the `exempt` administration params
 * the ladder deliberately ignores, and including a (hypothetical) tool with two scoped params
 * whose explicit argument the unbound branch skips.
 *
 * Anchored on `projectRefParams` — the derived population — so a new project-reference param
 * is covered the day it is born (no allow-list).
 */
function assertProjectRefsNamed(toolName: string, args: Record<string, unknown> | undefined): void {
  if (!args) return;
  for (const param of projectRefParams(toolName)) {
    if (param in args && isBlankProjectRef(args[param])) {
      throw new ProjectArgBlankError(toolName, param, args[param]);
    }
  }
}

/**
 * The scope-override params a tool declares (see PROJECT_SCOPE_OVERRIDE_PATTERN). PURE,
 * never throws. Derived from the tool's own schema — no list to maintain.
 */
function scopeOverrideParams(toolName: string): string[] {
  const declared = declaredParamKeys(toolName);
  if (!declared) return [];
  return [...declared].filter((k) => classifyProjectParam(toolName, k) === 'override');
}

/**
 * The project-scope argument name for a tool, derived from the tool's OWN declared schema.
 * Returns undefined when the tool declares no project-scope parameter (most tools).
 *
 * THROWS ProjectBindingAmbiguousParamError when a tool declares TWO scoped project params:
 * there is then no single answer to "where does this call write", and picking one would be
 * exactly the silent choice this module exists to abolish. Only ever called on the BOUND
 * path, so a future ambiguous tool fails loudly for a bound client without changing
 * anything for an unbound one.
 */
export function projectScopeParam(toolName: string): string | undefined {
  const scoped = scopedProjectParams(toolName);
  if (scoped.length > 1) {
    throw new ProjectBindingAmbiguousParamError(toolName, scoped);
  }
  return scoped[0];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Typed errors — every one of them NAMES the candidates. Never a default.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Stable machine codes so a caller can branch without string-matching prose. */
export const PROJECT_BINDING_ERROR_CODES = Object.freeze({
  MISMATCH: 'PROJECT_BINDING_MISMATCH',
  BINDING_UNRESOLVED: 'PROJECT_BINDING_UNRESOLVED',
  TARGET_UNRESOLVED: 'PROJECT_BINDING_TARGET_UNRESOLVED',
  AMBIGUOUS_PARAM: 'PROJECT_BINDING_AMBIGUOUS_PARAM',
  /** rung-1 normalizer: an explicit project arg that names nothing, UNBOUND. */
  ARG_UNRESOLVED: 'PROJECT_ARG_UNRESOLVED',
  /** a project reference that is PRESENT but blank (''/'   '/non-string). */
  ARG_BLANK: 'PROJECT_ARG_BLANK',
} as const);

export class ProjectBindingError extends MandrelClassifiedError {
  /**
   * The message is PREFIXED with the machine code and carries its own 💡 next step. Both
   * matter because this error crosses the MCP seam: `formatMcpError` → `actionableErrorText`
   * sanitizes and would otherwise append a GENERIC "re-check your parameters" hint, which is
   * the wrong advice here. A message already carrying 💡 is passed through untouched, so the
   * code and the specific remedy survive to the client verbatim.
   *
   * `faultStatus` is a REQUIRED third argument, not a default. Measured
   * before this change: every one of these refusals reached the HTTP caller as **200 OK** —
   * a refused write reported as a completed one — because `routeExecutorInner` returns them
   * in band and the in-band branch hardcoded 200. A default here would have re-created that
   * silence for the next subclass; making it required means a new refusal cannot be added
   * without someone deciding, at the keyboard, whose fault it is. The string `code` above is
   * untouched and stays a string: it is for CALLERS to branch on, and it is deliberately no
   * longer asked to double as the transport's classification key.
   */
  constructor(
    message: string,
    readonly code: string,
    faultStatus: HttpErrorStatus
  ) {
    super(`[${code}] ${message}`, faultStatus);
    this.name = 'ProjectBindingError';
  }
}

/**
 * rung 1 vs rung 2 CONTRADICTION. The message names BOTH projects (name + id) and where
 * each came from, so the operator can see at a glance which end is misconfigured.
 */
export class ProjectBindingMismatchError extends ProjectBindingError {
  constructor(
    readonly toolName: string,
    readonly requested: { identifier: string; id: string; name: string },
    readonly bound: { identifier: string; id: string; name: string; originLabel: string }
  ) {
    super(
      `Project mismatch on '${toolName}': this client is BOUND to project ` +
        `'${bound.name}' (${bound.id}) via the ${bound.originLabel}, but the call explicitly ` +
        `targets project '${requested.name}' (${requested.id}). Refusing to guess — a bound ` +
        `client must not write outside its project. Either drop the explicit project argument ` +
        `to use the binding, or re-bind this client (${PROJECT_BINDING_HEADER} header / ` +
        `${PROJECT_BINDING_ENV_VAR}) to '${requested.name}'.` +
        `\n\n💡 Bound project: '${bound.name}' (${bound.id}). Requested project: ` +
        `'${requested.name}' (${requested.id}). Retry WITHOUT the explicit project argument to ` +
        `write to the bound project.`,
      PROJECT_BINDING_ERROR_CODES.MISMATCH,
      // 409 CONFLICT, not a plain 400. The request is well-formed and every value in it
      // exists; what it collides with is the binding this client already established. 409 is
      // the only 4xx that says "your request contradicts current state" — a caller can branch
      // on it to re-bind or drop the argument without parsing prose, which a 400 shared with
      // every malformed-input case cannot support.
      409
    );
    this.name = 'ProjectBindingMismatchError';
  }
}

/** The CONFIGURED binding does not name a real project. Fail loud; never fall back. */
export class ProjectBindingUnresolvedError extends ProjectBindingError {
  constructor(readonly binding: ConfiguredBinding) {
    super(
      `Configured project binding '${binding.identifier}' (${binding.originLabel}) does not ` +
        `match any project. Refusing to fall back to an auto-selected project — that is the ` +
        `silent wrong-project write this binding exists to prevent.` +
        `\n\n💡 Fix the ${binding.originLabel} to name an existing project (id or name), or ` +
        `create project '${binding.identifier}' first.`,
      PROJECT_BINDING_ERROR_CODES.BINDING_UNRESOLVED,
      // THE ONE CASE WHERE THE ANSWER DEPENDS ON WHO CONFIGURED IT, and the reason
      // `ProjectBindingError` takes the full HttpErrorStatus rather than the 4xx-only
      // PolicyRefusalStatus. `binding.origin` is 'header' when the CLIENT declared
      // X-Mandrel-Project — a client naming a project that does not exist, which is a 400 —
      // and 'env' when THIS HOST's MANDREL_PROJECT_ID names nothing, which is an operator
      // misconfiguration that fails every call on the instance until someone fixes the
      // process env. That is a genuine server fault: it belongs in the 5xx rate, and it
      // should page. Handing the client a 4xx for it would tell the one party who cannot fix
      // it that it was their mistake.
      binding.origin === 'header' ? 400 : 500
    );
    this.name = 'ProjectBindingUnresolvedError';
  }
}

/**
 * The EXPLICIT target does not name a real project while a binding is in force. We cannot
 * prove the two agree, so we must not proceed: proving agreement is the guard.
 */
export class ProjectBindingTargetUnresolvedError extends ProjectBindingError {
  constructor(
    readonly toolName: string,
    readonly requestedIdentifier: string,
    readonly bound: { id: string; name: string; originLabel: string }
  ) {
    super(
      `Explicit project '${requestedIdentifier}' on '${toolName}' does not match any project, ` +
        `and this client is BOUND to '${bound.name}' (${bound.id}) via the ${bound.originLabel}. ` +
        `Refusing to guess which was meant.` +
        `\n\n💡 Drop the explicit project argument to write to the bound project ` +
        `'${bound.name}' (${bound.id}), or correct the project you named.`,
      PROJECT_BINDING_ERROR_CODES.TARGET_UNRESOLVED,
      // 404: the client explicitly named a project and no such project exists. The
      // resource-shaped client error, same as MethodNotFound above.
      404
    );
    this.name = 'ProjectBindingTargetUnresolvedError';
  }
}

/**
 * rung 1's EXPLICIT argument does not name a real project, and NO binding is in force
 *. This is the UNBOUND counterpart of ProjectBindingTargetUnresolvedError:
 * there is no bound project to name as the alternative, so the message just names what was
 * asked for and how to look it up.
 *
 * WHY IT IS LOUD RATHER THAN A PASS-THROUGH. Before the rung-1 normalizer, an unresolvable
 * explicit value flowed raw into each handler and produced whatever that handler happened to
 * do — measured pre-fix as FOUR different outcomes across the surface: a clean "not found",
 * a raw Postgres `invalid input syntax for type uuid`, a soft non-error response carrying a
 * ❌ in its prose, and (on the tag/edge path) a FALSE "could not be resolved" about the
 * REFERENT rather than about the project. One typed error replaces all four.
 */
export class ProjectArgUnresolvedError extends ProjectBindingError {
  constructor(
    readonly toolName: string,
    readonly paramName: string,
    readonly requestedIdentifier: string
  ) {
    super(
      `Project '${requestedIdentifier}' named in '${paramName}' on '${toolName}' does not match ` +
        `any project (by id or by name). Refusing to run the call against an unresolved project ` +
        `scope — that is how a write lands nowhere and a reference silently fails to resolve.` +
        `\n\n💡 Use project_list to see available projects, then pass an existing project id ` +
        `(recommended — a rename cannot break it) or name as '${paramName}'.`,
      PROJECT_BINDING_ERROR_CODES.ARG_UNRESOLVED,
      // 404, for the same reason as TARGET_UNRESOLVED — this is its UNBOUND twin, and two
      // errors that mean "the project you named does not exist" must not answer differently
      // depending on whether a binding happened to be in force.
      404
    );
    this.name = 'ProjectArgUnresolvedError';
  }
}

/**
 * A project reference was SUPPLIED but names nothing. See
 * `isBlankProjectRef` for the measured three-way split this replaces and for why blank is
 * refused rather than read as "omitted".
 *
 * The message quotes the value with visible delimiters, because the entire diagnostic
 * difficulty of this bug class is that `'   '` and `''` look identical in a log line.
 */
export class ProjectArgBlankError extends ProjectBindingError {
  constructor(
    readonly toolName: string,
    readonly paramName: string,
    readonly suppliedValue: unknown
  ) {
    const shown =
      typeof suppliedValue === 'string' ? `"${suppliedValue}"` : `a ${typeof suppliedValue}`;
    super(
      `Project reference '${paramName}' on '${toolName}' was supplied but names no project ` +
        `(received ${shown}). This is the argument, not a server fault — retrying the same ` +
        `call cannot succeed. Refusing to read a blank project reference as "use whatever ` +
        `project is current": on a write that is how a row lands in a project the caller ` +
        `never chose.` +
        `\n\n💡 Either OMIT '${paramName}' entirely (to use the current project) or pass a ` +
        `real ${PROJECT_REF_CONTRACT_PHRASE.toLowerCase()}; project_list shows both.`,
      PROJECT_BINDING_ERROR_CODES.ARG_BLANK,
      // 400. The message above already says it in prose — "This is the argument, not a
      // server fault — retrying the same call cannot succeed" — and the transport spent this
      // whole class of bug contradicting it with a 200. Now the status agrees with the text.
      400
    );
    this.name = 'ProjectArgBlankError';
  }
}

/** A tool declaring two scoped project params has no single write target. */
export class ProjectBindingAmbiguousParamError extends ProjectBindingError {
  constructor(
    readonly toolName: string,
    readonly params: string[]
  ) {
    super(
      `Tool '${toolName}' declares more than one project-scope parameter ` +
        `(${params.join(', ')}); there is no single project this call writes to.` +
        `\n\n💡 Classify all but one in PROJECT_PARAM_EXEMPTIONS (services/projectBinding.ts) ` +
        `with a reason.`,
      PROJECT_BINDING_ERROR_CODES.AMBIGUOUS_PARAM,
      // 500, and this one is NOT a policy refusal — read the remedy: "Classify all but one in
      // PROJECT_PARAM_EXEMPTIONS (services/projectBinding.ts)". The defect is in OUR tool
      // schema, the client sent nothing wrong, and no request the client can construct will
      // succeed until we ship a source change. Reporting it 4xx would blame the caller and,
      // worse, hide a shipped schema defect from the 5xx rate that is the only thing watching
      // for it. Every other error in this file is the caller's; this one is ours.
      500
    );
    this.name = 'ProjectBindingAmbiguousParamError';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The resolver
 * ──────────────────────────────────────────────────────────────────────────── */

/** Which rung of the ladder produced the project this call will use. */
export type ProjectResolutionSource = 'explicit' | 'binding' | 'interactive';

export interface ProjectBindingResolution {
  /** TRUE when this client declared a binding (rung 2 is in force for it). */
  bound: boolean;
  /** The rung that won. `interactive` means the route resolves it as it always did. */
  source: ProjectResolutionSource;
  /**
   * The canonical project UUID this call is pinned to, or undefined for `interactive`
   * (the unbound path, where the route's own resolution is left completely untouched).
   */
  projectId?: string;
  /** The resolved project NAME, when known (audit + human messages). */
  projectName?: string;
  /** The scope argument this resolution applies to, when the tool declares one. */
  scopeParam?: string;
  /**
   * Any all-projects widening flags the caller passed that the binding NARROWED (bound path
   * only). Empty for every normal call. Surfaced so the narrowing is auditable rather than
   * silent — see the SCOPE OVERRIDE note in resolveProjectBinding.
   */
  overriddenScopeParams?: string[];
  /**
   * WHICH configuration surface supplied the binding (`header` | `env`), when bound.
   * Returned by the resolver rather than re-derived by the caller: the header>env order
   * is decided in ONE place (configuredBinding) and a second copy at the audit site would
   * be a rule two programs merely agree on today (a past incident #5).
   */
  bindingOrigin?: ProjectBindingOrigin;
  /**
   * The HUMAN-FACING name of that surface (`x-mandrel-project header` / `MANDREL_PROJECT_ID
   * env var`), when bound. Carried rather than re-derived for the same reason as
   * `bindingOrigin`: the label is built exactly once, in `configuredBinding`, and a caller
   * that re-mapped origin→label would be a second copy of a rule that can drift.
   * The caller-facing narrowing notice below names it, so a bound client is told not just
   * THAT it is bound but WHICH knob to unset.
   */
  bindingOriginLabel?: string;
}

/**
 * Resolve an identifier (project UUID **or** project NAME) to a canonical project.
 * `projectHandler.getProject` already accepts both; null means "no such project".
 */
async function lookup(identifier: string): Promise<{ id: string; name: string } | null> {
  const p = await projectHandler.getProject(identifier);
  return p ? { id: p.id, name: p.name } : null;
}

/**
 * THE RULE. Decide which project a tool call is scoped to, given the caller's explicit
 * argument (rung 1) and the client's configured binding (rung 2).
 *
 * Contract:
 *   - no binding, no explicit     → {bound:false, source:'interactive'} and NO projectId is
 *                                   imposed. The route's existing behaviour is left exactly
 *                                   as it is (legacy == today).
 *   - no binding, explicit        → {bound:false, source:'explicit', projectId} — the rung-1
 *                                   NORMALIZER: the caller's identifier is
 *                                   canonicalised to a UUID. This is a DELIBERATE, bug-fixing
 *                                   departure from "the unbound path is byte-identical to
 *                                   pre-binding" — see the normalizer note below.
 *   - no binding, explicit that does not exist → THROWS ProjectArgUnresolvedError.
 *   - binding, no explicit        → {bound:true, source:'binding', projectId} — rung 3 is
 *                                   NOT consulted.
 *   - binding + equal explicit    → {bound:true, source:'explicit', projectId}.
 *   - binding + different explicit→ THROWS ProjectBindingMismatchError (names both).
 *   - binding that does not exist → THROWS ProjectBindingUnresolvedError.
 *   - explicit that does not exist while bound → THROWS ProjectBindingTargetUnresolvedError.
 *
 * @param toolName        the resolved tool/op id (gateway ops arrive already resolved)
 * @param args            the validated tool arguments (READ ONLY here — never mutated)
 * @param headerBinding   the raw `X-Mandrel-Project` value the transport read, if any
 */
export async function resolveProjectBinding(
  toolName: string,
  args: Record<string, unknown> | undefined,
  headerBinding?: string
): Promise<ProjectBindingResolution> {
  // BLANK-REFERENCE RULE — FIRST, before the bound/unbound fork, so it holds
  // for every rung, both surfaces, and every project-reference param including the `exempt`
  // ones the ladder itself ignores. A blank reference cannot be resolved by ANY rung, so
  // there is nothing to be gained by deciding which rung would have handled it.
  assertProjectRefsNamed(toolName, args);

  const binding = configuredBinding(headerBinding);

  // ── UNBOUND (today's every client, every human): rung 2 does not exist. Do not touch
  //    rung 1 or rung 3 — not even to validate them — so this path is byte-identical to
  //    the pre-binding product.
  //
  //    Deliberately uses the NON-THROWING scopedProjectParams, and is evaluated BEFORE the
  //    strict projectScopeParam below. A tool that someday declares two project-scope params
  //    is a real ambiguity a BOUND client must be refused on — but it must not start
  //    throwing for the humans and unbound clients that never asked for a binding. This
  //    ordering is what makes "legacy == today" hold for tools that do not exist yet
  //    (a shared assumption another branch changes).
  if (!binding) {
    const candidates = scopedProjectParams(toolName);
    const only = candidates.length === 1 ? candidates[0] : undefined;
    const raw = only ? args?.[only] : undefined;
    const named = typeof raw === 'string' && raw.trim() !== '';
    if (!named || !only) {
      // NO explicit project argument → rung 3, untouched, and NO database round-trip. This is
      // the overwhelmingly common call shape, so the normalizer below costs it nothing.
      return { bound: false, source: 'interactive', scopeParam: only };
    }

    // ── rung-1 NORMALIZER ───────────────────────────────────────────────
    // An explicit project argument is resolved to its CANONICAL UUID here, at the same choke
    // point the binding is enforced at, for BOUND AND UNBOUND CALLERS ALIKE — then
    // materialised into the tool's own scope argument by routeExecutor. Every downstream
    // consumer (the nine per-route resolveProjectId copies, the handlers' own name-aware
    // ensureProjectId, and — the bug — the tag/link edge resolver, which puts the value
    // straight into `AND project_id = $n`) therefore sees a UUID and only a UUID.
    //
    // THE BUG THIS CLOSES. `projectId` was documented as accepting a project NAME, and the
    // WRITE path honoured that (contexts' ensureProjectId resolves name→id), but the EDGE
    // path did not: a name reached SQL verbatim against a `uuid` column, Postgres raised
    // `invalid input syntax for type uuid`, and links.ts's catch-all reported the referent
    // as "could not be resolved". So `context_store(projectId:'riverbend', tags:['task:…'])`
    // stored the record in the right project with ZERO edges and blamed the task.
    //
    // THE PROPERTY, not the instance list: ANY consumer that put the argument into a
    // project-scoped predicate got the raw Postgres cast error, so the set of affected tools
    // was never "the ones we happened to try" — it was "every tool without its own name-aware
    // resolution". Measured on f9d9f00 (2026-07-25), AT LEAST these twelve hard-failed
    // outright on a VALID project name: task_create, task_list, task_details,
    // task_progress_summary, context_search, context_update, decision_record, decision_search,
    // decision_stats, recall_thread, thread_set. Treat that as a floor
    // sampled from 43 scoped params, NOT as the definition — the definition is the property
    // above, and this normalizer is what makes it vacuous. Two resolution rules for one
    // argument; this makes it ONE, at the boundary.
    //
    // WHY HERE AND NOT IN links.ts: normalizing inside the edge resolver would be a THIRD
    // copy of the rule and would fix only the instance. The choke point fixes the class, and
    // composes with the binding ladder above instead of becoming a second source of truth —
    // both rungs resolve through the SAME lookup().
    const requested = await lookup(raw.trim());
    if (!requested) {
      // FAIL LOUD. Silently passing an unresolvable scope through is precisely how this bug
      // stayed invisible (unrecognised must be a loud RED, never a silent pass).
      throw new ProjectArgUnresolvedError(toolName, only, raw.trim());
    }
    return {
      bound: false,
      source: 'explicit',
      projectId: requested.id,
      projectName: requested.name,
      scopeParam: only,
    };
  }

  // ── BOUND from here down. NOW the ambiguity judgement applies (throws if a tool has no
  //    single write target).
  const scopeParam = projectScopeParam(toolName);
  const rawExplicit = scopeParam ? args?.[scopeParam] : undefined;
  const explicit =
    typeof rawExplicit === 'string' && rawExplicit.trim() !== '' ? rawExplicit.trim() : undefined;

  // ── rung 2 must name a REAL project. Unrecognised → loud, never a default.
  const bound = await lookup(binding.identifier);
  if (!bound) {
    throw new ProjectBindingUnresolvedError(binding);
  }

  // ── SCOPE OVERRIDE: the caller passed an all-projects widening flag while bound to ONE
  //    project. THE BINDING WINS (coordinator decision, 2026-07-25, with Reviewer): this is
  //    a READ-widening flag, and narrowing a read to the bound project is the safe outcome —
  //    a bound client seeing less is never a data-safety event, whereas refusing would break
  //    `session_list` for exactly the autonomous clients this feature exists to serve.
  //
  //    It is NOT silent: the ignored flag is carried into the resolution and stamped on the
  //    write audit, so an operator can see that a widening request was narrowed. That is the
  //    part that matters — the failure class we keep killing is the SILENT override, not the
  //    override itself. (A caller-facing notice would have to live in each handler's own
  //    response; recommended as a follow-up rather than reached into from here.)
  const overridden = scopeOverrideParams(toolName).filter((k) => args?.[k] === true);

  // ── No explicit target: the binding wins outright. rung 3 is never consulted.
  if (!explicit) {
    return {
      bound: true,
      source: 'binding',
      projectId: bound.id,
      projectName: bound.name,
      scopeParam,
      bindingOrigin: binding.origin,
      bindingOriginLabel: binding.originLabel,
      overriddenScopeParams: overridden,
    };
  }

  // ── Explicit target present: it may only win if it PROVABLY names the bound project.
  const requested = await lookup(explicit);
  if (!requested) {
    throw new ProjectBindingTargetUnresolvedError(toolName, explicit, {
      id: bound.id,
      name: bound.name,
      originLabel: binding.originLabel,
    });
  }
  if (requested.id !== bound.id) {
    throw new ProjectBindingMismatchError(
      toolName,
      { identifier: explicit, id: requested.id, name: requested.name },
      {
        identifier: binding.identifier,
        id: bound.id,
        name: bound.name,
        originLabel: binding.originLabel,
      }
    );
  }
  return {
    bound: true,
    source: 'explicit',
    projectId: requested.id,
    projectName: requested.name,
    scopeParam,
    bindingOrigin: binding.origin,
    bindingOriginLabel: binding.originLabel,
    overriddenScopeParams: overridden,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The write audit
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The audit line prefix. A STABLE, greppable token so an operator (and the acceptance
 * run) can pull every project-resolution decision out of the server log with one grep.
 */
export const PROJECT_AUDIT_PREFIX = 'project-resolution';

export interface ProjectResolutionAuditEntry {
  /** The tool/op that wrote (or was about to). */
  tool: string;
  /** The project the write is scoped to — the id the report's acceptance asks for. */
  projectId?: string;
  projectName?: string;
  /** Which rung won. */
  source: ProjectResolutionSource;
  /** TRUE when a configured binding was in force for this client. */
  bound: boolean;
  /** Where the binding came from, when bound. */
  bindingOrigin?: string;
  connectionId?: string;
  actor?: string;
  /** All-projects flags the binding narrowed on this call (usually empty). */
  overriddenScopeParams?: string[];
}

/**
 * Emit ONE audit record for a write's project resolution. Includes the project ID —
 * report acceptance line 520 — plus the RUNG that produced it, which is the part that
 * makes a wrong-project write diagnosable after the fact rather than just visible.
 *
 * Best-effort: an audit failure must never break a user's write, but it is logged at
 * WARN so a silently-missing audit is still observable (a past incident — no silent degrade).
 */
export function auditProjectResolution(entry: ProjectResolutionAuditEntry): void {
  try {
    logger.info(
      `${PROJECT_AUDIT_PREFIX} tool=${entry.tool} projectId=${entry.projectId ?? 'none'} ` +
        `project=${entry.projectName ?? 'unknown'} source=${entry.source} bound=${entry.bound}` +
        (entry.bindingOrigin ? ` binding=${entry.bindingOrigin}` : '') +
        (entry.overriddenScopeParams?.length
          ? ` narrowed=${entry.overriddenScopeParams.join(',')}`
          : ''),
      {
        metadata: {
          audit: PROJECT_AUDIT_PREFIX,
          tool: entry.tool,
          projectId: entry.projectId ?? null,
          projectName: entry.projectName ?? null,
          source: entry.source,
          bound: entry.bound,
          bindingOrigin: entry.bindingOrigin ?? null,
          narrowedScopeOverrides: entry.overriddenScopeParams ?? [],
          connectionId: entry.connectionId ?? null,
          actor: entry.actor ?? null,
        },
      }
    );
  } catch (error) {
    logger.warn('project-resolution audit failed to emit', {
      metadata: { tool: entry.tool, error: (error as Error)?.message },
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The CALLER-FACING narrowing notice
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * THE CLASS THIS CLOSES: a result that is SILENTLY SMALLER than the one
 * requested READS AS CLEAN. A bound client that asks for `allProjects:true` is narrowed to
 * its binding — which is correct, the binding is the isolation boundary and a boolean
 * argument must not be able to cross it — but the caller was never told. It cannot tell
 *   "there is nothing"   from   "I was not allowed to look",
 * and for a CORRELATION tool (the entire reason `session_list` exists) that is a confidently
 * wrong conclusion, not a missing feature.
 *
 * SO THE FIX IS HONESTY, NOT SCOPE. Nothing here widens anything. `resolveProjectBinding`
 * already computes the fact — `overriddenScopeParams`, the widening flags the binding
 * ignored — and it was being written only to the WRITE audit. That audit is emitted for
 * `ACTION_TOOLS` members only, and every param the override classifier matches today belongs
 * to a READ tool, so the field was non-empty on none of the calls that reach the audit: the
 * narrowing was invisible to the caller AND to the operator. Deliberately stated as the
 * property rather than as two lists that would drift the moment either set changes; the
 * *executed* form of this claim is the derived-population test in
 * `tests/projectScopeNarrowingNotice.contract.test.ts`. This is the caller's half;
 * routes/index.ts emits the operator's half at the same seam, off the same object.
 *
 * WHY A NOTICE OBJECT AND NOT PROSE AT THE HANDLER. The population is not "session_list",
 * it is "any call the binding narrowed" — a set the override classifier derives from each
 * tool's own schema (PROJECT_SCOPE_OVERRIDE_PATTERN), so a future tool joins it the day it
 * declares such a flag. A notice written into one handler would cover the member that
 * happened to be known; stamped at the choke point every call passes through, it covers the
 * set. `message` is built HERE, once, and both channels carry that same string — a second
 * rendering would be a second copy of the sentence that can drift from the structured facts
 * beside it.
 */

/**
 * The `structuredContent` key the notice rides on. A STABLE name a machine consumer can
 * branch on, so it never has to parse the prose to learn it was narrowed. ABSENT (not
 * `null`, not `false`) on every call that was NOT narrowed — presence IS the signal.
 */
export const PROJECT_SCOPE_NARROWED_KEY = 'projectScopeNarrowed';

/**
 * The log-line prefix for the operator's half. Distinct from PROJECT_AUDIT_PREFIX on
 * purpose: that one is the WRITE audit and an operator greps it to answer "where did this
 * write land". Folding narrowed READS into it would silently change that population.
 */
export const PROJECT_SCOPE_NARROWED_LOG_PREFIX = 'project-scope-narrowed';

/** What a caller is told when its widening request lost to a binding. */
export interface ProjectScopeNarrowedNotice {
  /** The widening flags that were ignored, e.g. `['allProjects']`. Never empty. */
  params: string[];
  /** The project the call was pinned to instead — the whole extent of these results. */
  projectId: string;
  projectName?: string;
  /** Which surface configured the binding, and its human-facing name. */
  bindingOrigin?: ProjectBindingOrigin;
  bindingOriginLabel?: string;
  /** THE ONE rendering of the fact. The text channel carries this exact string. */
  message: string;
}

/**
 * Build the notice for a resolution, or `null` when nothing was narrowed.
 *
 * PURE — no DB, no logging, no response. Every condition is read off the resolution the
 * ladder already returned, so this cannot disagree with the decision it reports on.
 * Requires `bound` AND a non-empty `overriddenScopeParams` AND a resolved `projectId`:
 * an unbound caller is never narrowed (its `allProjects` is honoured untouched) and a
 * narrowing with no project to name is not a fact worth asserting.
 */
export function scopeNarrowingNotice(
  binding: ProjectBindingResolution | undefined
): ProjectScopeNarrowedNotice | null {
  if (!binding?.bound || !binding.projectId) return null;
  const params = binding.overriddenScopeParams;
  if (!params || params.length === 0) return null;

  const label = binding.bindingOriginLabel ?? 'configured project binding';
  const flags = params.map((p) => `\`${p}\``).join(', ');
  const project = binding.projectName
    ? `'${binding.projectName}' (${binding.projectId})`
    : binding.projectId;

  return {
    params: [...params],
    projectId: binding.projectId,
    projectName: binding.projectName,
    bindingOrigin: binding.bindingOrigin,
    bindingOriginLabel: binding.bindingOriginLabel,
    message:
      `⚠️ SCOPE NARROWED — you passed ${flags} to span every project, but this client is ` +
      `BOUND to ${project} via the ${label}. The binding WINS, so these results cover ONLY ` +
      `that project.\n` +
      `❗ A short or EMPTY result here does NOT mean nothing exists elsewhere — it means you ` +
      `were not allowed to look. Do not read it as "there is nothing".\n` +
      `💡 To enumerate across projects, call from a client with NO binding (unset the ` +
      `${PROJECT_BINDING_HEADER} header / the ${PROJECT_BINDING_ENV_VAR} env var).`,
  };
}
