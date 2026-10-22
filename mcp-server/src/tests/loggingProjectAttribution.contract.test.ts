/**
 * REQUEST-LOG PROJECT ATTRIBUTION — the log line names the project the request ACTUALLY used.
 * governed by an earlier decision ("MCP binding is AUTHORITATIVE … for
 * what every tool REPORTS"). Reviewer nit N4.
 *
 * =============================================================================
 * THE TWO DEFECTS THIS PINS, BOTH MEASURED RATHER THAN ASSERTED
 * =============================================================================
 * `MandrelMcpServer.loggingProjectId()` stamps `projectId` on every request's log context. It
 * was:
 *
 *   1. BINDING-BLIND — it read the connection's rung-3 slot, so under a binding every log line
 *      for a bound client was attributed to the AUTO-SELECTED project rather than the bound
 *      one. Log-only (the persisted audit paths already used the effective accessor), but a
 *      log that misattributes the project is precisely what makes the next incident hard to
 *      trace, and it is the same "no surface reports the wrong project" class as the tools.
 *
 *   2. READING THE WRONG KEY SPACE — it looked a DB SESSION id (from `ActiveSessionStore`, and
 *      via `getCurrentSessionId()` with NO argument, so the 'default' connection's at that) up
 *      in `projectHandler['sessionStates']`, which is keyed by CONNECTION id. Those key spaces
 *      do not overlap, so the field resolved to `undefined` on essentially every request. The
 *      KEY-SPACE test below reproduces both lookups directly, so the claim in the source
 *      comment is a measurement and not a story.
 *
 * =============================================================================
 * HOW IT IS GUARDED
 * =============================================================================
 * Through the REAL `MandrelMcpServer.executeMcpTool`, with `RequestLogger.wrapOperation` spied
 * so the assertion reads the log context the product actually built — not a re-implementation
 * of it. A static "does the file mention getCurrentProjectId" check would be a text search
 * standing in for a behavioural claim.
 *
 * Every case carries its own CONTROL: rung 3 is parked on a DIFFERENT project than the
 * binding, so "it reported the bound project" cannot be satisfied by a coin toss between two
 * projects that were never distinguished.
 *
 * Runs inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { patternEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding() })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { projectHandler } from '../handlers/project.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { RequestLogger } from '../middleware/requestLogger.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const BOUND_PROJECT = `log-bound-${STAMP}`;
const OTHER_PROJECT = `log-other-${STAMP}`;
let boundId: string;
let otherId: string;

/** The server under test — the real class, constructed but never `start()`ed. */
let server: any;

beforeAll(async () => {
  boundId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1,'bound') RETURNING id`, [
      BOUND_PROJECT,
    ])
  ).rows[0].id;
  otherId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1,'other') RETURNING id`, [
      OTHER_PROJECT,
    ])
  ).rows[0].id;

  // Imported dynamically so the module graph is loaded after the mocks above, like the other
  // server-touching contract tests do. The constructor wires the handlers/transports only —
  // nothing listens until start(), which is never called here.
  const { default: MandrelMcpServer } = await import('../server/MandrelMcpServer.js');
  server = new MandrelMcpServer();
});

afterAll(async () => {
  for (const t of ['contexts', 'tasks', 'technical_decisions', 'sessions']) {
    await db.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[boundId, otherId]]);
  }
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[boundId, otherId]]);
});

/** Park rung 3 on the WRONG project, asserted rather than assumed. */
async function connectionWithRung3OnTheWrongProject(label: string): Promise<string> {
  const conn = `${label}-${STAMP}`;
  await routeExecutor('project_switch', validateToolArguments('project_switch', {
    project: OTHER_PROJECT,
  }), { connectionId: conn, actor: 'log-attr-test' });
  expect(await projectHandler.getInteractiveProjectId(conn)).toBe(otherId);
  return conn;
}

/**
 * Run one tool call through the REAL executeMcpTool and return the `projectId` the product
 * stamped on the request-log context.
 */
