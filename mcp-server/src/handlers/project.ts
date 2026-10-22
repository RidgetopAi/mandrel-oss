/**
 * AIDIS Project Management Handler
 * 
 * This handles all project management operations:
 * - Creating and managing projects
 * - Session state (current active project)
 * - Project switching for AI agents
 * - Project discovery and listing
 * 
 * This enables AI agents to seamlessly work across multiple projects!
 */

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { isValidUuid } from '../utils/uuid.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { anchorStrictSessionKeyingEnabled } from '../config/reliableThreadingConfig.js';
import { boundProjectInForce, currentProjectScope } from '../services/effectiveProjectScope.js';
import { composePositionKey } from '../config/positionKeyConfig.js';
import {
  AmbientProjectFallbackError,
  ambientProjectFallbackIsLoud,
} from '../config/ambientProjectFallbackConfig.js';
import { actorProjectStateEnabled } from '../config/actorProjectStateConfig.js';
import {
  actorProjectKey,
  readActorProjectDefault,
  upsertActorProjectDefault,
} from '../services/actorProjectDefaults.js';
import {
  countProjectChildren,
  isProjectEmpty,
  describeProjectChildCounts,
  PROJECT_TABLE,
  PROJECT_ID_COLUMN,
} from '../services/projectCascade.js';
// Re-export types from shared types file (to avoid circular dependency with projectSwitchValidator)
export type { ProjectInfo, CreateProjectRequest, SessionState } from '../types/project.js';
// Import for internal use
import type { ProjectInfo, CreateProjectRequest, SessionState, ProjectChildCounts, DeleteProjectResult } from '../types/project.js';

/** The machine code for a strict-keying anchor refusal (mirrors CALLER_IDENTITY_ERROR_CODES). */
export const ANCHOR_SESSION_KEY_ERROR_CODE = 'ANCHOR_NO_SESSION_IDENTITY';

/**
 * STRICT ANCHOR KEYING refusal (config ANCHOR_STRICT_SESSION_KEYING).
 *
 * Thrown by thread_set / thread_clear (and rendered by thread_current) when strict keying is
 * ON and the connection has NO resolved DB session — because the only key left to fall back
 * to is the connection id, which for every header-less HTTP caller is a SHARED transport
 * literal ('http-default' / 'default-session'). An anchor keyed there is readable, mergeable
 * and clearable by every other header-less caller: the cross-session leak this mode refuses.
 *
 * Same shape as CallerIdentityError (services/callerIdentityGuard.ts): the message is
 * PREFIXED with the machine code and carries its own 💡 remedy, because formatMcpError →
 * actionableErrorText appends a generic "re-check your parameters" hint to any message that
 * does not already carry one — and the remedy here is identity, not a parameter.
 */
export class AnchorSessionKeyError extends Error {
  readonly code = ANCHOR_SESSION_KEY_ERROR_CODE;
  constructor(operation: string, sessionId: string) {
    super(
      `[${ANCHOR_SESSION_KEY_ERROR_CODE}] ${operation}: no session identity is resolved for ` +
        `this connection ('${sessionId}'), and strict anchor keying is enabled — so there is ` +
        `no per-session key to anchor to, only a SHARED fallback that every other ` +
        `unidentified caller reads and writes too. Refusing: no session identity → no anchor.` +
        `\n\n💡 Identify this connection (send a stable \`X-Connection-ID\` header) and run a ` +
        `session-creating operation (e.g. context_store) so a session is bound to it, or ` +
        `disable MANDREL_ANCHOR_STRICT_SESSION_KEYING to restore the legacy shared-key behavior.`
    );
    this.name = 'AnchorSessionKeyError';
  }
}

/**
 * The anchor-keying resolution: either the durable session key to use, or the strict-mode
 * refusal reason. Discriminated so a caller cannot read a key out of a refusal.
 */
export type AnchorKeying =
  | { key: string; refusal?: undefined }
  | { key?: undefined; refusal: string };

class ProjectHandler {
  // In-memory session state (in production, this could be Redis/database)
  private sessionStates = new Map<string, SessionState>();
  private defaultSessionId = 'default-session';

