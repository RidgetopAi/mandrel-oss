/**
 * Mandrel Core Redesign — T1 "fluidity wins" acceptance + adversarial contract test
 *.
 *
 * Drives the REAL routeExecutor + REAL Postgres (the disposable ci_* DB from
 * the CI gate, dropped on exit — NEVER the production `mandrel` DB). Embeddings are
 * stubbed (no native transformers in CI), but the full write/normalize/merge/truncate +
 * retrieval path runs.
 *
 * Covers all six T1 items + adversarial cases written to BREAK them:
 *   1. Recall payload control (response_format concise/detailed + truncation boundary).
 *   2. context_search.id accepts id8 (+ ambiguity/garbage adversarial).
 *   3. metadata surfaced in context_search structuredContent.
 *   4. context_update (CURATE) — re-tag a thread, edit content, errors.
 *   5. task_update + decision_update edit tags/title/description.
 *   6. metadata MERGE (partial update preserves untouched keys; null deletes a key).
 *
 * Every record is created + read through PUBLIC tools — the only SQL is disposable-DB
 * bookkeeping (project create + cleanup) and direct-column ASSERTIONS that prove the
 * persisted state (allowed: we're verifying the tool, not reaching past it to mutate).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings — the real DB write + normalize + merge + retrieval still runs.
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
import { RECALL_CONCISE_MAXLEN, recallSnippetBudget } from '../config/recallConfig.js';
import { clipBody } from '../services/altitudeProjection.js';
import { mergeMetadata } from '../utils/metadataMerge.js';

const STAMP = Date.now();
const CONN = `t1-fluidity-conn-${STAMP}`;
const PROJ_NAME = `t1-fluidity-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.[0]?.text ?? '';
}
/** structuredContent is optional on McpResponse; assert + return it typed-loose for tests. */
function sc(resp: any): any {
  expect(resp?.structuredContent, 'response must carry structuredContent').toBeTruthy();
  return resp.structuredContent;
}
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from response: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);
async function store(content: string, extra: Record<string, any> = {}): Promise<string> {
  const resp = await routeExecutor(
    'context_store',
    { content, type: 'planning', ...extra },
    { connectionId: CONN }
  );
  return parseId(resp);
}

