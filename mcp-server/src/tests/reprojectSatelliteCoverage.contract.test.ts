/**
 * REPROJECT SATELLITE COVERAGE — the guard that stops config/reprojectConfig.ts rotting.
 *
 * THE CLASS: a move has to update the DENORMALIZED `project_id` copies that travel with a
 * record, and which tables those are is DECLARED (no catalog fact can tell us — the columns
 * involved are polymorphic and carry no foreign key). A hand-written allow-list of "the
 * tables we move" is the shape that silently under-covers after the next migration: the
 * migration author has no reason to visit a TypeScript file, and the resulting half-move is
 * invisible — no error, no missing row, just a record that has gone blind on a
 * project-scoped read.
 *
 * SO THE DECLARATION IS NOT AN ALLOW-LIST. It is a CLASSIFICATION OF THE WHOLE POPULATION,
 * and this test reads that population off the LIVE CATALOG and REDs on anything unclassified
 * (in either direction). A new project-scoped table cannot land without someone answering
 * "does this follow a record, and why not?" — the failure mode is a red test at the moment
 * the migration merges, not a corrupted move six weeks later.
 *
 * DENY BY DEFAULT: unclassified is a FINDING, never a pass.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { db } from '../config/database.js';
import {
  REPROJECT_SATELLITES,
  SATELLITE_BY_TABLE,
  RECORD_TABLE,
  REPROJECT_RECORD_TYPES,
  followersFor,
} from '../config/reprojectConfig.js';

/** Every BASE TABLE in this database that carries a `project_id` column. */
async function liveProjectScopedTables(): Promise<string[]> {
  const r = await db.query(`
    SELECT t.table_name AS name
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                      AND c.column_name = 'project_id')
     ORDER BY 1`);
  return r.rows.map((row: any) => row.name);
}

describe('reproject satellite registry covers the live schema', () => {
  afterAll(async () => {
    await db.end();
  });

  test('G1: EVERY base table carrying project_id is classified (deny by default)', async () => {
    const live = await liveProjectScopedTables();
    expect(live.length, 'sanity: the catalog query found project-scoped tables at all')
      .toBeGreaterThan(10);

    const unclassified = live.filter((t) => !SATELLITE_BY_TABLE.has(t));
    expect(
      unclassified,
      'these tables carry project_id and NOBODY has said whether a record move must ' +
        'update them. Classify each in config/reprojectConfig.ts — "follows" with the ' +
        'columns that tie a row to one record, or "unrelated"/"caller-slot"/"endpoints" ' +
        'with the reason. An unclassified table is a silent half-move.',
    ).toEqual([]);
  });

  test('G2: the registry names no table that does not exist (no dead entries)', async () => {
    const live = new Set(await liveProjectScopedTables());
    const phantom = REPROJECT_SATELLITES.map((s) => s.table).filter((t) => !live.has(t));
    expect(
      phantom,
      'the registry classifies tables that are not in the schema (or no longer carry ' +
        'project_id) — a dead entry reads as coverage it does not provide',
    ).toEqual([]);
  });

  test('G3: every column the registry matches on EXISTS on its table', async () => {
    // The follower loop interpolates these column names into SQL. They come only from this
    // frozen registry (never from caller input), but a typo would make an UPDATE throw at
    // move time rather than at merge time.
    const problems: string[] = [];
    for (const entry of REPROJECT_SATELLITES) {
      if (!entry.match) continue;
      const r = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2)`,
        [entry.table, [...entry.match.columns]],
      );
      const found = new Set(r.rows.map((x: any) => x.column_name));
      for (const c of entry.match.columns) {
        if (!found.has(c)) problems.push(`${entry.table}.${c}`);
      }
    }
    expect(problems, 'registry columns that do not exist on their table').toEqual([]);
  });

  test('G4: every non-record class carries its co-located reason', () => {
    const missing = REPROJECT_SATELLITES.filter(
      (s) => s.kind !== 'record' && s.kind !== 'follows' && !s.reason,
    ).map((s) => s.table);
    expect(
      missing,
      'a table that does NOT follow a record must say why, next to the decision — a bare ' +
        'exclusion is indistinguishable from an oversight',
    ).toEqual([]);
  });

  test('G5: every "follows" entry declares how its rows tie to a record', () => {
    const missing = REPROJECT_SATELLITES.filter((s) => s.kind === 'follows' && !s.match).map(
      (s) => s.table,
    );
    expect(missing, 'a follower with no match clause cannot be moved').toEqual([]);
  });

  test('G6: the three record tables are classified as records, and every record type has one', () => {
    for (const type of REPROJECT_RECORD_TYPES) {
      const table = RECORD_TABLE[type];
      expect(SATELLITE_BY_TABLE.get(table)?.kind, `${table} must be the 'record' class`).toBe(
        'record',
      );
      // A record table is never also a follower of itself.
      expect(followersFor(type).map((f) => f.table)).not.toContain(table);
    }
  });
});
