/**
 * Session Management Unit Tests
 *
 * Unit tests for the LIVE session functions:
 * - SessionTracker class methods
 * - ensureActiveSession / recordSessionOperation utility functions
 * - Error handling and edge cases
 * - Mock database interactions
 *
 * NOTE (Phase 0 dead-code purge): the SessionManagementHandler
 * (assignSessionToProject / getSessionStatus / createNewSession) and the
 * sessionAnalytics util wrappers (getSessionStatistics / recordSessionOperation /
 * startSessionTracking) were deleted as dead code — their unit tests were removed
 * with them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../config/database.js';
import { SessionTracker, SessionData, ensureActiveSession, recordSessionOperation } from '../services/session/SessionTracker.js';
import { SessionRepo } from '../services/session/infra/db/index.js';
import { ActiveSessionStore } from '../services/session/state/index.js';

// Mock database to avoid real DB operations in unit tests
vi.mock('../config/database.js', () => ({
  db: {
    query: vi.fn()
  }
}));

// Neutralise project resolution so startSession() unit tests exercise the
// session-insert path directly without project-lookup DB queries consuming the
// mocked query sequence. (Refactor moved this off SessionTracker into a module.)
vi.mock('../services/session/domain/lifecycle/projectResolution.js', () => ({
  resolveProjectForSession: vi.fn().mockResolvedValue(null)
}));

const mockDb = db as any;

describe('SessionTracker Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() clears call history but NOT the queued *Once implementations
    // (mockResolvedValueOnce/mockReturnValueOnce). An unconsumed once-value would leak
    // into the next test under shuffle (order-dependent flake). Reset the db.query mock
    // to also drain its once-queue + impl, leaving the vi.mock module factory intact.
    (db as any).query.mockReset?.();
    // Clear active-session state. The session refactor moved the active-session
    // pointer OFF `SessionTracker.activeSessionId` (now a dead no-op) into the
    // connection-scoped `ActiveSessionStore` module Map. Resetting the real store is
    // what actually isolates tests — without it, a session set by an earlier test
    // (e.g. startSession) leaks into later getActiveSession/getSessionData tests and
    // makes the suite order-dependent (the latent flake this hardening removes).
    ActiveSessionStore.clearAll();
  });

  describe('startSession', () => {
    it('should create new session with project ID', async () => {
      const testProjectId = 'test-project-123';

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'session-123', started_at: new Date() }] }) // session insert
        .mockResolvedValueOnce({ rows: [] }); // analytics insert

      const sessionId = await SessionTracker.startSession(testProjectId);

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
      expect(mockDb.query).toHaveBeenCalledTimes(2);

      // Verify session insert call
      const sessionCall = mockDb.query.mock.calls[0];
      expect(sessionCall[0]).toContain('INSERT INTO sessions');
      expect(sessionCall[1][1]).toBe(testProjectId);
    });

    it('should create session without project ID', async () => {
      // resolveProjectForSession is module-mocked to return null (no project found)
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'session-123', started_at: new Date() }] }) // session insert
        .mockResolvedValueOnce({ rows: [] }); // analytics insert

      const sessionId = await SessionTracker.startSession();

      expect(sessionId).toBeTruthy();

      // Verify project_id is null (second parameter at index 1)
      const sessionCall = mockDb.query.mock.calls[0];
      expect(sessionCall[1][1]).toBeNull();
    });

    it('should handle database errors', async () => {
      // resolveProjectForSession is module-mocked to return null

      // Mock database to reject on session insert
      mockDb.query.mockRejectedValueOnce(new Error('Database error'));

      await expect(SessionTracker.startSession()).rejects.toThrow('Database error');
    });

    it('should set active session ID', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'session-123', started_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [] });

      const sessionId = await SessionTracker.startSession();
      const activeId = (SessionTracker as any).activeSessionId;

      expect(activeId).toBe(sessionId);
    });
  });

  // getActiveSession was deliberately changed by the session isolation + dangling-FK
  // refactor and again by SR-1 (per-connection re-attach), so these cases assert the
  // CURRENT contract (not the removed pre-refactor behavior):
  //   - a cached id is VALIDATED as STILL OPEN in the DB (SessionRepo.existsActive —
  //     SR-1's stale-but-ended fix; ended/reaped rows no longer count as valid) before
  //     being trusted, and self-heals (clears) on a miss;
  //   - a cache MISS is connection-scoped: it returns null and does NOT implicitly hunt
  //     for "the last session anywhere" unless the caller opts in with
  //     { allowGlobalFallback: true }, which then consults SessionRepo.getLastActive().
  //     (Re-attach-on-restart needs a real connection id, so the default-connection
  //     misses below never trigger it — they exercise the validate/fallback paths.)
  // We assert at the SessionRepo collaborator boundary (the stable seam) rather than on
  // raw db.query SQL, so internal query changes don't make this test brittle.
  describe('getActiveSession', () => {
    it('should return the cached active session after validating it is still OPEN in the DB', async () => {
      const cachedSessionId = 'cached-session-123';
      ActiveSessionStore.set(cachedSessionId); // default connection
      vi.spyOn(SessionRepo, 'existsActive').mockResolvedValueOnce(true);

      const activeId = await SessionTracker.getActiveSession();

      expect(activeId).toBe(cachedSessionId);
      // SR-1 stale-but-ended guard MUST validate the cached id is still OPEN.
      expect(SessionRepo.existsActive).toHaveBeenCalledWith(cachedSessionId);
    });

    it('should self-heal (clear) a cached id whose DB row is no longer OPEN', async () => {
      const staleSessionId = 'stale-session-999';
      ActiveSessionStore.set(staleSessionId);
      vi.spyOn(SessionRepo, 'existsActive').mockResolvedValueOnce(false); // ended/reaped

      const activeId = await SessionTracker.getActiveSession();

      // Falls through to a miss (no global fallback requested) and clears the stale entry.
      expect(activeId).toBeNull();
      expect(ActiveSessionStore.get()).toBeNull();
    });

    it('should return null on a connection-scoped miss WITHOUT an implicit global lookup', async () => {
      const getLastActive = vi.spyOn(SessionRepo, 'getLastActive');

      const activeId = await SessionTracker.getActiveSession(); // no cache, no opt-in

      expect(activeId).toBeNull();
      // Isolation: a miss must NOT silently grab "the most recent session anywhere".
      expect(getLastActive).not.toHaveBeenCalled();
    });

    it('should consult the DB for the last-active session only when global fallback is opted in', async () => {
      vi.spyOn(SessionRepo, 'getLastActive').mockResolvedValueOnce('db-session-456');

      const activeId = await SessionTracker.getActiveSession(undefined, { allowGlobalFallback: true });

      expect(activeId).toBe('db-session-456');
      expect(SessionRepo.getLastActive).toHaveBeenCalled();
    });

    it('should return null if no active session found (global fallback opted in, DB empty)', async () => {
      vi.spyOn(SessionRepo, 'getLastActive').mockResolvedValueOnce(null);

      const activeId = await SessionTracker.getActiveSession(undefined, { allowGlobalFallback: true });

      expect(activeId).toBeNull();
    });

    it('should handle database errors gracefully (returns null, never throws)', async () => {
      vi.spyOn(SessionRepo, 'getLastActive').mockRejectedValueOnce(new Error('DB connection error'));

      const activeId = await SessionTracker.getActiveSession(undefined, { allowGlobalFallback: true });

      expect(activeId).toBeNull();
    });
  });

  describe('recordOperation', () => {
    it('should record operation in analytics table', async () => {
      const sessionId = 'test-session-123';
      const operationType = 'context_creation';

      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await SessionTracker.recordOperation(sessionId, operationType);

      // Refactor: operations are now logged via AnalyticsEventsRepo.insert with
      // actor 'system', the raw operation type as event_type, status 'completed',
      // and ['operation', type] tags (was actor 'ai' / 'session_operation_*').
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO analytics_events'),
        [
          'system',
          null,
          sessionId,
          operationType,
          'completed',
          JSON.stringify({}),
          ['operation', operationType]
        ]
      );
    });

    it('should not throw on database errors', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Insert failed'));

      // Should not throw
      await expect(SessionTracker.recordOperation('session-123', 'test_op')).resolves.toBeUndefined();
    });
  });

  describe('getSessionData', () => {
    it('should return complete session data', async () => {
      const sessionId = 'test-session-123';
      const testDate = new Date();

      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: sessionId,
            started_at: testDate,
            ended_at: null,
            project_id: 'proj-123',
            title: null,
            description: null,
            session_goal: null,
            tags: null,
            lines_added: 0,
            lines_deleted: 0,
            lines_net: 0,
            productivity_score: 3.5,
            ai_model: null,
            files_modified_count: 0,
            activity_count: 5,
            status: 'active',
            last_activity_at: null,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            // these four now arrive from CHILD-TABLE subqueries inside the
            // getSessionData SELECT itself, not from the denormalized sessions.* columns
            // and not from a follow-up countDecisions() round trip. That is why the
            // second mockResolvedValueOnce (the old separate decisions count) is gone:
            // there is only ONE query now, and `decisions_created` is a column of it.
            // Previously the repo hard-coded `decisions_created: 0 // Filled by caller`
            // and SessionTracker patched it afterwards — two sources for one number.
            contexts_created: 2,
            tasks_created: 0,
            tasks_updated: 0,
            tasks_completed: 0,
            decisions_created: 1,
            duration_ms: 60000
          }]
        }); // session query (single round trip — counts are subqueries within it)

      const sessionData = await SessionTracker.getSessionData(sessionId);

      expect(sessionData).toBeTruthy();
      expect(sessionData!.session_id).toBe(sessionId);
      expect(sessionData!.start_time).toBe(testDate);
      expect(sessionData!.project_id).toBe('proj-123');
      expect(sessionData!.contexts_created).toBe(2);
      expect(sessionData!.decisions_created).toBe(1);
      expect(sessionData!.operations_count).toBe(5);
      expect(sessionData!.success_status).toBe('active');
      expect(sessionData!.productivity_score).toBe(3.5);
    });

    it('should return null for non-existent session', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] }); // no session found

      const sessionData = await SessionTracker.getSessionData('invalid-session');

      expect(sessionData).toBeNull();
    });

    it('should calculate correct success status', async () => {
      const sessionId = 'test-session-123';
      const testDate = new Date();
      const endDate = new Date(Date.now() + 60000);

      // Test completed session
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: sessionId,
            started_at: testDate,
            ended_at: endDate,
            project_id: 'proj-123',
            title: null,
            description: null,
            session_goal: null,
            tags: null,
            lines_added: 0,
            lines_deleted: 0,
            lines_net: 0,
            productivity_score: 2.0,
            ai_model: null,
            files_modified_count: 0,
            activity_count: 3,
            status: 'active',
            last_activity_at: null,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            contexts_created: 0,
            tasks_created: 0,
            tasks_updated: 0,
            tasks_completed: 0,
            duration_ms: 60000
          }]
        }) // session query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // decisions count

      const sessionData = await SessionTracker.getSessionData(sessionId);

      expect(sessionData!.success_status).toBe('completed');
    });

    it('should handle database errors', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Query failed'));

      const sessionData = await SessionTracker.getSessionData('test-session');

      expect(sessionData).toBeNull();
    });
  });

  describe('calculateProductivity', () => {
    it('should calculate productivity score correctly', async () => {
      const mockSessionData: SessionData = {
        session_id: 'test-123',
        start_time: new Date(),
        contexts_created: 3,
        decisions_created: 2,
        operations_count: 10,
        productivity_score: 0,
        success_status: 'active',
        status: 'active',
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 3600000 // 1 hour
      };

      vi.spyOn(SessionRepo, 'getSessionData').mockResolvedValueOnce(mockSessionData);

      const productivity = await SessionTracker.calculateProductivity('test-123');

      // Formula: (contexts * 2 + decisions * 3) / (duration_hours + 1)
      // (3 * 2 + 2 * 3) / (1 + 1) = 12 / 2 = 6
      expect(productivity).toBe(6);
    });

    it('should return 0 for non-existent session', async () => {
      vi.spyOn(SessionRepo, 'getSessionData').mockResolvedValueOnce(null);

      const productivity = await SessionTracker.calculateProductivity('invalid-session');

      expect(productivity).toBe(0);
    });

    it('should handle missing duration gracefully', async () => {
      const mockSessionData: SessionData = {
        session_id: 'test-123',
        start_time: new Date(),
        contexts_created: 2,
        decisions_created: 1,
        operations_count: 5,
        productivity_score: 0,
        success_status: 'active',
        status: 'active',
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
        // No duration_ms
      };

      vi.spyOn(SessionRepo, 'getSessionData').mockResolvedValueOnce(mockSessionData);

      const productivity = await SessionTracker.calculateProductivity('test-123');

      // Should use default duration of 1 hour: (2*2 + 1*3) / (1 + 1) = 7 / 2 = 3.5
      expect(productivity).toBe(3.5);
    });
  });

  // TS003-1: sessionExists() method removed - no longer needed with simplified logic

  describe('getSessionStats', () => {
    it('should return comprehensive session statistics', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ total: '10' }] }) // total sessions
        .mockResolvedValueOnce({ rows: [{ avg_duration: '1800000' }] }) // avg 30min
        .mockResolvedValueOnce({ rows: [{ completed: '8' }] }) // completed sessions
        .mockResolvedValueOnce({ rows: [{ date: '2023-01-01', count: '3' }] }) // sessions by day
        .mockResolvedValueOnce({ rows: [{ avg_productivity: '4.5' }] }); // productivity

      const stats = await SessionTracker.getSessionStats();

      expect(stats.totalSessions).toBe(10);
      expect(stats.avgDuration).toBe(1800000);
      expect(stats.retentionRate).toBe(0.8); // 8/10
      expect(stats.productivityScore).toBe(4.5);
      expect(stats.sessionsByDay).toHaveLength(1);
      expect(stats.sessionsByDay[0]).toEqual({ date: '2023-01-01', count: 3 });
    });

    it('should handle project-specific statistics', async () => {
      const projectId = 'test-project-123';

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ total: '5' }] })
        .mockResolvedValueOnce({ rows: [{ avg_duration: '900000' }] })
        .mockResolvedValueOnce({ rows: [{ completed: '4' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ avg_productivity: '3.2' }] });

      const stats = await SessionTracker.getSessionStats(projectId);

      expect(stats.totalSessions).toBe(5);

      // Verify project filter was used
      const calls = mockDb.query.mock.calls;
      calls.forEach((call: any) => {
        if (call[0].includes('WHERE')) {
          expect(call[1]).toEqual([projectId]);
        }
      });
    });

    it('should handle database errors', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Stats query failed'));

      await expect(SessionTracker.getSessionStats()).rejects.toThrow('Stats query failed');
    });
  });
});

describe('Utility Functions Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() clears call history but NOT the queued *Once implementations
    // (mockResolvedValueOnce/mockReturnValueOnce). An unconsumed once-value would leak
    // into the next test under shuffle (order-dependent flake). Reset the db.query mock
    // to also drain its once-queue + impl, leaving the vi.mock module factory intact.
    (db as any).query.mockReset?.();
    // See note above: reset the real connection-scoped store, not the dead field.
    ActiveSessionStore.clearAll();
  });

  describe('ensureActiveSession', () => {
    it('should return existing active session', async () => {
      const existingSessionId = 'existing-123';
      vi.spyOn(SessionTracker, 'getActiveSession').mockResolvedValueOnce(existingSessionId);

      const sessionId = await ensureActiveSession();

      expect(sessionId).toBe(existingSessionId);
    });

    it('should create new session when none exists', async () => {
      const newSessionId = 'new-123';
      const projectId = 'project-456';

      vi.spyOn(SessionTracker, 'getActiveSession').mockResolvedValueOnce(null);
      vi.spyOn(SessionTracker, 'startSession').mockResolvedValueOnce(newSessionId);

      const sessionId = await ensureActiveSession(projectId);

      expect(sessionId).toBe(newSessionId);
      expect(SessionTracker.startSession).toHaveBeenCalledWith(
        projectId,
        undefined, // title
        undefined, // description
        undefined, // sessionGoal
        undefined, // tags
        undefined, // aiModel
        undefined, // sessionType
        undefined, // connectionId
        undefined, // actor (Sessions Foundation Phase 1 — none derivable here)
        // W3: ensureActiveSession IS the auto-start path, so the reason it
        // forwards is 'automatic-write' — its own contract, not a guess about the caller.
        'automatic-write'
      );
    });
  });

  describe('recordSessionOperation', () => {
    it('should record operation with existing session', async () => {
      const sessionId = 'session-123';
      const operationType = 'test_operation';

      vi.spyOn(SessionTracker, 'getActiveSession').mockResolvedValueOnce(sessionId);
      vi.spyOn(SessionTracker, 'recordOperation').mockResolvedValueOnce();

      await recordSessionOperation(operationType);

      expect(SessionTracker.recordOperation).toHaveBeenCalledWith(sessionId, operationType);
    });

    it('should create session if none exists', async () => {
      const newSessionId = 'new-session-123';
      const operationType = 'test_operation';
      const projectId = 'project-456';

      vi.spyOn(SessionTracker, 'getActiveSession').mockResolvedValueOnce(null);
      vi.spyOn(SessionTracker, 'startSession').mockResolvedValueOnce(newSessionId);
      vi.spyOn(SessionTracker, 'recordOperation').mockResolvedValueOnce();

      await recordSessionOperation(operationType, projectId);

      expect(SessionTracker.startSession).toHaveBeenCalledWith(
        projectId,
        undefined, // title
        undefined, // description
        undefined, // sessionGoal
        undefined, // tags
        undefined, // aiModel
        undefined, // sessionType
        undefined, // connectionId
        undefined, // actor (Sessions Foundation Phase 1 — none derivable here)
        // W3: ensureActiveSession IS the auto-start path, so the reason it
        // forwards is 'automatic-write' — its own contract, not a guess about the caller.
        'automatic-write'
      );
      expect(SessionTracker.recordOperation).toHaveBeenCalledWith(newSessionId, operationType);
    });
  });
});
