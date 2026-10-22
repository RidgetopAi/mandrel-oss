/**
 * PROOF 5 — TAG VALIDATION ON THE TASK AND DECISION WRITE PATHS: WARN AND STORE, NEVER
 * REJECT (SCOPE §3.3, folded into P5.5 by §8.6).
 *
 * ═══ THE DEFECT ═══
 * `validateAndNormalizeTags` had exactly two callers — `handlers/context.ts:302` and `:1414`.
 * `decision_record` and `task_create/task_update` stored tags COMPLETELY RAW: unvalidated,
 * un-normalized, unwarned. That is why the `tranche:` census (Mandrel `066c7a42`) found 60%
 * of values out-of-enum: two of the three write surfaces had no boundary at all.
 *
 * ═══ 🔴 THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT *NOT* REJECTING ═══
 * `utils/threadingTags.ts` states the contract: "NEVER throws, NEVER rejects, NEVER
 * drops a tag." This change rides inside a schema migration and reaches every customer at
 * once. If it rejected anything, it would be a BREAKING CHANGE in the worst possible
 * packaging — a customer whose tags have always been accepted would find their writes
 * failing after a routine upgrade, with a migration in the same release to muddy the
 * diagnosis. So the load-bearing tests here are the ones asserting the write SUCCEEDED and
 * the tag SURVIVED, not the ones asserting a warning appeared.
 *
 * ═══ AMENDED BY an earlier task — SURVIVED, BUT NO LONGER DISGUISED ═══
 * The contract above is UNCHANGED and still asserted here: every write below still
 * succeeds and no tag is dropped. What changed is the FORM the surviving tag takes.
 * Keeping an unusable value VERBATIM shipped a second defect one layer over — the row
 * then carries a tag that reads, sorts and displays as a working threading tag while
 * threading nothing, and the only signal saying otherwise is a warning in a 200 response
 * that no human reads. So an unsalvageable threading value is now QUARANTINED
 * (`tranche:xyz` → `invalid-tranche:xyz`): stored, recoverable, warned about, and no
 * longer wearing a prefix it cannot honour.
 *
 * The expected strings below are DERIVED from `THREADING_QUARANTINE_PREFIX`, never typed
 * out. A test that hand-copies the marker is a fourth place the marker can drift (C4).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

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
import { THREADING_QUARANTINE_PREFIX, isThreadingTag } from '../utils/threadingTags.js';

const STAMP = Date.now();
const CONN = `p55-tags-${STAMP}`;
let projectId: string;

async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN, actor: 'p55-test' });
}
function text(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/**
 * A tag that is DEFINITELY out of enum: it wears the `tranche:` threading prefix with a
 * value the grammar does not expect. Chosen because `tranche:` is the exact prefix the
 * census measured at 60% out-of-enum — the population this whole item exists for.
 */
const OUT_OF_ENUM = 'tranche:definitely-not-a-declared-risk-class';
/** The form it is STORED in. DERIVED from the marker — never hand-copied. */
const QUARANTINED = `${THREADING_QUARANTINE_PREFIX}${OUT_OF_ENUM}`;
/** An ordinary tag with no threading prefix: it must pass through completely untouched. */
const INNOCENT = `p55-plain-tag-${STAMP}`;

/**
 * THE PROPERTY THE QUARANTINE EXISTS FOR, asserted once here and reused below: the stored
 * form must not be readable as a threading tag by the product's OWN prefix matcher. This
 * is the assertion that would catch a marker chosen badly enough to re-match (e.g. one
 * that still begins `tranche:`), which no amount of string comparison would notice.
 */
function expectQuarantinedNotThreading(tags: string[]): void {
  expect(tags, 'the tag must SURVIVE the write — nothing is ever dropped').toContain(QUARANTINED);
  expect(tags, 'the misleading verbatim form must be GONE from the row').not.toContain(OUT_OF_ENUM);
  expect(isThreadingTag(QUARANTINED), 'quarantined form still parses as a threading tag')
    .toBe(false);
}

