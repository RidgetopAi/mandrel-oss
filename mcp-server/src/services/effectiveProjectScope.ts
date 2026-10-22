/**
 * EFFECTIVE PROJECT SCOPE — the ambient half of the project-precedence ladder.
 * governed by an earlier decision ("MCP binding is AUTHORITATIVE for
 * project scope — for what queries USE *and* for what every tool REPORTS").
 *
 * =============================================================================
 * WHY THIS MODULE EXISTS (the bug it closes)
 * =============================================================================
 * `services/projectBinding.ts` decides WHICH RUNG WINS. `routes/index.ts` then MATERIALISED
 * that answer by writing the resolved project id into the tool's OWN project argument:
 *
 *     if (binding.projectId && binding.scopeParam) args[binding.scopeParam] = binding.projectId;
 *                              ^^^^^^^^^^^^^^^^^^
 *
 * so materialisation was only ever AS WIDE AS THE SCHEMA SURFACE. A tool that declares no
 * project parameter has nothing to inject into — the ladder's answer was computed and then
 * DISCARDED, and the handler fell through to rung 3 (`getCurrentProjectId(connectionId)`).
 * Six tools fell through that hole (`project_current`, `thread_current`, `thread_clear`,
 * `session_get`, `project_list`, `project_delete`), plus the connect-time `instructions`
 * string, which is the EARLIEST lie — no tool call can precede it.
 *
 * Live symptom (Amp evaluator, 2026-07-26, ONE connection, `X-Mandrel-Project` set):
 * `project.current` → "daily log" while `session.list`'s default scope → "amp-eval-3".
 *
 * =============================================================================
 * THE FIX: move the choke point off the SCHEMA and onto the ACCESSOR
 * =============================================================================
 * "Did this tool declare a project param" is not a choke point — it is a property of the
 * tool's schema that happens to correlate with project resolution. THE choke point is the
 * pair of accessors every project resolution in the tree actually passes through:
 * `projectHandler.getCurrentProjectId` / `getCurrentProject`.
 *
 * So the binding is made available AMBIENTLY, for the duration of a call, and those two
 * accessors consult it. A tool that resolves a project WHILE DECLARING NONE is then covered
 * by construction — which is precisely the population the old guard excluded (see
 * `src/tests/projectScopeChokePoint.contract.test.ts`).
 *
 * =============================================================================
 * WHY AsyncLocalStorage AND NOT A PER-CONNECTION REGISTRY
 * =============================================================================
 * The obvious alternative — a `Map<connectionId, rawHeader>` populated at the transport —
 * needs an eviction policy, and EVERY eviction policy has the same failure mode: an evicted
 * entry silently downgrades a BOUND client back to rung 3, i.e. it re-creates this exact bug
 * on a timer. ALS is scoped to the call, cannot leak between connections, cannot go stale,
 * and needs no eviction. The store is established at exactly two places (both named in the
 * guard): `routeExecutor` (every tool call on BOTH surfaces) and the transport's connect-time
 * instructions resolution (the one project resolution that happens before any tool call).
 *
 * OUTSIDE any established scope (background jobs, the tick, direct handler use in tests) the
 * store is absent and only the PROCESS-WIDE `MANDREL_PROJECT_ID` env binding applies — which
 * is the same rule `resolveProjectBinding` already follows, because both call the SAME
 * `configuredBinding()`. One ladder, one source; this module adds no second rule.
 *
 * =============================================================================
 * NOT A REPLACEMENT FOR MATERIALISATION
 * =============================================================================
 * `routes/index.ts` still materialises the resolved id into the tool's scope argument, and
 * must: that is what pins the ~43 tools that DO declare one, including the rung-1 normalizer
 * for unbound callers. This module covers the complement — everything that
 * resolves a project without declaring one. The two agree because they resolve the same
 * binding through the same `configuredBinding()`; the contract test asserts they agree by
 * cross-checking two REAL tools against each other under a real binding, rather than
 * asserting the ladder in isolation.
 *
 * DEFAULT = TODAY. With no header and no env there is no binding, `boundProjectInForce()`
 * returns null on its first (allocation-free) line, and every accessor behaves byte-for-byte
 * as it did before this task.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../config/database.js';
import { isValidUuid } from '../utils/uuid.js';
import { logger } from '../utils/logger.js';
import {
  configuredBinding,
  type ConfiguredBinding,
} from '../config/projectBindingConfig.js';
import { noteToolActivity } from './session/activityTouch.js';

/**
 * What a call carries about its own project scope. Deliberately tiny: the RAW declared
 * binding (never a resolved id — resolution belongs to one place) plus the connection it
 * arrived on, which is only used for diagnostics.
 */
