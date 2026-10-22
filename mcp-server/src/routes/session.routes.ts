/**
 * Session Lifecycle Routes (session-rework SR-2)
 *
 * Re-introduces EXPLICIT, user-controlled session lifecycle as MCP tools — the
 * capability the old "Phase 6" removed when it deleted the session MCP tools and
 * left sessions fully auto-managed. The operator's current direction: "the user can start
 * or stop a session whenever they choose."
 *
 * These tools are thin ORCHESTRATION over the SR-1 per-connection model. They add no
 * new persistence logic and contain NO raw SQL — every read/write goes through the
 * existing SessionTracker façade / SessionLifecycleService and the existing
 * SessionManagementHandler (reused, not rebuilt). The connection identity is the SAME
 * stable X-Connection-ID the route layer already threads into every other tool
 * (context?.connectionId), so "the current session" here means exactly the one
 * getActiveSession(connectionId) resolves — honoring SR-1's one-active-per-connection
 * invariant (the partial unique index + app guard).
 *
 *   session_start — finalize this connection's current session (if any) via the full
 *                   endSession() path, then OPEN a new one (optional title/goal/project).
 *   session_end   — finalize this connection's current session via endSession()
 *                   (productivity/flush/analytics); no-op-safe when none is active.
 *                   The next ACTION tool auto-starts a fresh session lazily.
 *   session_status— read-only summary of this connection's current active session.
 *
 * CONNECTION-SCOPED, NEVER GLOBAL: unlike the legacy dashboard readers (which opt into
 * allowGlobalFallback), these user-facing tools resolve strictly within the caller's
 * connection. A user who ends their session must not accidentally finalize another
 * connection's work.
 */

import { SessionTracker } from '../services/session/SessionTracker.js';
import { SessionManagementHandler } from '../handlers/sessionAnalytics/management/SessionManagementHandler.js';
import { SessionRepo, SessionPinRepo } from '../services/session/infra/db/index.js';
import {
  buildSessionIdentity,
  renderSessionIdentity,
  renderSessionIdentityLine,
  type SessionIdentity,
} from '../services/session/domain/identity/sessionIdentity.js';
import { formatRecordRef } from '../config/commandUrlConfig.js';
import { SESSION_IDENTITY_CONFIG } from '../config/sessionIdentityConfig.js';
import { normalizeActor } from '../config/actorRegistry.js';
// The caller echo now lives in services/callerEcho.ts so mandrel_ping shares this exact
// derivation rather than growing a second one.
import { callerEcho, renderCallerEcho } from '../services/callerEcho.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { projectHandler } from '../handlers/project.js';
import { resolveEntityId, AmbiguousIdError, IdNotFoundError, ambiguousIdMessage } from '../utils/idResolver.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { logger } from '../utils/logger.js';

/**
 * Resolve a project NAME-**or-ID** to its canonical {id,name}. Returns the resolved project,
 * or a structured "not found" with the list of available names (mirrors
 * SessionManagementHandler.createNewSession). No raw SQL here — delegates to
 * projectHandler.listProjects.
 *
 * ID-FIRST (the reviewer BLOCKER 1). This helper's own doc comment and the
 * `session_start.project` schema BOTH described it as a "NAME-or-id lookup" — but the
 * implementation matched `p.name` ONLY and never looked at `p.id`. The claim was in two
 * places; the behaviour was in neither (a past incident — a comment is a claim, not a fact).
 * It went unnoticed while every caller happened to pass a name.
 *
 * It stopped being harmless the moment the project-binding gate began materialising the
 * canonical UUID into `args.project` for a bound client: a UUID this function structurally
 * could not match, so `session_start` failed for every bound client. Fixing the CLASS here
 * — rather than special-casing session_start — also covers every future
 * `resolveProject`-backed tool (e.g. `session_list`) for free.
 *
 * ORDER MATTERS, and it is deny-the-guess ordering:
 *   1. exact ID          — canonical, unambiguous, and what the binding gate injects.
 *   2. exact NAME        — the human path, unchanged.
 *   3. substring NAME    — the pre-existing convenience match, unchanged, and LAST so it can
 *                          never shadow an exact id/name hit.
 */
