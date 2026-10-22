/**
 * CONTEXT SEARCH id-prefix + partial-tag lookup — Contract Test
 *
 * The Contexts half of the class-fix whose Decisions half shipped in 7014f77.
 * Operator pasted the id8 `e26aee99` into the Contexts search box and got nothing.
 *
 * THE BUG IS RANKING, NOT RETRIEVAL. Hex has no semantic content, so the embedder yields a
 * meaningless vector and the target ranks below unrelated prose. The score boost is what
 * fixes it — exactly as Decisions did.
 *
 * THIS FILE IS CONFIGURATION-AGNOSTIC ON PURPOSE — that is the lesson that produced it.
 * An earlier revision hard-asserted `activeEmbeddingColumn() === 'embedding'` in beforeAll and
 * hardcoded `DIM = 1536`, so it could ONLY run under the legacy minilm config. Prod runs
 * `MANDREL_EMBEDDER=gemma` (embedding_gemma, 768-d, with a CHECK constraint that a 1536-d
 * vector VIOLATES) — so the suite was structurally incapable of running in prod's
 * configuration, and its "acceptance" was proven only under a config prod does not run
 * (green in a worktree ≠ green in the real env). The column and geometry are
 * now DERIVED from the active embedder, so the same tests run — and must pass — under BOTH
 * `MANDREL_EMBEDDER=minilm` and `MANDREL_EMBEDDER=gemma`.
 *
 * WHY THE UN-EMBEDDED (`idTargetNull`) CASES ARE STILL HERE — they are NOT the prod case.
 * Measured on prod 2026-07-17: 0 of 8077 rows are NULL on the active gemma column, and
 * `e26aee99` has a 768-d gemma vector, so prod's gate already admitted it. The un-embedded
 * rows live on the LEGACY `embedding` column (586 NULLs) — which prod does not read. These
 * cases pin the gate relaxation + the SIM_EXPR COALESCE as ROLLBACK defense-in-depth:
 * embeddingConfig.ts is an explicitly reversible registry, and under a minilm rollback those
 * 586 rows genuinely are NULL and the relaxation becomes load-bearing. Under gemma they are
 * a no-op — seeded here by NULLing the ACTIVE column so the guarantee is pinned either way.
 *
 * Drives the REAL public tool path (zod validator → contextRoutes.handleSearch → real
 * migrated Postgres, the disposable ci_* DB from scripts/provision-test-db.sh — never
 * production), the same idiom as contextSearchTotalCount / decisionSearchIdTagLookup.
 *
 * WHAT THIS PROVES (the acceptance criteria):
 *   1. id-lookup — an 8-hex id-PREFIX and a FULL UUID each return the exact context at
 *      rank #1, on BOTH the hierarchical and baseline branches, for an EMBEDDED row (the
 *      real prod shape, ranked #1 via the BOOST with the gate a no-op) and for an
 *      un-embedded row (the rollback shape, which additionally needs the gate).
 *   2. partial-tag — a case-insensitive tag SUBSTRING reaches the context (Decisions parity).
 *   3. NO REGRESSION (the highest-risk part) — a non-id query returns the SAME rows in the
 *      SAME order with the SAME scores as the PRE-FIX SQL, proven against an independent
 *      legacy-SQL oracle; and a non-id query does NOT relax the gate.
 *   4. `total` cannot drift from the page: the COUNT applies the same relaxed gate.
 *   5. the real `queryLooksLikeId` class — including that DATES are id-shaped.
 *
 * SECURITY: the id match is a PARAMETERIZED `REPLACE(id::text,'-','') LIKE $n||'%'` and the
 * tag match a bound ILIKE (centralized buildSearchMatchPredicate) — nothing concatenated.
 * This test crafts ids only in the throwaway DB.
 */

import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

import { activeEmbedder } from '../config/embeddingConfig.js';

// DERIVED, never hardcoded: the active embedder decides both the column (activeEmbeddingColumn())
// and the geometry. gemma is 768-d with a CHECK constraint that rejects a 1536-d vector, so
// a hardcoded DIM silently pins this suite to minilm and makes it unrunnable under prod's
// real config. Deriving it is what lets the SAME tests run under both embedders.
const DIM = activeEmbedder().dimensions;

