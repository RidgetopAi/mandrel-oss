/**
 * Session-Start Schema Contract Test  (the executable fuse for Fault 2)
 *
 * Fault 2 from the signal trace: POST /api/v2/sessions/start returned HTTP 500
 *   `column "session_goal" of relation "sessions" does not exist`
 * because SessionRepo.create()'s INSERT writes session_goal / tags / ai_model,
 * but no migration ever added those columns. The feature never worked at the
 * data layer. Migration 041_add_session_goal_tags_ai_model.sql adds them.
 *
 * This test drives the EXACT production code path the HTTP route uses
 * (SessionAnalyticsHandler.startSession, the same call the controller makes)
 * with a sessionGoal, tags, and aiModel, then asserts the row was created AND
 * persisted all three values.
 *
 * It would have FAILED on the old schema (the INSERT throws) and PASSES now.
 *
 * DB target: relies on the connection configured via DATABASE_* env. Run it
 * against the app-instance DB (mandrel-app-postgres, host port 15432) — NOT the
 * personal mandrel on 5432 and NOT the prod node — e.g.:
 *   DATABASE_HOST=127.0.0.1 DATABASE_PORT=15432 DATABASE_NAME=mandrel \
 *   DATABASE_USER=mandrel DATABASE_PASSWORD=*** \
 *   npx vitest run src/tests/sessionStartSchema.contract.test.ts
 */

import { describe, test, expect, afterAll } from 'vitest';
import { db } from '../config/database.js';
import SessionAnalyticsHandler from '../handlers/sessionAnalytics.js';

describe('Session-start schema contract (Fault 2 fuse)', () => {
  const createdSessionIds: string[] = [];

  afterAll(async () => {
    // Clean up only the sessions this test created.
    for (const id of createdSessionIds) {
      await db.query('DELETE FROM analytics_events WHERE session_id = $1', [id]);
      await db.query('DELETE FROM sessions WHERE id = $1', [id]);
    }
    await db.end();
  });

  test('start persists session_goal, tags, and ai_model (would 500 on old schema)', async () => {
    // Unique title so we can locate the exact row the handler inserts, without
    // depending on getSessionData() (which reads OTHER columns and is out of
    // scope for this fault).
    const title = `contract-fuse-test-${Date.now()}`;
    const goal = 'verify server node';
    const tags = ['smoke', 'contract'];
    const aiModel = 'claude-contract-test';

    // Same handler the POST /api/v2/sessions/start controller invokes:
    // startSession(projectId, title, description, sessionGoal, tags, aiModel, sessionType)
    const result = await SessionAnalyticsHandler.startSession(
      undefined,
      title,
      'schema drift regression guard',
      goal,
      tags,
      aiModel
    );

    // 1) The start call reports success. On the OLD schema the INSERT inside
    //    SessionRepo.create threw (HTTP 500), so this would be false / throw and
    //    no row would exist below.
    expect(result.success).toBe(true);

    // 2) The INSERT actually landed a row carrying all three previously-missing
    //    columns. We read the row directly (by the unique title) rather than via
    //    getSessionData, so the assertion targets exactly the Fault-2 columns.
    const { rows } = await db.query(
      'SELECT id, session_goal, tags, ai_model FROM sessions WHERE title = $1',
      [title]
    );
    expect(rows).toHaveLength(1);
    createdSessionIds.push(rows[0].id);

    expect(rows[0].session_goal).toBe(goal);
    // tags is a Postgres TEXT[] -> node-postgres returns a JS array
    expect(Array.isArray(rows[0].tags)).toBe(true);
    expect(rows[0].tags).toEqual(tags);
    expect(rows[0].ai_model).toBe(aiModel);
  });
});