describe('SCOPE §3.3 — task and decision write paths WARN and STORE', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'p55 tag validation') RETURNING id`,
        [`p55-tags-${STAMP}`],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!projectId) return;
    await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  test('task_create: an out-of-enum tag is STORED (quarantined), not rejected', async () => {
    const resp = await viaTool('task_create', {
      projectId,
      title: `p55 tag task ${STAMP}`,
      tags: [OUT_OF_ENUM, INNOCENT],
    });
    // 1. THE WRITE SUCCEEDED. This is the assertion that would catch a breaking change.
    expect(text(resp)).toContain('Task created successfully');
    const taskId = resp.structuredContent?.task?.id;
    expect(taskId, 'no task id came back — the write did not happen').toBeTruthy();

    // 2. THE TAG SURVIVED, in the DATABASE, not merely in the response. Read from the row:
    //    a response echo can be assembled from the request and prove nothing about storage.
    const { rows } = await db.query('SELECT tags FROM tasks WHERE id = $1', [taskId]);
    expectQuarantinedNotThreading(rows[0].tags);
    expect(rows[0].tags, 'a tag with no threading prefix must pass through untouched')
      .toContain(INNOCENT);

    // 3. …AND A WARNING WAS SURFACED TO THE CALLER, in both channels.
    expect(resp.structuredContent?.task?.tagWarnings?.length ?? 0).toBeGreaterThan(0);
    expect(text(resp)).toContain('Tag notes');
    expect(text(resp)).toContain('nothing was rejected or dropped');
  });

  test('task_update: a re-tag with an out-of-enum tag is STORED (quarantined), not rejected', async () => {
    const created = await viaTool('task_create', {
      projectId, title: `p55 retag task ${STAMP}`, tags: ['scope:product'],
    });
    const taskId = created.structuredContent.task.id;
    const resp = await viaTool('task_update', { projectId, taskId, tags: [OUT_OF_ENUM] });
    expect(resp.structuredContent?.ok ?? true).not.toBe(false);
    const { rows } = await db.query('SELECT tags FROM tasks WHERE id = $1', [taskId]);
    expectQuarantinedNotThreading(rows[0].tags);
    expect(text(resp)).toContain('Tag notes');
  });

  test('decision_record: an out-of-enum tag is STORED (quarantined), not rejected', async () => {
    const resp = await viaTool('decision_record', {
      projectId,
      decisionType: 'architecture',
      title: `p55 tag decision ${STAMP}`,
      description: 'x',
      rationale: 'y',
      impactLevel: 'low',
      tags: [OUT_OF_ENUM, INNOCENT],
    });
    expect(text(resp)).toContain('Technical decision recorded');
    const id = resp.structuredContent?.decision?.id;
    expect(id).toBeTruthy();
    const { rows } = await db.query('SELECT tags FROM technical_decisions WHERE id = $1', [id]);
    expectQuarantinedNotThreading(rows[0].tags);
    expect(rows[0].tags).toContain(INNOCENT);
    expect(resp.structuredContent?.decision?.tagWarnings?.length ?? 0).toBeGreaterThan(0);
    expect(text(resp)).toContain('Tag notes');
  });

  test('decision_update: a re-tag with an out-of-enum tag is STORED (quarantined), not rejected', async () => {
    const created = await viaTool('decision_record', {
      projectId, decisionType: 'architecture', title: `p55 retag decision ${STAMP}`,
      description: 'x', rationale: 'y', impactLevel: 'low', tags: ['scope:product'],
    });
    const id = created.structuredContent.decision.id;
    await viaTool('decision_update', { projectId, decisionId: id, tags: [OUT_OF_ENUM] });
    const { rows } = await db.query('SELECT tags FROM technical_decisions WHERE id = $1', [id]);
    expectQuarantinedNotThreading(rows[0].tags);
  });

  test('THE CONTROL — a clean tag set produces NO warning at all', async () => {
    // Without this, every assertion above is satisfied by a validator that warns about
    // everything, which would be a different (and worse) product than the one described.
    const resp = await viaTool('task_create', {
      projectId, title: `p55 clean tags ${STAMP}`, tags: ['scope:product', INNOCENT],
    });
    expect(resp.structuredContent?.task?.tagWarnings ?? []).toEqual([]);
    expect(text(resp)).not.toContain('Tag notes');
  });

  test('THE EMPTY POPULATION — no tags at all is not an error and warns about nothing', async () => {
    const resp = await viaTool('task_create', { projectId, title: `p55 no tags ${STAMP}` });
    expect(text(resp)).toContain('Task created successfully');
    expect(resp.structuredContent?.task?.tagWarnings ?? []).toEqual([]);
  });
});
