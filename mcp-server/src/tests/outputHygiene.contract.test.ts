/**
 * Output Hygiene Contract Guard (an earlier task — text-channel value-cleaning at the
 * SOURCE + project_list pagination with honest truncation reporting).
 *
 * THE TWO BUG CLASSES this locks shut:
 *
 *  PART A — markdown-in-VALUES leaking into the HUMAN TEXT channel.
 *    an earlier Task fixed the MACHINE channel (structuredContent runs DB values through
 *    rawValue()). But a project literally named `**x**` in the DB still rendered its
 *    raw markup as LITERAL `**` in the human prose (project_current/project_info text).
 *    The fix runs short DB-sourced IDENTIFIER values (names/titles) through rawValue()
 *    at the render site so stored markup never prints literal. CONTENT fields (a
 *    context body, a decision rationale) are left as markdown ON PURPOSE — they're
 *    meant to be markdown. G_A asserts both halves: names clean, content preserved.
 *
 *  PART B — project_list returned EVERY project unbounded (output bloat). Now it pages
 *    (limit default 20, offset) and reports total-vs-returned + a "showing N of M"
 *    truncation note. Never a silent cut. G_B asserts the limit is applied, the counts
 *    are honest, and the note appears only when truncated.
 *
 * Driven through the REAL public tool path (validate → routeExecutor → migrated DB),
 * the same idiom as dualChannelOutput.contract.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = Date.now();

// Root-cause vector: a project whose NAME literally contains markdown in the DB.
const A_RAW = `hygiene proj ${STAMP}`;
const A_MD = `**${A_RAW}**`;
// Description is treated as a short identifier VALUE (rendered inline in info/list), so
// it IS cleaned. Keep the inner text free of markdown so the cleaned form is exactly
// A_DESC_RAW (the only stripping is the outer `**` wrapper applied at insert time).
const A_DESC_RAW = `desc line ${STAMP}`;

let mdProjectId: string;
const pageProjectIds: string[] = [];

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return (await routeExecutor(toolName, validated)) as any;
}

describe('output hygiene — text-channel value-cleaning + project_list pagination', () => {
  beforeAll(async () => {
    // A markdown-named project for PART A.
    mdProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
        [A_MD, `**${A_DESC_RAW}**`]
      )
    ).rows[0].id;

    // A burst of projects for PART B pagination (more than the default limit window we
    // exercise). Distinct stamped names so they're unambiguous in the result set.
    for (let i = 0; i < 5; i++) {
      const id = (
        await db.query(
          `INSERT INTO projects (name, description) VALUES ($1, 'pagination fuse') RETURNING id`,
          [`hygiene-page-${STAMP}-${i}`]
        )
      ).rows[0].id;
      pageProjectIds.push(id);
    }
  });

  afterAll(async () => {
    const ids = [mdProjectId, ...pageProjectIds].filter(Boolean);
    for (const id of ids) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [id]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [id]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── PART A: markdown in a project NAME renders CLEAN in human text (root-cause) ──
  test('G_A1: project_info TEXT renders a markdown DB name as CLEAN text (no doubled `**`)', async () => {
    const resp = await viaPublicTool('project_info', { project: mdProjectId });
    const text = textOf(resp);

    // WS1 (D2): the bold presentation wrapper is gone — the CLEAN render
    // is the bare name. The BUG signature (raw DB markup rendering as literal `**`) is
    // unchanged: rawValue() still strips it at render time.
    expect(text).toContain(`Project Information: ${A_RAW}`); // clean: bare name, no markup
    expect(text).not.toContain(`**`);                        // no literal markup at all

    // NOT-A-FALSE-PASS: the DB still holds the marked-up name (so cleaning happened at
    // render, the data was never mutated).
    const dbName = (await db.query('SELECT name FROM projects WHERE id = $1', [mdProjectId])).rows[0].name;
    expect(dbName).toBe(A_MD);
    expect(dbName).toContain('**');
  });

  test('G_A2: project_current TEXT renders a markdown DB name as CLEAN text', async () => {
    // Switch to the markdown-named project, then read project_current and assert its
    // human text is clean. (project_current renders the CURRENT project name.)
    await viaPublicTool('project_switch', { project: mdProjectId });
    const resp = await viaPublicTool('project_current', {});
    const text = textOf(resp);
    expect(text).toContain(A_RAW);
    expect(text).not.toContain(A_MD);
  });

  test('G_A3: a markdown DB description is also cleaned inline in project_info text', async () => {
    const resp = await viaPublicTool('project_info', { project: mdProjectId });
    const text = textOf(resp);
    expect(text).toContain(A_DESC_RAW);
    expect(text).not.toContain(`**${A_DESC_RAW}**`);
  });

  test('G_A4: CONTENT fields are NOT over-stripped — a markdown context body keeps its `**`', async () => {
    // Store a context whose BODY is legitimately markdown. The content channel must
    // PRESERVE the markup (both in structuredContent and in the human text) — we only
    // clean short identifier VALUES, never markdown content bodies.
    const body = `# Heading ${STAMP}\n\nThis has **bold** and _italic_ and \`code\` — all intentional markdown.`;
    const stored = await viaPublicTool('context_store',
      { content: body, type: 'completion', tags: [`hygiene-content-${STAMP}`], projectId: mdProjectId });
    expect(stored.structuredContent?.context?.id).toBeTruthy();

    const recent = await viaPublicTool('context_get_recent', { projectId: mdProjectId, limit: 5 });
    const row = recent.structuredContent.results.find((r: any) => r.content.includes(`Heading ${STAMP}`));
    expect(row, 'stored markdown context present').toBeTruthy();
    // The markdown body round-trips INTACT — not stripped.
    expect(row.content).toContain('**bold**');
    expect(row.content).toContain('_italic_');
    expect(row.content).toContain('`code`');
    // And the human text channel keeps it too.
    expect(textOf(recent)).toContain('**bold**');
  });

  // ── PART B: project_list pagination + honest truncation reporting ────────────────
  test('G_B1: project_list respects `limit` and reports total vs returned', async () => {
    const resp = await viaPublicTool('project_list', { limit: 2 });
    const sc = resp.structuredContent;
    expect(sc.returned).toBe(2);
    expect(sc.results.length).toBe(2);
    expect(sc.limit).toBe(2);
    // total is the FULL count (we inserted 6 projects, plus whatever else exists) and
    // must strictly exceed the returned page (so this is a real truncation).
    expect(sc.total).toBeGreaterThanOrEqual(6);
    expect(sc.total).toBeGreaterThan(sc.returned);
    expect(sc.truncated).toBe(true);
  });

  test('G_B2: the truncation note ("showing N of M") appears in human text when truncated', async () => {
    const resp = await viaPublicTool('project_list', { limit: 2 });
    const text = textOf(resp);
    const total = resp.structuredContent.total;
    // Honest, human-readable truncation signal — never a silent cut.
    expect(text).toContain(`Showing 2 of ${total}`);
    expect(text).toContain('Projects (2 of');
  });

  test('G_B3: offset pages forward; no note when the window covers everything', async () => {
    // A limit at/above the total returns the whole set with truncated=false and NO note.
    const all = await viaPublicTool('project_list', { limit: 100 });
    const total = all.structuredContent.total;
    expect(all.structuredContent.returned).toBe(Math.min(total, 100));
    if (total <= 100) {
      expect(all.structuredContent.truncated).toBe(false);
      expect(textOf(all)).not.toContain('Showing ');
    }

    // offset skips rows; returned reflects the remaining window. Always honest counts.
    const offsetResp = await viaPublicTool('project_list', { limit: 2, offset: 1 });
    expect(offsetResp.structuredContent.offset).toBe(1);
    expect(offsetResp.structuredContent.returned).toBe(2);
    // offset>0 is itself a paged view → truncated reported true.
    expect(offsetResp.structuredContent.truncated).toBe(true);
  });

  test('G_B4: limit/offset arrive as STRINGS over the bridge and still coerce (coercedInt)', async () => {
    // The HTTP bridge serializes args as JSON strings — "2" must coerce to 2.
    const resp = await viaPublicTool('project_list', { limit: '2', offset: '0' });
    expect(resp.structuredContent.returned).toBe(2);
    expect(resp.structuredContent.limit).toBe(2);
    expect(resp.structuredContent.offset).toBe(0);
  });
});