async function resolveProject(
  identifier: string
): Promise<{ ok: true; id: string; name: string } | { ok: false; message: string }> {
  const projects = await projectHandler.listProjects();
  if (!projects || !Array.isArray(projects)) {
    return { ok: false, message: 'Project service error: invalid response from project service' };
  }
  const lower = identifier.toLowerCase();
  const project =
    // 1. canonical id (case-insensitive: a UUID is hex, callers may upper-case it)
    projects.find((p) => p.id.toLowerCase() === lower) ??
    // 2. exact name (the human path)
    projects.find((p) => p.name.toLowerCase() === lower) ??
    // 3. substring name (pre-existing convenience — LAST, never shadows an exact match)
    projects.find((p) => p.name.toLowerCase().includes(lower));
  if (!project) {
    const available = projects.map((p) => p.name).join(', ');
    return { ok: false, message: `Project '${identifier}' not found. Available projects: ${available}` };
  }
  return { ok: true, id: project.id, name: project.name };
}

/**
 * Build the read-only summary for a session id by REUSING the existing
 * SessionManagementHandler.getSessionDetailsWithMeta (which already assembles the rich
 * record the Session View consumes — title, session_goal, project, counts, duration).
 * We pass the explicit session id (connection-resolved by the caller) so this never
 * touches the legacy global fallback.
 */
async function summarizeSession(sessionId: string): Promise<Record<string, any> | null> {
  const details = await SessionManagementHandler.getSessionDetailsWithMeta(sessionId);
  if (!details.success || !details.session) return null;
  return details.session;
}

/**
 * ── SESSION IDENTITY (Amp-orb eval W3) ────────────────────────────────────
 *
 * Fetch ONE session's identity record through the shared read model. Returns null ONLY when
 * no row with that id exists — every caller below turns that null into an EXPLICIT
 * "cannot resolve" response naming the id it looked for, never an empty/plausible record.
 */
async function identityOf(sessionId: string): Promise<SessionIdentity | null> {
  const row = await SessionRepo.getIdentityRow(sessionId);
  return row ? buildSessionIdentity(row) : null;
}

