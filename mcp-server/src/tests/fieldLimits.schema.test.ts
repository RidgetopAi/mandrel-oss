/**
 * FIELD-SIZE CAP ANTI-DRIFT CONTRACT TEST
 *
 * THE BUG THIS IS THE FUSE FOR:
 *   middleware/validation.ts carried ~30 hand-written `.max(N)` literals that had drifted
 *   from the columns they validate, in BOTH directions:
 *     (a) TOO TIGHT — task_create.description capped at 2000 against a TEXT column. It
 *         rejected a live incident record three times in two minutes and forced a spec out
 *         of a task and into a context.
 *     (b) TOO LOOSE — assignedTo/createdBy were unbounded z.string() over varchar(200)
 *         columns, so an over-length value passed validation and hit Postgres as a raw
 *         22001 → HTTP 500 with a driver error instead of an actionable message.
 *
 * WHY THIS TEST CAN'T BE A NO-OP (the "measures nothing passes everything" bar):
 *   A test that merely re-asserted the numbers in config/fieldLimits.ts against themselves
 *   would be a tautology — green whether or not the caps match the database. So the SCHEMA
 *   TRUTH suite below reads the REAL columns out of `information_schema` on the live
 *   migrated database and compares them to what the registry DECLARES. The database is the
 *   independent oracle; the config cannot lie to it.
 *
 *   Each suite states what makes it go RED:
 *     1. SCHEMA TRUTH   — ALTER a column (varchar(200)→varchar(400), TEXT→varchar, drop a
 *                         column) and the declared shape stops matching reality → RED.
 *     2. DERIVATION     — hand-edit a cap (max=2000 on a TEXT field, or a varchar cap that
 *                         isn't the column length) without a written deviationReason → RED.
 *     3. NO LITERALS    — add `description: z.string().max(2000)` back into validation.ts
 *                         and the source scan finds a raw field-size literal → RED.
 *     4. ENFORCEMENT    — the zod schemas are exercised at the boundary (cap vs cap+1) so
 *                         "the config says 5,000,000" is proven to be what the VALIDATOR
 *                         actually does, not just what a constant claims.
 *
 * DB target: the disposable migrated database created by the CI gate (dropped on exit).
 * NEVER the production `mandrel` DB. This suite is READ-ONLY against the schema — it
 * creates no rows and alters nothing.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { db } from '../config/database.js';
import {
  COLUMN_BACKED_LIMITS,
  TRANSIENT_LIMITS,
  TEXT_ANTI_ABUSE_CEILING,
  cap,
  type ColumnBackedLimit,
} from '../config/fieldLimits.js';
import { validationSchemas } from '../middleware/validation.js';

const entries = Object.entries(COLUMN_BACKED_LIMITS) as [string, ColumnBackedLimit][];

/** The REAL shape of a column, straight from the database. */
interface LiveColumn {
  data_type: string;
  character_maximum_length: number | null;
}

const live = new Map<string, LiveColumn | null>();

