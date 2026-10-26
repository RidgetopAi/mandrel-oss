/**
 * PROJECT SCOPE — THE CHOKE POINT IS THE ACCESSOR, NOT THE SCHEMA.
 * governed by an earlier decision.
 *
 * =============================================================================
 * WHAT WENT WRONG, AND WHY NO EXISTING TEST COULD HAVE CAUGHT IT
 * =============================================================================
 * An Amp evaluator, testing live on 2026-07-26 with `X-Mandrel-Project` set, saw ONE
 * connection report `project.current` → "daily log" while `session.list`'s default scope was
 * "amp-eval-3". The binding gate materialised the resolved project into each tool's OWN
 * project ARGUMENT, so materialisation was only ever as wide as the SCHEMA SURFACE: a tool
 * declaring no project param had the ladder's answer computed and then DISCARDED.
 *
 * `projectBindingRouteGate.contract.test.ts` sweeps "every tool where `projectScopeParam(tool)`
 * is defined". `project_current` has no scope param, so it was excluded from that guard's
 * population BY CONSTRUCTION — the guard's set was definitionally the COMPLEMENT of the bug.
 *
 * =============================================================================
 * SO THIS FILE GUARDS TWO THINGS, IN TWO DIFFERENT WAYS
 * =============================================================================
 * PART A — ACCOUNTING (static, deny-by-default). Anchored on the `getCurrentProjectId` /
 *   `getCurrentProject` call sites, which is the token every project resolution must pass
 *   through. An unclassified call site is a RED. See `helpers/projectScopeAudit.ts`.
 *
 * PART B — SELF-CHECK MUTATIONS (the probe probing itself). The auditor is pure over an
 *   in-memory corpus, so Part B feeds it FABRICATED corpora — unmarked / mismatched /
 *   ambiguous / comment-only / EMPTY — and asserts each is caught. A product mutation going
 *   RED does not prove the self-check works; zero/empty/absent are the values that slip
 *   through (a past incident #6). Part B also asserts a CORRECT corpus is GREEN, so the guard is
 *   not merely always-RED.
 *
 * PART C — BEHAVIOUR (real Postgres, real `routeExecutor`, real binding). CROSS-CHECKS TWO
 *   REAL TOOLS AGAINST EACH OTHER: it derives "the project this client's writes actually land
 *   in" from a real `context_store`'s DB row, and asserts `project_current`, `thread_current`,
 *   `session_get`, `session_list` and `project_list` all name THAT project. Nothing here
 *   asserts the ladder in isolation, because the ladder was never wrong — the REPORTING was.
 *
 * PART D — the two FUNCTIONAL bugs: `thread_set` → `thread_current` must round-trip under a
 *   binding, and `thread_clear` must clear the slot `thread_set` wrote.
 *
 * PART E — the connect-time `instructions` string, which is the EARLIEST lie: it is emitted at
 *   `initialize`, before any tool call can run.
 *
 * Runs inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { runScopedTmpPath } from './helpers/runScopedTmp.js';
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import { patternEmbedding } from './helpers/embedGeometry.js';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';

// Distinct ids per real create (global setup mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Embeddings are stubbed offline (native transformers unavailable in CI); the DB write path
// and the project resolution under test still run for real.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding() })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { projectHandler } from '../handlers/project.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { resolveInstructions, buildWriteEcho } from '../utils/projectEcho.js';
import {
  DEFAULT_PROJECT_HINT,
  BOUND_PROJECT_HINT,
  formatInstructions,
} from '../config/projectEchoConfig.js';
import { runWithProjectScope } from '../services/effectiveProjectScope.js';
import { readPosition } from '../services/branchPosition.js';
import { composePositionKey } from '../config/positionKeyConfig.js';
import { PROJECT_BINDING_ENV_VAR, PROJECT_BINDING_HEADER } from '../config/projectBindingConfig.js';
import { validateToolArguments } from '../middleware/validation.js';
import {
  auditProjectScope,
  findScopeCallSites,
  blankComments,
  ACCESSOR_DEFINITION_FILE,
} from './helpers/projectScopeAudit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..');

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART A — deny-by-default call-site accounting
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE rung-3 PIN — the LITERAL per-file count of binding-BLIND project reads.
 *
 * rung 3 (`getInteractiveProjectId`/`getInteractiveProject`) is the escape hatch from
 * binding-awareness. an earlier Decision makes the binding authoritative for what every tool
 * REPORTS, so every remaining rung-3 read has to be a read whose SUBJECT is rung 3 itself.
 * Pinned per file (not merely counted `> 0`) so that adding one is a two-file diff — a
 * decision, not a drift (a past incident #7).
 *
 *   handlers/project.ts (3)
 *     • getCurrentProjectId's own fall-through when nothing is bound
 *     • initializeSession — rung-3 machinery: it DECIDES what to write into the human slot
 *     • getInteractiveProject's own resolution
 *   services/projectSwitchValidator.ts (6)
 *     the switch machinery: source/rollback capture and the post-switch assertions that the
 *     INTERACTIVE slot actually moved. Reading the effective scope there would let a binding
 *     satisfy "the switch landed" while rung 3 silently failed to update.
 *   routes/project.routes.ts (1)
 *     project_current's provenance block, which exists precisely to show rung 3 ALONGSIDE the
 *     effective scope so the two are legible rather than conflated.
 */
