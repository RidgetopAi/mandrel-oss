/**
 * THE TASK SOURCE — smart_search's third source (tranche B).
 *
 * Drives the REAL handlers against a REAL migrated Postgres. Tranche B had already baked
 * task vectors (migration 088 + the write path + the backfill); NOTHING READ THEM. These
 * guards cover the reader — tasksHandler.searchTasks — and its participation in the merge.
 *
 * WHY THE FIXTURES LOOK LIKE THIS. Two independent hollowness traps apply here and both are
 * defended against IN-TEST rather than assumed:
 *
 *  1. THE EMBEDDER MUST DEPEND ON ITS INPUT. patternEmbedding() ignores its argument and
 *     returns one vector for everything, so cosine is 1.0 between any two texts and every
 *     ranking assertion below would pass with the ranking deleted. This file uses
 *     conceptEmbedding, and the 'PRECONDITION' block asserts the geometry is real before any
 *     ranking claim is made — a semantic-recall test that passes on the first try is far more
 *     often a broken helper than a working feature.
 *
 *  2. THE FIXTURES MUST DIVERGE ON SOMETHING. A ranking guard is only sensitive if the
 *     COMBINED order differs from the COSINE order, or if the recomputed oracle can disagree
 *     with the handler. Every score assertion here is against an INDEPENDENTLY RECOMPUTED
 *     oracle (unifiedScore over the cosine read back out of the database), never against a
 *     hardcoded number that would survive a formula change.
 *
 * SCOPE OF THIS FILE (stated, per C3 — a guard must say what population it enumerates): the
 * `task` SOURCE and its reader. The cross-source merge/eviction machinery, the deleted
 * decision base, and the recency-profile trapdoor are guarded by smartSearchMerge.contract
 * .test.ts and are NOT re-asserted here.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, conceptEmbedding, conceptTokens, cosine } from './helpers/embedGeometry.js';

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
import { tasksHandler } from '../handlers/tasks.js';
import { smartSearchHandler } from '../handlers/smartSearch.js';
import { SearchRoutes, searchRoutes } from '../routes/search.routes.js';
import { trustForRecords } from '../services/trust.js';
import { activeEmbeddingColumn, embedders } from '../config/embeddingConfig.js';
import { RANK_WEIGHTS, unifiedScore } from '../config/rankingConfig.js';
import { validationSchemas } from '../middleware/validation.js';
import { SEARCH_ID_MATCH_SCORE_BOOST } from '../config/searchConfig.js';
import {
  SEARCH_SOURCE_WEIGHTS,
  SMART_SEARCH_DEFAULT_SOURCES,
  SMART_SEARCH_SOURCE_KEYS,
  TASK_IMPORTANCE_DEFAULT,
  TASK_TYPE_WEIGHT,
  smartSearchSourcesJson,
  smartSearchSourcesPlus,
  smartSearchSourcesProse,
} from '../config/searchMergeConfig.js';

const STAMP = Date.now();

/**
 * The query. Its concept buckets are rotate('expiring') + secret('credentials') +
 * audit('review'). NO fixture below repeats any of these literal tokens, which is what makes
 * a hit here evidence of SEMANTIC retrieval rather than a substring match — asserted, not
 * asserted-by-comment, in the PRECONDITION block.
 */
const QUERY = 'expiring credentials review';

let projectId: string;
const id: Record<string, string> = {};
const keyOf = (rid: string) => Object.keys(id).find(k => id[k] === rid) ?? rid;

async function makeTask(key: string, title: string, description: string,
                        ageDays: number): Promise<void> {
  const row = await tasksHandler.createTask(projectId, title, description);
  id[key] = row.id;
  await db.query(
    `UPDATE tasks SET created_at = NOW() - ($2 || ' days')::interval WHERE id = $1`,
    [row.id, String(ageDays)]
  );
}

