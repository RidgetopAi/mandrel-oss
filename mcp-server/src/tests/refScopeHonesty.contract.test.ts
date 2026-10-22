/**
 * REF-RESOLUTION HONESTY — "no such record" is NOT "exists, but out of my scope"
 * (split out of 1ca8b181 as Reviewer finding N1).
 *
 * THE GAP THIS PINS
 * -----------------
 * `1ca8b181`'s acceptance required that a ref which cannot be resolved distinguish
 * *no such record* from *record exists but is outside the resolution scope I was given*.
 * Measured at `603a096` the two were byte-identical:
 *
 *     OUT-OF-SCOPE  {"minted":0,"skips":[{"ref":"a10aaa25","reason":"task \"a10aaa25\" not found in this project"}]}
 *     NOT-FOUND     {"minted":0,"skips":[{"ref":"deadbeef","reason":"task \"deadbeef\" not found in this project"}]}
 *
 * An agent that names a real task from the WRONG PROJECT got the same message as one that
 * typo'd an id, so it could not tell "I'm in the wrong project" from "that id is wrong."
 * That distinction is the entire point of a scoped graph.
 *
 * WHAT IS ASSERTED
 * ----------------
 * THREE outcomes, THREE distinct answers, through the real public path
 * (validate → routeExecutor) with the ROWS IN `links` as the observable for the in-scope
 * case — not a helper's return value (the standard `1ca8b181` set).
 *
 *   IN-SCOPE      → an edge exists in `links`, no skip.
 *   OUT-OF-SCOPE  → NO edge, code 'cross_project_ref', and the reason NAMES the project the
 *                   record actually lives in AND the full uuid to pass instead. A distinct
 *                   `code` alone is not enough: the remedy is what makes it actionable.
 *   NOT-FOUND     → NO edge, code 'not_found', and the reason names NO project (there is
 *                   none to name — saying one would be a fabricated hint).
 *   BAD SHAPE     → NO edge, and a fourth distinct answer — but it is no longer given at
 *                   the resolution layer, so it is no longer a skip code. See below.
 *
 * WHY BAD SHAPE MOVED LAYER (batch 6, lane M-7 + this repair)
 * ----------------------------------------------------------
 * This file originally asserted BAD SHAPE as `code: 'bad_id_shape'` from `resolveRefSafe`,
 * driven through a TAG (`task:nothex!!`). Lane M-7 made an unusable threading value
 * QUARANTINE at the write boundary (`utils/threadingTags.ts`): the tag is rewritten to
 * `invalid-task:nothex!!`, which wears no threading prefix, so `tagToEdgeIntent` never
 * matches it and ref-resolution is never reached. The skip list is empty — correctly.
 *
 * THE PROPERTY IS NOT WEAKENED BY THAT; IT SPANS TWO SURFACES NOW, AND BOTH ARE ASSERTED:
 *   - through a TAG, bad shape is answered by the validator: the value is quarantined into
 *     a form no reader can mistake for a working threading tag, and a warning naming the
 *     original value is returned on the write. That is a LOUDER answer than the skip it
 *     replaced, because it also survives in the stored row.
 *   - through the `links:` parameter, bad shape is answered even earlier: the shared
 *     `uuidOrShortId()` refinement REFUSES THE CALL. There is no write and no skip.
 *
 * MEASURED while writing this, and it is why the fix was not "assert bad_id_shape through
 * `links:` instead": `links.to` and every other id param use the SAME predicate the
 * resolver uses (`utils/idResolver.ts isUuidOrShortId`), so a value that reaches
 * `resolveRefSafe` through a validated param can never be shape-rejected by it.
 * `bad_id_shape` is not reachable from any public write path that surfaces it.
 *
 * FOUR OUTCOMES, FOUR PAIRWISE-DISTINCT ANSWERS — asserted explicitly over the whole
 * observable answer (edges · skip code · skip reason · quarantine · warning), not over the
 * skip code alone. A refactor that collapses the branches in EITHER layer breaks it while
 * every individual case still "passes", which is the failure this assertion exists for.
 *
 * ENUMERATION-ORACLE CARE (called out in the task): the cross-project answer is only ever
 * given about projects inside the caller's own instance — Mandrel's tenant isolation is at
 * the INSTANCE level (per-tenant containers + per-tenant DB), so "exists elsewhere" here
 * never crosses a tenant boundary. The last case pins that the disclosure is bounded to
 * naming the project + id, and is not a listing of any project's contents.
 *
 * MUTATION PROBE: collapse the branches in services/links.ts:resolveRefSafe — return the
 * plain `not found in this project` reason for the cross-project hit — and the OUT-OF-SCOPE
 * case plus the pairwise-distinct case go RED while IN-SCOPE and NOT-FOUND stay GREEN.
 * SECOND PROBE, for the layer that moved: narrow `utils/threadingTags.ts` back to a private
 * 8-hex pattern and THE REMEDY test below goes RED — following the cross-project message's
 * own instruction (`task:<full uuid>`) stops minting an edge. That regression shipped in
 * this batch and this file is where it is caught, because this file is where the remedy is
 * promised.
 *
 * DB target: the disposable migrated ci_* DB — never production.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim } from './helpers/embedGeometry.js';

// Zero vectors: similarity is irrelevant here, and zeros keep the inference fallback from
// minting an extra edge so the link counts measure ONLY the tag path.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: new Array(embedDim()).fill(0),
      model: 'stub-zero',
      dimensions: embedDim(),
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { THREADING_QUARANTINE_PREFIX, isQuarantinedThreadingTag } from '../utils/threadingTags.js';

const STAMP = Date.now();
const HOME_PROJECT = `refscope-home-${STAMP}`;
const OTHER_PROJECT = `refscope-other-${STAMP}`;
/** Well-FORMED (never rejected on shape) and matching no row in any project. */
const NO_SUCH_ID8 = 'deadbe0f';
/** Not a usable id at all — too short / non-hex once the prefix is stripped. */
const BAD_SHAPE_REF = 'nothex!!';

