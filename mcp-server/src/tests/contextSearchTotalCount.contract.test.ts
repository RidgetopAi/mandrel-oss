/**
 * CONTEXT SEARCH `total` = REAL match count — Contract Test
 *
 * The bug (the sibling of the decision_search total==page bug): context_search returned
 * `data.total = results.length` — but `results` is the PAGINATED page (capped by LIMIT),
 * so `total` silently maxed out at the page size. An offset-paginating caller reasoning
 * about "how many matched" was lied to the moment the match set exceeded one page.
 *
 * context_search has TWO multi-row branches, BOTH fixed here (same tool, same class —
 * A past incident):
 *   • SEMANTIC branch (query present): the query RANKS an embedded-candidate set; `total`
 *     is now contextHandler.countContext() — a COUNT(*) over the SAME hard filters
 *     (project/type/session/date/tags + `embedding IS NOT NULL`), NO LIMIT — built through
 *     the SHARED buildContextSearchFilters() the page query uses, so it can't drift.
 *   • TAGS-ONLY branch (tags, no query): `total` is now a COUNT(*) over the SAME
 *     `tags && … [+ project/type/archived]` WHERE the page is drawn from, NO LIMIT.
 *
 * Drives the REAL public tool path (zod validator → contextRoutes.handleSearch → real
 * migrated Postgres, the disposable ci_* DB from scripts/provision-test-db.sh — never
 * production), the same idiom as decisionSearchTotalCount / searchConsolidation.
 *
 * WHY MOCK THE EMBEDDER: CI has no model download. A deterministic CONCEPT embedder gives
 * every seeded row + the query a valid active-dimensional vector (the semantic branch requires
 * `embedding IS NOT NULL`), so the candidate set = the seeded rows and counts are exact.
 * The query has NO SQL similarity threshold — it only RANKS — so every embedded row in
 * the project passing the hard filters is a candidate (exactly what `total` counts), which
 * is what a paginating caller pages through.
 *
 * WHAT THIS PROVES (both branches):
 *   1. total > page — with MORE matches than one page, `total` = the FULL match count and
 *      the page length = `limit` (total strictly greater than the returned page).
 *   2. total is independent of the page size — same filter, different limits, same total.
 *   3. total tracks the FILTER, not the page size — a filtered subset returns that
 *      subset's real count, independent of `limit`.
 *   4. zero-match still returns total: 0.
 */

import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

// DERIVED from the active embedder (never hardcoded 1536) — same test runs under either geometry.
const DIM = activeEmbedder().dimensions;