class SessionRoutes {
  /**
   * session_start — resolve/open the caller's session (optional title/goal/project).
   *
   * ACTOR MODE (resolverMode==='actor'): converge onto the SHARED actor
   * resolver — resolve-or-create the CALLER's session idempotently (explicit id → pin →
   * newest-open, else advisory-locked create keyed by actor), stamped with the real
   * `context.actor` (never 'anonymous'/NULL), and NEVER end the actor's existing working
   * session. This makes the manual lifecycle match the write path (context_store/task_create
   * resolve the SAME session via ensureSessionForActor) — no orphan anonymous row, no
   * destroyed working session.
   *
   * LEGACY/SHADOW MODE (the default, byte-identical to before): open a NEW connection-keyed
   * session, ending the prior one first. Order matters for SR-1's one-active-per-connection
   * guard: we END the current active session (full finalize) BEFORE opening the new one, so the
   * partial unique index is never violated and analytics for the closed session are flushed.
   * Accepts optional title, goal, and project; title/goal are stamped onto the session row
   * (session_goal column → Session View "Session Goal" field).
   */
  async handleStart(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const connectionId = context?.connectionId;
      const title: string | undefined = args.title;
      const goal: string | undefined = args.goal;
      const projectName: string | undefined = args.project;

      // Resolve the project FIRST (before mutating any session state) so a bad project
      // name fails fast without leaving the connection sessionless.
      let projectId: string | undefined;
      let resolvedProjectName: string | undefined;
      if (projectName) {
        const resolved = await resolveProject(projectName);
        if (!resolved.ok) {
          return formatMcpError(resolved.message, 'session_start');
        }
        projectId = resolved.id;
        resolvedProjectName = resolved.name;
      }

      // ACTOR MODE (Sessions Foundation Phase 2b): converge session_start onto
      // the shared actor resolver. Resolve-or-create the CALLER's session idempotently and
      // stamp the real actor — do NOT run the legacy end-prior below (in actor mode it resolves
      // the actor's OWN working session and would finalize it, destroying attribution). Gated on
      // resolverMode==='actor', the SAME switch getActiveSession/the write path key on; the
      // legacy/shadow path below is left untouched and byte-identical.
      if (SESSION_CONFIG.resolverMode === 'actor') {
        // Inherit the connection's current project when none was given (mirror the legacy default
        // so a manual start with no project matches the auto-start default).
        if (!projectId && connectionId) {
          try {
            // PROJECT-SCOPE: effective — the new session must be pinned to the project this
            // connection's writes land in; for a bound client that is the binding.
            projectId = (await projectHandler.getCurrentProjectId(connectionId)) ?? undefined;
          } catch {
            projectId = undefined;
          }
        }

        // The ONE resolver: explicit id → pin → newest-open, else advisory-locked create keyed by
        // actor (connection_id NULL). Idempotent — a 2nd start for the same actor returns the SAME
        // session; it never mints a duplicate and never ends the actor's live session.
        const sessionId = await SessionTracker.ensureSessionForActor({
          actor: context?.actor,
          connectionId,
          projectId,
          // W3: if this resolves to an EXISTING session the reason is ignored
          // (that row keeps the reason it was born with — a resolve must not rewrite history).
          // If it CREATES, the session exists because the caller explicitly asked for one.
          creationReason: 'explicit',
        });

        // Apply the caller-supplied title/goal to the resolved/created row. updateDetails COALESCEs,
        // so an undefined field never wipes an existing value (covers both the fresh-create case —
        // where createForActorLocked wrote no title — and the resolve-existing case uniformly).
        if (title !== undefined || goal !== undefined) {
          await SessionRepo.updateDetails(sessionId, title, undefined, goal);
        }

        const session = await summarizeSession(sessionId);
        const titleSuffix = title ? ` ("${title}")` : '';
        const projectSuffix = (resolvedProjectName ?? session?.project_name)
          ? ` for project '${resolvedProjectName ?? session?.project_name}'`
          : '';
        return {
          content: [
            {
              type: 'text',
              text:
                `✅ Session ready: ${sessionId.substring(0, 8)}...${titleSuffix}${projectSuffix} (resolved per actor).\n` +
                `${formatRecordRef(sessionId)}`,
            },
          ],
          structuredContent: {
            ok: true,
            action: 'started',
            sessionId,
            // Actor mode never finalizes a prior session — the whole point of the converge fix.
            endedSessionId: null,
            session: session ?? { id: sessionId },
          },
        };
      }

      // End this connection's current session (if any) via the full finalize path.
      // Actor threaded so actor-mode resolves the CALLER's current session (the auditor A); ignored
      // in legacy/shadow (connection-keyed).
      const priorSessionId = await SessionTracker.getActiveSession(connectionId, { actor: context?.actor });
      let endedSessionId: string | undefined;
      if (priorSessionId) {
        await SessionTracker.endSession(priorSessionId);
        endedSessionId = priorSessionId;
        logger.info(
          `🔁 session_start: finalized prior session ${priorSessionId.substring(0, 8)}... before opening a new one` +
            `${connectionId ? ` (connection: ${connectionId})` : ''}`
        );
      }

      // If no project was specified, inherit the connection's current project (same key
      // the lazy action-gate uses), so a manual start mirrors the auto-start default.
      if (!projectId && connectionId) {
        try {
          // PROJECT-SCOPE: effective — same inheritance rule as the actor-mode branch above.
          projectId = (await projectHandler.getCurrentProjectId(connectionId)) ?? undefined;
        } catch {
          projectId = undefined;
        }
      }

      // Open the new session for THIS connection. title/goal persist to the session row.
      const newSessionId = await SessionTracker.startSession(
        projectId,
        title,
        undefined, // description
        goal,
        undefined, // tags
        undefined, // aiModel
        undefined, // sessionType (defaults)
        connectionId,
        undefined, // actor (legacy mode is connection-keyed; the actor is stamped downstream)
        // W3: the user invoked session_start — this session exists explicitly.
        'explicit'
      );

      const session = await summarizeSession(newSessionId);

      const titleSuffix = title ? ` ("${title}")` : '';
      const projectSuffix = (resolvedProjectName ?? session?.project_name)
        ? ` for project '${resolvedProjectName ?? session?.project_name}'`
        : '';
      return {
        content: [
          {
            type: 'text',
            text:
              `✅ New session started: ${newSessionId.substring(0, 8)}...${titleSuffix}${projectSuffix}` +
              (endedSessionId ? ` (finalized prior session ${endedSessionId.substring(0, 8)}...)` : '') +
              `\n${formatRecordRef(newSessionId)}` +
              (endedSessionId ? `\n   (prior) ${formatRecordRef(endedSessionId)}` : ''),
          },
        ],
        structuredContent: {
          ok: true,
          action: 'started',
          sessionId: newSessionId,
          endedSessionId: endedSessionId ?? null,
          session: session ?? { id: newSessionId },
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'session_start');
    }
  }

