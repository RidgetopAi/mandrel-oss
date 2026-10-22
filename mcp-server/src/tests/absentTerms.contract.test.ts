/**
 * ABSENT-TERM DETECTION — contract test.
 * (SEARCH P2a, acceptance criterion 2.)
 *
 * The headline is criterion 2: the DOUBLE-STEMMING TRAP must stay closed. Prose terms come
 * out of `to_tsvector` ALREADY STEMMED, and handing an already-stemmed lexeme back to
 * `plainto_tsquery`/`to_tsquery` stems it AGAIN — `database` → `databas` → `databa` — so the
 * most common word in a corpus reads as ABSENT from it. That failure is a confident, wrong
 * "we do not have that", which is the single worst answer this feature could give. The test
 * below asserts both halves: that our implementation says PRESENT, and that the naive
 * implementation would have said absent (measured against the same rows, so the guard cannot
 * pass because the corpus happens to be empty).
 *
 * Also asserted: project scoping (an absent-term claim is per project, never per database),
 * identifier absence, and that the whole query costs ONE statement.
 *
 * Runs against the disposable, fully-migrated ci_* Postgres, never production.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { findAbsentTerms, ABSENT_TERMS_SQL } from '../services/absentTerms.js';
import { LEXICAL_TABLES } from '../config/lexicalSearchConfig.js';

const STAMP = Date.now();
let projectA: string; // the project under test
let projectB: string; // a NEIGHBOUR, holding terms that must NOT count as present in A

const lex = (r: { absent: readonly { lexeme: string }[] }): string[] =>
  r.absent.map((a) => a.lexeme).sort();

describe('absent-term detection', () => {
  beforeAll(async () => {
    projectA = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1,'absent-terms A') RETURNING id`,
        [`absent-terms-a-${STAMP}`],
      )
    ).rows[0].id;
    projectB = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1,'absent-terms B') RETURNING id`,
        [`absent-terms-b-${STAMP}`],
      )
    ).rows[0].id;

    // PROJECT A — a corpus that contains 'database' as prose and one identifier of each shape.
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES
         ($1,'code',$2), ($1,'code',$3)`,
      [
        projectA,
        'the database migration ran cleanly against services/anchorGate.ts:122',
        'MANDREL_SEARCH_MIN_SIMILARITY governs the floor',
      ],
    );
    // …and one ARCHIVED row, whose contents must NOT make a term count as present: a search
    // will never return it, so claiming its terms are present is claiming a record the
    // caller cannot see.
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, archived_at)
       VALUES ($1,'code',$2, NOW())`,
      [projectA, 'archivedonlyword lives here in ARCHIVED_ONLY_TOKEN.ts:9'],
    );

    // PROJECT B — the neighbour. Its terms must read as ABSENT from project A.
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2)`,
      [projectB, 'kubernetes runs neighbourexclusiveword and OTHER_PROJECT_TOKEN.ts:1'],
    );
  });

  afterAll(async () => {
    for (const p of [projectA, projectB]) {
      if (!p) continue;
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [p]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── ACCEPTANCE 2: the double-stemming trap ───────────────────────────────────
  test("'database' is NOT reported absent from a corpus that contains it", async () => {
    const r = await findAbsentTerms('database', projectA);
    // The prose term is the STEMMED lexeme; that is what the corpus stores and what we probe.
    expect(r.terms.map((t) => t.lexeme)).toContain('databas');
    expect(lex(r)).not.toContain('databas');
    expect(r.absent).toHaveLength(0);
  });

  test('the NAIVE implementation would have failed that — measured on the same rows', async () => {
    // THE MUTATION, run as a query rather than described: swap the exact-lexeme cast for the
    // re-stemming form the trap warns about, against the identical corpus.
    const naive = await db.query(
      `SELECT count(*)::int AS n FROM contexts
        WHERE project_id = $1 AND archived_at IS NULL
          AND search_tsv @@ plainto_tsquery('english', 'databas')`,
      [projectA],
    );
    const correct = await db.query(
      `SELECT count(*)::int AS n FROM contexts
        WHERE project_id = $1 AND archived_at IS NULL
          AND search_tsv @@ quote_literal('databas')::tsquery`,
      [projectA],
    );
    expect(correct.rows[0].n).toBeGreaterThan(0); // the control: the term really is there
    expect(naive.rows[0].n).toBe(0); // the trap: re-stemming finds nothing
    // …because plainto_tsquery stemmed an already-stemmed lexeme one step further.
    const doubled = await db.query(
      `SELECT plainto_tsquery('english','databas')::text AS q`,
    );
    expect(doubled.rows[0].q).toBe("'databa'");
  });

  // ── a genuinely absent prose term ───────────────────────────────────────────
  test('a word the project has never contained IS reported absent', async () => {
    const r = await findAbsentTerms('kubernetes', projectA);
    expect(lex(r)).toEqual(['kubernet']); // 'kubernetes' stems to 'kubernet'
  });

  // ── identifiers ─────────────────────────────────────────────────────────────
  test('an identifier the project holds is present; one it does not is absent', async () => {
    const present = await findAbsentTerms('anchorGate.ts:122', projectA);
    expect(present.terms.some((t) => t.kind === 'identifier' && t.lexeme === 'anchorgate.ts:122')).toBe(true);
    expect(lex(present)).not.toContain('anchorgate.ts:122');

    const missing = await findAbsentTerms('otherFile.ts:99', projectA);
    expect(lex(missing)).toContain('otherfile.ts:99');
  });

  test('a file reference is checked ONCE, as an identifier — never also as prose', async () => {
    // THE CONTRADICTION THIS CLOSES, measured while building: the default parser emits
    // `anchorgate.ts:122` as a prose lexeme as well, and the document's prose vector splits
    // the same reference differently (`services/anchorgate.ts` + `122`). Without the
    // de-duplication the caller got BOTH answers about one string — present as an
    // identifier, absent as prose — and the wrong one is the one that says "we do not have
    // that". Asserted as a count so a regression cannot pass by returning a duplicate.
    const r = await findAbsentTerms('anchorGate.ts:122', projectA);
    const occurrences = r.terms.filter((t) => t.lexeme === 'anchorgate.ts:122');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].kind).toBe('identifier');
    expect(r.absent).toHaveLength(0);
  });

  test('a SCREAMING_SNAKE identifier is checked whole, not as four common words', async () => {
    const held = await findAbsentTerms('MANDREL_SEARCH_MIN_SIMILARITY', projectA);
    expect(lex(held)).not.toContain('mandrel_search_min_similarity');

    // The near-miss: same four prose words, a different identifier. Prose alone cannot tell
    // these apart — the identifier column is the entire reason this comes back absent.
    const nearMiss = await findAbsentTerms('MANDREL_SEARCH_MAX_SIMILARITY', projectA);
    expect(lex(nearMiss)).toContain('mandrel_search_max_similarity');
  });

  // ── scope ───────────────────────────────────────────────────────────────────
  test('the claim is PER PROJECT — a neighbour project does not make a term present', async () => {
    const inA = await findAbsentTerms('neighbourexclusiveword OTHER_PROJECT_TOKEN.ts:1', projectA);
    expect(lex(inA)).toContain('neighbourexclusiveword');
    expect(lex(inA)).toContain('other_project_token.ts:1');

    // The control, and the reason the assertion above means anything: the very same terms
    // are NOT absent from the project that actually holds them.
    const inB = await findAbsentTerms('neighbourexclusiveword OTHER_PROJECT_TOKEN.ts:1', projectB);
    expect(lex(inB)).not.toContain('neighbourexclusiveword');
    expect(lex(inB)).not.toContain('other_project_token.ts:1');
  });

  test('an ARCHIVED row does not make a term present', async () => {
    const r = await findAbsentTerms('archivedonlyword ARCHIVED_ONLY_TOKEN.ts:9', projectA);
    expect(lex(r)).toContain('archivedonlyword');
    expect(lex(r)).toContain('archived_only_token.ts:9');
  });

  // ── shape of the work ───────────────────────────────────────────────────────
  test('a multi-term query costs ONE statement, and every table is in it', async () => {
    // ONE ROUND TRIP is a requirement, not an optimisation: a query per term makes the cost
    // of asking scale with how articulate the caller was. Asserted structurally — the
    // statement contains no per-term repetition and every registry table appears in it.
    for (const t of LEXICAL_TABLES) {
      expect(ABSENT_TERMS_SQL).toContain(` ${t.table} x `);
    }
    // Banned forms: the re-stemming functions must not appear at all.
    expect(ABSENT_TERMS_SQL).not.toContain('plainto_tsquery');
    expect(ABSENT_TERMS_SQL).not.toContain('to_tsquery');

    const r = await findAbsentTerms(
      'kubernetes terraform database anchorGate.ts:122 otherFile.ts:99',
      projectA,
    );
    expect(lex(r)).toEqual(['kubernet', 'otherfile.ts:99', 'terraform'].sort());
  });

  // ── P2b: the surface forms, and the substitution that produced them ────
  test('ts_debug yields EXACTLY the lexemes to_tsvector does — the swap is not a behaviour change', async () => {
    // P2b replaced `tsvector_to_array(to_tsvector(...))` with `ts_debug(...) + unnest(lexemes)`
    // so each lexeme keeps the WORD IT CAME FROM (services/absentTerms.ts, QueryTerm.surfaces).
    // They are the same parser and the same dictionaries, but "should be identical" is a claim,
    // and this is the check. Run over queries that exercise stopwords, stemming, punctuation,
    // an identifier and a file:line — the shapes where a parser difference would show.
    const probes = [
      'the database migration ran cleanly',
      'MANDREL_SEARCH_MIN_SIMILARITY and services/anchorGate.ts:122',
      'favourite anybody encyclopedias, unsound; 12345',
      'don\'t re-stem hyphenated read-only words',
    ];
    for (const q of probes) {
      const r = await db.query(
        `SELECT (SELECT array_agg(l ORDER BY l) FROM (
                   SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1::text))) AS l) a) AS vec,
                (SELECT array_agg(l ORDER BY l) FROM (
                   SELECT DISTINCT l FROM ts_debug('english', $1::text) d, LATERAL unnest(d.lexemes) AS l) b) AS dbg`,
        [q],
      );
      expect(r.rows[0].dbg).toEqual(r.rows[0].vec);
      expect((r.rows[0].vec ?? []).length).toBeGreaterThan(0); // non-empty population (C3)
    }
  });

  test('every term carries at least one surface form, and identifiers are their own', async () => {
    const r = await findAbsentTerms('kubernetes databases MANDREL_NO_SUCH_KEY_HERE', projectA);
    expect(r.terms.length).toBeGreaterThan(0);
    for (const t of r.terms) {
      expect(t.surfaces.length).toBeGreaterThan(0);
      if (t.kind === 'identifier') expect(t.surfaces).toEqual([t.lexeme]);
    }
    // The stem/surface split is real, not an alias of the same string.
    const dbs = r.terms.find((t) => t.lexeme === 'databas');
    expect(dbs).toBeDefined();
    expect(dbs!.surfaces).toContain('databases');
  });

  test('an empty query asks the database nothing and vetoes nothing', async () => {
    const r = await findAbsentTerms('   ', projectA);
    expect(r.terms).toEqual([]);
    expect(r.absent).toEqual([]);
  });

  test('a stopword-only query yields no terms, which is not the same as all-absent', async () => {
    const r = await findAbsentTerms('the and of', projectA);
    expect(r.terms).toEqual([]);
    expect(r.absent).toEqual([]);
  });
});