beforeAll(async () => {
  // One round-trip: fetch every column the registry claims to know about.
  const tables = [...new Set(entries.map(([, l]) => l.table))];
  const res = await db.query(
    `SELECT table_name, column_name, data_type, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables]
  );
  for (const [key, limit] of entries) {
    const row = res.rows.find(
      (r: any) => r.table_name === limit.table && r.column_name === limit.column
    );
    live.set(
      key,
      row
        ? {
            data_type: row.data_type,
            character_maximum_length:
              row.character_maximum_length === null ? null : Number(row.character_maximum_length),
          }
        : null
    );
  }
});

afterAll(async () => {
  await db.end?.();
});

describe('field limits — 1. SCHEMA TRUTH (registry vs the LIVE information_schema)', () => {
  test('the registry is not empty (a vacuous suite would pass trivially)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  test.each(entries)('%s — the column actually exists in the database', (key) => {
    expect(live.get(key), `${key} is declared in COLUMN_BACKED_LIMITS but does NOT exist in the database`).not.toBeNull();
  });

  test.each(entries)(
    '%s — the DECLARED db shape matches the REAL column',
    (key, limit) => {
      const real = live.get(key);
      expect(real, `${key}: column missing`).toBeTruthy();

      if (limit.db.type === 'text') {
        // If someone ALTERs this to a varchar, this assertion names the column and fails.
        expect(
          real!.data_type,
          `${key} is declared TEXT in config/fieldLimits.ts but the database says ` +
            `'${real!.data_type}'. The schema changed — update the registry entry (and the ` +
            `cap it derives) to match reality.`
        ).toBe('text');
      } else {
        expect(
          real!.data_type,
          `${key} is declared varchar in config/fieldLimits.ts but the database says ` +
            `'${real!.data_type}'.`
        ).toBe('character varying');
        expect(
          real!.character_maximum_length,
          `${key} is declared varchar(${limit.db.length}) but the database column is ` +
            `varchar(${real!.character_maximum_length}). THIS IS THE DRIFT THIS TEST EXISTS ` +
            `TO CATCH — the validator cap derives from the declared length, so it is now ` +
            `${limit.max > (real!.character_maximum_length ?? 0) ? 'ACCEPTING VALUES POSTGRES WILL REJECT (raw 22001 → 500)' : 'rejecting values the column would happily store'}. ` +
            `Update the registry entry to the real length.`
        ).toBe(limit.db.length);
      }
    }
  );
});

describe('field limits — 2. DERIVATION (a cap must be derived, or argued in writing)', () => {
  test.each(entries)('%s — cap is derived from the column (or carries a deviationReason)', (key, limit) => {
    const natural = limit.db.type === 'text' ? TEXT_ANTI_ABUSE_CEILING : limit.db.length;
    if (limit.max !== natural) {
      // Deviation is ALLOWED — but never silent. This is the acceptance criterion
      // "matches reality or carries a written justification", enforced mechanically.
      expect(
        limit.deviationReason && limit.deviationReason.trim().length > 20,
        `${key} caps at ${limit.max} but its column's natural bound is ${natural}. A ` +
          `deliberate deviation is fine — but it MUST carry a substantive 'deviationReason' ` +
          `in config/fieldLimits.ts explaining why. Undocumented deviation IS the drift.`
      ).toBe(true);
    } else {
      expect(limit.max).toBe(natural);
    }
  });

  test.each(entries)('%s — a varchar cap never exceeds the column (no raw 22001 → 500)', (key, limit) => {
    if (limit.db.type !== 'varchar') return;
    const real = live.get(key);
    expect(
      limit.max,
      `${key}: the validator would accept ${limit.max} chars but the column holds only ` +
        `${real?.character_maximum_length}. Nothing truncates in between — Postgres would ` +
        `throw 22001 and the caller would get a 500 with a driver error.`
    ).toBeLessThanOrEqual(real!.character_maximum_length!);
  });

  test.each(entries)('%s — every cap states WHY it exists', (key, limit) => {
    expect(limit.why.trim().length, `${key} has no stated justification`).toBeGreaterThan(20);
  });

  test('every transient (non-column) limit also states WHY it exists', () => {
    for (const [key, v] of Object.entries(TRANSIENT_LIMITS)) {
      expect(v.why.trim().length, `TRANSIENT_LIMITS.${key} has no stated justification`).toBeGreaterThan(20);
      expect(v.max, `TRANSIENT_LIMITS.${key} must be a positive cap`).toBeGreaterThan(0);
    }
  });
});

