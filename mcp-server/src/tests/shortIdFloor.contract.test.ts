/**
 * SHORT-ID SHAPE FLOOR AT THE CHOKE POINT (Reviewer follow-up).
 *
 * THE CLASS. `isUuidOrShortId` — the predicate that enforces BOTH halves of a valid short id
 * (>= MIN_SHORT_ID_LENGTH hex chars, AND hex-only) — lived ONLY in the zod layer. Every ROUTE
 * argument passes through it, so the routes were safe. But `resolveEntityId` is the choke
 * point that EVERY resolution path funnels through, and it enforced NEITHER half itself.
 *
 * The tag path never touches zod: `autoMintFromTags` reads raw strings out of `tasks.tags` /
 * `contexts.tags` and hands the part after `task:` straight to the resolver. So the floor was
 * sitting at one caller's validation layer instead of at the resolver — the exact "guard has
 * a hole one layer over" shape this whole task was about (centralize the check,
 * don't leave N callers each responsible for it).
 *
 * TWO DISTINCT DEFECTS, both proven RED-by-minting before the fix:
 *
 *   (1) NO LENGTH FLOOR — a tag `task:a` resolves by prefix. In a small project a 1-char
 *       prefix matches exactly one row, so it MINTS A REAL EDGE to an essentially arbitrary
 *       record. (Found by Reviewer.)
 *
 *   (2) NO HEX CHECK — and this one survives a length-only fix, which is why it is here.
 *       The prefix is interpolated into `LIKE $1 || '%'`. It is a BOUND parameter (no SQL
 *       injection) but `_` and `%` are LIKE WILDCARDS. A tag `task:________` (8 underscores)
 *       clears any length floor and matches ANY row — measured resolving to a real task and
 *       minting a real edge. Fixing only the length would have left this open, and the
 *       "we added the floor" note would have made it look closed.
 *
 * ZERO LIVE EXPOSURE at the time of the fix: a read-only profile of prod found all 306
 * structural tag refs across 265 tagged tasks are exactly 8 hex chars — none short, none
 * non-hex. This is latent, closed before the backfill runs against those rows.
 *
 * THE FIX reuses `isUuidOrShortId` — the SAME predicate the zod layer uses — inside
 * `resolveEntityId`. One definition, now enforced where every caller funnels through it.
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
import { autoMintFromTags } from '../services/links.js';
import {
  resolveEntityId,
  IdNotFoundError,
  MIN_SHORT_ID_LENGTH,
} from '../utils/idResolver.js';

const STAMP = Date.now();
const PROJ_NAME = `shortid-floor-P-${STAMP}`;

let projectId: string;
let targetTask: string;

/** Every edge minted FROM this record. */
async function outEdgeCount(id: string): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS c FROM links WHERE from_id = $1`, [id]);
  return r.rows[0].c;
}

async function newContext(label: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'planning',$2) RETURNING id::text AS id`,
    [projectId, label]
  );
  return r.rows[0].id;
}

