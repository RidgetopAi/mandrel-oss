/**
 * OAUTH DCR CLIENT TTL-SWEEP — CONTRACT test.
 *
 * Proves the TTL-sweep against the disposable, migrated CI DB (the better-auth OAuth schema is
 * migration 052, so "oauthClient"/"oauthConsent"/"oauthAccessToken" exist after migrate):
 *
 *   1. DELETES an expired, NEVER-consented, NEVER-used client (abandoned DCR noise).
 *   2. SPARES an expired client that WAS consented (has an "oauthConsent" row).
 *   3. SPARES an expired client that was USED (has an "oauthAccessToken" row) even if never
 *      explicitly consented — a used client is not abandoned.
 *   4. SPARES a RECENT client (younger than the TTL) regardless of consent.
 *   5. SINGLE-FLIGHT: a runOnce that lands while a sweep is in flight is SKIPPED,
 *      and the in-flight flag clears afterward so the next sweep runs.
 *
 * Asserts by our own unique clientIds (never wipes the shared table), so it is robust to any
 * rows other test files leave behind.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { sweepExpiredUnconsentedClients } from '../services/oauthClientGuard.js';
import { OAuthClientSweeper } from '../services/oauthClientSweeper.js';

const STAMP = Date.now();
const TTL_DAYS = 30;

// Unique clientIds for this run so we never collide with or wipe other files' rows.
const OLD_UNCONSENTED = `sweep-old-unconsented-${STAMP}`;
const OLD_CONSENTED = `sweep-old-consented-${STAMP}`;
const OLD_USED = `sweep-old-used-${STAMP}`;
const RECENT = `sweep-recent-${STAMP}`;
const ALL_IDS = [OLD_UNCONSENTED, OLD_CONSENTED, OLD_USED, RECENT];

/** Insert an oauthClient row with an explicit createdAt (days-ago). */
async function seedClient(clientId: string, daysAgo: number): Promise<void> {
  await db.query(
    `INSERT INTO "oauthClient" ("id","clientId","redirectUris","createdAt")
     VALUES ($1, $2, $3::jsonb, NOW() - ($4::int * INTERVAL '1 day'))`,
    [clientId, clientId, JSON.stringify(['https://claude.ai/api/mcp/auth_callback']), daysAgo],
  );
}

async function seedConsent(clientId: string): Promise<void> {
  await db.query(
    `INSERT INTO "oauthConsent" ("id","clientId","scopes","createdAt","updatedAt")
     VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
    [`consent-${clientId}`, clientId, JSON.stringify(['openid'])],
  );
}

async function seedAccessToken(clientId: string): Promise<void> {
  await db.query(
    `INSERT INTO "oauthAccessToken" ("id","token","clientId","expiresAt","createdAt","scopes")
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour', NOW(), $4::jsonb)`,
    [`token-${clientId}`, `token-value-${clientId}`, clientId, JSON.stringify(['openid'])],
  );
}

async function exists(clientId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM "oauthClient" WHERE "clientId" = $1', [clientId]);
  return rows.length > 0;
}

describe('OAuth DCR TTL-sweep (deletes abandoned clients; spares consented/used/recent)', () => {
  beforeAll(async () => {
    // Clean only OUR ids (idempotent across re-runs); child rows cascade on delete.
    await db.query('DELETE FROM "oauthClient" WHERE "clientId" = ANY($1)', [ALL_IDS]);

    await seedClient(OLD_UNCONSENTED, 40); // expired, no consent, no token → DELETE
    await seedClient(OLD_CONSENTED, 40);   // expired, consented              → SPARE
    await seedClient(OLD_USED, 40);        // expired, has access token       → SPARE
    await seedClient(RECENT, 1);           // young, no consent               → SPARE

    await seedConsent(OLD_CONSENTED);
    await seedAccessToken(OLD_USED);
  });

  afterAll(async () => {
    OAuthClientSweeper.stop();
    try { await db.query('DELETE FROM "oauthClient" WHERE "clientId" = ANY($1)', [ALL_IDS]); } catch { /* ignore */ }
    await db.end();
  });

  test('a sweep deletes the expired unconsented/unused client and spares the rest', async () => {
    // Pre-condition: all four present.
    for (const id of ALL_IDS) expect(await exists(id), `${id} should exist before sweep`).toBe(true);

    const deleted = await sweepExpiredUnconsentedClients(db, TTL_DAYS);
    expect(deleted, 'at least our one abandoned client is deleted').toBeGreaterThanOrEqual(1);

    // Post-condition: ONLY the abandoned one is gone.
    expect(await exists(OLD_UNCONSENTED), 'expired+unconsented+unused → DELETED').toBe(false);
    expect(await exists(OLD_CONSENTED), 'expired but CONSENTED → spared').toBe(true);
    expect(await exists(OLD_USED), 'expired but USED (has token) → spared').toBe(true);
    expect(await exists(RECENT), 'younger than TTL → spared').toBe(true);
  });

  test('single-flight: an overlapping runOnce is SKIPPED while a sweep is in flight, then re-arms', async () => {
    // runOnce sets isSweeping=true synchronously before its first await, so a second call made
    // before the first resolves observes the flag and is skipped — no artificial delay needed.
    const first = OAuthClientSweeper.runOnce(db);   // in flight (flag set synchronously)
    const second = await OAuthClientSweeper.runOnce(db); // lands mid-sweep → skipped
    expect(second.skipped, 'a runOnce during an in-flight sweep must be skipped').toBe(true);
    expect(second.deleted).toBe(0);

    const firstResult = await first;                 // original sweep completes normally
    expect(firstResult.skipped).toBe(false);

    // Flag cleared in finally → a fresh sweep runs (not skipped).
    const third = await OAuthClientSweeper.runOnce(db);
    expect(third.skipped, 'after the sweep finished the flag must be clear (finally)').toBe(false);
  });
});
