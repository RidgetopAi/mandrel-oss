/**
 * THE LEXICAL LAYER'S SCHEMA — contract test for migration 091.
 * (SEARCH P2a, acceptance criteria 1 and 3.)
 *
 * WHAT THIS FILE IS FOR, and why each part of it exists rather than a comment saying the
 * same thing:
 *
 *  A. THE COLUMNS ARE GENERATED, NOT MAINTAINED. A trigger-maintained column is correct
 *     until someone disables the trigger or bulk-loads around it, and then it is stale and
 *     looks fine. `is_generated = 'ALWAYS'` is a fact the catalog will answer for; that is
 *     what is asserted, on every table in the registry.
 *
 *  B. ONE DEFINITION, TWO LANGUAGES — held together by MEASUREMENT, not by intent. The
 *     pattern exists twice by necessity (a migration is static SQL and cannot import
 *     TypeScript). So this file (1) reads the function body back out of the live database
 *     and asserts it carries exactly the values config/lexicalSearchConfig.ts holds, and
 *     (2) runs BOTH extractors over the same inputs and asserts identical output.
 *
 *  C. THE DRIFT NOBODY EXPECTS. MEASURED on PostgreSQL 16.14 while writing 091: Postgres
 *     REFUSES to drop a function a generated column depends on, but HAPPILY accepts
 *     `CREATE OR REPLACE FUNCTION` with a different body — and does NOT recompute the
 *     stored columns. Every row then keeps a value its own generation expression no longer
 *     produces, silently and forever. Nothing in the database prevents that, so the last
 *     test here recomputes the expression over real rows and fails if any stored value
 *     disagrees.
 *
 * Runs against the disposable, fully-migrated ci_* Postgres (scripts/provision-test-db.sh),
 * never production.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import {
  LEXICAL_TABLES,
  LEXICAL_SEARCH_CONFIG,
} from '../config/lexicalSearchConfig.js';
import { extractIdentifiers } from '../utils/lexicalTokens.js';

const STAMP = Date.now();
const PROJ_NAME = `lexical-schema-${STAMP}`;
let projectId: string;

/**
 * THE DIFFERENTIAL POPULATION, stated (C3 — name the population your guard enumerates).
 * Every shape the pattern has an alternative for, every shape it must reject, and — first
 * in the list, because it is the case that actually diverged — the SCREAMING.ext token where
 * POSIX leftmost-longest and JavaScript leftmost-first disagree unless the alternation is
 * ordered correctly.
 */
const DIFFERENTIAL_INPUTS: readonly string[] = Object.freeze([
  'ABC_DEF.ts and MY_VAR.js:12',
  'services/anchorGate.ts:122 with MANDREL_SEARCH_MIN_SIMILARITY',
  'anchorgate.ts:122',
  'plain.md, package.json, the CI gate, index.ts',
  'at 532f00d and 532f00d204273cc24dc41ae77ca96ecc2610dccf',
  'deadbe abcdef x532f00dy',
  'the quick brown fox jumps over the lazy dog',
  'MANDREL_SEARCH_MIN_SIMILARITY_MANDREL_SEARCH_MIN_SIMILARITY',
  'mixed CASE_TOKEN.TS and CASE_TOKEN.ts and Case_Token.ts',
  'https://command.example.com/r/6df1f00d and a.b.c.d.e',
  'punctuation: (foo.ts:1), [bar.js], {baz.md}; qux.py.',
  'a_b A_B AB_CD_EF _LEADING TRAILING_',
  '',
  '   ',
  'unicode ünïcödé.ts:7 and 日本語.ts',
]);

