/**
 * PROJECT-VISIBILITY resolver — the DB/handler-facing half of the
 * project-echo feature. Config/formatting live in config/projectEchoConfig.ts (pure); this
 * module resolves the project NAME + whether the target was DEFAULTED, then renders the
 * one-line write echo (FIX #1) and the connect-time instructions project name (FIX #2).
 *
 * ROBUSTNESS: every export here is best-effort and NEVER throws — a resolution hiccup must
 * not break a write or an initialize. On any error the write-echo degrades to '' (append
 * nothing) and the instructions degrade to the STATIC (project-agnostic) form.
 */

import { projectHandler } from '../handlers/project.js';
import { boundProjectInForce } from '../services/effectiveProjectScope.js';
import { logger } from '../utils/logger.js';
import {
  PROJECT_ECHO_ENABLED,
  formatWriteEcho,
  formatInstructions,
  toId8,
} from '../config/projectEchoConfig.js';

/**
 * Build the FIX #1 write-echo line for a resolved write.
 *
 * @param projectId  the RESOLVED target project id the write landed in (full UUID).
 * @param sessionId  the connection-scoped session key (context.connectionId or a default).
 * @param explicit   TRUE when the caller passed an explicit `projectId` arg to the tool —
 *                    an explicitly-named target is NEVER "defaulted" (they said where).
 *                    FALSE/omitted → the target came from session resolution, so it is a
 *                    DEFAULT unless the session was manually switched (manualOverride).
 * @returns a single line to append to the success payload, or '' (append nothing) when the
 *          feature is disabled, the projectId is missing, or resolution failed.
 */
export async function buildWriteEcho(
  projectId: string | undefined,
  sessionId: string,
  explicit: boolean = false
): Promise<string> {
  if (!PROJECT_ECHO_ENABLED || !projectId) return '';
  try {
    const project = await projectHandler.getProject(projectId);
    // Name resolution failed (project vanished mid-op) — degrade gracefully to the id8.
    const name = project?.name ?? projectId;

    // WHY THE BINDING IS CONSULTED FIRST.
    //
    // `defaulted` is computed from `getSessionInfo().manualOverride`, which a BINDING never
    // sets — a binding deliberately does not touch rung 3. So on any path where `explicit` is
    // false, a bound client's write would be labelled "⚠️ default project … project_switch if
    // this is wrong": a surface telling a bound client its explicit binding was a default, and
    // pointing it at a call that is REJECTED while bound.
    //
    // MEASURED, so this is not a hypothetical: today every write tool that echoes
    // (context_store / task_create / decision_record) happens to declare a `projectId` param,
    // so routes/index.ts MATERIALISES the bound id into it and the route passes
    // `args.projectId != null` — i.e. `explicit` is true and the bad label is not reached. The
    // echo is therefore correct today ONLY because of a coincidence in a different module:
    // remove the param from one tool, or narrow materialisation, and this silently flips. That
    // is the shape this whole task exists to kill, so the echo is anchored on the
    // effective scope itself rather than on what some other module happened to inject.
    let defaulted: boolean;
    let boundOriginLabel: string | undefined;
    const bound = await boundProjectInForce();
    if (bound && bound.id === projectId) {
      defaulted = false;
      boundOriginLabel = bound.originLabel;
    } else if (explicit) {
      // An explicitly-named projectId arg is a deliberate target (never defaulted).
      defaulted = false;
    } else {
      // The session's resolved project — a default UNLESS manually switched.
      const info = projectHandler.getSessionInfo(sessionId);
      defaulted = info.manualOverride !== true;
    }

    // A binding in force whose project is NOT where the write landed is a contradiction the
    // route gate is supposed to have already rejected (ProjectBindingMismatchError). If it
    // ever happens, it must not be papered over by an echo that reads fine.
    if (bound && bound.id !== projectId) {
      logger.warn(
        `project-echo: write landed in ${projectId.substring(0, 8)}… while the call was bound ` +
          `to ${bound.name} (${bound.id.substring(0, 8)}…, ${bound.originLabel}) — the echo is ` +
          `reporting where the row actually went`
      );
    }

    return formatWriteEcho(name, toId8(projectId), defaulted, boundOriginLabel);
  } catch (error) {
    logger.warn(
      `project-echo: failed to build write echo for ${projectId?.substring(0, 8)}… — appending nothing`,
      error as Error
    );
    return '';
  }
}

/**
 * Resolve the ACTIVE project NAME for the connect-time initialize instructions (FIX #2),
 * then render the instructions string. DYNAMIC when a name resolves, STATIC otherwise.
 *
 * `connectionId` is the dispatch key the transport will use for tool calls (prefer the
 * stable X-Connection-ID). When it is undefined (client sent no connection id, so tools
 * dispatch under an as-yet-unknown ephemeral session id) we cannot bind a per-connection
 * project → STATIC. Best-effort + never throws (STATIC on any error).
 */
export async function resolveInstructions(connectionId: string | undefined): Promise<string> {
  try {
    // A BOUND client is answered from the binding, WITHOUT initializeSession. Two reasons,
    // both from     //
    //  1. THIS STRING IS THE EARLIEST LIE. It is emitted at `initialize`, before any tool
    //     call can run, and it told a bound client "Active Mandrel project: daily log.
    //     Mandrel scopes all writes to this ACTIVE project" while its writes went to the
    //     bound project. The comment this replaces claimed the string exists "so the connect
    //     hint matches where the first write will land" — false for every bound client.
    //  2. NO SIDE EFFECT. `initializeSession` AUTO-SELECTS `metadata.is_primary` and WRITES
    //     it into the connection's rung-3 state, so merely rendering the connect hint used to
    //     PIN the wrong project onto a fresh bound connection. A binding must never mutate
    //     rung 3.
    //
    // Note this path resolves the binding WITHOUT a connectionId too (an env binding is
    // process-wide), which is why the bound branch is above the connectionId guard: a bound
    // client that sends no X-Connection-ID still gets a truthful, project-naming hint instead
    // of the static one.
    const bound = await boundProjectInForce();
    // The bound form also names the SURFACE that bound it and drops the "use project_switch
    // to change" advice, which is rejected while bound (see formatInstructions).
    if (bound) return formatInstructions(bound.name, bound.originLabel);

    if (!connectionId) return formatInstructions(undefined);
    // UNBOUND (every human, every client without a binding) — byte-identical to before.
    // Resolve the project this connection's writes WOULD target (the default/primary, or a
    // previously-switched project if this connection already switched). Mirrors the route's
    // resolveProjectId so the connect hint matches where the first write will land.
    await projectHandler.initializeSession(connectionId);
    // PROJECT-SCOPE: effective — the hint's whole claim is "this is where your writes land",
    // which is the effective scope by definition. (The bound case short-circuits above; this
    // reaches rung 3, and the two agree because both consult the same binding.)
    const project = await projectHandler.getCurrentProject(connectionId);
    return formatInstructions(project?.name ?? undefined);
  } catch (error) {
    logger.warn('project-echo: failed to resolve dynamic instructions — using static', error as Error);
    return formatInstructions(undefined);
  }
}
