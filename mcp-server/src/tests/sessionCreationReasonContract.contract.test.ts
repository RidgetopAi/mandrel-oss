/**
 * CREATION-REASON CONTRACT — the lockstep guard (Amp-orb eval finding W3).
 *
 * THE ARRANGEMENT THIS GUARDS: the creation-reason vocabulary exists in TWO
 * places by necessity — as a TypeScript constant (`SESSION_CREATION_REASONS`, which the
 * product reads) and as a Postgres CHECK constraint (migration 068, which is the fail-closed
 * gate that stops an out-of-vocabulary value ever reaching a row). Two copies that agree
 * today. **You can weaken one without the other noticing.** That is not a bug in either copy;
 * it is a bug in the arrangement, and it is what this file removes.
 *
 * HOW IT IS BUILT — every assertion CALLS or INTERROGATES the thing it guards:
 *   1. The SQL side is read from the LIVE DATABASE (`pg_get_constraintdef`), not from a model
 *      of what the migration ought to have produced. When the consumer is an interpreter, the
 *      test must BE the interpreter (second rule) — so we ask Postgres what it
 *      actually enforces.
 *   2. The migration FILE is parsed too, so a hand-edit to a live DB cannot mask a migration
 *      that no longer ships the constraint.
 *   3. The TS side is IMPORTED from the product. There is no second list here.
 *   4. FAIL-CLOSED: if the constraint cannot be found, or its vocabulary cannot be parsed, the
 *      test goes RED. An unparseable guard is never a silent pass.
 *   5. The DENY behaviour is exercised for real: an out-of-vocabulary INSERT must be REJECTED
 *      by the database. A CHECK that exists but does not bite is decoration.
 *   6. Every PRODUCTION create path is driven end-to-end and its stamped value asserted to be
 *      inside the vocabulary — so a new path that stamps something the contract does not
 *      declare is caught here, not in prod.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import {
  SESSION_CREATION_REASONS,
  isSessionCreationReason,
} from '../config/sessionIdentityConfig.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, '..', '..', 'database', 'migrations', '068_add_session_creation_reason.sql');
const CONSTRAINT = 'sessions_creation_reason_check';

const STAMP = Date.now();
let projectId: string;
const createdSessionIds: string[] = [];
const createdTaskIds: string[] = [];
const createdActors: string[] = [];

const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode;
  ActiveSessionStore.clearAll();
});

beforeAll(async () => {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-CreationReason-${STAMP}`, 'creation-reason contract'],
  );
  projectId = r.rows[0].id;
});

afterAll(async () => {
  if (createdTaskIds.length > 0) await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
  if (createdActors.length > 0) await db.query('DELETE FROM session_pins WHERE actor = ANY($1::text[])', [createdActors]);
  if (createdSessionIds.length > 0) {
    await db.query('DELETE FROM analytics_events WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM tasks WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdSessionIds]);
  }
  await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

/**
 * Extract the quoted vocabulary from a CHECK definition. FAIL-CLOSED: an input we cannot make
 * sense of throws, so an unrecognised shape is a loud RED rather than an empty set that would
 * trivially "match" anything.
 */
function parseCheckVocabulary(def: string, where: string): string[] {
  if (!def || def.trim() === '') {
    throw new Error(`creation-reason CHECK is EMPTY/MISSING in ${where} — nothing is enforced`);
  }
  if (!/creation_reason/.test(def)) {
    throw new Error(`the definition found in ${where} does not mention creation_reason: ${def}`);
  }
  const quoted = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // Postgres renders the type casts as ::text; those are not quoted, so `quoted` is the
  // vocabulary. An empty vocabulary means the CHECK constrains nothing → RED.
  if (quoted.length === 0) {
    throw new Error(`no vocabulary values could be parsed out of the CHECK in ${where}: ${def}`);
  }
  return [...new Set(quoted)].sort();
}

