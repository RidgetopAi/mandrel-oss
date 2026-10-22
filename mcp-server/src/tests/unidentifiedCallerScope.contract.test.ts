/**
 * UNIDENTIFIED-CALLER PROJECT SCOPE — the real transport, real tools, real Postgres.
 * an earlier task.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS AND THE EXISTING ONE COULD NOT CATCH THE BUG
 * =============================================================================
 * `projectSessionIsolation.contract.test.ts` calls
 * `projectHandler.switchProject(id, 'connA')` DIRECTLY — supplying two distinct connection
 * ids ITSELF. It therefore asserts a property of the handler that was never in question, and
 * can NEVER observe the thing that was actually broken: the TRANSPORT collapsing two
 * different callers onto ONE key. That is the a past incident shape exactly — a test written
 * against the shape the author had in mind (the handler) rather than the choke point (the
 * transport's `|| 'http-default'`).
 *
 * So this file enters at `HealthServer.handleMcpToolExpress` — the real flat `/mcp/tools/*`
 * entry point — and lets the header (or its absence) be the ONLY difference between two
 * callers, which is the real-world condition.
 *
 * THE CHAIN IS REAL, END TO END. The executor handed to HealthServer is
 * `MandrelMcpServer.executeMcpTool` itself, so the path under test is
 *   express req → handleMcpToolExpress → MandrelMcpServer.executeMcpTool → validation →
 *   routeExecutor → guard → real route handlers → real Postgres
 * with no stand-in for any link. In particular the marker's FORWARDING through
 * MandrelMcpServer is exercised rather than assumed, which is the seam a hand-built test
 * closure would have quietly replaced.
 *
 * =============================================================================
 * WHAT IS ASSERTED (and how each assertion is protected from being vacuous)
 * =============================================================================
 *  1. REPRODUCTION (mode 'off'): the ORIGINAL defect, live — two header-less callers share
 *     one slot, caller2's switch silently moves caller1's scope, and caller1's write lands
 *     in P2, the project caller1 never chose. This is also the ANTI-VACUOUS PAIR for (2):
 *     it proves the "never P2" assertion is capable of failing.
 *  2. ENFORCE: the same sequence errors instead — P1 or an error, NEVER P2.
 *  3. POSITIVE CONTROL: the identical sequence with two DISTINCT X-Connection-IDs stays
 *     fully GREEN in enforce mode. Nothing was achieved by breaking everything.
 *  4. MECHANISM (executor spy — non-circular, independent of any DB row): the two
 *     header-less calls reach dispatch marked `identified:false`, and the two header-ful
 *     calls reach it marked `identified:true` with DISTINCT connection ids.
 *  5. SHADOW: computes the would-reject, bumps its counter, and ACTS AS TODAY.
 *  6. EMPTY-POPULATION PROBE: the fixtures are asserted to exist and to be distinct BEFORE
 *     any "no rows in P2" claim is made, and the reproduction in (1) is what proves the
 *     population is non-empty. A "no rows" pass over a set that was never written to is the
 *     trap that has bitten us three times in a week.
 *
 * Run inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { patternEmbedding } from './helpers/embedGeometry.js';

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
import { HealthServer, type McpExecutorContext } from '../server/healthServer.js';
import { projectHandler } from '../handlers/project.js';
import { monitoring } from '../utils/monitoring.js';
import { CALLER_IDENTITY_CONFIG, type ProjectScopeGuardMode } from '../config/callerIdentityConfig.js';
import { CALLER_IDENTITY_ERROR_CODES } from '../services/callerIdentityGuard.js';
import { withAmbientProjectFallbackAllowed } from '../config/ambientProjectFallbackConfig.js';

const STAMP = Date.now();
const P1_NAME = `uid-p1-${STAMP}`;
const P2_NAME = `uid-p2-${STAMP}`;

let p1Id: string;
let p2Id: string;
let health: any;
let realExecutor: (t: string, a: any, c?: McpExecutorContext) => Promise<any>;
/** Every context tagged with this is created by THIS file and is cleaned up at the end. */
const TAG = `uid-scope-${STAMP}`;

const savedMode = CALLER_IDENTITY_CONFIG.unidentifiedGuardMode;

/**
 * A minimal express-ish request. `header()` is the ONLY place a caller's identity enters,
 * which is the point: two callers here differ by nothing else.
 */
function makeReq(
  toolName: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    params: { toolName },
    body: { arguments: args },
    header: (name: string) => lower[name.toLowerCase()],
  };
}

/** Drive one call through the REAL transport entry and return the JSON body it wrote. */
async function post(
  toolName: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<any> {
  const req = makeReq(toolName, args, headers);
  let payload: any;
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn((body: any) => {
      payload = body;
    }),
  };
  await health.handleMcpToolExpress(req, res);
  return payload;
}