const RUNG3_CALL_SITE_PIN: Readonly<Record<string, number>> = Object.freeze({
  'handlers/project.ts': 3,
  'services/projectSwitchValidator.ts': 6,
  'routes/project.routes.ts': 1,
});

/** The four accessors, all defined in exactly one file. */
const EXPECTED_ACCESSOR_DEFINITIONS = 4;

/**
 * SCAN-INTEGRITY PIN — the total number of accessor call sites in CODE (comments excluded).
 * Asserted, not narrated: a number in a test that nothing enforces is prose, which is the
 * phantom-guard class this task also fixes over in projectBindingRouteGate. If you add a
 * (properly classified) call site, bump this in the same commit.
 *
 * 42 -> 43: the request-log project attribution (server/MandrelMcpServer.ts `loggingProjectId`)
 * stopped reaching into `projectHandler['sessionStates']` binding-blind and now resolves the
 * EFFECTIVE scope through the accessor — so it became a classified call site rather than an
 * unaudited side door. That is the pin doing its job: a new read is a two-file decision.
 *
 * 43 -> 44: project_briefing (WS2) — handleBriefing's default-project
 * 44 -> 45: the archive-disclosure seam — applyArchiveDisclosure in
 *   routes/index.ts resolves the project the same way the op it is describing did, so
 *   the disclosed population matches the population that was read.
 * resolution (routes/project.routes.ts, getCurrentProject) is classified `effective`:
 * a hook-injected briefing must describe the BOUND project, never the interactive slot.
 * 45 -> 44: the code-scan routes module was removed with its
 *   one project-scope call site.
 */
const EXPECTED_TOTAL_CALL_SITES = 44;

/** Every .ts file under src/, EXCLUDING tests — tests legitimately mention the accessors. */
function sourceFiles(dir: string = SRC_DIR, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'tests' || entry === 'node_modules' || entry === 'dist') continue;
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function realCorpus(): Map<string, string> {
  const m = new Map<string, string>();
  for (const full of sourceFiles()) {
    m.set(relative(SRC_DIR, full).split('\\').join('/'), readFileSync(full, 'utf8'));
  }
  return m;
}

