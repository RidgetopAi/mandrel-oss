/**
 * TRUST MODEL v1 — integration + adversarial contract tests (Mandrel Core Redesign T2b,
 * an earlier task). THE MOAT, surfaced default-on in recall.
 *
 * Tests are armor (spec §6). The pure math is covered by trustModel.unit.test.ts; THIS
 * suite drives the REAL recall tools through validate → routeExecutor (the EXACT path the
 * HTTP bridge uses) against the CI Postgres, and asserts:
 *   - context_search / context_get_recent / decision_search each return a WELL-FORMED
 *     trust object on every result row (default-on, structuredContent + text hint),
 *   - the moat path works end-to-end: a context that `informs` a SUCCESSFUL decision
 *     earns a high outcome score; a FAILED downstream sinks it,
 *   - ADVERSARIAL (the spec's hostile cases):
 *       · a record whose ONLY downstream outcome is too_early → `unproven`, NOT failed,
 *       · a SUPERSEDED decision → abstain even WITH good outcomes,
 *       · a record with NO edges → `unproven` (cold-start, not distrusted).
 *
 * Embedding service mocked → deterministic + offline (mirrors typedEdges.contract).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { trustForRecord } from '../services/trust.js';

const STAMP = Date.now();
const CONN = `trust-conn-${STAMP}`;
const PROJ_NAME = `trust-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/**
 * Assert the shape of a trust object ON THE WIRE — band + score, and NOTHING ELSE.
 *
 * REWRITTEN by SEARCH P3. This used to assert the whole
 * computed verdict (outcome{}, freshness, superseded, abstain …) because that whole verdict
 * WAS the wire shape. It no longer is: the wire carries the two fields a caller needs to
 * decide what to open, and a consumer that wants the rest fetches the record by id.
 *
 * It asserts ABSENCE as well as presence, deliberately. A shape guard that only checks the
 * keys it wants is an allow-list: it would stay green if the dropped blob came back, which is
 * the regression this decision exists to prevent. The dropped set is spelled out so a
 * re-added field names itself in the failure.
 */
const TRUST_FIELDS_DROPPED_FROM_THE_WIRE = [
  'outcome',
  'freshness',
  'superseded',
  'softSuperseded',
  'abstain',
  'supersession',
  'reason',
  'promotionRequirement',
] as const;

function assertWellFormedTrust(trust: any) {
  expect(trust, 'trust object present').toBeTruthy();
  expect(typeof trust.band).toBe('string');
  expect(['trusted', 'ok', 'unproven', 'stale', 'superseded', 'contradicted']).toContain(trust.band);
  // score is a number or null (null only at cold-start outcome; the blended score is set).
  expect(trust.score === null || typeof trust.score === 'number').toBe(true);
  for (const f of TRUST_FIELDS_DROPPED_FROM_THE_WIRE) {
    expect(trust, `trust.${f} must NOT ship on the wire`).not.toHaveProperty(f);
  }
  expect(Object.keys(trust).sort()).toEqual(['band', 'score']);
}

/**
 * THE FULL COMPUTED VERDICT, read from the service rather than the wire.
 *
 * The trust MATH is unchanged by SEARCH P3 — only its wire projection shrank. So the math
 * assertions below moved here: they exercise services/trust.ts directly, which is where the
 * behaviour they are about actually lives, and they are no longer coupled to how much of it a
 * search row happens to carry.
 */
async function fullTrust(id: string, type: 'context' | 'decision' | 'task') {
  return trustForRecord({ id, type });
}

