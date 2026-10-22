/**
 * HYBRID SEARCH — contract test (SEARCH P2b).
 *
 * Drives the REAL smartSearchHandler and the REAL lexical channel against a REAL migrated
 * Postgres. Embeddings are stubbed the way every other smart_search contract test in this
 * directory stubs them — the vector half is not what this file is about, and a stub keeps the
 * lexical assertions deterministic rather than dependent on what a model thinks of the
 * fixtures.
 *
 * ═══ THE FOUR THINGS THIS FILE IS THE GUARD FOR ═══
 *  1. VISIBILITY PARITY (BUILD 1). The lexical channel must not be able to surface a row the
 *     semantic path cannot: another project's, or an archived one. A channel with different
 *     visibility rules is a LEAK, not a feature, and it is the failure mode that would ship
 *     silently because the leaked row looks like a good result.
 *  2. THE VETO ASKS ABOUT THE SURFACE FORM, NOT THE LEXEME (BUILD 4). English stems are
 *     mostly not English words, so a veto applied to the stemmed lexeme empties a search for
 *     'database'. This is asserted as a DIVERGENCE — the naive implementation's answer is
 *     computed alongside ours, so the test cannot pass because the word list happens to be
 *     permissive.
 *  3. THREE DISTINGUISHABLE EMPTY STATES (BUILDS 4 and 5), in BOTH channels. Empty-because-
 *     nothing-matched, empty-because-we-have-no-record-of-X and empty-because-everything-
 *     broke are three different facts, and a caller reading only the text channel used to be
 *     told to "try broader search terms" for all three.
 *  4. IDENTIFIER PRECEDENCE (BUILDS 1 and 2). An exact match on a literal the caller typed
 *     outranks a prose-ranked row, and does so because of the TIER rather than because the
 *     fixture happened to score well.
 *
 * POPULATION NOTE (C3): the visibility assertions enumerate LEXICAL_TABLES, the same registry
 * migration 091 and services/absentTerms.ts read. A fourth lexical table is covered here the
 * day it is added to that registry, without editing this file — which is the only version of
 * "all sources are covered" that cannot quietly become false.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: embedDim(),
      model: 'mock',
    })),
  },
}));

import { db } from '../config/database.js';
import { smartSearchHandler } from '../handlers/smartSearch.js';
import { runLexicalSearch, LEXICAL_SEARCH_SQL } from '../services/lexicalSearch.js';
import { findAbsentTerms } from '../services/absentTerms.js';
import { decideEmptyState, vetoMessage } from '../services/absentTermVeto.js';
import { isEnglishWord } from '../services/englishWords.js';
import { LEXICAL_TABLES } from '../config/lexicalSearchConfig.js';
import { HYBRID_SEARCH_CONFIG } from '../config/hybridSearchConfig.js';
import { LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';

const STAMP = Date.now();
/** A literal that exists ONLY in this test's fixtures — the identifier-channel probe. */
const MARK = `MANDREL_P2B_MARKER_${STAMP}`;
let projectA: string;
let projectB: string;
let homeContextId: string;
/** Holds a file:line literal and NOTHING else the tier fixture's query matches. */
let identOnlyId: string;
/** Matches every PROSE word of that query and none of its literal. Inserted LAST, so the
 *  deterministic semantic tie-break (equal stub cosines → created_at DESC) puts it first. */
let proseDecoyId: string;
const TIER_LITERAL = `p2bTier${STAMP}.ts:7`;
/** A record addressed by its OWN id8, and a second record that merely MENTIONS that id8. */
let idHomeId: string;
let idHomeId8: string;
let idMentionerId: string;

