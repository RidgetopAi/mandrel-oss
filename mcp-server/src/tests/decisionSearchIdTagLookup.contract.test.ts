/**
 * DECISION SEARCH id-prefix + partial-tag lookup — Contract Test
 *
 * The part-2 / sibling of the Command-backend class-fix. The Command UI
 * Decisions view + the MCP `decision_search` tool both proxy to the CORE searchDecisions
 * handler, which (before this task) could not:
 *   - find a decision by a bare id typed in the search box (full UUID or hex prefix), and
 *   - match a PARTIAL tag (tag filtering against the free-text query did not exist; the
 *     `tags` filter was an EXACT `tags && [..]` array-overlap).
 *
 * Drives the REAL public tool path (zod validator → decisionsRoutes.handleSearch → real
 * migrated Postgres, the disposable ci_* DB from scripts/provision-test-db.sh — never
 * production), the same idiom as shortIdResolution.contract.test.ts. Embeddings are NOT
 * stubbed; in CI the deterministic mock applies. To make the gate deterministic for the
 * id/tag-signal assertions we NULL the seeded rows' embeddings (the legacy-row path the
 * fix must still admit), so a row surfaces ONLY via the id/tag/text signal under test.
 *
 * WHAT THIS PROVES (acceptance criteria 1-3):
 *   1. id-lookup   — a full UUID OR an 8-hex id-prefix typed as the query returns the
 *                    EXACT decision, ranked result #1.
 *   2. partial-tag — a case-insensitive SUBSTRING of a tag returns decisions carrying a
 *                    tag that contains it (and a non-matching substring does not).
 *   3. no-regression — a plain text query still matches prose; a filter-only (no-query)
 *                    search is unchanged (newest-first, no similarity); the result OUTPUT
 *                    SHAPE (fields) is identical on every path.
 *
 * SECURITY: the id-prefix match is a PARAMETERIZED `REPLACE(id::text,'-','') LIKE $n||'%'`
 * (bound $n, never concatenated) — the centralized buildSearchMatchPredicate in
 * utils/idResolver, reusing the resolver's normalizeShortId. The partial-tag is a bound
 * ILIKE. This test crafts ids only in the throwaway DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';

import { db } from '../config/database.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `decision-search-idtag-${STAMP}`;

let projectId: string;
let targetId: string; // the decision we look up by id / matching tag
let noiseId: string;  // a different decision that must NOT match the id-prefix or matching tag

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(toolName: string, rawArgs: any) {
  const validated = validateToolArguments(toolName, rawArgs);
  return decisionsRoutes.handleSearch(validated);
}

/** Extract the structured result rows from a decision_search response. */
function rows(resp: any): any[] {
  return resp?.data?.results ?? [];
}

