/**
 * SessionLifecycleService - Orchestrates session start/end/management
 */

import { randomUUID } from 'crypto';
import { ActiveSessionStore, isEmptyDelta } from '../../state/index.js';
import { SessionRepo, AnalyticsEventsRepo } from '../../infra/db/index.js';
import { GitFileSync } from '../../infra/git/index.js';
import { TokenTracker, OperationTracker } from '../tracking/index.js';
import { calculateBasicProductivity } from '../productivity/index.js';
import { resolveProjectForSession } from './projectResolution.js';
import { resolveSession } from './resolveSession.js';
import { logger } from '../../../../utils/logger.js';
import { monitoring } from '../../../../utils/monitoring.js';
import { SESSION_CONFIG } from '../../../../config/sessionConfig.js';
import { ACTOR_ANONYMOUS, classifyActor, normalizeActor } from '../../../../config/actorRegistry.js';
import type { SessionCreationReason } from '../../../../config/sessionIdentityConfig.js';
import type { SessionData } from '../../types.js';

export interface StartSessionOptions {
  projectId?: string;
  title?: string;
  description?: string;
  sessionGoal?: string;
  tags?: string[];
  aiModel?: string;
  sessionType?: 'mcp-server' | 'AI Model';
  connectionId?: string;
  /**
   * Sessions Foundation Phase 1: the principal that owns this session, ALREADY derived at
   * the edge by `deriveActor` (the sub overrides the declared handle by default,
   * and SCOPES it into a `<sub>/<handle>` composite when composites are enabled — either way it
   * arrives here already decided, and may legitimately contain the `/` delimiter). This service
   * normalizes it and,
   * when absent, stamps the flagged `anonymous` actor + increments the coverage counter.
   * ADDITIVE — the stamped value does not affect resolution in Phase 1.
   */
  actor?: string;
  /**
   * Amp-orb eval W3: WHY this session is being created. REQUIRED — every
   * caller of this service must declare it, so the reason recorded on the row is the one the
   * calling path actually knows, never a default this service invented on its behalf.
   */
  creationReason: SessionCreationReason;
}