/** The prose an MCP result carries, whether it came back as success or as an error body. */
function textOf(payload: any): string {
  if (payload?.error) return String(payload.error);
  const content = payload?.result?.content;
  return Array.isArray(content) ? content.map((c: any) => c?.text).join('\n') : '';
}

function isToolError(payload: any): boolean {
  return payload?.success === false || payload?.result?.isError === true;
}

async function contextsIn(projectId: string, content: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM contexts WHERE project_id = $1 AND content = $2`,
    [projectId, content]
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  // The MandrelMcpServer constructor wires the real handler surface + the real executor.
  // These env values keep the constructor from reaching for a port or a lock file; nothing
  // here starts a listener (that is `start()`, which is never called).
  vi.stubEnv('AIDIS_SKIP_STDIO', 'true');
  vi.stubEnv('AIDIS_SKIP_BACKGROUND', 'true');
  vi.stubEnv('AIDIS_AIDIS_MCP_PORT', '0');
  vi.stubEnv('AIDIS_DISABLE_PROCESS_EXIT_HANDLERS', 'true');
  vi.stubEnv('AIDIS_LOCK_FILE', path.join(os.tmpdir(), `aidis-uid-scope-${STAMP}.lock`));

  const { default: MandrelMcpServer } = await import('../server/MandrelMcpServer.js');
  const server = new MandrelMcpServer();
  realExecutor = (server as any).executeMcpTool.bind(server);
  health = new HealthServer(realExecutor);

  p1Id = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'p1') RETURNING id`, [
      P1_NAME,
    ])
  ).rows[0].id;
  p2Id = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'p2') RETURNING id`, [
      P2_NAME,
    ])
  ).rows[0].id;

  // EMPTY-POPULATION PROBE. Every "the row is not in P2" assertion below is
  // trivially true against a fixture set that does not exist, so the fixtures are proven
  // present and DISTINCT here, before any such claim is made. A run whose setup silently
  // did nothing must fail HERE, loudly, not pass quietly downstream.
  expect(typeof p1Id).toBe('string');
  expect(typeof p2Id).toBe('string');
  expect(p1Id).not.toBe(p2Id);
  const present = await db.query(`SELECT count(*)::int AS n FROM projects WHERE id = ANY($1::uuid[])`, [
    [p1Id, p2Id],
  ]);
  expect(present.rows[0].n).toBe(2);
});

afterAll(async () => {
  CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = savedMode;
  for (const t of ['contexts', 'tasks', 'technical_decisions', 'sessions']) {
    await db.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[p1Id, p2Id]]);
  }
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[p1Id, p2Id]]);
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // The shared slot is in-memory and STICKY by design — that is the bug. Clear it between
  // cases so each case reproduces from the same known-empty start rather than inheriting the
  // previous case's leak (which would make a later case pass for the wrong reason).
  projectHandler.clearSessionCache();
});

afterEach(() => {
  CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = savedMode;
});

/**
 * THE SEQUENCE, exactly as specified. Two callers that differ ONLY in whether they sent
 * X-Connection-ID; caller1 then writes with no projectId of its own.
 */
async function runSequence(opts: { conn1?: string; conn2?: string; content: string }) {
  const h1 = { 'X-Actor-ID': 'alice', ...(opts.conn1 ? { 'X-Connection-ID': opts.conn1 } : {}) };
  const h2 = { 'X-Actor-ID': 'bob', ...(opts.conn2 ? { 'X-Connection-ID': opts.conn2 } : {}) };

  const switch1 = await post('project_switch', { project: P1_NAME }, h1);
  const switch2 = await post('project_switch', { project: P2_NAME }, h2);
  const write1 = await post(
    'context_store',
    { content: opts.content, type: 'completion', tags: [TAG] },
    h1
  );
  return { switch1, switch2, write1 };
}

describe('1. REPRODUCTION — with the guard OFF, the measured defect is live', () => {
  test("caller2's switch silently moves caller1's scope, and caller1's write lands in P2", async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'off';
    const content = `repro ${STAMP}`;

    const { switch1, switch2, write1 } = await runSequence({ content });

    // Both switches "succeed" — no error, no warning. That silence IS the defect.
    expect(isToolError(switch1)).toBe(false);
    expect(isToolError(switch2)).toBe(false);
    expect(isToolError(write1)).toBe(false);

    // caller1 chose P1. The row is in P2.
    expect(await contextsIn(p2Id, content)).toBe(1);
    expect(await contextsIn(p1Id, content)).toBe(0);
  });
});

describe('2. ENFORCE — the same sequence lands in P1 or errors, never in P2', () => {
  test('G1 rejects the header-less project_switch, G2 rejects the header-less ambient write', async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'enforce';
    const content = `enforced ${STAMP}`;

    const { switch1, switch2, write1 } = await runSequence({ content });

    expect(isToolError(switch1)).toBe(true);
    expect(textOf(switch1)).toContain(CALLER_IDENTITY_ERROR_CODES.SCOPE_SWITCH_UNIDENTIFIED);
    expect(isToolError(switch2)).toBe(true);

    expect(isToolError(write1)).toBe(true);
    expect(textOf(write1)).toContain(CALLER_IDENTITY_ERROR_CODES.AMBIENT_WRITE_UNIDENTIFIED);

    // THE ACCEPTANCE LINE: P1 or an error — never P2.
    expect(await contextsIn(p2Id, content)).toBe(0);
    expect(await contextsIn(p1Id, content)).toBe(0);
  });

  test('the errors NAME both remedies, so a rejected caller knows what to do', async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'enforce';
    const resp = await post('project_switch', { project: P1_NAME }, { 'X-Actor-ID': 'alice' });
    const text = textOf(resp);
    expect(text).toContain('X-Connection-ID');
    expect(text).toContain('projectId');
    expect(text).toContain('X-Mandrel-Project');
  });

  test('an unidentified WRITE that NAMES its project is permitted (rung 1 satisfies G2)', async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'enforce';
    const content = `explicit-project ${STAMP}`;
    const resp = await post(
      'context_store',
      { content, type: 'completion', tags: [TAG], projectId: p1Id },
      { 'X-Actor-ID': 'alice' }
    );
    expect(isToolError(resp)).toBe(false);
    expect(await contextsIn(p1Id, content)).toBe(1);
  });

  test('an unidentified write whose EXEMPT project param names its target is permitted', async () => {
    // MEASURED, not assumed: `project_delete`/`project_update` declare `project`, which
    // services/projectBinding.ts classifies EXEMPT ("administration by handle, not a
    // write-scope selection"), so `projectScopeParam` returns undefined for them and
    // `binding.projectId` stays unset. Guarding on the scope param ALONE would therefore
    // have rejected the Command UI's Delete Project with no per-call remedy. The call names
    // its target explicitly; the shared slot plays no part; it must pass.
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'enforce';
    const throwaway = `uid-doomed-${STAMP}`;
    const created = await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'to delete') RETURNING id`,
      [throwaway]
    );
    const resp = await post(
      'project_delete',
      { project: created.rows[0].id, confirm: true },
      { 'X-Actor-ID': 'alice' }
    );
    expect(textOf(resp)).not.toContain(CALLER_IDENTITY_ERROR_CODES.AMBIENT_WRITE_UNIDENTIFIED);
    const left = await db.query('SELECT count(*)::int AS n FROM projects WHERE id = $1', [
      created.rows[0].id,
    ]);
    expect(left.rows[0].n).toBe(0);
  });

  test('...but the SAME op with an EMPTY target is still ambient, and is rejected', async () => {
    // The anti-vacuous half of the test above: the exemption must buy a pass only when the
    // param actually CARRIES a target. Empty/whitespace is the value that slips through a
    // truthiness check.
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'enforce';
    for (const target of ['', '   ']) {
      const resp = await post(
        'project_delete',
        { project: target, confirm: true },
        { 'X-Actor-ID': 'alice' }
      );
      expect(isToolError(resp), JSON.stringify(target)).toBe(true);
    }
  });

  test('READS from an unidentified caller are NOT touched (G3)', async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'enforce';
    // OPT OUT of the test-only ambient-project guard, deliberately: an UNIDENTIFIED caller
    // that has never chosen a project IS the subject of this assertion. It sends no
    // X-Connection-ID and performs no project_switch — that is the real-world condition G3
    // is about — so it necessarily reaches initializeSession Priority 4. Binding it, or
    // naming a project, would delete the caller this test exists to describe.
    const resp = await withAmbientProjectFallbackAllowed(
      'G3 asserts a header-less, never-switched caller can still READ; reaching the ambient ' +
        'Priority-4 rung is the condition under test, not an accident of fixture setup.',
      () => post('project_current', {}, { 'X-Actor-ID': 'alice' }),
    );
    expect(isToolError(resp)).toBe(false);
  });
});

