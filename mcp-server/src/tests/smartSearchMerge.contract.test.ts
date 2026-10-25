/**
 * smart_search MERGE + SCORING CONTRACT
 *
 * Drives the REAL handlers against a REAL migrated Postgres. Guards G1-G7 of the build
 * plan, one describe block each, each naming the mutation that must turn it RED.
 *
 * WHY THE FIXTURES LOOK LIKE THIS — read before editing them (plan amendment A7).
 * A ranking guard is only sensitive if some fixture's COMBINED order differs from its
 * COSINE order. Rows inserted with defaults share a created_at and an importance, so both
 * orders are identical, the mutation lands on nothing, and the guard passes green forever
 * while asserting nothing. Every fixture here therefore sets created_at and importance
 * EXPLICITLY and DIVERGENTLY, and the divergence is ASSERTED IN-TEST below rather than
 * assumed — see 'A7 PRECONDITION'.
 *
 * Embeddings use conceptEmbedding (an earlier task / amendment A3), NOT patternEmbedding:
 * patternEmbedding ignores its input and returns one vector for everything, so cosine is
 * 1.0 between any two texts and every assertion in this file would pass with the merge
 * deleted. See embedGeometryConcept.unit.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, conceptEmbedding, conceptTokens } from './helpers/embedGeometry.js';

/**
 * ⚠️ THIS FILE IS PINNED TO THE SEMANTIC MERGE LAYER — MANDREL_LEXICAL_SEARCH_ENABLED=false.
 * (Added by SEARCH P2b. Read this before assuming it covers smart_search.)
 *
 * WHAT CHANGED UNDERNEATH IT. P2b fuses the semantic pool with a lexical channel BY RANK
 * (reciprocal-rank fusion), and two of this file's premises are deliberately no longer true
 * of the shipped smart_search:
 *   * the merged ORDER is the fused rank order, not the order of the unified scores;
 *   * `relevanceScore` is the fused score rescaled into [0,1] — display-consistency
 *     requires the number shown to BE the sort key, and the sort key moved.
 *
 * WHY PIN RATHER THAN REWRITE. What this file actually guards is defects D1/D2/D4 — that no
 * SOURCE invents its own scale, that per-source truncation is gone, and that a dead source
 * cannot silently zero the result. That layer is unchanged and it is the INPUT to the fusion:
 * the semantic channel's rank IS this file's order. Rewriting the assertions to fused
 * expectations would delete the D1 guard rather than move it — a constant 0.6 base score
 * would once again be invisible, because rank fusion throws the scale away.
 *
 * WHERE THE SHIPPED CONFIGURATION IS COVERED: src/tests/hybridSearch.contract.test.ts runs
 * with the flag at its DEFAULT and asserts the fused ordering, the tier ladder, visibility
 * parity and the empty states; src/tests/searchEmptyStates.contract.test.ts asserts the
 * rendered bytes. The env var is set through the real config path (not by mutating the frozen
 * config object) so this file exercises the same switch an operator would flip.
 *
 * HOW IT IS PINNED: by flipping LEXICAL_SEARCH_CONFIG.enabled in this file's beforeAll and
 * restoring it in afterAll. NOT by setting the env var — config reads env at import time, so a
 * hook would be too late, and setting it at module scope leaks into every later file (vitest
 * runs one process; the ENV-LEAK guard in vitest.setup.ts catches exactly that, and did).
 */


vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptEmbedding(text),
      dimensions: embedDim(),
      model: 'mock-concept',
    })),
  },
}));