  /**
   * List all projects with optional statistics.
   *
   * `sessionId` selects WHOSE current project the `isActive` flag is computed against.
   * It was previously not a parameter at all, so `isActive` always read the GLOBAL
   * 'default-session' slot — wrong for every non-default connection, and the reason
   * `project_list` reported a different "🟢 (CURRENT)" project than the one the caller's
   * own writes landed in (the bug predates the binding and is independent
   * of it). Callers that hold a connection MUST pass it.
   */
  async listProjects(
    includeStats: boolean = true,
    sessionId: string = this.defaultSessionId,
    /** false (default) counts LIVE contexts only; true counts archived too. */
    includeArchived: boolean = false
  ): Promise<ProjectInfo[]> {
    logger.info('📋 Listing all projects...');

    try {
      let sql = `
        SELECT 
          p.id, p.name, p.description, p.status, 
          p.created_at, p.updated_at, p.git_repo_url, 
          p.root_directory, p.metadata
      `;

      if (includeStats) {
        sql += `, COUNT(c.id) as context_count`;
      }

      sql += ` FROM projects p`;

      if (includeStats) {
        // SOFT-DELETE: count only LIVE contexts, so `contextCount` means the
        // same thing context_search would return. The predicate belongs in the JOIN
        // condition, NOT a WHERE clause — on a LEFT JOIN, `WHERE c.archived_at IS NULL`
        // would also drop projects that have no contexts at all (NULL fails the test), so
        // the fix would silently delete rows from project_list. Same reason at getProject().
        sql += ` LEFT JOIN contexts c ON p.id = c.project_id${includeArchived ? '' : ' AND c.archived_at IS NULL'}`;
      }

      sql += ` GROUP BY p.id, p.name, p.description, p.status, p.created_at, p.updated_at, p.git_repo_url, p.root_directory, p.metadata`;
      // TOTAL ORDER. `p.id DESC` is not decoration here — this list is PAGED
      // (project_list documents an `offset` and the route slices it), and the sort key alone
      // fails on TWO independent grounds:
      //   1. NOT UNIQUE. Projects touched in the same instant tie, and the pages are separate
      //      tool calls that each re-run this query — so a plan change between them (measured:
      //      Sort/GroupAggregate → HashAggregate at 400 tied rows) reorders the tied block and
      //      the caller sees one project twice while another never appears.
      //   2. MUTABLE — the ground that does not depend on the plan at all. `updated_at` moves
      //      on any write to the project, so the page boundary shifts under ordinary
      //      concurrent activity. A tiebreaker must not itself move; that is exactly why the
      //      key appended here is the PRIMARY KEY (unique, NOT NULL, stable under edits,
      //      already indexed) and not another timestamp.
      sql += ` ORDER BY p.updated_at DESC, p.id DESC`;

      const result = await db.query(sql);

      // Get current project ID once before mapping (now async)
      // PROJECT-SCOPE: effective — `isActive` must name the project THIS caller's reads and
      // writes are scoped to (no surface may report a different project
      // than the one writes land in), so it is the effective scope for the caller's session.
      const currentProjectId = await this.getCurrentProjectId(sessionId);

      const projects: ProjectInfo[] = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        gitRepoUrl: row.git_repo_url,
        rootDirectory: row.root_directory,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        contextCount: includeStats ? parseInt(row.context_count || '0') : undefined,
        isActive: currentProjectId === row.id
      }));

      logger.info(`✅ Found ${projects.length} projects`);
      return projects;

    } catch (error) {
      logger.error('❌ Failed to list projects', error as Error);
      throw new Error(`Failed to list projects: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create a new project
   */
  /**
   * ── KNOWN GAP, DELIBERATELY NOT CLOSED HERE ──────────────────
   * The Command backend's twin of this function (mandrel-command/backend
   * services/project.ts:createProject) now grants its CREATOR a `user_project_access` row
   * in the same transaction, so a new project is not invisible to the non-admin who made
   * it. THIS path cannot do the same, and the reason is structural, not an oversight:
   * `user_project_access.user_id` is a FK to `admin_users`, and this process has NO
   * concept of an admin_users principal — `grep -rn "admin_users" mcp-server/src` outside
   * tests returns 0. Its caller identity is an `X-Actor-ID` free-text actor, which does
   * not resolve to a user row, so there is no id to grant to.
   *
   * EXPOSURE: a project created through `project_create` is reachable by admins (who
   * short-circuit the grant check) and by nobody else until a grant is issued via
   * `PUT /api/users/:userId/project-access`. That is acceptable today because the tool is
   * NOT reachable from the browser — mcpReadAllowlist is deny-by-default and read-only, so
   * `project_create` cannot pass the /api/mcp passthrough — leaving agent/CLI callers,
   * which are admin-identity. Closing it properly needs an actor→user mapping, which is
   * its own decision, not a line of code to sneak in here.
   */
  async createProject(request: CreateProjectRequest): Promise<ProjectInfo> {
    logger.info(`🆕 Creating new project: "${request.name}"`);

    try {
      // Validate name uniqueness
      const existingCheck = await db.query('SELECT id FROM projects WHERE name = $1', [request.name]);
      if (existingCheck.rows.length > 0) {
        throw new Error(`Project with name "${request.name}" already exists`);
      }

      // Insert new project (status defaults to 'active' at the DB level when omitted)
      const result = await db.query(`
        INSERT INTO projects (name, description, status, git_repo_url, root_directory, metadata)
        VALUES ($1, $2, COALESCE($3, 'active'), $4, $5, $6)
        RETURNING *
      `, [
        request.name,
        request.description || null,
        request.status || null,
        request.gitRepoUrl || null,
        request.rootDirectory || null,
        JSON.stringify(request.metadata || {})
      ]);

      const row = result.rows[0];
      const project: ProjectInfo = {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        gitRepoUrl: row.git_repo_url,
        rootDirectory: row.root_directory,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        contextCount: 0
      };

      logger.info(`✅ Created project: ${project.id}`);
      return project;

    } catch (error) {
      logger.error('❌ Failed to create project', error as Error);
      throw new Error(`Failed to create project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get project details by ID or name.
   *
   * `sessionId` selects WHOSE current project `isActive` is measured against — same
   * global-slot fix as listProjects. Defaulted, so the internal callers
   * that have no connection (the binding resolver's lookup, initializeSession) are
   * unchanged.
   */
  async getProject(identifier: string, sessionId: string = this.defaultSessionId, includeArchived: boolean = false): Promise<ProjectInfo | null> {
    logger.info(`🔍 Getting project: "${identifier}"`);

    try {
      // Try by ID first (UUID format), then by name
      const isUUID = isValidUuid(identifier);
      
      const field = isUUID ? 'id' : 'name';
      const result = await db.query(`
        SELECT 
          p.id, p.name, p.description, p.status,
          p.created_at, p.updated_at, p.git_repo_url,
          p.root_directory, p.metadata,
          COUNT(c.id) as context_count
        FROM projects p
        -- SOFT-DELETE: live contexts only, so this count means what
        -- context_search returns. Predicate is in the JOIN condition, not WHERE — see
        -- listProjects() above for why a LEFT JOIN makes that difference load-bearing.
        LEFT JOIN contexts c ON p.id = c.project_id${includeArchived ? '' : ' AND c.archived_at IS NULL'}
        WHERE p.${field} = $1
        GROUP BY p.id, p.name, p.description, p.status, p.created_at, p.updated_at, p.git_repo_url, p.root_directory, p.metadata
      `, [identifier]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // Get current project ID (now async)
      // PROJECT-SCOPE: effective — `isActive` reports "is this where my writes land", which
      // under a binding is the bound project, for the CALLER's session.
      const currentProjectId = await this.getCurrentProjectId(sessionId);

      const project: ProjectInfo = {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        gitRepoUrl: row.git_repo_url,
        rootDirectory: row.root_directory,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        contextCount: parseInt(row.context_count || '0'),
        isActive: currentProjectId === row.id
      };

      logger.info(`✅ Found project: ${project.name} (${project.contextCount} contexts)`);
      return project;

    } catch (error) {
      logger.error('❌ Failed to get project', error as Error);
      throw new Error(`Failed to get project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Set the current active project for the session
   */
  setCurrentProject(projectId: string, sessionId: string = this.defaultSessionId, manualOverride: boolean = false): void {
    // T4: THIS LINE is the scope-move audit trail — it is what let us
    // attribute both prod captures (`session: http-default, manual: true` on 2026-07-27/28)
    // to explicit header-less project_switch calls rather than to a restart auto-select.
    // It named the slot and the manual flag but NOT the actor, so the two captures were
    // attributable to a POPULATION ("some header-less caller") and not to a caller. The
    // actor rides the ambient scope (services/effectiveProjectScope.ts) — no signature
    // carries a diagnostic argument for it. `none` = a path with no derived actor (an
    // internal/auto-select move), which is itself the useful distinction.
    const actor = currentProjectScope()?.actor ?? 'none';
    logger.info(
      `🔄 Setting current project to: ${projectId} (session: ${sessionId}, manual: ${manualOverride}, actor: ${actor})`
    );

    const existing = this.sessionStates.get(sessionId) || {};
    this.sessionStates.set(sessionId, {
      ...existing,
      currentProjectId: projectId,
      sessionId,
      manualOverride  // Store whether this was a manual switch
    });

    logger.info(`✅ Current project set for session ${sessionId}${manualOverride ? ' (manual override)' : ''}`);
  }

  /**
   * Clear all session caches - forces re-initialization on next access
   * Used when primary project changes to ensure sessions sync with new default
   */
  clearSessionCache(): void {
    logger.info('🗑️  Clearing all session caches');
    const sessionCount = this.sessionStates.size;
    this.sessionStates.clear();
    logger.info(`✅ Cleared ${sessionCount} session cache(s)`);
  }

  /**
   * THE EFFECTIVE PROJECT SCOPE for the call currently running (   * an earlier decision). This is the accessor the whole tree resolves projects through,
   * and it is therefore where the precedence ladder is honoured — NOT the tool's schema.
   *
   *   rung 2 BINDING     — an `X-Mandrel-Project` / `MANDREL_PROJECT_ID` client binding
   *                        wins outright, for what queries USE *and* what tools REPORT.
   *   rung 3 INTERACTIVE — otherwise, this connection's `project_switch` slot, exactly
   *                        as before (see getInteractiveProjectId).
   *
   * (rung 1, an explicit per-call project argument, is resolved upstream at the route gate
   * and never reaches here — a tool given an explicit project does not ask for "current".)
   *
   * NOTE the binding is deliberately consulted regardless of which `sessionId` is passed:
   * within a bound call the effective project IS the binding, full stop. A caller that
   * genuinely wants the human/interactive slot must say so by name — that is what
   * getInteractiveProjectId is for, and every such call site is accounted for by
   * `src/tests/projectScopeChokePoint.contract.test.ts`.
   *
   * PROJECT-SCOPE: accessor-definition — the effective-scope accessor itself; binding (rung 2)
   * beats the interactive slot (rung 3).
   */
  async getCurrentProjectId(sessionId: string = this.defaultSessionId): Promise<string | null> {
    const bound = await boundProjectInForce();
    if (bound) return bound.id;

    // rung 2.5 — ACTOR-KEYED DEFAULT (flag-gated, default OFF). The caller's
    // derived actor (ambient scope) resolves its durable current-project from
    // actor_project_defaults — the identity-keyed replacement for the connection-keyed Map
    // below, which collapses every header-less caller onto one shared slot. Placement is the
    // spec's ladder: explicit arg (rung 1, upstream) > binding (rung 2, above) > actor
    // default > legacy connection slot (rung 3, below — unchanged, still the fallback so an
    // actor that has never switched resolves exactly as before). The anonymous/absent actor
    // has NO actor key (actorProjectKey) and falls straight through. Non-throwing: a state
    // read failure degrades to the legacy path, never breaks resolution.
    if (actorProjectStateEnabled()) {
      const actorKey = actorProjectKey(currentProjectScope()?.actor);
      if (actorKey) {
        try {
          const fromActor = await readActorProjectDefault(actorKey);
          if (fromActor) return fromActor;
        } catch (error) {
          logger.error('❌ Actor project-default read failed; falling through to connection slot', error as Error);
        }
      }
    }

    // PROJECT-SCOPE: rung3 — nothing is bound for this call, so the effective scope IS the
    // interactive slot. This is the ONE place the two rungs meet.
    return this.getInteractiveProjectId(sessionId);
  }

  /**
   * rung 3 ONLY — the connection's INTERACTIVE current project, i.e. what `project_switch`
   * set. THE HUMAN PATH (services/projectBinding.ts:13-15). Never consults the binding.
   *
   * Callers that want this rather than the effective scope are the ones VALIDATING or
   * DISPLAYING rung 3 itself (the switch validator proving a switch landed; project_current
   * showing the interactive slot alongside the effective one). Everything else wants
   * getCurrentProjectId.
   *
   * Body is byte-for-byte the pre-707f0c53 getCurrentProjectId, including the stale-cache
   * eviction — so rung 3 is unchanged by this task (legacy == today).
   *
   * PROJECT-SCOPE: accessor-definition — the rung-3 accessor itself; deliberately
   * binding-blind.
   */
  async getInteractiveProjectId(sessionId: string = this.defaultSessionId): Promise<string | null> {
    const state = this.sessionStates.get(sessionId);
    const cachedId = state?.currentProjectId;

    if (!cachedId) {
      return null;
    }

    // Validate cached ID still exists in database
    const result = await db.query(
      'SELECT 1 FROM projects WHERE id = $1',
      [cachedId]
    );

    if (result.rows.length === 0) {
      // Clear invalid cached state
      logger.warn(`Clearing stale project cache for session ${sessionId}: project ${cachedId} no longer exists`);
      this.sessionStates.delete(sessionId);
      return null;
    }

    return cachedId;
  }

  /**
   * The EFFECTIVE current project's full record (binding-aware — see getCurrentProjectId).
   *
   * PROJECT-SCOPE: accessor-definition — the effective-scope record accessor.
   */
  async getCurrentProject(sessionId: string = this.defaultSessionId): Promise<ProjectInfo | null> {
    // PROJECT-SCOPE: effective — this IS the effective-scope accessor's own resolution.
    const projectId = await this.getCurrentProjectId(sessionId);
    if (!projectId) {
      return null;
    }

    // Pass the sessionId through so the returned record's `isActive` is computed against
    // THIS caller's scope rather than the global 'default-session' slot (see getProject).
    return await this.getProject(projectId, sessionId);
  }

  /**
   * The INTERACTIVE (rung 3) current project's full record. The binding-blind sibling of
   * getCurrentProject — used where rung 3 itself is the subject, not the answer.
   *
   * PROJECT-SCOPE: accessor-definition — the rung-3 record accessor.
   */
  async getInteractiveProject(sessionId: string = this.defaultSessionId): Promise<ProjectInfo | null> {
    // PROJECT-SCOPE: rung3 — the interactive slot is the subject of this read, by definition.
    const projectId = await this.getInteractiveProjectId(sessionId);
    if (!projectId) {
      return null;
    }

    return await this.getProject(projectId, sessionId);
  }

  /**
   * Switch to a project (by ID or name) and set as current
   * Enhanced with TS012 validation framework
   */
  async switchProject(identifier: string, sessionId: string = this.defaultSessionId): Promise<ProjectInfo> {
    logger.info(`🔄 Switching to project: "${identifier}" (session: ${sessionId.substring(0, 8)}...)`);

    // Basic validation for backwards compatibility
    const project = await this.getProject(identifier);
    if (!project) {
      throw new Error(`Project "${identifier}" not found`);
    }

    // Mark as manual override so initializeSession() won't override this choice
    this.setCurrentProject(project.id, sessionId, true);

    // ACTOR-KEYED DEFAULT (flag-gated, default OFF): a manual switch by a
    // caller with a derived non-anonymous actor also persists that actor's durable
    // current-project (actor_project_defaults, migration 073) — the row rung 2.5 of
    // getCurrentProjectId reads back. Gated on the SAME flag as the read so flag-off is
    // byte-identical (zero new DB traffic). Non-throwing, like
    // syncSessionProject below: a state-persistence failure must never break the switch.
    if (actorProjectStateEnabled()) {
      const actorKey = actorProjectKey(currentProjectScope()?.actor);
      if (actorKey) {
        try {
          await upsertActorProjectDefault(actorKey, project.id);
          logger.info(`✅ Actor project default persisted: ${actorKey} → ${project.id}`);
        } catch (error) {
          logger.error('❌ Actor project-default upsert failed (switch still applied)', error as Error);
        }
      }
    }

    // ROOT FIX (b6c18866): keep the connection's session DB row in sync with its
    // current project. Previously project_switch only mutated the in-memory
    // sessionStates map, so a session's stored project_id diverged from the
    // project its newly-stored contexts landed in (cross-project misattribution).
    // Scope STRICTLY to THIS connection's own active session — never global.
    await this.syncSessionProject(sessionId, project.id);

    logger.info(`✅ Switched to project: ${project.name}`);
    return { ...project, isActive: true };
  }

  /**
   * Sync the DB `sessions` row to the current project for a SINGLE connection's
   * active session only (per-connection isolation — b6c18866).
   *
   * `connectionId` is the key used throughout the project handler (the route layer
   * passes context.connectionId as `sessionId`). The DB session that belongs to that
   * connection is resolved via ActiveSessionStore — which is itself connection-scoped.
   * If the connection has no bound DB session (e.g. internal/default callers), this is
   * a no-op: there is nothing to keep in sync, and we MUST NOT touch any other row.
   *
   * The UPDATE is always pinned to `WHERE id = <that one session id>`, so switching
   * project on connection A can never alter connection B's session row.
   */
  private async syncSessionProject(connectionId: string, projectId: string): Promise<void> {
    try {
      const activeSessionId = ActiveSessionStore.get(connectionId);
      if (!activeSessionId) {
        logger.info(
          `ℹ️  No active DB session bound to connection ${connectionId.substring(0, 8)}...; skipping session project sync`
        );
        return;
      }

      const result = await db.query(
        `UPDATE sessions SET project_id = $1 WHERE id = $2`,
        [projectId, activeSessionId]
      );

      if (result.rowCount && result.rowCount > 0) {
        logger.info(
          `✅ Synced session ${activeSessionId.substring(0, 8)}... project_id → ${projectId} (connection ${connectionId.substring(0, 8)}...)`
        );
      } else {
        logger.warn(
          `⚠️  Session ${activeSessionId.substring(0, 8)}... not found while syncing project (already ended?)`
        );
      }
    } catch (error) {
      // Never let a sync failure break the user-facing switch; log and move on.
      logger.error('❌ Failed to sync session project_id during switch', error as Error);
    }
  }

  // Note: switchProjectWithValidation moved to projectSwitchValidator.ts to avoid circular dependency
  // Use ProjectSwitchValidator.switchProjectWithValidation() instead

  /**
   * Get session state information
   */
  getSessionInfo(sessionId: string = this.defaultSessionId): SessionState {
    return this.sessionStates.get(sessionId) || {
      currentProjectId: null,
      sessionId
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SESSION-SCOPED KEYING (originally the anchor's choke point, now the
  // BRANCH POSITION's — PHASE 1 positional membership).
  //
  // The active-thread ANCHOR is RETIRED (its state methods and services/activeThreadStore
  // are deleted; migration 080's D1 demoted its historical strong mints). What SURVIVES is
  // the keying rule below: how a connection resolves to a durable per-session key, including
  // the strict-mode refusal for unidentified callers. services/branchPosition.ts keys
  // `branch_positions` through exactly this resolution, so per-session isolation still has
  // ONE choke point.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Derive the durable per-session key for a connection — THE ONE CHOKE POINT every
   * session-scoped state operation (branch_open / branch_current / branch_close AND the
   * write-path position read) resolves its key through, so the strict rule below cannot be
   * bypassed one path over (a past incident / C3: one rule, not per-caller copies).
   *
   * D2 (spec / task): PREFER the resolved DB session id (ActiveSessionStore, connection-scoped)
   * — it is the logical session, and it survives a connection REATTACH (migration 050) so the
   * same logical session reconnecting keeps its exact-match anchor without needing the fallback.
   * Fall back to the connection id when no DB session is bound (internal/default callers, or a
   * connection that hasn't done a session-creating op yet). The in-memory CACHE stays keyed by
   * connectionId (the `sessionId` param) exactly as before; only the DURABLE key resolves this
   * way. A cross-restart rehydrate (both keys change) is served by the D2 project-fallback.
   *
   * STRICT KEYING (flag ANCHOR_STRICT_SESSION_KEYING, default OFF): the
   * connection-id fallback is exactly where the cross-session anchor leak lives — a
   * header-less HTTP caller's connection id is the SHARED transport literal ('http-default' /
   * 'default-session'), so "fall back to the connection id" means "share one anchor with
   * every other unidentified caller". In strict mode that fallback is REFUSED: no resolved
   * DB session → no key at all. Callers branch on the refusal (set/clear throw
   * AnchorSessionKeyError; the auto-thread read returns no-anchor and surfaces the skip).
   */
  private resolveAnchorKeying(sessionId: string): AnchorKeying {
    const resolved = ActiveSessionStore.get(sessionId);
    if (resolved) return { key: resolved };
    if (anchorStrictSessionKeyingEnabled()) {
      return {
        refusal:
          `strict anchor keying: no session identity resolved for connection ` +
          `'${sessionId}' — anchor not read (no shared-fallback key)`,
      };
    }
    return { key: sessionId };
  }

  /**
   * The strict-keying skip reason for a connection, or null when the anchor key resolves
   * normally. Used by context_store to SURFACE (not throw) the auto-thread skip — the same
   * judgment resolveAnchorKeying makes, exposed read-only so the write path can say WHY the
   * anchor was not consulted instead of silently reporting "no anchor".
   */
  anchorStrictKeySkipReason(sessionId: string): string | null {
    return this.resolveAnchorKeying(sessionId).refusal ?? null;
  }

  /**
   * PUBLIC access to the session-scoped keying resolution (positional membership):
   * branch.routes + services/positionalMint key `branch_positions` through THIS
   * — the same choke point the strict-keying rule guards — rather than re-deriving a key.
   */
  resolveSessionScopedKeying(sessionId: string): AnchorKeying {
    return this.resolveAnchorKeying(sessionId);
  }

  /**
   * The key candidates for the branch POSITION (positional membership) —
   * since an earlier task a single key: THE CONNECTION IDENTITY, never the resolved DB
   * session id.
   *
   * WHY (measured on prod 2026-08-13): a POSITION belongs to a LOOP — one
   * agent's working thread, identified by its stable connection id. The resolved DB session
   * does NOT identify a loop: under MANDREL_SESSION_RESOLVER_MODE=actor, resolveSession
   * keys sessions by ACTOR (newest-open), and ensureSessionForActor / getActiveSession
   * cache that ONE shared session under EVERY connection the actor calls from. This method
   * used to prefer that resolved session id as the position key, so two concurrent Builders
   * (distinct X-Connection-IDs, same X-Actor-ID) shared one position row: a task claim by
   * one stamped false DECLARED-tier `informs` edges onto the other's completion writes
   * (edges cf9911a9, 2c8c796d — both pruned), and one branch_close cleared both. Keying by
   * the connection id keeps every key the caller's OWN in every resolver mode.
   *
   * The old session-id preference existed to bridge lazy session creation (a branch_open
   * before the first write had only the connection id). Connection-keying dissolves that
   * problem instead of bridging it: the key is stable for the connection's whole life, so
   * the multi-key convergence dance is no longer needed (the list shape remains — it is
   * the seam the store wrappers consume). Rows written under the old session-id keys are
   * unreachable after this change and are purged by migration 083.
   *
   * STRICT MODE: the refusal population is resolveAnchorKeying's, unchanged — a connection
   * with no resolved session gets no position under strict keying. (A header-less caller
   * collapsed onto a shared transport literal shares that literal key exactly as it shared
   * the anonymous actor's session before — no better, no worse; the project-scope guard is
   * what rejects unidentified writes.)
   */
  resolvePositionKeys(connectionId: string): { keys: string[]; refusal?: undefined } | { keys?: undefined; refusal: string } {
    const single = this.resolveAnchorKeying(connectionId);
    if (single.refusal !== undefined) return { refusal: single.refusal };
    // Position is PER-LOOP. single.key (the RAM-resolved DB session) is deliberately NOT
    // used — in actor mode it is shared actor-wide. The connection id alone is not enough
    // either: it identifies a TRANSPORT, and one transport carries many
    // agents. The ladder that separates them is config/positionKeyConfig.ts, applied here
    // and nowhere else; the declared loop id and the actor ride the ambient scope for the
    // same reason the actor already did — this is the one consumer, reached from four call
    // sites that carry a connection id and nothing else.
    const scope = currentProjectScope();
    return {
      keys: [composePositionKey({ connectionId, actor: scope?.actor, loopId: scope?.loopId })],
    };
  }

  /**
   * Initialize session with default project (if available)
   */
  async initializeSession(sessionId: string = this.defaultSessionId): Promise<ProjectInfo | null> {
    logger.info(`🔄 Initializing session: ${sessionId}`);

    // Get all projects first
    const projects = await this.listProjects(false);
    if (projects.length === 0) {
      logger.info('⚠️  No projects available');
      return null;
    }

    // Priority 0: Check if user manually switched - respect their choice!
    const sessionState = this.sessionStates.get(sessionId);
    // PROJECT-SCOPE: rung3 — initializeSession IS rung-3 machinery: it decides what to WRITE
    // into the interactive slot. Reading the effective scope here would make it compare the
    // binding against the primary project and then overwrite the human's slot on that basis;
    // a binding must never mutate rung 3 (services/projectBinding.ts: "this module deliberately
    // does not touch rung 3's storage at all").
    const existing = await this.getInteractiveProjectId(sessionId);

    if (sessionState?.manualOverride && existing) {
      const manualProject = await this.getProject(existing);
      if (manualProject) {
        logger.info(`✅ Respecting manual project switch: ${manualProject.name}`);
        return { ...manualProject, isActive: true };
      }
    }

    // Priority 1: Check for primary project (respects user's default preference)
    const primaryProject = projects.find(p => p.metadata && p.metadata.is_primary === true);

    if (primaryProject) {
      logger.info(`✅ Found primary project: ${primaryProject.name}`);

      // Check if we're already on the primary project
      if (existing === primaryProject.id) {
        logger.info(`✅ Already on primary project: ${primaryProject.name}`);
        return { ...primaryProject, isActive: true };
      }

      // Switch from cached project to primary
      if (existing) {
        const old = await this.getProject(existing);
        logger.info(`🔄 Switching from ${old?.name} to primary project: ${primaryProject.name}`);
      }

      this.setCurrentProject(primaryProject.id, sessionId);
      return { ...primaryProject, isActive: true };
    }

    // Priority 2: No primary - check cached session state
    if (existing) {
      const project = await this.getProject(existing);
      if (project) {
        logger.info(`✅ Using cached project: ${project.name} (no primary set)`);
        return project;
      }
    }

    // Priority 3: Fall back to system defaults
    let defaultProject = projects.find(p => p.name === 'aidis-bootstrap');
    if (defaultProject) {
      logger.info(`✅ Using system default project: ${defaultProject.name}`);
    } else {
      // Priority 4: Use first available project.
      //
      // ORDERING DECIDES THE SUBJECT HERE, so in tests this is a defect, not a default
      // (measured by the L7 lane). `listProjects` orders by updated_at DESC,
      // so an unbound connection lands in whichever project the DATABASE touched last. In
      // production that is the legitimate way an unbound client gets a project at all and is
      // left exactly as it was; under NODE_ENV=test it announces itself instead, naming the
      // connection and what it would have silently picked. The rule, the measurement and the
      // reason it is keyed on NODE_ENV alone: config/ambientProjectFallbackConfig.ts.
      defaultProject = projects[0];
      if (ambientProjectFallbackIsLoud()) {
        throw new AmbientProjectFallbackError(sessionId, defaultProject.name, projects.length);
      }
      logger.info(`✅ Using first available project: ${defaultProject.name}`);
    }

    this.setCurrentProject(defaultProject.id, sessionId);
    logger.info(`✅ Session initialized with project: ${defaultProject.name}`);

    return { ...defaultProject, isActive: true };
  }

  /**
   * Update project details
   */
  async updateProject(projectId: string, updates: Partial<CreateProjectRequest>): Promise<ProjectInfo> {
    logger.info(`📝 Updating project: ${projectId}`);

    try {
      // Build dynamic update query
      const updateFields = [];
      const values = [];
      let paramIndex = 1;

      if (updates.name !== undefined) {
        updateFields.push(`name = $${paramIndex}`);
        values.push(updates.name);
        paramIndex++;
      }

      if (updates.description !== undefined) {
        updateFields.push(`description = $${paramIndex}`);
        values.push(updates.description);
        paramIndex++;
      }

      if (updates.status !== undefined) {
        updateFields.push(`status = $${paramIndex}`);
        values.push(updates.status);
        paramIndex++;
      }

      if (updates.gitRepoUrl !== undefined) {
        updateFields.push(`git_repo_url = $${paramIndex}`);
        values.push(updates.gitRepoUrl);
        paramIndex++;
      }

      if (updates.rootDirectory !== undefined) {
        updateFields.push(`root_directory = $${paramIndex}`);
        values.push(updates.rootDirectory);
        paramIndex++;
      }

      if (updates.metadata !== undefined) {
        updateFields.push(`metadata = $${paramIndex}`);
        values.push(JSON.stringify(updates.metadata));
        paramIndex++;
      }

      if (updateFields.length === 0) {
        throw new Error('No update fields provided');
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(projectId);

      const sql = `
        UPDATE projects 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await db.query(sql, values);
      
      if (result.rows.length === 0) {
        throw new Error(`Project ${projectId} not found`);
      }

      const row = result.rows[0];

      // Get current project ID (now async)
      // PROJECT-SCOPE: effective — the `isActive` flag on the record project_update echoes
      // back. Deliberately NOT session-parameterised: updateProject is administration by id
      // and has no connection argument; under a binding this still reports the effective
      // scope, and for an unbound caller it reads the global slot exactly as it always did.
      const currentProjectId = await this.getCurrentProjectId();

      const project: ProjectInfo = {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        gitRepoUrl: row.git_repo_url,
        rootDirectory: row.root_directory,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        isActive: currentProjectId === row.id
      };

      logger.info(`✅ Updated project: ${project.name}`);
      return project;

    } catch (error) {
      logger.error('❌ Failed to update project', error as Error);
      throw new Error(`Failed to update project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Count the rows a project owns in EVERY table the schema cascades from `projects`.
   * Used by deleteProject to make the blast radius explicit BEFORE any destructive
   * action, and by the route to describe a project it is refusing to delete.
   *
   * This used to be four hardcoded COUNTs (contexts / technical_decisions / tasks /
   * sessions) while the schema had twenty-four cascading child tables — so a project
   * owning only, say, `analytics_events` rows measured as EMPTY and was deleted without
   * confirmation. The table set is now derived from `pg_constraint`, which the migration
   * that adds a table cannot avoid updating. Full rationale, including why not simply
   * adding the missing twenty: services/projectCascade.ts.
   */
  async getProjectChildCounts(projectId: string): Promise<ProjectChildCounts> {
    return countProjectChildren(projectId);
  }

  /**
   * Delete a project (by id or name).
   *
   * SAFETY POLICY (deliberate):
   *  - Deleting a project cascades into EVERY table whose FK to `projects` is
   *    ON DELETE CASCADE — twenty-four of them today, and whatever the next migration
   *    adds. We therefore:
   *  - REFUSE to delete a non-empty project unless `confirm === true`, returning the
   *    exact child counts the caller would lose (no mutation on the refusal path).
   *  - REFUSE to delete the currently-active project (avoids pulling it out from
   *    under a live connection).
   *  - REFUSE to delete the last remaining project.
   * An empty project (no children) deletes without requiring confirm.
   *
   * "Empty" is decided by `isProjectEmpty` over the schema-derived counts, NOT by a sum
   * over a hardcoded table list, and NOT by `counts.total > 0` — a total of 0 is also
   * what an UNMEASURABLE project reports, and those two must not share an answer. See
   * services/projectCascade.ts.
   */
  async deleteProject(identifier: string, confirm: boolean = false): Promise<DeleteProjectResult> {
    logger.info(`🗑️  Delete requested for project: "${identifier}" (confirm=${confirm})`);

    const project = await this.getProject(identifier);
    if (!project) {
      throw new Error(`Project "${identifier}" not found`);
    }

    const counts = await this.getProjectChildCounts(project.id);

    // Guard: never delete the last remaining project.
    const allProjects = await this.listProjects(false);
    if (allProjects.length <= 1) {
      return {
        deleted: false,
        // Decided BEFORE the confirm gate: `confirm: true` returns this same refusal, so a
        // consumer must not tell the caller to retry with confirmation.
        reason: 'last_project',
        projectName: project.name,
        counts,
        message:
          `❌ Refusing to delete "${project.name}": it is the last remaining project. ` +
          `At least one project must exist.\n` +
          `Blast radius: ${describeProjectChildCounts(counts)}.`,
      };
    }

    // Guard: never delete the currently-active project out from under a connection.
    // PROJECT-SCOPE: effective — a bound client must not be able to delete the project it is
    // bound to (that is the project its own writes are landing in). Left on the DEFAULT
    // session slot on purpose: the CALLER-scoped half of this guard lives in the route
    // (routes/project.routes.ts handleDelete), which passes its connection id; this one is the
    // handler-level backstop for the global slot and keeping it un-parameterised preserves it.
    const currentProjectId = await this.getCurrentProjectId();
    if (currentProjectId === project.id) {
      return {
        deleted: false,
        // Also decided before the confirm gate — futile to retry; switch project first.
        reason: 'active_project',
        projectId: project.id,
        projectName: project.name,
        counts,
        message:
          `❌ Refusing to delete "${project.name}": it is the currently active project. ` +
          `Switch to another project first (project_switch), then delete.\n` +
          `Blast radius: ${describeProjectChildCounts(counts)}.`,
      };
    }

    // Guard: refuse non-empty (or unmeasurable) deletes without explicit confirmation.
    // NO mutation here. The predicate and the sentence below are the same object read
    // twice — `isProjectEmpty` and `describeProjectChildCounts` both derive from
    // `counts.byTable`, so the message can never name a table the gate did not count.
    if (!isProjectEmpty(counts) && !confirm) {
      return {
        deleted: false,
        // THE ONE RETRYABLE REFUSAL: re-running with { confirm: true } proceeds.
        reason: 'needs_confirmation',
        projectId: project.id,
        projectName: project.name,
        counts,
        message:
          `⚠️  Refusing to delete project "${project.name}" without confirmation.\n` +
          `Deleting it will CASCADE-DELETE ${describeProjectChildCounts(counts)}.\n` +
          `Re-run with { confirm: true } to permanently delete the project and all of the above.`,
      };
    }

    // Perform the delete. FKs cascade automatically.
    // Predicated on the SAME table/column the blast-radius survey keys child rows against
    // (projectCascade.PROJECT_TABLE / PROJECT_ID_COLUMN), so the delete and the thing that
    // measured it cannot come to describe different rows.
    await db.query(
      `DELETE FROM ${PROJECT_TABLE} WHERE ${PROJECT_ID_COLUMN} = $1`,
      [project.id]
    );

    const lostSummary = isProjectEmpty(counts)
      ? ''
      : ` Cascade-removed ${describeProjectChildCounts(counts)}.`;

    logger.info(`✅ Deleted project: ${project.name} (${project.id})${lostSummary}`);

    return {
      deleted: true,
      projectId: project.id,
      projectName: project.name,
      counts,
      message: `✅ Deleted project "${project.name}".${lostSummary}`,
    };
  }
}

// Export singleton instance
export const projectHandler = new ProjectHandler();
