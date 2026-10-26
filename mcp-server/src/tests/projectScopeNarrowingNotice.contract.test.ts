/**
 * A READ THAT RETURNS LESS THAN ASKED MUST SAY SO — end-to-end, real Postgres, real tools.
 * an earlier task (follow-up to an earlier change project binding / an earlier change session identity).
 *
 * =============================================================================
 * THE CLASS
 * =============================================================================
 * A result that is SILENTLY SMALLER than the one requested READS AS CLEAN. A bound client
 * that passes `allProjects:true` is narrowed to its binding — correct, and deliberately so:
 * the binding IS the isolation boundary (a bound client cannot `project_switch`), and a
 * boolean argument must not be able to cross it. Widening would be a security regression.
 * But the caller was never told, so it could not tell
 *     "there is nothing"      from      "I was not allowed to look",
 * and `session_list` exists precisely to let a correlation tool conclude things about what
 * sessions exist. The fix is HONESTY, not scope: nothing here widens anything.
 *
 * =============================================================================
 * WHAT THIS FILE ASSERTS, AND WHY EACH ASSERTION IS LOAD-BEARING
 * =============================================================================
 * It drives `routeExecutor` — the ONE seam both the flat `/mcp/tools/*` surface and the
 * gateway dispatcher pass through — so what is measured is the handler's actual response on
 * the path a live client takes, not a mock of it.
 *
 *  A. THE DISCRIMINATING FIXTURE. Sessions are planted in BOTH projects, and every
 *     "the bound client sees only its own" assertion names the OTHER project's session id
 *     and asserts its ABSENCE. Without a session that SHOULD have been excluded, "returns
 *     one project's worth" is indistinguishable from "the database is empty" — which is the
 *     very confusion this task is about, reproduced inside its own test.
 *
 *  B. THE EMPTY POPULATION. The bound-but-EMPTY case gets its own test: a binding whose
 *     project has ZERO sessions, with sessions present elsewhere. That is the exact input
 *     the class is named for — the empty answer that reads as "there is nothing" — and it is
 *     the value that slips through a guard written only against the populated case.
 *
 *  C. ABSENT, NOT FALSE. On a call that was NOT narrowed the structured key must be ABSENT.
 *     A `false`/`null` sentinel would make "not narrowed" and "narrowing not checked"
 *     indistinguishable to a consumer, which is the same failure one layer up.
 *
 *  D. THE POPULATION IS DERIVED, NOT ENUMERATED. `session_list` is the only tool that can be
 *     narrowed TODAY. The test injects an `allProjects` flag onto a DIFFERENT tool's schema
 *     and asserts the notice appears there too, with no change to this code or to that
 *     tool's handler. That is what proves the fix covers the CLASS: membership comes from
 *     the override classifier reading each tool's own schema, so the next tool to declare a
 *     widening flag is covered on the day it is born. A notice written into one handler
 *     would pass every test above and fail this one.
 *
 * Runs inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { z } from 'zod';

// Distinct ids per real create (global setup mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { logger } from '../utils/logger.js';
import {
  PROJECT_SCOPE_NARROWED_KEY,
  PROJECT_SCOPE_NARROWED_LOG_PREFIX,
  scopeNarrowingNotice,
} from '../services/projectBinding.js';
import { validationSchemas } from '../middleware/validation.js';
import { PROJECT_BINDING_ENV_VAR } from '../config/projectBindingConfig.js';

const STAMP = Date.now();
const BOUND_PROJECT = `narrow-bound-${STAMP}`;
const OTHER_PROJECT = `narrow-other-${STAMP}`;
const EMPTY_PROJECT = `narrow-empty-${STAMP}`;

let boundId: string;
let otherId: string;
let emptyId: string;
let boundSessionId: string;
let otherSessionId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** The session ids a `session_list` response actually returned. */
function listedIds(resp: any): string[] {
  return (resp?.structuredContent?.sessions ?? []).map((s: any) => s.sessionId);
}

async function makeProject(name: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'narrowing notice fixture') RETURNING id`,
    [name]
  );
  return r.rows[0].id;
}

/**
 * Plant a session row directly. Deliberately NOT via `session_start`: the fixture's job is
 * to make a row that `session_list` must or must not return, and creating it through a tool
 * that is itself project-bound would entangle the fixture with the mechanism under test.
 */
async function plantSession(projectId: string, label: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO sessions (project_id, agent_type, display_id, title, status, last_activity_at)
     VALUES ($1, 'test', $2, $3, 'active', NOW()) RETURNING id`,
    [projectId, label.slice(0, 20), label]
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  boundId = await makeProject(BOUND_PROJECT);
  otherId = await makeProject(OTHER_PROJECT);
  emptyId = await makeProject(EMPTY_PROJECT);
  boundSessionId = await plantSession(boundId, `nb-${STAMP}`);
  otherSessionId = await plantSession(otherId, `no-${STAMP}`);
});

