/**
 * TRUST INTEGRITY — `related_to` is NEVER an outcome edge (reliable-auto-threading, ST-1;
 * spec §E2).
 *
 * `related_to` is the WEAK, inferred edge Component B mints so a write is never a silent
 * orphan. It is deliberately NON-EVIDENCE: minting it must move NO trust score. This suite
 * is armor for that invariant, two ways:
 *
 *   (a) STATIC: `related_to` is NOT in services/trust.ts OUTCOME_OUT_EDGE_TYPES (the moat
 *       walk's edge set). Asserted against the AUTHORITATIVE exported list — plus the fact
 *       that importing trust.ts at all proves its load-time guard did not throw.
 *   (b) END-TO-END: a context whose ONLY edge is a `related_to` to a `successful` decision
 *       gets a COLD-START `unproven` trust band — the decision's successful outcome is NOT
 *       inherited (0 counted outcome samples, null outcome score). Contrast with the
 *       trust.contract.test.ts moat case where a `decided_by` edge to the SAME kind of
 *       decision DOES earn `trusted`. Same graph shape, different edge type → related_to
 *       carries no trust.
 *
 * Driven through validate → routeExecutor (the exact HTTP-bridge path); embeddings mocked
 * for determinism (mirrors trust.contract.test.ts). Rides the CI-migrated Postgres.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
import { OUTCOME_OUT_EDGE_TYPES } from '../services/trust.js';
import { trustForRecord } from '../services/trust.js';

const STAMP = Date.now();
const CONN = `trust-related-conn-${STAMP}`;
const PROJ_NAME = `trust-related-P-${STAMP}`;

let projectId: string;

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

describe('trust integrity — related_to is not an outcome edge (ST-1)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'trust related_to contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });
  // THIS SUITE RUNS UNPOSITIONED — restored explicitly, not assumed.
  // Auto-open means a task_create / decision_record in any earlier case leaves this shared
  // connection standing on a branch, so every later write in the file would pick up a
  // positional membership edge and the suite would be measuring trust-edge classification PLUS
  // positional membership. Each case here states its own precondition ("mints exactly
  // that edge", "an anchor with NO edges"), and this is what makes that precondition true
  // again rather than re-baselining every count around a second mechanism.
  // Auto-open's own behaviour is contracted in autoOpenPositions.contract.test.ts.
  beforeEach(async () => {
    await routeExecutor('branch_close', {}, { connectionId: CONN });
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

  // ── (a) STATIC INVARIANT ─────────────────────────────────────────────────────
  test('related_to is NOT in OUTCOME_OUT_EDGE_TYPES (the moat edge set)', () => {
    // Importing trust.ts above already proved its load-time guard did not throw. Now
    // assert against the authoritative exported list (not a copy).
    expect(OUTCOME_OUT_EDGE_TYPES as readonly string[]).not.toContain('related_to');
    // Sanity: the real outcome edges ARE present (guards against an empty/broken import).
    // LITERAL PIN, deliberately not derived from anything: this is the whole list, written
    // out, so ANY addition to the outcome set — including a well-meaning one — goes RED here
    // and has to be argued for rather than slipped in (a coverage assertion that
    // derives its expectation from the thing it checks is an allow-list).
    expect(OUTCOME_OUT_EDGE_TYPES).toEqual(['informs', 'decided_by', 'learned_from']);
  });

  test('depends_on is NOT in OUTCOME_OUT_EDGE_TYPES (scheduling structure, not evidence)', () => {
    // an earlier Task Q2. `depends_on` is minted from the `dependencies` field at task_create
    // AND backfilled across every existing task — so if it were an outcome edge, the backfill
    // would move trust scores en masse on data that never earned it. Importing trust.ts above
    // already proved its load-time guard for this did not throw; this asserts the authoritative
    // exported list directly.
    expect(OUTCOME_OUT_EDGE_TYPES as readonly string[]).not.toContain('depends_on');
  });

  // ── (b) END-TO-END: related_to carries NO trust ──────────────────────────────
  test('a context whose ONLY edge is related_to → successful decision stays cold-start unproven', async () => {
    // A decision the loop scored SUCCESSFUL — the exact ground-truth that a decided_by
    // edge WOULD inherit as trusted (see trust.contract.test.ts moat case).
    const decResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'the successful decision (related_to control)', description: 'd',
      rationale: 'r', impactLevel: 'high', outcomeStatus: 'successful',
    });
    const decId = decResp.structuredContent.decision.id;

    // Step off the branch the create above auto-opened — this case's
    // precondition is an UNPOSITIONED session, which is what makes "the related_to edge is the ONLY edge on this context"
    // a statement about the mechanism under test and not about positional membership too.
    await viaTool('branch_close', {});
    // A context with NO threading tag → born with no auto-minted outcome edge.
    const ctxResp = await viaTool('context_store', {
      content: 'context associated only by a weak related_to edge', type: 'discussion',
    });
    const ctxId = ctxResp.structuredContent.context.id;

    // Mint the ONLY edge: a related_to from the context to the successful decision.
    const linkResp = await viaTool('link', {
      from: id8(ctxId), fromType: 'context', to: id8(decId), toType: 'decision', edgeType: 'related_to',
    });
    expect(linkResp.isError).not.toBe(true);
    expect(linkResp.structuredContent.action).toBe('created');

    // Prove the edge really exists AND is the only one on this context.
    const edges = await db.query(
      `SELECT edge_type, to_id FROM links WHERE from_id = $1 OR to_id = $1`,
      [ctxId]
    );
    expect(edges.rows.length).toBe(1);
    expect(edges.rows[0].edge_type).toBe('related_to');
    expect(edges.rows[0].to_id).toBe(decId);

    // Recall it and read trust: the successful outcome is NOT inherited across related_to.
    const search = await viaTool('context_search', { query: 'context associated only by a weak related_to edge' });
    const row = search.structuredContent.results.find((r: any) => r.id === ctxId);
    expect(row, 'the context is in the results').toBeTruthy();
    // Cold-start band ON THE WIRE — NOT the `trusted` a decided_by would have earned. The
    // wire carries band+score only since so the outcome sub-signal is read
    // from the service, which is where that arithmetic lives.
    expect(row.trust.band).toBe('unproven');
    const t = await trustForRecord({ id: ctxId, type: 'context' });
    // Zero counted outcome samples → related_to moved NO trust score.
    expect(t.outcome.samples).toBe(0);
    expect(t.outcome.score).toBeNull();
    expect(t.superseded).toBe(false);
    expect(t.abstain).toBe(false); // freshly stored → lean on freshness, not distrust
  });
});
