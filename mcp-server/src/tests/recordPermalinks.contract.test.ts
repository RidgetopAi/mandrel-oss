/**
 * Record permalinks in tool output — contract test.
 *
 * THE CLAIMABLE GUARANTEE: every id-emitting Mandrel tool RESULT carries a plain, clickable
 * permalink `<this instance's Command UI>/r/<id8>` for the record it returns — produced by
 * the ONE shared helper (recordUrl / formatRecordRef in config/commandUrlConfig), so an id is
 * clickable everywhere without the model remembering a convention.
 *
 * The origin is per-INSTANCE, not a constant: a tenant's permalinks must point at that
 * tenant's own Command UI (customer bug 2026-07-30). This file asserts the
 * SHAPE and that every render site routes through the shared helper; it imports
 * COMMAND_BASE_URL from the module under test, so it cannot detect a wrong-but-well-formed
 * origin. That property is pinned in commandUrlConfig.unit.test.ts — the only home it has.
 *
 * DUAL-CHANNEL COVERAGE: the permalink must reach EVERY MCP client regardless
 * of which content block it renders — so it lives in BOTH:
 *   • the human-readable TEXT block  (for text-surfacing clients), AND
 *   • the machine-readable STRUCTURED payload  (for JSON-surfacing clients like the Claude
 *     Code harness the coordinator runs in, which renders structuredContent, NOT the text block).
 * This suite asserts the permalink is present in BOTH channels, and that both come from the
 * SAME shared helper (one source of truth — never a per-site URL copy).
 *
 * This drives the REAL routeExecutor + REAL Postgres (a disposable DB —
 * NEVER the production `mandrel` DB). For each
 * record-returning tool it asserts:
 *   (a) the returned TEXT contains recordUrl(id) pointing at /r/<id8>, and
 *   (b) the STRUCTURED payload carries that same recordUrl(id) as a per-record field.
 *
 * Config-drivenness of the base URL (override via env → URL changes) is proven in the pure
 * unit test commandUrlConfig.unit.test.ts (env is read at module load, so it must be tested via
 * resetModules+dynamic import — this live-DB suite has the module already loaded).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

// Distinct UUIDs per record (global setup mocks randomUUID for recognizable-yet-unique ids).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings (native transformers/sharp unavailable in CI/sandbox). The FULL real DB
// write + result-formatting path still runs — which is what carries the permalink.
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
import { recordUrl, COMMAND_BASE_URL } from '../config/commandUrlConfig.js';

const STAMP = Date.now();
const CONN = `record-permalinks-conn-${STAMP}`;
const PROJ_NAME = `record-permalinks-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.[0]?.text ?? '';
}

async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN });
}

/** The canonical TEXT permalink assertion: text carries recordUrl(id) AND it points at /r/<id8>. */
function expectPermalink(text: string, id: string): void {
  const url = recordUrl(id);
  // (a) present + (b) equals the shared helper's output (one source of truth).
  expect(text).toContain(url);
  // Points at /r/<id8> (first 8 chars), plain https URL (not markdown).
  expect(url).toBe(`${COMMAND_BASE_URL}/r/${id.slice(0, 8)}`);
  expect(text).not.toContain(`](${url})`); // never wrapped as a markdown link
}

/**
 * The STRUCTURED permalink assertion: the structured field equals
 * recordUrl(id) — i.e. it is the SAME shared-helper /r/<id8> URL the text carries, in the
 * machine channel so a JSON-only client sees it. `actualUrl` is the per-record `url` field.
 */
function expectStructuredUrl(actualUrl: unknown, id: string): void {
  expect(actualUrl).toBe(recordUrl(id));
  expect(actualUrl).toBe(`${COMMAND_BASE_URL}/r/${id.slice(0, 8)}`);
}

/**
 * WS1 machine-lean READ surfaces (D2): a read/list/search TEXT channel
 * carries NO per-row permalink line — the /r/<id8> URL rides each structured row's `url`
 * field only (asserted via expectStructuredUrl above). Write acks keep their one text
 * permalink; this helper is for the read surfaces.
 */
function expectNoTextPermalink(text: string): void {
  expect(text).not.toContain('/r/');
}

