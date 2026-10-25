import { tasksHandler } from '../handlers/tasks.js';
import { projectHandler } from '../handlers/project.js';
import { formatMcpError, rawValue } from '../utils/mcpFormatter.js';
import { formatRecordRef } from '../config/commandUrlConfig.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import {
  resolveEntityId,
  AmbiguousIdError,
  IdNotFoundError,
  ambiguousIdMessage,
  idErrorResponse,
} from '../utils/idResolver.js';
import { buildWriteEcho } from '../utils/projectEcho.js';
import {
  autoMintFromTags,
  autoMintFromTaskDependencies,
  mintExplicitLinks,
  mintEdge,
  type LinkWarning,
  type MintSkip,
} from '../services/links.js';
import { TASK_EDGE_MINT_CONFIG, TASK_EDGE_CREATED_BY } from '../config/tagEdgeConfig.js';
import {
  mintPositional,
  setPositionByproduct,
  serializePositionalReport,
  composePositionalBody,
  byproductPositionLines,
  positionalResponseLines,
} from '../services/positionalMint.js';
import { db } from '../config/database.js';
import { taskClaimService, TaskClaimFencedError } from '../services/taskClaim.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { ACTOR_ANONYMOUS, normalizeActor, refineActor } from '../config/actorRegistry.js';
import { assertAgentMayCreateTask } from '../services/agentFoldInGuard.js';
import { cap } from '../config/fieldLimits.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { TASK_NOTE_LOG_KEY, TASK_DESCRIPTION_HISTORY_KEY } from '../config/taskNotes.js';
import { assertDueAtQueryable } from '../services/taskBlockedOnCapability.js';
import { PunchIncompleteError, PunchDependsOnDirectError } from '../services/taskPunchCompleteness.js';
import { splitMetadataPunch, reconcilePunchDependsOn } from '../utils/punchMerge.js';
import { assertClosedAtQueryable } from '../services/taskClosedAtCapability.js';
import { readMembershipOf } from '../services/branchMembership.js';
import type { TaskListOptions } from '../handlers/tasks.js';
import { serializeTask } from '../services/serializers/taskSerializer.js';

/**
 * Task Management Routes
 * Handles: task_create, task_list, task_update, task_details, task_bulk_update, task_progress_summary
 */
class TasksRoutes {
  /**
   * Resolve project ID using connection-scoped session state
   */
  private async resolveProjectId(argsProjectId: string | undefined, context?: RouteContext): Promise<string> {
    if (argsProjectId) return argsProjectId;
    const sessionId = context?.connectionId || 'default-session';
    await projectHandler.initializeSession(sessionId);
    // PROJECT-SCOPE: effective — a route's own project resolution. Under a binding this is
    // the bound project; unbound it is rung 3, exactly as before.
    const projectId = await projectHandler.getCurrentProjectId(sessionId);
    if (!projectId) throw new Error('No current project set. Use project_switch to set an active project.');
    return projectId;
  }
  /* ═══════════════════════════════════════════════════════════════════════════════════
   * ATOMIC TASK CLAIM (SPEC v1) — shared plumbing
   * ═══════════════════════════════════════════════════════════════════════════════════ */

  /**
   * Resolve the ATTRIBUTION actor for a claim — through the ONE actor choke point,
   * `deriveActor` (closing an earlier note).
   *
   * WHAT THIS LINE USED TO BE, AND WHY IT WAS WRONG:
   *   normalizeActor(args.actor) ?? normalizeActor(context?.actor) ?? ACTOR_ANONYMOUS
   * `args.actor` is a client-supplied TOOL ARGUMENT, and it OUTRANKED the principal derived at
   * the edge — so declared say-so REPLACED verified identity, the exact inversion an earlier decision
   * exists to kill ("declared data may REFINE, never REPLACE, the verified identity").
   * It was the SECOND INSTANCE of the `deriveActor` precedence bug, in a different file, with
   * the precedence flipped the other way (fix the class, not the instance).
   *
   * It also FALSIFIED the composite's namespace invariant, because `normalizeActor` passes the
   * delimiter through by design: a caller could send `actor: '<victim-sub>/<handle>'` and write
   * the VICTIM'S composite actor into `claim_actor` — cross-principal impersonation created by
   * the very feature that promises it cannot happen (the reviewer probe, 2026-07-25).
   *
   * NOW: `refineActor(<the actor derived at the edge>, <caller-declared handle>)`. The declared
   * handle is delimiter-sanitized and de-prioritised — with composites enabled it replaces the
   * HANDLE segment under the caller's own PRINCIPAL (refine), and with them disabled the derived
   * actor simply wins (never replace). A caller with no derivable principal still gets its
   * declared handle, so the static-bearer / dispatcher use-case is preserved.
   *
   * NOT `deriveActor` — `context.actor` is an ALREADY-DERIVED identity, and deriveActor would
   * re-encode it as if it were a raw principal (`operator@x/coordinator` → `operator@x%2Fcoordinator/…`). See the
   * double-derivation warning on refineActor.
   *
   * DELIBERATE BEHAVIOR CHANGE, NOT COVERED BY THE FLAG-OFF PARITY GUARANTEE: unlike everything
   * in actorRegistry.ts, this precedence is corrected in BOTH modes. Gating a security fix
   * behind the feature flag would leave the forgeable-attribution bug live in the shipped
   * default, and the bug pre-dates the flag. The actor recorded is echoed back to the caller in
   * the claim response (`👤 Actor:`), so an argument that was scoped or superseded is visible,
   * never silent.
   *
   * THIS IS ATTRIBUTION ONLY — it is NEVER the lock key (SPEC D2). `assigned_to`/`claim_actor`
   * is a free-form varchar with no FK, so two callers can and do share a name; mutual exclusion
   * is keyed exclusively on the server-minted `claim_id`. That is exactly why falling back to a
   * shared 'anonymous' here is safe.
   */
  private claimActor(args: any, context?: RouteContext): string {
    return normalizeActor(refineActor(context?.actor, args.actor)) ?? ACTOR_ANONYMOUS;
  }

  /**
   * Fail LOUD if the resolved attribution actor cannot fit `tasks.claim_actor` (the reviewer N2).
   *
   * The caller-supplied `actor` argument is zod-capped at the column width, but the DERIVED
   * actor is not — and a composite is `<sub>/<handle>`, so a long OAuth sub plus a handle can
   * exceed it. Postgres varchar does NOT truncate; it raises `22001 value too long`, which
   * would surface to an agent as a raw driver error on an unrelated-looking write. This turns
   * that into an actionable, typed refusal BEFORE the statement runs. The bound is read from
   * the same fieldLimits registry the zod schema uses — one source, no second copy of `200`.
   */
  private claimActorTooLong(actor: string): McpResponse | null {
    const max = cap('tasks.assigned_to');
    if (actor.length <= max) return null;
    return formatMcpError(
      `the attribution actor for this claim is ${actor.length} characters, which exceeds the ` +
        `${max}-character limit of tasks.claim_actor. It is derived from your authenticated ` +
        `principal plus your declared handle (X-Actor-ID / the 'actor' argument) — shorten the ` +
        `declared handle, or omit it to be attributed to your principal alone.`,
      'task_claim'
    );
  }

  /** Resolve a task id (full UUID or short id) or return the actionable not-found response. */
  private async resolveTaskOrError(
    tool: string,
    args: any,
    projectId: string,
  ): Promise<{ id: string } | { response: McpResponse }> {
    try {
      return { id: await resolveEntityId('task', args.taskId, projectId) };
    } catch (e) {
      const handled = idErrorResponse(e, tool, 'task', args.taskId, 'task_list');
      if (handled) return { response: handled };
      throw e;
    }
  }

  /**
   * ATOMIC TASK CLAIM: when the feature is OFF, `claimId`/`force` are accepted (the schema
   * declares them) but INERT. Silently ignoring a param the caller deliberately passed is the
   * class of lie this whole task exists to remove, so say so in the machine channel
   * ([[confirm-only-when-verified]]). Returns {} when there is nothing to disclose.
   */
  private claimInertEcho(args: any): Record<string, any> {
    if (TASK_CLAIM_CONFIG.enabled) return {};
    if (args.claimId === undefined && args.force === undefined) return {};
    return { claimFencing: 'disabled' };
  }

  /** Render a claim conflict in BOTH channels — typed reason + what to do about it. */
  private claimConflictResponse(refusal: any): McpResponse {
    const hint: Record<string, string> = {
      held: `Someone else holds it. Wait for the lease to expire, or pick another task.`,
      'wrong-status': `Only claimable statuses can be claimed. A completed/cancelled task is NOT re-opened by a claim.`,
      archived: `Restore it first: task_restore(taskId="${refusal.taskId}").`,
      'version-stale': `The task changed underneath you — re-read it (task_details) and retry.`,
      'not-found': `Check the id with task_list.`,
      'claim-lost': `Re-acquire it: task claim(taskId="${refusal.taskId}").`,
      disabled: `Ask an operator to set MANDREL_TASK_CLAIM_ENABLED=true.`,
      'lease-out-of-bounds': `Pick a lease between ${TASK_CLAIM_CONFIG.minLeaseSeconds} and ${TASK_CLAIM_CONFIG.maxLeaseSeconds} seconds.`,
      conflict: `Transient race — retry.`,
    };
    return {
      content: [{
        type: 'text',
        text: `${refusal.message}\n\n${hint[refusal.reason] ?? 'See task claim.'}`,
      }],
      structuredContent: {
        ok: true,
        claimed: false,
        reason: refusal.reason,
        taskId: refusal.taskId,
        currentAssignee: refusal.currentAssignee ?? null,
        currentActor: refusal.currentActor ?? null,
        currentStatus: refusal.currentStatus ?? null,
        currentVersion: refusal.currentVersion ?? null,
        expiresAt: refusal.expiresAt ?? null,
      },
    };
  }

