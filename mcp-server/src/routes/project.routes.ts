import { formatRecordRef } from '../config/commandUrlConfig.js';
import { projectHandler } from '../handlers/project.js';
import { boundProjectInForce } from '../services/effectiveProjectScope.js';
import { switchProjectWithValidation } from '../services/projectSwitchValidator.js';
// The ONE renderer for "what does deleting this project destroy". Both sentences below
// come from here so a table can never be named without being counted (see the header of
// services/projectCascade.ts).
import { describeProjectChildCounts } from '../services/projectCascade.js';
// WS2 living summary: the deterministic current-state briefing renderer.
import { buildProjectBriefing, briefingConfig } from '../services/projectBriefing.js';
// SK5: the briefing's selection starts from the reader's open branch.
import { readPositionAny, isTrunkPosition, type SpineType } from '../services/branchPosition.js';
import { resolveSpineRecord, spineLiveness, SPINE_REFUSAL, type SpineRefusal } from '../services/spineResolver.js';
import { danglingSpineRefused } from '../config/danglingSpineConfig.js';
import {
  BRIEFING_SPINE_SOURCE,
  BRIEFING_SPINE_REFUSAL,
  type BriefingSpineSource,
  type BriefingSpineRefusal,
} from '../config/briefingSpineConfig.js';
import { moveRecord } from '../services/reproject.js';
import { idErrorResponse } from '../utils/idResolver.js';
import { formatMcpError, rawValue } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_PERSONAL_PROJECT_NAME } from '../config/defaultProjectConfig.js';

/**
 * Project Management Routes
 * Handles: project_list, project_create, project_switch, project_current, project_info, project_insights
 */
class ProjectRoutes {
  /**
   * Get session ID from context for connection-scoped isolation
   * Uses connectionId if available, otherwise falls back to default
   */
  private getSessionId(context?: RouteContext): string {
    // Use connectionId for session isolation, or fall back to default
    return context?.connectionId || 'default-session';
  }

  /**
   * Build a clean, RAW structuredContent project record (markdown-in-values fix):
   * project name/description are passed through rawValue() so a DB value containing
   * `**bold**` never leaks markup into the machine-readable channel. This is the
   * locked-in root-cause fix for the project_current markdown bug class.
   */
  private toRawProject(project: any): Record<string, any> {
    return {
      id: project.id,
      name: rawValue(project.name),
      description: project.description != null ? rawValue(project.description) : null,
      status: project.status,
      // MEASURED OR ABSENT (folded in under an earlier task): project_list without includeStats
      // never counts, and `?? 0` published a zero nobody measured — the exact number-that-
      // reads-as-clean this task exists to remove. The output schema declares it optional.
      ...(project.contextCount !== undefined ? { contextCount: project.contextCount } : {}),
      isActive: project.isActive ?? undefined,
      gitRepoUrl: project.gitRepoUrl ?? null,
      rootDirectory: project.rootDirectory ?? null,
      metadata: project.metadata ?? {},
      createdAt: project.createdAt ? project.createdAt.toISOString() : undefined,
      updatedAt: project.updatedAt ? project.updatedAt.toISOString() : undefined,
    };
  }