// Deterministic concept embedder (dim 0 = "workspace" concept). Every seeded row + the
// query hit the same concept, so all seeded rows are valid embedded candidates. The exact
// direction is irrelevant to the COUNT — only `embedding IS NOT NULL` + the hard filters
// matter — but a shared concept keeps the ranking well-defined.
function conceptVector(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const lower = ` ${text.toLowerCase()} `;
  if ([' workspace ', ' panes ', ' sweep ', ' context '].some((w) => lower.includes(w))) v[0] = 1;
  v[DIM - 1] = 0.001; // keep a no-concept vector normalizable/non-zero
  return v;
}
function pgVec(text: string): string {
  return `[${conceptVector(text).join(',')}]`;
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
import { activeEmbedder, activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { contextRoutes } from '../routes/context.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `context-total-count-${STAMP}`;
const TAG = `sweeptag-${STAMP}`;

// Two disjoint groups (by context_type) so a type filter hits a subset with a known count.
const GROUP_PLANNING = 7; // context_type 'planning'
const GROUP_CODE = 2;     // context_type 'code'
const TOTAL = GROUP_PLANNING + GROUP_CODE; // 9

let projectId: string;

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(rawArgs: any) {
  const validated = validateToolArguments('context_search', rawArgs);
  return contextRoutes.handleSearch(validated);
}

const rows = (resp: any): any[] => resp?.structuredContent?.results ?? [];
const total = (resp: any): number => resp?.structuredContent?.total;

async function seed(type: string, i: number): Promise<void> {
  const content = `workspace sweep context ${type} ${i}`;
  await db.query(
    `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()}, relevance_score, tags)
     VALUES ($1, $2, $3, $4::vector, 5.0, $5)`,
    [projectId, type, content, pgVec(content), [TAG]],
  );
}

describe('context_search total = real match count', () => {
  beforeAll(async () => {

    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'context total-count fuse') RETURNING id`,
      [PROJ_NAME],
    )).rows[0].id;

    for (let i = 0; i < GROUP_PLANNING; i++) await seed('planning', i);
    for (let i = 0; i < GROUP_CODE; i++) await seed('code', i);
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── SEMANTIC branch (query present) ──────────────────────────────────────────
  describe('semantic branch (query)', () => {
    test('total = FULL match count while the page is capped at limit (total > page length)', async () => {
      const limit = 3;
      const resp = await viaPublicTool({ projectId, query: 'workspace', limit });
      expect(rows(resp).length).toBe(limit);        // page capped at limit …
      expect(total(resp)).toBe(TOTAL);               // … but total is the REAL count (9)
      expect(total(resp)).toBeGreaterThan(rows(resp).length);
      // The OLD bug returned total = results.length = limit; assert we are NOT that.
      expect(total(resp)).not.toBe(limit);
    });

    test('total is independent of the page size — same filter, different limits, same total', async () => {
      const a = await viaPublicTool({ projectId, query: 'workspace', limit: 1 });
      const b = await viaPublicTool({ projectId, query: 'workspace', limit: 100 });
      expect(rows(a).length).toBe(1);
      expect(rows(b).length).toBe(TOTAL); // fewer than limit → full page
      expect(total(a)).toBe(TOTAL);
      expect(total(b)).toBe(TOTAL);
    });

    test('a type filter returns that subset\'s real count, independent of limit', async () => {
      const resp = await viaPublicTool({ projectId, query: 'workspace', type: 'planning', limit: 2 });
      expect(rows(resp).length).toBe(2);        // page capped
      expect(total(resp)).toBe(GROUP_PLANNING);  // real subset count (7), not the page (2)
      expect(total(resp)).toBeGreaterThan(rows(resp).length);
    });

    test('a filter matching nothing returns an empty page and total: 0', async () => {
      // 'error' type has zero seeded rows → the candidate set is empty.
      const resp = await viaPublicTool({ projectId, query: 'workspace', type: 'error', limit: 5 });
      expect(rows(resp).length).toBe(0);
      expect(total(resp)).toBe(0);
    });
  });

  // ── TAGS-ONLY branch (tags, no query) ────────────────────────────────────────
  describe('tags-only branch (tags, no query)', () => {
    test('total = FULL match count while the page is capped at limit (total > page length)', async () => {
      const limit = 4;
      const resp = await viaPublicTool({ projectId, tags: [TAG], limit });
      expect(rows(resp).length).toBe(limit);
      expect(total(resp)).toBe(TOTAL);
      expect(total(resp)).toBeGreaterThan(rows(resp).length);
      expect(total(resp)).not.toBe(limit);
    });

    test('total is independent of the page size — same tag filter, different limits, same total', async () => {
      const a = await viaPublicTool({ projectId, tags: [TAG], limit: 1 });
      const b = await viaPublicTool({ projectId, tags: [TAG], limit: 100 });
      expect(rows(a).length).toBe(1);
      expect(rows(b).length).toBe(TOTAL);
      expect(total(a)).toBe(TOTAL);
      expect(total(b)).toBe(TOTAL);
    });

    test('a type filter on the tags-only path returns that subset\'s real count', async () => {
      const resp = await viaPublicTool({ projectId, tags: [TAG], type: 'code', limit: 1 });
      expect(rows(resp).length).toBe(1);       // page capped
      expect(total(resp)).toBe(GROUP_CODE);     // real subset count (2), not the page (1)
      expect(total(resp)).toBeGreaterThan(rows(resp).length);
    });

    test('a tag matching nothing returns an empty page and total: 0', async () => {
      const resp = await viaPublicTool({ projectId, tags: [`no-such-tag-${STAMP}`], limit: 5 });
      expect(rows(resp).length).toBe(0);
      expect(total(resp)).toBe(0);
    });
  });
});