// Deterministic concept embedder (CI has no model download).
//
// IT MUST MODEL THE ACTUAL BUG, or it proves nothing. An earlier version mapped "no concept
// matched" to a single shared fallback vector — so a hex query and the target's prose both
// landed on it and scored a SPURIOUS 1.0 cosine against each other. The target then ranked #1
// for entirely the wrong reason, and the suite still passed with the boost DISABLED: a test
// that measures nothing passes everything. Caught by mutation-probing under gemma.
//
// The real failure mode: a hex id has no semantic content, so the embedder returns a
// MEANINGLESS direction that has nothing to do with the row the user wants — it lands near
// arbitrary unrelated prose, while the target sits somewhere else entirely. So:
//   - a hex-ish query      -> DIR_NOISE (the meaningless direction)
//   - the 'harbor' prose   -> DIR_NOISE  → the NOISE rows are the BEST semantic match
//   - everything else      -> DIR_TARGET → orthogonal to the query, similarity 0
// The target is therefore the WORST semantic match in the corpus and can ONLY reach #1 via
// the id boost. Disable the boost and the id-lookup tests go red, as they must.
const DIR_NOISE = 5;  // where a meaningless hex query lands — and the unrelated prose with it
const DIR_TARGET = 7; // the target's own direction: orthogonal to any hex query

/** A hex-ish string the real embedder would turn into a meaningless vector. */
const HEXISH_RE = /^[0-9a-f-]{8,}$/i;

function conceptVector(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const trimmed = text.trim();
  const lower = ` ${trimmed.toLowerCase()} `;
  // Exactly one unit component → every vector is normalized, none is the zero vector
  // (a zero vector makes cosine distance undefined).
  if (HEXISH_RE.test(trimmed) || [' harbor ', ' pilot ', ' vessel '].some((w) => lower.includes(w))) {
    v[DIR_NOISE] = 1;
  } else {
    v[DIR_TARGET] = 1;
  }
  return v;
}
function pgVec(text: string): string {
  return `[${conceptVector(text).join(',')}]`;
}

/**
 * A vector that is a GOOD but NOT PERFECT match for a hex query (cosine ~0.8).
 *
 * WHY THIS EXISTS — the tie that made this suite a coin flip. conceptVector only ever emits
 * unit BASIS vectors, so every cosine it can produce is exactly 0 or exactly 1. On the
 * BASELINE branch `similarity` IS the sort key and the id boost is folded straight into it
 * (handler: `COALESCE(1 - (col <=> $1), 0) + CASE WHEN <id match> THEN 1.0 END`), so an
 * un-embedded id target scores 0 + 1.0 = 1.0 — and a competitor that is a PERFECT semantic
 * match also scores exactly 1.0. `ORDER BY similarity DESC` carries no tiebreaker, so which
 * of the two came back as r[0] was decided by physical row order, not by ranking. Measured
 * 2026-08-29 (both rows returned similarity 100; the same two rows flip position purely by
 * insertion order under a seq scan), after the b7 gate went RED here on a ref where neither
 * this file nor the search handler had changed.
 *
 * 0.8 keeps the fixture DISCRIMINATING in the direction the test is about: the competitor is
 * still the better SEMANTIC match than the target (0.8 > 0), so the target can only reach #1
 * via the boost — but the ordering is now strict, so the assertion is decidable.
 */
function partialNoiseVec(): string {
  const v = new Array(DIM).fill(0);
  v[DIR_NOISE] = 0.8;
  v[DIR_TARGET] = 0.6; // unit length (0.8^2 + 0.6^2 = 1); cosine against a DIR_NOISE query ~0.8
  return `[${v.join(',')}]`;
}

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptVector(text),
      dimensions: DIM,
      model: 'concept-mock-minilm',
    })),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { contextRoutes } from '../routes/context.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { queryLooksLikeId } from '../utils/idResolver.js';

const STAMP = Date.now();
const PROJ_NAME = `context-idtag-${STAMP}`;
const BASELINE_PROJ_NAME = `context-idtag-baseline-${STAMP}`;
const PROD_SHAPE_PROJ_NAME = `context-idtag-prodshape-${STAMP}`;
const TAG_TARGET = 'ref:resume';
const TAG_UPPER_PROBE = 'bucket-search';

