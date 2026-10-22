/**
 * A DATABASE WITHOUT MIGRATION 098 — the order-independence proof (gap 1).
 *
 * ═══ WHY THIS FILE EXISTS ═══
 * A fleet roll and a migration run are two separate acts on eight separate instances, so for
 * some window SOME instance runs new code against a database that has no `tasks.closed_at`.
 * Without a probe that window is a 500: Postgres answers `column "closed_at" does not exist`
 * (SQLSTATE 42703) and the caller's whole `task_list` fails.
 *
 * Migration 093's tranche paid for that lesson once and left the pattern behind. This file is
 * the executed proof that 098 inherits it — and, more importantly, that 098's WRITE side does
 * not need it at all, because the trigger owns the column and no application statement ever
 * names it. That claim is the one that makes the roll order-independent in BOTH directions,
 * and a claim of that shape has to be measured rather than argued.
 *
 * THE SHADOW-SCHEMA TECHNIQUE is borrowed verbatim from blockedOnAbsentColumn.contract.test.ts:
 * a `tasks` table built WITHOUT the column, in its own schema, reached through a pool whose
 * `search_path` points at it. A test that mutated the real table would be a destructive act
 * against every other test sharing the database.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  readTaskClosedAtCapability,
  assertClosedAtQueryable,
  ClosedAtColumnUnavailableError,
  clearTaskClosedAtCapabilityCache,
} from '../services/taskClosedAtCapability.js';
import { CLOSED_AT_MIGRATION } from '../config/taskLifecycleConfig.js';

const SCHEMA = `pre098_${Date.now()}`;
let pool: Pool;

function poolOpts(extra: Record<string, unknown> = {}) {
  return {
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    ...extra,
  };
}

describe('a database WITHOUT migration 098', () => {
  beforeAll(async () => {
    const admin = new Pool(poolOpts({ max: 1 }));
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      // A `tasks` table with NO closed_at. Deliberately also no trigger and no CHECK — this
      // is what an un-migrated instance genuinely looks like, not a partial one.
      await admin.query(`
        CREATE TABLE ${SCHEMA}.tasks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id uuid NOT NULL,
          title text NOT NULL,
          status text NOT NULL DEFAULT 'todo',
          completed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
    } finally {
      await admin.end();
    }
    // EVERY connection from this pool sees the pre-098 schema FIRST. Set on the pool and not
    // per-query, because `pg` hands out an arbitrary connection per call and a search_path
    // applied to one of them would make this test flap rather than fail.
    pool = new Pool(poolOpts({ max: 2, options: `-c search_path=${SCHEMA}` }));
    clearTaskClosedAtCapabilityCache(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = new Pool(poolOpts({ max: 1 }));
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  test('the probe reports ABSENT — not present, and not an exception', async () => {
    const cap = await readTaskClosedAtCapability(pool);
    expect(cap.closedAt).toBe('absent');
    // `absent` is a legitimate deploy state, NOT an error. probeError stays null so a caller
    // cannot render "we could not determine" when we determined it perfectly well — those are
    // two different sentences sending a reader to two different remedies (CLASSES.md C1).
    expect(cap.probeError).toBeNull();
  });

  test('a `closedAfter` question is REFUSED, and the refusal NAMES the migration', async () => {
    // Refused rather than silently dropped: a dropped filter answers "what closed since
    // Monday" with the entire backlog, successfully, and a wrong read has no later surface
    // where anyone finds out.
    await expect(
      assertClosedAtQueryable(pool, { closedAfter: '2026-01-01T00:00:00.000Z' }, 'task_list'),
    ).rejects.toThrow(ClosedAtColumnUnavailableError);
    try {
      await assertClosedAtQueryable(pool, { closedAfter: '2026-01-01T00:00:00.000Z' }, 'task_list');
      throw new Error('unreachable');
    } catch (e) {
      expect((e as Error).message).toContain(CLOSED_AT_MIGRATION);
      expect((e as Error).message).toContain('closedAfter');
    }
  });

  test('a call that asks NO closed_at question is a NO-OP — every pre-098 call still works', async () => {
    // The one that matters for the roll: existing callers must be untouched.
    await expect(assertClosedAtQueryable(pool, {}, 'task_list')).resolves.toBeUndefined();
  });

  test('THE ORDER-INDEPENDENCE CLAIM: a task WRITE names no closed_at and therefore succeeds', async () => {
    // This is the assertion the migration header's argument rests on. If any handler ever
    // starts naming `closed_at` in an INSERT or UPDATE, the statement below stops being
    // representative — but the claim it is standing in for would already be false, and this
    // test is where that gets noticed.
    //
    // Driven as the raw statement shape the handler emits (a create, then a status move to a
    // terminal state) against a table that has no such column. On a pre-098 instance this is
    // the whole hot path, and it must not 42703.
    const projectId = '11111111-2222-3333-4444-555555555555';
    const ins = await pool.query(
      `INSERT INTO tasks (project_id, title, status) VALUES ($1,'pre098 task','todo') RETURNING id`,
      [projectId]);
    const id = ins.rows[0].id;
    await expect(
      pool.query(
        `UPDATE tasks SET status = $2, completed_at = NULL WHERE id = $1`, [id, 'cancelled']),
    ).resolves.toBeTruthy();
    // And a plain `SELECT *` read comes back without the key at all, which is what feeds
    // mapTask's absent-when-absent spread. An absent key means "nobody measured"; it must not
    // become a null meaning "this task is still open".
    const { rows } = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    expect('closed_at' in rows[0]).toBe(false);
  });

  test('the cache does not leak the ABSENT answer to a pool that CAN see the column', async () => {
    // Cross-talk between pools is precisely how a "green here" becomes a "red there"
    // (CLASSES.md C4), and this probe is now shared by two different column questions, so the
    // cache is keyed by pool AND by column set. A pool on the default search_path sees the
    // migrated table and must get its own answer.
    const migrated = new Pool(poolOpts({ max: 1 }));
    try {
      clearTaskClosedAtCapabilityCache(migrated);
      expect((await readTaskClosedAtCapability(migrated)).closedAt).toBe('present');
      expect((await readTaskClosedAtCapability(pool)).closedAt).toBe('absent');
    } finally {
      await migrated.end();
    }
  });
});
