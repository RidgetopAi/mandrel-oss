/**
 * Dual-Channel Output Contract Guard (an earlier task — structuredContent + outputSchema
 * on ALL tools, and the markdown-in-values root-cause fix).
 *
 * THE BUG CLASS this locks shut:
 *   Tools used to return ONLY a human-readable prose `content` blob. Machines had to
 *   regex-parse that prose to recover ids/names/statuses — fragile, and the ROOT of
 *   the markdown-in-values class (a DB value with `**bold**` leaked its markup into
 *   the only "data" channel, the marked-up text). The fix: every tool now carries a
 *   machine-readable `structuredContent` (RAW values) that conforms to a declared
 *   `outputSchema`, alongside a short human `content` summary.
 *
 * THE GUARDS (all deterministic):
 *   G1 — EVERY tool definition declares an `outputSchema` (no tool left behind).
 *   G2 — A representative tool of each response SHAPE (list / get / mutate / status)
 *        returns `structuredContent` that VALIDATES against its declared outputSchema.
 *        Driven through the REAL public tool path (validate → route → migrated DB),
 *        same idiom as decisionLearningLoopRead.contract.test.ts. Validation via ajv.
 *   G3 — structuredContent values are RAW: a project whose NAME contains markdown in
 *        the DB does NOT appear with `**` in structuredContent (root-cause fix locked).
 *   G4 — the short human `content` text is retained (dual-channel, not data-only).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import Ajv from 'ajv';

import { db } from '../config/database.js';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';
import { outputZodSchemas } from '../config/outputSchemas.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const ajv = new Ajv({ allErrors: true, strict: false });

const STAMP = Date.now();
// A project name carrying MARKDOWN in the DB — the root-cause test vector. The raw
// machine channel MUST surface the unmarked name; the markup must not leak through.
const RAW_NAME = `dual-channel proj ${STAMP}`;
const MD_NAME = `**${RAW_NAME}**`;
// ONE CONNECTION, BOUND TO THIS FILE'S PROJECT. Nothing here asserts a
// project-scoped RESULT — project_list is a whole-database listing and stays one — but
// every route entry resolves a project first, and an unchosen one resolves to
// `projects[0] ORDER BY updated_at DESC`: whichever project this DATABASE touched last.
const CONN = `dual-channel-conn-${STAMP}`;

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/**
 * Run a tool through the SAME path the HTTP bridge uses: validate THEN routeExecutor.
 * routeExecutor applies the dual-channel SEAM (ensureStructuredContent), so the test
 * exercises EXACTLY the structuredContent the client receives — including the central
 * `ok` stamp — not the raw pre-seam handler return.
 */
async function viaPublicTool(
  toolName: string,
  rawArgs: any
): Promise<{ content: any[]; structuredContent: Record<string, any>; isError?: boolean }> {
  const validated = validateToolArguments(toolName, rawArgs);
  const resp = (await routeExecutor(toolName, validated, { connectionId: CONN })) as any;
  // The seam guarantees this; assert so the rest of the test is non-null typed.
  expect(resp.structuredContent, `${toolName} must carry structuredContent`).toBeTruthy();
  return resp;
}

/** The JSON Schema the SDK would advertise for a tool (from the tool definition). */
function outputSchemaFor(toolName: string): any {
  const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === toolName);
  expect(def, `tool definition for ${toolName}`).toBeTruthy();
  return def!.outputSchema;
}

/** Assert structuredContent is present AND validates against the tool's outputSchema. */
function expectValidStructured(toolName: string, resp: any) {
  expect(resp.structuredContent, `${toolName} must return structuredContent`).toBeTruthy();
  const schema = outputSchemaFor(toolName);
  const validate = ajv.compile(schema);
  const ok = validate(resp.structuredContent);
  expect(
    ok,
    `${toolName} structuredContent must validate against its outputSchema. ` +
      `Errors: ${JSON.stringify(validate.errors)} | Got: ${JSON.stringify(resp.structuredContent)}`
  ).toBe(true);
}