describe('creation-reason vocabulary — the TS constant and the DB CHECK cannot drift apart', () => {
  test('the LIVE database enforces exactly the vocabulary the product declares', async () => {
    const r = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [CONSTRAINT],
    );
    // FAIL-CLOSED: a missing constraint is a RED, not a skipped test.
    expect(r.rows.length, `constraint '${CONSTRAINT}' does not exist on this database`).toBe(1);

    const def: string = r.rows[0].def;
    // The CHECK must admit NULL (every pre-068 row) — otherwise the migration would fail on
    // real data, and the read model's "NOT RECORDED" branch would be unreachable.
    expect(def, 'the CHECK must admit NULL for pre-migration rows').toMatch(/IS NULL/i);

    const dbVocabulary = parseCheckVocabulary(def, 'the live database');
    expect(dbVocabulary).toEqual([...SESSION_CREATION_REASONS].sort());
  });

  test('the committed MIGRATION FILE ships that same vocabulary', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    // Isolate the ADD CONSTRAINT statement so the doc comment above it (which names the values
    // in prose) cannot satisfy this check. A text search must never stand in for the artifact.
    const stmt = sql.match(/ADD CONSTRAINT\s+sessions_creation_reason_check[\s\S]*?;/i)?.[0];
    expect(stmt, `no ADD CONSTRAINT ${CONSTRAINT} statement found in ${MIGRATION}`).toBeTruthy();

    const fileVocabulary = parseCheckVocabulary(stmt as string, 'the migration file');
    expect(fileVocabulary).toEqual([...SESSION_CREATION_REASONS].sort());
  });

  test('the DENY actually bites — Postgres REJECTS an out-of-vocabulary value', async () => {
    // Ask the interpreter, do not model it. A CHECK that exists but does not reject is
    // decoration; this is the assertion that proves it is a gate.
    const id = randomUUID();
    let err: any = null;
    try {
      await db.query(
        `INSERT INTO sessions (id, project_id, agent_type, started_at, last_activity_at, status, creation_reason)
         VALUES ($1, $2, 'AI Model', now(), now(), 'active', $3)`,
        [id, projectId, 'definitely-not-in-the-vocabulary'],
      );
    } catch (e) {
      err = e;
    }
    expect(err, 'the INSERT was ACCEPTED — the CHECK is not enforcing anything').toBeTruthy();
    // A bare "it threw" would also pass if the COLUMN were missing entirely (measured: it did,
    // on a DB migrated before 068 existed). Pin the failure to the SPECIFIC constraint:
    // SQLSTATE 23514 = check_violation, and the constraint name must be ours.
    expect(err.code, `expected a check_violation (23514), got ${err.code}: ${err.message}`).toBe('23514');
    expect(err.constraint).toBe(CONSTRAINT);

    // …and nothing was written.
    const n = (await db.query('SELECT count(*)::int AS n FROM sessions WHERE id = $1', [id])).rows[0].n;
    expect(n).toBe(0);
  });

  test('NULL is still accepted (the "NOT RECORDED" case the read model reports on)', async () => {
    const id = randomUUID();
    createdSessionIds.push(id);
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, started_at, last_activity_at, status, creation_reason)
       VALUES ($1, $2, 'AI Model', now(), now(), 'active', NULL)`,
      [id, projectId],
    );
    const row = (await db.query('SELECT creation_reason FROM sessions WHERE id = $1', [id])).rows[0];
    expect(row.creation_reason).toBeNull();
  });

  test('the type guard is deny-by-default on anything it does not recognise', () => {
    for (const ok of SESSION_CREATION_REASONS) expect(isSessionCreationReason(ok)).toBe(true);
    for (const bad of ['', ' explicit', 'EXPLICIT', 'unknown', 'unspecified', null, undefined, 7, {}]) {
      expect(isSessionCreationReason(bad as unknown), `'${String(bad)}' must NOT be accepted`).toBe(false);
    }
  });
});

describe('every PRODUCTION create path stamps a reason inside the vocabulary', () => {
  test('the lazy action gate (a write with no session) stamps automatic-write', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `cr-gate-${STAMP}`;
    createdActors.push(actor);
    const resp = await routeExecutor(
      'task_create',
      { title: `cr-gate-${STAMP}`, projectId },
      { connectionId: `cr-gate-conn-${STAMP}`, actor },
    );
    const taskId = (resp as any).structuredContent?.task?.id;
    if (taskId) createdTaskIds.push(taskId);

    const row = (
      await db.query('SELECT id, creation_reason FROM sessions WHERE actor = $1', [actor])
    ).rows[0];
    createdSessionIds.push(row.id);
    expect(isSessionCreationReason(row.creation_reason)).toBe(true);
    expect(row.creation_reason).toBe('automatic-write');
  });

  test('the session_start tool stamps explicit — in BOTH resolver modes', async () => {
    for (const mode of ['actor', 'legacy'] as const) {
      SESSION_CONFIG.resolverMode = mode;
      const actor = `cr-start-${mode}-${STAMP}`;
      createdActors.push(actor);
      const resp = await routeExecutor(
        'session_start',
        { title: `cr-start-${mode}` },
        { connectionId: `cr-start-${mode}-conn-${STAMP}`, actor },
      );
      const sid = (resp as any).structuredContent.sessionId;
      createdSessionIds.push(sid);

      const row = (await db.query('SELECT creation_reason FROM sessions WHERE id = $1', [sid])).rows[0];
      expect(isSessionCreationReason(row.creation_reason), `mode=${mode}`).toBe(true);
      expect(row.creation_reason, `mode=${mode}`).toBe('explicit');
    }
  });

  test('the lazy action gate in LEGACY mode also stamps automatic-write (both modes agree)', async () => {
    SESSION_CONFIG.resolverMode = 'legacy';
    const connectionId = `cr-legacy-conn-${STAMP}`;
    const actor = `cr-legacy-${STAMP}`;
    createdActors.push(actor);
    const resp = await routeExecutor(
      'task_create',
      { title: `cr-legacy-${STAMP}`, projectId },
      { connectionId, actor },
    );
    const taskId = (resp as any).structuredContent?.task?.id;
    if (taskId) createdTaskIds.push(taskId);

    const row = (
      await db.query('SELECT id, creation_reason FROM sessions WHERE connection_id = $1', [connectionId])
    ).rows[0];
    createdSessionIds.push(row.id);
    expect(row.creation_reason).toBe('automatic-write');
  });

  test('NO session created by a production path is left with a NULL reason', async () => {
    // Sweep every session this suite's actors produced. A NULL here means some path slipped
    // past the required-field choke point.
    const rows = (
      await db.query(
        `SELECT id, creation_reason FROM sessions WHERE actor = ANY($1::text[])`,
        [createdActors],
      )
    ).rows;
    expect(rows.length, 'no sessions were created — this sweep would prove nothing').toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        isSessionCreationReason(row.creation_reason),
        `session ${row.id} has creation_reason '${row.creation_reason}' — outside the vocabulary`,
      ).toBe(true);
    }
  });
});
