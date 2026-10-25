/**
 * Tool-native record linking — acceptance contract test.
 *
 * THE POINT (Operator's "reproduce the linking model with ZERO SQL" bar):
 *   The record-linking model (mandrel-record-linking-convention) threads
 *   tasks↔contexts↔decisions into one searchable story. All session it was threaded
 *   BY HAND with raw SQL for the parts the tools didn't expose. This proves the WHOLE
 *   thread can now be built AND retrieved through the PUBLIC tools alone — no SQL on
 *   the records — driving the REAL routeExecutor + REAL Postgres (disposable DB from
 *   the CI gate, dropped on exit; NEVER the production `mandrel` DB).
 *
 * Two parts:
 *   1. THREADING GRAMMAR (pure): the threading prefixes (task:/decision:/context:/
 *      scope:/owner:/tranche:) are validated/normalized warn-only, never rejected —
 *      the same first-class contract `ref:` got, extended to the join keys.
 *   2. FULL LINKED THREAD (real DB, zero SQL on records): create a task → store a
 *      context tagged `task:<id8>` AND carrying metadata {parent_task} → record a
 *      decision tagged `context:<uuid>` → then RETRIEVE every link via tools:
 *        - context_search({tags:["task:<id8>"]}) returns the thread,
 *        - the context's metadata back-link round-trips (visible via context_search by id),
 *        - decision_search({tags:["context:<uuid>"]}) resolves the decision↔context link,
 *        - task_details shows the task's metadata + dependencies round-trip.
 *      The ONLY SQL used is disposable-DB bookkeeping (create project, cleanup) — the
 *      RECORDS themselves are created and read entirely through tools.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

// Distinct UUIDs per lazily-created session (global setup mocks randomUUID).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings (native transformers/sharp unavailable in CI/sandbox). The FULL
// real DB write + tag-normalization + retrieval path still runs.
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
  validateAndNormalizeTags,
  isThreadingTag,
  THREADING_QUARANTINE_PREFIX,
  isQuarantinedThreadingTag,
} from '../utils/threadingTags.js';
import { tagToEdgeIntent } from '../config/tagEdgeConfig.js';

const STAMP = Date.now();
const CONN = `tool-native-linking-conn-${STAMP}`;
const PROJ_NAME = `tool-native-linking-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.[0]?.text ?? '';
}

/** Pull a UUID labelled `🆔 ID:` / `ID:` out of a tool response. */
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from response: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