const projectIds: string[] = [];
let homeProjectId = '';
let otherProjectId = '';
let homeTaskId = '';
let otherTaskId = '';
// TWO CONNECTIONS, deliberately. `task_create` AUTO-OPENS a branch position on the task it
// creates, and a positioned write mints a membership `informs` edge — which would land in
// `links` alongside (or instead of) the tag edge and make every assertion below ambiguous.
// The setup connection creates the fixtures; the probe connection never creates anything, so
// it is unpositioned and the ONLY edge a probe write can produce is the tag edge under test.
const setupConn = `refscope-setup-${STAMP}`;
const probeConn = `refscope-probe-${STAMP}`;

async function viaTool(toolName: string, rawArgs: any, conn: string = setupConn): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const responseText = (r: any): string => r?.content?.map((c: any) => c.text).join('\n') ?? '';
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function mkProject(name: string): Promise<string> {
  const id = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, '085e1cb4 fixture') RETURNING id`, [name])
  ).rows[0].id;
  projectIds.push(id);
  return id;
}

/** Store a capture in the HOME project tagged at `ref`, and return its skip report + edges. */
async function storeTagged(
  ref: string
): Promise<{ skips: any[]; edgesInDb: any[]; ctxId: string; tags: string[]; warnings: string[] }> {
  const resp = await viaTool('context_store', {
    content: `refscope probe for "${ref}"`,
    type: 'completion',
    tags: [`task:${ref}`],
    projectId: homeProjectId,
  }, probeConn);
  const ctxId = resp.structuredContent.context.id;
  const edgesInDb = (
    await db.query(`SELECT to_id::text AS to_id, edge_type FROM links WHERE from_id = $1`, [ctxId])
  ).rows;
  return {
    skips: resp.structuredContent.context.tagEdgeSkips ?? [],
    edgesInDb,
    ctxId,
    // The write-boundary half of the answer. `tags` is read back from the STORED row, so a
    // quarantine is observed where it actually outlives the request, not from a helper.
    tags: (resp.structuredContent.context.tags ?? []) as string[],
    warnings: (resp.structuredContent.context.warnings ?? []) as string[],
  };
}

describe('ref-resolution honesty — not-found vs out-of-scope', () => {
  beforeAll(async () => {
    homeProjectId = await mkProject(HOME_PROJECT);
    otherProjectId = await mkProject(OTHER_PROJECT);
    await routeExecutor('project_switch', { project: homeProjectId }, { connectionId: setupConn });
    await routeExecutor('project_switch', { project: homeProjectId }, { connectionId: probeConn });
    homeTaskId = parseId(await viaTool('task_create', { title: 'in-scope task', type: 'feature', projectId: homeProjectId }));
    otherTaskId = parseId(await viaTool('task_create', { title: 'out-of-scope task', type: 'feature', projectId: otherProjectId }));
    // The fixture is only meaningful if the two id8s differ (they are random uuids; a
    // collision would silently make the OUT-OF-SCOPE case an in-scope one).
    expect(id8(homeTaskId)).not.toBe(id8(otherTaskId));
  });

  afterAll(async () => {
    for (const pid of projectIds) {
      try {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      } catch { /* teardown noise */ }
    }
    await db.end();
  });

  test('IN-SCOPE: the edge exists in `links` and nothing is skipped', async () => {
    const { skips, edgesInDb } = await storeTagged(id8(homeTaskId));
    expect(skips).toEqual([]);
    expect(edgesInDb).toEqual([{ to_id: homeTaskId, edge_type: 'informs' }]);
  });

  test('OUT-OF-SCOPE: no edge, code cross_project_ref, and the reason names the project AND the full uuid', async () => {
    const { skips, edgesInDb } = await storeTagged(id8(otherTaskId));
    expect(edgesInDb).toEqual([]); // a short id is NOT resolved across projects — correct
    expect(skips).toHaveLength(1);
    expect(skips[0].code).toBe('cross_project_ref');
    // ACTIONABLE, not merely distinct: where it lives, and what to pass instead.
    expect(skips[0].reason).toContain(OTHER_PROJECT);
    expect(skips[0].reason).toContain(otherTaskId);
  });

  test('NOT-FOUND: no edge, code not_found, and NO project is named (there is none to name)', async () => {
    const { skips, edgesInDb } = await storeTagged(NO_SUCH_ID8);
    expect(edgesInDb).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0].code).toBe('not_found');
    expect(skips[0].reason).not.toContain(OTHER_PROJECT);
    expect(skips[0].reason).not.toContain(HOME_PROJECT);
  });

  test('BAD SHAPE via a TAG: answered at the write boundary — quarantined + warned, no edge, and NO resolution skip', async () => {
    const { skips, edgesInDb, tags, warnings } = await storeTagged(BAD_SHAPE_REF);
    expect(edgesInDb).toEqual([]);
    // ASSERTED, NOT ASSUMED: the answer is no longer given at the resolution layer. An
    // empty skip list here is the positive evidence that the interception happened
    // earlier — if a future change lets a malformed value through to resolveRefSafe again,
    // this goes RED and the two assertions below stop describing the shipped behaviour.
    expect(skips).toEqual([]);
    // The half that outlives the request: the stored tag cannot be mistaken for one that
    // threads. `isQuarantinedThreadingTag` is the exported predicate, not a second copy of
    // the marker spelling.
    expect(tags).toEqual([`${THREADING_QUARANTINE_PREFIX}task:${BAD_SHAPE_REF}`]);
    expect(tags.some(isQuarantinedThreadingTag)).toBe(true);
    // The half the author reads: one warning, naming the value they wrote and the fact
    // that it does not thread. A quarantine that said nothing would be the silent drop.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(BAD_SHAPE_REF);
    expect(warnings[0]).toContain('does not thread');
  });

  test('BAD SHAPE via the `links:` param: refused at the schema edge — no write happens at all', async () => {
    const content = `refscope links-param bad shape ${STAMP}`;
    await expect(
      viaTool('context_store', {
        content,
        type: 'completion',
        projectId: homeProjectId,
        links: [{ toType: 'task', to: BAD_SHAPE_REF, edgeType: 'informs' }],
      }, probeConn)
    ).rejects.toThrow(/must be a full UUID or a short id/);
    // The refusal is a REFUSAL, not a partial write with a warning: nothing landed.
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM contexts WHERE content = $1`, [content]);
    expect(rows[0].n).toBe(0);
  });

  test('THE REMEDY THE CROSS-PROJECT MESSAGE GIVES ACTUALLY WORKS: re-tagging with the full uuid mints the edge', async () => {
    // The OUT-OF-SCOPE test above asserts the message SAYS "Re-tag with the FULL uuid
    // (task:<uuid>)". This asserts that DOING it works — the two together are the honest
    // pair, and only this half can catch a write-boundary change that quarantines the very
    // form the message recommends. It caught exactly that in batch 6.
    const { skips, edgesInDb, tags, warnings } = await storeTagged(otherTaskId);
    expect(tags).toEqual([`task:${otherTaskId}`]); // stored verbatim — NOT quarantined
    expect(warnings).toEqual([]);
    expect(skips).toEqual([]);
    expect(edgesInDb).toEqual([{ to_id: otherTaskId, edge_type: 'informs' }]);
  });

  test('THE PROPERTY: the four outcomes give PAIRWISE DISTINCT answers, across both layers', async () => {
    const inScope = await storeTagged(id8(homeTaskId));
    const outOfScope = await storeTagged(id8(otherTaskId));
    const notFound = await storeTagged(NO_SUCH_ID8);
    const badShape = await storeTagged(BAD_SHAPE_REF);

    expect(inScope.skips).toEqual([]); // the in-scope outcome is "no skip at all"

    // The two answers that are still the resolution layer's must stay distinct in BOTH
    // fields — a distinct code with a shared reason is the collapse this pins.
    expect(outOfScope.skips[0].code).not.toBe(notFound.skips[0].code);
    expect(outOfScope.skips[0].reason).not.toBe(notFound.skips[0].reason);
    // Bad shape's answer is not a skip code at all. Stated positively so that a refactor
    // reintroducing `bad_id_shape` here has to come back and re-read this file.
    expect(badShape.skips).toEqual([]);

    // THE WHOLE OBSERVABLE ANSWER, not just the code — so a collapse in the write-boundary
    // layer is caught as surely as one in the resolution layer.
    const answerOf = (o: { edgesInDb: any[]; skips: any[]; tags: string[]; warnings: string[] }) =>
      JSON.stringify({
        edges: o.edgesInDb.length,
        skipCode: o.skips[0]?.code ?? null,
        skipReason: o.skips[0]?.reason ?? null,
        quarantined: o.tags.some(isQuarantinedThreadingTag),
        warning: o.warnings[0] ?? null,
      });
    const answers = [answerOf(inScope), answerOf(outOfScope), answerOf(notFound), answerOf(badShape)];
    expect(new Set(answers).size).toBe(4);
  });

  test('BOUNDED DISCLOSURE: the cross-project reason names the project + the id, and nothing else about it', async () => {
    const { skips } = await storeTagged(id8(otherTaskId));
    const reason: string = skips[0].reason;
    // It may say WHERE and WHAT TO PASS. It must not hand over the record's contents.
    expect(reason).not.toContain('out-of-scope task'); // the task's title
  });
});
