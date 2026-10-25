/**
 * AN id8 INSIDE A SENTENCE MUST RESOLVE — Contract Test.
 *
 * THE BUG (measured on live prod 2026-08-22 during the P1 retrieval baseline, arm
 * `prod-http`, limit 5 — P1 baseline rows X16/X17)
 * ---------------------------------------------------------------------------------------
 *   X16  query = "<id8>"                       → the record at RANK 1, score 1.2699 (far
 *                                                outside the 0.34–0.59 semantic band).
 *   X17  query = "what is decision <id8> about" → the record NOT IN THE TOP FIVE AT ALL.
 *
 * The id path was real but brittle: `queryLooksLikeId` tested the WHOLE QUERY, so a single
 * surrounding word discarded an exact identifier the caller obviously meant. That is the
 * natural way a person types it, and it is the difference between "search knows about ids"
 * and "search knows about ids if you type nothing else".
 *
 * THE FIX SHAPE the task asked for: extract id-shaped TOKENS from the query instead of
 * testing the query as a whole, and let a recognised id resolve its record ALONGSIDE
 * whatever else the query retrieves. Not a sentence special-case — take the tokens.
 *
 * WHY THIS FILE ASSERTS AT THE SHARED PREDICATE *AND* AT THREE TOOLS
 * -----------------------------------------------------------------
 * `buildSearchMatchPredicate` (utils/idResolver.ts) is the ONE id/tag predicate builder;
 * context, decision and task search all call it. Fixing it there fixes the class. Asserting
 * it only through context_search would leave "does the fix reach the other two callers?"
 * as prose — so each caller gets an executed case instead of a sentence claiming coverage.
 *
 * NO-REGRESSION IS HALF THE DELIVERABLE (the task says X16 must not regress):
 *   - a bare id8 query still ranks its record #1 — the token path degenerates to exactly
 *     the old whole-query path when the query IS one token;
 *   - a sentence with NO id token gets NO id arm — proven by a query of ordinary prose
 *     returning nothing extra, so the widened arm cannot be matching everything.
 *
 * MUTATION PROBE: revert `buildSearchMatchPredicate` to `if (queryLooksLikeId(q))` and the
 * sentence cases go RED while every bare-id and no-id case stays GREEN.
 *
 * DB target: the disposable migrated ci_* DB — never production.
 */

import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';
import { activeEmbedder } from '../config/embeddingConfig.js';

const DIM = activeEmbedder().dimensions;

// Deterministic concept embedder — and it MUST MODEL THE BUG. A hex id carries no semantic
// content, so the real embedder puts a hex-bearing query somewhere meaningless, NOT near the
// row the user wants. Here every query lands on DIR_NOISE and the target prose sits on
// DIR_TARGET (orthogonal, similarity 0), so the target is the WORST semantic match in the
// corpus and can only reach rank #1 through the id arm. Without this, a test would pass for
// the wrong reason (this exact trap is documented in contextSearchIdTagLookup.contract.test.ts).
const DIR_NOISE = 5;
const DIR_TARGET = 7;
function conceptVector(text: string): number[] {
  const v = new Array(DIM).fill(0);
  v[text.includes('THE-TARGET-PROSE') ? DIR_TARGET : DIR_NOISE] = 1;
  return v;
}
const pgVec = (t: string) => `[${conceptVector(t).join(',')}]`;

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptVector(text),
      dimensions: DIM,
      model: 'concept-mock',
    })),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { contextRoutes } from '../routes/context.routes.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { extractIdTokens, queryLooksLikeId } from '../utils/idResolver.js';
import { SEARCH_ID_MAX_QUERY_TOKENS } from '../config/searchConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `idtoken-${STAMP}`;
const conn = `idtoken-conn-${STAMP}`;

let projectId = '';
let ctxTargetId = '';
let decisionTargetId = '';
let taskTargetId = '';

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);
const ctxRows = (resp: any): any[] => resp?.structuredContent?.results ?? [];

