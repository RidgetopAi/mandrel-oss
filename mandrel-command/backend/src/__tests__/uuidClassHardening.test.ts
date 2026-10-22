/**
 * UUID-class hardening — backend guard tests.
 *
 * Backstops the systemic fix for the "unvalidated id" bug class (the class
 * behind the contoso dashboard outage). Three things are pinned here, NO DB
 * required (validateUUIDParam + isValidUuid run purely on the route param):
 *
 *   1. The shared `isValidUuid` accepts EXACTLY what Postgres `uuid` accepts —
 *      any case-insensitive 8-4-4-4-12 hex — and rejects junk. Critically it
 *      must NOT over-reject real ids (the `aaaa...` / `12345678...` non-RFC-
 *      version cases Postgres stores and accepts), which a stricter RFC regex
 *      or zod 4.x `.uuid()` would wrongly reject and log users out of valid
 *      projects.
 *   2. `validateUUIDParam(name)` returns a clean 400 for a malformed id on
 *      both `:id` and `:sessionId` routes (NOT a 500), and never reaches the
 *      handler.
 *   3. A VALID stored id still reaches the handler (no over-rejection regression).
 */
import request from 'supertest';
import express from 'express';
import { validateUUIDParam } from '../middleware/validation';
import { isValidUuid, UUID_REGEX } from '../utils/uuid';

// A real v4 UUID from the task brief (a genuine stored id shape).
const REAL_UUID = 'c875b2af-9020-41b7-9595-d70221603464';

// Ids Postgres ACCEPTS but a stricter RFC version/variant regex (or zod 4.x
// .uuid()) would WRONGLY reject. Over-rejecting these is the "M1 in reverse"
// bug — it would 400 a user out of a perfectly valid project.
const POSTGRES_ACCEPTED_NON_RFC = [
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '12345678-1234-1234-1234-123456789012',
  '00000000-0000-0000-0000-000000000000', // nil/UNASSIGNED — a castable uuid at the DB boundary
];

const JUNK_IDS = [
  'session_voiceitt-bridge', // the exact corrupt value from the contoso outage
  'not-a-uuid',
  'undefined',
  'aidis-my-project',
  '', // empty
  'c875b2af-9020-41b7-9595-d70221603464-extra',
];

describe('shared isValidUuid (single source of truth)', () => {
  test('accepts a real v4 UUID (case-insensitive)', () => {
    expect(isValidUuid(REAL_UUID)).toBe(true);
    expect(isValidUuid(REAL_UUID.toUpperCase())).toBe(true);
  });

  test('accepts every id Postgres accepts — NO over-rejection', () => {
    for (const id of POSTGRES_ACCEPTED_NON_RFC) {
      expect(isValidUuid(id)).toBe(true);
    }
  });

  test('rejects junk / corrupt ids', () => {
    for (const id of JUNK_IDS) {
      expect(isValidUuid(id)).toBe(false);
    }
  });

  test('rejects non-string input without throwing', () => {
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid(null)).toBe(false);
    expect(isValidUuid(123)).toBe(false);
    expect(isValidUuid({})).toBe(false);
  });

  test('the canonical regex is the loose Postgres-exact form (no [1-5]/[89ab] strictness)', () => {
    expect(UUID_REGEX.source).toBe(
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    );
  });
});

