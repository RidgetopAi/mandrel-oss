/**
 * HANDOFF RESUME POINTER — the acceptance contract ( * evidence an earlier note).
 *
 * WHAT WENT WRONG, and therefore what this asserts. Three handoffs were stored with
 * EMPTY tag arrays. Their EDGES were fine — a declared branch position had threaded
 * them. But "which handoff is live" is resolved by three independent consumers through
 * the `ref:resume` TAG (the boot hook, the branch board, the tree-drift cron), so all
 * three went blind at once and the next cold session resumed from a four-generations-
 * superseded handoff. The fix is a write-path guarantee; this is its guard.
 *
 * THE SURFACE THIS DRIVES — and why it is the shipped one. Every assertion below goes
 * through `validateToolArguments` -> `routeExecutor`, the exact pair the HTTP bridge
 * calls, and then reads the `contexts.tags` COLUMN back with SQL. Not the service, not
 * a re-composed pipeline: the tool in, the row out. A test that called
 * ensureResumePointer() directly would prove the function works and prove NOTHING about
 * whether the store path calls it — which is the only thing that failed on 2026-08-23.
 * (C3: a test whose setup re-builds the composition the product performs has replaced
 * the product.) The stored ROW is the proof; source is not.
 *
 * THE POPULATION THIS GUARD ENUMERATES: the `context_store` tool as routed by
 * routeExecutor, across four scenarios — a handoff with NO tags at all (the exact
 * shape that caused the incident), a handoff with unrelated tags, a handoff whose
 * caller already supplied the pointer, and a NON-handoff type. It does not and cannot
 * speak for `context_update` re-tagging, which is deliberately out of scope: the
 * guarantee is FORWARD-ONLY at create (see handoffResumePointer.ts).
 *
 * Embeddings are mocked to zeros — similarity plays no role here; determinism is the
 * point. DB target: the disposable migrated ci_* DB, never production.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { THREADING_QUARANTINE_PREFIX } from '../utils/threadingTags.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import {
  RESUME_POINTER_CONTEXT_TYPE,
  RESUME_POINTER_TAG,
} from '../config/handoffResumePointerConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'resume-pointer fixture') RETURNING id`,
      [`rptr-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `rptr-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** The STORED row's tags — the assertion surface. Never the response, never the source. */
async function storedTags(id: string): Promise<string[]> {
  const r = await db.query(`SELECT tags FROM contexts WHERE id = $1`, [id]);
  expect(r.rows.length, `context ${id} must exist in the contexts table`).toBe(1);
  return r.rows[0].tags as string[];
}

afterAll(async () => {
  if (projectIds.length > 0) {
    await db.query(`DELETE FROM contexts WHERE project_id = ANY($1::uuid[])`, [projectIds]);
    await db.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  }
});

