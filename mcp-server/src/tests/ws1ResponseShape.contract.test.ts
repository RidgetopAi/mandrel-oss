/**
 * WS1 "CLEAN THE PIPES" — MCP response shape (defect register
 * 0b077f1d, tool-output audit 7282379a).
 *
 * THE THREE MEASURED DEFECTS THIS PINS CLOSED:
 *   D1 — truncation stubs ("…[truncated; fetch the full record…]") in 6/13 read-tool
 *        responses on a 16-record project: the DEFAULT read path returned packaging
 *        instead of the record. Now: full records by default; 'concise' is an explicit
 *        opt-in (the opt-in truncation contract itself is pinned in
 *        t1Fluidity.contract.test.ts).
 *   D2 — 2.5–4.5x noise: MCP tool responses assembled as human-terminal text (emoji
 *        banners, per-row /r/<id8> permalink lines, multi-line trust prose) sent to
 *        MACHINE readers. Now: terse key:value text; permalinks ride structuredContent
 *        `url`; trust renders as explainTrust().signal (band/score + supersession flag).
 *   D3 — task_list omitted descriptions, so a task's blocked-reason was reachable only
 *        via a per-task task_details round-trip. Now: description rides the list, full,
 *        in BOTH channels.
 *
 * TWO LAYERS:
 *   PART A — behavioral, real tools through routeExecutor against the CI Postgres:
 *            the surfaces an agent actually reads are emoji-free / stub-free and carry
 *            the data.
 *   PART B — static source scan of the WS1-scoped route files (the population the audit
 *            named), so an emoji re-introduced into a handler PART A happens not to
 *            drive still goes RED. The scanner is a pure function and PART B probes it
 *            with fabricated corpora (C3: a guard is a product and can be hollow).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
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
import { RECALL_CONCISE_MAXLEN, RECALL_DEFAULT_FORMAT } from '../config/recallConfig.js';
import { explainTrust } from '../services/trustModel.js';
import type { Trust } from '../services/trustModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(__dirname, '../routes');

const STAMP = Date.now();
const CONN = `ws1-shape-conn-${STAMP}`;
const PROJ_NAME = `ws1-shape-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN });
}

// The emoji detector + payload-line scanner moved VERBATIM to helpers/emojiScan.ts so
// WS2's briefing test reuses the SAME definitions (one scanner, no drift).
// The probes at the bottom of this file remain the scanner's adversarial suite.
import { EMOJI_RE, emojiPayloadLines } from './helpers/emojiScan.js';
export { emojiPayloadLines };

/** Assert a tool RESPONSE text is emoji-free, with the offending line in the failure. */
function expectEmojiFree(text: string, surface: string): void {
  const hit = text.split('\n').find((l) => EMOJI_RE.test(l));
  expect(hit, `${surface} emitted emoji in MCP text: "${hit}"`).toBeUndefined();
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * PART B's SCANNER — pure over a source string so the probes below can attack it.
 *
 * POPULATION (stated per C3, and WHY it is the whole audited one): the SIX route files
 * the WS1 audit (7282379a) measured as noise sources — context, tasks, decisions,
 * search, recall, project. session/branch/links/artifact routes were NOT in the audit's
 * scope and still carry their old styling; widening the population is a deliberate
 * follow-up, not a silent scope creep here.
 *
 * EXCLUSIONS inside a scanned file, each with a reason:
 *   - comment lines (`//`, `*`)      — not payload; several document the OLD format.
 *   - logger.* lines                 — server logs, not MCP payload.
 *   - the project_current handler's parse-contract lines are NOT excluded; that file's
 *     remaining emoji live on logger/comment lines plus project_current's preserved
 *     text, which is explicitly exempted below by its marker comment window.
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** The WS1-scoped route files (the audit's named noise sources). */
export const WS1_ROUTE_FILES = [
  'context.routes.ts',
  'tasks.routes.ts',
  'decisions.routes.ts',
  'search.routes.ts',
  'recall.routes.ts',
  'project.routes.ts',
] as const;

// (emojiPayloadLines now lives in helpers/emojiScan.ts — imported + re-exported above.)

describe('WS1 response shape — PART A: the wire is lean', () => {
  let bigId: string;
  let blockedTaskId: string;
  const BLOCKED_REASON = `blocked on the flag registry migration ${STAMP}`;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'ws1 response shape') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    // D1 probe: a body comfortably over the concise budget.
    const big = await viaTool('context_store', {
      content: `WS1-BIG ${STAMP} ` + 'y'.repeat(RECALL_CONCISE_MAXLEN + 300),
      type: 'planning',
      tags: ['ref:ws1-big'],
    });
    bigId = big.structuredContent.context.id;

    // D3 probe: a BLOCKED task whose description carries the blocked-reason.
    const blocked = await viaTool('task_create', {
      title: `ws1 blocked task ${STAMP}`,
      type: 'general',
      status: 'blocked',
      /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent',
      description: BLOCKED_REASON,
    });
    blockedTaskId = blocked.structuredContent.task.id;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── D1: full records by default ─────────────────────────────────────────────
  test('D1: the DEFAULT format is detailed, from the config layer', () => {
    // The default is config-derived (env MANDREL_RECALL_DEFAULT_FORMAT), not a buried
    // literal; in the unoverridden CI environment it is 'detailed'.
    expect(RECALL_DEFAULT_FORMAT).toBe('detailed');
  });

  test('D1: default context_search returns the FULL body — zero stub text', async () => {
    const resp = await viaTool('context_search', { tags: ['ref:ws1-big'] });
    const row = resp.structuredContent.results.find((r: any) => r.id === bigId);
    expect(row).toBeTruthy();
    expect(row.truncated).toBe(false);
    expect(row.content.length).toBeGreaterThan(RECALL_CONCISE_MAXLEN);
    expect(responseText(resp)).not.toContain('[truncated;');
  });

  test('D1: default context_get_recent returns the FULL body — zero stub text', async () => {
    const resp = await viaTool('context_get_recent', { limit: 10 });
    const row = resp.structuredContent.results.find((r: any) => r.id === bigId);
    expect(row).toBeTruthy();
    expect(row.truncated).toBe(false);
    expect(responseText(resp)).not.toContain('[truncated;');
  });

  // ── D3: task_list carries descriptions (where blocked-reasons live) ─────────
  test('D3: task_list TEXT carries the blocked task\'s full description', async () => {
    const resp = await viaTool('task_list', { statuses: ['blocked'] });
    const text = responseText(resp);
    expect(text).toContain(BLOCKED_REASON); // the whole reason, no truncation
  });

  test('D3: task_list structured rows carry description', async () => {
    const resp = await viaTool('task_list', { statuses: ['blocked'] });
    const row = resp.structuredContent.results.find((r: any) => r.id === blockedTaskId);
    expect(row).toBeTruthy();
    expect(row.description).toBe(BLOCKED_REASON);
  });

  // ── D2: the read/list/search surfaces are emoji-free and permalink-line-free ─
  test('D2: every WS1 read surface is emoji-free on the wire', async () => {
    const surfaces: Array<[string, any]> = [
      ['context_search', { tags: ['ref:ws1-big'] }],
      ['context_search', { id: bigId }],
      ['context_get_recent', { limit: 10 }],
      ['task_list', {}],
      ['task_details', { taskId: blockedTaskId }],
      ['decision_search', { limit: 5 }],
      ['smart_search', { query: `ws1 ${STAMP}` }],
      ['recall_thread', { anchor: bigId, altitude: 'headline' }],
      ['project_list', { limit: 5 }],
      ['project_info', { project: projectId }],
      ['task_progress_summary', {}],
      ['context_stats', {}],
      // NOTE: project_current is deliberately ABSENT — its text is the one MCP surface a
      // human-facing consumer parses (Command UI parseAidisProjectName) and is exempt.
    ];
    for (const [tool, args] of surfaces) {
      const resp = await viaTool(tool, args);
      expectEmojiFree(responseText(resp), tool);
    }
  });

  test('D2: write acks are emoji-free too, and keep the stable ID: marker', async () => {
    const stored = await viaTool('context_store', { content: `ws1 ack probe ${STAMP}`, type: 'planning' });
    const text = responseText(stored);
    expectEmojiFree(text, 'context_store');
    expect(text).toMatch(/\bID:\s*[0-9a-f-]{36}/i); // id-parsing consumers still work

    const task = await viaTool('task_create', { title: `ws1 ack task ${STAMP}`, type: 'general' });
    expectEmojiFree(responseText(task), 'task_create');
    expect(responseText(task)).toMatch(/\bID:\s*[0-9a-f-]{36}/i);
  });

  test('D2: read-surface TEXT carries no per-row /r/ permalink lines; structured rows keep url', async () => {
    const resp = await viaTool('context_search', { tags: ['ref:ws1-big'] });
    expect(responseText(resp)).not.toContain('/r/');
    const row = resp.structuredContent.results.find((r: any) => r.id === bigId);
    expect(row.url).toContain(`/r/${bigId.slice(0, 8)}`);
  });

  test('D2: the trust SIGNAL is terse and emoji-free, and keeps the supersession data', () => {
    // Unit-level: drive the ONE renderer directly across its branches.
    const base: Trust = {
      band: 'unproven',
      score: 1.0,
      freshness: 1.0,
      abstain: false,
      reason: 'cold-start',
      promotionRequirement: 'x',
      // P5.3 half B: the backward-soft guard AUDIT is required on Trust and is never
      // undefined — an absent audit and a guard that did not run must not read alike.
      supersessionGuard: { enabled: false, checked: 0, suppressed: [], undecided: [] },
      outcome: { samples: 0, score: null },
      supersession: null,
    } as any;
    expect(explainTrust(base).signal).toBe('trust:unproven score:1.00');

    const superseded = {
      ...base,
      band: 'superseded',
      score: 0.1,
      abstain: true,
      reason: 'declared-superseded',
      supersession: { supersededBy: 'a1b2c3d4-0000-0000-0000-000000000000', tier: 'declared', confidence: null, reason: null },
    } as any;
    const sig = explainTrust(superseded).signal;
    // The audited-correct, load-bearing information survives: WHO superseded it, and how.
    expect(sig).toBe('trust:superseded score:0.10 superseded_by:a1b2c3d4 tier:declared abstain');
    expect(EMOJI_RE.test(sig)).toBe(false);
  });
});

describe('WS1 response shape — PART B: static scan of the audited files', () => {
  test.each([...WS1_ROUTE_FILES])('%s assembles no emoji into payload lines', (file) => {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    let offending = emojiPayloadLines(src);
    if (file === 'project.routes.ts') {
      // The ONE exemption, held narrow: project_current's parsed text (the 🟢 line) and
      // its binding-provenance block. Anything ELSE in the file must be clean.
      offending = offending.filter(
        (l) => !l.includes('Current Project:') && !l.includes('scope source:') && !l.includes('interactive slot')
      );
    }
    expect(offending, `emoji payload lines in ${file}:\n${offending.join('\n')}`).toEqual([]);
  });

  test('the population is non-empty and names all six audited files', () => {
    // A loop over [] is green having checked nothing (C3: empty population).
    expect(WS1_ROUTE_FILES.length).toBe(6);
    for (const f of WS1_ROUTE_FILES) {
      expect(() => readFileSync(join(ROUTES_DIR, f), 'utf8')).not.toThrow();
    }
  });

  // ── the scanner is itself a product: probe it (C3) ──────────────────────────
  test('PROBE: an emoji in a template literal is a FINDING (mutation lands → RED)', () => {
    const mutated = 'const text = `📄 Context Details ${id}`;\n';
    expect(emojiPayloadLines(mutated)).toHaveLength(1);
  });

  test('PROBE: emoji in comments and logger lines are NOT findings (the exclusions work)', () => {
    expect(emojiPayloadLines('// 📄 documents the OLD format\n')).toEqual([]);
    expect(emojiPayloadLines(' * 📄 jsdoc line\n')).toEqual([]);
    expect(emojiPayloadLines('logger.info(`🔍 Context search request`);\n')).toEqual([]);
  });

  test('PROBE: the empty corpus is clean, and the CONTROL detector matches real emoji', () => {
    expect(emojiPayloadLines('')).toEqual([]);
    for (const e of ['🆔', '📄', '⚠️', '✅', '🔐', '⏰', '🟢']) {
      expect(EMOJI_RE.test(e), `EMOJI_RE must match ${e}`).toBe(true);
    }
    expect(EMOJI_RE.test('plain text — with dashes, bullets - and: colons')).toBe(false);
  });
});