describe('hybrid search', () => {
  beforeAll(async () => {
    const mk = async (name: string) =>
      (await db.query(`INSERT INTO projects (name, description) VALUES ($1,$2) RETURNING id`, [name, 'p2b']))
        .rows[0].id as string;
    projectA = await mk(`p2b-a-${STAMP}`);
    projectB = await mk(`p2b-b-${STAMP}`);

    // PROJECT A — the home of the marker, plus a decoy that is prose-similar but does NOT
    // contain the literal. The decoy is what makes "identifier precedence" falsifiable: with
    // the tier off, the decoy can outrank the home.
    homeContextId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2) RETURNING id`,
        [projectA, `the floor is governed by ${MARK} in the ranking config`],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2)`,
      [projectA, 'the floor is governed by the ranking config, at length, with the ranking config repeated: ranking config ranking config'],
    );
    // Ordinary English prose, so 'database' is PRESENT in this project.
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2)`,
      [projectA, 'the database migration ran cleanly and the favourite workspace was restored'],
    );
    // ARCHIVED — invisible to the semantic path, so it must be invisible to the lexical one.
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, archived_at)
       VALUES ($1,'code',$2, NOW())`,
      [projectA, `ARCHIVED_ONLY_${STAMP}.ts:9 holds archivedonlymarker${STAMP}`],
    );

    // ── THE TIER FIXTURE, and why it is built this way ────────────────────────────────
    // A guard for identifier precedence is only a guard if the home LOSES without the tier.
    // MEASURED: the first version of this test used a home that all three channels returned,
    // so it won on fused score alone and stayed GREEN with the tier deleted — hollow.
    // The shape below is the one that diverges: the home is reachable ONLY by the identifier
    // channel, and the decoy is reachable by the prose channel AND ranks first semantically.
    // Fused, the decoy wins (2 channels at rank 1 vs 1 channel at rank 1 plus a lower
    // semantic rank); only the tier puts the exact literal match on top.
    identOnlyId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2) RETURNING id`,
        [projectA, TIER_LITERAL],
      )
    ).rows[0].id;
    proseDecoyId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2) RETURNING id`,
        [projectA, 'tier ranking configuration floor tier ranking configuration floor'],
      )
    ).rows[0].id;

    // ── THE ID-LOOKUP FIXTURE ──────────────────────────────────────────────────────────
    // Two kinds of exact match, and the product has always ranked them differently: a row
    // whose OWN id matches ("this IS the record you named") versus a row whose TEXT contains
    // that id ("this record mentions it"). MEASURED REGRESSION this guards: when P2b added
    // the identifier tier without knowing about the id/tag boost, the live bare-id query
    // `4a460692` fell from rank 1 to rank 4 — three records that mention that id8 in their
    // prose took the identifier tier, and the record whose id IS 4a460692 does not contain
    // its own id in its text, so it had no identifier hit at all.
    idHomeId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2) RETURNING id`,
        [projectA, 'a record addressed only by its own identifier, with no distinguishing prose'],
      )
    ).rows[0].id;
    idHomeId8 = idHomeId.slice(0, 8);
    idMentionerId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2) RETURNING id`,
        [projectA, `see ${idHomeId8} for the details; ${idHomeId8} is where that lives`],
      )
    ).rows[0].id;

    // PROJECT B — the neighbour. Its literal must be invisible from project A.
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2)`,
      [projectB, `NEIGHBOUR_ONLY_${STAMP} lives only in the other project`],
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

  // ───────────────────────────────────────────────────────────────────────────────────────
  // 1. VISIBILITY PARITY
  // ───────────────────────────────────────────────────────────────────────────────────────

  /** Every id the lexical channel returned for `q`, both channels flattened. */
  const lexicalIds = async (project: string, q: string): Promise<string[]> => {
    const r = await runLexicalSearch(project, q);
    return [...r.identRanked, ...r.proseRanked].map((x) => x.id);
  };

  test('the lexical channel is scoped and archive-filtered exactly like the semantic path', async () => {
    // ⚠️ EACH FORBIDDEN ROW IS PROBED WITH ITS OWN TERMS, NOT WITH ONE COMBINED QUERY.
    // This is not tidiness — it is the difference between a guard and a hollow one. The
    // prose channel's default match mode is conjunctive, so a combined query asking for the
    // home's literal AND the archived row's marker matches NEITHER row's full term set, and
    // the "archived row is absent" assertion passes for a reason that has nothing to do with
    // the archive filter. MEASURED: with the `archived_at IS NULL` clause deleted, the
    // combined-query version of this test stayed GREEN; the per-row version below goes RED.
    const home = await lexicalIds(projectA, MARK);
    expect(home).toContain(homeContextId);

    // The population, resolved from the database so the assertion cannot pass by returning
    // nothing (C3 — probe the empty population, and name it).
    const archived = (
      await db.query(
        `SELECT id::text AS id FROM contexts WHERE project_id = $1 AND archived_at IS NOT NULL`,
        [projectA],
      )
    ).rows.map((r: { id: string }) => r.id);
    const neighbour = (
      await db.query(`SELECT id::text AS id FROM contexts WHERE project_id = $1`, [projectB])
    ).rows.map((r: { id: string }) => r.id);
    expect(archived.length).toBeGreaterThan(0);
    expect(neighbour.length).toBeGreaterThan(0);

    // ARCHIVED: queried by the marker that lives ONLY in the archived row, so the only reason
    // it can be missing is the archive filter.
    const archivedProbe = await lexicalIds(projectA, `archivedonlymarker${STAMP}`);
    for (const a of archived) expect(archivedProbe).not.toContain(a);
    // ...and the control that proves the probe is capable of finding it: from a scope where
    // the filter is the ONLY thing excluding it, the row exists and is lexically reachable.
    expect(
      (await db.query(
        `SELECT count(*)::int AS n FROM contexts
          WHERE project_id = $1 AND search_tsv @@ plainto_tsquery('english', $2)`,
        [projectA, `archivedonlymarker${STAMP}`],
      )).rows[0].n,
    ).toBeGreaterThan(0);

    // CROSS-PROJECT: queried by the literal that lives ONLY in project B.
    const neighbourProbe = await lexicalIds(projectA, `NEIGHBOUR_ONLY_${STAMP}`);
    for (const n of neighbour) expect(neighbourProbe).not.toContain(n);
    // The same query FROM project B finds it — so the exclusion above is the project scope,
    // not the query failing to match anything anywhere.
    expect(await lexicalIds(projectB, `NEIGHBOUR_ONLY_${STAMP}`)).toEqual(
      expect.arrayContaining([neighbour[0]]),
    );
  });

  test('the generated SQL scopes EVERY registry table, by that table\'s declared columns', () => {
    // POPULATION: LEXICAL_TABLES, the registry migration 091 and absentTerms.ts also read.
    // This asserts the SQL was GENERATED from it — a table added to the registry with no
    // scope clause here would fail this, rather than quietly returning unscoped rows.
    expect(LEXICAL_TABLES.length).toBeGreaterThan(0);
    for (const t of LEXICAL_TABLES) {
      expect(LEXICAL_SEARCH_SQL).toContain(`FROM ${t.table} x CROSS JOIN q`);
      expect(LEXICAL_SEARCH_SQL).toContain(`WHERE x.${t.projectColumn} = $1`);
      expect(LEXICAL_SEARCH_SQL).toContain(`AND x.${t.archivedColumn} IS NULL`);
    }
    // THE LOAD-BEARING MECHANIC P2a MEASURED: the query side must CAST A QUOTED LITERAL.
    // to_tsquery/plainto_tsquery re-parse and re-split on `_`, which silently stops documents
    // matching the identifiers they contain.
    expect(LEXICAL_SEARCH_SQL).toContain('quote_literal(lit)::tsquery');
    expect(LEXICAL_SEARCH_SQL).not.toContain('to_tsquery');
    expect(LEXICAL_SEARCH_SQL).not.toContain('plainto_tsquery');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // 2. THE VETO ASKS ABOUT THE SURFACE FORM
  // ───────────────────────────────────────────────────────────────────────────────────────

  test('absent terms carry the word the caller TYPED, not the stem', async () => {
    const probe = await findAbsentTerms('kubernetes deployments', projectA);
    const kube = probe.absent.find((t) => t.lexeme.startsWith('kubernet'));
    expect(kube).toBeDefined();
    // The stem is what the corpus stores; the surface is what the caller said.
    expect(kube!.lexeme).toBe('kubernet');
    expect(kube!.surfaces).toContain('kubernetes');
  });

  test('THE DIVERGENCE: vetoing on the LEXEME would empty an ordinary-English query', async () => {
    // A word that IS in this project, plus one that is not, both of which stem to non-words.
    // The naive implementation is computed here, from the same probe, so the test measures a
    // difference rather than asserting our answer alone.
    const probe = await findAbsentTerms('encyclopedia favourite anybody', projectA);
    expect(probe.absent.length).toBeGreaterThan(0); // non-empty population (C3)

    const naiveWouldVeto = probe.absent.filter((t) => !isEnglishWord(t.lexeme)).map((t) => t.lexeme);
    const ours = decideEmptyState(probe);

    // The stems really are not words — this is the fact the naive reading trips on.
    expect(naiveWouldVeto.length).toBeGreaterThan(0);
    // ...and ours does not veto on any of them, because it asked about the surface form.
    expect(ours.vetoedBy).toEqual([]);
    expect(ours.veto).toBe(false);
  });

  test('a non-English absent term DOES veto, and the verdict names the word', async () => {
    const probe = await findAbsentTerms(`what did we decide about ${MARK}xyzzy and kubernetes`, projectA);
    const v = decideEmptyState(probe);
    expect(HYBRID_SEARCH_CONFIG.absentTermVeto).toBe(true);
    expect(v.veto).toBe(true);
    expect(v.vetoedBy.length).toBeGreaterThan(0);
    // AN EMPTY RESULT MUST BE DISTINGUISHABLE FROM A BROKEN ONE: the message names the term.
    const msg = vetoMessage('q', v.vetoedBy);
    for (const t of v.vetoedBy) expect(msg).toContain(t);
  });

  test('BUILD 3: absent terms are reported even when rows ARE returned', async () => {
    // The no-recall-cost half. 'kubernetes' is absent from project A; the marker is present.
    const out = await smartSearchHandler.smartSearchDetailed(
      projectA, `${MARK} kubernetes`, undefined, 5,
    );
    // That query DOES veto (kubernetes is absent and not an English word) — the point here is
    // that the absent-term report is present EITHER WAY, so it is asserted on both branches.
    expect(out.absentTerms).not.toBeNull();
    expect(out.absentTerms!.map((a) => a.term)).toContain('kubernetes');

    const ok = await smartSearchHandler.smartSearchDetailed(
      projectA, `${MARK} encyclopedia`, undefined, 5,
    );
    expect(ok.results.length).toBeGreaterThan(0);
    expect(ok.emptyReason).toBeNull();
    expect(ok.absentTerms!.map((a) => a.term)).toContain('encyclopedia');
    expect(ok.absentTerms!.find((a) => a.term === 'encyclopedia')!.english).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // 3. THE THREE EMPTY STATES
  // ───────────────────────────────────────────────────────────────────────────────────────

  test('EMPTY-BECAUSE-NO-RECORD names the term and is not "nothing matched"', async () => {
    const out = await smartSearchHandler.smartSearchDetailed(
      projectA, 'how did the kubernetes rollout go', undefined, 5,
    );
    expect(out.results).toEqual([]);
    expect(out.emptyReason).not.toBeNull();
    expect(out.emptyReason!.kind).toBe('absent_terms');
    expect(out.emptyReason!.vetoedBy).toContain('kubernetes');
  });

  test('the veto FLAG turns it off — the same query then returns rows', async () => {
    // The flag exists so a bad measurement is answerable in seconds rather than by a revert;
    // a flag nothing exercises is a flag that has silently stopped working.
    const original = HYBRID_SEARCH_CONFIG.absentTermVeto;
    try {
      (HYBRID_SEARCH_CONFIG as { absentTermVeto: boolean }).absentTermVeto = false;
      const out = await smartSearchHandler.smartSearchDetailed(
        projectA, 'how did the kubernetes rollout go', undefined, 5,
      );
      expect(out.emptyReason?.kind).not.toBe('absent_terms');
      // ...and the absent term is STILL reported. BUILD 3 has no recall cost and no flag.
      expect(out.absentTerms!.map((a) => a.term)).toContain('kubernetes');
    } finally {
      (HYBRID_SEARCH_CONFIG as { absentTermVeto: boolean }).absentTermVeto = original;
    }
  });

  test('the lexical layer FLAG restores the pre-P2b answer shape', async () => {
    const original = LEXICAL_SEARCH_CONFIG.enabled;
    try {
      (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = false;
      const out = await smartSearchHandler.smartSearchDetailed(
        projectA, 'how did the kubernetes rollout go', undefined, 5,
      );
      // NULL, not []. "The probe did not run" and "nothing was absent" are different facts
      // and a caller must not be able to read one as the other.
      expect(out.absentTerms).toBeNull();
      expect(out.lexicalSkipped).toBeNull();
    } finally {
      (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = original;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // 4. IDENTIFIER PRECEDENCE
  // ───────────────────────────────────────────────────────────────────────────────────────

  test('a record holding the literal outranks a decoy the FUSED SCORE prefers', async () => {
    const q = `${TIER_LITERAL} tier ranking configuration floor`;

    // FIRST, establish the divergence exists — otherwise "the home came first" proves nothing.
    // The decoy is in the prose channel and the ident-only home is not.
    const lx = await runLexicalSearch(projectA, q);
    expect(lx.identRanked.map((r) => r.id)).toContain(identOnlyId);
    expect(lx.proseRanked.map((r) => r.id)).toContain(proseDecoyId);
    expect(lx.proseRanked.map((r) => r.id)).not.toContain(identOnlyId);

    const out = await smartSearchHandler.smartSearchDetailed(projectA, q, undefined, 5);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0].id).toBe(identOnlyId);
    expect(out.results[0].metadata.identifierHits).toBeGreaterThan(0);

    // AND the decoy really is the one the fused score would have chosen: it appears, and
    // (with the tier in place) below the exact match.
    const ids = out.results.map((r) => r.id);
    expect(ids).toContain(proseDecoyId);
    expect(ids.indexOf(identOnlyId)).toBeLessThan(ids.indexOf(proseDecoyId));
  });

  test('a BARE id8 returns the record it names, above records that merely mention it', async () => {
    // The divergence must exist for this to prove anything: the mentioner really is in the
    // identifier channel (tier 1), and the home really is not.
    const lx = await runLexicalSearch(projectA, idHomeId8);
    expect(lx.identRanked.map((r) => r.id)).toContain(idMentionerId);
    expect(lx.identRanked.map((r) => r.id)).not.toContain(idHomeId);

    const out = await smartSearchHandler.smartSearchDetailed(projectA, idHomeId8, undefined, 5);
    expect(out.results[0].id).toBe(idHomeId);
    const ids = out.results.map((r) => r.id);
    expect(ids).toContain(idMentionerId);
    expect(ids.indexOf(idHomeId)).toBeLessThan(ids.indexOf(idMentionerId));
  });

  test('an identifier hit still wins when it is the ONLY channel that found it', async () => {
    const out = await smartSearchHandler.smartSearchDetailed(
      projectA, `which floor does ${MARK} govern in the ranking config`, undefined, 5,
    );
    expect(out.results[0].id).toBe(homeContextId);
    expect(out.results[0].metadata.identifierHits).toBeGreaterThan(0);
  });

  test('the identifier list is ranked by IDENTIFIER evidence, never by prose rank', async () => {
    const lx = await runLexicalSearch(projectA, `${MARK} ranking config floor`);
    expect(lx.identRanked.length).toBeGreaterThan(0);
    // Every ident-ranked row has ≥1 hit, and the list is non-increasing in hits — the
    // property that makes it independent of ts_rank.
    for (let i = 1; i < lx.identRanked.length; i++) {
      expect(lx.identRanked[i - 1].identHits).toBeGreaterThanOrEqual(lx.identRanked[i].identHits);
    }
    expect(lx.identRanked[0].identHits).toBeGreaterThan(0);
    expect(lx.identifiers).toContain(MARK.toLowerCase());
  });
});
