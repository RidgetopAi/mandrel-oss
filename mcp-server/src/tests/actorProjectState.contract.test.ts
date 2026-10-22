/**
 * ACTOR-KEYED CURRENT-PROJECT — contract tests.
 *
 * THE DEFECT UNDER TEST: "current project" is keyed on TRANSPORT identity (the connection
 * id), with every identity-less caller collapsed onto ONE shared literal — a sticky,
 * last-writer-wins slot (measured flip-flopping on prod 2026-07-27/28), lost on restart.
 * The fix keys the state on the derived ACTOR (the durable identity the composite-actor
 * work shipped), behind MANDREL_ACTOR_PROJECT_STATE_ENABLED (default OFF).
 *
 * Pinned here:
 *   (1) FLAG ON + COMPOSITES ON: two agents under ONE OAuth sub with distinct declared
 *       handles get DISTINCT current-projects — and neither's project_switch moves the
 *       other's — even on the SAME connection id (the transport identity that used to be
 *       the whole key).
 *   (2) FLAG ON: an anonymous / actor-less caller has NO actor-keyed state: it cannot
 *       read any actor's default (no shared 'anonymous' row is ever written or read —
 *       that literal would rebuild the shared-slot defect one layer up).
 *   (3) FLAG ON: the ladder holds — an explicit projectId argument beats the actor
 *       default (proven at the real write surface: the stored row's project_id), and an
 *       ambient write with NO explicit project lands in the actor default.
 *   (4) FLAG ON: the binding (rung 2) still beats the actor default (rung 2.5).
 *   (5) FLAG OFF (the shipped default): parity — the legacy connection slot answers even
 *       when an actor default row exists, and project_switch writes NOTHING to the table.
 *
 * Env-flip discipline: both flags are read at CALL TIME (actorProjectStateConfig /
 * actorIdentityConfig), flipped in try/finally, always restored (file-serial suite).
 * DB-backed; rides the CI-provisioned migrated DB (migration 073).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { projectHandler } from '../handlers/project.js';
import { runWithProjectScope } from '../services/effectiveProjectScope.js';
import { deriveActor } from '../config/actorRegistry.js';
import { actorProjectKey, upsertActorProjectDefault } from '../services/actorProjectDefaults.js';
import { ACTOR_PROJECT_STATE_ENV, actorProjectStateEnabled } from '../config/actorProjectStateConfig.js';
import { ACTOR_IDENTITY_ENV } from '../config/actorIdentityConfig.js';
import { withAmbientProjectFallbackAllowed } from '../config/ambientProjectFallbackConfig.js';

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PROJ_PREFIX = `actor-proj-P-${STAMP}`;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from response: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}

async function newProject(label: string): Promise<{ id: string; name: string }> {
  const name = `${PROJ_PREFIX}-${label}`;
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'actor-project-state e912b354 test') RETURNING id`,
    [name]
  );
  return { id: r.rows[0].id, name };
}

/** Flip env flags for the duration of `fn`, ALWAYS restoring. */
async function withEnv<T>(flags: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(flags)) {
    prior.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Run `fn` inside an established ambient scope, as the given actor/connection. */
async function asCaller<T>(
  actor: string | undefined,
  conn: string,
  fn: () => Promise<T>,
  projectBinding?: string
): Promise<T> {
  return runWithProjectScope({ connectionId: conn, actor, projectBinding }, fn);
}

/** Full public path (validate → routeExecutor) with an actor-carrying context. */
async function viaTool(conn: string, actor: string | undefined, toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn, actor });
}

async function actorRow(actorKey: string): Promise<string | null> {
  const r = await db.query(`SELECT project_id FROM actor_project_defaults WHERE actor = $1`, [actorKey]);
  return r.rows[0]?.project_id ?? null;
}

