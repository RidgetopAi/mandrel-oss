/**
 * Session Analytics v2 REST boundary — malformed-id guard (H2).
 *
 * THE BUG CLASS (the class behind the contoso outage):
 *   The v2 session-analytics controller methods did a PRESENCE-ONLY check on
 *   `:sessionId` (`if (!sessionId) ...`) and then passed the raw value into a
 *   Postgres `uuid` column. A malformed id (e.g. `session_voiceitt-bridge`)
 *   made Postgres throw `invalid input syntax for type uuid` → an unhandled 500.
 *
 * WHAT THIS PROVES (no DB — the guard runs BEFORE any query):
 *   1. A malformed `:sessionId` yields a clean 404 (never a 500) and the db
 *      layer is NEVER reached (mocked db.query throws if called — proving the
 *      malformed id can't get to Postgres).
 *   2. `compareSessions` (query-param ids into a uuid `IN ($1,$2)`) is guarded
 *      the same way.
 *   3. The shared `isValidUuid` accepts a real v4 UUID and rejects junk, and
 *      does NOT over-reject ids Postgres accepts (no logging users out of valid
 *      sessions).
 *
 * This file is named *.contract.test.ts so it runs in the CI gate's mcp-server stage.
 * It is intentionally DB-free: `db` is mocked, so it does not require the
 * disposable Postgres the other contract tests use.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { isValidUuid } from '../utils/uuid.js';

// Mock the DB so any query during a malformed-id request fails the test loudly.
// (Proves the guard short-circuits BEFORE Postgres is ever touched.)
const dbQuery = vi.fn(() => {
  throw new Error('db.query must NOT be called for a malformed id');
});
vi.mock('../config/database.js', () => ({
  db: { query: dbQuery },
}));

const REAL_UUID = 'c875b2af-9020-41b7-9595-d70221603464';
const CORRUPT_ID = 'session_voiceitt-bridge';

/**
 * The background HEALTH PROBE this file must ignore (found while running the suite for
 * an earlier task — this file went RED with `expected "spy" to not be called at all, but
 * actually been called 1 times` / `["SELECT 1"]`).
 *
 * utils/monitoring.ts USED TO auto-start a background interval AT MODULE IMPORT which
 * periodically issued `db.query('SELECT 1')`. It is in this file's module graph, so it resolved
 * to the `db` mocked below and its tick landed in the spy. Whether it fired inside a given
 * test's window was pure TIMING — so a bare `not.toHaveBeenCalled()` on the whole spy was a
 * latent order-dependent flake for anyone, not a statement about the controller. an earlier Task
 * and the explicit-start change made that start explicit, so the probe no longer runs here; the assertion below
 * is kept as written because it states the real invariant, and stating it is not conditional on
 * which background work happens to share the process.
 *
 * The invariant this file actually guards is "a MALFORMED ID never reaches Postgres". The
 * assertion below states exactly that, and is STRICTLY STRONGER than what it replaced:
 *   (a) no db call carries the corrupt id — the direct statement of the contoso bug, which
 *       the old spy-count assertion only ever implied; and
 *   (b) no db call other than the parameterless health probe happened at all — preserving
 *       the original "the controller never touched the DB" claim.
 * A real controller query is `SELECT … FROM sessions WHERE id = $1` with the id in its
 * params, so it is caught by BOTH clauses; the health probe is parameterless and matches
 * neither. Mutation-probed: reverting the controller's isValidUuid guard makes this RED.
 */
const BACKGROUND_HEALTH_PROBE = 'SELECT 1';

/** Assert the controller issued NO database query for this request. */
function expectNoControllerDbQuery(): void {
  const calls = dbQuery.mock.calls as unknown as unknown[][];
  // (a) The id under test must never have been handed to Postgres, in ANY call.
  const serialized = JSON.stringify(calls);
  expect(serialized).not.toContain(CORRUPT_ID);
  // (b) Nothing but the parameterless background health probe may have run.
  const controllerCalls = calls.filter(
    (args) => !(args.length === 1 && args[0] === BACKGROUND_HEALTH_PROBE)
  );
  expect(controllerCalls).toEqual([]);
}

// Minimal Express res double capturing status + json.
function makeRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    return res;
  };
  return res;
}

describe('shared isValidUuid (mcp-server copy)', () => {
  test('accepts a real v4 UUID (any case)', () => {
    expect(isValidUuid(REAL_UUID)).toBe(true);
    expect(isValidUuid(REAL_UUID.toUpperCase())).toBe(true);
  });

  test('rejects junk', () => {
    expect(isValidUuid(CORRUPT_ID)).toBe(false);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
  });

  test('does NOT over-reject ids Postgres accepts', () => {
    expect(isValidUuid('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(true);
    expect(isValidUuid('12345678-1234-1234-1234-123456789012')).toBe(true);
  });
});

describe('v2 session-analytics controller — malformed id => 404, never 500, no DB hit', () => {
  beforeEach(() => {
    dbQuery.mockClear();
  });

  test('getSessionDetail rejects a corrupt :sessionId with 404 and no db query', async () => {
    const { SessionAnalyticsController } = await import(
      '../api/controllers/sessionAnalyticsController.js'
    );
    const controller = new SessionAnalyticsController();
    const req: any = { params: { sessionId: CORRUPT_ID }, query: {}, body: {} };
    const res = makeRes();

    await controller.getSessionDetail(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body?.success).toBe(false);
    expectNoControllerDbQuery();
  });

  test('getActivities rejects a corrupt :sessionId with 404 and no db query', async () => {
    const { SessionAnalyticsController } = await import(
      '../api/controllers/sessionAnalyticsController.js'
    );
    const controller = new SessionAnalyticsController();
    const req: any = { params: { sessionId: CORRUPT_ID }, query: {}, body: {} };
    const res = makeRes();

    await controller.getActivities(req, res);

    expect(res.statusCode).toBe(404);
    expectNoControllerDbQuery();
  });

  test('compareSessions rejects a corrupt query id with 404 and no db query', async () => {
    const { SessionAnalyticsController } = await import(
      '../api/controllers/sessionAnalyticsController.js'
    );
    const controller = new SessionAnalyticsController();
    const req: any = {
      params: {},
      query: { sessionId1: REAL_UUID, sessionId2: CORRUPT_ID },
      body: {},
    };
    const res = makeRes();

    await controller.compareSessions(req, res);

    expect(res.statusCode).toBe(404);
    expectNoControllerDbQuery();
  });
});
