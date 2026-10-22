/**
 * repair-mistyped-decision-edges — contract test.
 *
 * Drives the SHIPPED ENTRY POINT (`npx tsx scripts/repair-mistyped-decision-edges.ts`) rather
 * than importing its functions, so what is under test is the thing an operator runs — flag
 * parsing, refusal paths, manifest writing included — and not a re-wired composition of it.
 *
 * Three seeded rows, per the task: one whose to_id resolves to a CONTEXT (mis-typed by the
 * dead full-UUID fallback), one that resolves to NOTHING, and one that is CORRECT. Then:
 *   * dry run writes nothing;
 *   * apply re-types the first, deletes the second, leaves the third, writes a manifest;
 *   * undo restores both, provenance-scoped, from that manifest;
 *   * --apply without --i-mean-it refuses (exit 2) and writes nothing.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../config/database.js';

const MCP_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join('scripts', 'repair-mistyped-decision-edges.ts');
const STAMP = Date.now();

let projectId: string;
let decisionId: string;
let otherDecisionId: string;
let contextId: string;
let ghostId: string;
let mistypedEdgeId: string;
let ghostEdgeId: string;
let correctEdgeId: string;
let manifestDir: string;

function runCli(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    cwd: MCP_ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

async function edge(id: string) {
  const r = await db.query(`SELECT to_type, metadata FROM links WHERE id = $1`, [id]);
  return r.rows[0] as { to_type: string; metadata: Record<string, unknown> } | undefined;
}

beforeAll(async () => {
  manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-mistyped-'));
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'repair-mistyped contract') RETURNING id`,
      [`repair-mistyped-${STAMP}`],
    )
  ).rows[0].id;
  const dec = async (title: string) =>
    (
      await db.query(
        `INSERT INTO technical_decisions (project_id, decision_type, title, description, rationale, impact_level)
         VALUES ($1, 'pattern', $2, 'd', 'r', 'medium') RETURNING id::text AS id`,
        [projectId, title],
      )
    ).rows[0].id;
  decisionId = await dec('source decision');
  otherDecisionId = await dec('target decision');
  contextId = (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'code', 'evidence') RETURNING id::text AS id`,
      [projectId],
    )
  ).rows[0].id;
  ghostId = randomUUID();

  const link = async (toId: string) =>
    (
      await db.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, metadata)
         VALUES ($1, 'decision', $2, 'decision', 'decided_by', $3, 'auto:decision_record', 'decision-evidence', '{"ref":"seeded"}'::jsonb)
         RETURNING id::text AS id`,
        [decisionId, toId, projectId],
      )
    ).rows[0].id;
  mistypedEdgeId = await link(contextId); // resolves to a CONTEXT — mis-typed
  ghostEdgeId = await link(ghostId); // resolves to NOTHING
  correctEdgeId = await link(otherDecisionId); // correct
});

afterAll(async () => {
  await db.query(`DELETE FROM links WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM technical_decisions WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  fs.rmSync(manifestDir, { recursive: true, force: true });
});

describe('repair-mistyped-decision-edges', () => {
  test('DRY RUN classifies all three and writes NOTHING', async () => {
    const { status, out } = runCli(['--project', projectId]);
    expect(status, out).toBe(0);
    expect(out).toContain('DRY RUN');
    expect(out).toMatch(/RETYPE -> context \(same project\)\s+: 1\b/);
    expect(out).toMatch(/DELETE \(resolves to nothing\)\s+: 1\b/);
    // The correct edge is not in the population at all — it resolves to a decision.
    expect(out).not.toContain(correctEdgeId);

    expect((await edge(mistypedEdgeId))?.to_type).toBe('decision');
    expect(await edge(ghostEdgeId)).toBeDefined();
    expect((await edge(correctEdgeId))?.to_type).toBe('decision');
  });

  test('--apply without --i-mean-it REFUSES (exit 2) and writes nothing', async () => {
    const manifest = path.join(manifestDir, 'refused.json');
    const { status, out } = runCli(['--project', projectId, '--apply', '--manifest', manifest]);
    expect(status, out).toBe(2);
    expect(fs.existsSync(manifest)).toBe(false);
    expect((await edge(mistypedEdgeId))?.to_type).toBe('decision');
    expect(await edge(ghostEdgeId)).toBeDefined();
  });

  test('--apply without --manifest REFUSES (exit 2): the manifest is the only undo for deletes', async () => {
    const { status } = runCli(['--project', projectId, '--apply', '--i-mean-it']);
    expect(status).toBe(2);
    expect(await edge(ghostEdgeId)).toBeDefined();
  });

  test('APPLY re-types the context edge with a provenance stamp, deletes the ghost, leaves the correct one, writes the manifest', async () => {
    const manifest = path.join(manifestDir, 'apply.json');
    const { status, out } = runCli([
      '--project', projectId, '--apply', '--i-mean-it', '--manifest', manifest,
    ]);
    expect(status, out).toBe(0);
    expect(out).toContain('APPLIED');

    const retyped = await edge(mistypedEdgeId);
    expect(retyped?.to_type).toBe('context');
    // created_by is NOT rewritten; provenance lives in metadata.repair so the undo can scope on it.
    const repair = (retyped?.metadata as any).repair;
    expect(repair?.script).toBe('repair-mistyped-decision-edges');
    expect(repair?.from_to_type).toBe('decision');
    expect((retyped?.metadata as any).ref, 'existing metadata keys survive the stamp').toBe('seeded');
    const cb = await db.query(`SELECT created_by FROM links WHERE id = $1`, [mistypedEdgeId]);
    expect(cb.rows[0].created_by).toBe('auto:decision_record');

    expect(await edge(ghostEdgeId)).toBeUndefined();
    expect((await edge(correctEdgeId))?.to_type).toBe('decision');

    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    expect(m.retypedIds).toEqual([mistypedEdgeId]);
    expect(m.deletedRows).toHaveLength(1);
    expect(m.deletedRows[0].id).toBe(ghostEdgeId);
    expect(m.deletedRows[0].to_id).toBe(ghostId);
  });

  test('a second APPLY is a no-op — the population is now empty', async () => {
    const manifest = path.join(manifestDir, 'apply2.json');
    const { status, out } = runCli([
      '--project', projectId, '--apply', '--i-mean-it', '--manifest', manifest,
    ]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/APPLIED: 0 link\(s\)/);
  });

  test('UNDO dry run writes nothing; UNDO apply restores the re-type and re-inserts the deleted row', async () => {
    const manifest = path.join(manifestDir, 'apply.json');
    const dry = runCli(['--undo', '--manifest', manifest]);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain('UNDO DRY RUN');
    expect((await edge(mistypedEdgeId))?.to_type).toBe('context');
    expect(await edge(ghostEdgeId)).toBeUndefined();

    const applied = runCli(['--undo', '--manifest', manifest, '--apply', '--i-mean-it']);
    expect(applied.status, applied.out).toBe(0);
    expect(applied.out).toContain('UNDO APPLIED');
    expect(applied.out).toMatch(/1 row\(s\) re-typed back to decision/);
    expect(applied.out).toMatch(/1 deleted row\(s\) re-inserted/);

    const restored = await edge(mistypedEdgeId);
    expect(restored?.to_type).toBe('decision');
    expect((restored?.metadata as any).repair, 'the provenance stamp is stripped on undo').toBeUndefined();
    expect((restored?.metadata as any).ref).toBe('seeded');
    const ghost = await db.query(`SELECT id, to_id, created_by, mint_via FROM links WHERE id = $1`, [ghostEdgeId]);
    expect(ghost.rows).toHaveLength(1);
    expect(ghost.rows[0].to_id).toBe(ghostId);
    expect(ghost.rows[0].mint_via).toBe('decision-evidence');
  });

  test('CROSS_PROJECT: a context in another project is reported and NOT touched', async () => {
    const otherProject = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'x') RETURNING id`,
        [`repair-mistyped-other-${STAMP}`],
      )
    ).rows[0].id;
    try {
      const foreignCtx = (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'code', 'foreign') RETURNING id::text AS id`,
          [otherProject],
        )
      ).rows[0].id;
      const xId = (
        await db.query(
          `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
           VALUES ($1, 'decision', $2, 'decision', 'decided_by', $3, 'auto:decision_record', 'decision-evidence')
           RETURNING id::text AS id`,
          [decisionId, foreignCtx, projectId],
        )
      ).rows[0].id;
      const manifest = path.join(manifestDir, 'cross.json');
      const { status, out } = runCli([
        '--project', projectId, '--apply', '--i-mean-it', '--manifest', manifest,
      ]);
      expect(status, out).toBe(0);
      expect(out).toMatch(/CROSS_PROJECT context — untouched\s+: 1\b/);
      expect((await edge(xId))?.to_type).toBe('decision');
      await db.query(`DELETE FROM links WHERE id = $1`, [xId]);
      await db.query(`DELETE FROM contexts WHERE project_id = $1`, [otherProject]);
    } finally {
      await db.query(`DELETE FROM projects WHERE id = $1`, [otherProject]);
    }
  });
});
