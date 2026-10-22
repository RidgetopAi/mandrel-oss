/**
 * FIRST-CLASS `links` PARAM — contract + robustness tests (Mandrel Core Redesign T5a,
 * an earlier decision).
 *
 * Tests are armor (spec §6). This locks the explicit `links` write parameter on BOTH
 * context_store and decision_record:
 *   (1) explicit { edgeType, to, toType } mints exactly that typed edge,
 *   (2) shorthand { task:<ref> } mints an `informs` edge (REUSING the tag mapping so it
 *       cannot drift from the threading-tag path); + decision/context shorthands,
 *   (3) ROBUSTNESS: an unresolvable ref returns a WARNING and the write STILL succeeds
 *       (record exists, the good links in the SAME call still mint),
 *   (4) an invalid edgeType warns (caught at validation for a typo'd enum; and at the
 *       service for a direct call), write succeeds,
 *   (5) idempotent re-link (UNIQUE dedup) — re-storing the same link mints no duplicate.
 *
 * Driven through validate → routeExecutor (the EXACT path the HTTP bridge uses), same
 * idiom as typedEdges / toolNativeLinking. Embeddings are mocked so the suite is
 * deterministic + offline.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

// Deterministic, offline embeddings (mirrors typedEdges/toolNativeLinking).
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
import { mintExplicitLinks } from '../services/links.js';
import { MAX_LINKS_PER_WRITE } from '../config/linksConfig.js';

const STAMP = Date.now();
const CONN = `links-param-conn-${STAMP}`;
const PROJ_NAME = `links-param-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from response: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

/** Run a tool through the FULL public path: validate THEN routeExecutor. */
async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