  /** Render a fenced ordinary write (task_update / task_delete) as an actionable error. */
  private claimFencedResponse(error: TaskClaimFencedError, tool: string): McpResponse {
    // Reason-specific next step: "re-claim" is only actionable when nobody
    // else holds the task — telling a claim-mismatch caller to claim would just hand it a
    // typed `held` on the next call.
    const hint: Record<string, string> = {
      held: `Acquire it first: task claim(taskId="${error.taskId}") — then pass the returned claimId to ${tool}. A human override is force:true (audited).`,
      'claim-mismatch': `Someone else holds the live claim. Wait for the lease, have the holder release it (task release), or override deliberately with force:true (audited).`,
      'claim-expired': `Your lease ran out but nobody took over. Re-claim it: task claim(taskId="${error.taskId}", allowedStatuses=["todo","in_progress"]) — then retry ${tool} with the NEW claimId.`,
      'claim-lost': `Re-acquire it: task claim(taskId="${error.taskId}") — then retry ${tool} with the NEW claimId.`,
    };
    return {
      content: [{
        type: 'text',
        text: `${error.message}\n\n${hint[error.reason] ?? hint.held}`,
      }],
      isError: true,
      structuredContent: {
        ok: false,
        claimed: false,
        reason: error.reason,
        taskId: error.taskId,
        currentActor: error.holder,
        expiresAt: error.expiresAt ? error.expiresAt.toISOString() : null,
      },
    };
  }

  /**
   * task_claim — acquire (or idempotently re-affirm) the atomic claim on a task.
   *
   * The whole point: `rowCount === 1` from ONE guarded UPDATE is the win; every other caller
   * gets a TYPED conflict instead of a silent overwrite. See services/taskClaim.ts for the
   * statement and why each predicate is load-bearing.
   */
  async handleClaim(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      const resolved = await this.resolveTaskOrError('task_claim', args, projectId);
      if ('response' in resolved) return resolved.response;

      const claimActor = this.claimActor(args, context);
      const tooLong = this.claimActorTooLong(claimActor);
      if (tooLong) return tooLong;

      const result = await taskClaimService.claim({
        taskId: resolved.id,
        projectId,
        actor: claimActor,
        allowedStatuses: args.allowedStatuses,
        expectedVersion: args.expectedVersion,
        leaseSeconds: args.leaseSeconds,
        claimId: args.claimId,
      });

      if (!result.claimed) return this.claimConflictResponse(result);

      // BYPRODUCT POSITION (PHASE 1 spec item b): claiming a task IS
      // starting work on it — the session's branch position moves to this task with no
      // separate ceremony (the D2 principle: the lapse-prone habit is deleted, not taught).
      // Never throws; surfaced below so a position move is visible, never silent.
      const claimPosition = await setPositionByproduct({
        sessionId: context?.connectionId || 'default-session',
        projectId,
        spineId: result.taskId,
        spineType: 'task',
      });
      // ONE renderer for both byproduct sites (SK1 item d) — including the YIELD line when
      // the session is already standing somewhere it opened deliberately.
      const claimPositionLine = byproductPositionLines(claimPosition, result.taskId);

      return {
        content: [{
          type: 'text',
          text: `Task ${result.reentered ? 're-affirmed' : 'claimed'} — ${result.taskId}\n` +
                `Claim ID: ${result.claimId}\n` +
                `Actor: ${result.actor}\n` +
                `Status: ${result.status} | Version: ${result.version}\n` +
                `Lease: ${result.leaseSeconds}s (expires ${result.expiresAt})\n\n` +
                `Carry the claimId on every task_update while you hold the claim: task_update(taskId="${result.taskId}", ` +
                `claimId="${result.claimId}", status="..."). Extend with task renew, hand it back with task release.` +
                claimPositionLine,
        }],
        structuredContent: {
          ok: true,
          claimed: true,
          taskId: result.taskId,
          claimId: result.claimId,
          actor: result.actor,
          version: result.version,
          status: result.status,
          expiresAt: result.expiresAt,
          leaseSeconds: result.leaseSeconds,
          reentered: result.reentered,
          // PHASE 1: the byproduct position this claim opened (null + the
          // reason when it could not be keyed — never silent).
          position: claimPosition.position
            ? { spineId: claimPosition.position.spineId, spineType: claimPosition.position.spineType }
            : null,
          positionRefusal: claimPosition.refusal,
          // SK1 item d: TRUE when this byproduct declined to move a deliberately-opened
          // position. Structured, not only prose — a caller that reads the text line is not
          // the caller this failure mode was measured on.
          positionYielded: claimPosition.yieldedTo !== null,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'task_claim');
    }
  }

  /** task_renew — extend the lease on a claim you hold. Typed `claim-lost` if you no longer do. */
  async handleRenew(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      const resolved = await this.resolveTaskOrError('task_renew', args, projectId);
      if ('response' in resolved) return resolved.response;

      const result = await taskClaimService.renew({
        taskId: resolved.id,
        projectId,
        claimId: args.claimId,
        leaseSeconds: args.leaseSeconds,
      });
      if (!result.claimed) return this.claimConflictResponse(result);

      return {
        content: [{
          type: 'text',
          text: `Claim renewed — ${result.taskId}\n` +
                `Claim ID: ${result.claimId}\n` +
                `New expiry: ${result.expiresAt} (+${result.leaseSeconds}s)`,
        }],
        structuredContent: {
          ok: true,
          claimed: true,
          action: 'renewed',
          taskId: result.taskId,
          claimId: result.claimId,
          actor: result.actor,
          version: result.version,
          expiresAt: result.expiresAt,
          leaseSeconds: result.leaseSeconds,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'task_renew');
    }
  }

  /** task_release — hand the claim back so the next worker can take it. */
  async handleRelease(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      const resolved = await this.resolveTaskOrError('task_release', args, projectId);
      if ('response' in resolved) return resolved.response;

      const result = await taskClaimService.release({
        taskId: resolved.id,
        projectId,
        claimId: args.claimId,
      });
      if (!('released' in result)) return this.claimConflictResponse(result);

      return {
        content: [{
          type: 'text',
          text: `Claim released — ${result.taskId}\nThe task is now claimable by anyone.`,
        }],
        structuredContent: {
          ok: true,
          released: true,
          action: 'released',
          taskId: result.taskId,
          claimId: result.claimId,
          version: result.version,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'task_release');
    }
  }

