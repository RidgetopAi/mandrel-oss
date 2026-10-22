/**
 * DECISION SEARCH `total` = REAL match count — Contract Test
 *
 * The bug: decision_search returned `data.total = decisions.length` — but `decisions` is
 * the PAGINATED page (capped by LIMIT), so `total` silently maxed out at the page size.
 * A UI paginating on `total` (or any caller reasoning about "how many matched") was lied
 * to the moment the match set exceeded one page.
 *
 * The fix: the route surfaces `total` from decisionsHandler.countDecisions(), a COUNT(*)
 * over the SAME WHERE/filter set as the page — with NO LIMIT — built through the SHARED
 * buildDecisionFilterQuery() so the count can never drift from the page (one
 * filter clause, not two drifting copies).
 *
 * Drives the REAL public tool path (zod validator → decisionsRoutes.handleSearch → real
 * migrated Postgres, the disposable ci_* DB from scripts/provision-test-db.sh — never
 * production), the same idiom as decisionSearchIdTagLookup.contract.test.ts. Embeddings
 * are NULLed on the seeded rows so the semantic/query path is deterministic (a row
 * surfaces only via its text/id/tag signal, the legacy-row gate), which lets us assert
 * exact counts on both the filter-only and the query (semantic-branch) paths.
 *
 * WHAT THIS PROVES:
 *   1. total > page — with MORE matches than one page, `total` = the FULL match count and
 *      the page array length = `limit` (total strictly greater than the returned page).
 *   2. total tracks the FILTER, not the page size — a filtered subset returns that
 *      subset's real count, independent of `limit`.
 *   3. semantic/query branch — the COUNT-wrapped filtered query (with its extra bound
 *      params) counts the real match set, not the page.
 *   4. zero-match still returns total: 0.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';

import { db } from '../config/database.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `decision-total-count-${STAMP}`;

// Two disjoint groups so a query token hits exactly one group with zero trigram overlap
// with the other (deterministic counts, no word_similarity false-positives across groups).
const GROUP_A = 5; // decision_type 'pattern', prose token 'quantumfoo'
const GROUP_B = 2; // decision_type 'database', prose token 'sunsetzzz'
const TOTAL = GROUP_A + GROUP_B; // 7

let projectId: string;

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(toolName: string, rawArgs: any) {
  const validated = validateToolArguments(toolName, rawArgs);
  return decisionsRoutes.handleSearch(validated);
}

const rows = (resp: any): any[] => resp?.data?.results ?? [];
const total = (resp: any): number => resp?.data?.total;

describe('decision_search total = real match count', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'total-count fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;

    for (let i = 0; i < GROUP_A; i++) {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level)
         VALUES ($1,'pattern',$2,'alpha body','alpha rationale','medium')`,
        [projectId, `alpha quantumfoo ${i}`]
      );
    }
    for (let i = 0; i < GROUP_B; i++) {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level)
         VALUES ($1,'database',$2,'beta body','beta rationale','medium')`,
        [projectId, `beta sunsetzzz ${i}`]
      );
    }

    // Deterministic gate: NULL embeddings so the query path surfaces rows ONLY via their
    // text/id/tag signal (no "every row has an embedding" admit), making counts exact.
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

  // ── Criterion 1: total > page (the actual bug) ───────────────────────────────
  test('total = FULL match count while the page is capped at limit (total > page length)', async () => {
    const limit = 3;
    const resp = await viaPublicTool('decision_search', { projectId, limit });
    // Page is capped at `limit` …
    expect(rows(resp).length).toBe(limit);
    // … but total is the REAL count of ALL matching decisions, NOT the page size.
    expect(total(resp)).toBe(TOTAL);
    // The regression guard: total must exceed the returned page when more rows match.
    expect(total(resp)).toBeGreaterThan(rows(resp).length);
    // The OLD bug returned total = decisions.length = limit; assert we are NOT that.
    expect(total(resp)).not.toBe(limit);
  });

  test('total is independent of the page size — same filter, different limits, same total', async () => {
    const a = await viaPublicTool('decision_search', { projectId, limit: 1 });
    const b = await viaPublicTool('decision_search', { projectId, limit: 100 });
    expect(rows(a).length).toBe(1);
    expect(rows(b).length).toBe(TOTAL); // fewer than limit → full set
    expect(total(a)).toBe(TOTAL);
    expect(total(b)).toBe(TOTAL);
  });

  // ── Criterion 2: total tracks the FILTER, not the page ───────────────────────
  test('a decisionType filter returns that subset\'s real count, independent of limit', async () => {
    const resp = await viaPublicTool('decision_search', { projectId, decisionType: 'pattern', limit: 2 });
    expect(rows(resp).length).toBe(2);       // page capped
    expect(total(resp)).toBe(GROUP_A);        // real subset count (5), not the page (2)
    expect(total(resp)).toBeGreaterThan(rows(resp).length);
  });

  // ── Criterion 3: semantic/query branch counts the real match set ─────────────
  test('a free-text query counts ALL matching rows (semantic branch), not the page', async () => {
    const resp = await viaPublicTool('decision_search', { projectId, query: 'quantumfoo', limit: 2 });
    expect(rows(resp).length).toBe(2);        // page capped at limit
    expect(total(resp)).toBe(GROUP_A);         // all 5 'quantumfoo' rows counted
    // And the query genuinely filtered — the disjoint group is excluded from the count.
    const other = await viaPublicTool('decision_search', { projectId, query: 'sunsetzzz', limit: 50 });
    expect(total(other)).toBe(GROUP_B);
  });

  // ── Criterion 4: zero-match still returns total: 0 ───────────────────────────
  test('a query matching nothing returns an empty page and total: 0', async () => {
    const resp = await viaPublicTool('decision_search', { projectId, query: 'nevermatchxyz123', limit: 5 });
    expect(rows(resp).length).toBe(0);
    expect(total(resp)).toBe(0);
  });
});
