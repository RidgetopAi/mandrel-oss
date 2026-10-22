/**
 * Named refs (`ref:<slug>`) — first-class contract test.
 *
 * Proves the two backend guarantees that make a named ref a real product feature
 * (not just a hand-maintained convention), driving the REAL routeExecutor + REAL
 * Postgres (disposable DB created by scripts/test-named-refs.sh, dropped on exit —
 * NEVER the production `mandrel` DB):
 *
 *   1. GRAMMAR VALIDATION at the write boundary (context_store):
 *      - A well-formed `ref:resume` is stored verbatim (no warning).
 *      - A malformed `ref:My Resume` is NORMALIZED to `ref:my-resume`, the stored row
 *        carries the normalized tag, and the store response surfaces a warning.
 *      - A non-ref tag (`audit`, `task:abc12345`) is passed through untouched (the
 *        validation must not disturb the existing tag grammar).
 *
 *   2. MOVING-REF RESOLUTION is newest-first:
 *      - Three contexts stored over time all tagged `ref:resume`; a tags-only
 *        `context_search({ tags: ["ref:resume"] })` returns them newest-first, so the
 *        FIRST result is the LATEST handoff. This is the "read in on ref:resume" path.
 *      - A PINNED ref (`ref:cp-gaps`, one context) resolves to exactly that context.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';
import { randomUUID } from 'node:crypto';

// Distinct UUIDs per lazily-created session (global setup mocks randomUUID).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings (native transformers/sharp unavailable in CI/sandbox). The FULL
// real DB write + tag-normalization + tags-only resolution path still runs.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import {
  validateAndNormalizeRefTags,
  isValidRefTag,
  normalizeRefSlug,
} from '../utils/refs.js';

const STAMP = Date.now();
const CONN = `named-refs-conn-${STAMP}`;
const PROJ_NAME = `named-refs-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.[0]?.text ?? '';
}

function parseContextId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse context id from response: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}

async function tagsOf(contextId: string): Promise<string[]> {
  const r = await db.query('SELECT tags FROM contexts WHERE id = $1', [contextId]);
  return r.rows[0]?.tags ?? [];
}

/** Store a context and force created_at to a fixed instant (to make ordering deterministic). */
async function storeWithCreatedAt(content: string, tags: string[], createdAtIso: string): Promise<string> {
  const resp = await routeExecutor(
    'context_store',
    { content, type: 'handoff', tags },
    { connectionId: CONN }
  );
  const id = parseContextId(resp);
  await db.query('UPDATE contexts SET created_at = $1 WHERE id = $2', [createdAtIso, id]);
  return id;
}