async function searchContexts(query: string): Promise<any[]> {
  const validated = validateToolArguments('context_search', { query, projectId, limit: 5 });
  return ctxRows(await contextRoutes.handleSearch(validated));
}
async function searchDecisions(query: string): Promise<string> {
  const validated = validateToolArguments('decision_search', { query, projectId, limit: 5 });
  const resp = await routeExecutor('decision_search', validated, { connectionId: conn });
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
// The TASKS caller of the shared predicate is tasksHandler.searchTasks, which the public
// surface reaches through smart_search (task_list has no free-text `query` param — verified
// by strict-mode rejection). smart_search is therefore the honest public entry point for the
// task arm of this class fix.
async function searchTasks(query: string): Promise<string> {
  const validated = validateToolArguments('smart_search', {
    query,
    projectId,
    includeTypes: ['task'],
    limit: 5,
  });
  const resp = await routeExecutor('smart_search', validated, { connectionId: conn });
  return JSON.stringify(resp?.structuredContent ?? {}) + (resp?.content?.map((c: any) => c.text).join('\n') ?? '');
}

describe('id-token extraction — an id8 inside a sentence resolves', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'bdd5f00d fixture') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;

    // THE TARGET: prose that is semantically ORTHOGONAL to any query below, so only the id
    // arm can retrieve/rank it.
    ctxTargetId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()}, relevance_score, tags)
         VALUES ($1, 'planning', $2, $3::vector, 5.0, '{}') RETURNING id::text AS id`,
        [projectId, 'THE-TARGET-PROSE about tidal harbour survey scheduling', pgVec('THE-TARGET-PROSE')],
      )
    ).rows[0].id;

    // Distractors that DO match every query's concept — the rows X17 actually returned.
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()}, relevance_score, tags)
         VALUES ($1, 'planning', $2, $3::vector, 5.0, '{}')`,
        [projectId, `unrelated distractor row ${i}`, pgVec(`unrelated distractor row ${i}`)],
      );
    }

    decisionTargetId = (
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level, status)
         VALUES ($1, 'architecture', 'THE-TARGET-PROSE decision', 'd', 'r', 'medium', 'active')
         RETURNING id::text AS id`,
        [projectId],
      )
    ).rows[0].id;
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level, status)
         VALUES ($1, 'architecture', $2, 'd', 'r', 'medium', 'active')`,
        [projectId, `unrelated decision ${i}`],
      );
    }

    taskTargetId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'THE-TARGET-PROSE task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
        [projectId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* teardown noise */ }
    await db.end();
  });

  // ── the extractor itself (pure, so the classification is directly readable) ──────────
  describe('extractIdTokens', () => {
    test('pulls the id8 out of the X17 sentence', () => {
      expect(extractIdTokens('what is decision bdd5f00d about')).toEqual(['bdd5f00d']);
    });
    test('a bare id8 yields exactly the same single token (X16 degenerates to the old path)', () => {
      expect(extractIdTokens('bdd5f00d')).toEqual(['bdd5f00d']);
      expect(queryLooksLikeId('bdd5f00d')).toBe(true);
    });
    test('a full uuid in a sentence is extracted whole, dashes and all', () => {
      const u = 'bdd5f00d-7ab1-4a04-8759-678872af50bb';
      expect(extractIdTokens(`please open ${u} for me`)).toEqual([u]);
    });
    test('separators that cannot occur inside an id do not hide one', () => {
      expect(extractIdTokens('re: task:bdd5f00d, thoughts?')).toEqual(['bdd5f00d']);
      expect(extractIdTokens('(bdd5f00d)')).toEqual(['bdd5f00d']);
    });
    test('ordinary prose yields NO tokens — the arm cannot fire on everything', () => {
      expect(extractIdTokens('what is this decision about')).toEqual([]);
      expect(extractIdTokens('the quick brown fox jumps over the lazy dog')).toEqual([]);
    });
    test('a hex run BELOW the floor is not a token (the pre-existing floor is unchanged)', () => {
      expect(extractIdTokens('see face and beef')).toEqual([]);
    });
    test('duplicates collapse and the token count is CAPPED by config', () => {
      expect(extractIdTokens('bdd5f00d and again bdd5f00d')).toEqual(['bdd5f00d']);
      const many = Array.from({ length: SEARCH_ID_MAX_QUERY_TOKENS + 3 }, (_, i) =>
        `deadbe${i.toString(16).padStart(2, '0')}`,
      ).join(' ');
      expect(extractIdTokens(many)).toHaveLength(SEARCH_ID_MAX_QUERY_TOKENS);
    });
  });

  // ── X17: the reported bug, through the real public tool ─────────────────────────────
  test('X17 — context_search("what is decision <id8> about") returns the record at RANK 1', async () => {
    const rows = await searchContexts(`what is decision ${id8(ctxTargetId)} about`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].id).toBe(ctxTargetId);
  });

  test('X17 variant — the id8 at the END of a sentence resolves too', async () => {
    const rows = await searchContexts(`remind me about ${id8(ctxTargetId)}`);
    expect(rows[0].id).toBe(ctxTargetId);
  });

  test('X17 variant — a FULL UUID inside a sentence resolves', async () => {
    const rows = await searchContexts(`what is decision ${ctxTargetId} about`);
    expect(rows[0].id).toBe(ctxTargetId);
  });

  // ── X16: must not regress ───────────────────────────────────────────────────────────
  test('X16 — a BARE id8 still returns the record at rank 1 (no regression)', async () => {
    const rows = await searchContexts(id8(ctxTargetId));
    expect(rows[0].id).toBe(ctxTargetId);
  });

  // ── the arm is not matching everything ──────────────────────────────────────────────
  test('CONTROL — the same sentence WITHOUT an id does NOT surface the target', async () => {
    const rows = await searchContexts('what is decision about');
    expect(rows.map((r) => r.id)).not.toContain(ctxTargetId);
  });

  test('CONTROL — a sentence carrying a DIFFERENT, non-existent id8 does not surface it', async () => {
    const rows = await searchContexts('what is decision deadbe0f about');
    expect(rows.map((r) => r.id)).not.toContain(ctxTargetId);
  });

  // ── the class, not the instance: the other two callers of the shared predicate ───────
  test('decision_search — an id8 inside a sentence reaches the decision', async () => {
    const text = await searchDecisions(`what is decision ${id8(decisionTargetId)} about`);
    expect(text).toContain('THE-TARGET-PROSE decision');
  });

  test('smart_search (tasks) — an id8 inside a sentence reaches the task', async () => {
    const text = await searchTasks(`what about task ${id8(taskTargetId)} then`);
    expect(text).toContain('THE-TARGET-PROSE task');
  });
});
