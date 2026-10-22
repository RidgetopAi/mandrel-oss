/**
 * SessionTracker - Façade for session management
 * 
 * Maintains backward compatibility with the original API.
 * Delegates to domain services internally.
 */

import { SessionLifecycleService } from './domain/lifecycle/index.js';
import type { SessionCreationReason } from '../../config/sessionIdentityConfig.js';
import { TokenTracker, OperationTracker } from './domain/tracking/index.js';
import { SessionStatsService } from './domain/stats/index.js';
import { SessionRepo, ActivityRepo, FileRepo } from './infra/db/index.js';
import { ActiveSessionStore } from './state/index.js';
import { GitFileSync } from './infra/git/index.js';
import { noteSessionActivity } from './activityTouch.js';
import type { SessionData, SessionStats, SessionActivity, SessionFile } from './types.js';

// Re-export types for backward compatibility
export type { SessionData, SessionStats, SessionActivity, SessionFile } from './types.js';
export type { ProductivityConfig } from '../../types/session.js';

/**
 * Main SessionTracker Service Class
 * Façade pattern - delegates to domain services while maintaining original API
 */
export class SessionTracker {
  /**
   * Backward-compatible default active session accessor.
   * Prefer getActiveSession/setActiveSession for new code.
   */
  static get activeSessionId(): string | null {
    return ActiveSessionStore.get();
  }

  static set activeSessionId(sessionId: string | null) {
    ActiveSessionStore.set(sessionId);
  }

  /**
   * Start a new session with smart project inheritance
   * @param connectionId - Optional connection identifier for session isolation
   * @param creationReason - W3: WHY the row is being created. Defaults to
   *   'explicit' because that is THIS façade's own contract — `startSession` is the
   *   deliberate-open entry point (the `session_start` tool and the REST start route). The
   *   default is the function's own semantics, NOT a guess about the caller. The lazy write
   *   path does not rely on it: `ensureActiveSession` passes 'automatic-write' explicitly, and
   *   so does every production call site. The real gate is one layer down — `SessionRepo`
   *   REQUIRES the field, so no INSERT can happen without some path declaring a reason.
   */
  static async startSession(
    projectId?: string,
    title?: string,
    description?: string,
    sessionGoal?: string,
    tags?: string[],
    aiModel?: string,
    sessionType?: 'mcp-server' | 'AI Model',
    connectionId?: string,
    actor?: string,
    creationReason: SessionCreationReason = 'explicit'
  ): Promise<string> {
    return SessionLifecycleService.startSession({
      projectId,
      title,
      description,
      sessionGoal,
      tags,
      aiModel,
      sessionType,
      connectionId,
      actor,
      creationReason
    });
  }

  /**
   * Sessions Foundation Phase 2b — actor-mode RESOLVE-OR-CREATE (idempotent per actor).
   * Delegates to SessionLifecycleService.ensureSessionForActor: resolves the actor's existing
   * open session (explicit id → pin → newest-open) or advisory-locked-creates one keyed by the
   * actor (connection_id NULL). Used by session_start when resolverMode==='actor' so the manual
   * lifecycle converges onto the SAME resolver the write path uses — no separate anonymous row,
   * no clobbering the actor's working session.
   */
  static async ensureSessionForActor(options: {
    actor?: string;
    connectionId?: string;
    projectId?: string;
    explicitSessionId?: string;
    /** W3: the reason to stamp if this call CREATES. Required — see the service. */
    creationReason: SessionCreationReason;
  }): Promise<string> {
    return SessionLifecycleService.ensureSessionForActor(options);
  }

  /**
   * End an active session and calculate final metrics
   */
  static async endSession(sessionId: string): Promise<SessionData> {
    return SessionLifecycleService.endSession(sessionId);
  }

  /**
   * Get currently active session ID for a connection.
   * Connection-scoped by default (a miss returns null). Pass
   * { allowGlobalFallback: true } ONLY for legacy/dashboard READ callers that
   * genuinely want the most-recent-session-anywhere (see SessionLifecycleService).
   * @param connectionId - Optional connection identifier for session isolation
   */
  static async getActiveSession(
    connectionId?: string,
    opts: { allowGlobalFallback?: boolean; actor?: string } = {}
  ): Promise<string | null> {
    return SessionLifecycleService.getActiveSession(connectionId, opts);
  }

  /**
   * Clear active session from memory for a connection
   * @param connectionId - Optional connection identifier for session isolation
   */
  static clearActiveSession(connectionId?: string): void {
    SessionLifecycleService.clearActiveSession(connectionId);
  }