  /**
   * Handle task creation requests
   */
  async handleCreate(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // AGENT FOLD-IN GATE (REALIGN step 5). FIRST, before any resolution
      // and before the INSERT: a listed agent actor may create a task only when it is tagged
      // for the operator's decision. Throws a classified 403 that the catch below returns in band
      // with its [TASK_CREATE_AGENT_FOLD_IN] code; nothing is written. Empty roster (every
      // tenant, by default) → no-op. See services/agentFoldInGuard.ts for the rule.
      assertAgentMayCreateTask({ actor: context?.actor, tags: args.tags });

      const projectId = await this.resolveProjectId(args.projectId, context);

      // SHORT-ID RESOLUTION for `dependencies`: every OTHER id-taking arg
      // (taskId on update/details/delete, task_ids on bulk) already routes through the ONE
      // shared resolver, but `dependencies` used to pass its raw strings straight into the
      // `dependencies uuid[]` column — so an 8+-hex short id (the form we SHOW everywhere)
      // blew up as a raw Postgres "invalid input syntax for type uuid" cast error. Resolve
      // each dependency (full UUID OR short id) → full UUID, project-scoped, BEFORE the
      // INSERT. An ambiguous / unknown id surfaces as a TOOL-level actionable error (via the
      // centralized idErrorResponse) — never a leaked DB cast error, and nothing is written.
      let resolvedDependencies: string[] | undefined = args.dependencies;
      if (Array.isArray(args.dependencies) && args.dependencies.length > 0) {
        resolvedDependencies = [];
        for (const rawDep of args.dependencies) {
          try {
            resolvedDependencies.push(await resolveEntityId('task', rawDep, projectId));
          } catch (e) {
            const handled = idErrorResponse(e, 'task_create', 'task', String(rawDep), 'task_list');
            if (handled) return handled;
            throw e;
          }
        }
      }

      // DECLARED STRUCTURAL PARENT. `subtask_of` is a record-intrinsic
      // structural claim, so it mints ONLY from this explicit param — never from session
      // position (explicit intent beats position; precedence ladder).
      // Resolved like `dependencies`: full UUID or 8+-hex short id, project-scoped, BEFORE
      // the INSERT — an unknown/ambiguous parent is a typed tool error and nothing is written.
      let resolvedParentTaskId: string | undefined;
      if (args.parentTaskId) {
        try {
          resolvedParentTaskId = await resolveEntityId('task', args.parentTaskId, projectId);
        } catch (e) {
          const handled = idErrorResponse(e, 'task_create', 'task', String(args.parentTaskId), 'task_list');
          if (handled) return handled;
          throw e;
        }
      }

      // THE PUNCH LIST LANE, STRUCTURED.
      // `metadata.punch` (the alternate channel) is folded into the SAME `punch` argument
      // BEFORE either reaches the handler — see splitMetadataPunch for why this must happen
      // ahead of the metadata merge. `dependsOn` is then MIRRORED from `dependencies` (or
      // refused if set directly with no `dependencies` in this same call) — see
      // reconcilePunchDependsOn.
      const split = splitMetadataPunch(args.metadata, args.punch);
      let finalPunch = reconcilePunchDependsOn(
        'task_create',
        split.punch,
        args.dependencies !== undefined,
        resolvedDependencies,
      );
      // CLAUSE 11: a plain task's `dependencies` alone must not synthesize a
      // `metadata.punch` object — on create there is no existing row that could already carry
      // one, so the mirror applies ONLY when this call also named a punch field (via `punch`
      // or `metadata.punch`).
      if (split.punch === undefined && args.dependencies !== undefined) {
        finalPunch = undefined;
      }

      const task = await tasksHandler.createTask(
        projectId,
        args.title,
        args.description,
        args.type,
        args.priority,
        args.assignedTo,
        args.createdBy,
        args.tags,
        resolvedDependencies,
        split.metadata,
        context?.connectionId,
        args.status,
        context?.actor,
        // P5.5 / migration 093. `blockedOn: undefined` (omitted) leaves the INSERT byte-
        // identical to the pre-P5.5 statement; an explicit value on a pre-093 deployment is
        // a TYPED ERROR naming the migration, never a silent drop.
        { blockedOn: args.blockedOn, dueAt: args.dueAt },
        // THE PUNCH LIST LANE (migration 101).
        args.stage,
        finalPunch,
      );

      // Activity tracking is already handled in tasksHandler.createTask()
      // Removed duplicate SessionTrackingMiddleware.trackTaskCreated() call

      // ── TASKS STOP BEING BORN GRAPH LEAVES ────────────────────
      // task_create used to mint NOTHING. Tasks carried task:/decision: tags and had ZERO
      // outbound edges — every edge was INBOUND from contexts that tagged them. Our
      // convention calls the task the SPINE of a thread, and the spine was the one node
      // that could not point at anything (706 tasks affected).
      //
      // Three sources, all through the SAME mintEdge path every other surface uses:
      //   1. threading tags → the source-dependent matrix (config/tagEdgeConfig.ts), with
      //      fromType 'task' so `task:` mints the weak `related_to`, not `informs`.
      //   2. the `dependencies` column → `depends_on` edges (the column-mirror).
      //   3. the explicit `links` param (T5a parity — mintExplicitLinks is source-agnostic).
      //
      // KILL SWITCH: MANDREL_TASK_EDGE_MINT_ENABLED. OFF → this whole block is skipped and
      // task_create behaves exactly as it did before, so a surprise in prod is a flag flip,
      // not a rollback. It gates ONLY the task sources; no pre-existing mint path is affected.
      //
      // NOT DONE HERE, deliberately: anchor auto-threading on task_create. Tasks are
      // routinely created FOR ANOTHER THREAD (filing a follow-up while working something
      // else), so the anchor prior is much weaker for a task than for a capture — and a
      // wrong STRONG edge on the spine is the worst pollution available.
      //
      // ROBUSTNESS: every minter here swallows its own failures (the task is already
      // persisted; a bad tag must never break or roll back the write).
      let tagMint = { minted: 0, attempted: 0, skips: [] as MintSkip[] };
      let depMint = { minted: 0, attempted: 0, skips: [] as MintSkip[] };
      let linkResult = { minted: 0, attempted: 0, warnings: [] as LinkWarning[] };

      if (TASK_EDGE_MINT_CONFIG.enabled) {
        tagMint = await autoMintFromTags({
          fromId: task.id,
          fromType: 'task',
          tags: task.tags,
          projectId,
          createdBy: TASK_EDGE_CREATED_BY.taskTags,
        });
        depMint = await autoMintFromTaskDependencies({
          taskId: task.id,
          dependencies: resolvedDependencies,
          projectId,
          createdBy: TASK_EDGE_CREATED_BY.taskDeps,
        });
        linkResult = await mintExplicitLinks({
          fromId: task.id,
          fromType: 'task',
          links: args.links,
          projectId,
          createdBy: 'links:task_create',
        });
      }

      // THE ONE `subtask_of` MINT — from the resolved `parentTaskId` param.
      // Deliberately OUTSIDE the TASK_EDGE_MINT_CONFIG kill switch: that flag gates the
      // AUTO sources (tags / deps mirror / links batch); this is a single explicitly
      // declared structural edge, and silently dropping a declared param under a flag flip
      // would be a wrong "nothing happened", not a safe one. mintEdge is idempotent and its
      // failure must never roll back the already-persisted task — surfaced as a warning.
      let parentMint = { minted: 0, warnings: [] as string[] };
      if (resolvedParentTaskId) {
        try {
          const r = await mintEdge({
            fromId: task.id,
            fromType: 'task',
            toId: resolvedParentTaskId,
            toType: 'task',
            edgeType: 'subtask_of',
            projectId,
            createdBy: TASK_EDGE_CREATED_BY.taskParent,
            via: EDGE_MINT_VIA.parentTaskParam,
            metadata: {},
          });
          if (r.created) parentMint.minted = 1;
        } catch (e) {
          parentMint.warnings.push(
            `parentTaskId: failed to mint subtask_of → ${resolvedParentTaskId} (${(e as Error)?.message ?? 'error'})`
          );
        }
      }

      // POSITIONAL MEMBERSHIP (PHASE 1) — closes the
      // write-path hole the audit measured: task_create consulted threading NOT
      // AT ALL, so a task born mid-branch was an orphan unless a human tagged it. Now:
      //   • standing on a branch → declared `informs` membership edge to the spine
      //     (created_by 'auto:positional', the 079 meter's DECLARED bucket);
      //     (position NEVER mints `subtask_of` — that structural claim needs the explicit
      //     `parentTaskId` param above);
      //   • ≥2 task ids named in title/description → TRUNK record instead (reference edge
      //     to each, membership to none);
      //   • no branch open → the `branch_open <id8>` offer naming THIS task's own id.
      // The old "NOT DONE HERE, deliberately" reasoning (the anchor prior is weak for
      // tasks) retired WITH the anchor: position is not a prior, it is a declaration.
      // mintPositional NEVER throws (the task is already persisted).
      const positionalSessionId = context?.connectionId || 'default-session';
      const positional = await mintPositional({
        recordId: task.id,
        recordType: 'task',
        // ONE body-composition rule for all three write paths (SK1).
        body: composePositionalBody('task', { title: args.title, description: args.description }),
        projectId,
        sessionId: positionalSessionId,
      });

      // SURFACE IN BOTH CHANNELS from day one. The mint report is the pollution
      // EARLY-WARNING and the test assertion surface at once — an unreported mint is one
      // nobody can notice going wrong (it is exactly how the full-UUID hole hid).
      // SCOPE §3.3 — WARN AND STORE. Every one of these tags IS STORED; the warning says a
      // threading prefix will probably not resolve. Rendered in its own channel rather than
      // folded into "Link notes" because a link warning means an edge did not mint and this
      // one means nothing failed at all.
      const tagNoteLines = task.tagWarnings ?? [];
      const edgeSkips = [...tagMint.skips, ...depMint.skips];
      const linkWarningLines = [
        ...linkResult.warnings.map((w) => `${w.reason} (link: ${JSON.stringify(w.spec)})`),
        ...parentMint.warnings,
      ];
      const positionalMintedCount = positional.edges.filter((e) => e.created).length;
      const edgesMinted =
        tagMint.minted + depMint.minted + linkResult.minted + parentMint.minted + positionalMintedCount;
      const positionalText = positionalResponseLines(positional, task.id);

      // PROJECT VISIBILITY: append ONE line naming the RESOLVED target
      // project (name + id8), with an extra hint when it's the DEFAULT (not switched this
      // session) — so a wrong-project write is caught the moment the model reads the result.
      const sessionId = context?.connectionId || 'default-session';
      const projectEcho = await buildWriteEcho(projectId, sessionId, args.projectId != null);

      return {
        content: [{
          type: 'text',
          // DUAL-CHANNEL: lean headline; full raw record in structuredContent.
          // Keeps stable markers ("Task created successfully", "Type:", "ID:").
          // WS1 (D2): emoji markers dropped — MCP text goes to machine readers.
          // VALUE-CLEANING: task TITLE is a short DB identifier → rawValue()
          // so stored markup never prints literal `**`. task.description (below in
          // task_details) is long-form CONTENT and is intentionally left as markdown.
          text: `Task created successfully! "${rawValue(task.title)}"\n` +
                `Type: ${task.type} | Priority: ${task.priority} | Status: ${task.status}\n` +
                `ID: ${task.id}\n${formatRecordRef(task.id)}` +
                (edgesMinted > 0 ? `\nEdges minted: ${edgesMinted}` : '') +
                (linkWarningLines.length > 0
                  ? `\nLink notes:\n` + linkWarningLines.map(w => `   - ${w}`).join('\n')
                  : '') +
                (tagNoteLines.length > 0
                  ? `\nTag notes (nothing was rejected or dropped):\n` +
                    tagNoteLines.map(w => `   - ${w}`).join('\n')
                  : '') +
                (edgeSkips.length > 0
                  ? `\nEdges skipped:\n` + edgeSkips.map(s => `   - ${s.reason}`).join('\n')
                  : '') +
                // PHASE 1 + AUTO-OPEN: the positional edges, trunk note, the R1
                // branch-opened line / R2 revert line, and the no-branch offer — rendered
                // by the ONE shared renderer all three write paths use (an invisible mint
                // cannot be noticed going wrong, and neither can a silent position move).
                positionalText +
                (projectEcho ? `\n${projectEcho}` : ''),
        }],
        structuredContent: {
          action: 'created',
          // ONE SERIALIZER: the record is `serializeTask`'s output, never a
          // hand literal; the write report rides `extras`.
          task: serializeTask(task, {
            extras: {
              // SCOPE §3.3: the normalization report, in the structured channel too. Empty
              // array (never absent) — an absent key would leave a JSON reader unable to tell
              // "no warnings" from "this build does not report them".
              tagWarnings: tagNoteLines,
              // the edges this task was born with, per source, plus every ref that
              // resolved to nothing. Mirrors how context_store/decision_record report theirs.
              edgesMinted,
              mintedBySource: {
                tags: tagMint.minted,
                dependencies: depMint.minted,
                links: linkResult.minted,
                // the declared `parentTaskId` param's structural subtask_of edge.
                parent: parentMint.minted,
                // PHASE 1: positional edges (membership/refs — never subtask_of).
                positional: positionalMintedCount,
              },
              edgeSkips,
              linkWarnings: linkResult.warnings,
              // PHASE 1: the positional layer's full report (same shape context_store carries).
              positional: serializePositionalReport(positional),
            },
          }),
        },
      };
    } catch (error) {
      // THE PUNCH LIST LANE (migration 101): carry the structured
      // code + missing-field list on `structuredContent`, not just in the prose — the
      // Command backend maps this to a 400 with the same code/fields (task.ts createTask).
      if (error instanceof PunchIncompleteError) {
        const resp = formatMcpError(error, 'task_create');
        resp.structuredContent = { ok: false, code: error.code, missing: error.missing };
        return resp;
      }
      // THE `dependsOn` MIRROR: same structured carry as PunchIncompleteError.
      if (error instanceof PunchDependsOnDirectError) {
        const resp = formatMcpError(error, 'task_create');
        resp.structuredContent = { ok: false, code: error.code };
        return resp;
      }
      return formatMcpError(error as Error, 'task_create');
    }
  }

  /**
   * Handle task list requests
   */
  async handleList(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      // DEADLINE-AWARE LISTING (acceptance 3): "what is due in the next N
      // days" must be answerable through the tool, without SQL and WITHOUT the
      // blocked_on='human' precondition the briefing's waiting section imposes. Built as
      // ONE options object shared by the list and its grand total, so the two can never be
      // filtered differently.
      const listOpts: TaskListOptions = {
        dueBefore: args.dueBefore,
        sort: args.sort,
        // THE FLOW FILTERS (gap 4) ride the SAME options object as the
        // deadline filter, which is what guarantees the page and its grand total are
        // filtered identically — the property countTasks exists to hold.
        createdAfter: args.createdAfter,
        createdBefore: args.createdBefore,
        closedAfter: args.closedAfter,
        // THE PUNCH LIST LANE FILTER (migration 101).
        stage: args.stage,
      };
      // REFUSE, DO NOT DROP: on a pre-093 database a due_at predicate is unrunnable, and
      // quietly dropping it would answer "what is due this week" with the whole backlog.
      await assertDueAtQueryable(
        db,
        { dueBefore: args.dueBefore, sortsByDueAt: args.sort === 'dueAt' },
        'task_list',
      );
      // The same REFUSE-DO-NOT-DROP rule for migration 098's column. `createdAfter` /
      // `createdBefore` need no such gate: `created_at` is on every deployment by schema.
      await assertClosedAtQueryable(db, { closedAfter: args.closedAfter }, 'task_list');
      const tasks = await tasksHandler.listTasks(
        projectId,
        args.assignedTo,
        args.status,
        args.type,
        args.tags,
        args.priority,
        args.phase,
        args.statuses,
        args.limit,
        args.offset, // A7: forward pagination offset to the handler
        args.includeArchived, // default false → exclude archived tasks
        listOpts
      );

      // ACCURATE GRAND TOTAL: count ALL matching tasks with the SAME
      // filter (ignoring limit/offset), so `total` is the real match count — NOT the
      // returned slice length. Previously `total: tasks.length` under-reported whenever
      // the (default 10 / max 100) limit sliced the result, silently distorting the board.
      const total = await tasksHandler.countTasks(
        projectId,
        args.assignedTo,
        args.status,
        args.type,
        args.tags,
        args.priority,
        args.phase,
        args.statuses,
        args.includeArchived,
        listOpts
      );
      // Pagination metadata so a caller KNOWS when it is seeing a partial window and can
      // page the rest via `offset`. `returned` is this page's row count; `hasMore` is true
      // when total exceeds what has been returned so far (offset + returned).
      const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
      const returned = tasks.length;
      const hasMore = offset + returned < total;

      if (tasks.length === 0) {
        return {
          content: [{
            type: 'text',
            text: total > 0
              ? `No tasks in this window (offset ${offset}), but ${total} match this filter.\n\n` +
                `Lower the offset (or omit it) to see them.`
              : `No tasks found for this project\n\n` +
                `Create tasks with: task_create`
          }],
          structuredContent: { ok: true, results: [], total, returned: 0, limit: args.limit ?? null, offset, hasMore },
        };
      }

      const taskList = tasks.map((task, index) => {
        const assignedText = task.assignedTo ? ` (assigned to ${task.assignedTo})` : ' (unassigned)';
        const tagsText = task.tags.length > 0 ? `\n      Tags: [${task.tags.join(', ')}]` : '';
        // WS1 (D3): the DESCRIPTION rides the list. This is where
        // blocked-reasons live — before this, a task's blocked-reason was reachable only
        // via a per-task task_details round-trip and appeared in ZERO list/search
        // captures. Full text, no truncation (full records are the program's direction).
        const descriptionText = task.description
          ? `\n      Description: ${task.description}`
          : '';
        // THE DEADLINE RIDES THE LIST, for the same reason the description
        // does: a fact reachable only by a per-task task_details round-trip appears in zero
        // board captures. Absent-when-absent — nothing is printed for a task with no
        // deadline, and nothing is printed on a deployment whose SELECT had no such column.
        const dueText = task.dueAt
          ? `\n      Due: ${new Date(task.dueAt).toISOString()}` +
            (task.blockedOn ? ` (blocked on ${task.blockedOn})` : '')
          : '';

        // WS1 (D2): plain terse rows — status/priority icons, emoji field
        // markers, and the per-row permalink line dropped (structuredContent.url carries it).
        // THE DECLARED BRANCH, ON THE HUMAN CHANNEL TOO. Same reason the
        // description and the deadline ride this list: a fact reachable only through a
        // per-task task_details round-trip appears in zero board captures. Absent-when-
        // absent — nothing is printed for a task that is a member of no branch, and
        // nothing is printed on a read that did not join membership.
        const branchText = task.branchMembership
          ? `\n      Branch member of: ${task.branchMembership.spineType} ` +
            `${task.branchMembership.spineId.substring(0, 8)} (${task.branchMembership.source})`
          : '';

        return `   ${index + 1}. ${rawValue(task.title)}\n` +
               `      Type: ${task.type}${assignedText}\n` +
               `      Status: ${task.status} | Priority: ${task.priority}${tagsText}${descriptionText}\n` +
               `      Created: ${task.createdAt.toISOString().split('T')[0]}${dueText}${branchText}\n` +
               `      ID: ${task.id}`;
      }).join('\n\n');

      // Header shows the WINDOW vs the grand total when the result is partial, so a
      // capped/paged list can never masquerade as the whole board.
      const windowLabel = returned < total
        ? `showing ${offset + 1}-${offset + returned} of ${total}`
        : `${total}`;
      const moreHint = hasMore
        ? `\n\n${total - (offset + returned)} more match — page with: task_list(offset=${offset + returned}${args.limit ? `, limit=${args.limit}` : ''})`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Project Tasks (${windowLabel})\n\n${taskList}${moreHint}`
        }],
        structuredContent: {
          ok: true,
          // ONE SERIALIZER. `row` view: the full record minus `metadata`
          // (see TASK_ROW_VIEW_OMITS). Absent-when-absent keys (blockedOn/dueAt/closedAt/
          // branchMembership) keep their meaning: absent = this read did not select it.
          results: tasks.map((task) => serializeTask(task, { view: 'row' })),
          // GRAND TOTAL of all matching tasks (not the returned slice).
          total,
          returned,
          limit: args.limit ?? null,
          offset,
          hasMore,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'task_list');
    }
  }

  /**
   * Handle task update requests
   */
  async handleUpdate(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // SHORT-ID RESOLUTION: resolve a full UUID or 8+-hex short id →
      // full UUID, SCOPED to this project (project-scoped table → a prefix can't collide
      // across projects), BEFORE we mutate. Ambiguous / unknown short ids are surfaced as
      // actionable errors and DO NOT mutate (resolution throws before the UPDATE runs).
      const projectId = await this.resolveProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('task', args.taskId, projectId);
      } catch (e) {
        if (e instanceof AmbiguousIdError) {
          return {
            content: [{ type: 'text', text: ambiguousIdMessage(e, 'task_update') }],
            isError: true,
            structuredContent: { ok: false, ambiguous: true,
              candidates: e.candidates.map(c => c.id) },
          };
        }
        if (e instanceof IdNotFoundError) {
          return {
            content: [{
              type: 'text',
              text: `Task not found: ${args.taskId}\n\n` +
                    `The id may be wrong. Use task_list to see this project's tasks and copy an ID.`
            }],
            isError: true,
            structuredContent: { ok: false, found: false },
          };
        }
        throw e;
      }

      // A4: forward priority + progress (real columns) so they're actually written —
      // previously only status/assignedTo/metadata reached the handler, so a
      // priority/progress-only update returned success while writing nothing.
      // T1 item 5: forward title/description/tags (now editable). T1 item 6: metadata is
      // MERGED in the handler (null deletes a key), no longer a wholesale replace.
      // ATOMIC TASK CLAIM (fence widened by an earlier task): while a claim is
      // LIVE, EVERY task_update mutation requires the matching `claimId` (which also
      // implicitly renews the lease) or the audited `force` override — and a supplied
      // `claimId` is VALIDATED on every update regardless of fields (an invalid one is a
      // typed rejection, never silently ignored). Both params are inert when the feature
      // flag is off, so today's callers are unaffected.
      // SHORT-ID RESOLUTION for `dependencies` on the UPDATE path, mirroring
      // handleCreate. Runs before the update, so a rejection writes nothing.
      //
      // ⚠️ WHAT THIS DOES AND DOES NOT CATCH: `resolveEntityId` hits the database only for
      // SHORT ids, because that is what expanding one requires — a well-formed FULL UUID is
      // returned unchecked (utils/idResolver.ts). So an ambiguous or unknown SHORT id is
      // rejected here, and a full UUID naming a task that does not exist is NOT.
      // EXISTENCE IS ENFORCED ONE LAYER DOWN, in assertBlockerNamed, which refuses to count a
      // dependency as a named blocker unless it resolves to a real task. That is the honest
      // split, and it is deliberate: the full-UUID pass-through predates this work and is
      // shared by every id-taking tool, so tightening it is a fleet-wide change this task has
      // no business making.
      let resolvedUpdateDependencies: string[] | undefined = args.dependencies;
      if (Array.isArray(args.dependencies)) {
        resolvedUpdateDependencies = [];
        for (const rawDep of args.dependencies) {
          try {
            resolvedUpdateDependencies.push(await resolveEntityId('task', rawDep, projectId));
          } catch (e) {
            const handled = idErrorResponse(e, 'task_update', 'task', String(rawDep), 'task_list');
            if (handled) return handled;
            throw e;
          }
        }
      }

      // THE PUNCH LIST LANE, STRUCTURED. Same
      // pipeline as handleCreate: fold `metadata.punch` into `punch` BEFORE either reaches the
      // handler (splitMetadataPunch — the clobber fix), then mirror `dependsOn` from
      // `dependencies` or refuse a direct set (reconcilePunchDependsOn).
      const updateSplit = splitMetadataPunch(args.metadata, args.punch);
      const updateFinalPunch = reconcilePunchDependsOn(
        'task_update',
        updateSplit.punch,
        args.dependencies !== undefined,
        resolvedUpdateDependencies,
      );
      // CLAUSE 11: whether `updateFinalPunch` above is PURELY the
      // `dependencies` mirror with no other punch field this call named — the route can't
      // yet tell whether the row already carries a punch (that needs a DB read the handler
      // already does for the stage gate), so it hands the flag downstream instead of
      // deciding here.
      const dependsOnMirrorOnly = updateSplit.punch === undefined && args.dependencies !== undefined;

      const updateResult = await tasksHandler.updateTaskStatus(
        resolvedId,
        args.status,
        args.assignedTo,
        updateSplit.metadata,
        // LANE M-10 — this argument used to be a literal `undefined`, which made the
        // handler's own session-activity block (getActiveSession → updateSessionActivity
        // → recordTaskUpdated) UNREACHABLE through the tool surface: the handler could
        // never resolve a session to touch. Thread the caller's connection, exactly as
        // handleCreate and handleBulkUpdate already do.
        context?.connectionId,
        args.priority,
        args.progress,
        args.title,
        args.description,
        args.tags,
        context?.actor,
        args.claimId,
        args.force === true,
        // P5.5 / migration 093 — omitted leaves the SET clause unchanged; an explicit value
        // on a pre-093 deployment is a typed error naming the migration, never a drop.
        { blockedOn: args.blockedOn, dueAt: args.dueAt },
        // DEPENDENCIES, RESOLVED — short id or full UUID, project-scoped,
        // through the SAME shared resolver handleCreate uses, BEFORE the UPDATE. Passing raw
        // short ids into the `dependencies uuid[]` column is the exact cast-error defect an earlier task
        // fixed on the create path; this path must not reintroduce it.
        resolvedUpdateDependencies,
        // the append affordance. Appends to metadata.noteLog; never touches
        // description.
        { notes: args.notes },
        // Batch-5 lane K — RE-CLASSIFY. `type` is validated at the edge against the same
        // taskTypeEnum task_create uses; omitted leaves the SET clause unchanged. Forwarded
        // here because a param this route does not pass is a param the handler can never
        // write, which is the declared-but-unreachable defect this surface has now hit
        // four times (see the DRIFT-FIX notes on task_update in middleware/validation.ts).
        { type: args.type },
        // THE PUNCH LIST LANE (migration 101).
        args.stage,
        updateFinalPunch,
        dependsOnMirrorOnly,
      );

      // ── ADDITIVE RE-MINT ON TAG EDIT (an earlier task Q4) ──────────────────────
      // Matches decision_update, which already does exactly this. Only runs when tags were
      // actually part of the edit; the same kill switch gates it.
      //
      // TAG REMOVAL REMOVES NOTHING, on purpose. Two reasons, and the second is the load-
      // bearing one:
      //   (a) task_update REPLACES the tag set, so a partial or typo'd edit would silently
      //       destroy graph history;
      //   (b) edges dedup on (from,to,type) with a SINGLE-VALUED created_by — first writer
      //       wins — so ONE edge can be owed to a tag AND a links param AND the anchor
      //       simultaneously. On removal you CANNOT know the edge isn't still justified by
      //       one of the others. Attribution is structurally impossible under this schema;
      //       auto-deleting would be pretending otherwise.
      // The honest failure mode, stated: the graph may disagree with the CURRENT tag set.
      // That is acceptable — tags are a current LABEL LENS, the graph is an append-mostly
      // HISTORY of stated relations, each edge carrying source_tag provenance. The repair
      // path is an explicit `unlink` (human intent is the right bar for destroying an edge).
      let updateTagMint = { minted: 0, attempted: 0, skips: [] as MintSkip[] };
      if (args.tags !== undefined && TASK_EDGE_MINT_CONFIG.enabled) {
        // Re-read the task so we mint from the NORMALIZED stored tags (a case-fixed tag
        // still mints its edge) — same reason decision_update uses decision.tags.
        const stored = await db.query('SELECT tags FROM tasks WHERE id = $1', [resolvedId]);
        updateTagMint = await autoMintFromTags({
          fromId: resolvedId,
          fromType: 'task',
          tags: stored.rows[0]?.tags ?? args.tags,
          projectId,
          createdBy: TASK_EDGE_CREATED_BY.taskUpdate,
        });
      }

      // THE `depends_on` MIRROR, ON THE UPDATE PATH TOO. handleCreate has
      // minted these since the dependencies column existed; this path could not, because the
      // column was not writable here. Now that a task can acquire a dependency AFTER it is
      // filed — which is when a task actually becomes blocked — the edge has to be minted at
      // the same moment, or the graph would know about a dependency only if the author
      // happened to predict it at creation time. Same helper, same createdBy, same kill
      // switch as create: one rule, not a second copy that drifts (CLASSES.md C5).
      //
      // ADDITIVE, and removal removes nothing, for exactly the reasons the tag block above
      // states at length — edges dedup on (from,to,type) with a single-valued created_by, so
      // on removal you cannot know the edge is not still justified by another source. The
      // repair path is an explicit `unlink`.
      let updateDepMint = { minted: 0, attempted: 0, skips: [] as MintSkip[] };
      if (resolvedUpdateDependencies !== undefined && TASK_EDGE_MINT_CONFIG.enabled) {
        updateDepMint = await autoMintFromTaskDependencies({
          taskId: resolvedId,
          dependencies: resolvedUpdateDependencies,
          projectId,
          createdBy: TASK_EDGE_CREATED_BY.taskDeps,
        });
      }

      // BYPRODUCT POSITION (PHASE 1 spec item b): flipping a task to
      // in_progress is explicit work-start — the session's branch position moves to it,
      // exactly like task_claim. Never throws; surfaced in both channels below.
      let updatePosition: Awaited<ReturnType<typeof setPositionByproduct>> | null = null;
      if (args.status === 'in_progress') {
        updatePosition = await setPositionByproduct({
          sessionId: context?.connectionId || 'default-session',
          projectId,
          spineId: resolvedId,
          spineType: 'task',
        });
      }
      const updatePositionLine = updatePosition
        ? byproductPositionLines(updatePosition, resolvedId)
        : '';

      // Build a summary of exactly the fields that were updated (status is now optional).
      // WS1 (D2): plain key:value lines — status icons dropped with the
      // rest of the emoji packaging.
      const applied: string[] = [];
      if (args.status !== undefined) applied.push(`New Status: ${args.status}`);
      if (args.priority !== undefined) applied.push(`Priority: ${args.priority}`);
      if (args.progress !== undefined) applied.push(`Progress: ${args.progress}%`);
      if (args.assignedTo !== undefined) applied.push(`Assigned To: ${args.assignedTo}`);
      // T1 item 5: title/description/tags edits.
      if (args.title !== undefined) applied.push(`Title: ${rawValue(args.title)}`);
      // say WHERE the replaced text went, at the moment of need. "Description
      // updated" alone is what let a full replace read as a harmless edit. The refusal IS
      // the instruction — and so is the confirmation.
      if (args.description !== undefined) {
        applied.push(
          updateResult?.descriptionPreserved
            ? `Description REPLACED (the previous description was preserved at metadata.${TASK_DESCRIPTION_HISTORY_KEY}; use notes= to append a status note instead)`
            : `Description updated`,
        );
      }
      if (args.notes !== undefined) applied.push(`Note appended to metadata.${TASK_NOTE_LOG_KEY} (description untouched)`);
      if (args.tags !== undefined) applied.push(`Tags: [${args.tags.join(', ')}]`);
      // P5.5: `!== undefined` and not truthiness — `blockedOn: null` is a real edit (the
      // caller CLEARING the field) and must be reported as one, not swallowed.
      if (args.blockedOn !== undefined) applied.push(`Blocked on: ${args.blockedOn ?? '(cleared)'}`);
      if (args.dueAt !== undefined) applied.push(`Due at: ${args.dueAt ?? '(cleared)'}`);
      // SCOPE §3.3 — WARN AND STORE. The tags were stored; this says a threading prefix
      // will probably not resolve.
      const updateTagNotes = updateResult?.tagWarnings ?? [];
      const updateTagNoteText = updateTagNotes.length > 0
        ? `\nTag notes (nothing was rejected or dropped):\n` +
          updateTagNotes.map(w => `   - ${w}`).join('\n')
        : '';
      const appliedText = (applied.length > 0 ? `\n${applied.join('\n')}` : '') + updateTagNoteText;

      // Structured record of exactly what was applied (RAW values, no markup). Report the
      // RESOLVED full id (not the short input) so the displayed id is unambiguous to copy.
      const appliedFields: Record<string, any> = { id: resolvedId };
      if (args.status !== undefined) appliedFields.status = args.status;
      if (args.priority !== undefined) appliedFields.priority = args.priority;
      if (args.progress !== undefined) appliedFields.progress = args.progress;
      if (args.assignedTo !== undefined) appliedFields.assignedTo = args.assignedTo;
      if (args.title !== undefined) appliedFields.title = args.title;
      if (args.description !== undefined) {
        appliedFields.description = args.description;
        appliedFields.descriptionPreserved = updateResult?.descriptionPreserved ?? false;
      }
      if (args.notes !== undefined) appliedFields.noteAppended = true;
      if (args.tags !== undefined) appliedFields.tags = args.tags;

      // Surface the re-mint in BOTH channels, same as create.
      // BOTH mint sources report through the SAME two fields. Reporting only
      // the tag source would make a dependency edge minted by this call invisible to the
      // caller — and an edge the caller is never told about is one they cannot correct.
      const updateMinted = updateTagMint.minted + updateDepMint.minted;
      const updateSkips = [...updateTagMint.skips, ...updateDepMint.skips];
      if (updateMinted > 0) appliedFields.edgesMinted = updateMinted;
      if (updateSkips.length > 0) appliedFields.edgeSkips = updateSkips;
      // The record as it now stands — including anything the handler normalized (tag casing,
      // ISO timestamps) that an argument echo would misreport.
      const updatedTask = await tasksHandler.getTaskById(resolvedId, projectId);
      if (!updatedTask) throw new Error(`task_update: task ${resolvedId} vanished between UPDATE and read-back`);
      const appliedReport: Record<string, unknown> = {};
      if ('descriptionPreserved' in appliedFields) appliedReport.descriptionPreserved = appliedFields.descriptionPreserved;
      if ('noteAppended' in appliedFields) appliedReport.noteAppended = true;
      if ('edgesMinted' in appliedFields) appliedReport.edgesMinted = appliedFields.edgesMinted;
      if ('edgeSkips' in appliedFields) appliedReport.edgeSkips = appliedFields.edgeSkips;

      return {
        content: [{
          type: 'text',
          text: `Task updated successfully! ${resolvedId}${appliedText}` +
                (updateMinted > 0 ? `\nEdges minted: ${updateMinted}` : '') +
                (updateSkips.length > 0
                  ? `\nEdges skipped:\n` +
                    updateSkips.map(s => `   - ${s.reason}`).join('\n')
                  : '') +
                updatePositionLine,
        }],
        structuredContent: {
          action: 'updated',
          // ONE SERIALIZER: the WHOLE post-update record, read back from the
          // row, not an echo of the arguments. `applied` names the fields this call edited
          // (the old echo carried only those keys, so "present ⇒ applied" consumers read it
          // here instead); the write report rides alongside as before.
          task: serializeTask(updatedTask, { extras: { ...appliedReport, applied: Object.keys(appliedFields).filter((k) => k !== 'id') } }),
          // PHASE 1: the byproduct position an in_progress flip opened
          // (absent on other updates; null + reason when it could not be keyed).
          ...(updatePosition
            ? {
                position: updatePosition.position
                  ? { spineId: updatePosition.position.spineId, spineType: updatePosition.position.spineType }
                  : null,
                positionRefusal: updatePosition.refusal,
                positionYielded: updatePosition.yieldedTo !== null,
              }
            : {}),
          ...this.claimInertEcho(args),
        },
      };
    } catch (error) {
      // CLAIM FENCE (an earlier task SPEC §6.5, widened by an earlier task): ANY write against a
      // live claim it does not hold — and any write carrying an invalid claimId — is REFUSED
      // with a typed error that names the holder and points at `claim`. Agents that used
      // task_update as a de-facto claim get told where the real one lives.
      if (error instanceof TaskClaimFencedError) {
        return this.claimFencedResponse(error, 'task_update');
      }
      // THE PUNCH LIST LANE (migration 101): same structured carry as
      // handleCreate — see the note there.
      if (error instanceof PunchIncompleteError) {
        const resp = formatMcpError(error, 'task_update');
        resp.structuredContent = { ok: false, code: error.code, missing: error.missing };
        return resp;
      }
      // THE `dependsOn` MIRROR: same structured carry as PunchIncompleteError.
      if (error instanceof PunchDependsOnDirectError) {
        const resp = formatMcpError(error, 'task_update');
        resp.structuredContent = { ok: false, code: error.code };
        return resp;
      }
      // EXISTENCE ENFORCEMENT: updateTaskStatus throws IdNotFoundError when
      // a (full-UUID, resolver-short-circuited) id matches 0 rows — surface it via the
      // centralized actionable not-found (same contract as the resolve-time path above),
      // never a phantom success. idErrorResponse returns null for non-id errors → fall
      // through to the generic formatter.
      const handled = idErrorResponse(error, 'task_update', 'task', args.taskId, 'task_list');
      if (handled) return handled;
      return formatMcpError(error as Error, 'task_update');
    }
  }

  /**
   * Handle bulk task update requests
   */
  async handleBulkUpdate(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);

      // SHORT-ID RESOLUTION: resolve every id (full UUID or 8+-hex short
      // id) → full UUID, SCOPED to this project, BEFORE the atomic bulk update. Any
      // ambiguous / unknown id aborts the whole op (consistent with bulk's all-or-nothing
      // transaction) with an actionable error — nothing is mutated.
      const resolvedIds: string[] = [];
      try {
        for (const rawId of args.task_ids) {
          resolvedIds.push(await resolveEntityId('task', rawId, projectId));
        }
      } catch (e) {
        if (e instanceof AmbiguousIdError) {
          return {
            content: [{ type: 'text', text: ambiguousIdMessage(e, 'task_bulk_update') }],
            isError: true,
            structuredContent: { ok: false, ambiguous: true,
              candidates: e.candidates.map(c => c.id) },
          };
        }
        if (e instanceof IdNotFoundError) {
          return {
            content: [{
              type: 'text',
              text: `Bulk update aborted: task not found "${e.shortId}"\n\n` +
                    `The id may be wrong. Use task_list to see this project's tasks; nothing was changed.`
            }],
            isError: true,
            structuredContent: { ok: false, found: false },
          };
        }
        throw e;
      }

      // THE PUNCH LIST LANE, STRUCTURED. Same
      // pipeline as handleCreate/handleUpdate. `task_bulk_update` has no `dependencies`
      // channel at all, so `dependsOn` set directly (either argument) is ALWAYS refused here
      // — there is nothing for it to mirror.
      const bulkSplit = splitMetadataPunch(args.metadata, args.punch);
      const bulkFinalPunch = reconcilePunchDependsOn('task_bulk_update', bulkSplit.punch, false, undefined);

      const result = await tasksHandler.bulkUpdateTasks(resolvedIds, {
        status: args.status,
        assignedTo: args.assignedTo,
        priority: args.priority,
        // the bulk twin of task_update's `type`. Declared in zod, written by
        // bulkUpdateTasks, and in that handler's embedding-invalidation set.
        type: args.type,
        metadata: bulkSplit.metadata,
        notes: args.notes,
        projectId: projectId,
        // ATOMIC TASK CLAIM (SPEC §6.8): live-claimed rows are SKIPPED (and
        // reported) rather than stomped; force:true is the audited override.
        force: args.force === true,
        // NAMING A BLOCKER, IN BULK (gap 2). Forwarded ONLY when the caller
        // actually said something: `args.blockedOn` is undefined when the key is absent and
        // null when the caller explicitly cleared it, and the handler's SET-clause builder
        // distinguishes the two. A `?? null` here would collapse them and make every bulk
        // update silently erase the blocker of every row it touched.
        blockedOn: args.blockedOn,
        // THE PUNCH LIST LANE, BULK (migration 101).
        stage: args.stage,
        punch: bulkFinalPunch,
      }, context?.connectionId, context?.actor);

      // RAW applied-fields object (no markup/icons) for the machine channel.
      const appliedUpdates: Record<string, any> = {};
      if (args.status) appliedUpdates.status = args.status;
      if (args.assignedTo) appliedUpdates.assignedTo = args.assignedTo;
      if (args.priority) appliedUpdates.priority = args.priority;
      if (args.type) appliedUpdates.type = args.type;
      if (args.notes) appliedUpdates.notes = args.notes;
      if (args.metadata) appliedUpdates.metadata = args.metadata;
      // `!== undefined`, not truthiness — an explicit null IS an applied update (the caller
      // cleared the blocker) and reporting it as unapplied would misdescribe what happened.
      if (args.blockedOn !== undefined) appliedUpdates.blockedOn = args.blockedOn;

      return {
        content: [{
          type: 'text',
          text: `Bulk update: ${result.successfullyUpdated}/${result.totalRequested} updated` +
                (result.failed > 0 ? `, ${result.failed} failed` : '') +
                // Surface the claim skips in the machine channel too — a silently-skipped row
                // is the same lie as a silently-stomped one, just in the other direction.
                (result.errors.length > 0 ? `\nskipped: ${result.errors.join('\nskipped: ')}` : ''),
        }],
        structuredContent: {
          totalRequested: result.totalRequested,
          successfullyUpdated: result.successfullyUpdated,
          failed: result.failed,
          appliedUpdates,
          updatedTaskIds: result.updatedTaskIds,
          errors: result.errors,
          ...this.claimInertEcho(args),
        },
      };
    } catch (error) {
      const err = error as Error;
      // THE PUNCH LIST LANE (migration 101): the same structured
      // code + PER-ROW missing-field report handleCreate/handleUpdate carry, plus `rows`
      // (this tool's all-or-nothing bulk contract — a caller learns exactly which of the
      // targeted rows are the problem).
      const punchFields = err instanceof PunchIncompleteError
        ? { code: err.code, missing: err.missing, rows: err.rows ?? [] }
        : err instanceof PunchDependsOnDirectError
        ? { code: err.code }
        : {};
      return {
        content: [{
          type: 'text',
          text: `Bulk update failed: ${err.message}`,
        }],
        isError: true,
        structuredContent: {
          ok: false,
          error: err.message,
          requestedCount: args.task_ids?.length || 0,
          ...punchFields,
        },
      };
    }
  }

  /**
   * Handle task progress summary requests
   */
  async handleProgressSummary(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      const groupBy = args.groupBy || 'phase';

      // RECONCILE WITH task_list: exclude archived by default so the
      // summary counts match a status-filtered task_list; includeArchived:true to count them.
      const summary = await tasksHandler.getTaskProgressSummary(projectId, groupBy, args.includeArchived === true);

      // Format the response for human readability
      const overallStatus = `${summary.overallProgress.completed}/${summary.overallProgress.total} (${summary.overallProgress.percentage}%)`;

      // WS1 (D2): plain terse summary — no bold markup, icons, or usage
      // footer (the machine channel carries the same numbers in structuredContent).
      let responseText = `Task Progress Summary\n\n`;
      responseText += `Overall Progress: ${overallStatus} tasks completed\n`;
      responseText += `Total Tasks: ${summary.totalTasks}\n\n`;

      if (summary.groupedProgress.length > 0) {
        responseText += `Progress by ${groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}:\n\n`;

        summary.groupedProgress.forEach(group => {
          // groupName can be a free-text DB value when groupBy=phase → clean it (short
          // inline identifier, an earlier task whole-class). Enum group keys pass through.
          const groupName = group.group === 'ungrouped' ? 'No Group' : rawValue(group.group);
          responseText += `${groupName}: ${group.completedTasks}/${group.totalTasks} (${group.completionPercentage}%)\n`;

          if (group.inProgressTasks > 0) {
            responseText += `   In Progress: ${group.inProgressTasks}\n`;
          }
          if (group.pendingTasks > 0) {
            responseText += `   Pending: ${group.pendingTasks}\n`;
          }
          if (group.blockedTasks > 0) {
            responseText += `   Blocked: ${group.blockedTasks}\n`;
          }
          responseText += '\n';
        });
      } else {
        responseText += `No tasks found with valid ${groupBy} grouping.\n`;
      }

      return {
        content: [{
          type: "text",
          text: responseText
        }],
        structuredContent: {
          totalTasks: summary.totalTasks,
          overallProgress: summary.overallProgress,
          groupBy,
          groupedProgress: summary.groupedProgress,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        content: [{
          type: "text",
          text: `Progress summary failed: ${err.message}`,
        }],
        isError: true,
        structuredContent: { ok: false, error: err.message },
      };
    }
  }

  /**
   * Handle task details requests
   */
  async handleDetails(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);

      // SHORT-ID RESOLUTION: accept a full UUID or an 8+-hex short id and
      // resolve it → full UUID, SCOPED to this project so a prefix can't collide across
      // projects. Ambiguous prefix / unknown id surface as actionable errors below.
      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('task', args.taskId, projectId);
      } catch (e) {
        if (e instanceof AmbiguousIdError) {
          return {
            content: [{ type: 'text', text: ambiguousIdMessage(e, 'task_details') }],
            structuredContent: { ok: true, found: false, ambiguous: true,
              candidates: e.candidates.map(c => c.id) },
          };
        }
        if (e instanceof IdNotFoundError) {
          return {
            content: [{
              type: 'text',
              text: `Task not found\n\n` +
                    `Task ID: ${args.taskId}\n` +
                    `Project: ${projectId}\n\n` +
                    `The id may be wrong. Use task_list to see this project's tasks and copy an ID.`
            }],
            structuredContent: { ok: true, found: false },
          };
        }
        throw e;
      }

      // Get single task with full details — by id, so an ARCHIVED task is still findable
      // (the list path narrows by archived_at, which made task_details say "not found"
      // for a record task_delete had just told the caller to restore).
      const task = await tasksHandler.getTaskById(resolvedId, projectId);

      if (!task) {
        return {
          content: [{
            type: 'text',
            text: `Task not found\n\n` +
                  `Task ID: ${args.taskId}\n` +
                  `Project: ${projectId}\n\n` +
                  `Use task_list to see available tasks`
          }],
          structuredContent: { ok: true, found: false },
        };
      }

      // WHICH BRANCH THIS TASK BELONGS TO. A task's branch is carried two
      // unrelated ways — a `branch:<slug>` TAG naming a workstream, and a branch_memberships
      // row pointing at a SPINE RECORD — and until now only the tag was readable off the
      // task, because it happens to live in `tags`. So every branch-keyed consumer answered
      // "which branch?" from the tag alone and reported a task with a DECLARED membership
      // and no tag as belonging to nothing. Both carriers now come back, side by side,
      // which is the only way anyone sees them disagree without SQL.
      const membership = await readMembershipOf(task.id);
      const membershipText = membership
        ? `\nBranch member of: ${membership.spineType} ${membership.spineId.substring(0, 8)} (${membership.source})`
        : '';

      // WS1 (D2): plain terse detail block — icons and bold markup dropped.
      const assignedText = task.assignedTo ? `\nAssigned: ${task.assignedTo}` : '\nAssigned: (unassigned)';
      const createdByText = task.createdBy ? `\nCreated By: ${task.createdBy}` : '';
      const tagsText = task.tags.length > 0 ? `\nTags: [${task.tags.join(', ')}]` : '';
      const dependenciesText = task.dependencies.length > 0 ? `\nDependencies: [${task.dependencies.join(', ')}]` : '';
      const descriptionText = task.description ? `\n\nDescription:\n${task.description}` : '\n\nDescription: (no description provided)';
      const startedText = task.startedAt ? `\nStarted: ${task.startedAt.toISOString()}` : '';
      const completedText = task.completedAt ? `\nCompleted: ${task.completedAt.toISOString()}` : '';
      // WHEN IT LEFT THE BOARD (gap 1). Printed for a CANCELLED task too, which
      // is the entire point: `Completed:` was the only close line this block had, so all 113
      // cancelled tasks rendered with no close date at all and the reader had to infer one
      // from `Updated:` — which is "last touched", not "closed". Absent-when-absent: nothing
      // prints on a pre-098 deployment, and nothing prints for a task that is still open.
      const closedText = task.closedAt ? `\nClosed: ${new Date(task.closedAt).toISOString()}` : '';
      const metadataText = Object.keys(task.metadata).length > 0 ? `\nMetadata: ${JSON.stringify(task.metadata, null, 2)}` : '';
      // THE DEADLINE, READABLE. `blocked_on`/`due_at` were WRITE-ONLY:
      // task_create echoed both and task_update set both, and NO read surface returned
      // either — so the one genuinely time-boxed task we had became LESS visible by being
      // moved off an `expires:` tag onto the structured field. Visible today in exactly one
      // place (project_briefing's "Waiting on a human", which selects blocked_on='human'),
      // meaning a deadline on a task blocked on anything else was unrecallable without SQL.
      //
      // ABSENT-WHEN-ABSENT, the same rule mapTask applies: `undefined` here means this
      // deployment's SELECT carried no such column (a pre-093 database), and printing
      // "Due: none" for it would assert a fact nobody measured. A column that is present
      // and NULL is a real "no deadline recorded" and prints nothing either — the line
      // appears only when there is something to say.
      const dueText = task.dueAt ? `\nDue: ${new Date(task.dueAt).toISOString()}` : '';
      const blockedOnText = task.blockedOn ? `\nBlocked on: ${task.blockedOn}` : '';
      // ATOMIC TASK CLAIM: "who holds this task, until when?" must be
      // answerable through the PUBLIC tool contract — otherwise the only way to observe a
      // claim is raw SQL, which is exactly the reaching-past-the-contract we treat as a gap
      // ([[no-cheating-feel-the-pain]]). Shown only when a claim is present.
      //
      // THE TOKEN ITSELF IS NOT PUBLISHED. Answering "who holds it and until when" needs the
      // HOLDER and the DEADLINE, not the lock key — and printing the key here handed any
      // reader a bearer capability (read B's token off task_details, present it, two live
      // owners: the very bug this feature kills). The handler withholds it at the mapTask
      // choke point, so there is no `task.claimId` to leak on this or any other read surface;
      // only task_claim/task_renew return it, to the caller that just won it.
      const claimLive = task.claimLive === true;
      const claimText = task.claimActor || task.claimExpiresAt
        ? `\nClaim: ${claimLive ? 'LIVE' : 'EXPIRED'} — held by ${task.claimActor ?? 'unknown'}` +
          (task.claimExpiresAt ? ` until ${new Date(task.claimExpiresAt).toISOString()}` : '') +
          `\nClaim ID: (withheld — the fencing token is returned only to the holder by task_claim)`
        : '';

      return {
        content: [{
          type: 'text',
          // WS1 (D2): machine-lean detail block — no banner/emoji/bold, no
          // permalink line (structuredContent.url carries it).
          text: `ID: ${task.id}\n` +
                `Title: ${rawValue(task.title)}\n` +
                `Type: ${task.type}\n` +
                `Status: ${task.status}\n` +
                `Priority: ${task.priority}${assignedText}${createdByText}${tagsText}${dependenciesText}${descriptionText}\n\n` +
                `Created: ${task.createdAt.toISOString()}\n` +
                `Updated: ${task.updatedAt.toISOString()}${startedText}${completedText}${closedText}${blockedOnText}${dueText}${membershipText}${claimText}${metadataText}`
        }],
        structuredContent: {
          found: true,
          // ONE SERIALIZER. Both branch carriers ride it unmerged (`branch` +
          // `branchTags`); no `claimId` (withheld at the mapTask choke point).
          task: serializeTask({ ...task, branchMembership: membership }),
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'task_details');
    }
  }

  /**
   * Handle task SOFT-DELETE (archive) requests — task_delete.
   *
   * Sets archived_at on the row so it disappears from the DEFAULT task_list while STILL
   * EXISTING in the DB (reversible via task_restore). Accepts a full UUID or 8+-hex short
   * id, resolved project-scoped BEFORE the mutation; ambiguous / unknown ids surface as
   * actionable errors and mutate nothing. Idempotent (already-archived is a no-op).
   */
  async handleDelete(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('task', args.taskId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'task_delete', 'task', args.taskId, 'task_list');
        if (handled) return handled;
        throw e;
      }

      const result = await tasksHandler.archiveTask(resolvedId, projectId, args.force === true);
      // ATOMIC TASK CLAIM (SPEC §6.8): archiving a LIVE-CLAIMED task would
      // yank it off the board under its holder. Refuse with a distinct typed outcome —
      // reporting it as "already archived" would be a phantom success in a different costume.
      if (result.claimHeld) {
        return {
          content: [{ type: 'text',
            text: `Task ${result.id} is held by a live claim ('${result.claimActor ?? 'unknown'}'` +
                  (result.claimExpiresAt ? ` until ${new Date(result.claimExpiresAt).toISOString()}` : '') +
                  `) and was NOT archived.\n\n` +
                  `Wait for the lease, have the holder release it (task release), or override with force:true (audited).` }],
          isError: true,
          structuredContent: {
            ok: false,
            reason: 'held',
            taskId: result.id,
            currentActor: result.claimActor ?? null,
            expiresAt: result.claimExpiresAt ? new Date(result.claimExpiresAt).toISOString() : null,
          },
        };
      }
      if (!result.found) {
        return {
          content: [{ type: 'text',
            text: `Task not found: ${args.taskId}\n\n` +
                  `Use task_list to see this project's tasks and copy an ID.` }],
          isError: true,
          structuredContent: { ok: false, found: false },
        };
      }
      const verb = result.alreadyArchived ? 'was already archived' : 'archived';
      return {
        content: [{ type: 'text',
          text: `Task ${verb} (soft-delete) — ${result.id}\n` +
                `It is hidden from task_list but NOT deleted. Restore with: task_restore(taskId="${result.id}")` }],
        structuredContent: {
          action: 'archived',
          // ONE SERIALIZER: the archived record itself (archivedAt rides it),
          // not an `{id, archivedAt}` receipt the output schema never described.
          task: serializeTask((await tasksHandler.getTaskById(resolvedId, projectId))!),
          alreadyArchived: result.alreadyArchived === true,
          ...this.claimInertEcho(args),
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'task_delete');
    }
  }

  /**
   * Handle task RESTORE (un-archive) requests — task_restore.
   * Clears archived_at so the task returns to default listings. Mirror of handleDelete.
   */
  async handleRestore(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        // includeArchived semantics live in the resolver implicitly: it matches by id
        // regardless of archived state, so an archived task is resolvable for restore.
        resolvedId = await resolveEntityId('task', args.taskId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'task_restore', 'task', args.taskId, 'task_list');
        if (handled) return handled;
        throw e;
      }

      const result = await tasksHandler.restoreTask(resolvedId, projectId);
      if (!result.found) {
        return {
          content: [{ type: 'text',
            text: `Task not found: ${args.taskId}\n\n` +
                  `Use task_list(includeArchived:true) to see archived tasks and copy an ID.` }],
          isError: true,
          structuredContent: { ok: false, found: false },
        };
      }
      const verb = result.alreadyArchived ? 'was already live (not archived)' : 'restored';
      return {
        content: [{ type: 'text',
          text: `Task ${verb} — ${result.id}` }],
        structuredContent: {
          action: 'restored',
          task: serializeTask((await tasksHandler.getTaskById(resolvedId, projectId))!),
          alreadyArchived: result.alreadyArchived === true,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'task_restore');
    }
  }

  /**
   * Handle task CANCEL requests — cancel_task.
   *
   * A dedicated convenience verb that sets status='cancelled' — a first-class lifecycle
   * state (the tasks.status column accepts it, taskStatusEnum advertises it, and
   * task_list/task_details already render it). `cancelled` was already reachable via
   * task_update/task_bulk_update; this makes the intent explicit + self-documenting.
   * Resolves a full UUID or 8+-hex short id project-scoped BEFORE the mutation; a
   * non-existent id surfaces the SAME actionable not-found as task_update (never a phantom
   * success — updateTaskStatus enforces existence via rowCount). Idempotent:
   * cancelling an already-cancelled task just re-affirms the state.
   */
  async handleCancel(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('task', args.taskId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'cancel_task', 'task', args.taskId, 'task_list');
        if (handled) return handled;
        throw e;
      }

      // CLAIM FENCE: cancel_task is task_update(status='cancelled') in a
      // convenience wrapper, so it is an OWNERSHIP write and is fenced identically. It
      // therefore carries the same claimId/force so a holder can cancel its own work —
      // guarding the class, not just the reported surface.
      await tasksHandler.updateTaskStatus(
        // LANE M-10: argument 5 is `connectionId`. It was a bare positional `undefined`
        // here — the same defect as handleUpdate's, wearing a filler's clothes. Named
        // per-line now so the session argument cannot hide in a row of placeholders.
        resolvedId,
        'cancelled',
        undefined, // assignedTo
        undefined, // metadata
        context?.connectionId,
        undefined, // priority
        undefined, // progress
        undefined, // title
        undefined, // description
        undefined, // tags
        context?.actor,
        args.claimId,
        args.force === true
      );

      return {
        content: [{
          type: 'text',
          text: `Task cancelled — ${resolvedId}\nNew Status: cancelled`,
        }],
        structuredContent: {
          action: 'cancelled',
          task: serializeTask((await tasksHandler.getTaskById(resolvedId, projectId))!),
          ...this.claimInertEcho(args),
        },
      };
    } catch (error) {
      if (error instanceof TaskClaimFencedError) {
        return this.claimFencedResponse(error, 'cancel_task');
      }
      // updateTaskStatus throws IdNotFoundError for a non-existent (full-UUID) id — surface
      // it as the centralized actionable not-found, consistent with task_update.
      const handled = idErrorResponse(error, 'cancel_task', 'task', args.taskId, 'task_list');
      if (handled) return handled;
      return formatMcpError(error as Error, 'cancel_task');
    }
  }
}

export const tasksRoutes = new TasksRoutes();
