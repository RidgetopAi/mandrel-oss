/**
 * AMBIENT PROJECT INHERITANCE — the frozen reproduction.
 *
 * WHAT THIS FILE IS
 * -----------------
 * The coin-flip this task was filed for, made DETERMINISTIC and permanent. Three contract
 * tests in this suite were green only because the project the database happened to sort first
 * was, by luck, the project they meant. This file removes the luck: it plants the adverse
 * ordering itself, so the hazard is exercised on every run rather than waiting to fire on the
 * box during a deploy.
 *
 * THE MECHANISM (measured on this tree, not theorised)
 * ---------------------------------------------------
 * Every project-scoped route opens with `projectHandler.initializeSession(connectionId)`. For
 * a connection that has never acted, that ladder ends at **Priority 4 — `projects[0]`**
 * (handlers/project.ts), and `listProjects` orders `ORDER BY p.updated_at DESC`. So an unbound
 * connection writes into "whichever project was touched most recently ANYWHERE in the
 * database" — a property of the BOX and the run order, not of the commit under test.
 *
 * THE MEASUREMENT that produced this file (full suite, one disposable migrated Postgres):
 *     control                                     3585 passed / 0 failed
 *     + one decoy project, updated_at in the future   3581 passed / 4 failed
 *     decoy removed, SAME database                3585 passed / 0 failed
 * The four failures were `autoOpenPositions` x2 (two unbound READER connections),
 * `projectArgNormalizer` (its "no scope argument" arm) and `statsSearchCountReconcile` (an
 * unscoped `session_list` on the shared default slot). Their messages were `expected false to
 * be true`, `expected undefined to be 2`, `expected [] to deeply equal [ Array(1) ]` and
 * `expected undefined to be truthy` — not one of which names a project-scope cause.
 *
 * WHY A FUTURE `updated_at` RATHER THAN A BUMPER LOOP
 * --------------------------------------------------
 * The decoy has to stay `projects[0]` for the whole test even though the fixture project is
 * created after it and other rows are written meanwhile. Dating it forward makes that
 * structural instead of a race with the suite.
 *
 * SCOPE OF THIS GUARD, stated so nobody mistakes it for more (C3): it proves the RULE — that
 * ordering decides an unbound connection's project, and that binding defeats it. It does NOT
 * enumerate which other test files are exposed; that is what the full-suite decoy run above
 * is for, and it is the instrument to re-run if this class resurfaces.
 *
 * THAT CLASS FIX HAS LANDED: Priority 4 is now LOUD under NODE_ENV=test —
 * `handlers/project.ts` throws `AmbientProjectFallbackError` instead of inheriting, and the
 * rule lives in `config/ambientProjectFallbackConfig.ts`. Section A was updated accordingly
 * and is now the guard's own probe: A1 the refusal (and that nothing was written), A2 the
 * frozen reproduction reached through the documented opt-out — the control that proves A1's
 * RED is catching a live hazard — and A3 the measurement, not the claim, that production
 * outside NODE_ENV=test still inherits silently.
 *
 * DB target: the disposable migrated ci_* database, never production.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

// Zero embeddings: similarity plays no part in project scoping, and a zero vector keeps
// inference from minting anything that could flatter or muddy the row counts below.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub-zero' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { projectHandler } from '../handlers/project.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';
import {
  AMBIENT_FALLBACK_LOUD_NODE_ENV,
  ambientProjectFallbackIsLoud,
  withAmbientProjectFallbackAllowed,
} from '../config/ambientProjectFallbackConfig.js';

const STAMP = Date.now();
const FIXTURE_NAME = `ambient-fixture-${STAMP}`;
const DECOY_NAME = `ZZZ-ambient-decoy-${STAMP}`;

let fixtureId = '';
let decoyId = '';

/** The production invocation — validate exactly as the MCP surface does, then dispatch. */
async function viaTool(tool: string, rawArgs: any, conn: string): Promise<any> {
  return routeExecutor(tool, validateToolArguments(tool, rawArgs), { connectionId: conn });
}

/** Store one capture and read the project it ACTUALLY landed in, from Postgres. */
async function storeAndReadProject(conn: string, label: string): Promise<string> {
  const resp = await viaTool('context_store', { content: `ambient probe: ${label}`, type: 'completion' }, conn);
  expect(resp.isError, `store failed for '${label}': ${JSON.stringify(resp?.content)?.slice(0, 200)}`).not.toBe(
    true,
  );
  const id = resp.structuredContent.context.id as string;
  const row = await db.query('SELECT project_id::text AS project_id FROM contexts WHERE id = $1', [id]);
  return row.rows[0].project_id;
}