// ---------------------------------------------------------------------------
// Strict-RFC -> shared-validator migration.
//
// Several id-vs-name DISCRIMINATORS used to carry their OWN inline regex with
// the RFC version/variant nibbles (`-[1-5]...-[89ab]...`): the backend embedding
// route (`resolveProjectScope`), the mcp-server project handler (`getProject`),
// and `projectSwitchValidator`. Those are now migrated to the shared
// `isValidUuid`. The migration must only ever make the discriminator LOOSER (the
// shared loose set is a strict superset of the old RFC set) — never stricter —
// so a Postgres-valid non-RFC id is now correctly treated as an *id*, not a
// *name* (the over-rejection / "M1 in reverse" failure mode).
// ---------------------------------------------------------------------------
describe('discriminator migration: strict RFC regex -> shared isValidUuid (no over-rejection)', () => {
  // The exact strict regex the migrated sites used to embed inline.
  const OLD_STRICT_RFC =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  test('shared validator is a SUPERSET of the old strict regex (nothing got stricter)', () => {
    // Every id the OLD strict regex accepted, the shared validator must still
    // accept — otherwise the migration would lock a user out of a valid id.
    const strictlyAccepted = [
      REAL_UUID, // a real v4 (version 4, variant 9) — accepted by both
      'c875b2af-9020-41b7-9595-d70221603464',
      'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa',
    ];
    for (const id of strictlyAccepted) {
      expect(OLD_STRICT_RFC.test(id)).toBe(true); // sanity: old regex took it
      expect(isValidUuid(id)).toBe(true); // shared validator still takes it
    }
  });

  test('shared validator now accepts ids the OLD strict regex WRONGLY rejected (the fix)', () => {
    // These cast cleanly to Postgres `uuid` but fail the RFC version/variant
    // nibbles, so the old strict discriminator mis-routed them as NAMES.
    const wronglyRejectedByOldRegex = [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '12345678-1234-1234-1234-123456789012',
      'c875b2af-9020-71b7-c595-d70221603464', // version 7, variant c — non-RFC4122 nibbles
    ];
    for (const id of wronglyRejectedByOldRegex) {
      expect(OLD_STRICT_RFC.test(id)).toBe(false); // old regex mis-rejected it
      expect(isValidUuid(id)).toBe(true); // shared validator now accepts it
    }
  });
});

// Build a tiny app mirroring the production route shapes added in this fix.
function buildApp() {
  const app = express();
  // :id routes (decisions, sessions GET/:id, naming, tasks/:id/*)
  app.get('/sessions/:id', validateUUIDParam(), (req, res) => {
    res.status(200).json({ reachedHandler: true, id: req.params.id });
  });
  app.delete('/decisions/:id', validateUUIDParam(), (req, res) => {
    res.status(200).json({ reachedHandler: true, id: req.params.id });
  });
  // :sessionId routes (sessionCode, git, v2 proxies)
  app.get('/session-code/session/:sessionId', validateUUIDParam('sessionId'), (req, res) => {
    res.status(200).json({ reachedHandler: true, sessionId: req.params.sessionId });
  });
  app.get('/git/session/:sessionId/stats', validateUUIDParam('sessionId'), (req, res) => {
    res.status(200).json({ reachedHandler: true, sessionId: req.params.sessionId });
  });
  return app;
}

describe('validateUUIDParam on :id and :sessionId routes — clean 400, never 500', () => {
  const app = buildApp();

  const getCases: Array<[string, string]> = [
    ['/sessions', 'session_voiceitt-bridge'],
    ['/sessions', 'not-a-uuid'],
  ];

  test.each(getCases)(
    'GET %s/:id with a malformed id => 400, handler not reached',
    async (base, badId) => {
      const res = await request(app).get(`${base}/${badId}`);
      expect(res.status).toBe(400);
      expect(res.body.reachedHandler).toBeUndefined();
    }
  );

  test('DELETE /decisions/:id with a malformed id => 400, handler not reached (M2)', async () => {
    const res = await request(app).delete('/decisions/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.reachedHandler).toBeUndefined();
  });

  test('malformed :sessionId (sessionCode) => 400, not 500', async () => {
    const res = await request(app).get('/session-code/session/session_voiceitt-bridge');
    expect(res.status).toBe(400);
    expect(res.body.reachedHandler).toBeUndefined();
  });

  test('malformed :sessionId (git) => 400, not 500', async () => {
    const res = await request(app).get('/git/session/not-a-uuid/stats');
    expect(res.status).toBe(400);
    expect(res.body.reachedHandler).toBeUndefined();
  });

  test('REGRESSION: a VALID stored id still reaches the handler (:id)', async () => {
    const res = await request(app).get(`/sessions/${REAL_UUID}`);
    expect(res.status).toBe(200);
    expect(res.body.reachedHandler).toBe(true);
    expect(res.body.id).toBe(REAL_UUID);
  });

  test('REGRESSION: a VALID stored id still reaches the handler (:sessionId)', async () => {
    const res = await request(app).get(`/session-code/session/${REAL_UUID}`);
    expect(res.status).toBe(200);
    expect(res.body.reachedHandler).toBe(true);
    expect(res.body.sessionId).toBe(REAL_UUID);
  });

  test('REGRESSION: ids Postgres accepts are NOT over-rejected by the route', async () => {
    for (const id of POSTGRES_ACCEPTED_NON_RFC) {
      const res = await request(app).get(`/sessions/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.reachedHandler).toBe(true);
    }
  });
});