// ---------------------------------------------------------------------------
// PART 1 — threading grammar (pure functions, no DB)
// ---------------------------------------------------------------------------
describe('tool-native linking: threading grammar (pure)', () => {
  test('isThreadingTag recognizes the join-key prefixes and nothing else', () => {
    expect(isThreadingTag('task:9e25dac7')).toBe(true);
    expect(isThreadingTag('decision:77ce0f7f')).toBe(true);
    expect(isThreadingTag('context:0f3906cd-0000-4000-8000-000000000000')).toBe(true);
    expect(isThreadingTag('scope:product')).toBe(true);
    expect(isThreadingTag('owner:engineering')).toBe(true);
    expect(isThreadingTag('tranche:safe')).toBe(true);
    expect(isThreadingTag('ref:resume')).toBe(false); // owned by refs.ts, not a threading tag
    expect(isThreadingTag('audit')).toBe(false);
  });

  test('well-formed threading tags pass through unchanged with NO warning', () => {
    const { tags, warnings } = validateAndNormalizeTags([
      'task:9e25dac7', 'decision:77ce0f7f', 'scope:product', 'owner:engineering', 'tranche:safe', 'audit',
    ]);
    expect(tags).toEqual([
      'task:9e25dac7', 'decision:77ce0f7f', 'scope:product', 'owner:engineering', 'tranche:safe', 'audit',
    ]);
    expect(warnings).toHaveLength(0);
  });

  test('case/whitespace is normalized (lowercased) and reported, never rejected', () => {
    const { tags, warnings } = validateAndNormalizeTags(['Task:9E25DAC7', '  scope:Product  ']);
    expect(tags).toEqual(['task:9e25dac7', 'scope:product']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('task:9e25dac7');
    expect(warnings.join(' ')).toContain('scope:product');
  });

  test('a malformed value is WARNED and QUARANTINED, never dropped/rejected', () => {
    // task: id that is not 8 hex, and an unknown scope value.
    const { tags, warnings } = validateAndNormalizeTags(['task:9e25', 'scope:prod', 'keep-me']);
    // The VALUES survive — nothing is dropped — but not in a form that pretends to thread.
    expect(tags).toContain(`${THREADING_QUARANTINE_PREFIX}task:9e25`);
    expect(tags).toContain(`${THREADING_QUARANTINE_PREFIX}scope:prod`);
    expect(tags).toContain('keep-me');
    expect(tags, 'the misleading verbatim forms must be gone').not.toContain('task:9e25');
    expect(tags).not.toContain('scope:prod');
    expect(tags, 'same tag count in, same count out — quarantine is a rewrite, not a drop')
      .toHaveLength(3);
    // …and the quarantined forms no longer read as threading tags to the product's own matcher.
    for (const t of tags.filter(isQuarantinedThreadingTag)) {
      expect(isThreadingTag(t), `${t} still matches a threading prefix`).toBe(false);
    }
    // Two warnings flag the two malformed threading tags.
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toMatch(/task:/);
    expect(warnings.join(' ')).toMatch(/scope:/);
  });

  test('a context:<id8> tag is VALID and still MINTS ITS EDGE (regression)', () => {
    // THE NEAR-MISS THIS EXISTS FOR. Quarantine rewrites an invalid threading value so it no
    // longer wears its prefix -- which means anything that MINTS from that prefix stops
    // seeing it. `context:` used to demand a full UUID here, while tagEdgeConfig's
    // `tagToEdgeIntent` hands ANY non-empty ref to a resolver that accepts an id8. So
    // `context:<id8>` minted a real `learned_from` edge while this module called it invalid,
    // and quarantining it would have silently broken 45 live records' threading.
    // Measured before the fix: `context:353ec1c1` minted [learned_from, related_to]; with
    // quarantine and the old validator, zero edges.
    const id8 = '353ec1c1';
    const uuid = '353ec1c1-3cb5-4158-994d-95a7282cb1b6';
    for (const form of [`context:${id8}`, `context:${uuid}`]) {
      const { tags, warnings } = validateAndNormalizeTags([form]);
      expect(tags, `${form} must survive unrewritten`).toEqual([form]);
      expect(warnings, `${form} must not warn`).toEqual([]);
      expect(isQuarantinedThreadingTag(tags[0])).toBe(false);
      // The property that actually matters: the edge minter still recognises it.
      expect(tagToEdgeIntent('context', tags[0])?.edgeType).toBe('learned_from');
    }
    // …and a genuinely unusable ref is still caught, or the widening above went too far.
    expect(validateAndNormalizeTags(['context:nope']).tags)
      .toEqual([`${THREADING_QUARANTINE_PREFIX}context:nope`]);
  });

  test('QUARANTINE IS IDEMPOTENT — re-validating a stored row does not re-prefix it', () => {
    // The real path: task_update / context_update hand the record's CURRENT tags back in.
    // A non-idempotent marker would grow `invalid-invalid-…` on every edit.
    const once = validateAndNormalizeTags(['scope:prod']).tags;
    const twice = validateAndNormalizeTags(once).tags;
    const thrice = validateAndNormalizeTags(twice).tags;
    expect(once).toEqual([`${THREADING_QUARANTINE_PREFIX}scope:prod`]);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
    // …and the second pass is SILENT: a stable row must not warn forever.
    expect(validateAndNormalizeTags(once).warnings).toEqual([]);
  });

  test('THE BOUNDARY POPULATION — empty value, absent tags, wrong case, near-miss prefix', () => {
    // EMPTY VALUE: `scope:` with nothing after it is invalid and must quarantine, not crash.
    expect(validateAndNormalizeTags(['scope:']).tags)
      .toEqual([`${THREADING_QUARANTINE_PREFIX}scope:`]);
    // ABSENT / EMPTY POPULATION: no tags at all warns about nothing and returns nothing.
    expect(validateAndNormalizeTags(undefined)).toEqual({ tags: [], warnings: [] });
    expect(validateAndNormalizeTags([])).toEqual({ tags: [], warnings: [] });
    // WRONG CASE OF A **VALID** VALUE: normalized, NOT quarantined. This is the control that
    // stops the quarantine from swallowing tags it was never meant to touch.
    expect(validateAndNormalizeTags(['SCOPE:PRODUCT']).tags).toEqual(['scope:product']);
    expect(validateAndNormalizeTags(['  Tranche:Safe  ']).tags).toEqual(['tranche:safe']);
    // WRONG CASE OF AN INVALID VALUE: lowercased first, then quarantined.
    expect(validateAndNormalizeTags(['Scope:Mandrel']).tags)
      .toEqual([`${THREADING_QUARANTINE_PREFIX}scope:mandrel`]);
    // NEAR-MISS PREFIX: a tag that merely CONTAINS a prefix is not a threading tag at all.
    expect(validateAndNormalizeTags(['x-scope:mandrel', 'scoped:thing']).tags)
      .toEqual(['x-scope:mandrel', 'scoped:thing']);
    expect(validateAndNormalizeTags(['x-scope:mandrel']).warnings).toEqual([]);
  });

  test('ref grammar still composes (ref normalization + threading both run)', () => {
    const { tags, warnings } = validateAndNormalizeTags(['ref:My Resume', 'task:9e25dac7']);
    expect(tags).toEqual(['ref:my-resume', 'task:9e25dac7']);
    // One warning: the ref normalization (the well-formed task tag is silent).
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ref:my-resume');
  });
});

// ---------------------------------------------------------------------------
// PART 2 — full linked thread via tools, ZERO SQL on the records
// ---------------------------------------------------------------------------
describe('tool-native linking: full thread via public tools (zero SQL on records)', () => {
  beforeAll(async () => {
    // Disposable-DB bookkeeping only (a project to scope under) — NOT a record write.
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'tool-native linking contract') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch { /* ignore */ }
    await db.end();
  });

  test('build + retrieve the entire task↔context↔decision thread with ZERO record SQL', async () => {
    // --- 1. A dependency task (so we can prove task dependencies round-trip too).
    const depResp = await routeExecutor(
      'task_create',
      { title: 'dep task', type: 'general' },
      { connectionId: CONN }
    );
    const depTaskId = parseId(depResp);

    // --- 2. The SPINE task, carrying structured metadata AND a dependency, via tools.
    const taskResp = await routeExecutor(
      'task_create',
      {
        title: 'tool-native linking spine task',
        type: 'feature',
        dependencies: [depTaskId],
        metadata: { origin_context: 'seed', shape: 'thread' },
      },
      { connectionId: CONN }
    );
    const taskId = parseId(taskResp);
    const taskTag = `task:${id8(taskId)}`;

    // task_details must show metadata + dependencies round-tripped (zero SQL).
    const detailsResp = await routeExecutor('task_details', { taskId }, { connectionId: CONN });
    const detailsText = responseText(detailsResp);
    expect(detailsText).toContain('"origin_context": "seed"'); // metadata round-trips
    expect(detailsText).toContain('"shape": "thread"');
    expect(detailsText).toContain(depTaskId);                   // dependency round-trips

    // --- 3. A context threaded to the task by TAG and carrying a structured back-link
    //        in METADATA (the keystone newly exposed on context_store).
    const ctxResp = await routeExecutor(
      'context_store',
      {
        content: 'CAPTURE: why the thread exists',
        type: 'planning',
        tags: [taskTag, 'scope:product', 'owner:engineering', 'capture'],
        metadata: { parent_task: taskId, origin_context: 'capture-seed' },
      },
      { connectionId: CONN }
    );
    const ctxId = parseId(ctxResp);
    // No grammar warnings: every tag was well-formed.
    expect(responseText(ctxResp)).not.toContain('Tag notes');

    // --- 4. A decision pointing at the context via a `context:<uuid>` tag (the
    //        decision↔context link, all through the tool).
    const ctxTag = `context:${ctxId}`;
    const decResp = await routeExecutor(
      'decision_record',
      {
        decisionType: 'architecture',
        title: 'thread anchor decision',
        description: 'anchors the linked thread',
        rationale: 'prove the link resolves via tools',
        impactLevel: 'medium',
        tags: [ctxTag, `task:${id8(taskId)}`],
      },
      { connectionId: CONN }
    );
    const decisionId = parseId(decResp);

    // === RETRIEVE every link THROUGH TOOLS ONLY ===

    // (a) The thread: context_search by the task: tag returns the capture context.
    const threadResp = await routeExecutor(
      'context_search',
      { tags: [taskTag], limit: 10 },
      { connectionId: CONN }
    );
    const threadText = responseText(threadResp);
    expect(threadText).toContain(ctxId);
    expect(threadText).toContain('CAPTURE: why the thread exists');
    // The context's metadata back-link round-trips in the tags-only listing.
    expect(threadText).toContain(`"parent_task":"${taskId}"`);

    // (b) The context's metadata round-trips on a direct id lookup too.
    const byIdResp = await routeExecutor('context_search', { id: ctxId }, { connectionId: CONN });
    const byIdText = responseText(byIdResp);
    expect(byIdText).toContain(`"parent_task":"${taskId}"`);
    expect(byIdText).toContain(`"origin_context":"capture-seed"`);

    // (c) The decision↔context link resolves: decision_search by the context: tag
    //     returns the anchor decision (and shows the context: tag it carries).
    const decSearchResp = await routeExecutor(
      'decision_search',
      { tags: [ctxTag] },
      { connectionId: CONN }
    );
    const decSearchText = responseText(decSearchResp);
    expect(decSearchText).toContain('thread anchor decision');
    expect(decSearchText).toContain(ctxTag);

    // (d) The decision also ladders to the task (task: tag) — both ends thread.
    const decByTaskResp = await routeExecutor(
      'decision_search',
      { tags: [`task:${id8(taskId)}`] },
      { connectionId: CONN }
    );
    expect(responseText(decByTaskResp)).toContain('thread anchor decision');

    // Sanity: every record id is a distinct real UUID created via tools.
    expect(new Set([depTaskId, taskId, ctxId, decisionId]).size).toBe(4);
  });

  test('a typo in a threading tag is normalized + reported on store, never rejected', async () => {
    const resp = await routeExecutor(
      'context_store',
      {
        content: 'context with a sloppy threading tag',
        type: 'discussion',
        tags: ['Task:ABCD1234', 'scope:prod'], // uppercase task id + unknown scope value
      },
      { connectionId: CONN }
    );
    const text = responseText(resp);
    const id = parseId(resp);
    // Stored tags: the task tag is lowercased to VALID form (so it threads); the unusable
    // scope value is QUARANTINED so no later reader mistakes it for one.
    const stored = (await db.query('SELECT tags FROM contexts WHERE id = $1', [id])).rows[0].tags;
    expect(stored).toContain('task:abcd1234');
    expect(stored).toContain(`${THREADING_QUARANTINE_PREFIX}scope:prod`);
    expect(stored).not.toContain('scope:prod');
    // The caller is TOLD (warn-only) — the store still succeeded.
    expect(text).toContain('Tag notes'); // the shared linking-grammar warnings block header
    expect(text).toContain('Context stored');
  });
});