  /**
   * session_end — finalize this connection's current active session.
   *
   * Runs the full endSession() path (git file sync, productivity, token/activity flush,
   * analytics event, in-memory eviction). No-op-safe: if the connection has no active
   * session, returns success with action 'noop' (ending nothing is not an error). The
   * next ACTION tool on this connection lazily auto-starts a fresh session.
   */
  async handleEnd(_args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const connectionId = context?.connectionId;
      const activeSessionId = await SessionTracker.getActiveSession(connectionId, { actor: context?.actor });

      if (!activeSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'ℹ️ No active session to end for this connection — nothing to do. The next action will start a fresh session.',
            },
          ],
          structuredContent: { ok: true, action: 'noop', sessionId: null },
        };
      }

      // Snapshot the summary BEFORE finalize (endSession evicts in-memory counts).
      const session = await summarizeSession(activeSessionId);
      const finalData = await SessionTracker.endSession(activeSessionId);

      logger.info(
        `🏁 session_end: finalized session ${activeSessionId.substring(0, 8)}...` +
          `${connectionId ? ` (connection: ${connectionId})` : ''}`
      );

      return {
        content: [
          {
            type: 'text',
            text:
              `✅ Session ended: ${activeSessionId.substring(0, 8)}...` +
              ` (duration ${Math.round((finalData.duration_ms ?? 0) / 1000)}s, ` +
              `productivity ${finalData.productivity_score ?? 0}). ` +
              `The next action will start a fresh session.\n` +
              `${formatRecordRef(activeSessionId)}`,
          },
        ],
        structuredContent: {
          ok: true,
          action: 'ended',
          sessionId: activeSessionId,
          session: session ?? { id: activeSessionId },
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'session_end');
    }
  }

  /**
   * session_status — read-only summary of this connection's current active session, WITH the
   * full identity record (Amp-orb eval W3).
   *
   * Connection-scoped: resolves via getActiveSession(connectionId) (NO global fallback), then
   * reuses the existing rich summary AND the shared identity read model. Returns ok:true with
   * active:false when nothing resolves — but never a bare "none": the response states WHAT was
   * resolved from (the derived actor + connection) and WHY nothing was found, because a
   * plausible blank here is exactly the failure the eval hit.
   *
   * The legacy `session` field is preserved byte-for-byte for existing consumers; `identity`
   * and `caller` are ADDITIVE.
   */
  async handleStatus(_args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const connectionId = context?.connectionId;
      const caller = callerEcho(context);
      const activeSessionId = await SessionTracker.getActiveSession(connectionId, { actor: context?.actor });

      /** The "nothing resolved" response — states the reason, never a bare blank. */
      const noSession = (reason: string): McpResponse => ({
        content: [
          {
            type: 'text',
            text:
              `ℹ️ No active session resolves for this caller.\n` +
              `❓ why: ${reason}\n` +
              `${renderCallerEcho(caller)}\n` +
              `💡 The next content-producing write (context_store / task_create / ` +
              `decision_record) will create one automatically, or call session_start to open ` +
              `one explicitly.`,
          },
        ],
        structuredContent: {
          ok: true,
          active: false,
          session: null,
          identity: null,
          unresolvedReason: reason,
          caller,
        },
      });

      if (!activeSessionId) {
        return noSession(
          SESSION_CONFIG.resolverMode === 'actor'
            ? `no open session is pinned to, or owned by, actor '${caller.actor ?? 'anonymous'}' ` +
                `(resolver mode: actor)`
            : `no open session is bound to connection ` +
                `'${connectionId ?? 'none (header-less transport)'}' and none was re-attachable ` +
                `within the re-attach window (resolver mode: ${SESSION_CONFIG.resolverMode})`,
        );
      }

      const [session, identity] = await Promise.all([
        summarizeSession(activeSessionId),
        identityOf(activeSessionId),
      ]);

      if (!identity) {
        // Edge: the resolver returned an id but no row exists for it. SAY SO — naming the id —
        // rather than reporting a clean "no active session", which would hide a real defect.
        return noSession(
          `the session resolver returned session id ${activeSessionId}, but no session row ` +
            `with that id exists. This is an inconsistency, not an empty state — the id was ` +
            `resolved from a stale cache or the row was deleted underneath this call.`,
        );
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `📊 Active session\n` +
              `${renderSessionIdentity(identity)}\n` +
              `   ${formatRecordRef(identity.sessionId)}\n` +
              `${renderCallerEcho(caller)}`,
          },
        ],
        structuredContent: {
          ok: true,
          active: true,
          // ADDITIVE: the full identity record the eval asked for (report lines 437-449).
          identity,
          caller,
          // Preserved for existing consumers (the Session View / prior tooling).
          session: session ?? { id: activeSessionId },
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'session_status');
    }
  }

  /**
   * session_get — read-only identity for ONE session, by full UUID or 8+-hex short id
   * (Amp-orb eval W3).
   *
   * THE CORRELATION PRIMITIVE: every context row already reports its `sessionId`, so this is
   * the tool that turns "which session produced this record, and who held it?" into a single
   * call with ZERO SQL. Cross-actor by design — this is an OBSERVABILITY read, and refusing to
   * show an operator another actor's session would defeat the entire point of the finding.
   *
   * A short id is resolved by the SHARED resolver (project-scoped, parameterized, refuses to
   * pick between ambiguous candidates). An id that resolves to nothing produces an EXPLICIT
   * not-found naming the id — never an empty record.
   */
  async handleGet(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const rawId: string = args.sessionId;

      // Project scope for the SHORT-ID prefix match only (a full UUID short-circuits). Scoping
      // narrows prefix collisions; when no project is set we resolve across all sessions rather
      // than failing, because an operator correlating attribution may legitimately have no
      // project selected.
      let scopeProjectId: string | undefined;
      try {
        const connId = context?.connectionId || 'default-session';
        await projectHandler.initializeSession(connId);
        // PROJECT-SCOPE: effective — session_get declares no project param, so this read IS
        // the whole of its scoping. It must agree with session_list, which the gate pins to
        // the binding (the exact pair the Amp evaluator saw disagree).
        scopeProjectId = (await projectHandler.getCurrentProjectId(connId)) ?? undefined;
      } catch {
        scopeProjectId = undefined;
      }

      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('session', rawId, scopeProjectId);
      } catch (e) {
        if (e instanceof AmbiguousIdError) {
          return {
            content: [{ type: 'text', text: ambiguousIdMessage(e, 'session_get') }],
            structuredContent: {
              ok: true,
              found: false,
              ambiguous: true,
              candidates: e.candidates.map((c) => c.id),
            },
          };
        }
        if (e instanceof IdNotFoundError) {
          return this.sessionNotFound(rawId);
        }
        throw e;
      }

      const identity = await identityOf(resolvedId);
      if (!identity) return this.sessionNotFound(rawId, resolvedId);

      return {
        content: [
          {
            type: 'text',
            text:
              `📊 Session\n${renderSessionIdentity(identity)}\n` +
              `   ${formatRecordRef(identity.sessionId)}`,
          },
        ],
        structuredContent: { ok: true, found: true, identity },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'session_get');
    }
  }

  /**
   * The ONE not-found response for session_get. Names the id the caller supplied (and, when it
   * differs, the id it resolved to) so "I cannot resolve this session" is unambiguous and
   * actionable — never an empty identity record that reads like a real answer.
   */
  private sessionNotFound(rawId: string, resolvedId?: string): McpResponse {
    const resolvedNote =
      resolvedId && resolvedId !== rawId ? ` (resolved to full id ${resolvedId})` : '';
    return {
      content: [
        {
          type: 'text',
          text:
            `❌ Session NOT FOUND — cannot resolve session '${rawId}'${resolvedNote}.\n` +
            `❓ There is no session row with that id. It was never created, it belongs to a ` +
            `different Mandrel instance, or it was deleted.\n` +
            `💡 Use session_list to enumerate the sessions this instance actually has.`,
        },
      ],
      structuredContent: { ok: true, found: false, identity: null, requestedId: rawId },
    };
  }

  /**
   * session_list — read-only, project-scoped enumeration of sessions for correlation
   * (Amp-orb eval W3, "a project-level session list suitable for correlation").
   *
   * Defaults to the caller's current project, newest activity first. `project` accepts a name
   * or id; `actor` filters to one principal; `openOnly` restricts to live/resumable sessions.
   * The limit is CLAMPED against the configured ceiling and the clamp is REPORTED — a caller
   * never gets a silently-truncated page it believes is complete.
   */
  async handleList(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // ── project scope ────────────────────────────────────────────────────────────────────
      let projectId: string | null = null;
      let projectLabel: string;
      if (args.project) {
        const resolved = await resolveProject(args.project);
        if (!resolved.ok) return formatMcpError(resolved.message, 'session_list');
        projectId = resolved.id;
        projectLabel = `${resolved.name} (${resolved.id})`;
      } else if (args.allProjects === true) {
        projectLabel = 'ALL projects (allProjects:true)';
      } else {
        try {
          const connId = context?.connectionId || 'default-session';
          await projectHandler.initializeSession(connId);
          // PROJECT-SCOPE: effective — session_list's DEFAULT scope (the `project` arg branch
          // above is rung 1, and the gate materialises the binding into it).
          projectId = (await projectHandler.getCurrentProjectId(connId)) ?? null;
        } catch {
          projectId = null;
        }
        if (!projectId) {
          return formatMcpError(
            'session_list is project-scoped and no project could be resolved for this ' +
              'connection. Pass `project` (name or id), set one with project_switch, or pass ' +
              '`allProjects: true` to list across every project.',
            'session_list',
          );
        }
        projectLabel = `${projectId} (this connection's current project)`;
      }

      // ── bounds (clamped + reported, never silently truncated) ────────────────────────────
      const requestedLimit: number = args.limit ?? SESSION_IDENTITY_CONFIG.listDefaultLimit;
      const limit = Math.min(requestedLimit, SESSION_IDENTITY_CONFIG.listMaxLimit);
      const clamped = limit < requestedLimit;
      const offset: number = args.offset ?? 0;

      // ACTOR-PRECEDENCE SWEEP: this `args.actor` is a READ
      // FILTER — a WHERE-clause value on a project-scoped list — NOT an identity being asserted
      // or written. It is deliberately NOT routed through deriveActor: composing it with the
      // caller's principal would silently narrow "show me actor X's sessions" into "show me MY
      // sessions", which is a different tool. The identity-BEARING sites are claimActor
      // (tasks.routes.ts) and handlePin below, and both take the actor from context, never args.
      const actorFilter = normalizeActor(args.actor);
      const openOnly: boolean = args.openOnly === true;

      const { rows, totalCount } = await SessionRepo.listIdentityRows({
        projectId,
        actor: actorFilter,
        openOnly,
        limit,
        offset,
      });
      const identities = rows.map(buildSessionIdentity);

      const filterLine =
        `📁 project: ${projectLabel}` +
        (actorFilter ? ` · 👤 actor: ${actorFilter}` : '') +
        (openOnly ? ' · state: OPEN only' : '') +
        ` · showing ${identities.length} of ${totalCount}` +
        (offset > 0 ? ` (offset ${offset})` : '') +
        (clamped ? ` · ⚠️ limit clamped ${requestedLimit} → ${limit} (ceiling: ${SESSION_IDENTITY_CONFIG.listMaxLimit})` : '');

      const body =
        identities.length === 0
          ? '   (no sessions match these filters — this is an empty result, not a lookup failure)'
          : identities
              .map((i) => `   ${renderSessionIdentityLine(i)}  ${formatRecordRef(i.sessionId)}`)
              .join('\n');

      return {
        content: [{ type: 'text', text: `📋 Sessions\n${filterLine}\n${body}` }],
        structuredContent: {
          ok: true,
          sessions: identities,
          totalCount,
          limit,
          offset,
          limitClamped: clamped,
          requestedLimit,
          filters: { projectId, actor: actorFilter, openOnly },
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'session_list');
    }
  }

  /**
   * session_pin — set / get / clear the caller's DB-persisted session PIN (Phase 2a).
   *
   * The pin is the user-controlled "this is my session" targeting primitive (the auditor review
   * §4.1). It is keyed to the caller's ACTOR (derived at the edge into context.actor from
   * X-Actor-ID / auth `sub`), NEVER a tool argument — a user can only pin their own session.
   * A caller with no derivable actor cannot pin (fails loud) rather than pinning
   * under a shared/ambiguous key.
   *
   * DARK-SAFE: this only writes/reads the additive session_pins table. Setting a pin does NOT
   * change how any action resolves its session while resolverMode='legacy' (the default) —
   * resolveSession (which reads the pin) is not consulted yet. The tool persists intent now so
   * the 2b cutover has real pins to act on; it says so in its success text.
   *
   *   action='set'   → pin args.sessionId, or (if omitted) this connection's current active
   *                    session. The target must be an OPEN session.
   *   action='get'   → the caller's current pin + whether the pinned session is still open.
   *   action='clear' → remove the caller's pin (idempotent).
   */
  async handlePin(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const action: 'get' | 'set' | 'clear' = args.action;
      const connectionId = context?.connectionId;

      // Actor is REQUIRED — the pin key. Derive-and-normalize; blank → fail loud.
      const actor = normalizeActor(context?.actor);
      if (!actor) {
        return formatMcpError(
          'session_pin requires an actor identity. Declare one via the X-Actor-ID header ' +
            '(bridge/MCP) or authenticate (Command UI) so the pin can be scoped to you.',
          'session_pin'
        );
      }

      if (action === 'get') {
        const pin = await SessionPinRepo.getPin(actor);
        if (!pin) {
          return {
            content: [{ type: 'text', text: `ℹ️ No session pinned for actor '${actor}'.` }],
            structuredContent: { ok: true, action: 'get', actor, pinned: false, pin: null },
          };
        }
        const open = await SessionRepo.existsActive(pin.sessionId);
        return {
          content: [
            {
              type: 'text',
              text:
                `📌 Actor '${actor}' pins session ${pin.sessionId.substring(0, 8)}...` +
                ` (${open ? 'open' : 'closed — a stale pin is ignored on resolution'}).\n` +
                `${formatRecordRef(pin.sessionId)}`,
            },
          ],
          structuredContent: {
            ok: true,
            action: 'get',
            actor,
            pinned: true,
            open,
            pin: { actor: pin.actor, sessionId: pin.sessionId, pinnedAt: pin.pinnedAt },
          },
        };
      }

      if (action === 'clear') {
        const removed = await SessionPinRepo.clearPin(actor);
        return {
          content: [
            {
              type: 'text',
              text: removed
                ? `🧹 Cleared the session pin for actor '${actor}'.`
                : `ℹ️ No session pin to clear for actor '${actor}'.`,
            },
          ],
          structuredContent: { ok: true, action: 'clear', actor, removed },
        };
      }

      // action === 'set'
      let targetSessionId: string | undefined = args.sessionId;
      if (!targetSessionId) {
        // Default to the connection's current active session (connection-scoped, no global
        // fallback) — the natural "pin the session I'm working in" default. Actor threaded so
        // actor mode resolves the caller's own session (the auditor A); ignored in legacy/shadow.
        targetSessionId = (await SessionTracker.getActiveSession(connectionId, { actor })) ?? undefined;
        if (!targetSessionId) {
          return formatMcpError(
            'session_pin set: no sessionId given and this connection has no active session to ' +
              'pin. Start a session (or pass an explicit sessionId) first.',
            'session_pin'
          );
        }
      }

      // The target must be a real OPEN session — pinning a closed/nonexistent session is a
      // no-op on resolution, so reject it with a clear message instead of persisting dead intent.
      const open = await SessionRepo.existsActive(targetSessionId);
      if (!open) {
        return formatMcpError(
          `session_pin set: session ${targetSessionId} is not an open session (it may not ` +
            `exist or has already ended). Pin an active session.`,
          'session_pin'
        );
      }

      const pin = await SessionPinRepo.setPin(actor, targetSessionId);
      logger.info(
        `📌 session_pin: actor '${actor}' pinned session ${targetSessionId.substring(0, 8)}...` +
          `${connectionId ? ` (connection: ${connectionId})` : ''}`
      );
      return {
        content: [
          {
            type: 'text',
            text:
              `📌 Pinned session ${targetSessionId.substring(0, 8)}... for actor '${actor}'. ` +
              `(Persisted now; it will steer resolution once the shared resolver is enabled.)\n` +
              `${formatRecordRef(targetSessionId)}`,
          },
        ],
        structuredContent: {
          ok: true,
          action: 'set',
          actor,
          pin: { actor: pin.actor, sessionId: pin.sessionId, pinnedAt: pin.pinnedAt },
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'session_pin');
    }
  }
}

export const sessionRoutes = new SessionRoutes();
