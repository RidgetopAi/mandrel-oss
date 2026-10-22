/**
 * assignedToFieldLimit — the `tasks.assigned_to` cap is the COLUMN's, on every surface
 * (Phase 1 item 2).
 *
 * THE DEFECT: this backend's zod schemas capped `assigned_to` at a literal 100 while the
 * column is varchar(200) and the MCP surface caps at 200. A 101..200-char assignee that
 * MCP accepted and Postgres stored was rejected by the Command UI.
 *
 * WHY THE TEST IS DB-BACKED: the fix is only a fix if the declared cap equals the LIVE
 * column, which is the lowest rung of the instrument ladder (C1) — a declaration in a
 * config file can be confidently wrong about a column. So the first assertion reads
 * `information_schema` on the real migrated database, and the rest exercise the zod
 * schemas that DERIVE from that declaration. If someone ALTERs the column, this goes RED
 * and names it.
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

import { db } from '../database/connection';
import { COLUMN_BACKED_LIMITS, TASKS_ASSIGNED_TO } from '../config/fieldLimits';
import { CreateTaskSchema, UpdateTaskSchema } from '../validation/schemas';

describeDb('tasks.assigned_to cap is derived from the column', () => {
  const pool = db;

  beforeAll(async () => {
    await assertDbReachable(pool);
  }, 120000);

  afterAll(async () => {
    await pool.end();
  });

  it('every declared column-backed limit matches the LIVE information_schema', async () => {
    // NON-EMPTY TRAP: an empty registry would make this loop assert nothing.
    expect(COLUMN_BACKED_LIMITS.length).toBeGreaterThan(0);

    for (const limit of COLUMN_BACKED_LIMITS) {
      const { rows } = await pool.query(
        `SELECT data_type, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [limit.table, limit.column]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe('character varying');
      expect(rows[0].character_maximum_length).toBe(limit.length);

      // The cap is DERIVED, so there is no free number to get wrong. Asserted anyway
      // because `varcharColumn` is the only thing enforcing it.
      expect(limit.max).toBe(limit.length);
      expect(limit.why.trim().length).toBeGreaterThan(0);
    }
  });

  it('CreateTask accepts an assignee at the column length and rejects one over it', () => {
    const atCap = 'a'.repeat(TASKS_ASSIGNED_TO.max);
    const overCap = 'a'.repeat(TASKS_ASSIGNED_TO.max + 1);
    const base = {
      title: 'cap probe',
      type: 'general' as const,
      priority: 'medium' as const,
      project_id: '00000000-0000-4000-8000-000000000000',
    };

    expect(CreateTaskSchema.safeParse({ ...base, assigned_to: atCap }).success).toBe(true);
    expect(CreateTaskSchema.safeParse({ ...base, assigned_to: overCap }).success).toBe(false);
  });

  it('UpdateTask accepts an assignee at the column length and rejects one over it', () => {
    const atCap = 'b'.repeat(TASKS_ASSIGNED_TO.max);
    const overCap = 'b'.repeat(TASKS_ASSIGNED_TO.max + 1);

    expect(UpdateTaskSchema.safeParse({ assigned_to: atCap }).success).toBe(true);
    expect(UpdateTaskSchema.safeParse({ assigned_to: overCap }).success).toBe(false);
  });

  it('accepts the length range that the OLD literal-100 cap wrongly rejected', () => {
    // The regression this task exists to close, stated as a value rather than a number:
    // a 150-char assignee is legal to Postgres and to MCP, so it must be legal here.
    const wasRejected = 'c'.repeat(150);
    expect(wasRejected.length).toBeGreaterThan(100);
    expect(wasRejected.length).toBeLessThanOrEqual(TASKS_ASSIGNED_TO.max);
    expect(UpdateTaskSchema.safeParse({ assigned_to: wasRejected }).success).toBe(true);
  });
});