describe('PART A — every project-scope call site is accounted for (deny by default)', () => {
  test('the real tree has ZERO unclassified / mismatched project-scope call sites', () => {
    const result = auditProjectScope(
      realCorpus(),
      RUNG3_CALL_SITE_PIN,
      EXPECTED_ACCESSOR_DEFINITIONS,
      EXPECTED_TOTAL_CALL_SITES
    );

    if (result.violations.length > 0) {
      throw new Error(
        `${result.violations.length} project-scope violation(s):\n\n` +
          result.violations.map((v) => `  ✗ ${v}`).join('\n\n') +
          `\n\nScanned ${result.sites.length} call site(s): ` +
          `${result.byClass.effective} effective, ${result.byClass.rung3} rung3, ` +
          `${result.byClass['accessor-definition']} accessor-definition.`
      );
    }
    // The scan measured the product, not nothing (the vacuous-pass check, asserted here too
    // so a future refactor of the auditor cannot quietly drop it).
    expect(result.sites.length).toBe(EXPECTED_TOTAL_CALL_SITES);
    expect(result.byClass.effective).toBeGreaterThan(0);
  });

  test('the accessors are defined in exactly one file', () => {
    const defs = findScopeCallSites(realCorpus()).filter(
      (s) => s.declared === 'accessor-definition'
    );
    expect(defs.length).toBe(EXPECTED_ACCESSOR_DEFINITIONS);
    expect(new Set(defs.map((d) => d.file))).toEqual(new Set([ACCESSOR_DEFINITION_FILE]));
  });

  test('the binding-blind (rung 3) reads are exactly the pinned set', () => {
    const result = auditProjectScope(
      realCorpus(),
      RUNG3_CALL_SITE_PIN,
      EXPECTED_ACCESSOR_DEFINITIONS,
      EXPECTED_TOTAL_CALL_SITES
    );
    expect(result.rung3ByFile).toEqual({ ...RUNG3_CALL_SITE_PIN });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART B — mutation-probe the PROBE (fabricated corpora)
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

const MARK_EFF = '// PROJECT-SCOPE: effective — resolves where this call writes.';
const MARK_R3 = '// PROJECT-SCOPE: rung3 — the interactive slot is the subject here.';

function corpusOf(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

/** A minimal corpus that SHOULD be clean, so each probe below mutates exactly one thing. */
function cleanCorpus(): Map<string, string> {
  return corpusOf({
    'routes/a.routes.ts': `${MARK_EFF}\nconst p = await projectHandler.getCurrentProjectId(sid);\n`,
    'services/b.ts': `${MARK_R3}\nconst q = await handler.getInteractiveProjectId(sid);\n`,
  });
}
const CLEAN_PIN = Object.freeze({ 'services/b.ts': 1 });

describe('PART B — the guard’s own self-checks are mutation-probed', () => {
  test('CONTROL: a correctly-classified corpus is GREEN (the guard is not always-RED)', () => {
    const r = auditProjectScope(cleanCorpus(), CLEAN_PIN, 0, 2);
    expect(r.violations).toEqual([]);
  });

  test('MUTATION 1: a NEW UNCLASSIFIED getCurrentProjectId call site is RED', () => {
    const c = cleanCorpus();
    c.set('routes/new.routes.ts', 'const x = await projectHandler.getCurrentProjectId(sid);\n');
    const r = auditProjectScope(c, CLEAN_PIN, 0, 3);
    expect(r.violations.some((v) => v.includes('UNCLASSIFIED'))).toBe(true);
    expect(r.violations.some((v) => v.includes('routes/new.routes.ts:1'))).toBe(true);
  });

  test('MUTATION 2: a call site moved off the binding-aware accessor (marker unchanged) is RED', () => {
    // This is the acceptance criterion "strip binding-awareness from any one call site".
    const c = corpusOf({
      'routes/a.routes.ts': `${MARK_EFF}\nconst p = await projectHandler.getInteractiveProjectId(sid);\n`,
      'services/b.ts': `${MARK_R3}\nconst q = await handler.getInteractiveProjectId(sid);\n`,
    });
    const r = auditProjectScope(c, CLEAN_PIN, 0, 2);
    expect(r.violations.some((v) => v.includes('CLASS/TOKEN MISMATCH'))).toBe(true);
  });

  test('MUTATION 3: a NEW rung-3 read breaks the literal pin even though it is classified', () => {
    const c = cleanCorpus();
    c.set('services/sneaky.ts', `${MARK_R3}\nconst q = await h.getInteractiveProject(sid);\n`);
    const r = auditProjectScope(c, CLEAN_PIN, 0, 3);
    expect(r.violations.some((v) => v.includes('rung-3 PIN BROKEN in services/sneaky.ts'))).toBe(
      true
    );
  });

  test('MUTATION 4: an EMPTY corpus is RED, not a vacuous pass', () => {
    const r = auditProjectScope(new Map(), CLEAN_PIN, 0, 0);
    expect(r.violations.some((v) => v.includes('corpus is EMPTY'))).toBe(true);
    expect(r.violations.some((v) => v.includes('ZERO project-scope call sites'))).toBe(true);
  });

  test('MUTATION 5: a corpus whose ONLY occurrences are in COMMENTS is RED (prose ≠ coverage)', () => {
    const c = corpusOf({
      'docs/note.ts':
        '/**\n * We resolve via projectHandler.getCurrentProjectId(sessionId) here.\n */\n' +
        '// and getInteractiveProjectId(sid) is the human path\n',
    });
    const r = auditProjectScope(c, {}, 0, 0);
    // Nothing in CODE ⇒ zero sites ⇒ the self-check fires. A text-only match would have
    // reported two "call sites" and passed.
    expect(r.sites.length).toBe(0);
    expect(r.violations.some((v) => v.includes('ZERO project-scope call sites'))).toBe(true);
  });

  test('MUTATION 6: an AMBIGUOUS marker block (two classes) is RED', () => {
    const c = corpusOf({
      'routes/amb.ts':
        `${MARK_EFF}\n${MARK_R3}\nconst p = await projectHandler.getCurrentProjectId(sid);\n`,
    });
    const r = auditProjectScope(c, {}, 0, 1);
    expect(r.violations.some((v) => v.includes('AMBIGUOUS'))).toBe(true);
  });

  test('MUTATION 7: a bare class label with no REASON does not classify (marker needs a why)', () => {
    const c = corpusOf({
      'routes/lazy.ts': '// PROJECT-SCOPE: effective\nconst p = await h.getCurrentProjectId(s);\n',
    });
    const r = auditProjectScope(c, {}, 0, 1);
    expect(r.violations.some((v) => v.includes('UNCLASSIFIED'))).toBe(true);
  });

  test('MUTATION 8: an accessor DEFINED outside its one home file is RED', () => {
    const c = corpusOf({
      'services/shadow.ts':
        '/** PROJECT-SCOPE: accessor-definition — a second copy of the accessor. */\n' +
        'async getCurrentProjectId(sid) { return null; }\n',
    });
    const r = auditProjectScope(c, {}, 1, 1);
    expect(r.violations.some((v) => v.includes('ACCESSOR DEFINED OUTSIDE'))).toBe(true);
  });

  test('MUTATION 9: the SCAN-INTEGRITY pin fires when the scan sees fewer sites than pinned', () => {
    // Simulates comment-stripping (or a rename) quietly hiding a real call site: same corpus,
    // pin says 3. A guard that only iterated what it found would report GREEN.
    const r = auditProjectScope(cleanCorpus(), CLEAN_PIN, 0, 3);
    expect(r.violations.some((v) => v.includes('expected exactly 3 project-scope call sites'))).toBe(
      true
    );
  });

  test('the marker cannot be smuggled in from ABOVE an unrelated statement', () => {
    const c = corpusOf({
      'routes/gap.ts':
        `${MARK_EFF}\nconst unrelated = 1;\nconst p = await h.getCurrentProjectId(sid);\n`,
    });
    const r = auditProjectScope(c, {}, 0, 1);
    expect(r.violations.some((v) => v.includes('UNCLASSIFIED'))).toBe(true);
  });

  test('blankComments does not treat `//` inside a string literal as a comment', () => {
    const blanked = blankComments(`const u = 'http://x'; const p = h.getCurrentProjectId(s);\n`);
    expect(blanked).toContain('getCurrentProjectId');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PARTS C-E — real Postgres, real routeExecutor, real binding
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

const STAMP = Date.now();
const BOUND_PROJECT = `sc-amp-eval-3-${STAMP}`;
const OTHER_PROJECT = `sc-daily-log-${STAMP}`;

let boundId: string;
let otherId: string;
let taskInBound: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** Call a tool exactly the way the live surface does: validated args, through routeExecutor. */
/** The actor every call in this file declares — named once, because the position key is
 *  composed FROM it (see CALL_SESSION_KEY below). */
const CALL_ACTOR = 'choke-point-test';

async function call(tool: string, args: any, conn: string, binding?: string): Promise<any> {
  return routeExecutor(tool, validateToolArguments(tool, args), {
    connectionId: conn,
    projectBinding: binding,
    actor: CALL_ACTOR,
  });
}

beforeAll(async () => {
  boundId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'bound') RETURNING id`, [
      BOUND_PROJECT,
    ])
  ).rows[0].id;
  otherId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'other') RETURNING id`, [
      OTHER_PROJECT,
    ])
  ).rows[0].id;
  taskInBound = (
    await db.query(
      `INSERT INTO tasks (project_id, title, status) VALUES ($1, $2, 'todo') RETURNING id`,
      [boundId, `anchor target ${STAMP}`]
    )
  ).rows[0].id;
});

afterAll(async () => {
  for (const t of ['contexts', 'tasks', 'technical_decisions', 'sessions']) {
    await db.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[boundId, otherId]]);
  }
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[boundId, otherId]]);
});

afterEach(() => {
  delete process.env[PROJECT_BINDING_ENV_VAR];
});

/**
 * Reproduce the evaluator's connection EXACTLY: rung 3 pinned to the WRONG project (that is
 * what auto-selection did to a fresh orb), and a binding naming the right one. Every assertion
 * below then has a real chance to fail — if the reporting tools fell back to rung 3 they would
 * name OTHER_PROJECT, which is precisely the bug.
 */
async function connectionWithRung3OnTheWrongProject(label: string): Promise<string> {
  const conn = `${label}-${STAMP}`;
  await call('project_switch', { project: OTHER_PROJECT }, conn);
  // PRE-CONDITION, asserted rather than assumed: rung 3 really is on the other project.
  expect(await projectHandler.getInteractiveProjectId(conn)).toBe(otherId);
  return conn;
}

describe('PART C — every surface a bound client can ask agrees with where its writes land', () => {
  test('project_current / thread_current / session_get / session_list / project_list all name the project context_store actually wrote to', async () => {
    const conn = await connectionWithRung3OnTheWrongProject('cross-check');

    // ── THE GROUND TRUTH, derived (not asserted from a constant): do a REAL write as a bound
    //    client and read back which project the row landed in. This is the "where do my writes
    //    go" that earlier decision says no surface may contradict.
    const content = `cross-check write ${STAMP}`;
    const stored = await call('context_store', { content, type: 'completion' }, conn, BOUND_PROJECT);
    expect(stored.isError).toBeFalsy();
    const writeLanded = (
      await db.query(`SELECT project_id FROM contexts WHERE content = $1`, [content])
    ).rows[0].project_id as string;

    // ── 1. project_current — the tool the product's OWN shipped instructions tell clients to
    //       use as the pre-flight for where writes land.
    const current = await call('project_current', {}, conn, BOUND_PROJECT);
    expect(current.structuredContent.project.id).toBe(writeLanded);
    // and it NAMES the binding as the source, showing rung 3 alongside rather than conflated.
    expect(current.structuredContent.scopeSource).toBe('binding');
    expect(current.structuredContent.bound).toBe(true);
    expect(current.structuredContent.interactiveProject?.id).toBe(otherId);
    expect(textOf(current)).toContain(BOUND_PROJECT);

    // ── 2. session_list's DEFAULT scope (the other half of the evaluator's contradiction).
    const list = await call('session_list', {}, conn, BOUND_PROJECT);
    expect(list.isError).toBeFalsy();
    expect(list.structuredContent.filters.projectId).toBe(writeLanded);

    // ── 3. project_list's isActive — the 🟢 (CURRENT) marker.
    const projects = await call('project_list', {}, conn, BOUND_PROJECT);
    const active = projects.structuredContent.results.filter((p: any) => p.isActive);
    expect(active.map((p: any) => p.id)).toEqual([writeLanded]);

    // ── 4. branch_current — resolves a project while its param is optional, which is
    //       exactly the population the old guard excluded by construction. (PHASE 1: the
    //       thread anchor tools are deprecation aliases; the real surface is branch_*.)
    const opened = await call('branch_open', { id: taskInBound }, conn, BOUND_PROJECT);
    expect(opened.isError).toBeFalsy();
    const branchCur = await call('branch_current', {}, conn, BOUND_PROJECT);
    expect(branchCur.structuredContent.position?.spineId).toBe(taskInBound);

    // ── 5. session_get's short-id scoping resolves against the same project.
    const sessionRow = await db.query(
      `SELECT id FROM sessions WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [writeLanded]
    );
    expect(sessionRow.rows.length).toBe(1);
    const got = await call(
      'session_get',
      { sessionId: (sessionRow.rows[0].id as string).slice(0, 8) },
      conn,
      BOUND_PROJECT
    );
    expect(got.isError).toBeFalsy();
    expect(textOf(got)).toContain((sessionRow.rows[0].id as string).slice(0, 8));

    // The whole point, stated once: the write target and every REPORTING surface agree, and
    // none of them is the rung-3 project the connection was sitting on.
    expect(writeLanded).toBe(boundId);
    expect(writeLanded).not.toBe(otherId);

    ActiveSessionStore.clear(conn);
  });

  test('UNBOUND is unchanged: with no binding, every surface still reports rung 3', async () => {
    // Legacy == today. The same battery, with no binding at all.
    const conn = await connectionWithRung3OnTheWrongProject('unbound-control');

    const current = await call('project_current', {}, conn);
    expect(current.structuredContent.project.id).toBe(otherId);
    expect(current.structuredContent.scopeSource).toBe('interactive');
    expect(current.structuredContent.bound).toBe(false);
    // No provenance block is appended for an unbound client.
    expect(textOf(current)).not.toContain('scope source:');

    const list = await call('session_list', {}, conn);
    expect(list.structuredContent.filters.projectId).toBe(otherId);

    ActiveSessionStore.clear(conn);
  });

  test('the ENV binding (no header at all) reaches the same reporting surfaces', async () => {
    // ORDER MATTERS, and it is the product being correct that forces it: a bound client
    // CANNOT project_switch to a different project (ProjectBindingMismatchError), so rung 3
    // has to be put on the wrong project FIRST and the env binding declared after.
    const conn = await connectionWithRung3OnTheWrongProject('env-bound');
    process.env[PROJECT_BINDING_ENV_VAR] = BOUND_PROJECT;

    const current = await call('project_current', {}, conn);
    expect(current.structuredContent.project.id).toBe(boundId);
    expect(current.structuredContent.bindingOrigin).toBe('env');
    // rung 3 is untouched by the binding — it still holds what project_switch set.
    expect(await projectHandler.getInteractiveProjectId(conn)).toBe(otherId);
    ActiveSessionStore.clear(conn);
  });

  test('project_list isActive is CONNECTION-scoped even with no binding (the pre-existing global-slot bug)', async () => {
    // Binding-independent: `isActive` used to read the global 'default-session' slot, so it
    // named a project unrelated to the caller on every non-default connection. Two connections
    // on different projects must see different 🟢 (CURRENT) rows.
    const connA = `isactive-a-${STAMP}`;
    const connB = `isactive-b-${STAMP}`;
    await call('project_switch', { project: BOUND_PROJECT }, connA);
    await call('project_switch', { project: OTHER_PROJECT }, connB);

    const listA = await call('project_list', {}, connA);
    const listB = await call('project_list', {}, connB);
    expect(listA.structuredContent.results.filter((p: any) => p.isActive).map((p: any) => p.id)).toEqual([boundId]);
    expect(listB.structuredContent.results.filter((p: any) => p.isActive).map((p: any) => p.id)).toEqual([otherId]);

    ActiveSessionStore.clear(connA);
    ActiveSessionStore.clear(connB);
  });
});

describe('PART D — the two FUNCTIONAL bugs: the branch position round-trip under a binding', () => {
  test('branch_open → branch_current round-trips, and branch_close clears the slot branch_open wrote', async () => {
    const conn = await connectionWithRung3OnTheWrongProject('thread-roundtrip');

    // branch_open DECLARES `projectId`, so the gate materialises the BOUND project into it.
    const set = await call('branch_open', { id: taskInBound }, conn, BOUND_PROJECT);
    expect(set.isError).toBeFalsy();
    expect(set.structuredContent.position.spineId).toBe(taskInBound);

    // branch_current's projectId is optional — the class of bug PART D pins is a read keyed
    // by the CONNECTION-CURRENT (rung-3) project while the write keyed by the BOUND one.
    const cur = await call('branch_current', {}, conn, BOUND_PROJECT);
    expect(cur.structuredContent.position).not.toBeNull();
    expect(cur.structuredContent.position.spineId).toBe(taskInBound);

    // branch_close must clear the slot branch_open wrote (report AND effect).
    const cleared = await call('branch_close', {}, conn, BOUND_PROJECT);
    expect(cleared.structuredContent.action).toBe('closed');
    const after = await call('branch_current', {}, conn, BOUND_PROJECT);
    expect(after.structuredContent.position).toBeNull();

    ActiveSessionStore.clear(conn);
  });

  /**
   * THE SLOT ITSELF, observed below the tools (PHASE 1 rewrite of the durable-anchor slot
   * test): branch_open under a BINDING must write the `branch_positions` row under the
   * BOUND project — not the connection-current (rung-3) one — and the read/close must key
   * the same slot. The position store is DB-only (no in-memory cache layer to mask a
   * mis-keyed read), so this reads the store directly for WHICH project slot the row is in.
   */
  test('the position is stored under the BOUND project, and reads/closes key the same slot', async () => {
    const conn = await connectionWithRung3OnTheWrongProject('thread-slot');
    await call('branch_open', { id: taskInBound }, conn, BOUND_PROJECT);
    // THE KEY COMES FROM THE RULE, NOT FROM A COPY OF IT. This line used to
    // re-derive the position key here — `ActiveSessionStore.get(conn) ?? conn` — which is
    // the keying rule written a second time, in a test, where nothing keeps it in step with
    // the first. It silently went stale the moment position keying started scoping the
    // connection identity by actor, and reported a FUNCTIONAL bug in a product that was
    // fine. Compose it from the single source instead.
    const sessionKey = composePositionKey({ connectionId: conn, actor: CALL_ACTOR });

    // 1. WHICH SLOT the durable row went into — read at the store, so the assertion
    //    observes the project key itself rather than trusting the tool that wrote it.
    expect((await readPosition(boundId, sessionKey))?.spineId).toBe(taskInBound);
    expect(await readPosition(otherId, sessionKey)).toBeNull();

    // 2. Re-establish rung 3 on the wrong project so the differential below is deterministic.
    projectHandler.clearSessionCache();
    await call('project_switch', { project: OTHER_PROJECT }, conn);
    expect(await projectHandler.getInteractiveProjectId(conn)).toBe(otherId);

    // 2a. UNBOUND on the same connection reads the position keyed by rung 3 → finds nothing
    //     (the wrong-slot read, reproduced deliberately).
    const coldUnbound = await call('branch_current', {}, conn);
    expect(coldUnbound.structuredContent.position).toBeNull();

    // 2b. BOUND finds it, because the binding — not rung 3 — supplies the project key.
    const coldBound = await call('branch_current', {}, conn, BOUND_PROJECT);
    expect(coldBound.structuredContent.position?.spineId).toBe(taskInBound);

    // 3. branch_close must delete the DURABLE row it wrote.
    const cleared = await call('branch_close', {}, conn, BOUND_PROJECT);
    expect(cleared.structuredContent.action).toBe('closed');
    expect(await readPosition(boundId, sessionKey)).toBeNull();

    ActiveSessionStore.clear(conn);
  });
});

describe('PART E — the connect-time instructions string names the BOUND project', () => {
  test('a bound client is told its bound project before any tool call can run', async () => {
    const conn = await connectionWithRung3OnTheWrongProject('connect-string');

    const bound = await runWithProjectScope(
      { connectionId: conn, projectBinding: BOUND_PROJECT },
      () => resolveInstructions(conn)
    );
    expect(bound).toContain(BOUND_PROJECT);
    expect(bound).not.toContain(OTHER_PROJECT);

    // UNBOUND control: the same connection with no binding still gets the rung-3 project, so
    // this test is measuring the binding and not just "the string contains a project name".
    const unbound = await runWithProjectScope({ connectionId: conn }, () =>
      resolveInstructions(conn)
    );
    expect(unbound).toContain(OTHER_PROJECT);

    ActiveSessionStore.clear(conn);
  });

  /**
   * THE SIDE EFFECT, which is the part the binding short-circuit exists for.
   *
   * `initializeSession` AUTO-SELECTS `metadata.is_primary` and WRITES it into the connection's
   * rung-3 state, so merely RENDERING the connect hint used to pin a project onto a fresh
   * connection. This must be measured on a connection that has NEVER switched — on one that
   * HAS, `initializeSession` takes its "respect the manual override" branch and mutates
   * nothing, so the assertion would pass for the wrong reason (measured: with the
   * short-circuit removed, a switched connection's rung 3 is still untouched).
   */
  test('rendering the hint for a bound client does NOT pin anything into rung 3', async () => {
    const fresh = `connect-fresh-${STAMP}`;
    // A primary project must exist for initializeSession to have something to auto-pin,
    // otherwise this test could pass simply because there was nothing to select.
    await db.query(`UPDATE projects SET metadata = '{"is_primary": true}'::jsonb WHERE id = $1`, [
      otherId,
    ]);
    try {
      expect(await projectHandler.getInteractiveProjectId(fresh)).toBeNull();

      const bound = await runWithProjectScope(
        { connectionId: fresh, projectBinding: BOUND_PROJECT },
        () => resolveInstructions(fresh)
      );
      expect(bound).toContain(BOUND_PROJECT);

      // The bound client's rung-3 slot is still EMPTY — the binding did not write to it.
      expect(await projectHandler.getInteractiveProjectId(fresh)).toBeNull();

      // CONTROL, so this is not a claim about "nothing ever pins": the SAME call with no
      // binding does pin the primary project, which is the behaviour the short-circuit skips.
      const unboundConn = `connect-fresh-unbound-${STAMP}`;
      await runWithProjectScope({ connectionId: unboundConn }, () =>
        resolveInstructions(unboundConn)
      );
      expect(await projectHandler.getInteractiveProjectId(unboundConn)).toBe(otherId);
    } finally {
      await db.query(`UPDATE projects SET metadata = '{}'::jsonb WHERE id = $1`, [otherId]);
    }
  });
});

/**
 * PART F — the TRANSPORT actually establishes the scope.
 *
 * Parts A-E prove `resolveInstructions` is correct GIVEN an established project scope. That is
 * necessary and not sufficient: the connect-time path runs outside `routeExecutor`, so if
 * `remoteMcpTransport.resolveSessionInstructions` failed to wrap the call, a bound client would
 * still be told the wrong project and every test above would stay green. A static "does the
 * file contain runWithProjectScope" check would be a text search standing in for a behavioural
 * claim, so this drives the REAL transport: a real `initialize` over Streamable
 * HTTP with the real `X-Mandrel-Project` header, and reads the instructions back off the MCP
 * client exactly as a live orb would.
 */
describe('PART F — a real initialize over the transport carries the BOUND project', () => {
  const TEST_TOKEN = 'choke-point-transport-token';
  let health: any;
  let baseUrl: string;

  beforeAll(async () => {
    // OS-assigned port, never a literal: a fixed 18099 (reserved-port-ok: naming the old
    // value in prose) collided with a tenant docker-proxy on the prod box and aborted a
    // fleet deploy. The port must be
    // resolved BEFORE the transport is constructed — RemoteMcpTransport caches
    // allowedHosts in its constructor and the SDK matches the Host header (which
    // carries the port) exactly. See helpers/ephemeralPort.ts.
    const testPort = await reserveEphemeralPort();
    vi.stubEnv('MCP_AUTH_TOKEN', TEST_TOKEN);
    vi.stubEnv(
      'MCP_ALLOWED_HOSTS',
      `127.0.0.1:${testPort},localhost:${testPort},127.0.0.1,localhost`
    );
    vi.stubEnv('MANDREL_AIDIS_MCP_PORT', String(testPort));
    vi.stubEnv('AIDIS_PORT_REGISTRY', runScopedTmpPath('mandrel-chokepoint-port-registry.json'));
    vi.stubEnv('AIDIS_SKIP_BACKGROUND', 'true');
    vi.stubEnv('AIDIS_SKIP_STDIO', 'true');

    // Imported dynamically, AFTER the env stubs, exactly as remoteMcpTransport.integration
    // does — a static import would hoist above them. The DB env is the CI gate one and is
    // deliberately NOT stubbed: the binding has to resolve against the real projects table.
    const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
    const { HealthServer } = await import('../server/healthServer.js');
    const remoteMcp = new RemoteMcpTransport({
      executeMcpTool: (async () => ({
        content: [{ type: 'text', text: 'stub' }],
        structuredContent: { ok: true },
      })) as any,
      getServerStatus: async () => ({ version: 'test' }),
    } as any);
    health = new HealthServer((async () => ({})) as any, remoteMcp);
    const port = await health.start();
    baseUrl = `http://127.0.0.1:${(health.address()?.port ?? port) as number}`;
  });

  afterAll(async () => {
    try {
      if (health) await health.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  async function instructionsFor(headers: Record<string, string>): Promise<string | undefined> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    const client = new Client({ name: 'choke-point-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}`, ...headers } },
    });
    await client.connect(transport); // performs the real initialize
    const instructions = client.getInstructions();
    await client.close();
    return instructions;
  }

  test('X-Mandrel-Project on initialize ⇒ the instructions name the BOUND project', async () => {
    const conn = `transport-bound-${STAMP}`;
    // Put rung 3 on the WRONG project first, so falling through to it is a REAL failure mode
    // rather than a coin toss between two projects that were never distinguished.
    await call('project_switch', { project: OTHER_PROJECT }, conn);
    expect(await projectHandler.getInteractiveProjectId(conn)).toBe(otherId);

    const bound = await instructionsFor({
      'X-Connection-ID': conn,
      'X-Mandrel-Project': BOUND_PROJECT,
    });
    expect(bound).toBeTruthy();
    expect(bound).toContain(BOUND_PROJECT);
    expect(bound).not.toContain(OTHER_PROJECT);
    // …and the SENTENCE is finished (Reviewer N8): the shipped string told every bound client
    // to "use project_switch to change", which is REJECTED while bound. Naming the right
    // project while advising a call that hard-fails is still a surface lying to the client.
    expect(bound).toBe(formatInstructions(BOUND_PROJECT, `${PROJECT_BINDING_HEADER} header`));
    expect(bound).not.toContain('use project_switch to change');

    // CONTROL on the same connection, same transport, no binding header: it names rung 3.
    // Without this the assertion above could be satisfied by any string mentioning a project.
    const unbound = await instructionsFor({ 'X-Connection-ID': conn });
    expect(unbound).toContain(OTHER_PROJECT);
    expect(unbound).not.toContain(BOUND_PROJECT);
    // The unbound advice is unchanged — the caveat is added FOR the bound client, not by
    // degrading the human path (legacy == today).
    expect(unbound).toContain('use project_switch to change');

    ActiveSessionStore.clear(conn);
  });
});

/**
 * PART G — the WRITE ECHO, the surface that reports a write back to the client that made it.
 * (Reviewer nit N5.)
 *
 * `buildWriteEcho` decided "was this a DEFAULT target?" from `getSessionInfo().manualOverride`
 * — a flag a BINDING never sets, because a binding deliberately does not touch rung 3. So on
 * any path where the route did not pass `explicit`, a bound client's write was labelled
 * "⚠️ default project (not switched this session); project_switch if this is wrong": a surface
 * telling a bound client its explicit binding was a default, and pointing it at a call that is
 * REJECTED while bound.
 *
 * MEASURED FIRST, because the honest report matters more than the fix: today all
 * three echoing tools (context_store / task_create / decision_record) DECLARE a `projectId`
 * param, so routes/index.ts materialises the bound id into it and the route passes
 * `args.projectId != null` — `explicit` is true and the bad label is not reached on the live
 * surface. The echo was correct only because of a coincidence in a DIFFERENT module. The
 * second test below drives the exact shape that coincidence hides.
 */
describe('PART G — the write echo reports a bound write as BOUND, never as "defaulted"', () => {
  test('a real bound context_store echoes the BOUND project and the surface that bound it', async () => {
    const conn = await connectionWithRung3OnTheWrongProject('echo-bound');

    const content = `echo bound write ${STAMP}`;
    const stored = await call('context_store', { content, type: 'completion' }, conn, BOUND_PROJECT);
    expect(stored.isError).toBeFalsy();
    const echo = textOf(stored);

    expect(echo).toContain(BOUND_PROJECT);
    expect(echo).toContain(BOUND_PROJECT_HINT);
    expect(echo).toContain(`${PROJECT_BINDING_HEADER} header`);
    expect(echo).not.toContain(DEFAULT_PROJECT_HINT);

    // CONTROL on the SAME connection: unbound, the echo is the legacy one and still carries the
    // default hint (rung 3 was never switched *to* by a human here). Without this the bound
    // assertion could be satisfied by an echo that simply stopped saying anything.
    const plain = await call('context_store', { content: `echo unbound ${STAMP}`, type: 'completion' }, conn);
    const plainEcho = textOf(plain);
    expect(plainEcho).toContain(OTHER_PROJECT);
    expect(plainEcho).not.toContain(BOUND_PROJECT_HINT);

    ActiveSessionStore.clear(conn);
  });

  test('THE SHAPE MATERIALISATION HIDES: a bound write with no explicit arg is still not "defaulted"', async () => {
    // This is what every echoing tool produces the moment it stops declaring a `projectId`
    // param — or the moment materialisation is narrowed, which is exactly the kind of change
    // the caching optimisation in this area would make. Driven through a REAL established
    // scope with a REAL binding, so it is the product's own resolution, not a stub's.
    const conn = await connectionWithRung3OnTheWrongProject('echo-latent');

    const line = await runWithProjectScope(
      { connectionId: conn, projectBinding: BOUND_PROJECT },
      () => buildWriteEcho(boundId, conn, /* explicit */ false)
    );
    expect(line).toContain(BOUND_PROJECT);
    expect(line).toContain(BOUND_PROJECT_HINT);
    expect(line).not.toContain(DEFAULT_PROJECT_HINT);

    // CONTROL: the very same call with NO binding established still produces the legacy
    // "⚠️ default project" line. Measured on a connection that never switched, because a
    // connection that HAS switched has manualOverride=true and would report not-defaulted for
    // a reason that has nothing to do with the binding — the assertion would then pass for the
    // wrong reason.
    const neverSwitched = `echo-latent-fresh-${STAMP}`;
    const unbound = await runWithProjectScope({ connectionId: neverSwitched }, () =>
      buildWriteEcho(otherId, neverSwitched, /* explicit */ false)
    );
    expect(unbound).toContain(OTHER_PROJECT);
    expect(unbound).toContain(DEFAULT_PROJECT_HINT);
    expect(unbound).not.toContain(BOUND_PROJECT_HINT);

    ActiveSessionStore.clear(conn);
  });
});