describe('handoff resume pointer — the stored row always carries ref:resume', () => {
  test('a handoff stored with NO tags at all comes back tagged ref:resume', async () => {
    const { conn } = await freshCase('notags');
    // The exact call shape that caused the incident: type handoff, tags omitted entirely.
    const resp = await viaTool(
      'context_store',
      { content: `MODE: build\nPATH: roots -> trunk\nno-tags handoff ${STAMP}`, type: RESUME_POINTER_CONTEXT_TYPE },
      conn
    );
    const id = resp.structuredContent?.context?.id;
    expect(id, 'context_store must return an id').toBeTruthy();

    // THE PROOF: the persisted column, read straight out of Postgres.
    expect(await storedTags(id)).toEqual([RESUME_POINTER_TAG]);

    // Server-added, and SAID SO — a silent mutation of a caller's data is the thing we
    // refuse to ship. Both channels: the structured report and the human tag note.
    expect(resp.structuredContent?.context?.resumePointer).toMatchObject({
      tag: RESUME_POINTER_TAG,
      added: true,
    });
    expect(resp.structuredContent?.context?.tags).toContain(RESUME_POINTER_TAG);
    const warnings: string[] = resp.structuredContent?.context?.warnings ?? [];
    expect(warnings.some((w) => w.includes(RESUME_POINTER_TAG))).toBe(true);
    expect(resp.content?.[0]?.text ?? '').toContain(RESUME_POINTER_TAG);
  });

  test('the caller keeps every tag they passed; exactly one element is appended', async () => {
    const { conn } = await freshCase('keeps');
    // WELL-FORMED threading values on purpose. This test is about the POINTER APPEND --
    // order preserved, nothing dropped, exactly one element added -- so the sample must not
    // also exercise the threading validator. It used to pass `owner:coordinator` / `tranche:p4`,
    // which are both OUTSIDE their closed value sets; that made this assertion quietly
    // depend on what the validator does to an invalid value, and it broke when the validator
    // started quarantining them. The interaction is worth asserting -- so it
    // is asserted DELIBERATELY, in its own test below, instead of incidentally here.
    const passed = ['owner:engineering', 'tranche:safe', 'ref:cp-gaps'];
    const resp = await viaTool(
      'context_store',
      { content: `handoff with tags ${STAMP}`, type: RESUME_POINTER_CONTEXT_TYPE, tags: [...passed] },
      conn
    );
    const stored = await storedTags(resp.structuredContent.context.id);
    // Order preserved, nothing dropped or reordered, exactly one element added at the end.
    expect(stored).toEqual([...passed, RESUME_POINTER_TAG]);
  });

  test('a QUARANTINED tag keeps its position and still gets the pointer appended', async () => {
    // The interaction the test above used to cover by accident: an unusable threading value
    // is REWRITTEN in place, and that rewrite must not drop it, reorder the
    // array, or cost the caller the resume pointer. `owner:coordinator` and `tranche:p4` are the
    // real spellings this repo's own handoffs have carried, which is why they are the sample.
    const { conn } = await freshCase('quarantine');
    const resp = await viaTool(
      'context_store',
      {
        content: `handoff with unusable threading values ${STAMP}`,
        type: RESUME_POINTER_CONTEXT_TYPE,
        tags: ['owner:coordinator', 'tranche:p4', 'ref:cp-gaps'],
      },
      conn
    );
    const stored = await storedTags(resp.structuredContent.context.id);
    expect(stored).toEqual([
      `${THREADING_QUARANTINE_PREFIX}owner:coordinator`,
      `${THREADING_QUARANTINE_PREFIX}tranche:p4`,
      'ref:cp-gaps',
      RESUME_POINTER_TAG,
    ]);
    // Same LENGTH as went in, plus exactly the one appended element: a rewrite, not a drop.
    expect(stored).toHaveLength(4);
  });

  test('IDEMPOTENT: a caller who already passed ref:resume gets exactly one, unchanged', async () => {
    const { conn } = await freshCase('idem');
    const resp = await viaTool(
      'context_store',
      {
        content: `caller-supplied pointer ${STAMP}`,
        type: RESUME_POINTER_CONTEXT_TYPE,
        tags: [RESUME_POINTER_TAG, 'scope:product'],
      },
      conn
    );
    const stored = await storedTags(resp.structuredContent.context.id);
    expect(stored).toEqual([RESUME_POINTER_TAG, 'scope:product']);
    expect(stored.filter((t) => t === RESUME_POINTER_TAG).length).toBe(1);
    // Reported as NOT added, so "I passed this" is distinguishable from "Mandrel added it".
    expect(resp.structuredContent.context.resumePointer).toMatchObject({
      tag: RESUME_POINTER_TAG,
      added: false,
      note: null,
    });
    const warnings: string[] = resp.structuredContent?.context?.warnings ?? [];
    expect(warnings.some((w) => w.includes(RESUME_POINTER_TAG))).toBe(false);
  });

  test('a caller-supplied ref:Resume is folded onto the canonical tag, not duplicated', async () => {
    // The idempotency check runs AFTER refs.ts normalization, which is the whole reason it
    // can be an exact compare. If it ever moved before, this write would store BOTH spellings.
    const { conn } = await freshCase('case');
    const resp = await viaTool(
      'context_store',
      { content: `mixed-case pointer ${STAMP}`, type: RESUME_POINTER_CONTEXT_TYPE, tags: ['ref:Resume'] },
      conn
    );
    const stored = await storedTags(resp.structuredContent.context.id);
    expect(stored).toEqual([RESUME_POINTER_TAG]);
  });

  test('NO-OP on every other context type: a type:context store gains nothing', async () => {
    const { conn } = await freshCase('noop');
    const resp = await viaTool(
      'context_store',
      { content: `not a handoff ${STAMP}`, type: 'completion', tags: ['scope:product'] },
      conn
    );
    const stored = await storedTags(resp.structuredContent.context.id);
    expect(stored).toEqual(['scope:product']);
    expect(stored).not.toContain(RESUME_POINTER_TAG);
    expect(resp.structuredContent.context.resumePointer).toBeNull();
  });

  test('a tagless NON-handoff stays tagless (the empty population, probed explicitly)', async () => {
    const { conn } = await freshCase('emptynoop');
    const resp = await viaTool(
      'context_store',
      { content: `tagless completion ${STAMP}`, type: 'completion' },
      conn
    );
    expect(await storedTags(resp.structuredContent.context.id)).toEqual([]);
  });

  test('the guaranteed tag RESOLVES: a tags-only search finds the newest handoff by it', async () => {
    // The end the feature exists for. Two tagless handoffs; the pointer must resolve to the
    // NEWEST — which is also the argument for leaving the previous head's tag alone.
    const { conn } = await freshCase('resolve');
    const first = (
      await viaTool('context_store', { content: `older handoff ${STAMP}`, type: RESUME_POINTER_CONTEXT_TYPE }, conn)
    ).structuredContent.context.id;
    const second = (
      await viaTool('context_store', { content: `newer handoff ${STAMP}`, type: RESUME_POINTER_CONTEXT_TYPE }, conn)
    ).structuredContent.context.id;
    expect(await storedTags(first)).toContain(RESUME_POINTER_TAG);

    const found = await viaTool('context_search', { tags: [RESUME_POINTER_TAG], limit: 10 }, conn);
    const ids: string[] = (found.structuredContent?.results ?? []).map((c: any) => c.id);
    expect(ids.length, 'the tags-only search must return the handoffs').toBeGreaterThan(0);
    expect(ids[0]).toBe(second); // newest wins — no rewrite of the older head required
    expect(ids).toContain(first);
  });
});
