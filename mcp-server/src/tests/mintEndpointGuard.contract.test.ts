/**
 * MINT-ENDPOINT GUARD — the resolveRefSafe FULL-UUID bypass (step 1).
 *
 * THE HOLE THIS CLOSES. Every endpoint resolver short-circuited a syntactically valid full
 * UUID straight through with NO existence check and NO project check:
 *
 *     if (isFullUuid(ref)) return ref;
 *
 * The resolver VALIDATES THE FORMAT YOU'RE LIKELY TO TYPE (the id8 short id — existence +
 * project scoped) and WAVES THROUGH THE FORMAT YOU'D PASTE (the full UUID). So:
 *
 *   (a) a typo'd/pasted full UUID mints an edge to a NONEXISTENT node — a dangling edge.
 *       getLinks hydrates it with a null title rather than failing, which is exactly why
 *       it stayed invisible. There is no FK backstop (endpoints span three tables).
 *   (b) a full UUID from ANOTHER PROJECT mints a cross-project edge, bypassing the
 *       project scoping that every short id gets.
 *
 * SCOPE OF THE FIX — THE MINT PATHS, deliberately not the repair path (see the last
 * describe block). Guarded: resolveRefSafe (links.ts — covers autoMintFromTags AND
 * mintExplicitLinks), LinksRoutes.resolveEndpoint (the `link` tool), ThreadRoutes.resolveRef
 * (the active-thread anchor, whose bogus id would mint on every later context_store).
 *
 * These tests are written to be RED-BY-MINTING against the pre-fix code: they assert the
 * edge is NOT created, so before the guard they fail by finding one. That is the point —
 * a guard test that passes vacuously proves nothing.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

// Deterministic, offline embeddings (mirrors typedEdges.contract).
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
import { autoMintFromTags, mintEdge } from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const CONN = `mint-guard-conn-${STAMP}`;
const PROJ_NAME = `mint-guard-P-${STAMP}`;
const OTHER_PROJ_NAME = `mint-guard-OTHER-${STAMP}`;

/**
 * A syntactically valid full UUID that matches NO row in any table. This is the exact
 * shape of the attack: a pasted id with one hex digit fat-fingered.
 */
const NONEXISTENT_UUID = '00000000-dead-beef-0000-000000000000';
const NONEXISTENT_UUID_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

