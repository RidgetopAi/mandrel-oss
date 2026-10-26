/**
 * PROJECT SCOPE — THE ALS STORE'S ISOLATION IS A CLAIM, SO IT IS GUARDED.
 * governed by an earlier decision.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 * `services/effectiveProjectScope.ts` justifies choosing AsyncLocalStorage over a
 * `Map<connectionId, …>` with a load-bearing safety claim, in its own doc:
 *
 *     "ALS is scoped to the call, cannot leak between connections, cannot go stale,
 *      and needs no eviction."
 *
 * Nothing asserted it. Reviewer replaced the ALS with a module-level global —
 *
 *     let LEAKY: ProjectScopeContext | undefined;
 *     export function runWithProjectScope(ctx, fn) { LEAKY = ctx; return fn(); }
 *
 * — the literal cross-request-leak shape, and `projectScopeChokePoint.contract.test.ts`
 * stayed 24/24 GREEN. That is a past incident's tell ("your guard and your product agree, and you
 * can weaken one without the other noticing") sitting inside the fix written to close it.
 *
 * It is not hypothetical maintenance anxiety: the next obvious optimisation is caching the
 * resolved binding, and the natural place to put that cache is EXACTLY where the leak lives
 * (a module map keyed by connection). This guard has to exist before anyone tries it.
 *
 * =============================================================================
 * TWO LAYERS, BECAUSE ONE OF THEM IS PROBABILISTIC
 * =============================================================================
 * PART 1 — THE PRIMITIVE, DETERMINISTICALLY. No DB, no scheduler luck: a RENDEZVOUS
 *   (two promises) FORCES one scope to be suspended at an await while another scope is
 *   entered, and the interleave ORDER IS ASSERTED, so the test cannot pass by never having
 *   overlapped. Also asserts the "cannot go stale" half — the store is empty again the
 *   instant the call returns, which a module global fails on its own, with no concurrency
 *   at all. Reads through `bindingInForce()`, the function the PRODUCT calls, not only
 *   through the raw store.
 *
 * PART 2 — THE WHOLE PATH, UNDER LOAD. Reviewer's probe, adopted: 200 interleaved
 *   `project_current` calls across three scope states (bound A / bound B / unbound sitting
 *   on a third project) through the real `routeExecutor` against real Postgres, plus 40
 *   concurrent bound `context_store` writes checked in the DB. This is the one that would
 *   catch a leak PART 1's model missed.
 *
 * PROBING THE PROBE (a past incident #6 — zero/empty/absent are what slips through). A
 * concurrency test degrades silently: collapse the interleave count to 1, or collapse the
 * three scope states to one, and it still reports PASS while measuring nothing. So the shape
 * of the workload is PINNED LITERALLY (`INTERLEAVED_CALLS`, `EXPECTED_PER_STATE`,
 * `CONCURRENT_WRITES`) and asserted against what was actually built and actually observed —
 * shrinking the probe is a RED, not a quieter green.
 *
 * Runs inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { PROJECT_BINDING_ENV_VAR, PROJECT_BINDING_HEADER } from '../config/projectBindingConfig.js';
import { BOUND_PROJECT_HINT } from '../config/projectEchoConfig.js';
import {
  runWithProjectScope,
  currentProjectScope,
  bindingInForce,
} from '../services/effectiveProjectScope.js';

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART 1 — the primitive, deterministically (no DB, no scheduler luck)
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** A promise plus its resolver — the rendezvous that FORCES the interleave. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('PART 1 — the scope store cannot leak between calls and cannot outlive one', () => {
  afterEach(() => {
    delete process.env[PROJECT_BINDING_ENV_VAR];
  });

  test('a scope does NOT outlive the call that established it ("cannot go stale")', async () => {
    // Pre-condition, asserted rather than assumed: nothing is in force to begin with,
    // otherwise the post-condition below could hold for the wrong reason.
    expect(currentProjectScope()).toBeUndefined();
    expect(bindingInForce()).toBeUndefined();

    const inside = await runWithProjectScope(
      { connectionId: 'outlive-conn', projectBinding: 'outlive-project' },
      async () => {
        // The store is visible to everything the call awaits, not just its first tick.
        await Promise.resolve();
        return {
          raw: currentProjectScope()?.projectBinding,
          // …and through the accessor the PRODUCT actually reads.
          viaProduct: bindingInForce()?.identifier,
        };
      }
    );
    expect(inside).toEqual({ raw: 'outlive-project', viaProduct: 'outlive-project' });

    // THE ASSERTION A MODULE GLOBAL FAILS WITH NO CONCURRENCY AT ALL: the value is gone the
    // instant the call returns. A `let LEAKY` setter keeps it, and the NEXT request — a
    // different connection, maybe an unbound one — reads a binding that was never its own.
    expect(currentProjectScope()).toBeUndefined();
    expect(bindingInForce()).toBeUndefined();
  });

  test('two scopes suspended across each other each keep their OWN binding (forced interleave)', async () => {
    const aEntered = deferred();
    const bEntered = deferred();
    /** The ACTUAL execution order, so "they never overlapped" cannot masquerade as a pass. */
    const order: string[] = [];

    const a = runWithProjectScope({ connectionId: 'conn-a', projectBinding: 'proj-A' }, async () => {
      order.push('A:enter');
      const before = bindingInForce()?.identifier;
      aEntered.resolve(); // release B — A is now SUSPENDED inside its own scope
      await bEntered.promise; // B has entered (and, with a module global, overwritten the value)
      order.push('A:resume');
      return [before, bindingInForce()?.identifier];
    });

    const b = runWithProjectScope({ connectionId: 'conn-b', projectBinding: 'proj-B' }, async () => {
      await aEntered.promise;
      order.push('B:enter');
      const seen = bindingInForce()?.identifier;
      bEntered.resolve();
      await Promise.resolve();
      order.push('B:resume');
      return [seen, bindingInForce()?.identifier];
    });

    const [ra, rb] = await Promise.all([a, b]);

    // PROBE THE PROBE, co-located so deleting it is visible: B really did run WHILE A was
    // suspended inside its scope. Without this, removing the rendezvous awaits turns this
    // test into two sequential calls that any implementation passes.
    expect(order).toEqual(['A:enter', 'B:enter', 'A:resume', 'B:resume']);

    // A's read AFTER B ran is still A's. This is the cross-request leak, in one assertion.
    expect(ra).toEqual(['proj-A', 'proj-A']);
    expect(rb).toEqual(['proj-B', 'proj-B']);
  });

  test('OUTSIDE any scope only the process-wide env binding applies (the documented default)', async () => {
    // The module's own claim: with no established scope there is no header binding, and the
    // ONE remaining rung is the process env — read through the same configuredBinding().
    expect(bindingInForce()).toBeUndefined();

    process.env[PROJECT_BINDING_ENV_VAR] = 'env-only-project';
    expect(bindingInForce()).toMatchObject({ identifier: 'env-only-project', origin: 'env' });

    // …and an established header scope still WINS over it, from inside a call.
    const inner = await runWithProjectScope({ projectBinding: 'header-project' }, async () =>
      bindingInForce()
    );
    expect(inner).toMatchObject({ identifier: 'header-project', origin: 'header' });

    // Leaving the call restores the env answer — not the header one.
    expect(bindingInForce()).toMatchObject({ identifier: 'env-only-project', origin: 'env' });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PART 2 — the whole path under load (real Postgres, real routeExecutor)
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE PINNED WORKLOAD SHAPE. Asserted against what is actually built and actually observed,
 * because a concurrency probe that quietly shrinks still reports PASS. Changing any of these
 * is a deliberate two-file diff (a past incident #7), never a drift.
 */
const INTERLEAVED_CALLS = 200;
const SCOPE_STATES = 3;
/** 200 calls round-robined over 3 states — the exact split, pinned. */
const EXPECTED_PER_STATE = Object.freeze({ boundA: 67, boundB: 67, unbound: 66 });
const CONCURRENT_WRITES = 40;

const STAMP = Date.now();
const A_PROJECT = `als-a-${STAMP}`;
const B_PROJECT = `als-b-${STAMP}`;
const C_PROJECT = `als-c-${STAMP}`;

let aId: string;
let bId: string;
let cId: string;

/** Call a tool exactly the way the live surface does: validated args, through routeExecutor. */
async function call(tool: string, args: any, conn: string, binding?: string): Promise<any> {
  return routeExecutor(tool, validateToolArguments(tool, args), {
    connectionId: conn,
    projectBinding: binding,
    actor: 'als-isolation-test',
  });
}

beforeAll(async () => {
  const ids: string[] = [];
  for (const name of [A_PROJECT, B_PROJECT, C_PROJECT]) {
    ids.push(
      (
        await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'als') RETURNING id`, [
          name,
        ])
      ).rows[0].id
    );
  }
  [aId, bId, cId] = ids;
  // The three targets must be DISTINCT, or "everyone saw their own project" is unfalsifiable.
  expect(new Set(ids).size).toBe(SCOPE_STATES);
});

afterAll(async () => {
  const ids = [aId, bId, cId];
  for (const t of ['contexts', 'tasks', 'technical_decisions', 'sessions']) {
    await db.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [ids]);
  }
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ids]);
});

describe('PART 2 — concurrent calls in different scope states never cross', () => {
  test(`${INTERLEAVED_CALLS} interleaved project_current calls each report their OWN scope`, async () => {
    // The UNBOUND connection's rung 3 is parked on a THIRD project, so a leaked or lost scope
    // is observable in both directions: a bound call falling through reports C, and an unbound
    // call picking up a stray binding reports A or B.
    const unboundConn = `als-unbound-${STAMP}`;
    await call('project_switch', { project: C_PROJECT }, unboundConn);

    const jobs: Promise<any>[] = [];
    const expected: string[] = [];
    const built = { boundA: 0, boundB: 0, unbound: 0 };

    for (let i = 0; i < INTERLEAVED_CALLS; i++) {
      const state = i % SCOPE_STATES;
      if (state === 0) {
        jobs.push(call('project_current', {}, `als-a-${i}-${STAMP}`, A_PROJECT));
        expected.push(aId);
        built.boundA++;
      } else if (state === 1) {
        jobs.push(call('project_current', {}, `als-b-${i}-${STAMP}`, B_PROJECT));
        expected.push(bId);
        built.boundB++;
      } else {
        jobs.push(call('project_current', {}, unboundConn));
        expected.push(cId);
        built.unbound++;
      }
    }

    // PROBE THE PROBE, before measuring anything: the workload really is 200 calls spread over
    // all three states. A collapsed loop bound or a collapsed state set is RED here, not a
    // quieter green further down.
    expect(jobs.length).toBe(INTERLEAVED_CALLS);
    expect(built).toEqual({ ...EXPECTED_PER_STATE });
    expect(new Set(expected).size).toBe(SCOPE_STATES);

    const results = await Promise.all(jobs);
    const got: Array<string | undefined> = results.map((r) => r.structuredContent?.project?.id);

    // Every call resolved SOMETHING — an all-undefined run would satisfy "nobody saw the wrong
    // project" while proving nothing (a past incident #6: absent is the value that slips through).
    expect(got.filter((g) => typeof g === 'string').length).toBe(INTERLEAVED_CALLS);
    // …and the run really did exercise all three answers, not one repeated 200 times.
    expect(new Set(got).size).toBe(SCOPE_STATES);

    const crossed = got
      .map((g, i) => (g === expected[i] ? null : `call #${i}: reported ${g}, own scope is ${expected[i]}`))
      .filter(Boolean);
    expect(crossed).toEqual([]);

    ActiveSessionStore.clear(unboundConn);
  }, 120000);

  test(`${CONCURRENT_WRITES} concurrent bound writes each LAND in their own project`, async () => {
    // Reporting is one half of an earlier decision; this is the other — where the row goes.
    const jobs: Promise<any>[] = [];
    const marks: Array<[string, string]> = [];
    const built = { boundA: 0, boundB: 0 };

    for (let i = 0; i < CONCURRENT_WRITES; i++) {
      const even = i % 2 === 0;
      const content = `als-write-${STAMP}-${i}`;
      marks.push([content, even ? aId : bId]);
      if (even) built.boundA++;
      else built.boundB++;
      jobs.push(
        call(
          'context_store',
          { content, type: 'completion' },
          `als-w-${i}-${STAMP}`,
          even ? A_PROJECT : B_PROJECT
        )
      );
    }

    // PROBE THE PROBE: both bindings are actually represented, in the pinned volume.
    expect(jobs.length).toBe(CONCURRENT_WRITES);
    expect(built).toEqual({ boundA: CONCURRENT_WRITES / 2, boundB: CONCURRENT_WRITES / 2 });

    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.isError).length).toBe(0);

    // TEETH, added deliberately: the WRITE-LANDING half below is ALS-INDEPENDENT — the row's
    // project comes from the binding materialised into `args.projectId` by routes/index.ts,
    // which is passed down the call stack, not read from the ambient store. Measured: with the
    // ALS replaced by a module-level global, the landing assertions alone stayed GREEN. The
    // ECHO does read the ambient scope (utils/projectEcho.ts -> boundProjectInForce), so
    // asserting each write's own echo is what makes this test sensitive to a cross-request
    // leak as well as to a mis-routed write.
    for (let i = 0; i < CONCURRENT_WRITES; i++) {
      const echo: string = results[i]?.content?.map((c: any) => c.text).join('\n') ?? '';
      const ownProject = i % 2 === 0 ? A_PROJECT : B_PROJECT;
      const otherProject = i % 2 === 0 ? B_PROJECT : A_PROJECT;
      expect(echo).toContain(BOUND_PROJECT_HINT);
      expect(echo).toContain(`${PROJECT_BINDING_HEADER} header`);
      expect(echo).toContain(ownProject);
      expect(echo).not.toContain(otherProject);
    }

    for (const [content, wanted] of marks) {
      const rows = (
        await db.query('SELECT project_id FROM contexts WHERE content = $1', [content])
      ).rows;
      expect(rows.length).toBe(1);
      expect(rows[0].project_id).toBe(wanted);
    }

    for (let i = 0; i < CONCURRENT_WRITES; i++) ActiveSessionStore.clear(`als-w-${i}-${STAMP}`);
  }, 180000);
});
