/**
 * Decision Learning-Loop READ-PATH Contract Test (an earlier task — the moat-critical
 * READ path that unblocks the GAP1 Evaluator)
 *
 * Drives the REAL public tool path (zod validator → route handler → real migrated
 * Postgres, the disposable ci_* DB from the CI gate — never production), same idiom
 * as decisionLearningLoop.contract.test.ts. Embeddings are NOT stubbed; CI falls back
 * to the deterministic mock embedding and these reads use exact-title queries / filter-
 * only searches, so every DB read/write is real.
 *
 * WHAT THIS PROVES (the four part-fixes of an earlier task):
 *
 *  PART 1 — decision_search.outcomeStatus filters the OUTCOME column (not lifecycle):
 *    Two decisions with the SAME lifecycle status but DIFFERENT outcome_status; a
 *    search filtered by outcomeStatus:'failed' returns ONLY the failed one. Proven
 *    end-to-end through validate→route→handler→SQL (the routeContractDrift style).
 *
 *  PART 2 — outcome fields appear in the RENDERED TEXT of decision_search results:
 *    The human-readable content (not just the structured `data`) shows outcome_status
 *    + lessons, so a tool-only agent reading prose is no longer blind to them. A guard
 *    asserts the text contains them so it can't silently regress to data-only.
 *
 *  PART 3 — includeOutcome string→bool coercion:
 *    includeOutcome:"true" (string) is ACCEPTED and behaves as true; "false" as false;
 *    a real boolean still works; and the non-empty-string-"false"-is-truthy trap is
 *    NOT present (z.coerce.boolean would have failed this).
 *
 *  PART 4 — decision_get (single decision by id, full detail):
 *    Returns the outcome fields for a known decision, and an ACTIONABLE not-found error
 *    (mentioning the id may be wrong / a short id) for a bad-but-valid UUID.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const PROJ_NAME = `decision-read-path-${STAMP}`;

// ONE CONNECTION, BOUND TO THIS FILE'S PROJECT. `decision_record` and
// `decision_search` take an explicit `projectId`; `decision_update` and `decision_get` do
// NOT, so they resolved their project from the ambient ladder — whose last rung is
// `projects[0] ORDER BY updated_at DESC`, i.e. whichever project this DATABASE touched
// most recently. Every assertion in this file is about rows in PROJ_NAME, so the
// connection says so instead of letting row ordering answer.
const CONN = `decision-read-path-conn-${STAMP}`;
const CTX = { connectionId: CONN };
const FAILED_TITLE = `Adopt flaky-cache layer ${STAMP}`;
const OK_TITLE = `Adopt pgvector read-path ${STAMP}`;

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

function idFromRecordText(text: string): string {
  const m = text.match(/\bID:\s*([0-9a-f-]{36})/i);
  expect(m, 'record response must include the decision UUID').toBeTruthy();
  return m![1];
}

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(
  toolName: string,
  rawArgs: any,
  handler: (a: any, ctx: typeof CTX) => Promise<any>,
) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated, CTX);
}

let failedId: string;
let okId: string;

describe('decision learning-loop READ path (outcomeStatus filter, text render, coercion, decision_get)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'decision read-path fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    await bindConnectionToProject(CONN, PROJ_NAME);

    // Two decisions, recorded + evaluated entirely through the public tools.
    // Both keep the DEFAULT lifecycle status ('active') but get DIFFERENT outcomes,
    // so an outcomeStatus filter must discriminate on the outcome_status column alone.
    const recFailed = await viaPublicTool('decision_record', {
      decisionType: 'performance',
      title: FAILED_TITLE,
      description: 'Add an in-memory cache layer in front of the API',
      rationale: 'Hoped to cut p95 latency',
      impactLevel: 'medium',
      successCriteria: 'p95 < 100ms with no correctness regressions',
      projectId,
    }, (a, c) => decisionsRoutes.handleRecord(a, c));
    failedId = idFromRecordText(textOf(recFailed));

    const recOk = await viaPublicTool('decision_record', {
      decisionType: 'database',
      title: OK_TITLE,
      description: 'Use pgvector for the read path',
      rationale: 'Keep everything in Postgres',
      impactLevel: 'high',
      successCriteria: 'recall@10 >= 0.8',
      projectId,
    }, (a, c) => decisionsRoutes.handleRecord(a, c));
    okId = idFromRecordText(textOf(recOk));

    // Close the loop with DIFFERENT outcomes (via the public update tool).
    await viaPublicTool('decision_update', {
      decisionId: failedId,
      outcomeStatus: 'failed',
      outcomeNotes: 'cache caused stale reads; rolled back',
      lessonsLearned: 'cache invalidation was harder than the latency win',
      implementationStatus: 'deprecated',
    }, (a, c) => decisionsRoutes.handleUpdate(a, c));

    await viaPublicTool('decision_update', {
      decisionId: okId,
      outcomeStatus: 'successful',
      outcomeNotes: 'recall@10 measured 0.86',
      lessonsLearned: 'pgvector was sufficient',
      implementationStatus: 'validated',
    }, (a, c) => decisionsRoutes.handleUpdate(a, c));
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── PART 1 ─────────────────────────────────────────────────────────────────
  test('PART 1: outcomeStatus filters the outcome_status column (NOT lifecycle status)', async () => {
    // Sanity: both rows share the SAME lifecycle status, so a `status` filter could not
    // tell them apart — only outcome_status can.
    const both = await viaPublicTool('decision_search',
      { projectId, limit: 50 },
      (a, c) => decisionsRoutes.handleSearch(a, c));
    const bothResults = (both as any).data?.results ?? [];
    const failedRow = bothResults.find((r: any) => r.id === failedId);
    const okRow = bothResults.find((r: any) => r.id === okId);
    expect(failedRow, 'failed decision present').toBeTruthy();
    expect(okRow, 'successful decision present').toBeTruthy();
    expect(failedRow.status).toBe(okRow.status); // same lifecycle status

    // Filter by outcomeStatus:'failed' → ONLY the failed one in THIS project.
    const failedSearch = await viaPublicTool('decision_search',
      { projectId, outcomeStatus: 'failed', limit: 50 },
      (a, c) => decisionsRoutes.handleSearch(a, c));
    const failedIds = ((failedSearch as any).data?.results ?? []).map((r: any) => r.id);
    expect(failedIds).toContain(failedId);
    expect(failedIds).not.toContain(okId);

    // And outcomeStatus:'successful' → ONLY the successful one.
    const okSearch = await viaPublicTool('decision_search',
      { projectId, outcomeStatus: 'successful', limit: 50 },
      (a, c) => decisionsRoutes.handleSearch(a, c));
    const okIds = ((okSearch as any).data?.results ?? []).map((r: any) => r.id);
    expect(okIds).toContain(okId);
    expect(okIds).not.toContain(failedId);
  });

  test('PART 1b: a bogus outcomeStatus enum is REJECTED at the validator', () => {
    expect(() => validateToolArguments('decision_search', {
      outcomeStatus: 'totally-made-up',
    })).toThrow(/outcomeStatus/i);
  });

  // ── PART 2 ─────────────────────────────────────────────────────────────────
  test('PART 2: outcome fields appear in the RENDERED TEXT of decision_search (not data-only)', async () => {
    const resp = await viaPublicTool('decision_search',
      { projectId, outcomeStatus: 'failed', limit: 50 },
      (a, c) => decisionsRoutes.handleSearch(a, c));
    const text = textOf(resp);
    // The moat assertion: a tool-only agent reads PROSE — the outcome must be there.
    expect(text).toMatch(/Outcome:\s*failed/i);
    expect(text).toContain('cache invalidation was harder'); // lessonsLearned in text
    expect(text).toMatch(/Implementation:\s*deprecated/i);
  });

  // ── PART 3 ─────────────────────────────────────────────────────────────────
  test('PART 3: includeOutcome:"true" (string) is accepted and coerces to true', () => {
    const v = validateToolArguments('decision_search', { includeOutcome: 'true' }) as any;
    expect(v.includeOutcome).toBe(true);
  });

  test('PART 3: includeOutcome:"false" (non-empty string) coerces to FALSE (not truthy)', () => {
    const v = validateToolArguments('decision_search', { includeOutcome: 'false' }) as any;
    // This is the trap z.coerce.boolean() falls into (non-empty string -> true).
    expect(v.includeOutcome).toBe(false);
  });

  test('PART 3: real booleans and "1"/"0" still work; garbage is rejected', () => {
    expect((validateToolArguments('decision_search', { includeOutcome: true }) as any).includeOutcome).toBe(true);
    expect((validateToolArguments('decision_search', { includeOutcome: false }) as any).includeOutcome).toBe(false);
    expect((validateToolArguments('decision_search', { includeOutcome: '1' }) as any).includeOutcome).toBe(true);
    expect((validateToolArguments('decision_search', { includeOutcome: '0' }) as any).includeOutcome).toBe(false);
    expect(() => validateToolArguments('decision_search', { includeOutcome: 'maybe' })).toThrow(/includeOutcome/i);
  });

  test('PART 3: a string includeOutcome no longer breaks the live search path', async () => {
    // The exact rejection the task describes ("Expected boolean, received string") would
    // have thrown at validateToolArguments; prove the whole path runs green now.
    const resp = await viaPublicTool('decision_search',
      { projectId, query: OK_TITLE, includeOutcome: 'true' },
      (a, c) => decisionsRoutes.handleSearch(a, c));
    const ids = ((resp as any).data?.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(okId);
  });

  // ── PART 4 ─────────────────────────────────────────────────────────────────
  test('PART 4: decision_get returns full detail incl. outcome fields for a known id', async () => {
    const resp = await viaPublicTool('decision_get',
      { decisionId: failedId, projectId },
      (a, c) => decisionsRoutes.handleGet(a, c));

    // Structured data round-trips every learning-loop field.
    const d = (resp as any).data?.decision;
    expect((resp as any).data?.found).toBe(true);
    expect(d.id).toBe(failedId);
    expect(d.outcomeStatus).toBe('failed');
    expect(d.outcomeNotes).toContain('stale reads');
    expect(d.lessonsLearned).toContain('cache invalidation');
    expect(d.implementationStatus).toBe('deprecated');
    expect(d.successCriteria).toContain('p95 < 100ms');

    // And the RENDERED TEXT shows the outcome (part-2 idiom reused in decision_get).
    const text = textOf(resp);
    // WS1: the banner line is gone — the detail block opens with the id line.
    expect(text).toMatch(/^ID: [0-9a-f-]{36}/);
    expect(text).toMatch(/Outcome:\s*failed/i);
    expect(text).toContain('cache invalidation was harder');
  });

  test('PART 4: decision_get returns an ACTIONABLE not-found error for a bad UUID', async () => {
    const resp = await viaPublicTool('decision_get',
      { decisionId: '00000000-0000-0000-0000-000000000000' },
      (a, c) => decisionsRoutes.handleGet(a, c));
    expect((resp as any).data?.found).toBe(false);
    const text = textOf(resp);
    expect(text).toContain('not found');
    // Actionable: must hint at WHAT went wrong (wrong id / short id / use full UUID).
    expect(text).toMatch(/short id|full UUID/i);
  });

  test('PART 4: decision_get REJECTS a non-UUID id at the validator', () => {
    expect(() => validateToolArguments('decision_get', { decisionId: 'abc123' }))
      .toThrow(/decisionId/i);
  });
});
