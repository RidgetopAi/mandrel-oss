/**
 * UNIDENTIFIED-CALLER GUARDS.
 *
 * =============================================================================
 * THE DEFECT
 * =============================================================================
 * "Current project" lives in a process-global `Map<connectionId, SessionState>`
 * (handlers/project.ts). Scope is correctly ISOLATED for any caller that presents a
 * connection identity. The defect is what happens to a caller that presents NONE: the
 * transport collapses every one of them onto ONE shared literal (`http-default`,
 * server/healthServer.ts), and a second literal (`'default-session'`, 16 downstream
 * sites) catches anything that arrives with the id absent. So every header-less caller —
 * ours and every customer's — shares ONE sticky, last-writer-wins project slot, and a
 * `project_switch` from any of them silently moves scope for all of them, with no error,
 * no warning, and nothing in the record afterwards that says it happened.
 *
 * Measured on prod (2026-07-27/28): ~13 header-less manual switches between 21:06 and
 * 01:58 cycled the shared slot riverbend→personal→acme. Two real captures landed in a
 * project their author had not chosen. This is a continuous flip-flop, not two incidents.
 *
 * =============================================================================
 * WHAT THESE GUARDS DO — AND WHAT THEY DELIBERATELY DO NOT
 * =============================================================================
 *   G1  an unidentified caller may not PERSIST scope. `project_switch` (effect
 *       'scope-switch') is REJECTED: it is the operation that moves the shared slot for
 *       everyone else. There is no version of that call that is safe to serve.
 *   G2  an unidentified caller's AMBIENT write must carry an explicit project. A write
 *       (effect 'write') is REJECTED unless the project-precedence ladder already produced
 *       a project for it — i.e. unless rung 1 (an explicit project argument) or rung 2
 *       (an `X-Mandrel-Project` / `MANDREL_PROJECT_ID` binding) answered. Without one of
 *       those the call would land wherever the shared slot happens to point.
 *   G3  READS ARE NOT TOUCHED, on purpose. Re-keying reads creates a fresh empty slot per
 *       caller, and `initializeSession` then auto-selects primary → cached → bootstrap →
 *       `projects[0] ORDER BY updated_at DESC`. 5 of 7 tenants have NO primary project, so
 *       for them that last rung is a non-deterministic, drifting choice. "Fix" the reads
 *       and you break five tenants to close a write leak. Out of scope, deliberately.
 *       KNOWN AND ACCEPTED, not overlooked: five read-classified ops do persist something
 *       via a SHARED server side effect — context_search / decision_search / smart_search /
 *       get_recommendations write a best-effort `analytics_events` telemetry row attributed
 *       to the ambient project, and session_status re-attaches its own session row. Neither
 *       is the op's product; the reasoning and the enumeration are in config/opRegistry.ts
 *       (E1/E2) and pinned in tests/opEffectClassification.contract.test.ts. Calling them
 *       'write' would make G2 reject a header-less `context_search` — that is a READ
 *       behaviour change, i.e. exactly what G3 refuses to make here.
 *
 * =============================================================================
 * WHO G2 ACTUALLY REJECTS — the population, measured op by op, not inferred
 * =============================================================================
 * Enumerated across every `effect:'write'` op by asking `projectScopeParam` and
 * `explicitProjectTargetParams` (the product's own resolvers), not by reading them.
 * Re-derived 2026-07-28 after a persisting scan-status op was corrected read→write (the reviewer B1);
 * it landed in the first bucket, so the guard's shape did not change, only its size:
 *
 *   25 ops declare a scoped `projectId`/`project` param  → an unidentified caller complies
 *      by passing it. context_*, decision_*, task_*, link/unlink, thread_set,
 *      session_start, branch_assign, branch_unassign.
 *      (23 → 25 with P3, the two scan ops that once sat in this bucket have since been removed, so re-count before relying on the number. This number is prose and prose cannot be gated; the
 *      EXECUTED form of the same population is projectBindingRouteGate.contract.test.ts's
 *      SWEPT_SCOPE_TOOL_COUNT, which is derived from `projectScopeParam` and goes RED when it
 *      moves — that guard is what caught this line being stale, and it counts a wider set,
 *      reads AND writes, so the two numbers are not meant to match.)
 *    2 ops declare an EXEMPT `project` param (project_update, project_delete) → the target
 *      is named by handle; `binding.projectId` stays unset for them by design, so the guard
 *      ALSO accepts an explicit exempt target. Without that second derivation this guard
 *      would have broken the Command UI's Delete Project with no per-call remedy.
 *    4 ops declare NO project param at all — `session_end`, `session_pin`, `project_create`,
 *      `thread_clear`. An unidentified caller CANNOT satisfy G2 per-call on these; the only
 *      remedy is a header (`X-Connection-ID` or `X-Mandrel-Project`). That is CORRECT for
 *      `thread_clear` (it clears the anchor of whatever project the shared slot points at)
 *      and for `session_end`/`session_pin` (they stamp the ambient project onto a record),
 *      and it is OVER-BROAD for `project_create`, which creates a NEW project and consults
 *      no ambient scope. `project_create` is knowingly over-covered rather than exempted:
 *      the cost is one header on a call no first-party caller makes header-less today
 *      (the Command backend does not proxy it — its whole callTool set was enumerated), and
 *      the failure is LOUD with the remedy in the message.
 *
 * NOT A RE-KEY. Both guards leave `connectionId` exactly as it is (`http-default` still
 * arrives as `http-default`) and leave the Map untouched. The permanent fix — actor-keyed
 * current-project, DB-persisted, and the deletion of the Map and both literals — is Mandrel
 * which explicitly says "do NOT patch the fallback
 * string." Nothing here patches it: these guards do not change WHERE an unidentified call
 * resolves, they refuse the two operations for which resolving there is wrong.
 *
 * =============================================================================
 * WHY THE MARKER AND NOT A STRING COMPARISON
 * =============================================================================
 * The obvious implementation — `if (connectionId === 'http-default')` — is wrong twice
 * over. It is a literal that a second transport can miss, and it CANNOT distinguish "the
 * caller sent no identity" from "the caller explicitly named itself http-default", because
 * healthServer collapses absent into the literal BEFORE dispatch. Passing `undefined`
 * instead does not help either: 16 downstream sites substitute the SECOND shared literal
 * `'default-session'`, so the information is destroyed a second time. So the transport
 * carries an explicit `identified` marker on RouteContext, and both guards key off THAT.
 * A guard that string-matches either literal would have to be written twice and would be
 * wrong the day a third literal appears.
 *
 * =============================================================================
 * POSTURE
 * =============================================================================
 * config/callerIdentityConfig.ts owns the mode (off | shadow | enforce) and the polarity:
 * ABSENT MEANS ENFORCE. Read that file before changing anything here.
 */