describe('3. POSITIVE CONTROL — distinct X-Connection-IDs stay GREEN under enforce', () => {
  test('two identified callers each keep their own project, and the write lands in P1', async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'enforce';
    const content = `control ${STAMP}`;

    const { switch1, switch2, write1 } = await runSequence({
      conn1: `uid-connA-${STAMP}`,
      conn2: `uid-connB-${STAMP}`,
      content,
    });

    expect(isToolError(switch1)).toBe(false);
    expect(isToolError(switch2)).toBe(false);
    expect(isToolError(write1)).toBe(false);

    // caller1 chose P1 and its write went to P1 — isolation holds for identified callers.
    expect(await contextsIn(p1Id, content)).toBe(1);
    expect(await contextsIn(p2Id, content)).toBe(0);
  });
});

describe('4. MECHANISM — the marker reaches dispatch (non-circular, no DB row involved)', () => {
  test('header-less → identified:false; header-ful → identified:true with DISTINCT connection ids', async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'off';
    const seen: McpExecutorContext[] = [];
    const spy = vi.fn(async (_t: string, _a: any, ctx?: McpExecutorContext) => {
      seen.push(ctx as McpExecutorContext);
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const spied: any = new HealthServer(spy as any);

    const call = async (headers: Record<string, string>) => {
      const res: any = { status: vi.fn(() => res), json: vi.fn() };
      await spied.handleMcpToolExpress(makeReq('project_current', {}, headers), res);
    };

    await call({ 'X-Actor-ID': 'alice' });
    await call({ 'X-Actor-ID': 'bob' });
    await call({ 'X-Actor-ID': 'alice', 'X-Connection-ID': `mech-A-${STAMP}` });
    await call({ 'X-Actor-ID': 'bob', 'X-Connection-ID': `mech-B-${STAMP}` });

    expect(seen).toHaveLength(4);
    // The two callers that presented nothing are BOTH marked unidentified — which is the
    // fact the transport used to destroy by collapsing them into the literal.
    expect(seen[0].identified).toBe(false);
    expect(seen[1].identified).toBe(false);
    // ...and the collapse itself is UNCHANGED: they still dispatch on the shared key. The
    // fix is not a re-key (G3); it is that the shared key is now distinguishable from a
    // chosen one.
    expect(seen[0].connectionId).toBe('http-default');
    expect(seen[1].connectionId).toBe('http-default');
    // The two that presented an identity are marked identified AND are distinct.
    expect(seen[2].identified).toBe(true);
    expect(seen[3].identified).toBe(true);
    expect(seen[2].connectionId).not.toBe(seen[3].connectionId);
  });
});

describe('5. SHADOW — computes the would-reject, counts it, acts as today', () => {
  test('a header-less write SUCCEEDS in shadow and the shadow counter moves', async () => {
    CALLER_IDENTITY_CONFIG.unidentifiedGuardMode = 'shadow';
    const content = `shadow ${STAMP}`;
    const before = monitoring.getLatestMetric('project_scope_guard_shadow')?.value ?? 0;

    // OPT OUT, same reason as G3 above and for the same caller: shadow mode's whole claim is
    // that a HEADER-LESS WRITE still succeeds exactly as it does today. Such a caller has no
    // connection to bind and names no project, so it reaches Priority 4 by construction. If
    // the write were made to choose a project, the sentence being asserted would no longer
    // be about the caller the shadow counter is counting.
    const resp = await withAmbientProjectFallbackAllowed(
      'shadow mode asserts a header-less WRITE still succeeds; that caller has chosen no ' +
        'project by definition, which is exactly the Priority-4 rung.',
      () =>
        post(
          'context_store',
          { content, type: 'completion', tags: [TAG] },
          { 'X-Actor-ID': 'alice' }
        ),
    );

    expect(isToolError(resp)).toBe(false);
    const after = monitoring.getLatestMetric('project_scope_guard_shadow')?.value ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});

describe('6. MODE POLARITY — absent means ENFORCE', () => {
  test('the guard mode a fresh read produces with the env unset is enforce, not off', async () => {
    const { readProjectScopeGuardMode, PROJECT_SCOPE_GUARD_DEFAULT } = await import(
      '../config/callerIdentityConfig.js'
    );
    expect(PROJECT_SCOPE_GUARD_DEFAULT).toBe<ProjectScopeGuardMode>('enforce');
    expect(readProjectScopeGuardMode(undefined)).toBe('enforce');
    expect(readProjectScopeGuardMode('')).toBe('enforce');
    expect(readProjectScopeGuardMode('   ')).toBe('enforce');
    // An unrecognised value must take the RESTRICTIVE branch, never the permissive one.
    expect(readProjectScopeGuardMode('shadwo')).toBe('enforce');
    expect(readProjectScopeGuardMode('disabled')).toBe('enforce');
    // ...and the two real settings still parse, case/whitespace-insensitively.
    expect(readProjectScopeGuardMode('shadow')).toBe('shadow');
    expect(readProjectScopeGuardMode(' OFF ')).toBe('off');
  });
});