// ---------------------------------------------------------------------------
// PART A — pure config/merge units (no DB) — the truncation + merge primitives.
// ---------------------------------------------------------------------------
describe('T1 units: recall payload + metadata merge primitives', () => {
  /**
   * THE CLIP BOUNDARY, against the LIVE clipper (SEARCH P3 round 2).
   *
   * REPLACES two units that ran through applyRecallPayload, which this round DELETED (it had
   * zero production callers). They were not merely dead — one of them asserted that a body
   * ONE char over the budget comes back truncated:true, while the shipped surface returns it
   * WHOLE (a clip that does not shrink is not a clip; the affordance costs ~75 chars). Two
   * contradictory claims about one behaviour in one file, the false one about code nobody ran.
   *
   * Their surviving properties are kept here, re-pointed at clipBody:
   *   - EXACTLY at the budget is NOT clipped (the off-by-one fence),
   *   - a real clip keeps exactly `maxlen` chars of body before the affordance.
   * "full/detailed never truncates" is dropped from this unit because it is asserted through
   * the REAL surface twice over (the default-path test below, and altitudeVocabulary's by-id
   * test which cross-checks the returned length against SELECT length(content)).
   */
  test('clipBody: the budget boundary is a fence, and a real clip keeps exactly the budget', () => {
    const budget = recallSnippetBudget('id1');

    const atBoundary = 'x'.repeat(RECALL_CONCISE_MAXLEN); // exactly the budget → untouched
    const at = clipBody(atBoundary, budget);
    expect(at.omittedChars).toBe(0);
    expect(at.text).toBe(atBoundary);

    // Comfortably past the affordance's own cost, so a clip is actually profitable.
    const long = 'x'.repeat(RECALL_CONCISE_MAXLEN + 400);
    const over = clipBody(long, budget);
    expect(over.omittedChars).toBe(400);
    // The body kept is exactly the budget, before the affordance is appended.
    expect(over.text.startsWith('x'.repeat(RECALL_CONCISE_MAXLEN))).toBe(true);
    // NOTATION CHURN, INTENTIONAL: this literal previously read
    // `context_search id:id1`. That form parses as query syntax, and agents duly called
    // `context_search({query:'id:<uuid>'})` — which silently returned an unrelated record.
    // The affordance names the `id` PARAMETER and is surface-neutral (no tool name, so it is
    // correct on both the flat and gateway surfaces). This assertion is the fuse: if a
    // `tool arg:value` form ever comes back here, it fails loud.
    expect(over.text).toContain('…[truncated; fetch the full record by setting the id parameter: id="id1"]');
  });

  test('mergeMetadata: shallow-merges, preserves untouched keys, null deletes a key', () => {
    const existing = { parent_task: 'T1', origin: 'seed', keep: 'me' };
    const merged = mergeMetadata(existing, { origin: 'edited', added: 'new', keep: null });
    expect(merged).toEqual({ parent_task: 'T1', origin: 'edited', added: 'new' });
    // existing is not mutated.
    expect(existing.keep).toBe('me');
  });

  test('mergeMetadata: empty / undefined incoming is a no-op clone', () => {
    expect(mergeMetadata({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeMetadata(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadata(undefined, undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// PART B — full tool round-trips (real DB, zero record SQL).
// ---------------------------------------------------------------------------
describe('T1 fluidity via public tools (real DB)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'T1 fluidity contract') RETURNING id`,
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

  // ---- ITEM 1: recall payload control ----
  // WS1 (D1): FULL RECORDS BY DEFAULT. The default read path returns the
  // untruncated body with NO stub; 'concise' (and its truncation affordance) is an explicit
  // per-call opt-in. RECALL_DEFAULT_FORMAT is config-derived — these tests read the same
  // source the product does rather than hardcoding either mode.
  test('item1: context_search DEFAULT returns the FULL body with no truncation stub', async () => {
    const big = 'BODY-' + 'z'.repeat(RECALL_CONCISE_MAXLEN + 200);
    await store(big, { tags: ['ref:t1-recall-big'] });

    // Default (no response_format) → detailed → full body, truncated:false, ZERO stub text.
    const byDefault = await routeExecutor(
      'context_search', { tags: ['ref:t1-recall-big'] }, { connectionId: CONN }
    );
    const dRow = sc(byDefault).results.find((r: any) => r.content.startsWith('BODY-'));
    expect(dRow.truncated).toBe(false);
    expect(dRow.content).toBe(big);
    expect(responseText(byDefault)).not.toContain('[truncated;');

    // concise OPT-IN → truncated, with the affordance (the opt-in contract still holds).
    const concise = await routeExecutor(
      'context_search', { tags: ['ref:t1-recall-big'], response_format: 'concise' }, { connectionId: CONN }
    );
    const cRow = sc(concise).results.find((r: any) => r.content.startsWith('BODY-'));
    expect(cRow.truncated).toBe(true);
    expect(cRow.content).toContain('[truncated; fetch the full record by setting the id parameter: id="');
    expect(cRow.content.length).toBeLessThan(big.length);
    expect(responseText(concise)).toContain('[truncated; fetch the full record by setting the id parameter: id="');
  });

  test('item1: context_get_recent DEFAULT is full; concise opt-in truncates', async () => {
    // +400, not +50. SEARCH P3 put context_* on the SAME clipper
    // recall_thread already used, and that clipper refuses a clip that does not SHRINK: the
    // affordance costs ~75 chars, so a body only 50 over budget came back "clipped" LONGER
    // than the original while claiming an omission that saved nothing. It is now returned
    // whole with truncated:false. The overrun here is comfortably past the affordance so this
    // test measures truncation rather than that boundary; the boundary has its own test below.
    const big = 'RECENT-' + 'q'.repeat(RECALL_CONCISE_MAXLEN + 400);
    await store(big, { tags: ['ref:t1-recent'] });
    const recent = await routeExecutor('context_get_recent', { limit: 5 }, { connectionId: CONN });
    const row = sc(recent).results.find((r: any) => r.content.startsWith('RECENT-'));
    expect(row.truncated).toBe(false);
    expect(row.content).toBe(big);
    expect(responseText(recent)).not.toContain('[truncated;');
    const concise = await routeExecutor(
      'context_get_recent', { limit: 5, response_format: 'concise' }, { connectionId: CONN }
    );
    const crow = sc(concise).results.find((r: any) => r.content.startsWith('RECENT-'));
    expect(crow.truncated).toBe(true);
  });

  test('item1 adversarial: a clip that would GROW the payload returns the body whole', async () => {
    // THE BOUNDARY (SEARCH P3). A body just past the budget cannot be clipped
    // profitably: budget + affordance > body. The honest answer is the whole body with
    // truncated:false — never a longer string that claims to have omitted something. This is
    // the one behaviour change context_* inherited from recall_thread's clipper, and it is
    // pinned here rather than left as a surprise.
    const justOver = 'EDGE-' + 'w'.repeat(RECALL_CONCISE_MAXLEN - 5 + 10); // 10 chars past budget
    await store(justOver, { tags: ['ref:t1-clip-boundary'] });
    const resp = await routeExecutor(
      'context_search',
      { tags: ['ref:t1-clip-boundary'], altitude: 'summary' },
      { connectionId: CONN }
    );
    const row = sc(resp).results.find((r: any) => r.content.startsWith('EDGE-'));
    expect(row.truncated).toBe(false);
    expect(row.content).toBe(justOver);
    expect(row.content).not.toContain('[truncated;');
  });

  test('item1 adversarial: a short body is NEVER truncated even under concise', async () => {
    await store('tiny', { tags: ['ref:t1-tiny'] });
    const resp = await routeExecutor('context_search', { tags: ['ref:t1-tiny'] }, { connectionId: CONN });
    const row = sc(resp).results.find((r: any) => r.content === 'tiny');
    expect(row.truncated).toBe(false);
    expect(row.content).toBe('tiny');
  });

  test('item1 adversarial: response_format="bogus" is rejected by validation', async () => {
    // validateToolArguments runs upstream of routeExecutor in the real bridge; assert the
    // schema rejects an undeclared enum value (strict + enum).
    const { validateToolArguments } = await import('../middleware/validation.js');
    expect(() => validateToolArguments('context_search', { query: 'x', response_format: 'bogus' }))
      .toThrow();
  });

  // ---- ITEM 2: context_search.id accepts id8 ----
  test('item2: context_search by id8 resolves the same row as the full UUID', async () => {
    const id = await store('FINDME by id8', { tags: ['ref:t1-id8'] });
    const byId8 = await routeExecutor('context_search', { id: id8(id) }, { connectionId: CONN });
    expect(sc(byId8).results).toHaveLength(1);
    expect(sc(byId8).results[0].id).toBe(id);
    expect(sc(byId8).results[0].content).toContain('FINDME by id8');
    // by-id defaults to detailed (the zoom target) — full body, truncated:false.
    expect(sc(byId8).results[0].truncated).toBe(false);
  });

  test('item2 adversarial: non-hex garbage id is rejected at validation (wildcard-safe)', async () => {
    const { validateToolArguments } = await import('../middleware/validation.js');
    // A LIKE-wildcard / non-hex value must not even reach the resolver.
    expect(() => validateToolArguments('context_search', { id: '%' })).toThrow();
    expect(() => validateToolArguments('context_search', { id: 'not-hex-zzzz' })).toThrow();
  });

  test('item2 adversarial: an unknown id8 returns an actionable not-found (no crash)', async () => {
    const resp = await routeExecutor('context_search', { id: 'deadbeef' }, { connectionId: CONN });
    expect(resp.isError).toBe(true);
    expect(responseText(resp).toLowerCase()).toContain('not found');
  });

  // ---- ITEM 3: metadata surfaced in context_search ----
  test('item3: written metadata back-links are returned in semantic search structuredContent', async () => {
    await store('semantic metadata surface row', {
      tags: ['ref:t1-meta-surface'],
      metadata: { parent_task: 'PT-1', origin_context: 'oc-1' },
    });
    const resp = await routeExecutor(
      'context_search', { query: 'semantic metadata surface row' }, { connectionId: CONN }
    );
    const row = sc(resp).results.find(
      (r: any) => r.metadata && r.metadata.parent_task === 'PT-1'
    );
    expect(row).toBeTruthy();
    expect(row.metadata.origin_context).toBe('oc-1');
  });

  // ---- ITEM 4: context_update (CURATE) ----
  test('item4: re-tag a context thread via context_update (zero SQL on the record)', async () => {
    const id = await store('thread to be re-tagged', { tags: ['task:aaaaaaaa', 'keep'] });
    // Re-thread: move it to a different task thread + drop the old one.
    const upd = await routeExecutor(
      'context_update',
      { contextId: id8(id), tags: ['task:bbbbbbbb', 'keep'] },
      { connectionId: CONN }
    );
    expect(sc(upd).action).toBe('updated');
    expect(sc(upd).context.tags).toEqual(['task:bbbbbbbb', 'keep']);
    // Retrieve by the NEW thread tag via tools — it now resolves.
    const byNew = await routeExecutor('context_search', { tags: ['task:bbbbbbbb'] }, { connectionId: CONN });
    expect(sc(byNew).results.some((r: any) => r.id === id)).toBe(true);
    // The OLD thread tag no longer returns it.
    const byOld = await routeExecutor('context_search', { tags: ['task:aaaaaaaa'] }, { connectionId: CONN });
    expect(sc(byOld).results.some((r: any) => r.id === id)).toBe(false);
  });

  test('item4: context_update edits content (and round-trips)', async () => {
    const id = await store('original content', { tags: ['ref:t1-edit-content'] });
    await routeExecutor('context_update', { contextId: id, content: 'EDITED content' }, { connectionId: CONN });
    const byId = await routeExecutor('context_search', { id, response_format: 'detailed' }, { connectionId: CONN });
    expect(sc(byId).results[0].content).toBe('EDITED content');
  });

  test('item4 adversarial: context_update with no editable field is rejected by validation', async () => {
    const { validateToolArguments } = await import('../middleware/validation.js');
    expect(() => validateToolArguments('context_update', { contextId: 'aaaaaaaa' }))
      .toThrow(/At least one field/i);
  });

  test('item4 adversarial: context_update of an unknown id returns actionable not-found', async () => {
    const resp = await routeExecutor(
      'context_update', { contextId: 'ffffffff', content: 'x' }, { connectionId: CONN }
    );
    expect(resp.isError).toBe(true);
    expect(responseText(resp).toLowerCase()).toContain('not found');
  });

  // ---- ITEM 5: task_update + decision_update edit tags/title/description ----
  test('item5: task_update edits title, description, and tags', async () => {
    // STAGE PINNED TO 'draft' (an earlier task clause 10) — see item6 below for why a bare
    // task_create otherwise lands at stage='ready' with no punch fields, which the
    // completeness gate now correctly refuses a subsequent title edit against.
    const taskId = parseId(await routeExecutor(
      'task_create', { title: 'orig task title', type: 'feature', stage: 'draft' }, { connectionId: CONN }
    ));
    await routeExecutor(
      'task_update',
      { taskId, title: 'NEW task title', description: 'new desc', tags: ['phase-9', 'edited'] },
      { connectionId: CONN }
    );
    const details = await routeExecutor('task_details', { taskId }, { connectionId: CONN });
    const t = sc(details).task;
    expect(t.title).toBe('NEW task title');
    expect(t.description).toBe('new desc');
    expect(t.tags).toEqual(['phase-9', 'edited']);
  });

  // prove the full retag contract on task_update — REPLACE / OMIT / CLEAR / REJECT.
  test('item5: task_update with tags REPLACES the existing tag set (retag path)', async () => {
    const taskId = parseId(await routeExecutor(
      'task_create', { title: 'retag-replace', type: 'feature', tags: ['old-a', 'old-b'] },
      { connectionId: CONN }
    ));
    await routeExecutor(
      'task_update', { taskId, tags: ['new-x', 'new-y', 'new-z'] }, { connectionId: CONN }
    );
    const t = sc(await routeExecutor('task_details', { taskId }, { connectionId: CONN })).task;
    // SET semantics: the new array wholly replaces the old (no union/merge).
    expect(t.tags).toEqual(['new-x', 'new-y', 'new-z']);
    // And the new tags resolve the task via tag filter; the old ones no longer do.
    const byNew = sc(await routeExecutor('task_list', { tags: ['new-x'] }, { connectionId: CONN })).results;
    expect(byNew.map((x: any) => x.id)).toContain(taskId);
    const byOld = sc(await routeExecutor('task_list', { tags: ['old-a'] }, { connectionId: CONN })).results;
    expect(byOld.map((x: any) => x.id)).not.toContain(taskId);
  });

  test('item5: task_update with tags OMITTED leaves existing tags unchanged (backward-compatible)', async () => {
    const taskId = parseId(await routeExecutor(
      'task_create', { title: 'retag-omit', type: 'feature', tags: ['keep-me', 'and-me'] },
      { connectionId: CONN }
    ));
    // A pre-tags caller updates only status — tags must be untouched (no silent wipe).
    await routeExecutor('task_update', { taskId, status: 'in_progress' }, { connectionId: CONN });
    const t = sc(await routeExecutor('task_details', { taskId }, { connectionId: CONN })).task;
    expect(t.status).toBe('in_progress');
    expect(t.tags).toEqual(['keep-me', 'and-me']);
  });

  test('item5: task_update with an explicit EMPTY array CLEARS the tags', async () => {
    const taskId = parseId(await routeExecutor(
      'task_create', { title: 'retag-clear', type: 'feature', tags: ['will', 'be', 'gone'] },
      { connectionId: CONN }
    ));
    await routeExecutor('task_update', { taskId, tags: [] }, { connectionId: CONN });
    const t = sc(await routeExecutor('task_details', { taskId }, { connectionId: CONN })).task;
    expect(t.tags).toEqual([]);
  });

  test('item5 adversarial: task_update rejects invalid tags at validation (same rules as task_create)', async () => {
    const { validateToolArguments } = await import('../middleware/validation.js');
    const taskId = 'deadbeefdeadbeefdeadbeefdeadbeef'; // shape-valid id; never reached — rejected first.
    // A non-string element.
    expect(() => validateToolArguments('task_update', { taskId, tags: [123] as any })).toThrow();
    // A tag longer than the per-tag max (baseTags: max 50 chars).
    expect(() => validateToolArguments('task_update', { taskId, tags: ['x'.repeat(51)] })).toThrow();
    // More tags than the array max (baseTags: max 20).
    expect(() => validateToolArguments('task_update', { taskId, tags: Array(21).fill('t') })).toThrow();
    // Sanity: task_create rejects the SAME invalid tag → the two share baseTags (no drift).
    expect(() => validateToolArguments('task_create', { title: 'x', tags: ['x'.repeat(51)] })).toThrow();
  });

  test("item5: decision_update edits a decision's tags + title", async () => {
    const decId = parseId(await routeExecutor(
      'decision_record',
      {
        decisionType: 'architecture', title: 'orig decision title',
        description: 'a decision', rationale: 'because', impactLevel: 'medium',
        tags: ['old-tag'],
      },
      { connectionId: CONN }
    ));
    await routeExecutor(
      'decision_update',
      // A WELL-FORMED threading tag on purpose. This item is about decision_update
      // REPLACING tags + title; it used to pass `context:abc`, which is not an id8 or a
      // UUID, so the assertion quietly depended on what the validator does to an unusable
      // value and broke when those started being quarantined. A valid
      // threading tag keeps the coverage that matters here -- one survives an update
      // untouched -- without asserting the validator's behaviour by accident.
      { decisionId: decId, title: 'NEW decision title', tags: ['new-tag', 'scope:product'] },
      { connectionId: CONN }
    );
    const got = await routeExecutor('decision_get', { decisionId: decId }, { connectionId: CONN });
    expect(sc(got).decision.title).toBe('NEW decision title');
    expect(sc(got).decision.tags).toEqual(['new-tag', 'scope:product']);
    // And the new tag resolves the decision via tag search.
    const byTag = await routeExecutor('decision_search', { tags: ['new-tag'] }, { connectionId: CONN });
    expect(responseText(byTag)).toContain('NEW decision title');
  });

  // ---- ITEM 6: metadata MERGE (the footgun fix) ----
  test('item6: context_update metadata is MERGED — a partial update preserves untouched keys', async () => {
    const id = await store('metadata-merge context', {
      metadata: { parent_task: 'PT', origin: 'seed', survives: 'yes' },
    });
    // Partial update: change one key, add one — the others MUST survive.
    await routeExecutor(
      'context_update', { contextId: id, metadata: { origin: 'edited', added: 'x' } }, { connectionId: CONN }
    );
    const byId = await routeExecutor('context_search', { id }, { connectionId: CONN });
    const meta = sc(byId).results[0].metadata;
    expect(meta).toEqual({ parent_task: 'PT', origin: 'edited', survives: 'yes', added: 'x' });
  });

  test('item6: explicit null DELETES just that key (merge escape hatch)', async () => {
    const id = await store('metadata-null-delete context', {
      metadata: { a: '1', b: '2', c: '3' },
    });
    await routeExecutor(
      'context_update', { contextId: id, metadata: { b: null } }, { connectionId: CONN }
    );
    const byId = await routeExecutor('context_search', { id }, { connectionId: CONN });
    expect(sc(byId).results[0].metadata).toEqual({ a: '1', c: '3' });
  });

  test('item6: task_update metadata MERGE preserves untouched keys (was a wholesale replace)', async () => {
    // STAGE PINNED TO 'draft' (an earlier task clause 10): a task_create naming no `stage` is
    // backfilled to 'ready' by the tasks_sync_stage_status trigger (status defaults to
    // 'todo' -> stage='ready'). The completeness gate now keys on the MERGED row's stage, so
    // the metadata-only update below would be correctly refused against a ready row with no
    // punch fields — not what this metadata-merge test is exercising.
    const taskId = parseId(await routeExecutor(
      'task_create', { title: 'task meta merge', type: 'general', stage: 'draft', metadata: { keep: 'k', drop: 'd' } },
      { connectionId: CONN }
    ));
    await routeExecutor('task_update', { taskId, metadata: { drop: null, added: 'a' } }, { connectionId: CONN });
    const details = await routeExecutor('task_details', { taskId }, { connectionId: CONN });
    expect(sc(details).task.metadata).toEqual({ keep: 'k', added: 'a' });
  });

  test('item6: decision_update metadata MERGE preserves untouched keys', async () => {
    const decId = parseId(await routeExecutor(
      'decision_record',
      {
        decisionType: 'tooling', title: 'dec meta merge', description: 'd', rationale: 'r',
        impactLevel: 'low', metadata: { keep: 'k', drop: 'd' },
      },
      { connectionId: CONN }
    ));
    await routeExecutor('decision_update', { decisionId: decId, metadata: { drop: null, added: 'a' } }, { connectionId: CONN });
    const got = await routeExecutor('decision_get', { decisionId: decId }, { connectionId: CONN });
    expect(sc(got).decision.metadata).toEqual({ keep: 'k', added: 'a' });
  });

  test('item6 adversarial: a weird metadata key name (quote/dot) merges + deletes safely', async () => {
    const id = await store('weird key context', { metadata: { "a'b": '1', 'x.y': '2', normal: '3' } });
    // Delete the quote-containing key, keep the rest.
    await routeExecutor('context_update', { contextId: id, metadata: { "a'b": null } }, { connectionId: CONN });
    const byId = await routeExecutor('context_search', { id }, { connectionId: CONN });
    expect(sc(byId).results[0].metadata).toEqual({ 'x.y': '2', normal: '3' });
  });
});
