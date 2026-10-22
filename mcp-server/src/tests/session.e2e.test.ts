/**
 * Session Management E2E Tests
 * 
 * Comprehensive end-to-end testing of session functionality including:
 * - Session lifecycle management
 * - Project assignment and switching
 * - Analytics event tracking
 * - Session status and data retrieval
 * - Error handling and edge cases
 */

import { describe, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { db } from '../config/database.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { projectHandler } from '../handlers/project.js';

// NOTE (Phase 0 dead-code purge): tests that exercised the now-deleted
// SessionManagementHandler methods (assignSessionToProject / getSessionStatus /
// createNewSession) were removed with those methods. The remaining tests cover the
// LIVE SessionTracker lifecycle.

/**
 * Mirror the PRODUCTION context-write path (handlers/context.ts:449-456): INSERT the real
 * `contexts` child row FIRST, then record the in-memory activity increment for the SAME
 * session id. Those two always happen together in production — `recordContextCreated` is
 * called only inside `if (sessionId)` immediately after a successful INSERT carrying that
 * same session_id — so they can never disagree on a live server.
 *
 * These tests used to call `recordContextCreated` ALONE, fabricating a counter increment with
 * no child row — a state the product cannot produce. That was invisible while every reader
 * read the denormalized counter; it surfaced the moment the counts became DERIVED from the
 * child tables, because a session with a counter but no contexts now
 * correctly reports zero. Creating the row is what makes these tests exercise the real path.
 */
async function createContextForSession(projectId: string, sessionId: string): Promise<void> {
  await db.query(
    `INSERT INTO contexts (project_id, session_id, context_type, content)
     VALUES ($1, $2, 'completion', $3)`,
    [projectId, sessionId, `e2e session test context ${Date.now()}`]
  );
  SessionTracker.recordContextCreated(sessionId);
}

describe('Session Management E2E Tests', () => {
  let testProjectId: string;
  let testProjectName: string;
  let originalActiveSession: string | null = null;

  beforeAll(async () => {
    // Store original active session to restore later
    originalActiveSession = await SessionTracker.getActiveSession();
    
    // Create test project
    testProjectName = 'QA-Test-Session-' + Date.now();
    const project = await projectHandler.createProject({
      name: testProjectName,
      description: 'Test project for session management'
    });
    testProjectId = project.id;

    console.log(`Created test project: ${testProjectName} (${testProjectId})`);
  });

  afterAll(async () => {
    try {
      // Clean up ALL test sessions by UUID pattern (catches failed test sessions)
      // Pattern matches timestamp-based UUIDs: xxxxxxxx-4123-4123-8123-xxxxxxxxxxxx
      await db.query(`
        DELETE FROM analytics_events
        WHERE session_id IN (
          SELECT id FROM sessions
          WHERE id::text LIKE '%-4123-4123-8123-%'
        )
      `);
      await db.query(`
        DELETE FROM sessions
        WHERE id::text LIKE '%-4123-4123-8123-%'
      `);

      // Clean up test project and all related data
      await db.query('DELETE FROM analytics_events WHERE project_id = $1', [testProjectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [testProjectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [testProjectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [testProjectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [testProjectId]);

      console.log(`✅ Cleaned up test project: ${testProjectName}`);

      // Restore original active session
      if (originalActiveSession) {
        (SessionTracker as any).activeSessionId = originalActiveSession;
      }
    } catch (error) {
      console.error('❌ Cleanup error:', error);
    } finally {
      await db.end();
    }
  });

  beforeEach(() => {
    // Clear any cached active session between tests
    (SessionTracker as any).activeSessionId = null;
  });

  test('new session is auto-assigned to project', async () => {
    let sessionId: string | undefined;

    try {
      sessionId = await SessionTracker.startSession(testProjectId);
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');

      const { rows } = await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].project_id).toBe(testProjectId);
    } finally {
      // Clean up this test session
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('session without project defaults to unassigned', async () => {
    let sessionId: string | undefined;

    try {
      sessionId = await SessionTracker.startSession(); // No project_id
      expect(sessionId).toBeTruthy();

      const { rows } = await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionId]);
      expect(rows).toHaveLength(1);
      // TS010 project inheritance always resolves SOME project (current → primary
      // → system default → personal fallback); a session is never left unassigned.
      // Assert a valid resolved project rather than a hard-coded, env-specific id.
      expect(rows[0].project_id).toBeTruthy();
      const proj = await db.query('SELECT id FROM projects WHERE id = $1', [rows[0].project_id]);
      expect(proj.rows).toHaveLength(1);
    } finally {
      // Clean up
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('analytics events are properly linked to sessions', async () => {
    let sessionId: string | undefined;

    try {
      sessionId = await SessionTracker.startSession(testProjectId);

      // Simulate some activity
      await db.query(`
        INSERT INTO analytics_events (actor, event_type, session_id, project_id, metadata)
        VALUES ('test', 'test_event', $1, $2, '{}')
      `, [sessionId, testProjectId]);

      const { rows } = await db.query(`
        SELECT COUNT(*) FROM analytics_events WHERE session_id = $1 AND project_id = $2
      `, [sessionId, testProjectId]);

      expect(parseInt(rows[0].count)).toBeGreaterThan(1); // Should include session_start + test_event
    } finally {
      // Clean up
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('session operation recording works correctly', async () => {
    let sessionId: string | undefined;

    try {
      sessionId = await SessionTracker.startSession(testProjectId);

      await SessionTracker.recordOperation(sessionId, 'context_creation');

      // recordOperation now logs the raw operation type as event_type
      // (was 'session_operation_<type>' before the session refactor).
      const { rows } = await db.query(`
        SELECT COUNT(*) FROM analytics_events
        WHERE session_id = $1 AND event_type = 'context_creation'
      `, [sessionId]);

      expect(parseInt(rows[0].count)).toBe(1);
    } finally {
      // Clean up
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('session data retrieval includes all metrics', async () => {
    let sessionId: string | undefined;

    try {
      sessionId = await SessionTracker.startSession(testProjectId);

      // Simulate work. recordActivity persists session_activities rows, which is
      // what drives sessions.activity_count (and therefore success_status =
      // 'completed' / operations_count) — the same path real sessions use.
      await SessionTracker.recordActivity(sessionId, 'context_creation');
      await createContextForSession(testProjectId, sessionId); // real child row + counter
      await SessionTracker.recordActivity(sessionId, 'decision_creation');

      // End session to calculate productivity score
      await SessionTracker.endSession(sessionId);

      const sessionData = await SessionTracker.getSessionData(sessionId);

      expect(sessionData).toBeTruthy();
      expect(sessionData!.session_id).toBe(sessionId);
      expect(sessionData!.project_id).toBe(testProjectId);
      expect(sessionData!.success_status).toBe('completed'); // Changed from 'active' since we ended it
      expect(sessionData!.operations_count).toBeGreaterThan(0);
      expect(sessionData!.productivity_score).toBeGreaterThan(0);
    } finally {
      // Clean up
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('session ending updates all metrics correctly', async () => {
    let sessionId: string | undefined;

    try {
      sessionId = await SessionTracker.startSession(testProjectId);

      // Simulate work via the activity path so activity_count > 0 (drives the
      // 'completed' success_status the same way real sessions do).
      await SessionTracker.recordActivity(sessionId, 'context_creation');

      const endedSession = await SessionTracker.endSession(sessionId);

      expect(endedSession.session_id).toBe(sessionId);
      expect(endedSession.success_status).toBe('completed');
      expect(endedSession.end_time).toBeDefined();
      expect(endedSession.duration_ms).toBeGreaterThan(0);

      // Verify in database
      const { rows } = await db.query('SELECT ended_at FROM sessions WHERE id = $1', [sessionId]);
      expect(rows[0].ended_at).toBeTruthy();
    } finally {
      // Clean up
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('session statistics calculation is accurate', async () => {
    const sessionIds: string[] = [];

    try {
      // Create multiple test sessions
      for (let i = 0; i < 3; i++) {
        const sessionId = await SessionTracker.startSession(testProjectId);
        sessionIds.push(sessionId);

        // Add some operations
        await SessionTracker.recordOperation(sessionId, 'context_creation');
        await createContextForSession(testProjectId, sessionId); // real child row + counter
        await SessionTracker.recordOperation(sessionId, 'decision_creation');

        // End the session
        await SessionTracker.endSession(sessionId);
      }

      const stats = await SessionTracker.getSessionStats(testProjectId);

      expect(stats.totalSessions).toBeGreaterThanOrEqual(3);
      expect(stats.avgDuration).toBeGreaterThan(0);
      expect(stats.productivityScore).toBeGreaterThan(0);
      expect(stats.retentionRate).toBeGreaterThan(0);
    } finally {
      // Clean up
      for (const sessionId of sessionIds) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('active session detection works correctly', async () => {
    let sessionId: string | undefined;

    try {
      // Start session
      sessionId = await SessionTracker.startSession(testProjectId);

      // Should return the same session ID
      const activeId = await SessionTracker.getActiveSession();
      expect(activeId).toBe(sessionId);

      // End session
      await SessionTracker.endSession(sessionId);

      // Should not return ended session as active
      const activeIdAfterEnd = await SessionTracker.getActiveSession();
      expect(activeIdAfterEnd).toBeNull();
    } finally {
      // Clean up
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });

  test('session productivity calculation is correct', async () => {
    let sessionId: string | undefined;

    try {
      sessionId = await SessionTracker.startSession(testProjectId);

      // Two REAL contexts (row + counter, exactly as the product writes them), then end
      // the session. Productivity now reads the contexts CHILD TABLE rather than the
      // denormalized sessions.contexts_created column, which finish() used to zero.
      await createContextForSession(testProjectId, sessionId);
      await createContextForSession(testProjectId, sessionId);
      await SessionTracker.endSession(sessionId);

      const productivity = await SessionTracker.calculateProductivity(sessionId);

      // Formula: (contexts * 2 + decisions * 3) / (duration_hours + 1)
      // 2 contexts, ~0h duration → (2 * 2) / (≈0 + 1) ≈ 4
      expect(productivity).toBeGreaterThan(0);
      expect(productivity).toBeLessThan(10); // Should be reasonable
    } finally {
      // Clean up
      if (sessionId) {
        await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM analytics_events WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      }
    }
  });
});