import { db } from '../config/database.js';
import { LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';

/** See the pinning note above. Named rather than inline so the intent reads at the call. */
const LEXICAL_PINNED_OFF = false;
const LEXICAL_ORIGINAL = LEXICAL_SEARCH_CONFIG.enabled;
import { contextHandler } from '../handlers/context.js';
import { decisionsHandler } from '../handlers/decisions.js';
import { smartSearchHandler, mergeCandidates } from '../handlers/smartSearch.js';
import { RANK_WEIGHTS, unifiedScore } from '../config/rankingConfig.js';
import {
  SEARCH_MERGE_MIN_PER_SOURCE,
  SEARCH_MERGE_OVERFETCH_FACTOR,
  SEARCH_SOURCE_WEIGHTS,
  SMART_SEARCH_DEFAULT_SOURCES,
  DECISION_TYPE_WEIGHT,
  DECISION_IMPACT_IMPORTANCE,
} from '../config/searchMergeConfig.js';

/** The constant base score S1 deleted. Named so G1 can assert against the real number. */
const DELETED_DECISION_BASE = 0.6;

const STAMP = Date.now();
// No token of this query may appear in CTX_META's content — including 'the'. The JS
// substring boost filters query terms at length >= 3, so 'the' is a MATCHABLE TERM
// and one stray article silently added +round(1/6*25) = +4 to CTX_META's displayed
// similarity, breaking the drift oracle below. Measured, not guessed.
const QUERY = 'expiring secrets ahead compliance review';

let projectId: string;
const id: Record<string, string> = {};

async function storeCtx(key: string, content: string, type: string,
                        ageDays: number, relevanceScore: number): Promise<void> {
  const row = await contextHandler.storeContext({ projectId, type: type as any, content });
  id[key] = row.id;
  await db.query(
    `UPDATE contexts SET created_at = NOW() - ($2 || ' days')::interval, relevance_score = $3 WHERE id = $1`,
    [row.id, String(ageDays), relevanceScore]
  );
}

async function storeDec(key: string, title: string, description: string,
                        impactLevel: string, ageDays: number): Promise<void> {
  const row = await decisionsHandler.recordDecision({
    projectId, decisionType: 'architecture', impactLevel: impactLevel as any,
    title, description, rationale: description,
  });
  id[key] = row.id;
  await db.query(
    `UPDATE technical_decisions SET decision_date = NOW() - ($2 || ' days')::interval WHERE id = $1`,
    [row.id, String(ageDays)]
  );
}

/** Reverse-map a result id back to its fixture key, so failures read as names not UUIDs. */
const keyOf = (rid: string) => Object.keys(id).find(k => id[k] === rid) ?? rid;

describe('smart_search merge + scoring contract', () => {
  beforeAll(() => { (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = LEXICAL_PINNED_OFF; });
afterAll(() => { (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = LEXICAL_ORIGINAL; });

beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'smart search merge contract') RETURNING id`,
      [`smartsearch-merge-${STAMP}`]
    )).rows[0].id;

    // CTX_TOP  — the query's OWN words: the highest cosine in the project, and the only
    //            row that also earns the JS substring boost. Deliberately ANCIENT, lowest
    //            importance, lowest-weighted type. Its cosine rank is 1; its combined rank
    //            is not.
    await storeCtx('CTX_TOP', QUERY, 'discussion', 400, 1);
    // CTX_META — reaches the query ONLY through the declared synonym table (zero literal
    //            token overlap, asserted below). Slightly lower cosine, but brand new,
    //            maximum importance, highest-weighted type. Combined rank 1.
    await storeCtx('CTX_META', 'renewal credential lease before audit inspection',
                   'milestone', 0, 10);

    // DEC_MID  — shares two literal words with the query, so the DELETED formula would have
    //            scored it 0.6 + 0.15 + 0.15. Its real blend is far lower.
    await storeDec('DEC_MID', 'compliance review meeting notes',
                   'compliance review meeting notes', 'low', 400);
    // DEC_WEAK — shares no concept with the query at all. Its blend is near the floor,
    //            which is what makes G1's "< 0.6" assertion decisive rather than marginal.
    await storeDec('DEC_WEAK', 'postgres table column storage layout',
                   'postgres table column storage layout', 'low', 400);
  }, 60000);

  afterAll(async () => {
    if (projectId) {
      for (const t of ['contexts', 'technical_decisions', 'sessions']) {
        try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]); } catch { /* ignore */ }
      }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ===========================================================================
  // A7 PRECONDITION — without this, G2 and G3 are hollow and cannot be read as guards.
  // ===========================================================================
  describe('A7 PRECONDITION: the fixtures actually diverge', () => {
    test('cosine order and combined order DISAGREE, and the divergence comes from metadata', async () => {
      const rows = await contextHandler.searchContext({
        projectId, query: QUERY, limit: 10, rankProfile: 'balanced',
      });
      const byKey = new Map(rows.map(r => [keyOf(r.id), r]));
      const top = byKey.get('CTX_TOP')!;
      const meta = byKey.get('CTX_META')!;
      expect(top).toBeTruthy();
      expect(meta).toBeTruthy();

      // 1. The metadata really is divergent — not two rows that merely look different.
      expect(top.recency_score!).toBeLessThan(meta.recency_score!);
      expect(top.importance_score!).toBeLessThan(meta.importance_score!);
      expect(top.type_weight!).toBeLessThan(meta.type_weight!);

      // 2. COSINE order: CTX_TOP is strictly ahead.
      expect(top.similarity!).toBeGreaterThan(meta.similarity!);

      // 3. COMBINED order: CTX_META is strictly ahead. The two orders are OPPOSITE, so a
      //    mutation that swaps which key is ranked on necessarily changes the answer.
      expect(meta.combined_score!).toBeGreaterThan(top.combined_score!);
    });

    test('CTX_META shares ZERO literal tokens with the query, so no lexical path can rank it', async () => {
      const q = new Set(conceptTokens(QUERY));
      const overlap = conceptTokens('renewal credential lease before audit inspection')
        .filter(t => q.has(t));
      expect(overlap).toEqual([]);
    });
  });

  // ===========================================================================
  // G1 — NO CONSTANT BASE SCORE.   mutation: reinstate `let relevanceScore = 0.6`
  // ===========================================================================
  describe('G1 no constant base score', () => {
    test('a decision that matches nothing scores BELOW the deleted 0.6 base', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['decision'], 10);
      const weak = results.find(r => r.id === id.DEC_WEAK);
      expect(weak).toBeTruthy();
      // Under the deleted formula EVERY decision started at 0.6 and only went up, so this
      // single assertion is unsatisfiable with the mutation reinstated.
      expect(weak!.relevanceScore).toBeLessThan(DELETED_DECISION_BASE);
    });

    test('a decision that shares query words does NOT thereby outrank a better context', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, undefined, 10);
      const order = results.map(r => keyOf(r.id));
      // DEC_MID shares 'compliance' and 'review' with the query — worth +0.30 on top of the
      // 0.6 base under the deleted formula, which put it first. It now ranks below both
      // contexts on its own merits.
      expect(order.indexOf('DEC_MID')).toBeGreaterThan(order.indexOf('CTX_TOP'));
      expect(order.indexOf('DEC_MID')).toBeGreaterThan(order.indexOf('CTX_META'));
    });
  });

  // ===========================================================================
  // G2 — CROSS-SOURCE COMPARABILITY.   mutation: multiply one source's score by 1.5
  // ===========================================================================
  describe('G2 cross-source comparability', () => {
    test('every per-source weight is 1.0 — the map may not carry a handicap', () => {
      for (const key of SMART_SEARCH_DEFAULT_SOURCES) {
        expect(SEARCH_SOURCE_WEIGHTS[key]).toBe(1.0);
      }
    });

    test('the merged order is exactly the order of the unified scores, across sources', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, undefined, 10);
      expect(results.map(r => keyOf(r.id))).toEqual(['CTX_META', 'CTX_TOP', 'DEC_MID', 'DEC_WEAK']);
      // Monotonic: the reported score is the thing that produced the order, not a
      // display number computed separately from it.
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].relevanceScore).toBeGreaterThanOrEqual(results[i].relevanceScore);
      }
      // The margin a 1.5x handicap on decisions has to cross to break the order above.
      // Asserting it here means a future weight change that silently shrinks the margin
      // shows up as a RED on THIS line, not as a mysteriously insensitive guard later.
      const ctxTop = results.find(r => r.id === id.CTX_TOP)!.relevanceScore;
      const decMid = results.find(r => r.id === id.DEC_MID)!.relevanceScore;
      expect(decMid * 1.5).toBeGreaterThan(ctxTop);
    });

    test('the JS blend and the SQL blend are the SAME formula (two copies, one behaviour)', async () => {
      // handlers/context.ts computes combined_score in SQL; config/rankingConfig.ts
      // recomputes the identical blend in JS for sources assembled in the handler. Two
      // copies of one formula is a real drift risk, so it is closed executably here
      // instead of by comment.
      //
      // THE ORACLE IS CTX_META SPECIFICALLY, and that is a constraint not a shortcut: the
      // `similarity` field is the RAW cosine plus a JS substring boost of up to +40, so
      // for any row that shares literal tokens with the query it is NOT the cosine that
      // fed the SQL blend and cannot be used to recompute it. CTX_META shares zero tokens
      // with the query (asserted in the A7 preconditions above), so it earns no boost and
      // its `similarity` IS its cosine. Using a boosted row here would compare the twin
      // against a number the SQL never saw — which is how this test first went RED.
      const rows = await contextHandler.searchContext({
        projectId, query: QUERY, limit: 10, rankProfile: 'balanced',
      });
      const row = rows.find(r => r.id === id.CTX_META)!;
      expect(row).toBeTruthy();
      expect(row.similarity!).toBeLessThan(100); // unboosted and unclamped
      const viaHelper = unifiedScore(
        { cosine: row.similarity! / 100, createdAt: null,
          importance: row.importance_score!, typeWeight: row.type_weight! },
        RANK_WEIGHTS.balanced
      ) + row.recency_score! * RANK_WEIGHTS.balanced.recency;
      // 1e-3, not 1e-6: `similarity` is rounded to one decimal place for display, so the
      // cosine fed back in here carries up to 0.0005 of rounding, times the 0.70 weight.
      expect(viaHelper).toBeCloseTo(row.combined_score!, 3);
    });
  });

  // ===========================================================================
  // G3 — CONTEXTS RANK ON THE SORT KEY.   mutation: read context.similarity instead
  //      (this is the LIVE BUG, encoded)
  // ===========================================================================
  describe('G3 contexts rank on the sort key', () => {
    test('the context with the higher COMBINED score wins, not the one with the higher cosine', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['context'], 10);
      const order = results.map(r => keyOf(r.id));
      // CTX_TOP has the higher cosine AND is the only row earning the +40 substring boost,
      // so reading `similarity` puts it first. CTX_META has the higher combined_score —
      // the key the database actually ordered by — so it must be first.
      expect(order).toEqual(['CTX_META', 'CTX_TOP']);
    });

    test('the reported score is the sort key, not the boosted display similarity', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['context'], 10);
      const top = results.find(r => r.id === id.CTX_TOP)!;
      const rows = await contextHandler.searchContext({
        projectId, query: QUERY, limit: 10, rankProfile: 'balanced',
      });
      const topRow = rows.find(r => r.id === id.CTX_TOP)!;
      expect(top.relevanceScore).toBeCloseTo(topRow.combined_score!, 6);
      // and is NOT the boosted similarity fraction that the old code used
      expect(top.relevanceScore).not.toBeCloseTo(topRow.similarity! / 100, 3);
    });
  });

  // ===========================================================================
  // G4 — NO SOURCE FLOODS *WHEN THE FLOOR IS ENABLED*.   mutation: delete the floor pass
  //
  // RESCOPED, deliberately (plan amendment A5). The plan's G4 assumed the floor pass was
  // the shipped default. A5 turns it OFF, which means a source taking every slot is now
  // CORRECT behaviour whenever it genuinely holds the best rows — so a guard asserting
  // "no source floods" against the shipped configuration would be asserting a bug. What is
  // still guardable, and is guarded here, is that the OPT-IN floor does what it claims.
  // ===========================================================================
  describe('G4 no source floods (opt-in floor)', () => {
    const cand = (sourceKey: string, idStr: string, score: number) => ({
      sourceKey, score, createdAt: new Date(0),
      result: { type: sourceKey as any, id: idStr, title: idStr, summary: '', relevanceScore: score, metadata: {}, source: sourceKey },
    });

    test('with the floor ENABLED, one source cannot take every slot while another has candidates', () => {
      const pool = [
        cand('context', 'c1', 0.9), cand('context', 'c2', 0.8), cand('context', 'c3', 0.7),
        cand('decision', 'd1', 0.1),
      ];
      const out = mergeCandidates(pool, 3, 1).map(r => r.id);
      expect(out).toContain('d1');
      expect(out.filter(x => x.startsWith('c')).length).toBe(2);
    });

    test('the floor never evicts a row below another source\'s own floor, and terminates', () => {
      const pool = [
        cand('context', 'c1', 0.9), cand('context', 'c2', 0.8),
        cand('decision', 'd1', 0.7), cand('decision', 'd2', 0.6),
        cand('task', 't1', 0.1),
      ];
      const out = mergeCandidates(pool, 3, 1).map(r => r.id);
      expect(out.length).toBe(3);
      for (const src of ['c', 'd', 't']) {
        expect(out.filter(x => x.startsWith(src)).length).toBeGreaterThanOrEqual(1);
      }
    });

    test('the floor is SKIPPED when there are fewer slots than it would need', () => {
      const pool = [
        cand('context', 'c1', 0.9), cand('decision', 'd1', 0.5), cand('task', 't1', 0.4),
      ];
      // limit 2 < 3 sources x floor 1 → no legal solution; pure global sort must be used.
      expect(mergeCandidates(pool, 2, 1).map(r => r.id)).toEqual(['c1', 'd1']);
    });
  });

  // ===========================================================================
  // G5 — THE SHIPPED FLOOR IS 0.   mutation: change the default to 1
  //
  // RESCOPED, deliberately (plan amendment A5). The plan's G5 guarded a floor of 1 with
  // "SEARCH_MERGE_MIN_PER_SOURCE=0" as its mutation. A5 inverts that decision: a
  // guaranteed row per source is a constant bonus expressed structurally, and at limit=5
  // with 3 sources it can evict the correct record out of the result set to inject
  // irrelevant rows. So the value to PROTECT is 0, and the mutation is setting it to 1.
  // ===========================================================================
  describe('G5 pure global sort is what ships', () => {
    test('the shipped floor default is 0 — no source is guaranteed a slot', () => {
      expect(SEARCH_MERGE_MIN_PER_SOURCE).toBe(0);
    });

    test('with the shipped config a better-scoring source DOES take every slot', async () => {
      // Directly contradicts a floor of 1: at limit 2 both slots go to contexts, and the
      // decision source — which has candidates — gets none, because it earned none.
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, undefined, 2);
      expect(results.map(r => keyOf(r.id))).toEqual(['CTX_META', 'CTX_TOP']);
    });
  });

  // ===========================================================================
  // G6 — OVER-FETCH REACHES A ROW THE SOURCE'S OWN ORDER BURIED.
  //      mutation: SEARCH_MERGE_OVERFETCH_FACTOR=1
  //
  // This encodes the Q2/Q5 failures: a record whose within-source rank is deeper than
  // `limit`, but whose UNIFIED score belongs in the answer. It is reachable only because
  // a source's own ordering is not the unified ordering — decision_search orders by raw
  // cosine, while the merge ranks on the blend, so a moderately-similar but new and
  // critical decision outranks older high-cosine ones it sits behind.
  // ===========================================================================
  describe('G6 over-fetch reaches a buried row', () => {
    let burialProjectId: string;
    const bid: Record<string, string> = {};

    beforeAll(async () => {
      burialProjectId = (await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'overfetch burial') RETURNING id`,
        [`smartsearch-burial-${STAMP}`]
      )).rows[0].id;
      const save = projectId;
      projectId = burialProjectId;
      try {
        // Five decoys with HIGHER cosine (they repeat the query's own concepts) but
        // ancient and low-impact, so their blends are mediocre.
        for (let i = 0; i < 5; i++) {
          await storeDec(`BURY_${i}`, `expiring secrets compliance review item ${i}`,
                         'expiring secrets compliance review', 'low', 500);
        }
        // The buried row: LOWER cosine than every decoy (it reaches two of the query's
        // four concepts only through the synonym table), but brand new and critical
        // impact, so its blend belongs in the answer while its raw cosine does not.
        //
        // MARGIN, not balance. The metadata advantage here must clear the decoys' cosine
        // lead across a BAND of weights, not at one point. At the shipped blend the
        // buried row gains ~0.075 from impact (critical 1.0 vs low 0.25 at w_imp=0.10)
        // and ~0.045 from age (0 vs 500 days at w_rec=0.05), so it can afford a cosine
        // deficit of roughly 0.12/0.75 ~ 0.16 — which is why it shares 'compliance
        // review' rather than reaching the query through synonyms alone.
        //
        // It did NOT share those tokens until 2026-08-19. It leaned almost entirely on
        // recency, so halving w_rec (0.10 -> 0.05) dropped it out of the result set
        // entirely and turned this guard RED on a tuning change that never touched the
        // merge. A fixture balanced on one weight value measures that value; a fixture
        // with margin measures the mechanism. The PRECONDITION below is what keeps the
        // widened margin honest — it fails loudly if the row stops being buried at all.
        await storeDec('BURIED', 'renewal of the credential lease before the review',
                       'renewal of the credential lease review audit',
                       'critical', 0);
      } finally {
        Object.keys(id).filter(k => k.startsWith('BURY_') || k === 'BURIED')
          .forEach(k => { bid[k] = id[k]; delete id[k]; });
        projectId = save;
      }
    }, 60000);

    afterAll(async () => {
      if (burialProjectId) {
        for (const t of ['technical_decisions', 'sessions']) {
          try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [burialProjectId]); } catch { /* ignore */ }
        }
        try { await db.query('DELETE FROM projects WHERE id = $1', [burialProjectId]); } catch { /* ignore */ }
      }
    });

    test('PRECONDITION: the buried row is deeper than `limit` in its own source order', async () => {
      const LIMIT = 3;
      const rows = await decisionsHandler.searchDecisions({
        projectId: burialProjectId, query: QUERY, limit: 50,
      });
      const rank = rows.findIndex(r => r.id === bid.BURIED);
      expect(rank).toBeGreaterThanOrEqual(LIMIT);
      // If this ever fails, the fixture stopped burying the row and G6 below became
      // hollow — which is exactly the failure mode A7 warns about.
      expect(SEARCH_MERGE_OVERFETCH_FACTOR).toBeGreaterThan(1);
    });

    // ASSERT MEMBERSHIP, NOT RANK 1 — deliberately, and the distinction is the guard.
    // The claim G6 makes is that OVER-FETCH REACHES a row which sub-limit truncation
    // would have discarded. The precondition above pins that row at source-rank >= LIMIT,
    // so at limit=3 it is cut unless over-fetch pulled it into the pool: being in the
    // result set AT ALL is the whole mechanism, and setting OVERFETCH_FACTOR=1 removes it.
    // Where it then lands is the BLEND's business, which is what G2 and G3 assert.
    //
    // It asserted rank 1 until 2026-08-19, and that coupled it to the weight VALUES: the
    // fixture's buried row won on being brand new, so halving the recency weight (0.10 ->
    // 0.05) handed rank 1 to a decoy and this went RED on a change that did
    // not touch the merge at all. A guard that fails when a tunable is tuned is not
    // measuring the mechanism it names — it is measuring the tuning.
    test('the buried row is returned by the merge (over-fetch reached it)', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(
        burialProjectId, QUERY, ['decision'], 3);
      expect(results).toHaveLength(3);
      expect(results.map(r => r.id)).toContain(bid.BURIED);
    });
  });

  // ===========================================================================
  // G7 — ONE SOURCE FAILING IS NOT ZERO RESULTS.
  //      mutation: restore the single outer try/catch around all sources
  // ===========================================================================
  describe('G7 one source failing is not zero results', () => {
    test('a throwing decision source leaves the context results intact and is NAMED', async () => {
      const spy = vi.spyOn(decisionsHandler, 'searchDecisions')
        .mockRejectedValue(new Error('injected: decision source is down'));
      try {
        const { results, degradedSources } = await smartSearchHandler.smartSearchDetailed(
          projectId, QUERY, undefined, 10);
        // Not [] — the healthy source still answered.
        expect(results.length).toBeGreaterThan(0);
        expect(results.map(r => keyOf(r.id))).toEqual(['CTX_META', 'CTX_TOP']);
        // And the answer SAYS it is partial. Without this, "nothing matched" and
        // "a source is down" are the same empty array.
        expect(degradedSources).toEqual(['decision']);
      } finally {
        spy.mockRestore();
      }
    });

    test('a healthy search reports NO degraded sources', async () => {
      const { degradedSources } = await smartSearchHandler.smartSearchDetailed(
        projectId, QUERY, undefined, 10);
      expect(degradedSources).toEqual([]);
    });
  });

  // ===========================================================================
  // D4 — the dead component source is gone from the DEFAULT set.
  // ===========================================================================
  describe('D4 the component source is dropped', () => {
    test('the default source set is exactly context + decision + task', () => {
      // `task` joined on 2026-08-20. This assertion is deliberately an
      // EXACT-EQUALS on the whole list rather than a `not.toContain('component')`: the
      // defect D4 describes is a source being in the default set that cannot produce a
      // comparable score, and only pinning the whole list catches the NEXT one of those.
      expect([...SMART_SEARCH_DEFAULT_SOURCES]).toEqual(['context', 'decision', 'task']);
      // The dead source stays dead — the specific regression this block was written for.
      expect(SMART_SEARCH_DEFAULT_SOURCES).not.toContain('component');
    });

    test('a default smart_search runs no query against code_components', async () => {
      const executed: string[] = [];
      const realQuery = db.query.bind(db);
      const spy = vi.spyOn(db, 'query').mockImplementation(((...args: any[]) => {
        executed.push(String(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? ''));
        return (realQuery as any)(...args);
      }) as any);
      const realConnect = db.connect.bind(db);
      const cspy = vi.spyOn(db, 'connect').mockImplementation((async (...a: any[]) => {
        const client: any = await (realConnect as any)(...a);
        const rq = client.query.bind(client);
        client.query = (...q: any[]) => {
          executed.push(String(typeof q[0] === 'string' ? q[0] : q[0]?.text ?? ''));
          return rq(...q);
        };
        return client;
      }) as any);
      try {
        await smartSearchHandler.smartSearchDetailed(projectId, QUERY, undefined, 5);
      } finally { spy.mockRestore(); cspy.mockRestore(); }
      expect(executed.filter(s => /code_components/i.test(s))).toEqual([]);
    });
  });

  // ===========================================================================
  // The isRecencyQuery trapdoor — DECIDED, not inherited.
  // ===========================================================================
  describe('the recency profile does not leak into the merge', () => {
    test('a query containing a recency keyword still ranks on the balanced blend', async () => {
      // 'current' appears inside 'concurrent'; the shipped keyword test is a SUBSTRING
      // match, so this query trips isRecencyQuery without being a temporal question at all.
      const recencyish = `${QUERY} concurrent`;
      const { results } = await smartSearchHandler.smartSearchDetailed(
        projectId, recencyish, ['context'], 10);
      // Under the 0.90-recency profile CTX_TOP (400 days old) is excluded outright by that
      // profile's hard 60-day window, so it would be missing entirely.
      expect(results.map(r => keyOf(r.id)).sort()).toEqual(['CTX_META', 'CTX_TOP']);
    });

    test('context_search itself is UNCHANGED — the switch still fires there', async () => {
      // Scope check: this task pinned the profile for smart_search only. context_search's
      // own behaviour, right or wrong, is deliberately untouched, and that is asserted
      // rather than asserted-in-prose.
      const rows = await contextHandler.searchContext({
        projectId, query: `${QUERY} concurrent`, limit: 10,
      });
      expect(rows.map(r => keyOf(r.id))).toEqual(['CTX_META']);
    });
  });

  // ===========================================================================
  // The blend inputs decisions use are calibrated against contexts, not invented.
  // ===========================================================================
  describe('decision blend inputs are neutral against the context source', () => {
    test('a medium-impact decision and a default-importance context weigh the same', () => {
      expect(DECISION_IMPACT_IMPORTANCE.medium).toBe(0.5); // contexts: COALESCE(relevance_score,5)/10
    });
    test('a decision takes the type weight the context table prices a decision at', () => {
      expect(DECISION_TYPE_WEIGHT).toBe(0.9); // TYPE_WEIGHT_CASE: WHEN 'decision' THEN 0.9
    });
  });
});
