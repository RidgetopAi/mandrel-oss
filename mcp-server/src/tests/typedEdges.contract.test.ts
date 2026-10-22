/**
 * TYPED-EDGE GRAPH — contract + adversarial tests (Mandrel Core Redesign T2a).
 *
 * Tests are armor (spec §6). This locks the T2a foundation the moat is built on:
 *   - the edge-type single-source ↔ DB CHECK agree (no drift),
 *   - the migration shape (table, UNIQUE dedup, both-direction indexes, CHECK),
 *   - auto-mint at write time: each tag→edge mapping, the decision evidence/supersession
 *     edges, AND the critical robustness case — a typo'd/unresolvable tag must NOT break
 *     the write (it just doesn't mint that edge),
 *   - explicit link/unlink (create / repair) through the real public tool path,
 *   - dedup (UNIQUE) — re-mint = no dup,
 *   - bidirectional get_links (out + in, hydrated connected node),
 *   - backfill idempotency (re-run = no dupes),
 *   - ADVERSARIAL: id8 wildcard rejected, self-link rejected, bad edge_type rejected,
 *     cross-project link rejected.
 *
 * Driven through validate → routeExecutor (the EXACT path the HTTP bridge uses), same
 * idiom as dualChannelOutput / toolNativeLinking. The embedding service is mocked so the
 * suite is deterministic + offline.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

// Deterministic, offline embeddings (mirrors toolNativeLinking).
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
import { EDGE_TYPES } from '../config/edgeTypes.js';
import { mintEdge } from '../services/links.js';
import { runBackfill } from '../services/backfillTypedEdges.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const CONN = `typed-edges-conn-${STAMP}`;
const PROJ_NAME = `typed-edges-P-${STAMP}`;
const OTHER_PROJ_NAME = `typed-edges-OTHER-${STAMP}`;

let projectId: string;
let otherProjectId: string;

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

/** Count edges for a record (both directions) directly — fuse to verify the graph. */
async function edgeCount(recordId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM links WHERE from_id = $1 OR to_id = $1`,
    [recordId]
  );
  return r.rows[0].c;
}

describe('typed-edge graph (T2a)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'typed-edges contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    otherProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'typed-edges other project') RETURNING id`,
        [OTHER_PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });
  // THIS SUITE RUNS UNPOSITIONED — restored explicitly, not assumed.
  // Auto-open means a task_create / decision_record in any earlier case leaves this shared
  // connection standing on a branch, so every later write in the file would pick up a
  // positional membership edge and the suite would be measuring typed-edge minting PLUS
  // positional membership. Each case here states its own precondition ("mints exactly
  // that edge", "an anchor with NO edges"), and this is what makes that precondition true
  // again rather than re-baselining every count around a second mechanism.
  // Auto-open's own behaviour is contracted in autoOpenPositions.contract.test.ts.
  beforeEach(async () => {
    await routeExecutor('branch_close', {}, { connectionId: CONN });
  });


  afterAll(async () => {
    try {
      for (const pid of [projectId, otherProjectId]) {
        if (!pid) continue;
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      }
    } catch { /* ignore */ }
    await db.end();
  });

  // ── EDGE-TYPE SINGLE SOURCE ↔ DB CHECK ──────────────────────────────────────
  test('the edge-type config and the DB CHECK constraint agree (no drift)', async () => {
    // Pull the links.edge_type CHECK definition and assert it lists EXACTLY EDGE_TYPES.
    const check = await db.query(
      `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'links' AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ILIKE '%edge_type%'`
    );
    expect(check.rows.length, 'links.edge_type CHECK exists').toBeGreaterThan(0);
    const def = check.rows.map((r) => r.def).join(' ');
    for (const t of EDGE_TYPES) {
      expect(def, `DB CHECK must allow edge type "${t}"`).toContain(`'${t}'`);
    }
  });

  // ── MIGRATION SHAPE ─────────────────────────────────────────────────────────
  test('links table has the UNIQUE dedup constraint + both-direction indexes', async () => {
    const uniq = await db.query(
      `SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname='links' AND con.contype='u'`
    );
    expect(uniq.rows.length, 'UNIQUE(from_id,to_id,edge_type) present').toBeGreaterThan(0);
    const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='links'`);
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toContain('idx_links_from');
    expect(names).toContain('idx_links_to');
  });

  // ── AUTO-MINT: each tag → edge mapping ──────────────────────────────────────
  test('context tagged task:<id8> auto-mints an `informs` edge (record→task)', async () => {
    const taskResp = await viaTool('task_create', { title: 'spine task', type: 'feature' });
    const taskId = parseId(taskResp);

    const ctxResp = await viaTool('context_store', {
      content: 'capture for the spine task',
      type: 'planning',
      tags: [`task:${id8(taskId)}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const links = await db.query(
      `SELECT edge_type, from_id, to_id, from_type, to_type FROM links
       WHERE from_id = $1 AND to_id = $2`,
      [ctxId, taskId]
    );
    expect(links.rows.length).toBe(1);
    expect(links.rows[0].edge_type).toBe('informs');
    expect(links.rows[0].from_type).toBe('context');
    expect(links.rows[0].to_type).toBe('task');
  });

  test('context tagged decision:<id8> auto-mints a `decided_by` edge (record→decision)', async () => {
    const decResp = await viaTool('decision_record', {
      decisionType: 'architecture',
      title: 'the governing decision',
      description: 'why we chose X',
      rationale: 'because Y',
      impactLevel: 'medium',
    });
    const decId = decResp.structuredContent.decision.id;

    // Step off the branch the create above auto-opened — this case's
    // precondition is an UNPOSITIONED session, which is what makes "exactly one edge, of type decided_by"
    // a statement about the mechanism under test and not about positional membership too.
    await viaTool('branch_close', {});
    const ctxResp = await viaTool('context_store', {
      content: 'context that ladders up to the decision',
      type: 'discussion',
      tags: [`decision:${id8(decId)}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const links = await db.query(
      `SELECT edge_type FROM links WHERE from_id = $1 AND to_id = $2`,
      [ctxId, decId]
    );
    expect(links.rows.length).toBe(1);
    expect(links.rows[0].edge_type).toBe('decided_by');
  });

  test('context tagged context:<uuid> auto-mints a `learned_from` edge', async () => {
    const anchorResp = await viaTool('context_store', { content: 'anchor doc', type: 'milestone' });
    const anchorId = anchorResp.structuredContent.context.id;

    const ctxResp = await viaTool('context_store', {
      content: 'derived note',
      type: 'discussion',
      tags: [`context:${anchorId}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    const links = await db.query(
      `SELECT edge_type FROM links WHERE from_id = $1 AND to_id = $2`,
      [ctxId, anchorId]
    );
    expect(links.rows.length).toBe(1);
    expect(links.rows[0].edge_type).toBe('learned_from');
  });

  // ── ROBUSTNESS: a bad/unresolvable tag must NOT break the write ──────────────
  test('a typo\'d/unresolvable threading tag does NOT break the write (no edge, store still succeeds)', async () => {
    // 'task:deadbeef' resolves to nothing in this project — must be skipped silently.
    const ctxResp = await viaTool('context_store', {
      content: 'has a dangling task tag',
      type: 'error',
      tags: ['task:deadbeef', 'keep-me'],
    });
    expect(ctxResp.isError).not.toBe(true);
    const ctxId = ctxResp.structuredContent.context.id;
    expect(ctxId).toBeTruthy(); // the write SUCCEEDED
    // The dangling tag minted NO edge.
    expect(await edgeCount(ctxId)).toBe(0);
    // And the row really exists (not a false success).
    const row = await db.query('SELECT id FROM contexts WHERE id = $1', [ctxId]);
    expect(row.rows.length).toBe(1);
  });

  // ── DECISION evidence + supersession auto-mint ──────────────────────────────
  test('decision_record with metadata.evidence mints `learned_from`; supersededBy mints `supersedes`', async () => {
    const evidenceResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'evidence decision', description: 'd', rationale: 'r', impactLevel: 'low',
    });
    const evidenceId = evidenceResp.structuredContent.decision.id;
    const oldResp = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'old decision', description: 'd', rationale: 'r', impactLevel: 'low',
    });
    const oldId = oldResp.structuredContent.decision.id;

    const newResp = await viaTool('decision_record', {
      decisionType: 'pattern',
      title: 'new decision citing evidence + superseding old',
      description: 'd', rationale: 'r', impactLevel: 'high',
      metadata: { evidence: [evidenceId] },
    });
    const newId = newResp.structuredContent.decision.id;

    const learned = await db.query(
      `SELECT edge_type FROM links WHERE from_id=$1 AND to_id=$2`, [newId, evidenceId]
    );
    expect(learned.rows.map((r) => r.edge_type)).toContain('learned_from');

    // Now supersede via decision_update (the common path) and assert the supersedes edge.
    await viaTool('decision_update', { decisionId: newId, supersededBy: oldId, status: 'superseded' });
    const sup = await db.query(
      `SELECT edge_type FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='supersedes'`,
      [newId, oldId]
    );
    expect(sup.rows.length).toBe(1);
  });

  // ── EXPLICIT link / unlink (create / repair) ────────────────────────────────
  test('link creates a typed edge; re-link is idempotent (dedup); unlink removes it', async () => {
    const a = parseId(await viaTool('task_create', { title: 'link A', type: 'general' }));
    const b = parseId(await viaTool('task_create', { title: 'link B', type: 'general' }));

    const first = await viaTool('link', {
      from: id8(a), fromType: 'task', to: id8(b), toType: 'task', edgeType: 'caused',
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent.action).toBe('created');

    // DEDUP: re-link the SAME edge → no duplicate row, reported as already-exists.
    const second = await viaTool('link', {
      from: a, fromType: 'task', to: b, toType: 'task', edgeType: 'caused',
    });
    expect(second.structuredContent.action).toBe('exists');
    const cnt = await db.query(
      `SELECT count(*)::int AS c FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='caused'`, [a, b]
    );
    expect(cnt.rows[0].c).toBe(1);

    // The edge id, so the removal report can be checked against the row that existed.
    const edgeRow = await db.query(
      `SELECT id::text AS id FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='caused'`, [a, b]
    );

    // UNLINK removes it; re-unlink is idempotent (absent, not an error).
    const removed = await viaTool('unlink', { from: a, to: b, edgeType: 'caused' });
    expect(removed.structuredContent.action).toBe('removed');
    // an earlier task (minor): a SUCCESSFUL removal reports what the DELETE actually knew —
    // the endpoint TYPE and the removed row's id. It used to answer 'unknown' + '' and drop
    // both on the floor (the same "report less than you measured" class as the anchor
    // admissions this task fixed).
    expect(removed.structuredContent.edge.connectedType).toBe('task');
    expect(removed.structuredContent.edge.edgeId).toBe(edgeRow.rows[0].id);

    const again = await viaTool('unlink', { from: a, to: b, edgeType: 'caused' });
    expect(again.structuredContent.action).toBe('absent');
    expect(again.isError).not.toBe(true);
    // ABSENT is genuinely unknowable — nothing was removed, so nothing is claimed.
    expect(again.structuredContent.edge.connectedType).toBe('unknown');
    expect(again.structuredContent.edge.edgeId).toBe('');
  });

  // ── BIDIRECTIONAL get_links ─────────────────────────────────────────────────
  test('get_links returns BOTH directions with the connected record hydrated', async () => {
    const task = parseId(await viaTool('task_create', { title: 'getlinks task', type: 'feature' }));
    const ctxResp = await viaTool('context_store', {
      content: 'context informing the task', type: 'planning', tags: [`task:${id8(task)}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;

    // From the CONTEXT side: an OUT edge (context → task) of type informs.
    const fromCtx = await viaTool('get_links', { id: ctxId });
    const outEdge = fromCtx.structuredContent.results.find((e: any) => e.edgeType === 'informs');
    expect(outEdge).toBeTruthy();
    expect(outEdge.direction).toBe('out');
    expect(outEdge.connectedId).toBe(task);
    expect(outEdge.connectedType).toBe('task');

    // From the TASK side: the SAME edge appears as an IN edge (reverse walk).
    const fromTask = await viaTool('get_links', { id: id8(task) });
    const inEdge = fromTask.structuredContent.results.find((e: any) => e.edgeType === 'informs');
    expect(inEdge).toBeTruthy();
    expect(inEdge.direction).toBe('in');
    expect(inEdge.connectedId).toBe(ctxId);

    // edge_types filter restricts the walk.
    const filtered = await viaTool('get_links', { id: ctxId, edgeTypes: ['decided_by'] });
    expect(filtered.structuredContent.results.find((e: any) => e.edgeType === 'informs')).toBeUndefined();
  });

  // ── ADVERSARIAL ─────────────────────────────────────────────────────────────
  test('adversarial: a SELF-link is rejected and mints nothing', async () => {
    const t = parseId(await viaTool('task_create', { title: 'self link', type: 'general' }));
    const resp = await viaTool('link', {
      from: t, fromType: 'task', to: t, toType: 'task', edgeType: 'caused',
    });
    expect(resp.isError).toBe(true);
    const cnt = await db.query(`SELECT count(*)::int AS c FROM links WHERE from_id=$1 AND to_id=$1`, [t]);
    expect(cnt.rows[0].c).toBe(0);
  });

  test('adversarial: a bad edge_type is rejected at validation (never reaches the DB)', () => {
    expect(() => validateToolArguments('link', {
      from: '11111111-1111-4111-8111-111111111111', fromType: 'task',
      to: '22222222-2222-4222-8222-222222222222', toType: 'task',
      edgeType: 'not_a_real_edge',
    })).toThrow();
  });

  test('adversarial: a wildcard / non-hex id is rejected at validation', () => {
    expect(() => validateToolArguments('link', {
      from: '%', fromType: 'task', to: '%', toType: 'task', edgeType: 'caused',
    })).toThrow();
  });

  test('adversarial: a cross-project link is rejected (endpoint resolves only in its own project)', async () => {
    // A task created in the OTHER project.
    const otherConn = `${CONN}-other`;
    await routeExecutor('project_switch', { project: otherProjectId }, { connectionId: otherConn });
    const otherTaskResp = await routeExecutor(
      'task_create', { title: 'other-project task', type: 'general' }, { connectionId: otherConn }
    );
    const otherTaskId = parseId(otherTaskResp);

    // From OUR project, link to the other project's task BY SHORT ID → must NOT resolve
    // (resolution is scoped to our active project) → actionable not-found, no edge.
    const here = parseId(await viaTool('task_create', { title: 'here task', type: 'general' }));
    const resp = await viaTool('link', {
      from: id8(here), fromType: 'task', to: id8(otherTaskId), toType: 'task', edgeType: 'caused',
    });
    expect(resp.isError).toBe(true);
    const cnt = await db.query(
      `SELECT count(*)::int AS c FROM links WHERE from_id=$1 AND to_id=$2`, [here, otherTaskId]
    );
    expect(cnt.rows[0].c).toBe(0);
  });

  // ── BACKFILL idempotency ────────────────────────────────────────────────────
  test('backfill is idempotent — re-running mints no new edges (UNIQUE dedup)', async () => {
    // Seed a record with a threading tag whose edge we DELETE so backfill has work to do.
    const task = parseId(await viaTool('task_create', { title: 'backfill task', type: 'feature' }));
    const ctxResp = await viaTool('context_store', {
      content: 'backfill seed context', type: 'planning', tags: [`task:${id8(task)}`],
    });
    const ctxId = ctxResp.structuredContent.context.id;
    // Remove the auto-minted edge to simulate a pre-graph record.
    await db.query(`DELETE FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, task]);
    expect((await db.query(`SELECT count(*)::int c FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, task])).rows[0].c).toBe(0);

    // First backfill mints it.
    await runBackfill();
    const after1 = (await db.query(`SELECT count(*)::int c FROM links WHERE from_id=$1 AND to_id=$2`, [ctxId, task])).rows[0].c;
    expect(after1).toBe(1);

    // Total edge count snapshot, then re-run: NO new edges (idempotent).
    const totalBefore = (await db.query(`SELECT count(*)::int c FROM links`)).rows[0].c;
    await runBackfill();
    const totalAfter = (await db.query(`SELECT count(*)::int c FROM links`)).rows[0].c;
    expect(totalAfter).toBe(totalBefore);
  });

  // ── SERVICE-LEVEL dedup (defense in depth) ──────────────────────────────────
  test('mintEdge dedups at the service layer (created:false on re-mint)', async () => {
    const a = parseId(await viaTool('task_create', { title: 'mint A', type: 'general' }));
    const b = parseId(await viaTool('task_create', { title: 'mint B', type: 'general' }));
    const first = await mintEdge({ fromId: a, fromType: 'task', toId: b, toType: 'task', edgeType: 'built_by', projectId, via: EDGE_MINT_VIA.linkTool });
    expect(first.created).toBe(true);
    const second = await mintEdge({ fromId: a, fromType: 'task', toId: b, toType: 'task', edgeType: 'built_by', projectId, via: EDGE_MINT_VIA.linkTool });
    expect(second.created).toBe(false);
  });
});
