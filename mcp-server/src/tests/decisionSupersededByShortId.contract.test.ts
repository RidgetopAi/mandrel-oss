/**
 * decision_update `supersededBy` short-id resolution contract
 * (contract-symmetry follow-up to an earlier change / the task_create dependencies fuse).
 *
 * THE BUG (flagged 2026-07-18 during the resolver sweep): supersededBy was
 * validated as a bare `z.string().uuid()`, so it rejected the id8 short form — the handle
 * every OTHER id-accepting arg (decisionId on the same tool, task deps, link endpoints)
 * accepts via the ONE shared resolver. Unlike an earlier change it failed with a CLEAN zod error
 * (not a leaked Postgres cast), but the asymmetry broke the id8-everywhere contract the
 * moat is built around.
 *
 * THE FIX: zod relaxed to uuidOrShortId(); handleUpdate resolves an id8 → full UUID via
 * resolveEntityId (project-scoped, same as decisionId) BEFORE updateDecision, so the
 * `superseded_by` uuid column + the auto-minted `supersedes` edge both get the RESOLVED
 * full UUID; an unknown/ambiguous id returns a tool-level actionable error and mutates
 * NOTHING (no partial write, no leaked "invalid input syntax for type uuid").
 *
 * WHAT THIS PROVES (real Postgres, the FULL public path: validate → routeExecutor):
 *   1. supersededBy:"<id8>" → superseded_by column holds the FULL UUID, status flips to
 *      'superseded', and the `supersedes` edge endpoint is the full UUID (not the id8).
 *   2. a full-UUID supersededBy still works (back-compat).
 *   3. a syntactically-valid-but-UNKNOWN id8 → tool-level not-found (isError), NO raw
 *      Postgres cast leak, and the target decision is NOT mutated.
 *
 * DB target: the disposable migrated Postgres from the CI gate stage 0b.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

// Deterministic, offline embeddings (same idiom as typedEdges.contract.test.ts).
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

const STAMP = Date.now();
const CONN = `superseded-by-id8-conn-${STAMP}`;
const PROJ_NAME = `superseded-by-id8-${STAMP}`;

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

/** Record a minimal decision and return its full UUID. */
async function recordDecision(title: string): Promise<string> {
  const resp = await viaTool('decision_record', {
    decisionType: 'architecture',
    title,
    description: `${title} — description`,
    rationale: `${title} — rationale`,
    impactLevel: 'low',
    projectId,
  });
  return parseId(resp);
}

describe('decision_update supersededBy id8 resolution (74218558, symmetry with an earlier change)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'supersededBy id8 fuse') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch { /* ignore */ }
    await db.end();
  });

  test('MOAT: supersededBy:"<id8>" resolves → full UUID in superseded_by + the supersedes edge', async () => {
    const oldId = await recordDecision(`old decision ${STAMP}`);
    const newId = await recordDecision(`new decision ${STAMP}`);

    // The reproduction: the id8 short form (previously → clean zod REJECT; the whole point
    // of this contract is that it now resolves like every other id arg).
    const resp = await viaTool('decision_update', {
      decisionId: newId,
      supersededBy: id8(oldId),
      supersededReason: 'replaced by the new approach',
    });
    const text = responseText(resp);
    expect(resp.isError, `update must succeed, got: ${text.slice(0, 300)}`).not.toBe(true);
    expect(text).toContain('Decision updated successfully');
    expect(text).not.toMatch(/invalid input syntax for type uuid/i);

    // Authoritative: the uuid column holds the RESOLVED full UUID, not the id8; and
    // supersededBy implies status='superseded' (existing contract, unchanged).
    const row = (
      await db.query(
        'SELECT superseded_by::text AS superseded_by, status FROM technical_decisions WHERE id = $1',
        [newId]
      )
    ).rows[0];
    expect(row.superseded_by).toBe(oldId);
    expect(row.status).toBe('superseded');

    // The auto-minted `supersedes` edge endpoint is the RESOLVED full UUID too.
    const edge = await db.query(
      `SELECT to_id::text AS to_id FROM links
       WHERE from_id = $1 AND edge_type = 'supersedes'`,
      [newId]
    );
    expect(edge.rows.map((r: any) => r.to_id)).toContain(oldId);
  });

  test('a full-UUID supersededBy still resolves + persists (back-compat)', async () => {
    const oldId = await recordDecision(`old-full ${STAMP}`);
    const newId = await recordDecision(`new-full ${STAMP}`);

    const resp = await viaTool('decision_update', {
      decisionId: newId,
      supersededBy: oldId,
    });
    expect(resp.isError).not.toBe(true);

    const row = (
      await db.query(
        'SELECT superseded_by::text AS superseded_by FROM technical_decisions WHERE id = $1',
        [newId]
      )
    ).rows[0];
    expect(row.superseded_by).toBe(oldId);
  });

  test('an UNKNOWN supersededBy id8 → tool-level not-found, NO raw cast leak, NOTHING mutated', async () => {
    const targetId = await recordDecision(`untouched ${STAMP}`);

    // Syntactically valid id8 (hex, passes zod shape) matching no decision in-project.
    const resp = await viaTool('decision_update', {
      decisionId: targetId,
      supersededBy: 'deadbeef',
    });
    const text = responseText(resp);
    expect(resp.isError).toBe(true);
    expect(text).toMatch(/not found/i);
    // Tool-level actionable message — never the leaked Postgres cast error.
    expect(text).not.toMatch(/invalid input syntax for type uuid/i);

    // And the target decision was NOT mutated (resolution failed BEFORE the UPDATE).
    const row = (
      await db.query(
        'SELECT superseded_by, status FROM technical_decisions WHERE id = $1',
        [targetId]
      )
    ).rows[0];
    expect(row.superseded_by).toBeNull();
    expect(row.status).toBe('active');
  });

  test('zod still rejects non-hex garbage in supersededBy (shape floor intact)', () => {
    expect(() =>
      validateToolArguments('decision_update', {
        decisionId: '00000000-0000-4000-8000-000000000000',
        supersededBy: 'not-a-real-id!',
      })
    ).toThrow(/full UUID or a short id/i);
  });
});