async function edgeCount(recordId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM links WHERE from_id = $1 OR to_id = $1`,
    [recordId]
  );
  return r.rows[0].c;
}

describe('first-class `links` write param (T5a)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'links-param contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });
  // THIS SUITE RUNS UNPOSITIONED — restored explicitly, not assumed.
  // Auto-open means a task_create / decision_record in any earlier case leaves this shared
  // connection standing on a branch, so every later write in the file would pick up a
  // positional membership edge and the suite would be measuring the explicit `links` param PLUS
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

  // ── (1) EXPLICIT edgeType mints exactly that edge ───────────────────────────
  test('context_store links:[{edgeType,to,toType}] mints exactly that typed edge', async () => {
    const decResp = await viaTool('decision_record', {
      decisionType: 'architecture', title: 'governing decision', description: 'd',
      rationale: 'r', impactLevel: 'medium',
    });
    const decId = decResp.structuredContent.decision.id;

    // Step off the branch the create above auto-opened — this case's
    // precondition is an UNPOSITIONED session, which is what makes "exactly the one typed edge the links param named"
    // a statement about the mechanism under test and not about positional membership too.
    await viaTool('branch_close', {});
    const ctxResp = await viaTool('context_store', {
      content: 'context with an explicit decided_by link',
      type: 'discussion',
      links: [{ edgeType: 'decided_by', to: id8(decId), toType: 'decision' }],
    });
    expect(ctxResp.isError).not.toBe(true);
    const ctxId = ctxResp.structuredContent.context.id;

    const rows = await db.query(
      `SELECT edge_type, from_type, to_type FROM links WHERE from_id=$1 AND to_id=$2`,
      [ctxId, decId]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].edge_type).toBe('decided_by');
    expect(rows.rows[0].from_type).toBe('context');
    expect(rows.rows[0].to_type).toBe('decision');
    expect(ctxResp.structuredContent.context.linksMinted).toBe(1);
    expect(ctxResp.structuredContent.context.linkWarnings).toEqual([]);
  });

  test('decision_record links:[{edgeType,to,toType}] mints exactly that typed edge', async () => {
    const targetTask = parseId(await viaTool('task_create', { title: 'target task', type: 'feature' }));
    const decResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'decision informing a task', description: 'd',
      rationale: 'r', impactLevel: 'low',
      links: [{ edgeType: 'informs', to: id8(targetTask), toType: 'task' }],
    });
    const decId = decResp.structuredContent.decision.id;
    const rows = await db.query(
      `SELECT edge_type FROM links WHERE from_id=$1 AND to_id=$2`, [decId, targetTask]
    );
    expect(rows.rows.map((r) => r.edge_type)).toContain('informs');
    expect(decResp.structuredContent.decision.linksMinted).toBe(1);
  });

  // ── (2) SHORTHAND reuses the tag mapping ────────────────────────────────────
  test('shorthand {task:<ref>} mints an `informs` edge (same mapping as the tag path)', async () => {
    const task = parseId(await viaTool('task_create', { title: 'spine task', type: 'feature' }));
    const ctxResp = await viaTool('context_store', {
      content: 'context shorthand-linked to a task',
      type: 'planning',
      links: [{ task: id8(task) }],
    });
    const ctxId = ctxResp.structuredContent.context.id;
    const rows = await db.query(
      `SELECT edge_type FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, task]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].edge_type).toBe('informs');
  });

  test('shorthand {decision:<ref>}→decided_by and {context:<ref>}→learned_from', async () => {
    const decResp = await viaTool('decision_record', {
      decisionType: 'database', title: 'shorthand target decision', description: 'd',
      rationale: 'r', impactLevel: 'medium',
    });
    const decId = decResp.structuredContent.decision.id;
    const anchorResp = await viaTool('context_store', { content: 'anchor doc', type: 'milestone' });
    const anchorId = anchorResp.structuredContent.context.id;

    const ctxResp = await viaTool('context_store', {
      content: 'context with two shorthand links',
      type: 'discussion',
      links: [{ decision: id8(decId) }, { context: anchorId }],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const decEdge = await db.query(
      `SELECT edge_type FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, decId]
    );
    expect(decEdge.rows[0]?.edge_type).toBe('decided_by');
    const ctxEdge = await db.query(
      `SELECT edge_type FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, anchorId]
    );
    expect(ctxEdge.rows[0]?.edge_type).toBe('learned_from');
  });

  // ── (3) ROBUSTNESS: unresolvable ref warns, write still succeeds + good links mint ──
  test('an unresolvable ref WARNS and the write still succeeds; the good link in the same call still mints', async () => {
    const task = parseId(await viaTool('task_create', { title: 'good link task', type: 'feature' }));
    const ctxResp = await viaTool('context_store', {
      content: 'one bad link, one good link',
      type: 'error',
      links: [
        { task: 'deadbeef' },          // unresolvable in this project → WARN
        { task: id8(task) },           // good → mints `informs`
      ],
    });
    // The write SUCCEEDED (not an error response).
    expect(ctxResp.isError).not.toBe(true);
    const ctxId = ctxResp.structuredContent.context.id;
    expect(ctxId).toBeTruthy();

    // The row really exists (not a false success).
    const row = await db.query('SELECT id FROM contexts WHERE id=$1', [ctxId]);
    expect(row.rows.length).toBe(1);

    // The bad link produced a WARNING in the structured channel...
    const warnings = ctxResp.structuredContent.context.linkWarnings;
    expect(warnings.length).toBe(1);
    // The reason must say WHICH ref failed and that it did not resolve. Asserted on
    // SEMANTICS, not the exact sentence: the mint-endpoint guard replaced
    // the old generic "could not resolve X" with the resolver's more specific reason
    // ("not found in this project" vs "is ambiguous"), which is strictly more useful. The
    // contract this test defends is "an unresolvable ref WARNS naming the ref", not any
    // particular phrasing of it.
    expect(warnings[0].reason).toMatch(/not found|could not resolve|ambiguous/i);
    expect(warnings[0].reason, 'the warning names the offending ref').toMatch(/deadbeef/);
    // ...and in the human text channel ("Link notes").
    expect(responseText(ctxResp)).toMatch(/Link notes/);

    // The GOOD link in the same call STILL minted (exactly one edge: ctx → task).
    expect(await edgeCount(ctxId)).toBe(1);
    const good = await db.query(
      `SELECT edge_type FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, task]
    );
    expect(good.rows[0]?.edge_type).toBe('informs');
    expect(ctxResp.structuredContent.context.linksMinted).toBe(1);
  });

  // ── (4) invalid edgeType warns, write succeeds ──────────────────────────────
  test('an invalid edgeType is rejected at validation (typo never reaches the DB)', () => {
    expect(() =>
      validateToolArguments('context_store', {
        content: 'x', type: 'discussion',
        links: [{ edgeType: 'not_a_real_edge', to: '11111111-1111-4111-8111-111111111111', toType: 'task' }],
      })
    ).toThrow();
  });

  test('an invalid edgeType passed DIRECTLY to the service WARNS, mints nothing, never throws', async () => {
    // The route validates the enum, but the service is the backstop (defense in depth):
    // a bad edgeType reaching mintExplicitLinks becomes a warning, not an exception.
    const ctxResp = await viaTool('context_store', { content: 'host for direct-service test', type: 'discussion' });
    const ctxId = ctxResp.structuredContent.context.id;
    const targetTask = parseId(await viaTool('task_create', { title: 'svc target', type: 'general' }));

    const res = await mintExplicitLinks({
      fromId: ctxId,
      fromType: 'context',
      links: [{ edgeType: 'bogus_edge', to: id8(targetTask), toType: 'task' } as any],
      projectId,
      createdBy: 'links:test',
    });
    expect(res.minted).toBe(0);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0].reason).toMatch(/unknown edgeType/i);
    // No edge was minted between ctx and the task.
    const cnt = await db.query(
      `SELECT count(*)::int c FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, targetTask]
    );
    expect(cnt.rows[0].c).toBe(0);
  });

  // ── (5) idempotent re-link ──────────────────────────────────────────────────
  test('idempotent: storing the same link twice mints no duplicate edge', async () => {
    const task = parseId(await viaTool('task_create', { title: 'idempotent task', type: 'feature' }));
    const first = await viaTool('context_store', {
      content: 'first store with link', type: 'planning', links: [{ task: id8(task) }],
    });
    const firstId = first.structuredContent.context.id;
    expect(first.structuredContent.context.linksMinted).toBe(1);

    // Re-mint the SAME edge (same from + to + edge_type) directly → dedup, no new row.
    const again = await mintExplicitLinks({
      fromId: firstId, fromType: 'context', links: [{ task: id8(task) }], projectId, createdBy: 'links:test',
    });
    expect(again.minted).toBe(0); // already existed → created:false → not counted
    expect(again.warnings).toEqual([]);
    const cnt = await db.query(
      `SELECT count(*)::int c FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='informs'`,
      [firstId, task]
    );
    expect(cnt.rows[0].c).toBe(1);
  });

  // ── CONFIG: the array bound derives from MAX_LINKS_PER_WRITE (no hardcoded var) ──
  test('links over MAX_LINKS_PER_WRITE are rejected at validation (bound from config)', () => {
    const tooMany = Array.from({ length: MAX_LINKS_PER_WRITE + 1 }, () => ({ task: 'deadbeef' }));
    expect(() =>
      validateToolArguments('context_store', { content: 'x', type: 'discussion', links: tooMany })
    ).toThrow();
  });
});