async function loggedProjectIdFor(
  tool: string,
  args: any,
  connectionId: string,
  projectBinding?: string
): Promise<string | undefined> {
  const captured: Array<string | undefined> = [];
  const spy = vi
    .spyOn(RequestLogger, 'wrapOperation')
    .mockImplementation(async (_tool: any, _args: any, op: any, ctx: any) => {
      captured.push(ctx?.projectId);
      return op();
    });
  try {
    await server['executeMcpTool'](tool, args, {
      connectionId,
      projectBinding,
      actor: 'log-attr-test',
    });
  } finally {
    spy.mockRestore();
  }
  // The spy must have observed EXACTLY one wrapped operation — zero would make every
  // assertion below vacuously true (a past incident #6: absent is what slips through).
  expect(captured.length).toBe(1);
  return captured[0];
}

describe('the request-log project attribution follows the EFFECTIVE scope', () => {
  test('BOUND: the log line names the BOUND project, not the rung-3 one', async () => {
    const conn = await connectionWithRung3OnTheWrongProject('log-bound-conn');

    const logged = await loggedProjectIdFor('project_current', {}, conn, BOUND_PROJECT);

    expect(logged).toBe(boundId);
    // The control that makes the assertion mean something: rung 3 is a DIFFERENT project, and
    // it is still exactly where it was — the binding did not write into it.
    expect(logged).not.toBe(otherId);
    expect(await projectHandler.getInteractiveProjectId(conn)).toBe(otherId);

    ActiveSessionStore.clear(conn);
  }, 60000);

  test('UNBOUND: the log line names THIS connection’s project (not undefined, not another connection’s)', async () => {
    // Two connections on two different projects, so "it read the right connection" is
    // falsifiable rather than a single value that could have come from anywhere.
    const connA = await connectionWithRung3OnTheWrongProject('log-unbound-a');
    const connB = `log-unbound-b-${STAMP}`;
    await routeExecutor('project_switch', validateToolArguments('project_switch', {
      project: BOUND_PROJECT,
    }), { connectionId: connB, actor: 'log-attr-test' });
    expect(await projectHandler.getInteractiveProjectId(connB)).toBe(boundId);

    expect(await loggedProjectIdFor('project_current', {}, connA)).toBe(otherId);
    expect(await loggedProjectIdFor('project_current', {}, connB)).toBe(boundId);

    ActiveSessionStore.clear(connA);
    ActiveSessionStore.clear(connB);
  }, 60000);

  test('KEY SPACE: the pre-fix lookup (session id → sessionStates) could never have resolved', async () => {
    // The exact expression the old code evaluated:
    //     projectHandler['sessionStates'].get(ActiveSessionStore.get(connectionId))
    // A DB session id is a UUID minted by SessionTracker; `sessionStates` is keyed by the
    // CONNECTION id the routes pass in. Measuring both lookups on the same live connection is
    // what turns "wrong key space" from a claim into a fact.
    const conn = await connectionWithRung3OnTheWrongProject('log-keyspace');
    // A content write, so the connection definitely HAS a DB session to look up.
    await routeExecutor('context_store', validateToolArguments('context_store', {
      content: `log attribution keyspace ${STAMP}`,
      type: 'completion',
    }), { connectionId: conn, actor: 'log-attr-test' });

    const sessionId = ActiveSessionStore.get(conn);
    expect(typeof sessionId).toBe('string'); // there IS a session — the lookup had a real input
    expect(sessionId).not.toBe(conn); // …and it is a different key space from the connection

    const states = projectHandler['sessionStates'] as Map<string, { currentProjectId?: string }>;
    expect(states.get(sessionId as string)).toBeUndefined(); // the OLD lookup: a miss
    expect(states.get(conn)?.currentProjectId).toBe(otherId); // the NEW one: the real answer

    ActiveSessionStore.clear(conn);
  }, 60000);
});
