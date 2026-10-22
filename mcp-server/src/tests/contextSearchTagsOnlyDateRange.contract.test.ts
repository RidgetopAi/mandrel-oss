/**
 * TAGS-ONLY `dateFrom` / `dateTo` — Contract Test
 *
 * THE BUG (measured against the live tool before the fix):
 *   context_search declares `dateFrom` / `dateTo` and runs in STRICT mode — an
 *   undeclared key is rejected outright — so a caller has every reason to believe a
 *   declared param is applied. On the SEMANTIC branch it was. On the TAGS-ONLY branch
 *   (`tags` present, no `query`) the WHERE clause was built from tags / archived_at /
 *   project_id / context_type only, and `dateFrom` was never read. The call
 *     { tags:["alert:urgent"], limit:40, dateFrom:"2030-01-01T00:00:00Z" }
 *   returned a full page of rows created years BEFORE that instant — accepted,
 *   validated, silently inert. The same call with `query` returned 0.
 *
 * `sessionId` was the SAME defect in the same branch, found by sweeping the declared
 * keyset against what that branch reads, and measured the same way: a tags-only call
 * naming one session returned rows belonging to every session.
 *
 * WHAT THIS GUARD PINS: the DOCUMENTED contract is true on BOTH branches — a
 * created_at range and a sessionId each narrow the tags-only page AND its `total`, and
 * the semantic branch is unchanged.
 *
 * POPULATION / SCOPE: this guard enumerates the two multi-row branches of
 * contextRoutes.handleSearch (semantic + tags-only) for the structured filters that
 * branch did not read — the created_at range and sessionId. The by-id branch is a
 * single explicit record fetch and is out of scope by construction (it ignores every
 * filter, including type and tags).
 *
 * Drives the REAL public tool path (zod validator -> contextRoutes.handleSearch -> real
 * migrated Postgres, a disposable ci_* DB) — the same idiom as
 * contextSearchTotalCount.contract.test.ts.
 *
 * WHY MOCK THE EMBEDDER: CI has no model download, and the semantic branch requires
 * `embedding IS NOT NULL`. A deterministic concept vector makes every seeded row a
 * candidate so the comparison between the two branches is apples-to-apples.
 *
 * Expected values below are written LITERALLY (never imported from the subject), so the
 * oracle cannot move with the code it judges.
 */

import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

const DIM = activeEmbedder().dimensions;