describe('record permalinks in tool output (real DB)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'record-permalinks contract') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM context_links WHERE from_id IN (SELECT id FROM contexts WHERE project_id = $1)', [projectId]).catch(() => {});
        await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch { /* ignore */ }
    await db.end();
  });

  // ── CONTEXT ────────────────────────────────────────────────────────────────
  test('context_store result carries the created context permalink (text + structured)', async () => {
    const resp = await viaTool('context_store', { content: 'permalink probe A', type: 'planning' });
    const id = resp.structuredContent.context.id;
    expectPermalink(responseText(resp), id);
    // STRUCTURED: the created context's structured payload carries the url.
    expectStructuredUrl(resp.structuredContent.context.url, id);
  });

  test('context_search result list carries a permalink per context (text + structured)', async () => {
    await viaTool('context_store', { content: 'searchable permalink probe zephyr', type: 'planning' });
    const resp = await viaTool('context_search', { query: 'zephyr', limit: 5 });
    const text = responseText(resp);
    const rows: any[] = (resp.structuredContent?.results ?? []).filter((r: any) => r.id);
    expect(rows.length).toBeGreaterThan(0);
    // Every returned row carries its own structured url; the first's is also in the text.
    for (const row of rows) expectStructuredUrl(row.url, row.id);
    expectNoTextPermalink(text);
  });

  test('context_get_recent result list carries a permalink per context (text + structured)', async () => {
    const resp = await viaTool('context_get_recent', { limit: 5 });
    const text = responseText(resp);
    const rows: any[] = (resp.structuredContent?.results ?? []).filter((r: any) => r.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectStructuredUrl(row.url, row.id);
    expectNoTextPermalink(text);
  });

  test('context_search by-id lookup carries the permalink (text + structured)', async () => {
    const created = await viaTool('context_store', { content: 'by-id permalink probe', type: 'planning' });
    const id = created.structuredContent.context.id;
    const resp = await viaTool('context_search', { id });
    expectNoTextPermalink(responseText(resp));
    expectStructuredUrl(resp.structuredContent.results[0].url, id);
  });

  // ── TASK ─────────────────────────────────────────────────────────────────────
  test('task_create result carries the created task permalink (text + structured)', async () => {
    const resp = await viaTool('task_create', { title: 'permalink task', type: 'feature' });
    const id = resp.structuredContent.task.id;
    expectPermalink(responseText(resp), id);
    expectStructuredUrl(resp.structuredContent.task.url, id);
  });

  test('task_list result list carries a permalink per task (text + structured)', async () => {
    await viaTool('task_create', { title: 'permalink task 2', type: 'feature' });
    const resp = await viaTool('task_list', {});
    const text = responseText(resp);
    const rows: any[] = (resp.structuredContent?.results ?? []).filter((r: any) => r.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectStructuredUrl(row.url, row.id);
    expectNoTextPermalink(text);
  });

  test('task_details result carries the task permalink (text + structured)', async () => {
    const created = await viaTool('task_create', { title: 'permalink task 3', type: 'feature' });
    const id = created.structuredContent.task.id;
    const resp = await viaTool('task_details', { taskId: id });
    expectNoTextPermalink(responseText(resp));
    expectStructuredUrl(resp.structuredContent.task.url, id);
  });

  // ── DECISION ──────────────────────────────────────────────────────────────────
  test('decision_record result carries the created decision permalink (text + structured)', async () => {
    const resp = await viaTool('decision_record', {
      decisionType: 'architecture', title: 'permalink decision', description: 'd',
      rationale: 'r', impactLevel: 'medium',
    });
    const id = resp.structuredContent.decision.id;
    expectPermalink(responseText(resp), id);
    expectStructuredUrl(resp.structuredContent.decision.url, id);
  });

  test('decision_get result carries the decision permalink (text + structured)', async () => {
    const created = await viaTool('decision_record', {
      decisionType: 'pattern', title: 'permalink decision get', description: 'd',
      rationale: 'r', impactLevel: 'low',
    });
    const id = created.structuredContent.decision.id;
    const resp = await viaTool('decision_get', { decisionId: id });
    expectNoTextPermalink(responseText(resp));
    // decision_get emits the legacy `data` sibling → the routeExecutor seam promotes it to
    // structuredContent, so the url is at structuredContent.decision.url.
    expectStructuredUrl(resp.structuredContent.decision.url, id);
  });

  test('decision_search result list carries a permalink per decision (text + structured)', async () => {
    await viaTool('decision_record', {
      decisionType: 'architecture', title: 'permalink decision search quokka', description: 'd',
      rationale: 'r', impactLevel: 'medium',
    });
    const resp = await viaTool('decision_search', { query: 'quokka', limit: 5 });
    const text = responseText(resp);
    const rows: any[] = (resp.structuredContent?.results ?? []).filter((r: any) => r.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectStructuredUrl(row.url, row.id);
    expectNoTextPermalink(text);
  });

  // ── GATED MIXED-TYPE SURFACES (only context/task/decision get a url) ───────────
  test('branch_open / branch_current carry the spine permalink (text + structured)', async () => {
    const task = await viaTool('task_create', { title: 'branch spine task', type: 'feature' });
    const taskId = task.structuredContent.task.id;

    const opened = await viaTool('branch_open', { id: taskId });
    expectPermalink(responseText(opened), taskId);
    expectStructuredUrl(opened.structuredContent.position.spineUrl, taskId);

    const current = await viaTool('branch_current', {});
    expectStructuredUrl(current.structuredContent.position.spineUrl, taskId);

    await viaTool('branch_close', {});
  });

  test('get_links carries the connected-endpoint permalink (text + structured)', async () => {
    const a = await viaTool('context_store', { content: 'link endpoint A', type: 'planning' });
    const b = await viaTool('context_store', { content: 'link endpoint B', type: 'planning' });
    const aId = a.structuredContent.context.id;
    const bId = b.structuredContent.context.id;
    await viaTool('link', { from: aId, fromType: 'context', to: bId, toType: 'context', edgeType: 'related_to' });

    const resp = await viaTool('get_links', { id: aId });
    const edges: any[] = (resp.structuredContent?.results ?? []).filter((e: any) => e.connectedId);
    expect(edges.length).toBeGreaterThan(0);
    // Every connected (resolvable) endpoint carries connectedUrl = recordUrl(connectedId).
    for (const edge of edges) expectStructuredUrl(edge.connectedUrl, edge.connectedId);
    expectPermalink(responseText(resp), bId);
  });

  test('recall_thread carries a permalink per node (text + structured)', async () => {
    const a = await viaTool('context_store', { content: 'recall node alpha vireo', type: 'planning' });
    const b = await viaTool('context_store', { content: 'recall node beta vireo', type: 'planning' });
    const aId = a.structuredContent.context.id;
    const bId = b.structuredContent.context.id;
    await viaTool('link', { from: aId, fromType: 'context', to: bId, toType: 'context', edgeType: 'related_to' });

    const resp = await viaTool('recall_thread', { anchor: aId });
    const nodes: any[] = (resp.structuredContent?.nodes ?? []).filter((n: any) => n.id);
    expect(nodes.length).toBeGreaterThan(0);
    // Nodes are context/task/decision (resolvable) → each carries url = recordUrl(node.id).
    for (const node of nodes) expectStructuredUrl(node.url, node.id);
    expectNoTextPermalink(responseText(resp));
  });

  test('smart_search carries a permalink per resolvable result (text + structured)', async () => {
    await viaTool('context_store', { content: 'smart search permalink probe narwhal', type: 'planning' });
    const resp = await viaTool('smart_search', { query: 'narwhal', includeTypes: ['context'] });
    const rows: any[] = (resp.structuredContent?.results ?? []).filter((r: any) => r.id);
    expect(rows.length).toBeGreaterThan(0);
    // Only context/task/decision get a url; the probe is a context → url present per row.
    for (const row of rows) expectStructuredUrl(row.url, row.id);
    expectNoTextPermalink(responseText(resp));
  });

  // ── SANITY: the URL really is the shared-helper /r/<id8> form ──────────────────
  test('the emitted permalink is the plain /r/<id8> URL from the shared helper', async () => {
    const resp = await viaTool('context_store', { content: 'shape check', type: 'planning' });
    const id = resp.structuredContent.context.id;
    const text = responseText(resp);
    expect(text).toContain(`${COMMAND_BASE_URL}/r/${id.slice(0, 8)}`);
    expect(text).toMatch(/https:\/\/[^\s]+\/r\/[0-9a-f]{8}/);
    // And the structured field is the identical shared-helper URL.
    expect(resp.structuredContent.context.url).toBe(`${COMMAND_BASE_URL}/r/${id.slice(0, 8)}`);
  });
});