  /**
   * Handle project listing requests
   */
  async handleList(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      logger.info('📋 Project list request received');
      const sessionId = this.getSessionId(context);

      await projectHandler.initializeSession(sessionId); // Ensure session is initialized
      // The sessionId argument is the project_list half of `isActive`
      // ("🟢 (CURRENT)") previously read the GLOBAL 'default-session' slot, so it named a
      // project unrelated to the caller for every non-default connection, bound or not.
      const allProjects = await projectHandler.listProjects(args.includeStats !== false, sessionId, args.includeArchived === true);

      // PAGINATION: the validator supplies a bounded limit (default 20)
      // and optional offset. listProjects() returns the full set (ordered updated_at
      // DESC) and is shared by two internal callers that must keep seeing everything,
      // so we page IN-ROUTE rather than changing the handler signature — the project
      // set is small enough that an in-memory slice is cheap, and it lets us report an
      // HONEST `total` (full count) vs `returned` (this page) without a second query.
      const total = allProjects.length;
      const offset = args.offset ?? 0;
      const limit = args.limit; // always present (zod default 20)
      const projects = allProjects.slice(offset, offset + limit);
      const truncated = total > offset + projects.length || offset > 0;

      if (total === 0) {
        return {
          content: [{
            type: 'text',
            text: `No projects found\n\n` +
                  `Create your first project with: project_create`
          }],
          structuredContent: { ok: true, results: [], total: 0, returned: 0, offset, limit },
        };
      }

      const projectList = projects.map((project, index) => {
        const isActive = project.isActive ? ' (CURRENT)' : '';
        const stats = project.contextCount !== undefined
          ? ` | Contexts: ${project.contextCount}`
          : '';

        // VALUE-CLEANING: name + description are short,
        // DB-sourced IDENTIFIER values rendered inline — run them through rawValue()
        // BEFORE the literal `**` wrapper so a name literally stored as `**x**` shows
        // as clean text, not `****x****`. (Same source-channel fix as project_current.)
        // WS1 (D2): no bold markup, no per-row permalink line
        // (structuredContent carries the raw project rows).
        return `${offset + index + 1}. ${rawValue(project.name)}${isActive}\n` +
               `   Description: ${project.description ? rawValue(project.description) : 'No description'}\n` +
               `   Status: ${project.status}${stats}\n` +
               `   ID: ${project.id}`;
      }).join('\n\n');

      // Honest truncation note — never silently drop rows.
      const truncationNote = truncated
        ? `\n\nShowing ${projects.length} of ${total}` +
          (offset > 0 ? ` (offset ${offset})` : '') +
          ` — page with limit/offset (e.g. project_list limit:${limit} offset:${offset + limit}).`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Projects (${projects.length} of ${total})\n\n${projectList}${truncationNote}\n\n` +
                `Switch projects with: project_switch <name-or-id>`
        }],
        structuredContent: {
          ok: true,
          results: projects.map((p) => this.toRawProject(p)),
          total,
          returned: projects.length,
          offset,
          limit,
          truncated,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_list');
    }
  }

  /**
   * Handle project create requests
   */
  async handleCreate(args: any): Promise<McpResponse> {
    try {
      logger.info(`🆕 Project create request: "${args.name}"`);

      const project = await projectHandler.createProject({
        name: args.name,
        description: args.description,
        status: args.status,
        gitRepoUrl: args.gitRepoUrl,
        rootDirectory: args.rootDirectory,
        metadata: args.metadata
      });

      return {
        content: [{
          type: 'text',
          // VALUE-CLEANING: project name is a DB-sourced identifier
          // rendered inline → rawValue() so stored markup never prints literal `**`.
          text: `Project created: "${rawValue(project.name)}" (${project.status}) — ID ${project.id}\n` +
                `${formatRecordRef(project.id)}`,
        }],
        structuredContent: { action: 'created', project: this.toRawProject(project) },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_create');
    }
  }

  /**
   * Handle project switching requests with TS012 validation framework
   */
  async handleSwitch(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const sessionId = this.getSessionId(context);
      logger.info(`🔄 [TS012] Project switch request: "${args.project}" (session: ${sessionId})`);

      // Use enhanced validation switching (now from projectSwitchValidator to avoid circular dependency)
      const project = await switchProjectWithValidation(args.project, sessionId);

      // Log successful switch for metrics and monitoring
      const switchMetrics = {
        sessionId,
        targetProject: args.project,
        switchSuccessful: true,
        timestamp: new Date(),
        validationPassed: true
      };

      logger.info(`✅ [TS012] Project switch metrics`, { metadata: { switchMetrics } });

      return {
        content: [{
          type: 'text',
          text: `Switched to project: ${rawValue(project.name)} (${project.status})`,
        }],
        structuredContent: { action: 'switched', project: this.toRawProject(project) },
      };
    } catch (error) {
      logger.error(`❌ [TS012] Project switch failed`, error as Error);

      // Log failed switch for metrics and monitoring
      const errorMetrics = {
        sessionId: this.getSessionId(context),
        targetProject: args.project,
        switchSuccessful: false,
        timestamp: new Date(),
        error: error instanceof Error ? error.message : String(error)
      };

      logger.info(`❌ [TS012] Project switch error metrics`, { metadata: { errorMetrics } });

      // Try to provide helpful error message based on error type
      let userFriendlyMessage = `Failed to switch to project "${args.project}"`;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('not found')) {
        userFriendlyMessage += `\n\nTroubleshooting:\n` +
          `- Check if the project name is spelled correctly\n` +
          `- Use \`project_list\` to see available projects\n` +
          `- Create the project first with \`project_create\``;
      } else if (errorMessage.includes('Pre-switch validation failed')) {
        userFriendlyMessage += `\n\nValidation Issues:\n` +
          `- Session state may be inconsistent\n` +
          `- Try again in a few moments\n` +
          `- Contact support if problem persists`;
      } else if (errorMessage.includes('Atomic switch failed')) {
        userFriendlyMessage += `\n\nSwitch Process Issues:\n` +
          `- The switch was safely rolled back\n` +
          `- Your previous project setting is preserved\n` +
          `- Try again or contact support`;
      }