afterAll(async () => {
  const ids = [boundId, otherId, emptyId];
  await db.query('DELETE FROM sessions WHERE project_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ids]);
});

afterEach(() => {
  delete process.env[PROJECT_BINDING_ENV_VAR];
  vi.restoreAllMocks();
});

describe('ACCEPTANCE — a bound client is TOLD its allProjects request was narrowed', () => {
  test('BOUND + allProjects:true ⇒ bound project only, and BOTH channels say so', async () => {
    const conn = `narrow-bound-${STAMP}`;
    const resp: any = await routeExecutor(
      'session_list',
      { allProjects: true },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    ActiveSessionStore.clear(conn);

    expect(resp.isError).toBeFalsy();

    // The SCOPE is unchanged — the binding still wins. Asserted against a session that
    // exists and was excluded, so this cannot pass on an empty database.
    expect(listedIds(resp)).toContain(boundSessionId);
    expect(listedIds(resp)).not.toContain(otherSessionId);

    // MACHINE CHANNEL — a consumer branches on presence, never on parsing prose.
    const notice = resp.structuredContent[PROJECT_SCOPE_NARROWED_KEY];
    expect(notice).toBeDefined();
    expect(notice.params).toEqual(['allProjects']);
    expect(notice.projectId).toBe(boundId);
    expect(notice.projectName).toBe(BOUND_PROJECT);
    expect(notice.bindingOrigin).toBe('header');

    // TEXT CHANNEL — the same one string, not a second rendering that could drift.
    const text = textOf(resp);
    expect(text).toContain(notice.message);
    // The two facts a caller must not have to infer: WHAT was ignored, and WHICH binding
    // ignored it. Named, not merely hinted at.
    expect(text).toContain('allProjects');
    expect(text).toContain(BOUND_PROJECT);

    // The load-bearing sentence: the reason this bug is expensive is that a short answer
    // reads as a complete one. Assert the response actually says otherwise.
    expect(text).toMatch(/does NOT mean nothing exists elsewhere/);

    // A warning belongs BEFORE the results it qualifies, and a client that reads only the
    // first text block is exactly the client that would draw the wrong conclusion.
    const firstBlock = resp.content.find((c: any) => c.type === 'text').text as string;
    expect(firstBlock.startsWith('⚠️ SCOPE NARROWED')).toBe(true);
  });

  test('THE EMPTY CASE — a bound client with ZERO sessions is still told it was narrowed', async () => {
    const conn = `narrow-empty-${STAMP}`;
    const resp: any = await routeExecutor(
      'session_list',
      { allProjects: true },
      { connectionId: conn, projectBinding: EMPTY_PROJECT }
    );
    ActiveSessionStore.clear(conn);

    // The population this class is named for: nothing came back, and something DOES exist
    // elsewhere. Without the notice this response is a confident, wrong "there is nothing".
    expect(resp.structuredContent.sessions).toEqual([]);
    expect(resp.structuredContent.totalCount).toBe(0);
    expect(resp.structuredContent[PROJECT_SCOPE_NARROWED_KEY]).toBeDefined();
    expect(textOf(resp)).toContain('SCOPE NARROWED');
    // Proof the emptiness was a narrowing artefact, not the state of the world.
    expect(
      (await db.query('SELECT COUNT(*)::int AS n FROM sessions WHERE project_id = $1', [otherId]))
        .rows[0].n
    ).toBeGreaterThan(0);
  });

  test('the operator half: ONE warn line carries the same facts, under its own prefix', async () => {
    const seen: Array<{ msg: string; meta: any }> = [];
    vi.spyOn(logger, 'warn').mockImplementation(((msg: string, meta?: any) => {
      seen.push({ msg, meta });
    }) as any);

    const conn = `narrow-log-${STAMP}`;
    await routeExecutor(
      'session_list',
      { allProjects: true },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    ActiveSessionStore.clear(conn);

    const lines = seen.filter((e) => e.msg.startsWith(PROJECT_SCOPE_NARROWED_LOG_PREFIX));
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toContain('tool=session_list');
    expect(lines[0].msg).toContain('narrowed=allProjects');
    expect(lines[0].meta.metadata.projectId).toBe(boundId);
    expect(lines[0].meta.metadata.narrowedScopeOverrides).toEqual(['allProjects']);
  });
});

describe('NON-REGRESSION — nothing else grows a notice', () => {
  test('UNBOUND + allProjects:true ⇒ spans projects, key ABSENT', async () => {
    const conn = `narrow-unbound-${STAMP}`;
    const resp: any = await routeExecutor(
      'session_list',
      { allProjects: true },
      { connectionId: conn }
    );
    ActiveSessionStore.clear(conn);

    // Genuinely wider: BOTH planted sessions come back.
    expect(listedIds(resp)).toEqual(expect.arrayContaining([boundSessionId, otherSessionId]));
    // ABSENT, not false/null — see (C) in the header.
    expect(PROJECT_SCOPE_NARROWED_KEY in resp.structuredContent).toBe(false);
    expect(textOf(resp)).not.toContain('SCOPE NARROWED');
  });

  test('BOUND but allProjects NOT passed ⇒ nothing was narrowed, key ABSENT', async () => {
    const conn = `narrow-noflag-${STAMP}`;
    const resp: any = await routeExecutor(
      'session_list',
      {},
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    ActiveSessionStore.clear(conn);

    expect(listedIds(resp)).toContain(boundSessionId);
    expect(PROJECT_SCOPE_NARROWED_KEY in resp.structuredContent).toBe(false);
  });

  test('BOUND + allProjects:false ⇒ no widening was requested, so none was refused', async () => {
    const conn = `narrow-false-${STAMP}`;
    const resp: any = await routeExecutor(
      'session_list',
      { allProjects: false },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    ActiveSessionStore.clear(conn);
    expect(PROJECT_SCOPE_NARROWED_KEY in resp.structuredContent).toBe(false);
  });

  test('an UNRELATED tool from a bound client is byte-untouched', async () => {
    const conn = `narrow-unrelated-${STAMP}`;
    const resp: any = await routeExecutor(
      'project_current',
      {},
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    ActiveSessionStore.clear(conn);
    expect(PROJECT_SCOPE_NARROWED_KEY in resp.structuredContent).toBe(false);
    expect(textOf(resp)).not.toContain('SCOPE NARROWED');
  });
});

describe('THE POPULATION IS DERIVED — a tool this seam has never heard of is covered', () => {
  /**
   * See (D) in the header. `context_get_recent` declares no widening flag and its handler
   * knows nothing about narrowing. Injecting `allProjects` into its SCHEMA — the same shape
   * `session_list` declares — must be enough, on its own, for a bound caller to be told. If
   * this goes RED while the session_list tests stay GREEN, the notice has been written into
   * one handler and the class is not closed.
   */
  const VICTIM = 'context_get_recent';
  const preexisting = (validationSchemas as any)[VICTIM];

  beforeAll(() => {
    (validationSchemas as any)[VICTIM] = z.object({
      projectId: z.string().optional(),
      allProjects: z.boolean().optional(),
      limit: z.number().optional(),
    });
  });
  afterAll(() => {
    if (preexisting === undefined) delete (validationSchemas as any)[VICTIM];
    else (validationSchemas as any)[VICTIM] = preexisting;
  });

  test('a NEWLY widening-capable tool gets the notice with no code change here', async () => {
    const conn = `narrow-derived-${STAMP}`;
    const resp: any = await routeExecutor(
      VICTIM,
      { allProjects: true, limit: 1 },
      { connectionId: conn, projectBinding: BOUND_PROJECT }
    );
    ActiveSessionStore.clear(conn);

    const notice = resp.structuredContent[PROJECT_SCOPE_NARROWED_KEY];
    expect(notice).toBeDefined();
    expect(notice.params).toEqual(['allProjects']);
    expect(notice.projectId).toBe(boundId);
    expect(textOf(resp)).toContain('SCOPE NARROWED');
  });
});

describe('the notice builder itself is pure and refuses to over-claim', () => {
  // The three inputs that must produce NOTHING. Written against the builder directly
  // because these are the states a route can hand it, and a notice minted for any of them
  // would be a false alarm — the mirror of the silence this task removes.
  test('unbound / no overridden params / no resolved project ⇒ null', () => {
    expect(scopeNarrowingNotice(undefined)).toBeNull();
    expect(
      scopeNarrowingNotice({ bound: false, source: 'interactive', overriddenScopeParams: [] })
    ).toBeNull();
    expect(
      scopeNarrowingNotice({
        bound: false,
        source: 'explicit',
        projectId: boundId,
        overriddenScopeParams: ['allProjects'],
      })
    ).toBeNull();
    expect(
      scopeNarrowingNotice({
        bound: true,
        source: 'binding',
        projectId: boundId,
        overriddenScopeParams: [],
      })
    ).toBeNull();
    expect(
      scopeNarrowingNotice({
        bound: true,
        source: 'binding',
        overriddenScopeParams: ['allProjects'],
      })
    ).toBeNull();
  });
});