describe('short-id shape floor enforced at the resolver choke point', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'short id floor') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    // EXACTLY ONE task in this project — so a sloppy prefix matches unambiguously and the
    // resolver would happily return it. A project with many tasks would mask the bug behind
    // an AmbiguousIdError; the single-row case is the one that silently mints.
    targetTask = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, status, priority)
         VALUES ($1,'the only task in this project','general','todo','medium') RETURNING id::text AS id`,
        [projectId]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── (1) THE LENGTH FLOOR ───────────────────────────────────────────────────
  describe('sub-floor prefixes', () => {
    test('a 1-char tag ref mints NO edge and SURFACES the skip', async () => {
      const ctx = await newContext('probe: 1-char tag ref');
      // Sanity: the trap is real — this prefix DOES identify exactly one row by LIKE.
      expect(targetTask.startsWith(targetTask[0])).toBe(true);

      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${targetTask[0]}`],
        projectId,
        createdBy: 'test:floor',
      });

      expect(await outEdgeCount(ctx), 'no edge from a 1-char prefix').toBe(0);
      expect(res.minted).toBe(0);
      expect(res.skips.length, 'the skip is surfaced, not swallowed').toBe(1);
      expect(res.skips[0].reason).toMatch(/short|character|hex/i);
    });

    test('the resolver itself rejects every length below the floor', async () => {
      const prefix = targetTask.replace(/-/g, '');
      for (let n = 1; n < MIN_SHORT_ID_LENGTH; n++) {
        await expect(
          resolveEntityId('task', prefix.slice(0, n), projectId),
          `a ${n}-char prefix must be rejected`
        ).rejects.toBeInstanceOf(IdNotFoundError);
      }
    });

    test('a ref AT the floor still resolves (the guard denies only what is too short)', async () => {
      const id8 = targetTask.replace(/-/g, '').slice(0, MIN_SHORT_ID_LENGTH);
      await expect(resolveEntityId('task', id8, projectId)).resolves.toBe(targetTask);
    });
  });

  // ── (2) LIKE WILDCARDS — survives a length-only fix ────────────────────────
  describe('LIKE metacharacters are not valid short ids', () => {
    test('8 underscores mint NO edge (they would otherwise match ANY row)', async () => {
      const ctx = await newContext('probe: underscore wildcard tag');
      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: ['task:________'], // 8 chars — clears any length-only floor
        projectId,
        createdBy: 'test:floor',
      });
      expect(await outEdgeCount(ctx), 'a wildcard prefix mints nothing').toBe(0);
      expect(res.minted).toBe(0);
      expect(res.skips.length).toBe(1);
    });

    test('8 percent signs mint NO edge', async () => {
      const ctx = await newContext('probe: percent wildcard tag');
      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: ['task:%%%%%%%%'],
        projectId,
        createdBy: 'test:floor',
      });
      expect(await outEdgeCount(ctx)).toBe(0);
      expect(res.minted).toBe(0);
    });

    test('the resolver rejects wildcard and non-hex prefixes directly', async () => {
      for (const bad of ['________', '%%%%%%%%', 'zzzzzzzz', 'abc%defg', 'task-nam']) {
        await expect(
          resolveEntityId('task', bad, projectId),
          `"${bad}" is not a valid short id`
        ).rejects.toBeInstanceOf(IdNotFoundError);
      }
    });
  });

  // ── REGRESSION: the good paths still work ──────────────────────────────────
  describe('valid refs are unaffected', () => {
    test('a valid id8 tag still mints', async () => {
      const ctx = await newContext('probe: valid id8 tag');
      const res = await autoMintFromTags({
        fromId: ctx,
        fromType: 'context',
        tags: [`task:${targetTask.replace(/-/g, '').slice(0, 8)}`],
        projectId,
        createdBy: 'test:floor',
      });
      expect(res.minted).toBe(1);
      expect(await outEdgeCount(ctx)).toBe(1);
    });

    test('a HYPHENATED input still passes the shape check (hyphens are stripped, not rejected)', async () => {
      // The shape check must run on the NORMALIZED hex, not the raw string — otherwise a
      // pasted, hyphen-bearing prefix would be rejected as "non-hex" by the new guard. This
      // pins that the guard strips first and judges second.
      const dashed = `${targetTask.slice(0, 8)}-`;
      expect(dashed).toContain('-');
      await expect(resolveEntityId('task', dashed, projectId)).resolves.toBe(targetTask);

      // NOTE — a SEPARATE, PRE-EXISTING limitation, deliberately NOT asserted here so this
      // test does not enshrine it as intended behaviour: a dashed partial LONGER than 8 hex
      // chars (e.g. "d0922adc-8641") matches nothing, because the resolver normalizes the
      // INPUT (strips hyphens) but compares against `id::text`, which still CONTAINS them.
      // The search path gets this right (`REPLACE(id::text,'-','')`); the resolver does not.
      // Predates this work and is out of its scope — reported separately.
    });

    test('a full UUID still short-circuits unchanged', async () => {
      await expect(resolveEntityId('task', targetTask, projectId)).resolves.toBe(targetTask);
    });
  });
});