export interface ProjectScopeContext {
  /** The dispatch connection id this call is running under, when known. */
  connectionId?: string;
  /** The RAW `X-Mandrel-Project` value the transport read off this request, if any. */
  projectBinding?: string;
  /**
   * The DERIVED actor for this call (T4). Originally diagnostics only; as of
   * an earlier task it is ALSO the flag-gated resolution input for the actor-keyed
   * current-project rung: with MANDREL_ACTOR_PROJECT_STATE_ENABLED on,
   * `projectHandler.getCurrentProjectId` consults `actor_project_defaults` keyed by this
   * value (after the binding, before the connection slot), and `switchProject` persists it.
   * With the flag off (the shipped default) it is exactly the T4 diagnostic it always was.
   *
   * It is here rather than plumbed through `switchProject → setCurrentProject` because the
   * ONE line that records a scope move (`handlers/project.ts:setCurrentProject`) is reached
   * from two paths with different signatures, and the log line is what let us attribute
   * both prod captures — it named the slot key and the manual flag, but not WHO. Threading
   * a parameter through both paths to serve a log line is how a signature acquires a
   * diagnostic argument forever; the ambient scope already spans exactly the right lifetime.
   */
  actor?: string;
  /**
   * THE DECLARED AGENT-LOOP IDENTITY for this call (`X-Loop-ID`). Carried
   * ambiently for exactly the same reason `actor` is: the ONE consumer is the position
   * keying choke point (`handlers/project.ts: resolvePositionKeys`), which is reached from
   * four call sites whose signatures take a connection id and nothing else. Threading a
   * fifth parameter through all of them to serve one choke point is how a signature
   * acquires a permanent passenger; the ambient scope already spans exactly this call.
   */
  loopId?: string;
}

const scopeStore = new AsyncLocalStorage<ProjectScopeContext>();

/**
 * Establish the project scope for everything `fn` does, including everything it awaits.
 * The ONLY way to populate the store — there is no setter, so a scope cannot outlive the
 * call that created it.
 */
export function runWithProjectScope<T>(ctx: ProjectScopeContext, fn: () => T): T {
  return scopeStore.run(ctx, () => {
    // SESSION LIVENESS (bug 2). This wrap is the ONE thing every tool call
    // passes through on BOTH surfaces — read and write alike — which is exactly why the
    // read-path activity touch hangs here and not on a write-side tracker. See
    // services/session/activityTouch.ts for the full rationale, the throttle, and the
    // three things it deliberately will not do (create a session, change a status, or
    // fail a call). Synchronous, RAM-only, and dispatched before `fn` so it cannot add
    // latency to the call or perturb its result.
    //
    // BEFORE `fn`, not after: the only call for which the session is not yet resolvable
    // is a connection's FIRST action, and that call is the one that CREATES the session
    // row — whose `last_activity_at` is fresh by construction. So there is no gap, and
    // running first avoids attaching a handler to the caller's promise.
    noteToolActivity(ctx.connectionId);
    return fn();
  });
}

/** The scope context of the call currently running, if one was established. */
export function currentProjectScope(): ProjectScopeContext | undefined {
  return scopeStore.getStore();
}

/**
 * The CONFIGURED binding in force for the call currently running: the ambient
 * `X-Mandrel-Project` header when one was declared, else the process-wide
 * `MANDREL_PROJECT_ID` env var. The header>env order is NOT re-stated here — it is read out
 * of `configuredBinding()`, the same function `resolveProjectBinding` uses, so the two can
 * never drift (a past incident #5: a rule written in two places is a rule two programs merely
 * agree on today).
 *
 * PURE + synchronous + no DB. Returns undefined when nothing is bound (the default).
 */
export function bindingInForce(): ConfiguredBinding | undefined {
  return configuredBinding(scopeStore.getStore()?.projectBinding);
}

/** A binding resolved against the projects table. */
export interface BoundProject {
  id: string;
  name: string;
  /** Human-facing name of the surface the binding came from, for messages/echoes. */
  originLabel: string;
  origin: ConfiguredBinding['origin'];
}

/**
 * Resolve the binding in force to a real project, or null when nothing is bound.
 *
 * DELIBERATELY DOES NOT GO THROUGH `projectHandler.getProject()`. That method computes
 * `isActive` by calling `getCurrentProjectId()`, which is the very accessor that calls THIS
 * function — routing through it would be unbounded recursion. A direct, single-column lookup
 * is also the honest shape: resolving a binding is not "fetching a project record".
 *
 * NEVER THROWS. A binding that names nothing already fails LOUDLY at the route gate
 * (`ProjectBindingUnresolvedError`, `services/projectBinding.ts`) before any handler runs, so
 * throwing again here would only turn best-effort callers (the connect-time instructions
 * string, the event logger) into hard failures for a condition their caller has already
 * rejected. Unresolvable → a WARN and null, i.e. fall through to rung 3 — visible in the log,
 * never silent.
 */
export async function boundProjectInForce(): Promise<BoundProject | null> {
  const binding = bindingInForce();
  if (!binding) return null;

  try {
    // Same identifier rule as projectHandler.getProject: a UUID matches `id`, anything else
    // matches `name`. Parameterised; never interpolated.
    const field = isValidUuid(binding.identifier) ? 'id' : 'name';
    const result = await db.query(
      `SELECT id, name FROM projects WHERE ${field} = $1 LIMIT 1`,
      [binding.identifier]
    );
    if (result.rows.length === 0) {
      logger.warn(
        `project-scope: binding '${binding.identifier}' (${binding.originLabel}) resolves to no ` +
          `project — falling through to the interactive project for this connection`
      );
      return null;
    }
    return {
      id: result.rows[0].id,
      name: result.rows[0].name,
      originLabel: binding.originLabel,
      origin: binding.origin,
    };
  } catch (error) {
    logger.warn(
      `project-scope: failed to resolve binding '${binding.identifier}' — falling through to the ` +
        `interactive project`,
      error as Error
    );
    return null;
  }
}
