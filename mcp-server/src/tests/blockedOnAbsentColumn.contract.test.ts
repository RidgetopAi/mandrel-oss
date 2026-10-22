/**
 * PROOF 3 — THE ABSENT COLUMN (SCOPE §8.6: "Code must tolerate the ABSENT column").
 *
 * ═══ WHY THIS TEST IS THE ONE THAT MATTERS ═══
 * P5.5 is the tranche's only schema migration. A fleet roll and a migration run are two
 * separate acts on eight separate instances, so for some window SOME instance runs new code
 * against a pre-093 database. Without the capability probe that window is not a degraded
 * section — it is a 500 on the whole `project_briefing` call, because Postgres answers
 * `column "blocked_on" does not exist` (SQLSTATE 42703) and takes the statement with it.
 *
 * Every other way of establishing this property is a claim about a claim: reading the code,
 * mocking the pool, or asserting that a comment says so. So this test creates a REAL
 * POSTGRES SCHEMA whose `tasks` table genuinely lacks both columns, points a REAL pool at it
 * with `search_path`, and runs the SHIPPED gather against it. If the reader ever names the
 * column unconditionally again, this goes RED with Postgres's own 42703 rather than with an
 * assertion the author wrote.
 *
 * ═══ WHY A SCHEMA AND NOT A SECOND DATABASE ═══
 * `taskBlockedOnCapability` asks `information_schema.columns WHERE table_schema =
 * current_schema()`, so a `search_path`-scoped pool is genuinely a different schema to it —
 * the probe cannot tell this apart from a pre-093 database, which is the point. A second
 * DATABASE would be more faithful and is not reachable from a suite the clean gate points at
 * one DB. THAT more faithful run was ALSO performed, out of band, against a database
 * provisioned at migration 092 and never migrated further; its captured output is at
 * reports/artifacts/p5-5-blocked-on/. This test is the in-CI guard; that artifact is the
 * stronger single measurement. Neither replaces the other.
 *
 * ═══ WHAT THIS TEST DOES *NOT* COVER, STATED ═══
 * The fabricated `tasks` table below carries only the columns the waiting path reads. It is
 * not the real pre-093 schema and does not claim to be. It proves the reader survives their
 * ABSENCE; it does not prove anything about the rest of the briefing on a pre-093 database.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  gatherWaitingOnHuman,
  type BriefingWaiting,
} from '../services/waitingOnHuman.js';
import {
  readTaskBlockedOnCapability,
  assertBlockedOnWritable,
  BlockedOnColumnUnavailableError,
  clearTaskBlockedOnCapabilityCache,
  assertDueAtQueryable,
} from '../services/taskBlockedOnCapability.js';
import { BLOCKED_ON_MIGRATION } from '../config/blockedOnConfig.js';

const SCHEMA = `p55_pre093_${Date.now()}`;
const OPEN_STATUSES = ['todo', 'in_progress', 'blocked'];

let pool: Pool;
const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

describe('P5.5 PROOF 3 — a database WITHOUT migration 093', () => {
  beforeAll(async () => {
    pool = new Pool({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT ?? 5432),
      database: process.env.DATABASE_NAME,
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      max: 2,
      // EVERY connection from this pool sees the pre-093 schema FIRST. Set on the pool and
      // not per-query, because `pg` hands out an arbitrary connection per call and a
      // search_path applied to one of them would make this test flap rather than fail.
      options: `-c search_path=${SCHEMA}`,
    });

    // A tasks table WITHOUT blocked_on and WITHOUT due_at. `technical_decisions` too,
    // because the tag-collision finding scans it — the point is that the WHOLE gather
    // survives, not just its first query.
    const admin = new Pool({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT ?? 5432),
      database: process.env.DATABASE_NAME,
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      max: 1,
    });
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await admin.query(`
        CREATE TABLE ${SCHEMA}.tasks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id uuid NOT NULL,
          title text NOT NULL,
          description text,
          status text NOT NULL DEFAULT 'todo',
          priority text NOT NULL DEFAULT 'medium',
          tags text[] NOT NULL DEFAULT '{}',
          archived_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      await admin.query(`
        CREATE TABLE ${SCHEMA}.technical_decisions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id uuid NOT NULL,
          tags text[] NOT NULL DEFAULT '{}',
          archived_at timestamptz
        )`);
      await admin.query(
        `INSERT INTO ${SCHEMA}.tasks (project_id, title, status, tags)
         VALUES ($1, 'pre093 blocked task', 'blocked', ARRAY['needs-operator','needs:operator']),
                ($1, 'pre093 open task', 'todo', ARRAY['scope:product'])`,
        [PROJECT_ID],
      );
    } finally {
      await admin.end();
    }
    clearTaskBlockedOnCapabilityCache(pool);
  });

  afterAll(async () => {
    if (pool) {
      const admin = new Pool({
        host: process.env.DATABASE_HOST,
        port: Number(process.env.DATABASE_PORT ?? 5432),
        database: process.env.DATABASE_NAME,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        max: 1,
      });
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  test('the CONTROL: this schema really does lack both columns', async () => {
    // Before trusting any FAIL below, show the setup is what it claims to be. A test that
    // asserted graceful degradation against a schema that HAD the columns would pass for the
    // wrong reason and prove nothing (CLASSES.md C3: prove the mutation LANDED).
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tasks'`,
    );
    const names = rows.map((r: any) => r.column_name);
    expect(names, 'the fixture schema has no tasks table at all').toContain('title');
    expect(names).not.toContain('blocked_on');
    expect(names).not.toContain('due_at');
  });

  test('the probe reports ABSENT — not `unknown`, and not a throw', async () => {
    const cap = await readTaskBlockedOnCapability(pool);
    expect(cap.blockedOn).toBe('absent');
    expect(cap.dueAt).toBe('absent');
    // ABSENT is a MEASUREMENT and carries no error. Folding it in with "I could not measure"
    // is the C1 third-state defect this probe exists to avoid.
    expect(cap.probeError).toBeNull();
  });

  test('PROOF 3 — the gather DEGRADES HONESTLY instead of throwing 42703', async () => {
    let w: BriefingWaiting;
    // Not wrapped in expect().resolves: if this throws, the raw Postgres error is what the
    // reader of the failure needs to see, and it is the exact failure mode under test.
    w = await gatherWaitingOnHuman(PROJECT_ID, OPEN_STATUSES, pool);

    expect(w.source).toBe('fallback-absent-column');
    expect(w.capability.blockedOn).toBe('absent');
    // It still SERVES: the blocked row is there, so the customer gets a section rather than
    // silence. Degrading to an empty section would be the 40-minute-broken-boot failure
    // (SCOPE §8.5) one section over.
    expect(w.items.map((t) => t.title)).toContain('pre093 blocked task');
    expect(w.items.map((t) => t.title)).not.toContain('pre093 open task');
    // No row claims a blocked_on it cannot have.
    expect(w.items.every((t) => t.blockedOn === null)).toBe(true);
    expect(w.items.every((t) => t.dueAt === null)).toBe(true);
    // PRECISION IS NOT COMPUTABLE HERE, and the code says so rather than inventing a number:
    // you cannot count blocked_on='human' in a database with no such column.
    expect(w.precision).toBeNull();
    // The tag-collision finding still runs — the WHOLE gather survives, not just query one.
    expect(w.findings.collisionGroupsTotal).toBe(1);
    expect(w.findings.collisions[0].spellings).toEqual(['needs-operator', 'needs:operator']);
  });

  test('a WRITE that supplies blocked_on REFUSES loudly, naming the migration', async () => {
    // The other half of tolerating an absent column: a value the deployment cannot store
    // must not be silently discarded. Silently succeeding is worse than the 500 it replaces,
    // because the caller believes the value is set.
    await expect(
      assertBlockedOnWritable(pool, { blockedOn: 'human' }, 'task_create'),
    ).rejects.toThrow(BlockedOnColumnUnavailableError);
    await expect(
      assertBlockedOnWritable(pool, { blockedOn: 'human' }, 'task_create'),
    ).rejects.toThrow(new RegExp(BLOCKED_ON_MIGRATION));

    // THE CONTROL: a write that supplies NEITHER field is untouched by this gate. Every
    // call that predates P5.5 is that call, so a gate that refused here would break the
    // entire product on a pre-093 instance — a far worse outcome than the one it prevents.
    await expect(assertBlockedOnWritable(pool, {}, 'task_create')).resolves.toBeUndefined();
  });

  test('a READ that filters or sorts on due_at REFUSES loudly too', async () => {
    // task_list grew `dueBefore` and `sort:"dueAt"`. On this schema both name a column that
    // is not there, and the tempting third option — quietly ignoring the filter — is the
    // dangerous one: it returns a LIST, successfully, that is not the list that was asked
    // for. "What is due this week" would answer with the entire backlog and look right, and
    // unlike a bad WRITE there is no later surface where anyone finds out.
    await expect(
      assertDueAtQueryable(pool, { dueBefore: '2026-09-05T00:00:00Z' }, 'task_list'),
    ).rejects.toThrow(BlockedOnColumnUnavailableError);
    await expect(
      assertDueAtQueryable(pool, { sortsByDueAt: true }, 'task_list'),
    ).rejects.toThrow(new RegExp(BLOCKED_ON_MIGRATION));

    // THE CONTROL, and the population that matters most: a task_list call that asks for
    // NEITHER — which is every task_list call ever made before this change — must pass
    // straight through. A gate that refused here would take task_list down on every
    // pre-093 instance to protect a filter nobody used.
    await expect(assertDueAtQueryable(pool, {}, 'task_list')).resolves.toBeUndefined();
    // And the zero-ish values that slip past a truthiness check: an explicitly UNDEFINED
    // dueBefore with sortsByDueAt FALSE is still "asked for neither".
    await expect(
      assertDueAtQueryable(pool, { dueBefore: undefined, sortsByDueAt: false }, 'task_list'),
    ).resolves.toBeUndefined();
  });
});