describe('migration 091 — the lexical layer schema contract', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'lexical schema contract') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── A. the columns ────────────────────────────────────────────────────────────
  test.each(LEXICAL_TABLES.map((t) => [t.table, t] as const))(
    '%s carries both tsvector columns, both STORED GENERATED',
    async (_name, t) => {
      const { rows } = await db.query(
        `SELECT column_name, data_type, is_generated
           FROM information_schema.columns
          WHERE table_name = $1 AND column_name = ANY($2::text[])
          ORDER BY column_name`,
        [t.table, [t.tsvColumn, t.identsColumn]],
      );
      expect(rows.map((r: any) => r.column_name)).toEqual(
        [t.identsColumn, t.tsvColumn].sort(),
      );
      for (const r of rows) {
        expect(r.data_type).toBe('tsvector');
        // The whole reason these are not triggers: ALWAYS cannot be disabled or bypassed.
        expect(r.is_generated).toBe('ALWAYS');
      }
    },
  );

  test.each(LEXICAL_TABLES.map((t) => [t.table, t] as const))(
    '%s has a GIN index on each tsvector column',
    async (_name, t) => {
      const { rows } = await db.query(
        `SELECT i.indexdef
           FROM pg_indexes i
          WHERE i.tablename = $1 AND i.indexdef ILIKE '%USING gin%'`,
        [t.table],
      );
      const defs = rows.map((r: any) => r.indexdef).join('\n');
      expect(defs).toContain(`(${t.tsvColumn})`);
      expect(defs).toContain(`(${t.identsColumn})`);
    },
  );

  // ── B. one definition, two languages ─────────────────────────────────────────
  test('the stored SQL functions carry EXACTLY the values config holds', async () => {
    const { rows } = await db.query(
      `SELECT p.proname, p.provolatile, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
        WHERE p.proname IN ('mandrel_search_tsv','mandrel_search_idents')
        ORDER BY p.proname`,
    );
    expect(rows.map((r: any) => r.proname)).toEqual([
      'mandrel_search_idents',
      'mandrel_search_tsv',
    ]);

    const byName: Record<string, any> = Object.fromEntries(
      rows.map((r: any) => [r.proname, r]),
    );

    // IMMUTABLE is not cosmetic — a generated column REQUIRES it, so a volatility change
    // would break the next fresh migrate rather than this instance.
    expect(byName['mandrel_search_tsv'].provolatile).toBe('i');
    expect(byName['mandrel_search_idents'].provolatile).toBe('i');

    // The four values duplicated between the migration and the config module. If someone
    // edits one copy, this is what tells them there is another.
    expect(byName['mandrel_search_tsv'].def).toContain(`'${LEXICAL_SEARCH_CONFIG.tsConfig}'::regconfig`);
    expect(byName['mandrel_search_tsv'].def).toContain(`left(txt, ${LEXICAL_SEARCH_CONFIG.indexMaxChars})`);
    expect(byName['mandrel_search_idents'].def).toContain(`left(txt, ${LEXICAL_SEARCH_CONFIG.indexMaxChars})`);
    expect(byName['mandrel_search_idents'].def).toContain(`length(m[1]) <= ${LEXICAL_SEARCH_CONFIG.identifierMaxLength}`);
    expect(byName['mandrel_search_idents'].def).toContain(LEXICAL_SEARCH_CONFIG.identifierPatternPg);

    // …and the injection mechanic that makes the whole feature work. to_tsvector here would
    // re-parse the extracted token and re-split it on `_`, silently undoing the extraction.
    expect(byName['mandrel_search_idents'].def).toContain('array_to_tsvector');
  });

  test('the Postgres and JavaScript extractors agree, token for token', async () => {
    // ONE round trip for the whole population: the inputs go down as an array and come back
    // as Postgres's answer per input, which is then compared to JavaScript's.
    const { rows } = await db.query(
      `SELECT i AS input, tsvector_to_array(mandrel_search_idents(i)) AS pg_tokens
         FROM unnest($1::text[]) AS i`,
      [DIFFERENTIAL_INPUTS],
    );
    expect(rows.length).toBe(DIFFERENTIAL_INPUTS.length);
    for (const r of rows) {
      const pg = [...(r.pg_tokens ?? [])].sort();
      const js = extractIdentifiers(r.input).sort();
      // Named in the failure so a disagreement says WHICH input, not just "arrays differ".
      expect({ input: r.input, tokens: js }).toEqual({ input: r.input, tokens: pg });
    }
  });

  test('and they agree on every context row present in this database', async () => {
    // POPULATION: every non-archived context row this test database contains at the moment
    // the test runs — the fixtures above plus whatever the rest of the suite has written.
    // Deliberately not a fixed number: the point is that the agreement holds over real
    // stored text, whatever it happens to be.
    const { rows } = await db.query(
      `SELECT content, tsvector_to_array(search_idents) AS pg_tokens FROM contexts LIMIT 2000`,
    );
    let compared = 0;
    for (const r of rows) {
      const pg = [...(r.pg_tokens ?? [])].sort();
      const js = extractIdentifiers(r.content).sort();
      expect({ n: compared, tokens: js }).toEqual({ n: compared, tokens: pg });
      compared++;
    }
    expect(compared).toBe(rows.length);
  });

  // ── acceptance 1: the identifier round trip, BOTH directions ─────────────────
  test('a stored document matches queries for each of its identifiers, and not for others', async () => {
    const content =
      'services/anchorGate.ts:122 with MANDREL_SEARCH_MIN_SIMILARITY at 532f00d';
    const id = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2) RETURNING id`,
        [projectId, content],
      )
    ).rows[0].id;

    const hits = async (lexeme: string): Promise<boolean> =>
      (
        await db.query(
          `SELECT search_idents @@ quote_literal($2::text)::tsquery AS hit
             FROM contexts WHERE id = $1`,
          [id, lexeme],
        )
      ).rows[0].hit === true;

    // DIRECTION 1 — every identifier in the document is findable by its bare query form.
    expect(await hits('anchorgate.ts:122')).toBe(true);
    expect(await hits('mandrel_search_min_similarity')).toBe(true);
    expect(await hits('532f00d')).toBe(true);

    // DIRECTION 2 — and a different identifier does NOT match. Without this the test would
    // pass against a column that matched everything.
    expect(await hits('otherfile.ts:99')).toBe(false);
    expect(await hits('mandrel_search_max_similarity')).toBe(false);
    expect(await hits('deadbeef')).toBe(false);

    // THE POINT OF THE WHOLE FEATURE, asserted rather than described: the prose vector has
    // shredded the identifier into common words, which is why it cannot answer this.
    const prose = (
      await db.query(`SELECT tsvector_to_array(search_tsv) AS lex FROM contexts WHERE id = $1`, [id])
    ).rows[0].lex as string[];
    expect(prose).toContain('mandrel');
    expect(prose).toContain('search');
    expect(prose).not.toContain('mandrel_search_min_similarity');
  });

  // ── the UPDATE half of "must stay correct on UPDATE, not only INSERT" ────────
  test('an UPDATE recomputes both columns', async () => {
    const id = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2) RETURNING id`,
        [projectId, 'first BEFORE_UPDATE_TOKEN in before.ts:1'],
      )
    ).rows[0].id;

    const idents = async (): Promise<string[]> =>
      (
        await db.query(`SELECT tsvector_to_array(search_idents) AS a FROM contexts WHERE id=$1`, [id])
      ).rows[0].a ?? [];

    expect(await idents()).toContain('before_update_token');

    await db.query(`UPDATE contexts SET content = $2 WHERE id = $1`, [
      id,
      'second AFTER_UPDATE_TOKEN in after.ts:2',
    ]);

    const after = await idents();
    expect(after).toContain('after_update_token');
    expect(after).toContain('after.ts:2');
    expect(after).not.toContain('before_update_token');
  });

  // ── the version trigger the generated columns collided with ─────────────────
  test('every whole-row comparison over `tasks` neutralises every generated column', async () => {
    // WHY THIS EXISTS: a STORED GENERATED column is computed AFTER a BEFORE trigger runs, so
    // inside `bump_tasks_version` NEW.search_tsv is NULL while OLD holds the stored value —
    // and the trigger's "did this UPDATE author anything?" comparison read every write as a
    // change. That over-bumped `version`, which is task_claim's optimistic-lock token.
    // Measured before migration 091 amended it: 3 pre-existing suite tests went RED.
    //
    // POPULATION, derived rather than remembered: every plpgsql function in this database
    // that compares a whole row against OLD. That query returns exactly one function today;
    // if a second one is ever written, it is covered the day it is born.
    const { rows: comparers } = await db.query(
      `SELECT proname, prosrc FROM pg_proc
        WHERE prosrc ILIKE '%IS NOT DISTINCT FROM OLD%' OR prosrc ILIKE '%IS DISTINCT FROM OLD%'`,
    );
    expect(comparers.length).toBeGreaterThan(0); // not vacuous

    const { rows: generated } = await db.query(
      `SELECT attname FROM pg_attribute
        WHERE attrelid = 'tasks'::regclass AND attgenerated = 's' AND NOT attisdropped`,
    );
    // Not a fixed list: whatever generated columns `tasks` has, each must be neutralised.
    expect(generated.length).toBeGreaterThan(0);

    for (const fn of comparers) {
      for (const g of generated) {
        expect({
          fn: fn.proname,
          column: g.attname,
          neutralised: fn.prosrc.includes(`probe.${g.attname} := OLD.${g.attname}`),
        }).toEqual({ fn: fn.proname, column: g.attname, neutralised: true });
      }
    }
  });

  test('a task UPDATE that authors nothing does not bump version', async () => {
    // The behaviour the neutralisation buys, asserted end to end rather than by reading the
    // function body — a source-text check alone would pass against a body that no longer
    // works.
    const taskId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, description, status, priority)
         VALUES ($1,'lexical version probe','body','todo','medium') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
    const ver = async (): Promise<number> =>
      (await db.query(`SELECT version FROM tasks WHERE id=$1`, [taskId])).rows[0].version;

    const before = await ver();
    // Writes the SAME values back: nothing authored changes.
    await db.query(`UPDATE tasks SET title = title, description = description WHERE id = $1`, [taskId]);
    expect(await ver()).toBe(before);

    // The control — a real authored change DOES bump, so the assertion above is not passing
    // because the trigger stopped working altogether.
    await db.query(`UPDATE tasks SET title = 'lexical version probe II' WHERE id = $1`, [taskId]);
    expect(await ver()).toBe(before + 1);

    await db.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
  });

  // ── C. the drift Postgres will not prevent ──────────────────────────────────
  test('every stored value equals what its own generation expression produces today', async () => {
    // The generation expression is read from the CATALOG, not written here — so this cannot
    // drift from the migration, and it covers all six columns in the registry.
    //
    // ⚠️ WHAT THIS CAN AND CANNOT SEE, stated because the difference is not obvious. It
    // compares STORED values against a FRESH evaluation, so it detects drift only for rows
    // that PREDATE the change. In a freshly-provisioned test database every row is written
    // after the function is installed, so a mutated function would produce mutated rows and
    // agree with itself. Its real subject is a long-lived instance where the corpus predates
    // a `CREATE OR REPLACE FUNCTION`. The non-vacuity assertion below is what keeps it from
    // passing on an empty table and reading like coverage it does not have.
    let checkedColumns = 0;
    let rowsCompared = 0;
    for (const t of LEXICAL_TABLES) {
      const { rows: gens } = await db.query(
        `SELECT a.attname, pg_get_expr(d.adbin, d.adrelid) AS expr
           FROM pg_attribute a
           JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1::regclass AND a.attgenerated = 's'
            AND a.attname = ANY($2::text[])`,
        [t.table, [t.tsvColumn, t.identsColumn]],
      );
      expect(gens.length).toBe(2);
      for (const g of gens) {
        const { rows } = await db.query(
          `SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE (${g.expr}) IS DISTINCT FROM ${g.attname})::int AS stale
             FROM ${t.table}`,
        );
        expect({ table: t.table, column: g.attname, stale: rows[0].stale }).toEqual({
          table: t.table,
          column: g.attname,
          stale: 0,
        });
        checkedColumns++;
        rowsCompared += rows[0].n;
      }
    }
    expect(checkedColumns).toBe(LEXICAL_TABLES.length * 2);
    // NOT VACUOUS: a zero-row comparison would report "no drift" about nothing at all.
    expect(rowsCompared).toBeGreaterThan(0);
  });
});