export const SessionLifecycleService = {
  /**
   * Start a new session with smart project inheritance
   */
  async startSession(options: StartSessionOptions): Promise<string> {
    try {
      const sessionId = randomUUID();
      const startTime = new Date();

      // Resolve project if not specified
      let resolvedProjectId: string | null = options.projectId || null;
      if (!resolvedProjectId) {
        resolvedProjectId = await resolveProjectForSession(sessionId);
      }

      logger.info(`🚀 Starting session: ${sessionId.substring(0, 8)}... for project: ${resolvedProjectId || 'none'}`);

      // Capture git information
      const gitInfo = await GitFileSync.captureHeadInfo();
      if (gitInfo.branch) logger.info(`🌿 Git branch: ${gitInfo.branch}`);
      if (gitInfo.commitSha) logger.info(`📌 Git commit: ${gitInfo.commitSha.substring(0, 8)}...`);

      // Determine session type
      const finalSessionType = options.sessionType || 'AI Model';
      logger.info(`📋 Session type: ${finalSessionType}${options.aiModel ? ` (${options.aiModel})` : ''}`);

      // Sessions Foundation Phase 1: resolve the ACTOR to stamp. The edge already derived it
      // (by deriveActor — see the class doc; the value may be a `<sub>/<handle>` composite and
      // normalizeActor deliberately preserves the delimiter). If none is derivable we stamp the FLAGGED
      // `anonymous` actor AND increment a coverage counter + emit a structured log line, so
      // actor-coverage is MEASURABLE (via the metric, the greppable log, and directly on the
      // sessions.actor column) BEFORE Phase 2 makes resolution depend on it (review F3/§5:
      // fail loud, don't silent-degrade). ADDITIVE — the value does not affect resolution here.
      const normalizedActor = normalizeActor(options.actor);
      const actor = normalizedActor ?? ACTOR_ANONYMOUS;
      if (normalizedActor === null) {
        monitoring.incrementCounter('sessions_created_anonymous_actor', {
          connection_id: options.connectionId ?? 'none',
        });
        logger.warn(
          `🕵️  Session created with NO derivable actor → stamping '${ACTOR_ANONYMOUS}' ` +
            `(session ${sessionId.substring(0, 8)}…, connection ${options.connectionId ?? 'none'}). ` +
            `metric=sessions_created_anonymous_actor`,
          { metadata: { event: 'anonymous_actor_session', sessionId, connectionId: options.connectionId ?? null } }
        );
      } else {
        monitoring.incrementCounter('sessions_created_with_actor', { actor_kind: classifyActor(actor) });
      }

      // Create session record.
      //
      // an earlier Task — CONNECTION-KEYED creates go through the advisory-locked get-or-create.
      // This call site is the ONE caller of SessionRepo.create (the choke point every session
      // INSERT passes through), and `ensureActiveSession` is a check-then-insert: N concurrent
      // first-actions on one connection all read "no session" and all arrive here. Exactly one
      // could win the partial unique index `uq_sessions_open_per_connection`; the rest used to
      // get a raw duplicate-key exception. The locked variant makes the loser ADOPT the
      // winner's row instead (see SessionRepo.createForConnectionLocked). The header-less /
      // NULL-connection path is untouched: it never enters that index, so it keeps the plain
      // INSERT and two header-less sessions still legitimately coexist.
      const createParams = {
        sessionId,
        projectId: resolvedProjectId,
        sessionType: finalSessionType,
        startTime,
        title: options.title,
        description: options.description,
        sessionGoal: options.sessionGoal,
        tags: options.tags,
        aiModel: options.aiModel,
        activeBranch: gitInfo.branch,
        workingCommitSha: gitInfo.commitSha,
        // SR-1: persist the stable connection identity so a server restart
        // re-attaches to this session instead of minting a new one.
        connectionId: options.connectionId ?? null,
        // Phase 1: stamp the resolved actor (attribution/coverage; not yet resolution).
        actor,
        // W3: WHY this row exists, as declared by the calling path.
        creationReason: options.creationReason,
        metadata: {
          start_time: startTime.toISOString(),
          created_by: 'mandrel-session-tracker',
          auto_created: !options.sessionType,
          session_type: finalSessionType,
          actor,
          actor_kind: classifyActor(actor),
          actor_is_anonymous: normalizedActor === null,
          ai_model: options.aiModel || null,
          git_branch: gitInfo.branch,
          git_start_commit: gitInfo.commitSha,
          project_resolution_method: resolvedProjectId === options.projectId ? 'explicit' : 'inherited',
          title_provided: !!options.title,
          description_provided: !!options.description,
          session_goal_provided: !!options.sessionGoal,
          tags_provided: !!(options.tags && options.tags.length > 0)
        }
      };

      let finalSessionId: string = sessionId;
      let created = true;
      if (options.connectionId) {
        ({ sessionId: finalSessionId, created } = await SessionRepo.createForConnectionLocked({
          ...createParams,
          connectionId: options.connectionId
        }));
      } else {
        await SessionRepo.create(createParams);
      }

      if (!created) {
        // We LOST the create race for this connection and adopted the winner's row. Reactivate
        // it (idempotent, and the same move ensureSessionForActor makes on a resolve) so an
        // adopted row parked 'interrupted'/'dormant' is live for the action that needed it —
        // otherwise touchActivity (WHERE status='active') would silently no-op on it.
        // Deliberately NO analytics 'session_start' event: no session started here, and
        // claiming one would put a second start on a single session's timeline.
        await SessionRepo.reactivate(finalSessionId);

        // The INSERT is what would have persisted the caller's title/description/goal/tags, and
        // the adopt SKIPS it — so without this they are silently dropped while the caller is told
        // "✅ New session started". That is silent data loss replacing what used to be a loud
        // duplicate-key error, which is the wrong direction. Apply them to the adopted row, the
        // same move the actor route already makes after a resolve (session.routes.ts). Guarded so
        // a detail-less lazy write-gate adopt (the common case) writes nothing at all.
        //
        // updateDetails COALESCEs, so an undefined field never wipes the winner's existing value.
        // actor and project_id are deliberately NOT re-stamped: an adopt is a re-attach, and
        // re-attach has never re-stamped either — the row keeps the identity it was born with.
        if (
          options.title !== undefined ||
          options.description !== undefined ||
          options.sessionGoal !== undefined ||
          (options.tags !== undefined && options.tags.length > 0)
        ) {
          await SessionRepo.updateDetails(
            finalSessionId,
            options.title,
            options.description,
            options.sessionGoal,
            options.tags
          );
        }

        ActiveSessionStore.set(finalSessionId, options.connectionId);
        logger.info(
          `🤝 Session create race on connection ${options.connectionId}: adopted existing open ` +
          `session ${finalSessionId.substring(0, 8)}... (minted id ${sessionId.substring(0, 8)}... discarded, no row written).`
        );
        return finalSessionId;
      }

      // Log analytics event
      await AnalyticsEventsRepo.insertSessionEvent(finalSessionId, 'session_start', options.projectId, {
        start_time: startTime.toISOString()
      });

      // Set as active session for this connection
      ActiveSessionStore.set(finalSessionId, options.connectionId);

      logger.info(`✅ Session started: ${finalSessionId.substring(0, 8)}...${options.connectionId ? ` (connection: ${options.connectionId})` : ''}`);
      return finalSessionId;

    } catch (error) {
      logger.error('❌ Failed to start session', error as Error);
      throw error;
    }
  },

  /**
   * Sessions Foundation Phase 2b — the ACTOR-MODE resolve-or-create for the action gate.
   * Consulted ONLY when SESSION_CONFIG.resolverMode === 'actor'; legacy/shadow keep the
   * untouched connection-keyed ensureActiveSession path (byte-identical to pre-2b).
   *
   * Shape (the auditor review, all four fixes load-bearing):
   *   D1 — normalize the actor to ACTOR_ANONYMOUS BEFORE the resolver, so actorless callers
   *        share ONE classified-automation same-UTC-day session instead of minting one per
   *        action (the explosion resolveSession's lazy-create-per-null would cause).
   *   resolve — the ONE resolver (explicit id → pin → newest-open). On a hit:
   *   D2 — reactivate(id) (idempotent; flips a shutdown-parked 'interrupted' session back to
   *        active so the reaper can't terminalize it under a live user) and set the per-
   *        connection RAM cache, THEN use it.
   *   B  — on lazy-create, advisory-locked get-or-create keyed by actor (connection_id NULL).
   *
   * Fail-open like the legacy gate: the wrapper (ensureSessionForAction) swallows a throw and
   * proceeds session-less, so a tracking hiccup never blocks the user's write.
   */
  async ensureSessionForActor(options: {
    actor?: string;
    connectionId?: string;
    projectId?: string;
    explicitSessionId?: string;
    /**
     * W3: the reason to stamp IF this call ends up CREATING a session. REQUIRED
     * — the caller knows whether it is an explicit `session_start` or the lazy write gate, and
     * this service must not guess on its behalf. Ignored when an existing session RESOLVES
     * (that row already carries the reason it was actually born with; a resolve must never
     * rewrite history).
     */
    creationReason: SessionCreationReason;
  }): Promise<string> {
    // D1: anonymous normalization BEFORE the resolver.
    const actor = normalizeActor(options.actor) ?? ACTOR_ANONYMOUS;

    // The ONE resolver — explicit id → actor's pin → actor's newest open. No global fallback.
    const resolved = await resolveSession(actor, options.explicitSessionId);

    if (resolved.sessionId) {
      // D2: reactivate (idempotent) + cache for this connection before using it.
      await SessionRepo.reactivate(resolved.sessionId);
      ActiveSessionStore.set(resolved.sessionId, options.connectionId);
      logger.info(
        `🎯 actor-mode resolve: actor '${actor}' → session ${resolved.sessionId.substring(0, 8)}... ` +
          `(${resolved.source}); reactivated + cached${options.connectionId ? ` (connection: ${options.connectionId})` : ''}.`
      );
      return resolved.sessionId;
    }

    // B: nothing resolved → advisory-locked get-or-create keyed by actor.
    return this.createSessionForActor(
      actor,
      options.connectionId,
      options.projectId,
      options.creationReason
    );
  },

  /**
   * Phase 2b (the auditor fix B) — lazily CREATE the actor's session via the advisory-locked
   * get-or-create. Mirrors startSession's richness (project resolution, git head capture,
   * metadata, analytics event, coverage counters) but keyed by ACTOR: connection_id is written
   * NULL and the minting connection is preserved as created_via_connection telemetry. The
   * advisory lock + double-check (SessionRepo.createForActorLocked) guarantee concurrent
   * same-actor creates converge on ONE session.
   *
   * @param actor        the ALREADY-normalized principal (never null — anonymized by the caller).
   * @param connectionId the physical connection minting this row (telemetry + RAM cache key).
   * @param projectId    optional explicit project; otherwise inherited via resolveProjectForSession.
   * @param creationReason W3: why this row is being created, declared by the caller.
   */
  async createSessionForActor(
    actor: string,
    connectionId: string | undefined,
    projectId: string | undefined,
    creationReason: SessionCreationReason
  ): Promise<string> {
    const sessionId = randomUUID();
    const startTime = new Date();

    let resolvedProjectId: string | null = projectId || null;
    if (!resolvedProjectId) {
      resolvedProjectId = await resolveProjectForSession(sessionId);
    }

    const gitInfo = await GitFileSync.captureHeadInfo();
    const finalSessionType = 'AI Model';
    const sameUtcDayOnly = classifyActor(actor) === 'automation';

    const { sessionId: finalId, created } = await SessionRepo.createForActorLocked({
      sessionId,
      projectId: resolvedProjectId,
      sessionType: finalSessionType,
      startTime,
      activeBranch: gitInfo.branch,
      workingCommitSha: gitInfo.commitSha,
      // connection_id is forced NULL inside createForActorLocked; the minting connection is
      // preserved as telemetry only.
      createdViaConnection: connectionId ?? null,
      actor,
      // W3: WHY this row exists, as declared by the calling path.
      creationReason,
      metadata: {
        start_time: startTime.toISOString(),
        created_by: 'mandrel-session-tracker',
        auto_created: true,
        session_type: finalSessionType,
        actor,
        actor_kind: classifyActor(actor),
        actor_is_anonymous: actor === ACTOR_ANONYMOUS,
        resolver_mode: 'actor',
        created_via_connection: connectionId ?? null,
        git_branch: gitInfo.branch,
        git_start_commit: gitInfo.commitSha,
      },
      sameUtcDayOnly,
    });

    // Lost the advisory-lock race: a concurrent same-actor create already won. Adopt its
    // session (reactivate + cache) instead of the id we generated (which was never inserted).
    if (!created) {
      await SessionRepo.reactivate(finalId);
      ActiveSessionStore.set(finalId, connectionId);
      logger.info(
        `🎯 actor-mode create: actor '${actor}' adopted concurrently-created session ` +
          `${finalId.substring(0, 8)}... (advisory-lock double-check); no duplicate minted.`
      );
      return finalId;
    }

    // We inserted the row. Emit the analytics event + coverage counter, cache it, and return.
    await AnalyticsEventsRepo.insertSessionEvent(sessionId, 'session_start', resolvedProjectId ?? undefined, {
      start_time: startTime.toISOString(),
      resolver_mode: 'actor',
    });

    if (actor === ACTOR_ANONYMOUS) {
      monitoring.incrementCounter('sessions_created_anonymous_actor', {
        connection_id: connectionId ?? 'none',
      });
    } else {
      monitoring.incrementCounter('sessions_created_with_actor', { actor_kind: classifyActor(actor) });
    }

    ActiveSessionStore.set(sessionId, connectionId);
    logger.info(
      `✅ actor-mode session created: ${sessionId.substring(0, 8)}... actor '${actor}' ` +
        `(connection_id NULL; created_via_connection=${connectionId ?? 'none'}).`
    );
    return sessionId;
  },

  /**
   * End an active session and calculate final metrics
   */
  async endSession(sessionId: string): Promise<SessionData> {
    try {
      const endTime = new Date();

      // ────────────────────────────────────────────────────────────────────────────
      // STEP 0 — CONSUME THE UN-FLUSHED DELTA. THIS MUST BE THE FIRST THING WE DO,
      // BEFORE THE FIRST `await` IN THIS FUNCTION. Do not move it, do not put an
      // `await` above it.
      //
      // These stores hold a DELTA — activity since the last 30 s flush
      // (MANDREL_SESSION_FLUSH_SEC) — never a session total. Two races close here:
      //   (a) if we merely PEEKED (the old `getActivityCounts` / `TokenTracker.get`)
      //       and cleared later, the periodic flush could persist the same delta in
      //       between → double count;
      //   (b) anything recorded AFTER this line belongs to the next flush, not to us.
      // `consume` is get-and-delete in one synchronous turn, so neither can happen.
      //
      // The old code did the opposite: it peeked, then handed the peeked value to
      // SessionRepo.finish, which ABSOLUTE-SET the counter columns to it — overwriting
      // everything the flush had already accumulated. See the comment on
      // SessionRepo.finish for the full autopsy.
      // ────────────────────────────────────────────────────────────────────────────
      const tokenDelta = TokenTracker.consume(sessionId);
      const activityDelta = OperationTracker.consumeActivityCounts(sessionId);

      logger.info(`🏁 Ending session: ${sessionId.substring(0, 8)}...`);

      // ────────────────────────────────────────────────────────────────────────────
      // STEP 1 — PERSIST THE CONSUMED DELTA THROUGH THE ONE WRITE PATH, IN ONE
      // STATEMENT. `SessionRepo.applyCounterDelta` is the SAME
      // `col = COALESCE(col,0) + delta` choke point the periodic flush uses (the flush
      // reaches it through the `applyActivityCounts` / `addTokens` wrappers). There is
      // exactly one piece of SQL that writes these columns, so an end can no longer
      // disagree with a flush.
      //
      // THIS IS THE FIRST `await` IN THE FUNCTION, AND THAT IS DELIBERATE. `consume`
      // above is a get-and-DELETE: from that line until this write commits, the delta
      // exists ONLY in the two local variables. Anything that throws in between drops
      // it permanently. It used to sit after the git file-sync AND after
      // `getSessionData`, so a `getSessionData` failure silently discarded the tail —
      // and while contexts/tasks would be re-derived from the child tables on the next
      // read, TOKENS HAVE NO CHILD TABLE, so their tail was simply gone. Persist first,
      // then do everything that can fail.
      //
      // ── ONE STATEMENT, NOT TWO (the reviewer B1) ──────────────────────────────────
      // The activity half and the token half go in the SAME UPDATE. This block used to
      // issue two sequential writes inside one try and restore BOTH deltas in the catch,
      // so a failure of the SECOND write re-queued activity the FIRST had already
      // committed — the next flush added it again and the columns came out DOUBLED
      // (measured: 2 contexts / 1 task created / 1 task updated → 4 / 2 / 2). Both those
      // deltas are ordinarily non-zero at once — `recordTokenUsage` fires on every tool
      // call — so the window was routine, not exotic.
      //
      // A single UPDATE of a single row is atomic: it lands whole or not at all. There is
      // no half-landed state left for the catch below to get wrong, which is why
      // restoring BOTH deltas is now unconditionally correct rather than correct-by-luck.
      // Per-half try/catch would have handled the case; this removes it.
      //
      // If the persist fails, hand the delta BACK (`restore`) so the next periodic flush
      // persists it, then rethrow. `restore` ADDS, so activity recorded during the failed
      // write is kept too. Nothing landed, so nothing is re-applied, and nothing is
      // dropped.
      // ────────────────────────────────────────────────────────────────────────────
      //
      // ── THE GATE READS THE OBJECT IT IS GATING ─────────────────────────────────
      // The combined delta is built FIRST and `isEmptyDelta` is asked about that exact
      // object, so the condition cannot disagree with the payload. It used to be a
      // seven-term hand-written disjunction sitting above a seven-field object literal:
      // two copies of the same field list, correct only while both were maintained
      // together. The sibling copy of that pattern in `OperationTracker.flushToDatabase`
      // was already one field short. Both deltas are CONSUMED by the time we get here,
      // so the skipped branch discards them — see `isEmptyDelta`.
      // ────────────────────────────────────────────────────────────────────────────
      const counterDelta = {
        tasks_created: activityDelta.tasks_created,
        tasks_updated: activityDelta.tasks_updated,
        tasks_completed: activityDelta.tasks_completed,
        contexts_created: activityDelta.contexts_created,
        input_tokens: tokenDelta.input,
        output_tokens: tokenDelta.output,
        total_tokens: tokenDelta.total
      };

      if (!isEmptyDelta(counterDelta)) {
        try {
          await SessionRepo.applyCounterDelta(sessionId, counterDelta);
        } catch (persistError) {
          OperationTracker.restoreActivityCounts(sessionId, activityDelta);
          TokenTracker.restore(sessionId, tokenDelta);
          logger.error(
            '❌ Failed to persist the consumed activity/token delta at session end — ' +
              'delta RESTORED to the in-memory stores for the next flush; session NOT ended',
            persistError instanceof Error ? persistError : new Error('Unknown error'),
            { component: 'SessionLifecycleService', operation: 'endSession', metadata: { sessionId } }
          );
          throw persistError;
        }
      }

      // Sync file changes from git
      logger.info(`📁 Syncing file changes from git...`);
      try {
        const fileSync = await GitFileSync.syncFilesFromGit(sessionId);
        logger.info(`✅ File sync complete: ${fileSync.filesProcessed} files, +${fileSync.totalLinesAdded}/-${fileSync.totalLinesDeleted} lines`);
      } catch (error) {
        logger.warn('⚠️  Failed to sync files from git', { metadata: { error } });
      }

      // Get session data
      const sessionData = await SessionRepo.getSessionData(sessionId);
      if (!sessionData) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // STEP 2 — read the AUTHORITATIVE post-increment counts back from the DB.
      // Child tables for everything recomputable; the total_tokens column for tokens
      // (not recomputable — see SessionRepo.getFinalCounts).
      const finalCounts = await SessionRepo.getFinalCounts(sessionId);

      // Calculate duration
      const durationMs = endTime.getTime() - sessionData.start_time.getTime();

      // Build session data for productivity calculation.
      // Previously this fed `activityCounts.contexts_created || contextsCreated` and
      // left tasks/tokens at their (about-to-be-zeroed) column values, so every
      // closer-finalized session got a score computed from zeros. Now every input is
      // the authoritative post-increment number.
      const sessionDataForProd = {
        ...sessionData,
        contexts_created: finalCounts.contexts_created,
        decisions_created: finalCounts.decisions_created,
        tasks_created: finalCounts.tasks_created,
        tasks_updated: finalCounts.tasks_updated,
        tasks_completed: finalCounts.tasks_completed,
        input_tokens: finalCounts.input_tokens,
        output_tokens: finalCounts.output_tokens,
        total_tokens: finalCounts.total_tokens,
        duration_ms: durationMs
      };

      // Calculate productivity
      const productivityScore = calculateBasicProductivity(sessionDataForProd);

      // STEP 3 — terminalize. `finish` writes status/ended_at/summary/metadata ONLY;
      // it does not touch a counter column.
      await SessionRepo.finish({
        sessionId,
        endTime,
        durationMs,
        finalCounts,
        operationsCount: sessionData.operations_count,
        productivityScore
      });

      await SessionRepo.updateProductivityScore(sessionId, productivityScore);

      // Log analytics event
      await AnalyticsEventsRepo.insertSessionEvent(sessionId, 'session_end', sessionData.project_id, {
        end_time: endTime.toISOString(),
        contexts_created: finalCounts.contexts_created,
        decisions_created: finalCounts.decisions_created,
        tasks_created: finalCounts.tasks_created,
        tasks_completed: finalCounts.tasks_completed,
        operations_count: sessionData.operations_count,
        productivity_score: productivityScore,
        input_tokens: finalCounts.input_tokens,
        output_tokens: finalCounts.output_tokens,
        total_tokens: finalCounts.total_tokens
      }, durationMs);

      // Clear remaining in-memory state. The token/activity stores were already
      // emptied by the STEP 0 `consume()` — re-clearing them here would be harmless but
      // misleading, and it is exactly the peek-then-clear shape that caused the bug.
      ActiveSessionStore.clearIfActive(sessionId);

      const finalData: SessionData = {
        ...sessionData,
        end_time: endTime,
        duration_ms: durationMs,
        success_status: sessionData.operations_count > 0 ? 'completed' : 'abandoned',
        contexts_created: finalCounts.contexts_created,
        // `SessionRepo.getSessionData` hard-codes `decisions_created: 0 // Filled by
        // caller` and the caller never filled it, so the decisions term of the
        // productivity formula was structurally 0 on every session. Filled now.
        decisions_created: finalCounts.decisions_created,
        input_tokens: finalCounts.input_tokens,
        output_tokens: finalCounts.output_tokens,
        total_tokens: finalCounts.total_tokens
      };

      logger.info(`✅ Session ended: ${sessionId.substring(0, 8)}... Duration: ${Math.round(durationMs / 1000)}s`);
      return finalData;

    } catch (error) {
      logger.error('❌ Failed to end session', error as Error);
      throw error;
    }
  },

  /**
   * Get currently active session ID for a connection.
   *
   * CONNECTION-SCOPED BY DEFAULT (attribution-correct):
   *   A miss returns null. We NEVER silently adopt another connection's session
   *   via a global "last active anywhere" lookup — that was the per-connection
   *   attribution leak (a context/task on connection A could attach to whatever
   *   session was last touched on B). Connection-scoped write callers
   *   (context_store / task_create / decision_record, the tracking middleware)
   *   must pass their connectionId and accept null when their connection has no
   *   session yet (the route-level action gate creates it lazily before the write).
   *
   * EXPLICIT GLOBAL FALLBACK (opt-in only):
   *   A handful of legacy/dashboard READ callers genuinely want "the most recent
   *   session anywhere" (e.g. the REST /sessions/active poll that has no
   *   connection of its own). Those callers pass { allowGlobalFallback: true }
   *   so the global query is auditable, never implicit.
   *
   * ACTOR MODE (the auditor review A, Phase 2b — INERT unless resolverMode === 'actor'):
   *   After the RAM hit (unchanged), the DB-MISS branch routes through resolveSession(actor)
   *   instead of the connection-keyed findReattachable. This is load-bearing because the
   *   NON-gated read callers (session_status/end/pin, task_update/bulk) call getActiveSession
   *   DIRECTLY, and after a restart the actor's live rows have connection_id NULL — which
   *   findReattachable can NEVER match — so the legacy miss branch would report "no session"
   *   for a user who has one. In actor mode we resolve by actor, reactivate, and cache. The
   *   legacy findReattachable path is kept verbatim for legacy/shadow modes.
   *
   * @param connectionId - Optional connection identifier for isolation
   * @param opts.allowGlobalFallback - opt in to the global last-active DB lookup
   * @param opts.actor - the caller's principal; used ONLY in actor mode to resolve the DB miss
   */
  async getActiveSession(
    connectionId?: string,
    opts: { allowGlobalFallback?: boolean; actor?: string } = {}
  ): Promise<string | null> {
    try {
      // 1. RAM HIT (connection-scoped), VALIDATED against the DB as STILL OPEN.
      //
      // STALE-BUT-ENDED FIX (SR-1, ctx 81901e32): the in-RAM store can hold a session
      // id whose row is no longer alive — it was reaped (status=inactive + ended_at),
      // pruned, or shut-down-and-not-resumed. The OLD code validated with exists(),
      // which returns true even for an ENDED row, so it kept returning a DEAD id and
      // every write silently no-op'd (touchActivity is WHERE status='active'). We now
      // validate with existsActive() (ended_at NULL AND status active|interrupted). On
      // a miss we evict the stale entry and fall through to re-attach/mint a real,
      // live session.
      const memorySession = ActiveSessionStore.get(connectionId);
      if (memorySession) {
        const stillOpen = await SessionRepo.existsActive(memorySession);
        if (stillOpen) {
          return memorySession;
        }
        logger.warn(
          `⚠️  Cached session ${memorySession.substring(0, 8)}... is no longer OPEN in the ` +
          `database${connectionId ? ` (connection: ${connectionId})` : ''}; ` +
          `evicting stale entry so we re-attach or create a live session.`
        );
        ActiveSessionStore.clear(connectionId);
        // fall through — treat as a miss
      }

      // 1b. ACTOR MODE (the auditor A): on a RAM miss, resolve the DB by ACTOR — never by
      // connection_id (actor rows carry connection_id NULL, unmatchable by findReattachable).
      // resolveSession honors explicit-id → pin → newest-open (automation ⇒ same-UTC-day) with
      // NO global fallback; a hit is reactivated (idempotent) + cached for this connection. A
      // miss returns null (the action gate creates lazily; a read caller reports "none"). This
      // branch is INERT unless resolverMode === 'actor', so legacy/shadow fall straight through
      // to the unchanged findReattachable path below.
      if (SESSION_CONFIG.resolverMode === 'actor') {
        const actor = normalizeActor(opts.actor) ?? ACTOR_ANONYMOUS;
        const resolved = await resolveSession(actor, undefined);
        if (resolved.sessionId) {
          await SessionRepo.reactivate(resolved.sessionId);
          ActiveSessionStore.set(resolved.sessionId, connectionId);
          logger.info(
            `🎯 actor-mode getActiveSession: actor '${actor}' → session ` +
              `${resolved.sessionId.substring(0, 8)}... (${resolved.source}); reactivated + cached.`
          );
          return resolved.sessionId;
        }
        return null;
      }

      // 2. RE-ATTACH-ON-RESTART (the core random-spawning fix, SR-1): with no valid
      // in-RAM session, look up the newest OPEN session for THIS connection id within
      // the re-attach window and RE-ATTACH to it (don't mint). This is what makes a
      // SERVER RESTART (which wipes the RAM map) re-bind the same live bridge
      // connection to its existing session instead of spawning a duplicate. A session
      // parked 'interrupted' by a graceful shutdown is reactivated here. NULL
      // connectionId never re-attaches (findReattachable requires a real id).
      if (connectionId) {
        const reattachId = await SessionRepo.findReattachable(
          connectionId,
          SESSION_CONFIG.reattachWindowSec
        );
        if (reattachId) {
          await SessionRepo.reactivate(reattachId);
          ActiveSessionStore.set(reattachId, connectionId);
          logger.info(
            `🔁 Re-attached connection ${connectionId} to existing session ` +
            `${reattachId.substring(0, 8)}... (no new session minted).`
          );
          return reattachId;
        }
      }

      // 3. Global "last active anywhere" lookup ONLY when a caller explicitly opts in
      // (legacy/dashboard readers with no connection of their own). Restricted to
      // genuinely OPEN sessions so it never resurrects an ended one.
      if (opts.allowGlobalFallback) {
        const dbSession = await SessionRepo.getLastActive();
        if (dbSession) {
          // D1 fix (Phase 0, the auditor review): a READ path must NEVER write targeting
          // state. Previously we cached this global-fallback hit via
          // ActiveSessionStore.set(dbSession, connectionId) — with a connection-less
          // reader that lands under the shared 'default' key, polluting the bucket so a
          // later scoped, connection-less caller could adopt this arbitrary session for
          // a WRITE. Return it for this read only; nothing is cached.
          return dbSession;
        }
      }

      return null;

    } catch (error) {
      logger.error('❌ Failed to get active session', error as Error);
      return null;
    }
  },

  /**
   * Clear active session from memory for a connection
   * @param connectionId - Optional connection identifier for isolation
   */
  clearActiveSession(connectionId?: string): void {
    const currentId = ActiveSessionStore.get(connectionId);
    if (currentId) {
      logger.info(`🧹 Clearing active session: ${currentId.substring(0, 8)}...${connectionId ? ` (connection: ${connectionId})` : ''}`);
      ActiveSessionStore.clear(connectionId);
    }
  },

  /**
   * Set active session explicitly for a connection
   * @param connectionId - Optional connection identifier for isolation
   */
  setActiveSession(sessionId: string | null, connectionId?: string): void {
    if (sessionId) {
      logger.info(`📌 Setting active session: ${sessionId.substring(0, 8)}...${connectionId ? ` (connection: ${connectionId})` : ''}`);
    } else {
      logger.info(`🧹 Clearing active session explicitly${connectionId ? ` (connection: ${connectionId})` : ''}`);
    }
    ActiveSessionStore.set(sessionId, connectionId);
  },

  /**
   * SR-1: Graceful-shutdown close — mark ALL open active sessions 'interrupted'
   * (resumable; ended_at left NULL) and evict their in-RAM entries.
   *
   * REPLACES the old stdio-only special case (ctx 81901e32): previously shutdown
   * ended ONLY the 'stdio' connection's session, so every bridge/http/remote session
   * was left 'active' with ended_at NULL forever — they accumulated and, on restart,
   * the RAM map was empty so a duplicate was minted. Now shutdown parks them ALL as
   * 'interrupted': the next action on each connection within the re-attach window
   * resumes the SAME session (interrupted→active), and the 1h reaper terminalizes
   * any that never resume. This is a DB-only flip (no endSession finalize) — full
   * finalize happens only on explicit/manual session_end (the operator Q5).
   *
   * PHASE 3 (actor mode): 'dormant' subsumes 'interrupted' (the auditor review §4.2 — "interrupted
   * becomes redundant"). When resolverMode==='actor', shutdown parks open sessions 'dormant'
   * instead of 'interrupted' (both are open/resumable everywhere; the reattach/resolve paths
   * treat them identically). In legacy/shadow mode this stays BYTE-IDENTICAL — markInterrupted,
   * exactly as before. Method name kept for the external shutdown caller.
   *
   * @returns the count of sessions parked (dormant in actor mode, interrupted otherwise).
   */
  async markAllInterrupted(): Promise<number> {
    try {
      const actorMode = SESSION_CONFIG.resolverMode === 'actor';
      const connIds = actorMode
        ? await SessionRepo.markDormant()
        : await SessionRepo.markInterrupted();
      // Evict every in-RAM entry — the map is rebuilt by re-attach/resolve on the next action
      // for each connection (this also drops the stop-cleanup timer when empty).
      ActiveSessionStore.clearAll();
      const parked = actorMode ? 'dormant' : 'interrupted';
      logger.info(
        `📋 Graceful shutdown: parked ${connIds.length} open session(s) → ${parked} ` +
        `(resumable) and cleared the in-RAM session map.`
      );
      return connIds.length;
    } catch (error) {
      logger.error('❌ Failed to park sessions on shutdown', error as Error);
      return 0;
    }
  }
};