describe('dual-channel output (structuredContent + outputSchema on ALL tools)', () => {
  beforeAll(async () => {
    // Insert a project whose NAME literally contains markdown (root-cause vector).
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'dual-channel fuse') RETURNING id`,
        [MD_NAME]
      )
    ).rows[0].id;
    await bindConnectionToProject(CONN, projectId);
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── G1: ALL tools declare an outputSchema ────────────────────────────────────
  test('G1: EVERY tool definition declares an outputSchema (no tool left behind)', () => {
    const missing = AIDIS_TOOL_DEFINITIONS.filter((d) => !d.outputSchema).map((d) => d.name);
    expect(
      missing,
      `these tools have NO outputSchema — every tool must declare one: ${missing.join(', ')}`
    ).toEqual([]);

    // And each outputSchema is a well-formed object JSON Schema the SDK accepts.
    for (const d of AIDIS_TOOL_DEFINITIONS) {
      expect(d.outputSchema!.type, `${d.name}.outputSchema.type`).toBe('object');
      expect(() => ajv.compile(d.outputSchema as any), `${d.name}.outputSchema compiles`).not.toThrow();
    }
  });

  test('G1b: the output-schema registry covers exactly the active tool set', () => {
    // Every active tool definition has a registry entry (the import-time attach guard
    // would have thrown otherwise) — assert here too so the relationship is explicit.
    for (const d of AIDIS_TOOL_DEFINITIONS) {
      expect(d.name in outputZodSchemas, `${d.name} has an outputZodSchemas entry`).toBe(true);
    }
  });

  // ── G2: a representative tool of each SHAPE returns valid structuredContent ───
  test('G2 (status shape): mandrel_ping → structuredContent validates', async () => {
    const resp = await viaPublicTool('mandrel_ping', { message: 'hi' });
    expectValidStructured('mandrel_ping', resp);
    expect(resp.structuredContent.ok).toBe(true);
    expect(textOf(resp).length, 'short human text retained').toBeGreaterThan(0); // G4
  });

  test('G2 (mutate shape): project_create → structuredContent validates + carries the record', async () => {
    const created = await viaPublicTool('project_create',
      { name: `dc-create-${STAMP}`, description: 'mutate-shape fuse' });
    expectValidStructured('project_create', created);
    expect(created.structuredContent.action).toBe('created');
    expect(created.structuredContent.project.id).toBeTruthy();
    expect(created.structuredContent.project.name).toBe(`dc-create-${STAMP}`);
    expect(textOf(created)).toContain('created'); // G4 dual-channel text
    // cleanup this side project
    await db.query('DELETE FROM projects WHERE id = $1', [created.structuredContent.project.id]);
  });

  test('G2 (list shape): project_list → structuredContent is a typed results array', async () => {
    const resp = await viaPublicTool('project_list', {});
    expectValidStructured('project_list', resp);
    expect(Array.isArray(resp.structuredContent.results)).toBe(true);
    expect(typeof resp.structuredContent.total).toBe('number');
  });

  test('G2 (get shape): project_info → structuredContent validates with found+record', async () => {
    const resp = await viaPublicTool('project_info', { project: projectId });
    expectValidStructured('project_info', resp);
    expect(resp.structuredContent.found).toBe(true);
    expect(resp.structuredContent.project.id).toBe(projectId);
  });

  test('G2 (list shape, real DB write+read): context_store then context_get_recent validate', async () => {
    const stored = await viaPublicTool('context_store',
      { content: `dual-channel ctx ${STAMP}`, type: 'completion', tags: ['dc-test'], projectId });
    expectValidStructured('context_store', stored);
    expect(stored.structuredContent.context.id).toBeTruthy();

    const recent = await viaPublicTool('context_get_recent',
      { projectId, limit: 5 });
    expectValidStructured('context_get_recent', recent);
    expect(recent.structuredContent.results.length).toBeGreaterThan(0);
    // RAW value check: the stored content round-trips clean in structuredContent.
    const row = recent.structuredContent.results.find((r: any) => r.content.includes(`dual-channel ctx ${STAMP}`));
    expect(row, 'stored context present in structured results').toBeTruthy();
  });

  test('G2 (mutate shape, real DB): task_create → structuredContent validates', async () => {
    const created = await viaPublicTool('task_create',
      { title: `dc-task-${STAMP}`, type: 'feature', projectId });
    expectValidStructured('task_create', created);
    expect(created.structuredContent.task.title).toBe(`dc-task-${STAMP}`);
    expect(created.structuredContent.task.id).toBeTruthy();
  });

  // ── G3: structuredContent values are RAW (markdown-in-values root-cause fix) ──
  test('G3: a project NAME with markdown in the DB is RAW in structuredContent (no `**`)', async () => {
    // project_current resolves the markdown-named project; structuredContent.name must
    // be the UNMARKED name. This is the exact root-cause the task calls out.
    const infoResp = await viaPublicTool('project_info', { project: projectId });
    const sc = infoResp.structuredContent;
    expect(sc.project.name).toBe(RAW_NAME);        // unmarked
    expect(sc.project.name).not.toContain('**');   // markup stripped at source
    // The DB really does still hold the marked-up name (so this isn't a false pass).
    const dbName = (await db.query('SELECT name FROM projects WHERE id = $1', [projectId])).rows[0].name;
    expect(dbName).toBe(MD_NAME);
    expect(dbName).toContain('**');

    // And it's raw through the list shape too (whole-class, not one path).
    const listResp = await viaPublicTool('project_list', {});
    const listed = listResp.structuredContent.results.find((p: any) => p.id === projectId);
    expect(listed, 'markdown-named project present in list').toBeTruthy();
    expect(listed.name).toBe(RAW_NAME);
    expect(listed.name).not.toContain('**');
  });

  // ── G4: dual-channel — short human text retained on representative tools ──────
  test('G4: tools keep a non-empty short human `content` summary (dual-channel)', async () => {
    const resp = await viaPublicTool('project_list', {});
    expect(textOf(resp).length).toBeGreaterThan(0);
    expect(resp.structuredContent).toBeTruthy();
  });
});
