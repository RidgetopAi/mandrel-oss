/**
 * TRUST EXPLAINABILITY, END-TO-END on all FOUR render surfaces.
 *
 * The source guard (trustExplainSingleRenderer.contract.test.ts) proves nobody re-implements
 * the hint; THIS suite proves what an agent actually READS. It drives the REAL tools through
 * validate → routeExecutor (the exact path the HTTP bridge uses) against the CI Postgres and
 * asserts, on each of the four surfaces:
 *   - context_search / context_get_recent  (routes/context.routes.ts)
 *   - decision_search                      (routes/decisions.routes.ts)
 *   - smart_search                         (routes/search.routes.ts — the TRUNCATED copy)
 *   - recall_thread                        (routes/recall.routes.ts — the copy that had lost
 *                                            the explanation AND the score entirely)
 * that a freshly-stored record renders `🌱 unproven` WITH the reason, the evidence count,
 * and (on the per-record surfaces) what would promote it.
 *
 * ⚠️ THE STRUCTURED HALF OF THIS CLAIM WAS RETIRED by SEARCH P3.
 * structuredContent used to carry `reason` + `promotionRequirement` on every row
 * "so a structured consumer never has to re-derive it"; measured, that convenience cost 3.5x
 * the bytes of the titles it decorated, and `reason:"trusted"` merely restates `band`. Trust
 * on the wire is now band + score. So these tests assert the explanation where it still
 * lives — the PROSE renderer, via the SAME explainTrust() the product calls — and separately
 * assert that the wire carries exactly the two fields and nothing else. The claim in the
 * title is unchanged: an agent never reads an unexplained band. The evidence for it moved.
 *
 * Embedding service mocked → deterministic + offline (mirrors trust.contract).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { TRUST_CONFIG } from '../config/trustConfig.js';
import { trustForRecords, explainTrust } from '../services/trust.js';
import { logger } from '../utils/logger.js';

const STAMP = Date.now();
const CONN = `trust-explain-conn-${STAMP}`;
const PROJ_NAME = `trust-explain-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** The promotion clause, as the ONE renderer derives it — from the SAME config the product
 *  reads (never hardcoded here). WS1 (D2): the TEXT channel now
 *  carries the machine-lean SIGNAL (`trust:<band> score:<x>` + supersession flag) instead of
 *  the WHY prose; the reason sentence + promotion requirement ride structuredContent.trust,
 *  asserted via assertExplainedTrust below. */
const SIGNAL_COLD = 'trust:unproven score:';
const PROMOTION = `>= ${TRUST_CONFIG.minOutcomeSamples} counted downstream outcome${
  TRUST_CONFIG.minOutcomeSamples === 1 ? '' : 's'
}, then score >= ${TRUST_CONFIG.trustedAt}`;

const TRUST_REASONS = [
  'cold-start',
  'stale',
  'soft-demoted',
  'declared-superseded',
  'contradicted',
  'trusted',
  'ok',
  'degraded', // the failed-gather fallback (nit N3) — a real branch, never seen on a healthy path
] as const;

/**
 * Assert a WIRE trust object: band + score, and NOTHING else.
 *
 * Absence is asserted, not just presence. A guard that only checks the keys it wants would
 * stay green if the whole old blob came back — that is an allow-list, and re-growing the blob
 * is exactly the regression worth catching.
 */
function assertWireTrust(trust: any) {
  expect(trust, 'trust object present').toBeTruthy();
  expect(Object.keys(trust).sort(), `wire trust: ${JSON.stringify(trust)}`).toEqual([
    'band',
    'score',
  ]);
  expect(trust.score === null || typeof trust.score === 'number').toBe(true);
}

/**
 * Assert the EXPLANATION still exists and is well-formed — from the ONE renderer, given the
 * record's real computed verdict. This is the half that answers "is the band explainable",
 * which is what this suite is named after; it is no longer answerable from the wire.
 */