  /**
   * Set active session explicitly for a connection
   * @param connectionId - Optional connection identifier for session isolation
   */
  static setActiveSession(sessionId: string | null, connectionId?: string): void {
    SessionLifecycleService.setActiveSession(sessionId, connectionId);
  }

  /**
   * Update session activity timestamp.
   *
   * Routed through `activityTouch.noteSessionActivity`, NOT straight at
   * `SessionRepo.touchActivity`. This is the seam every write handler
   * (handlers/context.ts, handlers/tasks.ts, handlers/decisions.ts) already calls, so
   * hooking it here converges the whole write side onto the one throttle in one place
   * instead of editing four call sites — and a fifth handler added tomorrow is covered
   * the day it is written.
   */
  static async updateSessionActivity(sessionId: string): Promise<void> {
    await noteSessionActivity(sessionId);
  }

  /**
   * SR-1: Graceful-shutdown close — mark ALL active sessions 'interrupted'
   * (resumable, ended_at NULL) and evict the in-RAM map. See
   * SessionLifecycleService.markAllInterrupted.
   * @returns the count of sessions marked interrupted.
   */
  static async markAllInterrupted(): Promise<number> {
    return SessionLifecycleService.markAllInterrupted();
  }

  /**
   * Record an operation within a session
   */
  static async recordOperation(sessionId: string, operationType: string): Promise<void> {
    await OperationTracker.recordOperation(sessionId, operationType);
  }

  /**
   * Record token usage for a session
   */
  static recordTokenUsage(sessionId: string, inputTokens: number, outputTokens: number): void {
    TokenTracker.record(sessionId, inputTokens, outputTokens);
  }

  /**
   * Get token usage for a session
   */
  static getTokenUsage(sessionId: string): { input: number; output: number; total: number } {
    return TokenTracker.get(sessionId);
  }

  /**
   * Record task created
   */
  static recordTaskCreated(sessionId: string): void {
    OperationTracker.recordTaskCreated(sessionId);
  }

  /**
   * Record task updated
   */
  static recordTaskUpdated(sessionId: string, isCompleted: boolean = false): void {
    OperationTracker.recordTaskUpdated(sessionId, isCompleted);
  }

  /**
   * Record context created
   */
  static recordContextCreated(sessionId: string): void {
    OperationTracker.recordContextCreated(sessionId);
  }

  /**
   * Calculate productivity
   */
  static async calculateProductivity(sessionId: string): Promise<number> {
    return SessionStatsService.calculateProductivity(sessionId);
  }

  /**
   * Get comprehensive session data with metrics
   */
  static async getSessionData(sessionId: string): Promise<SessionData | null> {
    const data = await SessionRepo.getSessionData(sessionId);
    if (!data) return null;

    // The in-memory stores hold a DELTA since the last flush, so the old
    // `activityCounts.contexts_created || data.contexts_created` was wrong in BOTH
    // branches: with un-flushed activity it returned the delta INSTEAD OF the total
    // (an undercount that looks precise); with none it fell back to the denormalized
    // column. Same shape for the three token fields.
    //
    // Correct answer = DB truth + the un-flushed delta:
    //   - contexts/decisions come from the child tables, so they are already complete
    //     the moment the row is written — no delta to add;
    //   - tokens have no child table, so the column (everything flushed so far) plus
    //     the un-flushed delta is the best available total. `TokenTracker.get` is a
    //     read-only PEEK — it must not consume here, or a later flush/end would lose it.
    // contexts_created / decisions_created already arrive DERIVED from the child tables
    // (SessionRepo.getSessionData) — child rows are visible the instant they are written,
    // so there is no delta to add and nothing to recount here. Re-counting them in this
    // wrapper would create a SECOND copy of the count rule that could drift from the repo's.
    const tokenDelta = TokenTracker.get(sessionId);

    return {
      ...data,
      input_tokens: (data.input_tokens || 0) + tokenDelta.input,
      output_tokens: (data.output_tokens || 0) + tokenDelta.output,
      total_tokens: (data.total_tokens || 0) + tokenDelta.total
    };
  }

  /**
   * Record activity event
   */
  static async recordActivity(
    sessionId: string,
    activityType: string,
    activityData: Record<string, any> = {}
  ): Promise<void> {
    await OperationTracker.recordActivity(sessionId, activityType, activityData);
  }

  /**
   * Get session activities
   */
  static async getSessionActivities(
    sessionId: string,
    activityType?: string,
    limit: number = 100
  ): Promise<SessionActivity[]> {
    return ActivityRepo.listBySession(sessionId, activityType, limit);
  }