describe('actor-keyed current-project', () => {
  beforeAll(async () => {
    const t = await db.query("SELECT to_regclass('public.actor_project_defaults') AS t");
    expect(t.rows[0].t).not.toBeNull();
    // Both flags must be OFF at rest or the parity assertions measure the wrong mode.
    expect(actorProjectStateEnabled()).toBe(false);
  });

  afterAll(async () => {
    try {
      await db.query(
        `DELETE FROM actor_project_defaults WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`,
        [`${PROJ_PREFIX}-%`]
      );
      await db.query(`DELETE FROM contexts WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`, [`${PROJ_PREFIX}-%`]);
      await db.query(`DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`, [`${PROJ_PREFIX}-%`]);
      await db.query(`DELETE FROM projects WHERE name LIKE $1`, [`${PROJ_PREFIX}-%`]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── (1) N agents under ONE principal: distinct state, no cross-moves ───────────────────
  test('(1) flag ON + composites ON: two handles under one OAuth sub keep DISTINCT current-projects on the SAME connection', async () => {
    const p1 = await newProject('agent-a');
    const p2 = await newProject('agent-b');
    const conn = `conn-shared-${STAMP}`; // ONE connection id — the old (broken) key

    await withEnv(
      {
        [ACTOR_PROJECT_STATE_ENV.ENABLED]: 'true',
        [ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED]: 'true',
      },
      async () => {
        const sub = 'owner@example.com';
        const actorA = deriveActor(sub, 'agent-a')!;
        const actorB = deriveActor(sub, 'agent-b')!;
        expect(actorA).not.toBe(actorB); // the composite primitive is what makes this test possible

        // A switches to p1; B switches to p2 — same connection, interleaved.
        await asCaller(actorA, conn, () => projectHandler.switchProject(p1.id, conn));
        await asCaller(actorB, conn, () => projectHandler.switchProject(p2.id, conn));

        // DISTINCT reads: B's switch did NOT move A, and vice versa. (Without the actor
        // rung both reads would answer the connection Map: p2, last-writer-wins.)
        expect(await asCaller(actorA, conn, () => projectHandler.getCurrentProjectId(conn))).toBe(p1.id);
        expect(await asCaller(actorB, conn, () => projectHandler.getCurrentProjectId(conn))).toBe(p2.id);

        // The durable rows are keyed by the normalized composite actor.
        expect(await actorRow(actorProjectKey(actorA)!)).toBe(p1.id);
        expect(await actorRow(actorProjectKey(actorB)!)).toBe(p2.id);

        // Distinctness survives a restart (the in-memory Map is gone; the DB row answers).
        projectHandler.clearSessionCache();
        expect(await asCaller(actorA, conn, () => projectHandler.getCurrentProjectId(conn))).toBe(p1.id);
      }
    );
  });

  // ── (2) anonymous/actor-less callers have NO actor-keyed state ─────────────────────────
  test('(2) flag ON: a header-less/anonymous caller cannot read any actor default (and mints no anonymous row)', async () => {
    const p1 = await newProject('anon-victim');
    const freshConn = `conn-anon-${STAMP}`;

    await withEnv({ [ACTOR_PROJECT_STATE_ENV.ENABLED]: 'true' }, async () => {
      // A real actor has a default set.
      await upsertActorProjectDefault('some-agent', p1.id);

      // The anonymous key is refused at the ONE key rule…
      expect(actorProjectKey('anonymous')).toBeNull();
      expect(actorProjectKey(undefined)).toBeNull();
      expect(actorProjectKey('  ')).toBeNull();

      // …so an anonymous caller resolves NOTHING from the table (fresh conn, empty Map):
      // NOT some-agent's default, not anyone's.
      expect(await asCaller('anonymous', freshConn, () => projectHandler.getCurrentProjectId(freshConn))).toBeNull();
      expect(await asCaller(undefined, freshConn, () => projectHandler.getCurrentProjectId(freshConn))).toBeNull();

      // And an anonymous project_switch persists NO anonymous row.
      await asCaller('anonymous', freshConn, () => projectHandler.switchProject(p1.id, freshConn));
      const anonRows = await db.query(`SELECT count(*)::int AS c FROM actor_project_defaults WHERE actor = 'anonymous'`);
      expect(anonRows.rows[0].c).toBe(0);
    });
  });

  // ── (3) the ladder at the REAL write surface: explicit arg > actor default ─────────────
  test('(3) flag ON: an explicit projectId always wins over the actor default; an ambient write lands in the actor default', async () => {
    const pDefault = await newProject('ladder-default');
    const pExplicit = await newProject('ladder-explicit');
    const conn = `conn-ladder-${STAMP}`;
    const actor = 'ladder-agent';

    await withEnv({ [ACTOR_PROJECT_STATE_ENV.ENABLED]: 'true' }, async () => {
      await upsertActorProjectDefault(actor, pDefault.id);

      // EXPLICIT projectId → the row lands there, actor default ignored (rung 1 > 2.5).
      const explicitResp = await viaTool(conn, actor, 'context_store', {
        content: 'ladder explicit-arg write',
        type: 'code',
        projectId: pExplicit.id,
      });
      expect(explicitResp.isError).not.toBe(true);
      const explicitRow = await db.query(`SELECT project_id FROM contexts WHERE id = $1`, [parseId(explicitResp)]);
      expect(explicitRow.rows[0].project_id).toBe(pExplicit.id);

      // AMBIENT write (no projectId) → the actor default answers (rung 2.5 > the Map).
      //
      // OPT OUT of the test-only ambient-project guard, deliberately. "Ambient"
      // is the literal subject: this connection must NOT be bound, or the answer would come
      // from rung 2 and the test would be measuring the binding — which is test (4)'s job, not
      // this one's. `initializeSession` runs at route entry and knows nothing about actor
      // defaults, so it reaches Priority 4 before rung 2.5 is ever consulted; the assertion
      // below is what proves the actor default, not projects[0], decided the row.
      const ambientResp = await withAmbientProjectFallbackAllowed(
        'rung 2.5 (actor default) is only reachable by a connection that has chosen no ' +
          'project — binding this connection would test rung 2 instead, which is test (4).',
        () =>
          viaTool(conn, actor, 'context_store', {
            content: 'ladder ambient write',
            type: 'code',
          }),
      );
      expect(ambientResp.isError).not.toBe(true);
      const ambientRow = await db.query(`SELECT project_id FROM contexts WHERE id = $1`, [parseId(ambientResp)]);
      expect(ambientRow.rows[0].project_id).toBe(pDefault.id);
    });
  });

  // ── (4) the binding (rung 2) still beats the actor default (rung 2.5) ──────────────────
  test('(4) flag ON: an X-Mandrel-Project binding outranks the actor default', async () => {
    const pDefault = await newProject('bind-default');
    const pBound = await newProject('bind-bound');
    const conn = `conn-bind-${STAMP}`;
    const actor = 'binding-agent';

    await withEnv({ [ACTOR_PROJECT_STATE_ENV.ENABLED]: 'true' }, async () => {
      await upsertActorProjectDefault(actor, pDefault.id);
      const resolved = await asCaller(
        actor,
        conn,
        () => projectHandler.getCurrentProjectId(conn),
        pBound.name // the declared X-Mandrel-Project binding
      );
      expect(resolved).toBe(pBound.id);
    });
  });

  // ── (5) flag OFF: parity — the table is inert in both directions ───────────────────────
  test('(5) flag OFF (shipped default): the legacy connection slot answers, and project_switch writes nothing to the table', async () => {
    const pMap = await newProject('parity-map');
    const pTable = await newProject('parity-table');
    const conn = `conn-parity-${STAMP}`;
    const actor = 'parity-agent';

    // A row exists in the table (as if the flag had been on once) …
    await upsertActorProjectDefault(actor, pTable.id);

    // … but with the flag OFF (ambient default), the READ ignores it: the connection slot wins.
    await asCaller(actor, conn, () => projectHandler.switchProject(pMap.id, conn));
    expect(await asCaller(actor, conn, () => projectHandler.getCurrentProjectId(conn))).toBe(pMap.id);

    // And the WRITE path did not touch the table: the row still points at pTable.
    expect(await actorRow(actor)).toBe(pTable.id);
  });
});