import { logger } from '../utils/logger.js';
import { monitoring } from '../utils/monitoring.js';
import { opEffect } from '../config/opRegistry.js';
import {
  CALLER_IDENTITY_CONFIG,
  PROJECT_SCOPE_GUARD_ENV,
  type ProjectScopeGuardMode,
} from '../config/callerIdentityConfig.js';
import { MandrelClassifiedError } from '../utils/mcpErrorStatus.js';

/** Stable machine codes, mirroring PROJECT_BINDING_ERROR_CODES' contract. */
export const CALLER_IDENTITY_ERROR_CODES = Object.freeze({
  /** G1 — a header-less caller tried to persist the shared interactive project slot. */
  SCOPE_SWITCH_UNIDENTIFIED: 'PROJECT_SCOPE_SWITCH_UNIDENTIFIED',
  /** G2 — a header-less caller tried an ambient write with no explicit project. */
  AMBIENT_WRITE_UNIDENTIFIED: 'PROJECT_AMBIENT_WRITE_UNIDENTIFIED',
} as const);

/** Which guard produced a rejection — the label on the shadow counter. */
export type CallerIdentityGuard = 'G1-scope-switch' | 'G2-ambient-write';

/**
 * The typed error. Same shape as `ProjectBindingError` (services/projectBinding.ts): the
 * message is PREFIXED with the machine code and carries its own 💡 remedy, because
 * `formatMcpError` → `actionableErrorText` appends a generic "re-check your parameters"
 * hint to any message that does NOT already carry one — which would be the wrong advice
 * here. The remedy is a HEADER, not a parameter.
 */
export class CallerIdentityError extends MandrelClassifiedError {
  /**
   * 403 FORBIDDEN, fixed for both subclasses, and the choice is load-bearing
   * in two directions:
   *
   *   NOT 200, which is what these returned before this change — measured at the real HTTP
   *   surface. A guard that refuses a write and then reports OK to the transport is invisible
   *   to every status-code consumer in the path; our 4xx rate showed zero identity rejections
   *   while the guard was enforcing on all 8 instances.
   *
   *   NOT 401, which is the tempting one and would be wrong. 401 means "authenticate, then
   *   retry", and it makes a client re-present or refresh credentials. This caller IS
   *   authenticated — it passed the bearer gate to get here. What it failed to do is IDENTIFY
   *   WHICH CONNECTION it is, which no credential can supply. 401 would send an agent SDK
   *   into a token-refresh loop that cannot terminate. 403 is the accurate one: understood,
   *   authenticated, and refused on policy. The remedy is a header, and it is in the message.
   */
  constructor(
    message: string,
    readonly code: string,
    readonly guard: CallerIdentityGuard
  ) {
    super(`[${code}] ${message}`, 403);
    this.name = 'CallerIdentityError';
  }
}

/** The two remedies, written once — both errors offer the same escape routes. */
const REMEDY =
  `\n\n💡 Either identify this connection — send an \`X-Connection-ID: <a stable id you ` +
  `choose>\` header, which gives you your OWN project slot — or state the project on the ` +
  `call itself: pass \`projectId\` per call, or send \`X-Mandrel-Project: <project>\` to ` +
  `bind this client to one project.`;