describe('named refs: grammar (pure)', () => {
  test('isValidRefTag accepts the canonical grammar and rejects garbage', () => {
    expect(isValidRefTag('ref:resume')).toBe(true);
    expect(isValidRefTag('ref:cp-gaps')).toBe(true);
    expect(isValidRefTag('ref:audit-retrieval-2')).toBe(true);
    expect(isValidRefTag('ref:Resume')).toBe(false);   // uppercase
    expect(isValidRefTag('ref:my resume')).toBe(false); // space
    expect(isValidRefTag('ref:-bad')).toBe(false);      // leading hyphen
    expect(isValidRefTag('ref:')).toBe(false);          // empty slug
    expect(isValidRefTag('task:abc12345')).toBe(false); // not a ref at all
  });

  test('normalizeRefSlug salvages common human inputs and is a fixed point on valid slugs', () => {
    expect(normalizeRefSlug('My Resume')).toBe('my-resume');
    expect(normalizeRefSlug('cp_gaps')).toBe('cp-gaps');
    expect(normalizeRefSlug('Audit/Retrieval')).toBe('audit-retrieval');
    expect(normalizeRefSlug('resume')).toBe('resume'); // already valid → unchanged
    expect(normalizeRefSlug('___')).toBeNull();        // nothing salvageable
  });

  test('validateAndNormalizeRefTags leaves non-ref tags untouched and in order', () => {
    const { tags, warnings } = validateAndNormalizeRefTags(['audit', 'task:abc12345', 'ref:resume']);
    expect(tags).toEqual(['audit', 'task:abc12345', 'ref:resume']);
    expect(warnings).toHaveLength(0);
  });

  test('validateAndNormalizeRefTags normalizes a malformed ref and warns', () => {
    const { tags, warnings } = validateAndNormalizeRefTags(['ref:My Resume', 'keep-me']);
    expect(tags).toEqual(['ref:my-resume', 'keep-me']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ref:my-resume');
  });
});

describe('named refs: write-boundary + resolution (real DB)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'named-refs contract') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch { /* ignore */ }
    await db.end();
  });

  test('well-formed ref stored verbatim, no warning surfaced', async () => {
    // TYPE IS DELIBERATELY NOT `handoff` (changed for an earlier task). This test's subject is
    // the REF GRAMMAR — "a well-formed ref is stored verbatim and produces no tag note" — and
    // a `handoff` now additionally gets `ref:resume` appended with a note, which would make
    // this assertion about a second feature. The handoff interaction is asserted where it
    // belongs, in handoffResumePointer.contract.test.ts (a ref tag the caller passed on a
    // handoff is preserved, and `ref:Resume` still folds to the canonical spelling).
    const resp = await routeExecutor(
      'context_store',
      { content: 'clean ref store', type: 'completion', tags: ['ref:cp-gaps', 'audit'] },
      { connectionId: CONN }
    );
    const id = parseContextId(resp);
    expect(await tagsOf(id)).toEqual(['ref:cp-gaps', 'audit']);
    expect(responseText(resp)).not.toContain('Tag notes');
  });

  test('malformed ref is normalized on write AND a warning is surfaced', async () => {
    const resp = await routeExecutor(
      'context_store',
      // Not `handoff` — same reason as the test above: the subject here is
      // ref normalization + its warning, not the handoff resume-pointer guarantee.
      { content: 'typo ref store', type: 'completion', tags: ['ref:My Resume', 'keep'] },
      { connectionId: CONN }
    );
    const id = parseContextId(resp);
    // Stored row carries the NORMALIZED ref, untouched non-ref tag preserved.
    expect(await tagsOf(id)).toEqual(['ref:my-resume', 'keep']);
    // The caller is told what changed (no silent rewrite).
    const text = responseText(resp);
    expect(text).toContain('Tag notes');
    expect(text).toContain('ref:my-resume');
  });

  test('MOVING ref (ref:resume) resolves newest-first via tags-only search', async () => {
    // Three handoffs, oldest → newest, all carrying the same moving ref.
    const oldId = await storeWithCreatedAt('HANDOFF v1 (oldest)', ['ref:resume'], '2026-06-01T10:00:00Z');
    const midId = await storeWithCreatedAt('HANDOFF v2 (middle)', ['ref:resume'], '2026-06-10T10:00:00Z');
    const newId = await storeWithCreatedAt('HANDOFF v3 (newest)', ['ref:resume'], '2026-06-18T10:00:00Z');

    const resp = await routeExecutor(
      'context_search',
      { tags: ['ref:resume'], limit: 10 },
      { connectionId: CONN }
    );
    const text = responseText(resp);

    // The first listed result must be the NEWEST handoff (the one you resume on).
    const idxNew = text.indexOf(newId);
    const idxMid = text.indexOf(midId);
    const idxOld = text.indexOf(oldId);
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxMid).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeGreaterThanOrEqual(0);
    // newest appears before middle appears before oldest in the rendered, ordered list
    expect(idxNew).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxOld);
    // And the rendered content of result #1 is the newest one.
    expect(text.indexOf('HANDOFF v3 (newest)')).toBeLessThan(text.indexOf('HANDOFF v2 (middle)'));
  });

  test('PINNED ref resolves to its single thread', async () => {
    // SELF-ISOLATED (order-independent): this test stores its OWN pinned ref with a
    // per-run-UNIQUE slug + content marker and asserts on THAT tag alone. It must not
    // depend on the sibling 'well-formed ref' test's `ref:cp-gaps` context having run
    // first (a within-file test-shuffle reorders siblings → that context is absent →
    // "No contexts found"), nor can another file's `ref:cp-gaps` tag bleed into the
    // count. A unique slug guarantees the tags-only search matches exactly the one
    // context this test created — proving the pinned-ref → single-thread contract
    // (Found 1 + its content) regardless of execution order.
    const pinSlug = `pinned-${STAMP}-${randomUUID().slice(0, 8)}`;
    const pinTag = `ref:${pinSlug}`;
    const pinMarker = `PINNED single-thread payload ${pinSlug}`;

    const storeResp = await routeExecutor(
      'context_store',
      // Not `handoff` — same reason as above: a handoff would additionally
      // carry `ref:resume`, which is a different feature than "a PINNED ref resolves to its
      // single thread".
      { content: pinMarker, type: 'completion', tags: [pinTag, 'audit'] },
      { connectionId: CONN }
    );
    const pinId = parseContextId(storeResp);
    // Valid ref slug → stored verbatim (this is also the pinned single context).
    expect(await tagsOf(pinId)).toEqual([pinTag, 'audit']);

    const resp = await routeExecutor(
      'context_search',
      { tags: [pinTag], limit: 10 },
      { connectionId: CONN }
    );
    const text = responseText(resp);
    expect(text).toContain(pinMarker);
    expect(text).toContain('Found 1 contexts');
  });
});