describe('field limits — 3. NO LITERALS (a re-drifted cap cannot be hand-typed back in)', () => {
  /**
   * Scans the validation.ts SOURCE for a raw field-size literal on a string field.
   *
   * This is the guard that catches the NEXT drift at its source: the original bug was
   * someone typing `.max(2000)` next to a TEXT column. Everything must go through
   * cap()/transientCap().
   *
   * HISTORY (why this once had a dead-block EXCLUSION): validation.ts used to carry dead
   * naming_ / agent_ / complexity_ / code_ schema blocks whose `.max()` LITERALS were left
   * as-is (no column behind them to derive from), so the scan excluded them by name. Those
   * dead blocks were DELETED in the MCP-2026 rebuild Phase 1 — every
   * remaining schema block is LIVE and column-backed, so there is nothing to exclude and the
   * scan now covers the WHOLE file (strictly stronger than before). The direct fuse below is
   * kept: the exact decision prose fields a prior Reviewer REJECT proved could go unguarded
   * MUST still be present and scanned.
   */
  test('validation.ts contains no raw field-size literal on a z.string() field', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, '..', 'middleware', 'validation.ts'), 'utf8');

    // Guard the guard: if the file moves/renames, fail loudly rather than scan nothing.
    expect(src.length, 'validation.ts source not found / empty — this scan would be a no-op').toBeGreaterThan(1000);
    expect(src).toContain('const taskSchemas');
    expect(src).toContain('const decisionSchemas');

    const lines = src.split('\n');

    // THE DIRECT FUSE: the precise decision prose fields a prior Reviewer REJECT proved
    // could silently go unguarded must be PRESENT (and — now that nothing is excluded —
    // therefore scanned). If any disappears, this names it immediately.
    // NOTE: these prose fields are WRAPPED in artifactFreeText(...), so the
    // declaration reads `<field>: artifactFreeText(z.string()...)` OR (unwrapped) `<field>: z.string()`.
    for (const field of ['outcomeNotes', 'lessonsLearned', 'successCriteria', 'problemStatement', 'supersededReason']) {
      const hits = lines.filter((l) => new RegExp(`^\\s*${field}: (?:artifactFreeText\\()?z\\.string\\(\\)`).test(l));
      expect(hits.length, `No '${field}: z.string()' declaration found — this fuse would measure nothing.`).toBeGreaterThan(0);
    }

    // Scan EVERY line (no exclusions — all remaining schema blocks are live + column-backed).
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      const code = line.split('//')[0]; // ignore comments (they cite old caps on purpose)
      // Match a numeric `.max()` applied DIRECTLY to a z.string() (optionally through the
      // string refiners that may precede it). Deliberately does NOT match `.max(N)` on an
      // ARRAY — `z.array(z.string()).max(10)` bounds the ITEM COUNT, not a field size, and
      // is governed by TRANSIENT_LIMITS/config elsewhere. Flagging those would be a false
      // positive that trains people to ignore this gate.
      if (/z\.string\(\)(?:\.(?:min|trim|regex|email|url|uuid|nonempty)\([^()]*\))*\.max\(\s*\d/.test(code)) {
        offenders.push(`  line ${i + 1}: ${line.trim()}`);
      }
    });

    expect(
      offenders,
      `Raw field-size literal(s) found in validation.ts. A hand-typed cap is exactly what ` +
        `drifted from the schema. Use cap('<table>.<column>') for a field ` +
        `backed by a column, or transientCap('<key>') for an input that is never stored — ` +
        `both from config/fieldLimits.ts:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});

describe('field limits — 4. ENFORCEMENT (the VALIDATOR does what the config says)', () => {
  const long = (n: number) => 'x'.repeat(n);

  test('task_create accepts the ~3000-char description that used to be rejected', () => {
    // The exact shape of the call that failed: a real spec/incident record in a task.
    const parsed = validationSchemas.task_create.parse({
      title: 'Anti-drift regression: a 3000-char task description',
      description: long(3000),
    });
    expect((parsed as any).description).toHaveLength(3000);
  });

  test('task_create.description is capped at the TEXT anti-abuse ceiling, not below it', () => {
    // At the ceiling: accepted.
    expect(() =>
      validationSchemas.task_create.parse({ title: 't', description: long(cap('tasks.description')) })
    ).not.toThrow();
    // Above the ceiling: rejected (the anti-abuse guard is still REAL, not removed).
    expect(() =>
      validationSchemas.task_create.parse({ title: 't', description: long(cap('tasks.description') + 1) })
    ).toThrow();
  });

  test('task_create.title uses the whole varchar(500) column (was wrongly capped at 255)', () => {
    expect(() => validationSchemas.task_create.parse({ title: long(500) })).not.toThrow();
    expect(() => validationSchemas.task_create.parse({ title: long(501) })).toThrow();
  });

  test('assignedTo is bounded to varchar(200) on EVERY sibling path (create/update/bulk)', () => {
    // The (b)-direction bug: these used to ACCEPT 201 chars and detonate in Postgres.
    expect(() => validationSchemas.task_create.parse({ title: 't', assignedTo: long(200) })).not.toThrow();
    expect(() => validationSchemas.task_create.parse({ title: 't', assignedTo: long(201) })).toThrow();

    const id = '00000000-0000-0000-0000-000000000001';
    expect(() => validationSchemas.task_update.parse({ taskId: id, assignedTo: long(200) })).not.toThrow();
    expect(() => validationSchemas.task_update.parse({ taskId: id, assignedTo: long(201) })).toThrow();

    expect(() =>
      validationSchemas.task_bulk_update.parse({ task_ids: [id], assignedTo: long(200) })
    ).not.toThrow();
    expect(() =>
      validationSchemas.task_bulk_update.parse({ task_ids: [id], assignedTo: long(201) })
    ).toThrow();
  });

  test('createdBy is bounded to its varchar(200) column', () => {
    expect(() => validationSchemas.task_create.parse({ title: 't', createdBy: long(200) })).not.toThrow();
    expect(() => validationSchemas.task_create.parse({ title: 't', createdBy: long(201) })).toThrow();
  });

  test('decision prose fields hold long-form text (rationale was wrongly capped at 2000)', () => {
    expect(() =>
      validationSchemas.decision_record.parse({
        decisionType: 'architecture',
        title: 'A decision with a long rationale',
        description: long(20_000),
        rationale: long(20_000),
        impactLevel: 'high',
      })
    ).not.toThrow();
  });

  test('context_store keeps its 5MB ceiling (the precedent must not regress)', () => {
    expect(cap('contexts.content')).toBe(TEXT_ANTI_ABUSE_CEILING);
    expect(() =>
      validationSchemas.context_store.parse({ content: long(23_000), type: 'discussion' })
    ).not.toThrow();
  });
});