let projectId: string;
let otherProjectId: string;
let otherProjectTaskId: string;

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** Every edge whose TO endpoint is `id` — the dangling-edge fuse. */
async function edgesTo(id: string): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS c FROM links WHERE to_id = $1`, [id]);
  return r.rows[0].c;
}

describe('mint-endpoint guard — full-UUID bypass', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'mint guard') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    otherProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'mint guard other') RETURNING id`,
        [OTHER_PROJ_NAME]
      )
    ).rows[0].id;
    // A REAL task that exists, but in the OTHER project — the cross-project probe.
    otherProjectTaskId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, status, priority)
         VALUES ($1, 'other-project task', 'general', 'todo', 'medium') RETURNING id`,
        [otherProjectId]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
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
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── (a) NONEXISTENT FULL UUID → NO EDGE + A SURFACED SKIP ───────────────────
  describe('a nonexistent full UUID mints nothing', () => {
    test('autoMintFromTags: task:<nonexistent full uuid> mints NO edge and SURFACES the skip', async () => {
      const ctx = (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content)
           VALUES ($1, 'planning', 'guard probe: nonexistent uuid tag') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${NONEXISTENT_UUID}`],
        projectId,
        createdBy: 'test:guard',
      });

      // THE ASSERTION THAT IS RED-BY-MINTING PRE-FIX: no edge may exist.
      expect(await edgesTo(NONEXISTENT_UUID), 'no dangling edge to a nonexistent node').toBe(0);
      expect(res.minted, 'nothing minted').toBe(0);
      // DENY + SURFACE: the skip is reported, not swallowed at debug level.
      expect(res.skips.length, 'the skip is surfaced').toBe(1);
      expect(res.skips[0].ref).toBe(NONEXISTENT_UUID);
      expect(res.skips[0].reason).toMatch(/not found|does not exist|unresolvable/i);
    });

    test('the `link` tool refuses a nonexistent full-UUID endpoint (actionable error, mints nothing)', async () => {
      const task = (
        await db.query(
          `INSERT INTO tasks (project_id, title, type, status, priority)
           VALUES ($1, 'guard link source', 'general', 'todo', 'medium') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      const resp = await viaTool('link', {
        from: task,
        fromType: 'task',
        to: NONEXISTENT_UUID_2,
        toType: 'task',
        edgeType: 'related_to',
      });

      expect(resp.isError, 'a nonexistent endpoint is an error, not a silent mint').toBe(true);
      expect(responseText(resp)).toMatch(/not found/i);
      expect(await edgesTo(NONEXISTENT_UUID_2), 'no dangling edge minted').toBe(0);
    });

    test('the `links` param (mintExplicitLinks) warns and mints nothing for a nonexistent full UUID', async () => {
      const resp = await viaTool('context_store', {
        content: 'guard probe: links param with a nonexistent full uuid',
        type: 'planning',
        links: [{ task: NONEXISTENT_UUID }],
      });

      const warnings = resp?.structuredContent?.context?.linkWarnings ?? [];
      expect(warnings.length, 'the bad link is surfaced as a warning').toBeGreaterThan(0);
      expect(await edgesTo(NONEXISTENT_UUID), 'no dangling edge minted').toBe(0);
    });
  });

  // ── (b) CROSS-PROJECT REFS ──────────────────────────────────────────────────
  //
  // CONTRACT NARROWED, DELIBERATELY (threading tranche 1). This block used to assert that a
  // cross-project FULL UUID minted nothing, on the same footing as a cross-project id8. The
  // two are not on the same footing and treating them as one rule cost us real data: measured
  // on the dev snapshot, 25 of 25 `task:<id8>` tags naming a sibling-project task minted zero
  // edges, and every one of them was a build-proof record made unreachable from its branch.
  //
  // The half of the guard that was load-bearing is the AMBIGUITY: an 8-char prefix is not
  // unique across projects, so resolving one cross-project would mint an edge to whichever
  // row happened to match. That half is unchanged and still asserted below. A full UUID
  // carries no ambiguity, so it now mints — with cross-project provenance stamped on the
  // edge, which is what makes the crossing auditable instead of merely permitted.
  //
  // NOT WIDENED: the explicit `link` TOOL still refuses a cross-project endpoint outright
  // (asserted below). It resolves through resolveMintEndpoint directly, not resolveRefSafe,
  // so the change is scoped to the auto-mint paths that read a writer's tags.
  describe('cross-project refs: an id8 is refused, an unambiguous full UUID mints with provenance', () => {
    test('autoMintFromTags: a cross-project id8 mints NOTHING and says WHERE the record lives', async () => {
      const ctx = (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content)
           VALUES ($1, 'planning', 'guard probe: cross-project id8 tag') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;
      const id8 = otherProjectTaskId.replace(/-/g, '').slice(0, 8);

      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${id8}`],
        projectId,
        createdBy: 'test:guard',
      });

      expect(
        await edgesTo(otherProjectTaskId),
        'an AMBIGUOUS short id must never resolve across a project boundary'
      ).toBe(0);
      expect(res.minted).toBe(0);
      expect(res.skips.length, 'the cross-project skip is surfaced').toBe(1);
      // MACHINE-READABLE, so this assertion does not decay into substring-matching prose.
      expect(res.skips[0].code).toBe('cross_project_ref');
      // ACTIONABLE: the message must name the project it IS in and the id that would work.
      // Before this, the writer was told only "not found in this project" and had no next
      // step — which is why all 25 real cases went unnoticed for weeks.
      expect(res.skips[0].reason).toContain(OTHER_PROJ_NAME);
      expect(res.skips[0].reason).toContain(otherProjectTaskId);
    });

    test('autoMintFromTags: a cross-project FULL UUID mints, and the edge records the crossing', async () => {
      const ctx = (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content)
           VALUES ($1, 'planning', 'guard probe: cross-project uuid tag') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${otherProjectTaskId}`],
        projectId,
        createdBy: 'test:guard',
      });

      expect(res.minted, 'an unambiguous cross-project ref mints').toBe(1);
      expect(res.skips, 'and it is not ALSO reported as a skip').toEqual([]);

      // The edge points at the RIGHT record — the whole risk of allowing this at all.
      const edge = (
        await db.query(
          `SELECT to_id::text AS to_id, metadata FROM links WHERE from_id = $1 AND to_id = $2`,
          [ctx, otherProjectTaskId]
        )
      ).rows[0];
      expect(edge, 'the edge exists').toBeTruthy();
      expect(edge.to_id).toBe(otherProjectTaskId);
      // PROVENANCE: links.project_id records the WRITER's project, so without this stamp a
      // boundary-crossing edge is indistinguishable from an in-project one in the data.
      expect(edge.metadata.cross_project).toBe(true);
      expect(edge.metadata.to_project_id).toBe(otherProjectId);
      expect(edge.metadata.cross_project_ref_form).toBe('uuid');
    });

    test('a TYPO\'D cross-project-shaped uuid still dies loudly (the fix is not "allow anything")', async () => {
      const ctx = (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content)
           VALUES ($1, 'planning', 'guard probe: typo uuid tag') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${NONEXISTENT_UUID}`],
        projectId,
        createdBy: 'test:guard',
      });

      expect(res.minted).toBe(0);
      expect(await edgesTo(NONEXISTENT_UUID)).toBe(0);
      expect(res.skips[0].code, 'a miss everywhere is not a cross-project hit').toBe('not_found');
    });

    test('the `link` tool refuses a cross-project full-UUID endpoint', async () => {
      const task = (
        await db.query(
          `INSERT INTO tasks (project_id, title, type, status, priority)
           VALUES ($1, 'guard xproj source', 'general', 'todo', 'medium') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      // ITS OWN target: the tag-path test above deliberately mints to otherProjectTaskId, so
      // reusing it here would make this assertion read the other test's edge and pass or fail
      // on file order rather than on the `link` tool's behaviour.
      const linkTarget = (
        await db.query(
          `INSERT INTO tasks (project_id, title, type, status, priority)
           VALUES ($1, 'link-tool xproj target', 'general', 'todo', 'medium') RETURNING id`,
          [otherProjectId]
        )
      ).rows[0].id;

      const resp = await viaTool('link', {
        from: task,
        fromType: 'task',
        to: linkTarget,
        toType: 'task',
        edgeType: 'related_to',
      });

      expect(resp.isError, 'cross-project endpoint rejected').toBe(true);
      expect(await edgesTo(linkTarget)).toBe(0);
    });
  });

  // ── REGRESSION: the guard must not break the GOOD paths ─────────────────────
  describe('the guard does not break valid resolution', () => {
    test('a VALID full UUID in the same project still mints (the guard denies only misses)', async () => {
      const target = (
        await db.query(
          `INSERT INTO tasks (project_id, title, type, status, priority)
           VALUES ($1, 'guard valid target', 'general', 'todo', 'medium') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;
      const ctx = (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content)
           VALUES ($1, 'planning', 'guard probe: valid uuid tag') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${target}`],
        projectId,
        createdBy: 'test:guard',
      });

      expect(res.minted, 'a real in-project full UUID still mints').toBe(1);
      expect(res.skips.length, 'no skip for a good ref').toBe(0);
      expect(await edgesTo(target)).toBe(1);
    });

    test('a VALID id8 short id still mints (unchanged path)', async () => {
      const target = (
        await db.query(
          `INSERT INTO tasks (project_id, title, type, status, priority)
           VALUES ($1, 'guard id8 target', 'general', 'todo', 'medium') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;
      const ctx = (
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content)
           VALUES ($1, 'planning', 'guard probe: id8 tag') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${target.replace(/-/g, '').slice(0, 8)}`],
        projectId,
        createdBy: 'test:guard',
      });

      expect(res.minted).toBe(1);
      expect(await edgesTo(target)).toBe(1);
    });
  });

  // ── THE REPAIR PATH STAYS OPEN (deliberate NON-guard — see the header) ──────
  //
  // resolveAnyEndpoint (unlink / get_links) is NOT strict-guarded, ON PURPOSE. It is the
  // READ + REPAIR path, and it mints nothing. Guarding it would make every ALREADY-DANGLING
  // edge (minted before this fix, incl. any on prod) permanently UNREMOVABLE — it would
  // wall off the one sanctioned remedy for the very rows the guard exists to stop creating.
  // This test PINS that decision so a future "let's be consistent" edit goes RED here and
  // has to read the reasoning first.
  describe('repair path (unlink) can still reach an already-dangling endpoint', () => {
    test('unlink removes an edge whose TO endpoint does not exist', async () => {
      const src = (
        await db.query(
          `INSERT INTO tasks (project_id, title, type, status, priority)
           VALUES ($1, 'dangling src', 'general', 'todo', 'medium') RETURNING id`,
          [projectId]
        )
      ).rows[0].id;

      // Count RELATIVE, not absolute: this assertion must measure only the edge THIS test
      // plants, so it stays honest regardless of what earlier tests in the file did or did
      // not mint (pre-fix they minted dangling edges; post-fix they do not).
      const before = await edgesTo(NONEXISTENT_UUID_2);

      // Plant a dangling edge the way the PRE-fix code would have, bypassing the routes.
      await mintEdge({
        fromId: src,
        fromType: 'task',
        toId: NONEXISTENT_UUID_2,
        toType: 'task',
        edgeType: 'related_to',
        projectId,
        createdBy: 'test:planted-dangling',
        via: EDGE_MINT_VIA.linkTool,
      });
      expect(await edgesTo(NONEXISTENT_UUID_2), 'planted').toBe(before + 1);

      const resp = await viaTool('unlink', {
        from: src,
        to: NONEXISTENT_UUID_2,
        edgeType: 'related_to',
      });

      expect(resp?.structuredContent?.action, 'the repair succeeds').toBe('removed');
      expect(await edgesTo(NONEXISTENT_UUID_2), 'dangling edge removed').toBe(before);
    });
  });
});