      return {
        content: [{
          type: 'text',
          text: `${userFriendlyMessage}\n\n` +
                `Error Details: ${errorMessage}`
        }],
        isError: true,
        structuredContent: { ok: false, action: 'switch_failed', error: errorMessage, target: args.project },
      };
    }
  }

  /**
   * The BINDING PROVENANCE block appended to project_current's answer.
   *
   * under a binding, project_current reports the EFFECTIVE SCOPE, NAMES
   * the binding as its source, and shows rung 3 ALONGSIDE — so the two are legible rather
   * than conflated. This matters because the product's own shipped instructions
   * (config/projectEchoConfig.ts) tell every client to call project_current to find out
   * where its writes will land; answering with rung 3 while writing to the binding is the
   * bug this task exists to close.
   *
   * Returns '' for the overwhelmingly common UNBOUND caller, so their output is
   * byte-identical to before.
   */
  private async bindingProvenance(sessionId: string, effectiveId: string): Promise<{
    text: string;
    structured: Record<string, any>;
  }> {
    const bound = await boundProjectInForce();
    if (!bound) {
      return { text: '', structured: { scopeSource: 'interactive', bound: false } };
    }

    // PROJECT-SCOPE: rung3 — deliberately the INTERACTIVE slot: this line's whole purpose is
    // to show the human path SEPARATELY from the effective scope, so the two are legible.
    // A pure read (no initializeSession) — never pin rung 3 as a side effect of reporting.
    const interactive = await projectHandler.getInteractiveProject(sessionId);

    const lines = [
      `   🔗 scope source: ${bound.originLabel} — this client is BOUND to ` +
        `${rawValue(bound.name)}, and every read and write is scoped there.`,
      `   👤 interactive slot (project_switch): ` +
        (interactive ? rawValue(interactive.name) : 'unset') +
        (interactive && interactive.id !== effectiveId
          ? ' — NOT in effect while the binding is set'
          : ''),
    ];

    return {
      text: `\n${lines.join('\n')}`,
      structured: {
        scopeSource: 'binding',
        bound: true,
        bindingOrigin: bound.origin,
        bindingOriginLabel: bound.originLabel,
        interactiveProject: interactive
          ? { id: interactive.id, name: rawValue(interactive.name) }
          : null,
      },
    };
  }

  /**
   * Handle current project requests.
   *
   * Reports the EFFECTIVE project scope. `getCurrentProject` is the
   * binding-aware accessor, so a bound client is told the project its writes actually land
   * in — and the binding provenance block above makes the source explicit.
   */
  // ⚠️ WS1 MACHINE-LEAN EXEMPTION: this handler's TEXT is deliberately
  // UNCHANGED (including the `🟢 Current Project:` line). It is the ONE MCP text response a
  // human-facing consumer PARSES: the Command UI frontend's parseAidisProjectName
  // (mandrel-command/frontend/src/contexts/projectResolution.ts) regex-extracts the project
  // name from `Current project: ...`. Do not restyle this surface without migrating that
  // parser to the structured channel first.
  async handleCurrent(_args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const sessionId = this.getSessionId(context);
      logger.info(`🔍 Current project request received (session: ${sessionId})`);

      // PROJECT-SCOPE: effective — project_current answers "where do my writes land", which
      // an earlier decision binds to the effective scope, not the interactive slot.
      const project = await projectHandler.getCurrentProject(sessionId);

      if (!project) {
        await projectHandler.initializeSession(sessionId);
        // PROJECT-SCOPE: effective — re-read after auto-selection; same question, same rung.
        const initializedProject = await projectHandler.getCurrentProject(sessionId);

        if (!initializedProject) {
          return {
            content: [{
              type: 'text',
              text: `No project exists yet, so there is nothing to create first.\n\n` +
                    `The next write (context_store, task_create, decision_record) will land in the default project "${DEFAULT_PERSONAL_PROJECT_NAME}", created automatically.`
            }],
            structuredContent: { ok: true, found: false, defaultProject: DEFAULT_PERSONAL_PROJECT_NAME },
          };
        }

        const prov = await this.bindingProvenance(sessionId, initializedProject.id);
        return {
          content: [{
            type: 'text',
            text: `🟢 Current Project: ${rawValue(initializedProject.name)} (auto-selected, ${initializedProject.status})` + prov.text,
          }],
          structuredContent: {
            found: true,
            autoSelected: true,
            project: this.toRawProject(initializedProject),
            ...prov.structured,
          },
        };
      }

      const prov = await this.bindingProvenance(sessionId, project.id);
      return {
        content: [{
          type: 'text',
          text: `🟢 Current Project: ${rawValue(project.name)} (${project.status})` + prov.text,
        }],
        structuredContent: {
          found: true,
          project: this.toRawProject(project),
          ...prov.structured,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_current');
    }
  }

  /**
   * Handle project info requests
   */
  async handleInfo(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      logger.info(`🔍 Project info request: "${args.project}"`);

      // Caller-scoped `isActive`, same global-slot fix as handleList.
      const project = await projectHandler.getProject(args.project, this.getSessionId(context), args.includeArchived === true);

      if (!project) {
        return {
          content: [{
            type: 'text',
            text: `Project "${args.project}" not found\n\n` +
                  `List all projects with: project_list`
          }],
          structuredContent: { ok: true, found: false },
        };
      }

      const metadataInfo = Object.keys(project.metadata).length > 0
        ? `\nMetadata:\n${Object.entries(project.metadata).map(([k, v]) => `   ${k}: ${v}`).join('\n')}`
        : '';

      return {
        content: [{
          type: 'text',
          // VALUE-CLEANING (whole-class): name + description are short
          // DB-sourced identifier values rendered inline → rawValue() at the source so
          // markup stored in data never renders as literal `**` in the human text.
          // WS1 (D2): machine-lean detail block — no emoji/bold; the
          // permalink rides structuredContent.project.
          text: `Project Information: ${rawValue(project.name)}${project.isActive ? ' (CURRENT)' : ''}\n\n` +
                `Description: ${project.description ? rawValue(project.description) : 'No description'}\n` +
                `Status: ${project.status}\n` +
                `Contexts: ${project.contextCount || 0}\n` +
                `Git Repo: ${project.gitRepoUrl || 'None'}\n` +
                `Root Directory: ${project.rootDirectory || 'None'}\n` +
                `Created: ${project.createdAt.toISOString().split('T')[0]}\n` +
                `Updated: ${project.updatedAt.toISOString().split('T')[0]}\n` +
                `ID: ${project.id}${metadataInfo}\n\n` +
                `${project.isActive ? 'This is your current active project' : 'Switch to this project with: project_switch ' + rawValue(project.name)}`
        }],
        structuredContent: { found: true, project: this.toRawProject(project) },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_info');
    }
  }

  /**
   * Handle project update requests (name, description, status, etc.)
   * Identifies the project by id or name (like project_switch).
   */
  async handleUpdate(args: any): Promise<McpResponse> {
    try {
      logger.info(`📝 Project update request: "${args.project}"`);

      // Resolve project by id or name first.
      const existing = await projectHandler.getProject(args.project);
      if (!existing) {
        return {
          content: [{
            type: 'text',
            text: `Project "${args.project}" not found\n\n` +
                  `List all projects with: project_list`
          }],
        };
      }

      // Guard against renaming onto an existing project's name.
      if (args.name !== undefined && args.name !== existing.name) {
        const collision = await projectHandler.getProject(args.name);
        if (collision && collision.id !== existing.id) {
          return {
            content: [{
              type: 'text',
              text: `Cannot rename to "${args.name}": a project with that name already exists\n\n` +
                    `Choose a different name or list projects with: project_list`
            }],
          };
        }
      }

      // Build the set of fields actually provided.
      const updates: Record<string, any> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.gitRepoUrl !== undefined) updates.gitRepoUrl = args.gitRepoUrl;
      if (args.rootDirectory !== undefined) updates.rootDirectory = args.rootDirectory;
      if (args.metadata !== undefined) updates.metadata = args.metadata;

      if (Object.keys(updates).length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No update fields provided\n\n` +
                  `Provide at least one of: name, description, status, gitRepoUrl, rootDirectory, metadata`
          }],
        };
      }

      const project = await projectHandler.updateProject(existing.id, updates);

      return {
        content: [{
          type: 'text',
          text: `Project updated: ${rawValue(project.name)} (${project.status}) — ID ${project.id}\n` +
                `${formatRecordRef(project.id)}`,
        }],
        structuredContent: {
          action: 'updated',
          project: this.toRawProject(project),
          updatedFields: Object.keys(updates),
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_update');
    }
  }

  /**
   * Handle project delete requests.
   *
   * DESTRUCTIVE: every project FK is ON DELETE CASCADE, so deletion wipes all
   * owned contexts/decisions/tasks/sessions. The handler delegates the safety
   * policy (refuse non-empty without confirm; refuse active/last project) to
   * projectHandler.deleteProject and formats the outcome.
   */
  async handleDelete(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      logger.info(`🗑️  Project delete request: "${args.project}" (confirm=${args.confirm === true})`);

      // Resolve first so we can compare against the active project for THIS session.
      const existing = await projectHandler.getProject(args.project);
      if (!existing) {
        return {
          content: [{
            type: 'text',
            text: `Project "${args.project}" not found\n\n` +
                  `List all projects with: project_list`
          }],
        };
      }

      // Connection-scoped active-project guard (the handler also checks the
      // default-session current project; this catches per-connection switches).
      const sessionId = this.getSessionId(context);
      // PROJECT-SCOPE: effective — refuse to delete the project THIS caller is actually
      // scoped to. For a bound client that is the binding, which is exactly the project its
      // live writes are landing in.
      const sessionCurrentId = await projectHandler.getCurrentProjectId(sessionId);
      if (sessionCurrentId === existing.id) {
        const counts = await projectHandler.getProjectChildCounts(existing.id);
        // ONE string, both channels — same reason as the delete_refused branch below.
        // This branch used to return the prose ONLY, with no structuredContent, so
        // ensureStructuredContent synthesised a bare `{ok:true}`. A machine consumer (the
        // Command UI backend) then saw a payload with no recognised action,
        // correctly failed closed, and surfaced an opaque 500 with NO reason — the user was
        // told the delete failed but not that it failed because this is their active
        // project, which is the one refusal they can act on themselves.
        const message =
          `Refusing to delete "${rawValue(existing.name)}": it is the active project for this session.\n\n` +
          `Owned data: ${describeProjectChildCounts(counts)}.\n` +
          `Switch to another project first: project_switch <other-project>`;
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: {
            action: 'delete_refused',
            deleted: false,
            counts,
            message,
            // Distinguishes "switch project and retry" from "pass confirm:true", which are
            // different user actions behind the same `delete_refused` action.
            reason: 'active_project',
          },
        };
      }

      const result = await projectHandler.deleteProject(args.project, args.confirm === true);

      if (!result.deleted) {
        // No footer of its own: EVERY refusal message the handler returns already carries
        // describeProjectChildCounts(counts), so a second rendering here would be the same
        // sentence twice — and a second place for the wording to drift.
        // `message` is the SAME string as the text channel above — echoed, not re-rendered.
        // A non-MCP consumer of this gate (the Command UI backend, which
        // delegates its `DELETE /api/projects/:id` here) reads structuredContent only; the
        // prose channel is discarded by McpService. Without this field that consumer would
        // hold `counts` and no sentence, and would have to compose its own — a SECOND
        // renderer of the blast radius, which is precisely what projectCascade.ts exists to
        // prevent. One `result.message`, two channels, no second source.
        return {
          content: [{ type: 'text', text: result.message }],
          structuredContent: {
            action: 'delete_refused',
            deleted: false,
            counts: result.counts,
            message: result.message,
            // Relayed from the handler, which is where the refusal was actually decided.
            // Two of the three refusals it can return (last_project, active_project) are
            // settled BEFORE the confirm gate, so a consumer that assumes every refusal is
            // retryable will tell the user to confirm when confirming cannot help.
            reason: result.reason,
          },
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Deleted project — ID ${result.projectId}`,
        }],
        structuredContent: {
          action: 'deleted',
          deleted: true,
          project: { id: result.projectId },
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_delete');
    }
  }

  /**
   * PROJECT BRIEFING (WS2 "living summary", plan 4333eaae).
   * Deterministic current-state briefing markdown — the whole renderer lives in
   * services/projectBriefing.ts; this route only resolves the project and ships the
   * result on both channels. `project` optional → the caller's current project.
   *
   * `spine` optional (FIX A) → render THIS branch instead of whatever branch the connection
   * happens to be standing on. It exists because SK5's position-only selection is
   * unreachable for the client that needs it most: a position is keyed on CONNECTION ID, and
   * the SessionStart boot hook is a separate shell client from the MCP bridge that holds the
   * session's position. Same project, different connection slot, so the hook could never see
   * its own branch. See config/briefingSpineConfig.ts for the precedence and refusal rules.
   */
  async handleBriefing(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const sessionId = this.getSessionId(context);
      let project;
      if (args.project) {
        project = await projectHandler.getProject(args.project, sessionId);
      } else {
        await projectHandler.initializeSession(sessionId);
        // PROJECT-SCOPE: effective — the briefing's default project is the caller's
        // EFFECTIVE scope: under a binding the briefing must describe the bound project,
        // never the interactive slot (an injection built from the wrong project is the
        // exact wrong-project hazard the binding exists to prevent).
        project = await projectHandler.getCurrentProject(sessionId);
      }
      if (!project) {
        return {
          content: [{
            type: 'text',
            text: args.project
              ? `Project "${args.project}" not found\n\nList all projects with: project_list`
              : 'No current project set — pass `project`, or switch first with project_switch',
          }],
          structuredContent: { ok: true, found: false },
        };
      }

      // THE READER'S SPINE (SK5). The briefing is scoped to the branch this
      // caller is standing on IN THIS PROJECT — readPositionAny is project-keyed, so a
      // position held on some other project cannot leak in.
      //
      // THREE WAYS THIS IS null, all of them the documented trunk fallback and none of them
      // an error: strict keying refuses this connection a position at all; no position row
      // exists; or the row is origin='trunk' (which retains spine_id as provenance of what
      // the session reverted FROM — reading it as a place the reader is standing would scope
      // the briefing to a branch they explicitly left).
      // FLAG OFF (the shipped default) => the position is never even READ. The renderer
      // refuses the spine on its own (services/projectBriefing.ts applySelectionFlag), so
      // this is not the enforcement point — it is the query we do not need to run.
      //
      // FIX A adds the EXPLICIT spine argument, and the order below is the whole design:
      // the flag is checked FIRST, so no argument can reach the branch machinery on a
      // flag-off deployment; then an explicit spine; then, only in its absence, the position.
      const branchScopeEnabled = briefingConfig().branchScopeEnabled;
      const rawSpine = typeof args.spine === 'string' ? args.spine.trim() : '';
      let spineId: string | null = null;
      // Carried beside spineId ONLY so the archived read below can name the right table.
      // Both routes already know it; nothing else consumes it.
      let spineType: SpineType | null = null;
      let spineSource: BriefingSpineSource = BRIEFING_SPINE_SOURCE.none;
      let spineRefusal: BriefingSpineRefusal | SpineRefusal | null = null;

      if (rawSpine !== '' && !branchScopeEnabled) {
        // THE TENANT-PROTECTION PROPERTY. A caller must not be able to route around the
        // default-OFF flag by passing an argument — that would make the flag a lie for every
        // tenant that never set it. Refused, and the refusal is REPORTED: the caller asked
        // for a branch and is getting the global document, and it must not learn that by
        // noticing the section is missing.
        spineRefusal = BRIEFING_SPINE_REFUSAL.flagOff;
      } else if (rawSpine !== '') {
        const resolved = await resolveSpineRecord(rawSpine, project.id);
        if (resolved.ok) {
          // EXPLICIT BEATS AMBIENT (briefingSpineConfig.ts): the position is not even read,
          // so a connection standing somewhere else cannot override what was asked for.
          spineId = resolved.spineId;
          spineType = resolved.spineType;
          spineSource = BRIEFING_SPINE_SOURCE.explicit;
        } else {
          // HONEST, TYPED, NEVER SILENT. An unresolvable / other-project spine falls back to
          // the trunk render — which is the useful answer for a boot hook holding a stale id
          // — but the reason rides in a field, so "I got the global document" and "the branch
          // you named does not exist here" are never the same observation.
          spineRefusal = resolved.reason;
        }
      } else if (branchScopeEnabled) {
        const keying = projectHandler.resolvePositionKeys(sessionId);
        if (keying.keys !== undefined) {
          const position = await readPositionAny(project.id, keying.keys);
          if (position && !isTrunkPosition(position)) {
            // THE AMBIENT SPINE GETS THE SAME LIVENESS RULE AS THE EXPLICIT ONE (an earlier task
            // , N4). Two paths reach this variable and only one of them validated —
            // the C5 shape, and the weaker path is the one a COLD BOOT takes, because the
            // boot hook asks for a briefing without naming a spine. MEASURED with
            // MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED=true, same id, both routes:
            //
            //   spine passed EXPLICITLY, record deleted -> spineId null, source 'none',
            //                                              refusal 'spine-not-found'
            //   same id arriving AS THE POSITION        -> spineId <the dead id>,
            //                                              source 'position', refusal NULL
            //
            // So the caller that named the id was told it was gone, and the caller that did
            // not name it got the whole briefing silently scoped to a record that does not
            // exist — with `spineRefusal` reading null, which a client is entitled to read as
            // "nothing went wrong". Reusing SPINE_REFUSAL.notFound rather than inventing a
            // second reason string is the point: one vocabulary, so a consumer that already
            // handles the explicit refusal handles this one for free.
            //
            // ARCHIVED IS DELIBERATELY NOT REFUSED, and that is measured too, not assumed:
            // the explicit path ACCEPTS an archived spine (source 'explicit', refusal null),
            // so refusing it here would create the very divergence this fix removes — in the
            // opposite direction. It is also the ruling on this task: an archived spine is a
            // real record and its branch still carries the work.
            const ambientLive =
              !danglingSpineRefused() ||
              (await spineLiveness(position.spineId, position.spineType)).exists;
            if (ambientLive) {
              spineId = position.spineId;
              spineType = position.spineType;
              spineSource = BRIEFING_SPINE_SOURCE.position;
            } else {
              spineRefusal = SPINE_REFUSAL.notFound;
            }
          }
        }
      }

      const result = await buildProjectBriefing(project.id, rawValue(project.name), undefined, undefined, spineId);

      // IS THE SPINE THIS BRIEFING WAS SCOPED TO ARCHIVED? (N-b.)
      //
      // branch_current already reports this and the briefing did not, which left the worst
      // caller uninformed: a COLD BOOT takes the ambient route (the hook asks for a briefing
      // without naming a spine), and an archived record answers NOT FOUND to a by-id read
      // under the default includeArchived:false. So the boot package could be scoped to a
      // branch whose spine the reader then cannot look up, with nothing in the response
      // saying why — this task's cause B, arriving where it does the most damage, with the
      // signal stripped.
      //
      // COMPUTED ONCE, FROM THE RENDERER'S ANSWER, FOR BOTH ROUTES. `result.spineId` rather
      // than the local `spineId` for the reason the `spineId` field below already documents:
      // the renderer can refuse a spine on its own, and reporting the REQUEST would re-open
      // that gap. Doing it here rather than inside either branch is also what stops the two
      // routes disagreeing about archived the way they disagreed about deleted — the defect
      // this whole area was rejected over twice.
      //
      // null (not false) when there is no spine: "not archived" and "there is nothing to ask
      // about" are different answers, and a caller branching on a bare false would render the
      // second as the first.
      const spineArchived =
        result.spineId !== null && spineType !== null
          ? (await spineLiveness(result.spineId, spineType)).archived
          : null;

      return {
        // The briefing markdown IS the payload — the text channel carries it verbatim
        // (it is built for injection into hooks/prompts, machine-lean by construction).
        content: [{ type: 'text', text: result.markdown }],
        structuredContent: {
          ok: true,
          found: true,
          briefing: {
            projectId: project.id,
            projectName: rawValue(project.name),
            markdown: result.markdown,
            sizeChars: result.markdown.length,
            droppedRecords: result.droppedRecords,
            // THE TWO KINDS OF ABSENCE, AS SEPARATE FIELDS (P5.1). `droppedRecords` is their
            // sum and stays exactly where it was for callers already reading it; these two
            // are what make it actionable. `excludedBySelection` is a rule choosing — the
            // reader can inspect the rule and re-tune it. `evictedByCap` is the budget
            // running out, which nobody chose, and it is the number that must stay near zero:
            // a briefing where it is large is a briefing whose content is decided by its size.
            excludedBySelection: result.excludedBySelection,
            evictedByCap: result.evictedByCap,
            // How many reserved full-prose slots existed, were granted, and were DENIED (the
            // record consumed its slot and rendered a reason instead of a body). A field, so
            // "no slot was denied" is distinguishable from "the renderer stopped emitting
            // denials" — the same reason `census` and `handoffHead` are fields.
            fullProse: result.fullProse,
            included: result.included,
            // WHICH BRANCH THIS RENDER WAS SCOPED TO — a field, so a caller (and a contract
            // test) can assert the selection that happened rather than infer it from the
            // markdown. null = trunk / unpositioned / strict-keying refusal.
            //
            // READ THE RENDERER'S ANSWER, NOT THE ROUTE'S REQUEST. `result.spineId` is what
            // the render actually scoped to; the local `spineId` is only what was asked for.
            // The renderer refuses a spine on its own when the flag is off
            // (projectBriefing.ts applySelectionFlag), so reporting the request here would
            // re-open exactly the gap this field was added to close.
            spineId: result.spineId,
            // WHERE THE SPINE CAME FROM, and WHY one was not used — fields, not prose
            // (config/briefingSpineConfig.ts). `spineSource` is downgraded to `none` if the
            // renderer declined the spine, so source and spineId can never disagree.
            spineSource: result.spineId === null ? BRIEFING_SPINE_SOURCE.none : spineSource,
            spineRefusal,
            // Parity with branch_current's position.spineArchived / revertedFrom.spineArchived:
            // whatever surface tells you WHERE you are must also tell you whether a by-id read
            // of it will come back empty. See the derivation above.
            spineArchived,
            census: result.data.census,
            // WHICH HANDOFF WAS SERVED AND HOW IT WAS CHOSEN (P5.2) — fields, not prose.
            // A caller must be able to tell RESOLVED from REFUSED from ABSENT without
            // reading the markdown: `status` is the three-state answer, `concurringSeeds`
            // and `walks[].hops` are the provenance of a resolution, and `refusal` +
            // `candidates` are what a refusal owes the reader. Passed through whole rather
            // than re-shaped here — a second spelling of this object is a second thing to
            // keep in step (services/handoffHead.ts owns the shape).
            handoffHead: result.data.handoffHead,
          },
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_briefing');
    }
  }

  /**
   * project_move_record — MOVE a record into another project.
   *
   * The route is deliberately thin: the whole judgement (which denormalized project_id
   * columns follow a move, and what happens to an edge whose other endpoint stays behind)
   * lives in services/reproject.ts + config/reprojectConfig.ts, where it is testable
   * without a route and can never be half-re-implemented here.
   *
   * NO `confirm` GATE, on purpose. A move destroys nothing and is undone by moving the
   * record back — it is not in the class `project_delete` is in, and a confirmation on a
   * reversible action trains callers to click through the ones that matter.
   */
  async handleMoveRecord(args: any): Promise<McpResponse> {
    try {
      const result = await moveRecord({
        recordType: args.recordType,
        recordId: args.recordId,
        toProject: args.toProject,
      });

      // ONE sentence, both channels. It states what MOVED and what deliberately did not,
      // because the things a move leaves behind (a cross-project edge, a stranded position)
      // are precisely the ones a caller would otherwise discover three sessions later.
      const to = `"${rawValue(result.toProject.name)}" (${result.toProject.id})`;
      const from = `"${rawValue(result.fromProject.name)}" (${result.fromProject.id})`;
      const head = result.moved
        ? `Moved ${result.recordType} ${result.recordId} from ${from} to ${to} — ` +
          `same id, same created_at, same edges.`
        : `${result.recordType} ${result.recordId} is already in ${to} — nothing moved.`;

      const lines = [head];
      if (result.moved) {
        for (const s of result.satellites) lines.push(`• ${s.table}: ${s.rows} row(s) followed`);
        lines.push(
          `• edges: ${result.edges.touched} touched — ${result.edges.restamped} re-stamped to the ` +
            `destination, ${result.edges.crossProject} now cross-project (kept, marked), ` +
            `${result.edges.dangling} dangling (untouched)`,
        );
        if (result.strandedPositions > 0) {
          lines.push(
            `• ${result.strandedPositions} open branch position(s) were left standing on this ` +
              `record in ${from} — a position belongs to the ` +
              `session that opened it, so a move does not relocate it.`,
          );
        }
        lines.push(formatRecordRef(result.recordId));
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ok: true,
          action: result.moved ? 'moved' : 'already_there',
          ...result,
        },
      };
    } catch (error) {
      // A bad/ambiguous record id gets the SAME actionable three-case response every other
      // id-taking tool returns (candidates listed, never picked) rather than a raw throw.
      const idResponse = idErrorResponse(
        error,
        'project_move_record',
        args.recordType ?? 'record',
        String(args.recordId ?? ''),
        `${args.recordType ?? 'context'}_search`,
      );
      if (idResponse) return idResponse as McpResponse;
      return formatMcpError(error as Error, 'project_move_record');
    }
  }

  /**
   * Handle project insights requests
   * Note: project_insights is actually handled in search.routes.ts
   * This method is included for completeness but not used in the route dispatcher
   */
  async handleInsights(_args: any): Promise<McpResponse> {
    // This tool is handled by searchRoutes.handleProjectInsights()
    // Included here for type safety but not exposed in routes/index.ts
    return formatMcpError('project_insights is handled by search routes', 'project_insights');
  }
}

export const projectRoutes = new ProjectRoutes();