beforeAll(async () => {
  decoyId = (
    await db.query(
      `INSERT INTO projects (name, description, updated_at)
       VALUES ($1, 'adverse-ordering decoy', now() + interval '365 days') RETURNING id`,
      [DECOY_NAME],
    )
  ).rows[0].id;
  fixtureId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'fixture') RETURNING id`, [
      FIXTURE_NAME,
    ])
  ).rows[0].id;
});

afterAll(async () => {
  for (const pid of [decoyId, fixtureId]) {
    if (!pid) continue;
    for (const t of ['links', 'branch_positions', 'contexts', 'technical_decisions', 'tasks', 'sessions']) {
      try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [pid]); } catch { /* teardown noise */ }
    }
    try { await db.query('DELETE FROM projects WHERE id = $1', [pid]); } catch { /* teardown noise */ }
  }
  await db.end();
});

describe('ambient project inheritance', () => {
  // ── WITNESS ────────────────────────────────────────────────────────────────────────────
  // Without this, section B is green for free: if the decoy were NOT first, "binding wins"
  // would prove nothing, because there would be nothing for the binding to beat. This is the
  // "the mutation LANDED" leg of the probe (CLASSES.md C3), read from the product's OWN
  // ordering rather than re-implemented here.
  test('WITNESS — the decoy really is projects[0], so the adverse ordering is in force', async () => {
    const projects = await projectHandler.listProjects(false);
    expect(projects.length, 'the fixture projects must exist').toBeGreaterThanOrEqual(2);
    expect(projects[0].id, 'the decoy must sort first — otherwise this file tests nothing').toBe(decoyId);
    expect(projects[0].id, 'the fixture must NOT be first, or the hazard is not being exercised').not.toBe(
      fixtureId,
    );
  });

  // ── SECTION A — THE HAZARD, NOW GUARDED ────────────────────────────────────────────────
  // The header's stated update has landed: Priority 4 is LOUD under NODE_ENV=test
  // (config/ambientProjectFallbackConfig.ts). So section A no longer asserts a silent
  // inheritance — it asserts the three things that make the guard worth having, in the order
  // a reader needs them (CLASSES.md C3: mutation RED, unmutated control GREEN, and the claim
  // about the untouched population actually measured rather than asserted).

  test('A1 — LOUD: an unbound connection is REFUSED, and the refusal names what it would have taken', async () => {
    const conn = `ambient-unbound-${STAMP}`;
    const resp = await viaTool('context_store', { content: 'ambient probe: unbound', type: 'completion' }, conn);

    expect(resp.isError, 'an unbound connection must NOT be allowed to write on row ordering').toBe(true);
    const text = JSON.stringify(resp?.content ?? '');
    expect(text, 'the refusal must carry the machine-greppable code').toContain('[AMBIENT_PROJECT_FALLBACK]');
    expect(text, 'the refusal must name the connection that failed to choose').toContain(conn);
    expect(text, 'and the project it would silently have taken — the actionable half').toContain(DECOY_NAME);

    // AND NOTHING WAS WRITTEN. A guard that reports the fault after performing it is not a
    // guard; the coin flip would still have landed a row in the decoy.
    const written = await db.query(
      `SELECT count(*)::int AS n FROM contexts WHERE project_id IN ($1, $2) AND content = $3`,
      [decoyId, fixtureId, 'ambient probe: unbound'],
    );
    expect(written.rows[0].n, 'the refused store must have written no row anywhere').toBe(0);
  });

  test('A2 — THE FROZEN REPRODUCTION, still exercised: with the guard opted out, the ordering DOES decide', async () => {
    // This is the original section A, kept verbatim in behaviour and reached through the
    // documented exception rather than by deleting the assertion. It is what makes A1's RED
    // mean something: it proves the hazard is still live underneath the guard, so A1 is
    // catching a real thing rather than passing because nothing happens on this path.
    const landed = await withAmbientProjectFallbackAllowed(
      'the frozen reproduction for an earlier task — this test exists to DEMONSTRATE the ' +
        'Priority-4 inheritance, so it is the one caller that must be allowed to reach it.',
      () => storeAndReadProject(`ambient-optout-${STAMP}`, 'opted-out'),
    );
    expect(landed, 'the ambient winner is exactly projects[0]').toBe(decoyId);
    expect(landed, 'and it is NOT the project the test chose — that is the whole defect').not.toBe(fixtureId);
  });

  test('A3 — PRODUCTION IS UNTOUCHED: outside NODE_ENV=test the same call inherits silently', async () => {
    // The config keys the gate on NODE_ENV and NOTHING else, and reads it at CALL time
    // precisely so this can be measured instead of claimed. Priority 4 is legitimate in
    // production — it is how a real unbound client gets a project at all — and 5 of 7 tenants
    // have no primary project, so a throw there would break them.
    const before = process.env.NODE_ENV;
    expect(before, 'the control: this suite runs in the one env where the gate is armed').toBe(
      AMBIENT_FALLBACK_LOUD_NODE_ENV,
    );
    expect(ambientProjectFallbackIsLoud(), 'armed under NODE_ENV=test').toBe(true);
    try {
      process.env.NODE_ENV = 'production';
      expect(ambientProjectFallbackIsLoud(), 'disarmed outside NODE_ENV=test').toBe(false);
      const landed = await storeAndReadProject(`ambient-prod-${STAMP}`, 'production-env');
      expect(landed, 'production still inherits projects[0], exactly as before this guard').toBe(decoyId);
    } finally {
      process.env.NODE_ENV = before;
    }
    expect(ambientProjectFallbackIsLoud(), 're-armed after the probe').toBe(true);
  });

  // ── SECTION B — THE FIX ────────────────────────────────────────────────────────────────
  // REVERT PROBE: delete the `bindConnectionToProject` line and this test goes RED with
  // `expected <decoy> to be <fixture>`. Verified by hand at build time.
  test('B — a BOUND connection writes where the test said, decoy or no decoy', async () => {
    const conn = `ambient-bound-${STAMP}`;
    await bindConnectionToProject(conn, FIXTURE_NAME);

    const landed = await storeAndReadProject(conn, 'bound');
    expect(landed, 'a bound connection must be immune to the ambient ordering').toBe(fixtureId);
  });

  // ── SECTION C — THE READ SIDE ──────────────────────────────────────────────────────────
  // The two autoOpenPositions failures were READS, not writes: a reader connection is scoped
  // the same way, so a test that writes correctly and reads on a fresh connection is still
  // exposed. Proven here on the shipped search surface.
  test('C — a READER connection is scoped the same way, and binding fixes it too', async () => {
    const writer = `ambient-cwriter-${STAMP}`;
    await bindConnectionToProject(writer, FIXTURE_NAME);
    const marker = `ambient-read-probe-${STAMP}`;
    const stored = await viaTool('context_store', { content: marker, type: 'completion' }, writer);
    expect(stored.isError).not.toBe(true);

    const idsOf = (resp: any): string[] =>
      ((resp?.structuredContent?.contexts ?? resp?.structuredContent?.results ?? []) as any[]).map(
        (c: any) => c.id,
      );
    const wanted = stored.structuredContent.context.id as string;

    // OPT OUT for this one call: an unbound READER is the subject here. Without the opt-out
    // this assertion would still be GREEN — but for the wrong reason, because the guard's
    // error response carries no ids and `not.toContain` passes over an empty list. Reaching
    // the ambient rung on purpose is what makes it an assertion about SCOPE rather than an
    // assertion that something went wrong.
    const unbound = await withAmbientProjectFallbackAllowed(
      'section C demonstrates that a READER connection is scoped by the same ambient ladder; ' +
        'the unbound reader is the subject, not a fixture oversight.',
      () => viaTool('context_search', { query: marker, limit: 20 }, `ambient-runbound-${STAMP}`),
    );
    expect(unbound.isError, 'the opted-out read must actually RUN, not fail').not.toBe(true);
    expect(idsOf(unbound), 'an unbound reader searches the ambient winner, not the test project').not.toContain(
      wanted,
    );

    const boundReader = `ambient-rbound-${STAMP}`;
    await bindConnectionToProject(boundReader, FIXTURE_NAME);
    const bound = await viaTool('context_search', { query: marker, limit: 20 }, boundReader);
    expect(idsOf(bound), 'a bound reader finds the record the test actually wrote').toContain(wanted);
  });
});