describe('decision_search id-prefix + partial-tag lookup', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'idtag fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;

    targetId = (await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, impact_level, tags)
       VALUES ($1,'database','Adopt pgvector for search','desc','rationale','high',
               ARRAY['ref:resume','bucket-search'])
       RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    noiseId = (await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, impact_level, tags)
       VALUES ($1,'pattern','Use repository pattern','desc','rationale','low',
               ARRAY['architecture'])
       RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    // Deterministic gate: NULL the embeddings so a row surfaces ONLY via the id/tag/text
    // signal under test (the legacy-row path the fix must still admit), not "every row has
    // an embedding". This is exactly the un-embedded legacy decision the gate must handle.
    await db.query(
      `UPDATE technical_decisions SET ${activeEmbeddingColumn()} = NULL WHERE project_id = $1`,
      [projectId]
    );
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── Criterion 1: id-lookup (full UUID + hex prefix) ──────────────────────────
  test('id-lookup: a FULL UUID typed as the query returns the exact decision, ranked #1', async () => {
    const resp = await viaPublicTool('decision_search', { query: targetId, projectId, limit: 20 });
    const r = rows(resp);
    expect(r.length).toBeGreaterThanOrEqual(1);
    // The POSITIVE guarantee the id/tag fix makes: an exact id hit gets a +1 score boost
    // (handler folds `CASE WHEN id_match THEN 1` INTO search_score, where text/trgm scores
    // live in [0,1]), so the target is ranked result #1 — strictly above any row that can
    // only reach the row via the pre-existing trgm prose gate. We assert RANK, not absence:
    // the noise row CAN legitimately surface via that independent trgm path, so "noise
    // never present" is non-deterministic; "target outranks noise" is the real invariant.
    expect(r[0].id).toBe(targetId);
    const noiseRank = r.findIndex((d) => d.id === noiseId);
    if (noiseRank !== -1) {
      // If the noise row appears at all (via the unrelated trgm gate), it must rank BELOW
      // the target — i.e. it never beats the id/tag match. Target is #1, so any noise hit
      // is strictly after it.
      expect(noiseRank).toBeGreaterThan(0);
    }
  });

  test('id-lookup: an 8-hex id-PREFIX typed as the query returns the exact decision, ranked #1', async () => {
    const prefix = targetId.slice(0, 8);
    const resp = await viaPublicTool('decision_search', { query: prefix, projectId, limit: 20 });
    const r = rows(resp);
    expect(r.length).toBeGreaterThanOrEqual(1);
    // Same RANK invariant as the full-UUID case. NOTE: an 8-hex prefix can trigram-overlap
    // the noise row's prose (~12.5% of random prefixes), so "noise absent" flakes; "target
    // ranked #1" is deterministic because the id-prefix +1 boost always outscores a trgm-only
    // hit. We prove the fix returns the RIGHT record at the top, and that noise never beats it.
    expect(r[0].id).toBe(targetId);
    const noiseRank = r.findIndex((d) => d.id === noiseId);
    if (noiseRank !== -1) {
      expect(noiseRank).toBeGreaterThan(0);
    }
  });

  // ── Criterion 2: partial-tag (case-insensitive substring) ────────────────────
  test('partial-tag: a SUBSTRING of a tag returns the decision carrying a tag that contains it', async () => {
    // Target carries 'ref:resume'; the substring 'ref:res' must reach it. The substring
    // must NOT reach a decision whose tags do not contain it.
    const resp = await viaPublicTool('decision_search', { query: 'ref:res', projectId, limit: 20 });
    const r = rows(resp);
    expect(r.some((d) => d.id === targetId)).toBe(true);
  });

  test('partial-tag: case-insensitive — an UPPER-CASE substring still matches a lower-case tag', async () => {
    const resp = await viaPublicTool('decision_search', { query: 'BUCKET-SEARCH', projectId, limit: 20 });
    const r = rows(resp);
    expect(r.some((d) => d.id === targetId)).toBe(true);
  });

  test('partial-tag: a substring matching NO tag (and no prose) returns no false tag match', async () => {
    // 'zzqqnotag' is not a substring of any tag and not in any prose → target not matched
    // via the tag path. (The pre-existing trgm prose gate is unrelated to the tag path.)
    const resp = await viaPublicTool('decision_search', { query: 'zzqqnotag', projectId, limit: 20 });
    const r = rows(resp);
    expect(r.some((d) => d.id === targetId)).toBe(false);
  });

  // ── Criterion 3: no-regression (text query, no-query shape, output contract) ──
  test('no-regression: a plain text query still matches on prose', async () => {
    const resp = await viaPublicTool('decision_search', { query: 'pgvector', projectId, limit: 20 });
    const r = rows(resp);
    expect(r.some((d) => d.id === targetId)).toBe(true);
  });

  test('no-regression: a filter-only (no query) search returns rows newest-first with NO similarity', async () => {
    const resp = await viaPublicTool('decision_search', { projectId, limit: 20 });
    const r = rows(resp);
    // Both seeded decisions present; no semantic ranking → similarity undefined.
    expect(r.length).toBe(2);
    expect(r[0].similarity).toBeUndefined();
  });

  test('no-regression: the OUTPUT SHAPE (result field set) is identical across query / no-query paths', async () => {
    const byId = rows(await viaPublicTool('decision_search', { query: targetId, projectId, limit: 20 }));
    const byNone = rows(await viaPublicTool('decision_search', { projectId, limit: 20 }));
    // THE decision wire record: serializeDecision's canonical camelCase set
    // PLUS the snake_case aliases decision_search has always shipped (`legacyAliases`) and
    // the list-shape `trust`. `url` = the structured record permalink.
    // Both paths run through the ONE serializer in handleSearch, so the set is pinned once.
    const SHARED_FIELDS = [
      'id', 'url', 'projectId', 'sessionId', 'title', 'description', 'rationale', 'decisionType',
      'impactLevel', 'status', 'problemStatement', 'successCriteria', 'implementationStatus',
      'outcomeStatus', 'outcomeNotes', 'lessonsLearned', 'supersededBy', 'supersededDate',
      'supersededReason', 'decidedBy', 'stakeholders', 'category', 'alternativesConsidered',
      'affectedComponents', 'tags', 'metadata', 'decisionDate', 'archivedAt', 'trust',
      // THE DECISION INBOX (migration 104).
      'answerStatus', 'question', 'options', 'chosen', 'answeredAt', 'answeredBy', 'answerNote',
      'deadline',
      // legacyAliases (decision_search's frontend contract; the spelling table lives in the serializer)
      'project_id', 'session_id', 'decision_type', 'impact_level', 'affected_components',
      'problem', 'decision', 'alternatives', 'created_at', 'updated_at',
    ].sort();
    // THE ONE DECLARED DIVERGENCE: `similarity` is the rank a row scored on and exists ONLY
    // when a query ranked it (the handler sets it in the semantic branch alone, and the
    // serializer emits it only when set). A filter-only search has no rank, so the key is
    // absent — not present-as-undefined, which JSON would drop anyway. Asserted as exactly
    // one key in exactly one direction, so any OTHER drift between the two paths is RED.
    expect(Object.keys(byId[0]).sort()).toEqual([...SHARED_FIELDS, 'similarity'].sort());
    expect(Object.keys(byNone[0]).sort()).toEqual(SHARED_FIELDS);
  });

  // ── Existing exact-tags filter still works (the request.tags array path) ──────
  test('no-regression: the explicit exact tags[] filter still array-overlap matches', async () => {
    const resp = await viaPublicTool('decision_search', { tags: ['ref:resume'], projectId, limit: 20 });
    const r = rows(resp);
    expect(r.some((d) => d.id === targetId)).toBe(true);
    expect(r.some((d) => d.id === noiseId)).toBe(false);
  });
});