let projectId: string;         // hierarchical (default) → balanced branch
let baselineProjectId: string; // hierarchical explicitly disabled → baseline branch
/** A corpus shaped exactly like PROD: every row embedded on the ACTIVE column. */
let prodShapeProjectId: string;
let prodShapeTarget: string;

/** The real e26aee99 shape: an UN-EMBEDDED context, findable ONLY via the id path. */
let idTargetNull: string;
/** An EMBEDDED context carrying the tags (the partial-tag path operates on candidates). */
let idTargetEmb: string;
/** An UN-EMBEDDED context carrying the target tag — must stay invisible to a NON-id query. */
let tagTargetNull: string;
/** Embedded prose rows that legitimately match the text concept. */
const noiseIds: string[] = [];
/** The un-embedded id target's twin in the baseline (non-hierarchical) project. */
let baselineIdTargetNull: string;

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(rawArgs: any) {
  const validated = validateToolArguments('context_search', rawArgs);
  return contextRoutes.handleSearch(validated);
}

const rows = (resp: any): any[] => resp?.structuredContent?.results ?? [];
const total = (resp: any): number => resp?.structuredContent?.total;

async function seed(opts: {
  projectId: string;
  content: string;
  type?: string;
  tags?: string[];
  embedded: boolean;
  /** Explicit vector literal, for a row that needs a similarity conceptVector cannot express. */
  vec?: string;
}): Promise<string> {
  const res = await db.query(
    `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()}, relevance_score, tags)
     VALUES ($1, $2, $3, $4::vector, 5.0, $5)
     RETURNING id::text AS id`,
    [
      opts.projectId,
      opts.type ?? 'planning',
      opts.content,
      opts.embedded ? (opts.vec ?? pgVec(opts.content)) : null,
      opts.tags ?? [],
    ],
  );
  return res.rows[0].id;
}