/** The cosine the DATABASE computes for a row, read back through the ACTIVE column. */
async function dbCosine(table: string, rowId: string, queryText: string): Promise<number> {
  const vec = `[${conceptEmbedding(queryText).join(',')}]`;
  const r = await db.query(
    `SELECT 1 - (${activeEmbeddingColumn()} <=> $2::vector) AS c FROM ${table} WHERE id = $1`,
    [rowId, vec]
  );
  return parseFloat(r.rows[0].c);
}

describe('smart_search task source', () => {
  beforeAll(() => { (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = LEXICAL_PINNED_OFF; });
afterAll(() => { (LEXICAL_SEARCH_CONFIG as { enabled: boolean }).enabled = LEXICAL_ORIGINAL; });

beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'task source contract') RETURNING id`,
      [`smartsearch-task-${STAMP}`]
    )).rows[0].id;

    // ── THE AGES ARE ADVERSARIAL ON PURPOSE (the A7 trap, and it caught us) ──────────────
    // The first cut of this file gave every fixture the SAME created_at. A mutation probe
    // that DELETED the cosine term from the blend then still passed: with cosine gone all
    // tasks scored identically and the merged order fell through to the created_at / id
    // tiebreakers, which happened to preserve the expected order. The guard was asserting
    // the tiebreaker, not the ranking.
    //
    // So the WRONG answer is now the RECENT one: TASK_MISS and CTX_MID are a day old, the
    // correct answer TASK_HIT is sixty days old. Every "TASK_HIT ranks first" assertion below
    // is therefore a claim that the cosine term OVERCAME a recency handicap, which is a
    // statement about ranking that no tiebreaker can accidentally satisfy.

    // TASK_HIT   — reaches the query ONLY through the declared synonym table: 'renewal'→rotate,
    //              'passwords'/'lease'→secret, 'inspection'/'compliance'→audit. Zero literal
    //              token overlap with QUERY (asserted below). OLD.
    await makeTask('TASK_HIT', 'Renewal of the leased passwords before the compliance inspection',
                   'Rotation work ahead of the scheduled inspection.', 60);
    // TASK_MISS  — concept-disjoint from the query (deploy/retrieval/storage), and BRAND NEW.
    //              Its presence is what makes "the hit ranked first" a discrimination rather
    //              than a tautology; its recency is what makes it a decisive one.
    await makeTask('TASK_MISS', 'Ship the ranking relevance rollout',
                   'Release the postgres storage column change.', 1);
    // TASK_GONE  — archived. Must never appear. Same text AND same age as TASK_HIT so the ONLY
    //              thing that can exclude it is the soft-delete predicate, not a weak cosine.
    await makeTask('TASK_GONE', 'Renewal of the leased passwords before the compliance inspection',
                   'Rotation work ahead of the scheduled inspection.', 60);
    await tasksHandler.archiveTask(id.TASK_GONE, projectId);

    // CTX_MID    — a CONTEXT with partial concept overlap, also BRAND NEW. The cross-source
    //              comparison subject, and the recency-favoured one.
    const ctx = await contextHandler.storeContext({
      projectId, type: 'planning', content: 'Audit inspection of the stored postgres column layout',
    });
    id.CTX_MID = ctx.id;
    await db.query(
      `UPDATE contexts SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [ctx.id]);
  }, 60000);

  afterAll(async () => {
    if (projectId) {
      for (const t of ['tasks', 'contexts', 'technical_decisions', 'sessions']) {
        try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]); } catch { /* ignore */ }
      }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ===========================================================================
  // PRECONDITION — without these, every ranking assertion below is hollow.
  // ===========================================================================
  describe('PRECONDITION: the geometry is real and the win is semantic', () => {
    test('the fake embedder DEPENDS ON ITS INPUT (concept-disjoint texts do not score 1.0)', () => {
      const a = conceptEmbedding('renewal leased passwords compliance inspection');
      const b = conceptEmbedding('ship ranking relevance rollout postgres storage');
      // patternEmbedding would make this 1.0 and silently hollow the whole file.
      expect(cosine(a, b)).toBeLessThan(0.2);
      expect(cosine(a, a)).toBeCloseTo(1.0, 10);
    });

    test('TASK_HIT shares NO literal token with the query — a hit cannot be a substring match', () => {
      const qTokens = new Set(conceptTokens(QUERY));
      const hitTokens = conceptTokens(
        'Renewal of the leased passwords before the compliance inspection ' +
        'Rotation work ahead of the scheduled inspection.');
      expect(hitTokens.length).toBeGreaterThan(0);
      expect(hitTokens.filter(t => qTokens.has(t))).toEqual([]);
    });

    test('the fixtures DIVERGE: the correct answer is the OLDER row', async () => {
      // This is the assertion that keeps S1/S3 honest. If these ages ever converge, a
      // cosine-deleting mutation stops being detectable and every ranking guard in this
      // file silently becomes a test of the created_at/id tiebreaker.
      const r = await db.query(
        `SELECT id::text, created_at FROM tasks WHERE id = ANY($1::uuid[])`,
        [[id.TASK_HIT, id.TASK_MISS]]);
      const at = (rid: string) =>
        new Date(r.rows.find((x: any) => x.id === rid)!.created_at).getTime();
      expect(at(id.TASK_HIT)).toBeLessThan(at(id.TASK_MISS));
      // And the gap is big enough to matter at the shipped half-life, not a few seconds.
      const gapDays = (at(id.TASK_MISS) - at(id.TASK_HIT)) / 86400000;
      expect(gapDays).toBeGreaterThan(RANK_WEIGHTS.balanced.halfLifeDays);
    });

    test('the task rows really carry vectors in the ACTIVE column', async () => {
      const r = await db.query(
        `SELECT COUNT(*)::int AS n FROM tasks
          WHERE project_id = $1 AND ${activeEmbeddingColumn()} IS NOT NULL`,
        [projectId]);
      // 3 created; the archived one is embedded too (archiving does not clear the vector).
      expect(r.rows[0].n).toBe(3);
    });
  });

  // ===========================================================================
  // S1 — the reader exists and retrieves BY MEANING.
  // ===========================================================================
  describe('S1 a task is findable by meaning', () => {
    test('smart_search with includeTypes:["task"] returns the concept-matching task first', async () => {
      const { results, degradedSources } = await smartSearchHandler.smartSearchDetailed(
        projectId, QUERY, ['task'], 10);
      expect(degradedSources).toEqual([]);
      expect(results.length).toBeGreaterThan(0);
      expect(keyOf(results[0].id)).toBe('TASK_HIT');
      expect(results[0].type).toBe('task');
      // The disjoint task is present but BELOW — the source discriminates, it does not
      // merely return everything it has.
      const order = results.map(r => keyOf(r.id));
      expect(order.indexOf('TASK_HIT')).toBeLessThan(order.indexOf('TASK_MISS'));
    });

    test('the reader queries the ACTIVE embedding column, never a hardcoded one', async () => {
      const executed: string[] = [];
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
        await tasksHandler.searchTasks({ projectId, query: QUERY, limit: 5 });
      } finally { cspy.mockRestore(); }

      const taskSql = executed.filter(s => /FROM tasks/i.test(s));
      expect(taskSql.length).toBeGreaterThan(0);
      const active = activeEmbeddingColumn();
      expect(taskSql.some(s => s.includes(active))).toBe(true);
      // AND the INACTIVE column is absent. The two are different WIDTHS (1536 vs 768), so a
      // hardcoded name is not a slightly-wrong result — it is a dimension error, or a query
      // against a column holding nothing written since the fleet cutover, which returns
      // EMPTY with no error. Asserting only "the active name appears" would pass if BOTH
      // appeared, which is the exact half-migrated state worth catching.
      const inactive = Object.values(embedders())
        .map(e => e.column)
        .filter(c => c !== active);
      for (const col of inactive) {
        expect(taskSql.some(s => new RegExp(`\\b${col}\\b`).test(s))).toBe(false);
      }
    });
  });

  // ===========================================================================
  // S2 — the score is the SHARED quantity, recomputed against an oracle.
  // ===========================================================================
  describe('S2 the task score is the shared unified score', () => {
    test('the reported relevanceScore equals unifiedScore recomputed from the DB cosine', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['task'], 10);
      const hit = results.find(r => r.id === id.TASK_HIT)!;
      expect(hit).toBeTruthy();

      const rows = await db.query(`SELECT created_at FROM tasks WHERE id = $1`, [id.TASK_HIT]);
      const cos = await dbCosine('tasks', id.TASK_HIT, QUERY);
      // A real cosine, not a degenerate 0 or 1 — otherwise the oracle agrees for the wrong
      // reason and this test would pass against a broken reader.
      expect(cos).toBeGreaterThan(0.05);
      expect(cos).toBeLessThan(0.99);

      const oracle = unifiedScore({
        cosine: cos,
        createdAt: rows.rows[0].created_at,
        importance: TASK_IMPORTANCE_DEFAULT,
        typeWeight: TASK_TYPE_WEIGHT,
      }, RANK_WEIGHTS.balanced, Date.now()) * (SEARCH_SOURCE_WEIGHTS.task ?? 1.0);

      // Tolerance covers only the millisecond drift between the handler's nowMs and this
      // one inside a 30-day-half-life exponential; it is far tighter than any weight change.
      expect(hit.relevanceScore).toBeCloseTo(oracle, 6);
    });

    test('the merge ranks on the RAW cosine, not the rounded display percentage', async () => {
      const rows = await tasksHandler.searchTasks({ projectId, query: QUERY, limit: 10 });
      const hit = rows.find(r => r.id === id.TASK_HIT)!;
      // The two agree to display precision...
      expect(hit.similarity).toBeCloseTo(hit.cosineScore! * 100, 1);
      // ...and the raw one is what the DB actually computed, to full precision. This is the
      // assertion that goes RED if the adapter is repointed at `similarity`: it caught a
      // real 2.0e-4 divergence in the first cut of this build.
      const cos = await dbCosine('tasks', id.TASK_HIT, QUERY);
      expect(hit.cosineScore).toBeCloseTo(cos, 12);
      // And the rounding really is lossy at the precision the merge sorts on — otherwise
      // the distinction above is academic and this guard proves nothing.
      expect(Math.round(hit.cosineScore! * 1000) / 1000).not.toBe(hit.cosineScore);
    });

    test('the task source weight is 1.0 — the map may not carry a handicap', () => {
      expect(SEARCH_SOURCE_WEIGHTS.task).toBe(1.0);
    });

    test('the task TYPE weight cannot become a standing handicap either', () => {
      // THE SECOND AXIS. The pin above guards SEARCH_SOURCE_WEIGHTS, the per-source
      // multiplier — but typeWeight can carry the identical deficit and had no bound at
      // all. Measured by Reviewer: dropping TASK_TYPE_WEIGHT 0.5 -> 0.05 left the ENTIRE
      // suite green (51/51), because the only other test that reads it is the scoring
      // oracle, which imports the same constant and so can never disagree with the handler
      // about it. A future edit could hand tasks a real standing deficit with nothing red.
      //
      // The bound is the type table's OWN floor (context.ts TYPE_WEIGHT_CASE ELSE = 0.4) —
      // what the system already pays a record kind it has no opinion about. A task may be
      // priced at or above that; it may not be priced below the thing the system does not
      // recognise at all. Deliberately a FLOOR and not an equality: 0.5 is an unmeasured
      // calibration and a sweep is expected to move it, so pinning the exact value would
      // RED on correct work — the same over-reach this commit removes one test above.
      expect(TASK_TYPE_WEIGHT).toBeGreaterThanOrEqual(0.4);
      expect(TASK_TYPE_WEIGHT).toBeLessThanOrEqual(1.0);
    });
  });

  // ===========================================================================
  // S3 — CROSS-SOURCE. A task and a context are ordered by the one score.
  // ===========================================================================
  describe('S3 a task and a context are ordered against each other', () => {
    test('the merged order across task+context is exactly the order of the reported scores', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(
        projectId, QUERY, ['task', 'context'], 10);
      // Both sources actually contributed — otherwise "ordered across sources" is vacuous.
      const types = new Set(results.map(r => r.type));
      expect(types.has('task')).toBe(true);
      expect(types.has('context')).toBe(true);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].relevanceScore).toBeGreaterThanOrEqual(results[i].relevanceScore);
      }

      // The concept-matching TASK outranks the partially-overlapping CONTEXT — and it does
      // so while being the OLDER row (TASK_HIT 60d vs CTX_MID 1d), so recency is actively
      // working AGAINST the expected order. That is deliberate: with equal ages this
      // assertion would pass on the created_at tiebreaker alone and stay green with the
      // cosine term deleted. Do not "fix" the ages to match.
      const order = results.map(r => keyOf(r.id));
      expect(order.indexOf('TASK_HIT')).toBeLessThan(order.indexOf('CTX_MID'));
    });

    test('a task can also LOSE to a context — the source has no structural advantage', async () => {
      // Query the CONTEXT's concepts (storage/audit). If tasks carried a standing bonus this
      // would still put a task on top; it must not.
      const ctxQuery = 'database column persisted storage';
      const { results } = await smartSearchHandler.smartSearchDetailed(
        projectId, ctxQuery, ['task', 'context'], 10);
      expect(results.length).toBeGreaterThan(0);
      expect(keyOf(results[0].id)).toBe('CTX_MID');
    });
  });

  // ===========================================================================
  // S4 — SOFT-DELETE. An archived task is not a search result.
  // ===========================================================================
  describe('S4 archived tasks are excluded by default', () => {
    test('the archived twin never appears, though its text is identical to the winner', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['task'], 50);
      expect(results.map(r => r.id)).not.toContain(id.TASK_GONE);
      // The control: its identical-text twin DID come back, so the exclusion is the
      // soft-delete predicate and not a scoring accident.
      expect(results.map(r => r.id)).toContain(id.TASK_HIT);
    });

    test('includeArchived:true returns it — the predicate is a filter, not a data loss', async () => {
      const rows = await tasksHandler.searchTasks({
        projectId, query: QUERY, limit: 50, includeArchived: true });
      expect(rows.map(r => r.id)).toContain(id.TASK_GONE);
    });
  });

  // ===========================================================================
  // S5 — the exact-id / partial-tag boost survives, and is not folded into similarity.
  // ===========================================================================
  describe('S5 the id/tag boost passes through additively', () => {
    test('a bare id query returns that exact task first', async () => {
      const { results } = await smartSearchHandler.smartSearchDetailed(
        projectId, id.TASK_MISS, ['task'], 10);
      expect(keyOf(results[0].id)).toBe('TASK_MISS');
      // It won on the BOOST, not on meaning: a raw uuid has no concept tokens at all.
      expect(results[0].relevanceScore).toBeGreaterThanOrEqual(SEARCH_ID_MATCH_SCORE_BOOST);
    });

    test('`similarity` stays a [0,100] cosine — the boost rides idTagHit, not the percentage', async () => {
      const rows = await tasksHandler.searchTasks({ projectId, query: id.TASK_MISS, limit: 10 });
      const hit = rows.find(r => r.id === id.TASK_MISS)!;
      expect(hit.idTagHit).toBe(true);
      // A displayed relevance that can read 187% is not a relevance. This is the property
      // the decisions source does NOT have, because it sums the two into one column.
      expect(hit.similarity!).toBeLessThanOrEqual(100);
      expect(hit.similarity!).toBeGreaterThanOrEqual(0);
      // And an ordinary text query sets the flag FALSE — the flag tracks the match, it is
      // not stuck on.
      const plain = await tasksHandler.searchTasks({ projectId, query: QUERY, limit: 10 });
      expect(plain.find(r => r.id === id.TASK_HIT)!.idTagHit).toBe(false);
    });
  });

  // ===========================================================================
  // S6 — AN UNKNOWN SOURCE KEY IS AN ERROR, NOT AN EMPTY RESULT.
  // ===========================================================================
  describe('S6 an unknown includeTypes key is rejected loudly', () => {
    test('the handler THROWS and names the valid set', async () => {
      await expect(
        smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['tsak'], 10)
      ).rejects.toThrow(/unknown source/i);
      // The control that makes the RED meaningful: a KNOWN key on the same call path does
      // not throw. Without this, a guard asserting "it throws" passes if it always throws.
      await expect(
        smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['task'], 10)
      ).resolves.toBeTruthy();
    });

    test('an unknown key does NOT come back as a clean empty success', async () => {
      // This is the defect in its own words. Before the guard, this call resolved to
      // {results: [], degradedSources: []} — indistinguishable from "nothing matched".
      let resolved: unknown = Symbol('did-not-resolve');
      try {
        resolved = await smartSearchHandler.smartSearchDetailed(projectId, QUERY, ['component'], 10);
      } catch { /* expected */ }
      expect(resolved).not.toEqual({ results: [], degradedSources: [] });
    });

    test('the zod validator rejects an unknown source before the handler is reached', () => {
      const schema = validationSchemas.smart_search;
      expect(schema.safeParse({ query: 'x', includeTypes: ['task'] }).success).toBe(true);
      expect(schema.safeParse({ query: 'x', includeTypes: ['context', 'decision'] }).success).toBe(true);
      const bad = schema.safeParse({ query: 'x', includeTypes: ['tsak'] });
      expect(bad.success).toBe(false);
      // EMPTY and ABSENT are the populations that slip through a membership check: neither
      // names an invalid source, so both must remain valid.
      expect(schema.safeParse({ query: 'x', includeTypes: [] }).success).toBe(true);
      expect(schema.safeParse({ query: 'x' }).success).toBe(true);
    });
  });

  // ===========================================================================
  // S9 — THE FLIP. A DEFAULT smart_search searches tasks.
  //
  // These live in the FLIP COMMIT on purpose, not in the build commit. The default-set
  // change is the kill switch, and a kill switch has to revert as ONE commit — so the
  // assertions that describe the flipped behaviour must revert with it. `git revert` of that
  // commit takes this block too and leaves a green tree; if these lived in the build commit,
  // disarming the source in a hurry would leave a RED suite and someone would be editing
  // tests under pressure to ship a rollback.
  // ===========================================================================
  describe('S9 the task source is ON by default', () => {
    test('smart_search with NO includeTypes returns the task', async () => {
      const { results, degradedSources } = await smartSearchHandler.smartSearchDetailed(
        projectId, QUERY, undefined, 10);
      expect(degradedSources).toEqual([]);
      // The whole point of the flip: a caller who names no sources gets tasks.
      expect(results.some(r => r.type === 'task')).toBe(true);
      expect(results.map(r => r.id)).toContain(id.TASK_HIT);
    });

    test('task is in the default set — the flip itself', () => {
      // ASSERTS MEMBERSHIP, NOT EQUALITY, and the difference is the point. An earlier
      // draft asserted the default set EQUALS the vocabulary, which makes the
      // built-but-not-yet-default state unrepresentable — the exact state that gives this
      // build its kill switch, and the state the next source will be born into. A guard
      // that REDs on correct work gets deleted the first time it is inconvenient, so it
      // protects nothing. The subset invariant (S7) already covers the other direction:
      // every default source must be a real vocabulary key.
      expect(SMART_SEARCH_DEFAULT_SOURCES).toContain('task');
    });

    test('the ADVERTISED source list follows the searched one with no edit', () => {
      // The four model-facing copies are rendered from SMART_SEARCH_DEFAULT_SOURCES. This
      // asserts the DERIVATION, which is the property that stops the advertised list drifting
      // from the searched list the way `component` did — it stayed advertised for weeks after
      // the handler stopped searching it.
      expect(smartSearchSourcesJson()).toBe('["context","decision","task"]');
      expect(smartSearchSourcesPlus()).toBe('context+decision+task');
      expect(smartSearchSourcesProse()).toBe('contexts, decisions and tasks');
    });
  });

  // ===========================================================================
  // S8 — TRUST BANDS reach task rows, END-TO-END through the real route.
  // ===========================================================================
  describe('S8 a task result carries a trust band', () => {
    test('trustForRecords resolves a TASK ref against the tasks table', async () => {
      // The claim under test is that services/trust.ts genuinely handles type:'task' — the
      // code SAYS so (fetchRecordMeta maps it to the `tasks` table) and this is the assertion
      // that it is true rather than merely written down. The tell that it resolved a REAL row
      // is the freshness: TASK_HIT is 60 days old, so a verdict computed from a found row
      // cannot look like a brand-new record, and a NOT-FOUND row would fall back to epoch.
      const [trust] = await trustForRecords([{ id: id.TASK_HIT, type: 'task' }]);
      expect(trust).toBeTruthy();
      expect(trust.band).toBeTruthy();
      // THE CONTROL THAT MAKES THIS MEAN SOMETHING. A ref whose id is in no table falls back
      // to `new Date(0)` — maximally stale. If the task lookup were silently missing the row
      // (wrong table, wrong column) the found and the not-found verdict would be IDENTICAL,
      // and a bare `band is truthy` assertion would pass anyway. Freshness is the field that
      // separates them, so it is the field asserted on.
      const [missing] = await trustForRecords([
        { id: '00000000-0000-0000-0000-000000000000', type: 'task' }]);
      expect(trust.freshness).toBeGreaterThan(missing.freshness);
      expect(trust.freshness).toBeGreaterThan(0);
    });

    test('the smart_search ROUTE renders a trust hint on a task row', async () => {
      const res: any = await searchRoutes.handleSmartSearch({
        query: QUERY, projectId, includeTypes: ['task'], limit: 5 });
      expect(res.isError).toBeFalsy();
      const text = res.content[0].text as string;
      expect(text).toContain('[task]');
      // The row for TASK_HIT carries a trust line. Asserted against the SAME renderer the
      // route uses, not against a hand-copied string that could drift from it.
      const expectedHint = SearchRoutes.trustHint(
        (await trustForRecords([{ id: id.TASK_HIT, type: 'task' }]))[0]);
      expect(expectedHint.length).toBeGreaterThan(0);
      expect(text).toContain(expectedHint);
    });

    test('the trustable set is exactly what trust.ts can resolve', () => {
      expect([...SearchRoutes.TRUSTABLE_RESULT_TYPES]).toEqual(['context', 'decision', 'task']);
      expect(SearchRoutes.isTrustableResultType('task')).toBe(true);
      // The kinds with no outcome graph stay OUT — a freshness-only number dressed as a
      // verdict is worse than no verdict.
      expect(SearchRoutes.isTrustableResultType('component')).toBe(false);
      expect(SearchRoutes.isTrustableResultType('agent')).toBe(false);
    });
  });

  // ===========================================================================
  // S7 — the source vocabulary and the default set agree with the adapters.
  // ===========================================================================
  describe('S7 the vocabulary, the default set and the adapters agree', () => {
    test('every DEFAULT source is a member of the VOCABULARY', () => {
      for (const key of SMART_SEARCH_DEFAULT_SOURCES) {
        expect(SMART_SEARCH_SOURCE_KEYS).toContain(key);
      }
    });

    test('every VOCABULARY key is actually reachable — it has a working adapter', async () => {
      // Behavioural, not structural: sourceAdapters() is private, and asserting against a
      // second hand-written list would just be the drift this checks for. A key with no
      // adapter now throws (S6), so "does not throw" IS the adapter check.
      for (const key of SMART_SEARCH_SOURCE_KEYS) {
        const { degradedSources } = await smartSearchHandler.smartSearchDetailed(
          projectId, QUERY, [key], 5);
        expect(degradedSources).toEqual([]);
      }
    });

    test('every VOCABULARY key has a per-source weight, and it is 1.0', () => {
      for (const key of SMART_SEARCH_SOURCE_KEYS) {
        expect(SEARCH_SOURCE_WEIGHTS[key]).toBe(1.0);
      }
    });
  });
});
