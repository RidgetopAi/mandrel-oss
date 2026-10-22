/**
 * Session-Start FULL Round-Trip Contract Test  (the executable fuse for Fault 3)
 *
 * Fault 2 (migration 041) made the INSERT succeed: SessionRepo.create() can write
 * session_goal / tags / ai_model. But POST /api/v2/sessions/start STILL returned
 * `data: null` because SessionAnalyticsHandler.startSession() immediately calls
 * SessionTracker.getSessionData() -> SessionRepo.getSessionData(), whose SELECT
 * references MORE columns the app DB lacked (lines_added/deleted/net,
 * productivity_score, files_modified_count, activity_count, decisions_created, ...).
 * That SELECT threw, getSessionData() returned null, and the handler returned
 * `data: undefined` even though the row was inserted (HTTP still 201).
 *
 * Migration 042_reconcile_sessions_schema.sql adds those 11 missing columns so the
 * read-back SELECT no longer throws.
 *
 * Unlike sessionStartSchema.contract.test.ts (which reads the row DIRECTLY by title,
 * bypassing getSessionData), THIS test asserts the FULL round-trip: start() must
 * return a NON-NULL `data` object with the values read BACK out of the DB via
 * getSessionData. It would FAIL on the pre-042 schema (data is null/undefined) and
 * PASSES after 042.
 *
 * DB target: app-instance DB (mandrel-app-postgres). Run via the same env as the
 * other contract test:
 *   DATABASE_HOST=127.0.0.1 DATABASE_PORT=15432 DATABASE_NAME=mandrel \
 *   DATABASE_USER=mandrel DATABASE_PASSWORD=*** \
 *   npx vitest run src/tests/sessionStartRoundTrip.contract.test.ts
 */

import { describe, test, expect, afterAll } from 'vitest';
import { db } from '../config/database.js';
import SessionAnalyticsHandler from '../handlers/sessionAnalytics.js';

describe('Session-start full round-trip contract (Fault 3 fuse)', () => {
  const createdSessionIds: string[] = [];

  afterAll(async () => {
    for (const id of createdSessionIds) {
      // analytics_events exists in the app DB; other session-child tables may not,
      // so guard each delete independently.
      try { await db.query('DELETE FROM analytics_events WHERE session_id = $1', [id]); } catch { /* table may not exist */ }
      try { await db.query('DELETE FROM sessions WHERE id = $1', [id]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('start returns a NON-NULL session read back from the DB (would be null on pre-042 schema)', async () => {
    const title = `roundtrip-contract-${Date.now()}`;
    const goal = 'verify read-back';
    const tags = ['smoke', 'roundtrip'];
    const aiModel = 'claude-roundtrip-test';

    // Same handler the POST /api/v2/sessions/start controller invokes. Internally it
    // calls getSessionData() and returns its result as `data`.
    const result = await SessionAnalyticsHandler.startSession(
      undefined,
      title,
      'full round-trip regression guard',
      goal,
      tags,
      aiModel
    );

    // 1) The start call reports success.
    expect(result.success).toBe(true);

    // 2) THE FAULT-3 ASSERTION: data must be a populated object, not null/undefined.
    //    On the pre-042 schema getSessionData()'s SELECT throws on the missing
    //    columns, getSessionData returns null, and `data` is undefined here.
    expect(result.data).toBeDefined();
    expect(result.data).not.toBeNull();

    const data = result.data!;
    if (data.session_id) createdSessionIds.push(data.session_id);

    // 3) The round-tripped object carries the values we sent, read BACK from the DB
    //    through getSessionData (not the raw INSERT params).
    expect(data.session_id).toBeTruthy();
    expect(data.title).toBe(title);
    expect(data.session_goal).toBe(goal);
    expect(Array.isArray(data.tags)).toBe(true);
    expect(data.tags).toEqual(tags);
    expect(data.ai_model).toBe(aiModel);

    // 4) The previously-missing read-back columns are present (and sane defaults),
    //    proving the SELECT no longer throws on them.
    expect(data.lines_added).toBe(0);
    expect(data.lines_deleted).toBe(0);
    expect(data.lines_net).toBe(0);
    expect(data.files_modified_count).toBe(0);
    expect(data.activity_count).toBe(0);
    expect(data.productivity_score).toBe(0);
    expect(data.status).toBe('active');
  });
});