function conceptVector(text: string): number[] {
  const v = new Array(DIM).fill(0);
  if (` ${text.toLowerCase()} `.includes(' alertbeacon ')) v[0] = 1;
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
const PROJ_NAME = `tagsonly-daterange-${STAMP}`;
const TAG = `alertfuse-${STAMP}`;

// Seeded population, stated literally: 3 rows "now", 2 rows 100 days old.
// Of the 3 recent rows, 2 belong to session S and 1 has a NULL session; both old rows
// have a NULL session. So `sessionId: S` selects exactly 2 of the 5 tagged rows, and
// that 2 is DIFFERENT from every count the date cases assert — a sessionId predicate
// that silently did nothing could not hide behind another filter's number.
const RECENT_COUNT = 3;
const OLD_COUNT = 2;
const ALL_COUNT = 5;
const IN_SESSION_COUNT = 2;

// A `dateFrom` in the future can match NOTHING — the honest-zero probe. This is the
// exact shape that returned a full page before the fix.
const FUTURE = '2030-01-01T00:00:00Z';

let projectId: string;
let sessionId: string;

async function viaPublicTool(rawArgs: any) {
  const validated = validateToolArguments('context_search', rawArgs);
  return contextRoutes.handleSearch(validated);
}

const rows = (resp: any): any[] => resp?.structuredContent?.results ?? [];
const total = (resp: any): number => resp?.structuredContent?.total ?? 0;

async function seed(i: number, createdAtSql: string, session: string | null): Promise<void> {
  const content = `alertbeacon row ${i}`;
  await db.query(
    `INSERT INTO contexts (project_id, session_id, context_type, content, ${activeEmbeddingColumn()},
                           relevance_score, tags, created_at)
     VALUES ($1, $2, 'planning', $3, $4::vector, 5.0, $5, ${createdAtSql})`,
    [projectId, session, content, pgVec(content), [TAG]],
  );
}

describe('context_search created_at range applies on the TAGS-ONLY branch', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'tags-only dateFrom fuse') RETURNING id`,
      [PROJ_NAME],
    )).rows[0].id;

    sessionId = (await db.query(
      `INSERT INTO sessions (project_id, agent_type, display_id) VALUES ($1, 'test', $2) RETURNING id`,
      [projectId, `tod-${STAMP}`],
    )).rows[0].id;

    // 2 recent rows in session S, 1 recent row with no session, 2 old rows with no session.
    for (let i = 0; i < RECENT_COUNT; i++) {
      await seed(i, 'now()', i < IN_SESSION_COUNT ? sessionId : null);
    }
    for (let i = 0; i < OLD_COUNT; i++) await seed(100 + i, `now() - interval '100 days'`, null);
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── TAGS-ONLY branch (the defect) ────────────────────────────────────────────
  test('BASELINE: tags-only with no date range returns the whole tagged set', async () => {
    const resp = await viaPublicTool({ projectId, tags: [TAG], limit: 40 });
    expect(rows(resp).length).toBe(ALL_COUNT);
    expect(total(resp)).toBe(ALL_COUNT);
  });

  test('a FUTURE dateFrom returns ZERO rows on the tags-only branch', async () => {
    const resp = await viaPublicTool({ projectId, tags: [TAG], limit: 40, dateFrom: FUTURE });
    expect(rows(resp).length).toBe(0);
    expect(total(resp)).toBe(0);
    // The pre-fix behavior was the FULL page. Assert we are not that.
    expect(rows(resp).length).not.toBe(5);
  });

  test('dateFrom narrows the tags-only page AND its total to the recent rows', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const resp = await viaPublicTool({ projectId, tags: [TAG], limit: 40, dateFrom: tenDaysAgo });
    expect(rows(resp).length).toBe(3);
    expect(total(resp)).toBe(3);
  });

  test('dateTo narrows the tags-only page AND its total to the old rows', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const resp = await viaPublicTool({ projectId, tags: [TAG], limit: 40, dateTo: tenDaysAgo });
    expect(rows(resp).length).toBe(2);
    expect(total(resp)).toBe(2);
  });

  test('dateFrom + dateTo together bound the tags-only set from both ends', async () => {
    const from = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const resp = await viaPublicTool({ projectId, tags: [TAG], limit: 40, dateFrom: from, dateTo: to });
    expect(rows(resp).length).toBe(2); // only the 100-day-old rows fall inside
    expect(total(resp)).toBe(2);
  });

  // ── TAGS-ONLY branch, sessionId (the same defect, found by sweeping the keyset) ─
  test('sessionId narrows the tags-only page AND its total to that session', async () => {
    const resp = await viaPublicTool({ projectId, tags: [TAG], limit: 40, sessionId });
    expect(rows(resp).length).toBe(2);
    expect(total(resp)).toBe(2);
    // The pre-fix behavior was every tagged row regardless of session. Assert we are not that.
    expect(rows(resp).length).not.toBe(5);
    // And the rows returned really are the session's, not merely a count that matches.
    for (const r of rows(resp)) expect(r.sessionId).toBe(sessionId);
  });

  test('sessionId composes with dateFrom on the tags-only branch', async () => {
    // Both session rows are recent, so the date bound must not change the answer …
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const withinWindow = await viaPublicTool({ projectId, tags: [TAG], limit: 40, sessionId, dateFrom: tenDaysAgo });
    expect(rows(withinWindow).length).toBe(2);
    expect(total(withinWindow)).toBe(2);
    // … and a window that excludes them must return zero, not the session's whole set.
    const outsideWindow = await viaPublicTool({ projectId, tags: [TAG], limit: 40, sessionId, dateTo: tenDaysAgo });
    expect(rows(outsideWindow).length).toBe(0);
    expect(total(outsideWindow)).toBe(0);
  });

  // ── SEMANTIC branch (control: it already worked; prove it still does) ─────────
  test('CONTROL: the semantic branch still honors sessionId (unchanged)', async () => {
    const all = await viaPublicTool({ projectId, query: 'alertbeacon', limit: 40 });
    expect(rows(all).length).toBe(5);

    const scoped = await viaPublicTool({ projectId, query: 'alertbeacon', limit: 40, sessionId });
    expect(rows(scoped).length).toBe(2);
    for (const r of rows(scoped)) expect(r.sessionId).toBe(sessionId);
  });

  test('CONTROL: the semantic branch still honors dateFrom (unchanged)', async () => {
    const all = await viaPublicTool({ projectId, query: 'alertbeacon', limit: 40 });
    expect(rows(all).length).toBe(5);

    const future = await viaPublicTool({ projectId, query: 'alertbeacon', limit: 40, dateFrom: FUTURE });
    expect(rows(future).length).toBe(0);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const recent = await viaPublicTool({ projectId, query: 'alertbeacon', limit: 40, dateFrom: tenDaysAgo });
    expect(rows(recent).length).toBe(3);
  });
});