export class ScopeSwitchUnidentifiedError extends CallerIdentityError {
  constructor(readonly toolName: string) {
    super(
      `'${toolName}' from a caller that presented no connection identity would move the ` +
        `SHARED project slot that every other header-less caller reads — including other ` +
        `agents and other users. Refusing: an unidentified caller may not persist project ` +
        `scope.` +
        REMEDY,
      CALLER_IDENTITY_ERROR_CODES.SCOPE_SWITCH_UNIDENTIFIED,
      'G1-scope-switch'
    );
    this.name = 'ScopeSwitchUnidentifiedError';
  }
}

export class AmbientWriteUnidentifiedError extends CallerIdentityError {
  constructor(readonly toolName: string) {
    super(
      `'${toolName}' writes, and this caller presented no connection identity AND named no ` +
        `project — so the write would land in whatever project the SHARED slot happens to ` +
        `point at right now, which any other header-less caller can move at any time. ` +
        `Refusing to write to an ambient scope no one owns.` +
        REMEDY,
      CALLER_IDENTITY_ERROR_CODES.AMBIENT_WRITE_UNIDENTIFIED,
      'G2-ambient-write'
    );
    this.name = 'AmbientWriteUnidentifiedError';
  }
}

/** What the guards need to know about the call. Deliberately tiny and DB-free. */
export interface CallerIdentityGuardInput {
  toolName: string;
  /**
   * The transport's explicit marker. `false` = the transport saw NO connection identity
   * and substituted a shared literal. Anything else (true, or absent for an in-process
   * caller that is not a multi-tenant transport) is not the population these guards defend.
   */
  identified?: boolean;
  /**
   * Did the project-precedence ladder already produce a project for this call — i.e. did
   * rung 1 (explicit argument) or rung 2 (binding) answer? Passed in rather than recomputed
   * so there is exactly ONE resolution per call and the guard cannot disagree with the
   * resolution the route then uses.
   */
  hasExplicitProject: boolean;
}

/**
 * THE PURE DECISION. Returns the Error to throw, or null to proceed. No DB, no logging, no
 * config read — so it is unit-testable against every combination, and so the mode handling
 * below is the only thing that decides whether a rejection is ACTED on.
 *
 * Exported because a guard whose decision can only be observed through its own enforcement
 * path cannot be tested for the shadow case, which is precisely the case that has to be
 * right before a flip.
 */
export function callerIdentityRejection(input: CallerIdentityGuardInput): CallerIdentityError | null {
  // ONLY an EXPLICIT `false` is the unidentified population. `undefined` means the caller
  // is not a transport that reads request identity at all (an in-process call, a test, a
  // background job) — those never shared the slot with a customer, and treating them as
  // unidentified would reject the tick's own writes. Transports do not get this latitude:
  // `identified` is REQUIRED on the transport-facing context type, so a new transport that
  // fails to decide does not compile (see routes/index.ts TransportRouteContext).
  if (input.identified !== false) return null;

  const effect = opEffect(input.toolName);

  // G1 — scope persistence. Rejected regardless of any explicit project argument: the harm
  // is not where THIS call lands, it is that the call moves the slot everyone else reads.
  if (effect === 'scope-switch') return new ScopeSwitchUnidentifiedError(input.toolName);

  // G2 — ambient writes. An explicit project (rung 1) or a binding (rung 2) makes the call
  // self-describing, so the shared slot is never consulted and there is nothing to defend.
  if (effect === 'write' && !input.hasExplicitProject) {
    return new AmbientWriteUnidentifiedError(input.toolName);
  }

  return null;
}

/**
 * THE ENFORCEMENT SEAM — called from the routeExecutor choke point, which every tool call
 * on BOTH surfaces (flat `/mcp/tools/*` and the gateway dispatcher) passes through.
 *
 * THROWS in 'enforce'. In 'shadow' it computes the same rejection, LOGS it and bumps
 * `project_scope_guard_shadow{guard,tool}` — so the population a flip would break is
 * measurable BEFORE the flip — and then returns, acting exactly as today. In 'off' the
 * decision is not even computed.
 */
export function enforceCallerIdentity(input: CallerIdentityGuardInput): void {
  const mode: ProjectScopeGuardMode = CALLER_IDENTITY_CONFIG.unidentifiedGuardMode;
  if (mode === 'off') return;

  const rejection = callerIdentityRejection(input);
  if (!rejection) return;

  if (mode === 'shadow') {
    monitoring.incrementCounter('project_scope_guard_shadow', {
      guard: rejection.guard,
      tool: input.toolName,
    });
    logger.warn(
      `👁️  [project-scope-guard SHADOW] would reject '${input.toolName}' (${rejection.guard}) — ` +
        `caller presented no connection identity. Acting as today. Set ` +
        `${PROJECT_SCOPE_GUARD_ENV}=enforce (or REMOVE it — absent means enforce) to make ` +
        `this a rejection.`
    );
    return;
  }

  monitoring.incrementCounter('project_scope_guard_rejected', {
    guard: rejection.guard,
    tool: input.toolName,
  });
  logger.warn(
    `🚫 [project-scope-guard] rejected '${input.toolName}' (${rejection.guard}) — caller ` +
      `presented no connection identity`
  );
  throw rejection;
}