describe('trust model (T2b) — surfaced default-on in recall', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'trust contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  // ── DEFAULT-ON shape on all three recall tools ──────────────────────────────
  test('context_search returns a well-formed trust object on every row (default-on)', async () => {
    await viaTool('context_store', { content: 'searchable trust row', type: 'planning' });
    const resp = await viaTool('context_search', { query: 'searchable trust row' });
    expect(resp.structuredContent.results.length).toBeGreaterThan(0);
    for (const row of resp.structuredContent.results) assertWellFormedTrust(row.trust);
    // The machine-lean signal rides the text channel too (WS1 an earlier task).
    expect(responseText(resp)).toMatch(/trust:[a-z-]+ score:/);
  });

  test('context_get_recent returns a well-formed trust object on every row (default-on, boot path)', async () => {
    await viaTool('context_store', { content: 'recent trust row', type: 'milestone' });
    const resp = await viaTool('context_get_recent', { limit: 5 });
    expect(resp.structuredContent.results.length).toBeGreaterThan(0);
    for (const row of resp.structuredContent.results) assertWellFormedTrust(row.trust);
    expect(responseText(resp)).toMatch(/trust:[a-z-]+ score:/);
  });

  test('decision_search returns a well-formed trust object on every row (default-on)', async () => {
    await viaTool('decision_record', {
      decisionType: 'architecture', title: 'trust-search decision', description: 'd',
      rationale: 'r', impactLevel: 'medium',
    });
    const resp = await viaTool('decision_search', { query: 'trust-search decision' });
    // decision_search uses `data` → promoted to structuredContent by the route executor.
    const rows = resp.structuredContent.results;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) assertWellFormedTrust(row.trust);
    expect(responseText(resp)).toMatch(/trust:[a-z-]+ score:/);
  });

  // ── THE MOAT: outcome propagates along edges ────────────────────────────────
  test('a context informing a SUCCESSFUL decision earns outcome evidence (the moat path)', async () => {
    // A decision scored successful by the loop.
    const decResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'the successful decision', description: 'd',
      rationale: 'r', impactLevel: 'high', outcomeStatus: 'successful',
    });
    const decId = decResp.structuredContent.decision.id;

    // A context that `decided_by` that decision (auto-mints a decided_by edge — an outcome
    // edge type) → it inherits the decision's successful outcome.
    const ctxResp = await viaTool('context_store', {
      content: 'context that laddered up to the successful decision',
      type: 'discussion',
      tags: [`decision:${id8(decId)}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const search = await viaTool('context_search', { query: 'laddered up to the successful decision' });
    const row = search.structuredContent.results.find((r: any) => r.id === ctxId);
    expect(row, 'the context is in the results').toBeTruthy();
    assertWellFormedTrust(row.trust);
    // THE MATH, read from the service (the wire carries band+score only since 014edd48):
    // counted outcome evidence (the successful decision) → outcome.score = 1, samples ≥ 1.
    const t = await fullTrust(ctxId, 'context');
    expect(t.outcome.samples).toBeGreaterThanOrEqual(1);
    expect(t.outcome.score).toBe(1);
    expect(t.abstain).toBe(false);
    // With a successful outcome + (fresh) it should be trusted — and the WIRE says so too.
    expect(row.trust.band).toBe('trusted');
    expect(t.band).toBe('trusted');
  });

  test('a context informing a FAILED decision sinks its outcome score', async () => {
    const decResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'the failed decision', description: 'd',
      rationale: 'r', impactLevel: 'high', outcomeStatus: 'failed',
    });
    const decId = decResp.structuredContent.decision.id;
    const ctxResp = await viaTool('context_store', {
      content: 'context tied to the failed decision', type: 'discussion',
      tags: [`decision:${id8(decId)}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const search = await viaTool('context_search', { query: 'context tied to the failed decision' });
    const row = search.structuredContent.results.find((r: any) => r.id === ctxId);
    expect(row).toBeTruthy();
    const t = await fullTrust(ctxId, 'context');
    expect(t.outcome.samples).toBeGreaterThanOrEqual(1);
    expect(t.outcome.score).toBe(0); // failed → 0
    // Failed outcome → low blended score → abstain.
    expect(t.abstain).toBe(true);
  });

  // ── ADVERSARIAL ─────────────────────────────────────────────────────────────
  test('adversarial: a record whose ONLY downstream outcome is too_early → unproven, NOT failed', async () => {
    const decResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'a too-early decision', description: 'd',
      rationale: 'r', impactLevel: 'low', outcomeStatus: 'too_early',
    });
    const decId = decResp.structuredContent.decision.id;
    const ctxResp = await viaTool('context_store', {
      content: 'context tied only to a too-early decision', type: 'discussion',
      tags: [`decision:${id8(decId)}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const search = await viaTool('context_search', { query: 'context tied only to a too-early decision' });
    const row = search.structuredContent.results.find((r: any) => r.id === ctxId);
    expect(row).toBeTruthy();
    // too_early is IGNORED → 0 counted outcomes → cold-start.
    const t = await fullTrust(ctxId, 'context');
    expect(t.outcome.samples).toBe(0);
    expect(t.outcome.score).toBeNull();
    expect(t.abstain).toBe(false); // fresh → not distrusted
    expect(row.trust.band).toBe('unproven'); // crucially NOT a failed/low band
  });

  test('adversarial: a SUPERSEDED decision abstains even WITH a good outcome', async () => {
    // The decision being superseded — give it a SUCCESSFUL outcome so only supersession
    // can drive the abstain.
    const oldResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'the superseded-but-successful decision', description: 'd',
      rationale: 'r', impactLevel: 'high', outcomeStatus: 'successful',
    });
    const oldId = oldResp.structuredContent.decision.id;
    // A newer decision that supersedes it (auto-mints a supersedes edge → reverse-points at old).
    const newResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'the replacement decision', description: 'd',
      rationale: 'r', impactLevel: 'high',
    });
    const newId = newResp.structuredContent.decision.id;
    await viaTool('decision_update', { decisionId: newId, supersededBy: oldId, status: 'superseded' });

    const search = await viaTool('decision_search', { query: 'the superseded-but-successful decision' });
    const row = search.structuredContent.results.find((r: any) => r.id === oldId);
    expect(row, 'the superseded decision is in the results').toBeTruthy();
    assertWellFormedTrust(row.trust);
    const t = await fullTrust(oldId, 'decision');
    expect(t.superseded).toBe(true);
    expect(t.abstain).toBe(true); // abstain DESPITE the successful outcome
    expect(row.trust.band).toBe('superseded'); // override caps the band, ON THE WIRE
  });

  test('adversarial: a record with NO edges → unproven (cold-start, not distrusted)', async () => {
    const ctxResp = await viaTool('context_store', {
      content: 'a lonely context with no edges at all', type: 'planning',
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const search = await viaTool('context_search', { query: 'a lonely context with no edges at all' });
    const row = search.structuredContent.results.find((r: any) => r.id === ctxId);
    expect(row).toBeTruthy();
    const t = await fullTrust(ctxId, 'context');
    expect(t.outcome.samples).toBe(0);
    expect(t.outcome.score).toBeNull();
    expect(t.superseded).toBe(false);
    expect(t.abstain).toBe(false); // freshly stored → fresh → lean on freshness
    expect(row.trust.band).toBe('unproven'); // cold-start — NOT distrusted
  });
});