async function assertExplainable(id: string, type: 'context' | 'decision' | 'task') {
  const [t] = await trustForRecords([{ id, type }]);
  const e = explainTrust(t);
  expect(TRUST_REASONS as readonly string[]).toContain(e.reason);
  expect(typeof e.reasonText).toBe('string');
  expect(e.reasonText.length).toBeGreaterThan(0);
  expect(e.promotionRequirement === null || typeof e.promotionRequirement === 'string').toBe(true);
  return e;
}

describe('trust explainability — the four render surfaces never show an unexplained band', () => {
  let ctxId: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'trust explain contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
    // A FRESH record with no downstream work: the honest cold-start case the evaluator
    // flagged — band `unproven`, score = freshness (~1.00), ZERO counted outcomes.
    const r = await viaTool('context_store', {
      content: `explainable trust row ${STAMP}`,
      type: 'planning',
    });
    ctxId = r.structuredContent.context.id;
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

  test('SURFACE 1 — context_search: unproven is printed WITH the reason, evidence and promotion', async () => {
    const resp = await viaTool('context_search', { query: `explainable trust row ${STAMP}` });
    const row = resp.structuredContent.results.find((r: any) => r.id === ctxId);
    expect(row).toBeTruthy();
    expect(row.trust.band).toBe('unproven');
    assertWireTrust(row.trust);
    const e = await assertExplainable(ctxId, 'context');
    expect(e.reason).toBe('cold-start');
    expect(e.promotionRequirement).toBe(PROMOTION);

    const text = responseText(resp);
    // The band is never bare: the signal always carries band AND score together.
    expect(text).toMatch(/trust:unproven score:\d\.\d\d/);
    // The WHY prose and promotion clause moved OFF the text channel (WS1) — asserted
    // present on the structured trust object above, absent from the machine-lean text here.
    expect(text).not.toContain('to promote:');
    expect(text).not.toContain('🔐');
  });

  test('SURFACE 1b — context_get_recent (the boot path) explains it too', async () => {
    const resp = await viaTool('context_get_recent', { limit: 5 });
    const text = responseText(resp);
    expect(text).toContain(SIGNAL_COLD);
    for (const row of resp.structuredContent.results) assertWireTrust(row.trust);
    await assertExplainable(ctxId, 'context');
  });

  test('SURFACE 2 — decision_search explains the band (indent preserved)', async () => {
    await viaTool('decision_record', {
      decisionType: 'architecture',
      title: `explainable trust decision ${STAMP}`,
      description: 'd',
      rationale: 'r',
      impactLevel: 'medium',
    });
    const resp = await viaTool('decision_search', { query: `explainable trust decision ${STAMP}` });
    const rows = resp.structuredContent.results;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) assertWireTrust(row.trust);
    await assertExplainable(rows[0].id, 'decision');

    const text = responseText(resp);
    expect(text).toContain('   trust:'); // this surface nests under a numbered result
    expect(text).toContain(SIGNAL_COLD);
  });

  test('SURFACE 3 — smart_search: the TRUNCATED ", cold-start" copy is gone, replaced by the full explanation', async () => {
    const resp = await viaTool('smart_search', { query: `explainable trust row ${STAMP}` });
    const text = responseText(resp);
    expect(text).toContain(SIGNAL_COLD);
    // The drifted copy printed a bare ", cold-start" with nothing after it.
    expect(text).not.toMatch(/, cold-start(?![ \w])/);
  });

  test('SURFACE 4 — recall_thread node lines carry band + score + reason (they carried NEITHER)', async () => {
    const resp = await viaTool('recall_thread', { anchor: id8(ctxId), altitude: 'headline' });
    expect(resp.structuredContent.ok).toBe(true);
    const node = resp.structuredContent.nodes.find((n: any) => n.id === ctxId);
    expect(node).toBeTruthy();
    assertWireTrust(node.trust);
    const e4 = await assertExplainable(ctxId, 'context');
    expect(e4.reason).toBe('cold-start');
    expect(e4.promotionRequirement).toBe(PROMOTION);

    const text = responseText(resp);
    expect(text).toMatch(/trust:unproven score:\d\.\d\d/); // band AND score, never a bare band
    // SIGNAL: a thread renders many nodes, so the WHY prose + promotion clause stay in
    // structuredContent — the node line must NOT carry them.
    expect(text).not.toContain('to promote:');
    // Still ONE line per node (the headline altitude renders no body).
    // (the thread HEADER also carries the anchor id — match the numbered NODE line)
    const nodeLine = text.split('\n').find((l) => l.includes(ctxId) && l.includes('[context]'));
    expect(nodeLine).toBeTruthy();
    expect(nodeLine!).toContain(SIGNAL_COLD);
  });

  test('a record WITH counted outcome evidence explains itself differently (not a stuck string)', async () => {
    // A decision the loop scored `successful`, and a context that laddered up to it →
    // real outcome evidence → a DIFFERENT branch, a DIFFERENT sentence.
    const dec = await viaTool('decision_record', {
      decisionType: 'pattern',
      title: `explainable successful decision ${STAMP}`,
      description: 'd',
      rationale: 'r',
      impactLevel: 'high',
      outcomeStatus: 'successful',
    });
    const decId = dec.structuredContent.decision.id;
    const ctx = await viaTool('context_store', {
      content: `evidence-backed explainable row ${STAMP}`,
      type: 'discussion',
      tags: [`decision:${id8(decId)}`],
    });
    const backedId = ctx.structuredContent.context.id;

    const resp = await viaTool('context_search', { query: `evidence-backed explainable row ${STAMP}` });
    const row = resp.structuredContent.results.find((r: any) => r.id === backedId);
    expect(row).toBeTruthy();
    assertWireTrust(row.trust);
    expect(row.trust.band).toBe('trusted'); // the WIRE says which band
    // …and the explanation, from the one renderer, took a DIFFERENT branch than cold-start.
    const [bt] = await trustForRecords([{ id: backedId, type: 'context' }]);
    expect(bt.outcome.samples).toBeGreaterThan(0);
    const be = explainTrust(bt);
    expect(be.reason).not.toBe('cold-start');
    expect(be.promotionRequirement).toBeNull(); // already the top band

    const text = responseText(resp);
    // A different branch renders a DIFFERENT signal — the string is not stuck.
    expect(text).toMatch(/trust:trusted score:\d\.\d\d/);
  });

  test('DEGRADE PATH — a failed signal gather WARNS for operators and never claims evidence (nit N3)', async () => {
    // Inject a pool whose every query throws: the exact systemic shape (bad pool / schema
    // drift / missing index) that used to vanish behind correct-sounding per-record wording.
    const throwingPool = {
      query: async () => {
        throw new Error('probe: signal gather exploded');
      },
    } as any;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);
    try {
      const [trust] = await trustForRecords(
        [{ id: ctxId, type: 'context', createdAt: new Date() }],
        TRUST_CONFIG,
        throwingPool
      );

      // 1. Recall still works — trust never fails a search.
      expect(trust).toBeTruthy();
      // 2. The record SAYS it was not measured, rather than asserting "no evidence".
      expect(trust.reason).toBe('degraded');
      expect(trust.promotionRequirement).toBeNull();
      // 3. And an OPERATOR can see it: a greppable warn naming the record + the metric.
      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toContain('signal gather FAILED');
      expect(msg).toContain(ctxId);
      expect(msg).toContain('metric=trust_degraded_fallback');
      // The error message rides the metadata, not the headline.
      const meta = warn.mock.calls[0]?.[1] as any;
      expect(meta?.metadata?.error).toContain('probe: signal gather exploded');
    } finally {
      warn.mockRestore(); // restore on EVERY path — a leaked spy poisons later files
    }
  });
});
