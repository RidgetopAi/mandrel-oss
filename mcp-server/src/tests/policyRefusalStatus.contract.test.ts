/**
 * POLICY REFUSALS CARRY A 4xx, AND REAL FAULTS STILL CARRY A 5xx (an earlier task — the
 * deferred half of an earlier decision).
 *
 * ## What was measured before the fix, and why it is not what the task expected
 *
 * The task was written expecting policy refusals to reach the caller as HTTP 500, via the
 * `typeof code !== 'number'` fall-through in utils/mcpErrorStatus.ts (our policy errors carry
 * STRING codes). Driven at the real HTTP surface that is not what happened, because those
 * errors never reach the express catch: routeExecutorInner catches them and returns
 * formatMcpError IN BAND, and the in-band branch hardcoded 200. Measured, all four:
 *
 *     PROJECT_AMBIENT_WRITE_UNIDENTIFIED  → 200        PROJECT_BINDING_UNRESOLVED → 200
 *     PROJECT_SCOPE_SWITCH_UNIDENTIFIED   → 200        actor-requirement rejection → 200
 *
 * A refused write reported to the transport as a completed one. That is the worse direction:
 * a 500 at least tells a `res.ok` check something failed.
 *
 * ## Why §3 exists and is not padding
 *
 * Turning genuine faults into 4xx would be worse than the bug being fixed — it hides real
 * incidents from the 5xx rate that is the only thing watching for them. So the 5xx direction
 * is asserted at the SAME surface, in the same file, rather than left to the reader's
 * confidence that "we only touched the refusal path".
 *
 * ## Why §2's population is trustworthy
 *
 * The risk in a table like this is that it enumerates the refusals the author happened to
 * remember. So the classes are DISCOVERED from the two modules' exports at runtime and the
 * discovered set is asserted EQUAL to the set the table covers. A new refusal class added to
 * either module without a row here turns §2 RED by construction; it cannot be forgotten
 * silently. That is the whole population — `MandrelClassifiedError` is the only base that
 * declares a status, so anything not descending from it cannot classify itself at all, and
 * §1 covers that hole behaviourally at the wire.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import type express from 'express';
import type http from 'http';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', async () => {
  const { embedDim } = await import('./helpers/embedGeometry.js');
  return {
    embeddingService: {
      generateEmbedding: vi.fn(async () => ({
        embedding: new Array(embedDim()).fill(0.01),
        dimensions: embedDim(),
        model: 'stub-local',
      })),
    },
  };
});

import { db } from '../config/database.js';
import MandrelMcpServer from '../server/MandrelMcpServer.js';
import { HealthServer } from '../server/healthServer.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MandrelClassifiedError, httpStatusForToolOutcome } from '../utils/mcpErrorStatus.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import * as projectBinding from '../services/projectBinding.js';
import * as callerIdentity from '../services/callerIdentityGuard.js';
import * as agentFoldIn from '../services/agentFoldInGuard.js';
import { ActorRequirementError } from '../routes/index.js';

const STAMP = Date.now();
const CONN = `policy-conn-${STAMP}`;

let listener: http.Server;
let base: string;
let projectId: string;

interface Res {
  status: number;
  body: {
    success?: boolean;
    error?: string;
    result?: { isError?: boolean; transportStatus?: number; content?: Array<{ text?: string }> };
  };
}

async function post(
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
  target: string = base,
): Promise<Res> {
  const res = await fetch(`${target}/mcp/tools/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ arguments: args }),
  });
  return { status: res.status, body: (await res.json()) as Res['body'] };
}

const textOf = (r: Res): string => r.body.result?.content?.[0]?.text ?? '';

describe('policy refusals are 4xx; real faults are 5xx; ordinary tool errors are 200', () => {
  beforeAll(async () => {
    const server = new MandrelMcpServer();
    const app = (server as any).healthServer.app as express.Application;
    listener = await new Promise<http.Server>((r) => {
      const l = app.listen(0, () => r(l));
    });
    const a = listener.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'policy refusal status contract') RETURNING id`,
        [`policy-P-${STAMP}`],
      )
    ).rows[0].id;
  }, 60000);

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => listener?.close(() => r()));
    await db.end();
  });

  // ===================================================================================
  // §1 THE REFUSAL DIRECTION, at the real HTTP surface, through the real guards.
  //    Not a unit test of the classifier: the defect lived in the seam between the
  //    executor's in-band catch and the express envelope, so only the wire can see it.
  // ===================================================================================
  describe('§1 a policy refusal answers 4xx and still carries its own prose', () => {
    test('G2 ambient write with no connection identity and no project → 403', async () => {
      const res = await post('context_store', {
        content: 'policy refusal fixture — must be REFUSED, never stored',
        type: 'completion',
      });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.result?.isError).toBe(true);
      // The remedy survives the status change: the BODY is untouched by this fix.
      expect(textOf(res)).toContain('PROJECT_AMBIENT_WRITE_UNIDENTIFIED');
      expect(textOf(res)).toContain('X-Connection-ID');
    }, 30000);

    test('G1 scope switch with no connection identity → 403', async () => {
      const res = await post('project_switch', { project: projectId });
      expect(res.status).toBe(403);
      expect(textOf(res)).toContain('PROJECT_SCOPE_SWITCH_UNIDENTIFIED');
    }, 30000);

    test('a CLIENT-declared binding naming no project → 400 (the client named it)', async () => {
      const res = await post(
        'mandrel_ping',
        { message: 'bound to nothing' },
        {
          'X-Connection-ID': `${CONN}-bind`,
          'X-Mandrel-Project': `no-such-project-${STAMP}`,
        },
      );
      expect(res.status).toBe(400);
      expect(textOf(res)).toContain('PROJECT_BINDING_UNRESOLVED');
    }, 30000);

    test('an explicit project argument naming no project → 404 (resource-shaped)', async () => {
      const res = await post(
        'context_search',
        { query: 'anything', projectId: `no-such-project-${STAMP}` },
        { 'X-Connection-ID': `${CONN}-arg` },
      );
      expect(res.status).toBe(404);
      expect(textOf(res)).toContain('PROJECT_ARG_UNRESOLVED');
    }, 30000);

    test('a blank project reference → 400', async () => {
      const res = await post(
        'context_search',
        { query: 'anything', projectId: '   ' },
        { 'X-Connection-ID': `${CONN}-blank` },
      );
      expect(res.status).toBe(400);
      expect(textOf(res)).toContain('PROJECT_ARG_BLANK');
    }, 30000);

    test('the actor requirement → 403 (authenticated, refused on policy — never 401)', async () => {
      const prior = SESSION_CONFIG.requireActor;
      (SESSION_CONFIG as { requireActor: boolean }).requireActor = true;
      try {
        const res = await post(
          'context_store',
          { content: 'must be refused', type: 'completion', projectId },
          { 'X-Connection-ID': `${CONN}-actor` },
        );
        expect(res.status).toBe(403);
        // 401 would send an agent SDK into a credential-refresh loop it cannot escape:
        // no credential can supply an X-Actor-ID header.
        expect(res.status).not.toBe(401);
        expect(textOf(res)).toContain('X-Actor-ID');
      } finally {
        (SESSION_CONFIG as { requireActor: boolean }).requireActor = prior;
      }
    }, 30000);

    test('NOTHING WAS WRITTEN by the refused write (a 4xx that stored a row would be worse)', async () => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM contexts WHERE content LIKE '%policy refusal fixture%'`,
      );
      expect(rows[0].n).toBe(0);
    }, 30000);
  });

  // ===================================================================================
  // §2 EVERY CLASSIFIED ERROR DECLARES A STATUS — over a DISCOVERED population.
  // ===================================================================================
  describe('§2 the classified-error population', () => {
    /** Constructors that produce each refusal, with representative arguments. */
    const factories: Record<string, () => MandrelClassifiedError> = {
      ProjectBindingError: () => new (projectBinding as any).ProjectBindingError('m', 'CODE', 400),
      ProjectBindingMismatchError: () =>
        new projectBinding.ProjectBindingMismatchError(
          't',
          { identifier: 'a', id: 'a-id', name: 'A' },
          { identifier: 'b', id: 'b-id', name: 'B', originLabel: 'X-Mandrel-Project header' },
        ),
      ProjectBindingUnresolvedError: () =>
        new projectBinding.ProjectBindingUnresolvedError({
          identifier: 'nope',
          origin: 'header',
          originLabel: 'X-Mandrel-Project header',
        }),
      ProjectBindingTargetUnresolvedError: () =>
        new projectBinding.ProjectBindingTargetUnresolvedError('t', 'nope', {
          id: 'b-id',
          name: 'B',
          originLabel: 'X-Mandrel-Project header',
        }),
      ProjectArgUnresolvedError: () =>
        new projectBinding.ProjectArgUnresolvedError('t', 'projectId', 'nope'),
      ProjectArgBlankError: () => new projectBinding.ProjectArgBlankError('t', 'projectId', '   '),
      ProjectBindingAmbiguousParamError: () =>
        new projectBinding.ProjectBindingAmbiguousParamError('t', ['a', 'b']),
      CallerIdentityError: () =>
        new (callerIdentity as any).CallerIdentityError('m', 'CODE', 'G1-scope-switch'),
      ScopeSwitchUnidentifiedError: () => new callerIdentity.ScopeSwitchUnidentifiedError('t'),
      AmbientWriteUnidentifiedError: () => new callerIdentity.AmbientWriteUnidentifiedError('t'),
      ActorRequirementError: () => new ActorRequirementError('t'),
      AgentFoldInError: () => new agentFoldIn.AgentFoldInError('builder'),
    };

    /** Every exported class in a module whose prototype chain reaches MandrelClassifiedError. */
    const discover = (mod: Record<string, unknown>): string[] =>
      Object.entries(mod)
        .filter(
          ([, v]) =>
            typeof v === 'function' &&
            (v as { prototype?: object }).prototype !== undefined &&
            Object.prototype.isPrototypeOf.call(
              MandrelClassifiedError.prototype,
              (v as { prototype: object }).prototype,
            ),
        )
        .map(([k]) => k);

    test('the table covers EXACTLY the classes that exist (a new refusal cannot be forgotten)', async () => {
      const routes = await import('../routes/index.js');
      const discovered = [
        ...discover(projectBinding as unknown as Record<string, unknown>),
        ...discover(callerIdentity as unknown as Record<string, unknown>),
        ...discover(agentFoldIn as unknown as Record<string, unknown>),
        ...discover(routes as unknown as Record<string, unknown>),
      ].sort();
      expect(discovered).toEqual(Object.keys(factories).sort());
      // A population of zero would make every assertion below vacuously true.
      expect(discovered.length).toBeGreaterThan(0);
    });

    test.each(Object.keys(factories))(
      '%s declares a numeric, non-2xx status and survives formatMcpError',
      (name) => {
        const err = factories[name]();
        expect(typeof err.faultStatus).toBe('number');
        expect(err.faultStatus).toBeGreaterThanOrEqual(400);
        expect(err.faultStatus).toBeLessThan(600);
        // The seam: the status must reach the result the executor returns in band.
        const result = formatMcpError(err, 'contract');
        expect(result.transportStatus).toBe(err.faultStatus);
        expect(
          httpStatusForToolOutcome({ kind: 'returned', result, failed: true }),
        ).toBe(err.faultStatus);
      },
    );

    test('the two errors that are OUR fault, not the caller\'s, are 5xx', () => {
      // An env-configured binding naming nothing: this host's MANDREL_PROJECT_ID is broken
      // and no request the client can construct will succeed until an operator fixes it.
      expect(
        new projectBinding.ProjectBindingUnresolvedError({
          identifier: 'nope',
          origin: 'env',
          originLabel: 'MANDREL_PROJECT_ID env var',
        }).faultStatus,
      ).toBe(500);
      // A tool declaring two project-scope params is a defect in OUR schema; the remedy is
      // a source change, and blaming the caller would hide it from the 5xx rate.
      expect(factories.ProjectBindingAmbiguousParamError().faultStatus).toBe(500);
      // The client-declared twin of the first one is the caller's mistake, and differs.
      expect(factories.ProjectBindingUnresolvedError().faultStatus).toBe(400);
    });
  });

  // ===================================================================================
  // §3 THE OTHER DIRECTION — a genuine fault is still 5xx, and an ordinary tool error
  //    is still 200. Getting either wrong is worse than the bug being fixed.
  // ===================================================================================
  describe('§3 real faults stay 5xx and ordinary tool errors stay 200', () => {
    test('a genuine internal fault thrown by the executor → 500, at the wire', async () => {
      const stub = new HealthServer(async () => {
        throw new McpError(ErrorCode.InternalError, 'a genuine internal fault');
      });
      const app = (stub as any).app as express.Application;
      const l = await new Promise<http.Server>((r) => {
        const s = app.listen(0, () => r(s));
      });
      try {
        const addr = l.address();
        const b = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        expect((await post('mandrel_ping', {}, {}, b)).status).toBe(500);
      } finally {
        await new Promise<void>((r) => l.close(() => r()));
      }
    }, 30000);

    test('an UNCLASSIFIED thrown error → 500, at the wire (fail closed)', async () => {
      const stub = new HealthServer(async () => {
        // The shape a Postgres driver error really has: a STRING code. This is the exact
        // value the refusal fix must NOT have taught the classifier to call a client error.
        throw Object.assign(new Error('database exploded'), { code: '23505' });
      });
      const app = (stub as any).app as express.Application;
      const l = await new Promise<http.Server>((r) => {
        const s = app.listen(0, () => r(s));
      });
      try {
        const addr = l.address();
        const b = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        expect((await post('mandrel_ping', {}, {}, b)).status).toBe(500);
      } finally {
        await new Promise<void>((r) => l.close(() => r()));
      }
    }, 30000);

    test('an ordinary in-band tool error (not found) stays 200', async () => {
      const res = await post('context_delete', { contextId: 'deadbeef' }, { 'X-Connection-ID': `${CONN}-nf` });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
      expect(res.body.result?.transportStatus).toBeUndefined();
    }, 30000);

    test('an unknown GATEWAY action stays 200 (the tool ran and answered)', async () => {
      const res = await post('task', { action: 'no_such_action_xyz' }, { 'X-Connection-ID': `${CONN}-ga` });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
    }, 30000);

    test('a NORMAL call is still 200', async () => {
      const res = await post('mandrel_ping', { message: 'ok' }, { 'X-Connection-ID': `${CONN}-ok` });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }, 30000);
  });

  // ===================================================================================
  // §4 THE AUTHORITY ITSELF — the unit-level fail-closed / fail-conservative rules that
  //    the wire tests above depend on but cannot enumerate exhaustively.
  // ===================================================================================
  describe('§4 httpStatusForToolOutcome is the single authority and defaults safely', () => {
    test('THREW + anything unrecognised → 500', () => {
      for (const e of [null, undefined, 'a string', new Error('x'), { code: 'ECONNREFUSED' }, { code: 0 }]) {
        expect(httpStatusForToolOutcome({ kind: 'threw', error: e })).toBe(500);
      }
    });

    test('THREW + a classified refusal → its declared status (the escape hatch agrees)', () => {
      // Nothing throws these to the express catch today — routeExecutorInner returns them in
      // band. Pinned anyway: if a future refactor lets one escape, the two branches must not
      // give two different answers, which is the exact defect this task collapsed.
      const err = new callerIdentity.AmbientWriteUnidentifiedError('t');
      expect(httpStatusForToolOutcome({ kind: 'threw', error: err })).toBe(403);
      expect(
        httpStatusForToolOutcome({ kind: 'returned', result: formatMcpError(err, 't'), failed: true }),
      ).toBe(403);
    });

    test('RETURNED + failed + no declared status → 200 (an ordinary MCP tool error)', () => {
      expect(
        httpStatusForToolOutcome({ kind: 'returned', result: { isError: true, content: [] }, failed: true }),
      ).toBe(200);
    });

    test('RETURNED + NOT failed → 200 even if something set a status on it', () => {
      // A success can never be relabelled a refusal by a stray field.
      expect(
        httpStatusForToolOutcome({ kind: 'returned', result: { transportStatus: 403 }, failed: false }),
      ).toBe(200);
    });

    test('RETURNED + failed + a NON-numeric status → 200 (never crash, never guess)', () => {
      // NaN is the one that actually bit: it IS typeof 'number', so a bare typeof check
      // let it through to res.status(NaN). Found by this test, fixed in the product.
      for (const bad of ['403', null, {}, NaN, Infinity, 200, 399, 600, 403.5]) {
        expect(
          httpStatusForToolOutcome({
            kind: 'returned',
            result: { isError: true, transportStatus: bad } as never,
            failed: true,
          }),
        ).toBe(200);
      }
    });
  });
});