describe('context_search id-prefix + partial-tag lookup', () => {
  beforeAll(async () => {
    // NO COLUMN PIN. The suite must run under whatever embedder is configured — asserting a
    // specific column here is what made the earlier revision unable to run under prod's
    // gemma config. Log the config instead, so a failure report says which one it ran under.
    console.log(
      `[709aca13] running under MANDREL_EMBEDDER=${activeEmbedder().key} ` +
      `(column=${activeEmbeddingColumn()}, dims=${DIM})`,
    );

    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'context id/tag fuse') RETURNING id`,
      [PROJ_NAME],
    )).rows[0].id;

    // hierarchical_memory_enabled = 'false' → searchContext takes the BASELINE branch,
    // where `similarity` (not combined_score) is the sort key. The boost must land there too.
    baselineProjectId = (await db.query(
      `INSERT INTO projects (name, description, metadata)
       VALUES ($1, 'context id/tag fuse (baseline branch)', '{"hierarchical_memory_enabled":"false"}'::jsonb)
       RETURNING id`,
      [BASELINE_PROJ_NAME],
    )).rows[0].id;

    // THE REAL CASE: un-embedded, prose that does NOT hit the query concept, no tags →
    // reachable ONLY if the gate relaxes AND the boost ranks it.
    idTargetNull = await seed({
      projectId,
      content: 'HANDOFF — un-embedded legacy row, reachable only by id',
      type: 'handoff',
      embedded: false,
    });

    idTargetEmb = await seed({
      projectId,
      content: 'harbor pilot notes with tags',
      tags: [TAG_TARGET, TAG_UPPER_PROBE],
      embedded: true,
    });

    tagTargetNull = await seed({
      projectId,
      content: 'un-embedded row that merely carries the tag',
      tags: [TAG_TARGET],
      embedded: false,
    });

    for (let i = 0; i < 4; i++) {
      noiseIds.push(await seed({
        projectId,
        content: `harbor vessel pilot log entry ${i}`,
        embedded: true,
      }));
    }

    baselineIdTargetNull = await seed({
      projectId: baselineProjectId,
      content: 'baseline-branch un-embedded row, reachable only by id',
      embedded: false,
    });
    // The baseline competitor is a 0.8 match, NOT a perfect 1.0 one — see partialNoiseVec().
    // At 1.0 it tied the id target's 0 + boost exactly, and the winner was physical row order.
    await seed({
      projectId: baselineProjectId,
      content: 'harbor vessel baseline noise',
      embedded: true,
      vec: partialNoiseVec(),
    });

    // PROD-SHAPE corpus: EVERY row embedded on the ACTIVE column, mirroring prod (0 of 8077
    // NULL on embedding_gemma). The target's prose deliberately does NOT hit the query
    // concept, and the noise rows DO — so semantically the target is the WORST match and can
    // only reach #1 via the id boost. This is the reported bug's real shape.
    prodShapeProjectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'context id/tag fuse (prod shape)') RETURNING id`,
      [PROD_SHAPE_PROJ_NAME],
    )).rows[0].id;
    prodShapeTarget = await seed({
      projectId: prodShapeProjectId,
      content: '★ HANDOFF — 2026-07-17 Contexts page review + sessions rollout',
      type: 'handoff',
      embedded: true,
    });
    for (let i = 0; i < 4; i++) {
      await seed({
        projectId: prodShapeProjectId,
        content: `harbor vessel pilot dockside report ${i}`,
        embedded: true,
      });
    }
  });

  afterAll(async () => {
    for (const pid of [projectId, baselineProjectId, prodShapeProjectId]) {
      if (!pid) continue;
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [pid]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── Criterion 1: id-lookup ───────────────────────────────────────────────────
  test('id-lookup: an 8-hex id-PREFIX returns the UN-EMBEDDED context at rank #1 (the e26aee99 case)', async () => {
    const prefix = idTargetNull.slice(0, 8);
    const resp = await viaPublicTool({ query: prefix, projectId, limit: 20 });
    const r = rows(resp);
    // PRE-FIX this returned the noise rows and NOT the target at all (the gate excluded it).
    expect(r.map((c) => c.id)).toContain(idTargetNull);
    expect(r[0].id).toBe(idTargetNull);
  });

  test('id-lookup: a FULL UUID returns the exact un-embedded context at rank #1', async () => {
    const resp = await viaPublicTool({ query: idTargetNull, projectId, limit: 20 });
    const r = rows(resp);
    expect(r[0].id).toBe(idTargetNull);
  });

  test('id-lookup: an id-prefix of an EMBEDDED context also ranks it #1 (boost beats every text hit)', async () => {
    const prefix = idTargetEmb.slice(0, 8);
    const resp = await viaPublicTool({ query: prefix, projectId, limit: 20 });
    const r = rows(resp);
    expect(r[0].id).toBe(idTargetEmb);
  });

  test('id-lookup: works on the BASELINE branch too (similarity is the sort key there)', async () => {
    const prefix = baselineIdTargetNull.slice(0, 8);
    const resp = await viaPublicTool({ query: prefix, projectId: baselineProjectId, limit: 20 });
    const r = rows(resp);
    expect(r[0].id).toBe(baselineIdTargetNull);
  });

  // ── THE PROD ACCEPTANCE: the shape that actually decides this task ────────────
  test('PROD SHAPE: an id8 over a FULLY-EMBEDDED corpus ranks the target #1 via the BOOST (gate is a no-op)', async () => {
    // This mirrors prod exactly: every row embedded on the ACTIVE column (prod: 0 of 8077
    // NULL on embedding_gemma), so the relaxed gate is `TRUE OR …` for every row and admits
    // NOTHING extra. The target is the WORST semantic match in the corpus (its prose misses
    // the 'harbor' concept the noise rows hit) — exactly the reported bug, where a hex query
    // embeds to noise. Only the boost can carry it to #1.
    const nullsOnActiveColumn = await db.query(
      `SELECT COUNT(*)::int AS n FROM contexts
        WHERE project_id = $1 AND ${activeEmbeddingColumn()} IS NULL`,
      [prodShapeProjectId],
    );
    expect(nullsOnActiveColumn.rows[0].n, 'prod-shape corpus must have NO un-embedded rows').toBe(0);

    const resp = await viaPublicTool({ query: prodShapeTarget.slice(0, 8), projectId: prodShapeProjectId, limit: 20 });
    const r = rows(resp);
    expect(r[0].id).toBe(prodShapeTarget);

    // The gate admitted nothing extra: `total` equals the full embedded corpus, so the row
    // reached #1 purely on the score boost — which is what fixes the bug under prod's config.
    const corpus = await db.query(
      `SELECT COUNT(*)::int AS n FROM contexts WHERE project_id = $1 AND archived_at IS NULL`,
      [prodShapeProjectId],
    );
    expect(total(resp)).toBe(corpus.rows[0].n);
  });

  test('id-lookup: a dashed PARTIAL uuid (a pasted prefix) still resolves to rank #1', async () => {
    const dashed = idTargetNull.slice(0, 13); // e.g. "e26aee99-4208"
    expect(dashed).toContain('-');
    const resp = await viaPublicTool({ query: dashed, projectId, limit: 20 });
    expect(rows(resp)[0].id).toBe(idTargetNull);
  });

  // ── Criterion 2: partial-tag (Decisions parity) ──────────────────────────────
  test('partial-tag: a SUBSTRING of a tag reaches the context carrying it', async () => {
    const resp = await viaPublicTool({ query: 'ref:res', projectId, limit: 20 });
    expect(rows(resp).some((c) => c.id === idTargetEmb)).toBe(true);
  });

  test('partial-tag: case-insensitive — an UPPER-CASE substring matches a lower-case tag', async () => {
    const resp = await viaPublicTool({ query: 'BUCKET-SEARCH', projectId, limit: 20 });
    expect(rows(resp).some((c) => c.id === idTargetEmb)).toBe(true);
  });

  test('partial-tag: an exact tag hit outranks rows that only match on prose', async () => {
    const resp = await viaPublicTool({ query: 'ref:res', projectId, limit: 20 });
    expect(rows(resp)[0].id).toBe(idTargetEmb);
  });

  // ── Criterion 3: NO REGRESSION — the highest-risk part of the change ──────────
  test('no-regression: a non-id query returns the SAME rows, order and scores as the PRE-FIX SQL', async () => {
    // INDEPENDENT ORACLE: the pre-fix balanced-branch SQL, written out verbatim as it stood
    // before this task (no COALESCE on the similarity signal, the un-relaxed
    // `embedding IS NOT NULL` gate, no id/tag boost in combined_score). If the fix perturbs
    // an ordinary text query by so much as a row, an ordinal, or a score, this goes RED.
    //
    // The weights MIRROR the RANK_WEIGHTS.balanced defaults (0.70/0.10/0.10/0.10 — the
    // similarity-dominant profile from an earlier task). They are written out rather than
    // imported ON PURPOSE: an oracle that imported the handler's own constants could not
    // catch the handler mis-applying them. If the profile is ever retuned, update this
    // oracle in step — a deliberate speed bump on a ranking change, not an obstacle.
    const [W_SIM, W_REC, W_IMP, W_TYPE] = [0.7, 0.1, 0.1, 0.1];
    // THE INVARIANT THE +1 BOOST RESTS ON: the weights sum to 1.0 and each signal is in
    // [0,1], so combined_score ≤ 1 and SEARCH_ID_MATCH_SCORE_BOOST (1.0) is at least the
    // maximum attainable score — an id hit is never outranked. At the boundary it can TIE
    // (a perfect 1.0 match), and the ORDER BY's tiebreaker decides that, not the boost
    //. If a retune pushes this sum above 1, the boost must rise with it
    // (via SEARCH_ID_MATCH_SCORE_BOOST) or an id hit starts ranking BELOW ordinary rows.
    expect(W_SIM + W_REC + W_IMP + W_TYPE).toBeLessThanOrEqual(1.0);

    const q = 'harbor pilot';
    const legacy = await db.query(
      `SELECT id::text AS id,
              (
                (1 - (${activeEmbeddingColumn()} <=> $1::vector)) * ${W_SIM} +
                (EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / (30 * 24.0 * 3600))) * ${W_REC} +
                (COALESCE(relevance_score, 5.0) / 10.0) * ${W_IMP} +
                (CASE context_type
                   WHEN 'milestone' THEN 1.0 WHEN 'decision' THEN 0.9 WHEN 'completion' THEN 0.8
                   WHEN 'reflections' THEN 0.7 WHEN 'planning' THEN 0.6 WHEN 'code' THEN 0.5
                   ELSE 0.4 END) * ${W_TYPE}
              ) AS combined_score
         FROM contexts
        WHERE ${activeEmbeddingColumn()} IS NOT NULL
          AND archived_at IS NULL
          AND project_id = $2
        -- MIRRORS THE PRODUCT'S TOTAL ORDER. The oracle compares row order
        -- byte-for-byte against the handler, so an oracle ordering by the score ALONE
        -- disagrees with the handler the moment two rows tie — a latent flake in the guard,
        -- not in the product. The tiebreaker is part of the ordering contract being asserted.
        ORDER BY combined_score DESC, created_at DESC, id DESC
        LIMIT 20`,
      [pgVec(q), projectId],
    );

    const resp = await viaPublicTool({ query: q, projectId, limit: 20 });
    const r = rows(resp);

    // Same row set, in the same order.
    expect(r.map((c) => c.id)).toEqual(legacy.rows.map((c: any) => c.id));

    // Same score, to the precision the tool reports (`relevance` = the sort key, 1 dp).
    const legacyRelevance = legacy.rows.map((c: any) =>
      Math.round(Math.max(0, Math.min(1, parseFloat(c.combined_score))) * 100 * 10) / 10,
    );
    expect(r.map((c) => c.relevance)).toEqual(legacyRelevance);
  });

  test('no-regression: a NON-id query does NOT relax the gate (un-embedded rows stay excluded)', async () => {
    // `tagTargetNull` is un-embedded and carries 'ref:resume'. The tag arm of the predicate
    // matches it, but the query 'ref:res' is NOT id-shaped, so the gate must NOT relax and
    // the row must NOT appear — otherwise every ordinary text search would start returning
    // rows it never returned before. This is the exact line the fix must not cross.
    expect(queryLooksLikeId('ref:res')).toBe(false);
    const resp = await viaPublicTool({ query: 'ref:res', projectId, limit: 20 });
    expect(rows(resp).some((c) => c.id === tagTargetNull)).toBe(false);
  });

  test('no-regression: a query matching no id and no tag scores every row +0 (pure prose ranking)', async () => {
    const resp = await viaPublicTool({ query: 'harbor vessel', projectId, limit: 20 });
    const r = rows(resp);
    expect(r.length).toBeGreaterThan(0);
    // No row can reach the boosted band: every non-matching row's combined_score stays in
    // [0,1] → relevance ≤ 100 and, with no id/tag hit, strictly below the saturated 100
    // that a boosted row shows.
    for (const c of r) expect(c.relevance).toBeLessThan(100);
  });

  test('the id-shaped class is WIDER than "looks like a uuid" — DATES are id-shaped', async () => {
    // MEASURED, not assumed. queryLooksLikeId accepts ANY 8+-char dash-stripped hex string.
    // A date matches that shape, and this repo's own tags literally contain '2026-07-17'
    // (an earlier task carries it) — so a date query DOES take the relaxed-gate path.
    // Pinned here so nobody re-describes this as a "narrow, safe" class of queries.
    expect(queryLooksLikeId('2026-07-17')).toBe(true); // dash-stripped '20260717' = 8 hex
    expect(queryLooksLikeId('20260717')).toBe(true);
    expect(queryLooksLikeId('12345678')).toBe(true);
    expect(queryLooksLikeId('deadbeef')).toBe(true);
    // Below the 8-char floor → plain text, whether hex-spellable or not.
    expect(queryLooksLikeId('2026-07')).toBe(false); // '202607' = 6 hex
    expect(queryLooksLikeId('added')).toBe(false);   // hex-spellable but only 5
    // Non-hex is never id-shaped at any length.
    expect(queryLooksLikeId('ref:res')).toBe(false);

    // The BOUND on the blast radius: an id-shaped date query relaxes the gate, but the
    // relaxation still only admits rows whose id-prefix or tag SUBSTRING actually matches —
    // never "every un-embedded row". Here the date matches no id and no tag in this project,
    // so nothing extra is admitted and the un-embedded rows stay out.
    const resp = await viaPublicTool({ query: '2026-07-17', projectId, limit: 20 });
    expect(rows(resp).some((c) => c.id === idTargetNull)).toBe(false);
    expect(rows(resp).some((c) => c.id === tagTargetNull)).toBe(false);
  });

  test('no-regression: a hex string BELOW the 8-char floor is treated as plain text, not an id', async () => {
    // The floor is what stops a short hex string (`abc`) from dragging id matches in.
    const shortHex = idTargetNull.slice(0, 4);
    expect(queryLooksLikeId(shortHex)).toBe(false);
    const resp = await viaPublicTool({ query: shortHex, projectId, limit: 20 });
    expect(rows(resp).some((c) => c.id === idTargetNull)).toBe(false);
  });

  test('no-regression: an id-shaped query that matches NOTHING returns no false id hit', async () => {
    const resp = await viaPublicTool({ query: 'ffffffff', projectId, limit: 20 });
    expect(rows(resp).some((c) => c.id === idTargetNull)).toBe(false);
    expect(rows(resp).some((c) => c.id === tagTargetNull)).toBe(false);
  });

  // ── Criterion 4: `total` must not drift from the page ────────────
  test('total: an id query counts the SAME relaxed candidate set the page returned', async () => {
    const prefix = idTargetNull.slice(0, 8);
    const resp = await viaPublicTool({ query: prefix, projectId, limit: 20 });
    // The page returns the un-embedded target. If countContext kept the un-relaxed gate it
    // would count only the embedded rows — reporting a total that EXCLUDES a row the page
    // just showed. total must be >= the page and must include the target.
    expect(rows(resp).length).toBeGreaterThan(0);
    expect(total(resp)).toBeGreaterThanOrEqual(rows(resp).length);

    // Exact: the relaxed set = the 5 embedded rows + the 1 un-embedded id hit.
    const embedded = await db.query(
      `SELECT COUNT(*)::int AS n FROM contexts
        WHERE project_id = $1 AND ${activeEmbeddingColumn()} IS NOT NULL AND archived_at IS NULL`,
      [projectId],
    );
    expect(total(resp)).toBe(embedded.rows[0].n + 1);
  });

  test('total: a NON-id query counts exactly the un-relaxed embedded candidate set (unchanged)', async () => {
    const resp = await viaPublicTool({ query: 'harbor pilot', projectId, limit: 20 });
    const embedded = await db.query(
      `SELECT COUNT(*)::int AS n FROM contexts
        WHERE project_id = $1 AND ${activeEmbeddingColumn()} IS NOT NULL AND archived_at IS NULL`,
      [projectId],
    );
    expect(total(resp)).toBe(embedded.rows[0].n);
  });

  // ── The 60-day temporal filter invariant (the recency branch) ─────────────────
  test('the recency branch can never swallow an id query: no recency keyword is pure hex', async () => {
    // searchContext routes to the RECENCY branch (which adds `created_at > NOW() - 60 days`,
    // a filter this fix does NOT relax) when the query contains a recency keyword. That
    // branch can never see an id-shaped query, because `queryLooksLikeId` accepts only
    // [0-9a-f-] and every keyword contains a letter outside hex. This test PINS that
    // invariant: add a hex-spellable keyword (e.g. 'added', 'faded') and it goes RED —
    // which is the signal to relax the temporal filter too, rather than a silent
    // regression where an old context stops being findable by its id.
    const RECENCY_KEYWORDS = [
      'recent', 'latest', 'current', 'now',
      'today', 'yesterday', 'this week', 'this month',
      'new', 'newest', 'just', 'last',
    ];
    for (const kw of RECENCY_KEYWORDS) {
      expect(queryLooksLikeId(kw), `recency keyword "${kw}" must not be id-shaped`).toBe(false);
    }
  });

  test('an id query finds a context OLDER than the recency branch 60-day window', async () => {
    // Behavioural companion to the invariant above: the target is aged past 60 days, then
    // fetched by id. Proves the id path is not silently bounded by the temporal filter.
    const oldId = await seed({
      projectId,
      content: 'ancient un-embedded row, well outside the 60-day window',
      embedded: false,
    });
    await db.query(`UPDATE contexts SET created_at = NOW() - INTERVAL '400 days' WHERE id = $1`, [oldId]);
    const resp = await viaPublicTool({ query: oldId.slice(0, 8), projectId, limit: 20 });
    expect(rows(resp)[0].id).toBe(oldId);
  });
});