  /**
   * Record file modification
   */
  static async recordFileModification(
    sessionId: string,
    filePath: string,
    linesAdded: number,
    linesDeleted: number,
    source: 'tool' | 'git' | 'manual' = 'tool'
  ): Promise<void> {
    await FileRepo.upsert(sessionId, filePath, linesAdded, linesDeleted, source);
    await SessionRepo.updateFileMetrics(sessionId);
  }

  /**
   * Get session files
   */
  static async getSessionFiles(sessionId: string): Promise<SessionFile[]> {
    return FileRepo.listBySession(sessionId);
  }

  /**
   * Calculate productivity score using configurable formula
   */
  static async calculateProductivityScore(
    sessionId: string,
    configName: string = 'default'
  ): Promise<number> {
    return SessionStatsService.calculateProductivityScore(sessionId, configName);
  }

  /**
   * Resolve project for new session
   */
  static async resolveProjectForSession(sessionId: string = 'default-session'): Promise<string | null> {
    const { resolveProjectForSession } = await import('./domain/lifecycle/projectResolution.js');
    return resolveProjectForSession(sessionId);
  }

  /**
   * Get session with details
   */
  static async getSessionWithDetails(sessionId: string): Promise<{
    id: string;
    title?: string;
    description?: string;
    project_id?: string;
    started_at: Date;
    ended_at?: Date;
  } | null> {
    return SessionRepo.getWithDetails(sessionId);
  }

  /**
   * Get session statistics
   */
  static async getSessionStats(projectId?: string): Promise<SessionStats> {
    return SessionStatsService.getSessionStats(projectId);
  }

  /**
   * Generate session summary
   */
  static async generateSessionSummary(sessionId: string): Promise<string> {
    return SessionStatsService.generateSessionSummary(sessionId);
  }

  /**
   * Flush in-memory token usage to database
   */
  static async flushTokensToDatabase(): Promise<void> {
    await TokenTracker.flushToDatabase();
  }

  /**
   * Flush in-memory activity counts to database
   */
  static async flushActivityToDatabase(): Promise<void> {
    await OperationTracker.flushToDatabase();
  }

  /**
   * Sync file changes from git
   */
  static async syncFilesFromGit(sessionId: string): Promise<{
    filesProcessed: number;
    totalLinesAdded: number;
    totalLinesDeleted: number;
    error?: string;
  }> {
    return GitFileSync.syncFilesFromGit(sessionId);
  }

  /**
   * Get enhanced session statistics with grouping
   */
  static async getSessionStatsEnhanced(options: {
    projectId?: string;
    period?: 'day' | 'week' | 'month' | 'all';
    groupBy?: 'project' | 'agent' | 'tag' | 'none';
    phase2Only?: boolean;
  } = {}): Promise<any> {
    return SessionStatsService.getSessionStatsEnhanced(options);
  }
}

/**
 * Utility functions for session management
 */

/**
 * Auto-start session if none exists for this connection
 * @param connectionId - Optional connection identifier for session isolation
 */
export async function ensureActiveSession(
  projectId?: string,
  title?: string,
  description?: string,
  sessionGoal?: string,
  tags?: string[],
  aiModel?: string,
  connectionId?: string,
  actor?: string,
  creationReason: SessionCreationReason = 'automatic-write'
): Promise<string> {
  let sessionId = await SessionTracker.getActiveSession(connectionId);

  if (!sessionId) {
    sessionId = await SessionTracker.startSession(
      projectId, title, description, sessionGoal, tags, aiModel, undefined, connectionId, actor,
      // W3: a session minted HERE exists because an action needed one — this
      // helper IS the auto-start path (see its name + doc above), so 'automatic-write' is this
      // function's own contract, not an assumption about who called it.
      creationReason
    );
  }

  return sessionId;
}

/**
 * Record operation and ensure session exists.
 * Legacy/global helper (no connection scope): used by tests and bare callers.
 * @param connectionId - optional connection scope for the ensured session
 */
export async function recordSessionOperation(
  operationType: string,
  projectId?: string,
  connectionId?: string
): Promise<void> {
  const sessionId = await ensureActiveSession(
    projectId, undefined, undefined, undefined, undefined, undefined, connectionId
  );
  await SessionTracker.recordOperation(sessionId, operationType);
}

/**
 * Get current session ID (GLOBAL last-active reader).
 * Legacy/background helper (e.g. gitTracker) that genuinely wants the most-recent
 * session anywhere and has no connection of its own. Opts INTO the global fallback
 * explicitly so this is not a silent cross-connection adoption.
 */
export async function getCurrentSession(): Promise<string | null> {
  return SessionTracker.getActiveSession(undefined, { allowGlobalFallback: true });
}
