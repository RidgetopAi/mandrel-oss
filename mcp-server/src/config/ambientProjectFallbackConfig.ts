import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * THE PRIORITY-4 AMBIENT FALLBACK MUST NOT BE SILENT IN TESTS
 * (measured by the L7 lane; the edit lives here because handlers/project.ts is another
 * lane's file).
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. The rule and the condition it fires
 * under live here, once, beside the reason.
 *
 * ── WHAT PRIORITY 4 IS ───────────────────────────────────────────────────────────────
 * `projectHandler.initializeSession` resolves the project for a connection that has never
 * acted. Its last rung is `projects[0]`, and `listProjects` orders `ORDER BY p.updated_at
 * DESC`. So an unbound connection writes into "whichever project was touched most recently
 * ANYWHERE in the database" — a property of the BOX and the run order, not of the code
 * under test.
 *
 * ── WHY LOUD, AND WHY FIXING THE CALL SITES WAS NOT ENOUGH ───────────────────────────
 * L7 fixed the four measured sites. That protects those four and does nothing for the next
 * test anyone writes: allow-by-default, with the class left open. And the failure mode is
 * MISDIRECTION, which is what makes silence expensive here. Measured on one disposable
 * Postgres, planting a single decoy project dated into the future:
 *     control                                        3585 passed / 0 failed
 *     + one decoy, updated_at = now() + 365 days     3581 passed / 4 failed
 *     decoy removed, SAME database                   3585 passed / 0 failed
 * The four were autoOpenPositions x2, projectArgNormalizer and statsSearchCountReconcile,
 * and their messages were `expected false to be true`, `expected undefined to be 2`,
 * `expected [] to deeply equal [ Array(1) ]` and `expected undefined to be truthy`. NOT ONE
 * of them names a project-scope cause. The author of the next such test would debug
 * `recall_thread` or `session_list` for an hour before suspecting the project ladder.
 *
 * So the fallback announces itself. A test that reaches it has not chosen a project, and
 * whatever it then asserts is a coin flip on row ordering.
 *
 * ── THE HARD CONSTRAINT: PRODUCTION IS UNTOUCHED ─────────────────────────────────────
 * Priority 4 is LEGITIMATE in production. It is how a real unbound client gets a project at
 * all, and 5 of 7 tenants have no primary project, so throwing there would break them
 * (exactly the reason `services/callerIdentityGuard.ts` G3 leaves reads alone). This gate is
 * therefore keyed on NODE_ENV === 'test' and nothing else: no opt-in flag that could be left
 * on, no config file a deployment could inherit.
 *
 * Read at CALL time, not at import time, so a probe can flip NODE_ENV and observe BOTH
 * behaviours in one run — which is the only way "production is byte-identical" is a
 * measurement rather than a claim.
 */

/** The one environment in which an ambient project inheritance is a defect rather than a feature. */
export const AMBIENT_FALLBACK_LOUD_NODE_ENV = 'test';

const allowStore = new AsyncLocalStorage<string>();

export function ambientProjectFallbackIsLoud(): boolean {
  if (allowStore.getStore() !== undefined) return false;
  return process.env.NODE_ENV === AMBIENT_FALLBACK_LOUD_NODE_ENV;
}

/**
 * THE CO-LOCATED EXCEPTION, with its reason written at the site — NOT a
 * central allow-list, and NOT a narrowing of the rule to the shapes we happen to have.
 *
 * WHY IT HAS TO EXIST. Some tests exercise the unbound path ON PURPOSE — that is their
 * subject (unidentifiedCallerScope, projectArgNormalizer's "no scope argument" arm). A
 * blanket throw makes the thing they are for unwritable, and a guard that blocks correct
 * work gets deleted the first time it is inconvenient, which is strictly worse than the
 * hole it closed. So the rule stays loud by DEFAULT and a test that means it says so, in
 * one place, next to the call, with a `reason` it must supply.
 *
 * Scoped by AsyncLocalStorage rather than a module flag so a parallel test cannot
 * accidentally inherit another's exemption — the same reasoning as effectiveProjectScope.
 */
export function withAmbientProjectFallbackAllowed<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return allowStore.run(reason, fn);
}

/**
 * Thrown INSTEAD of silently inheriting `projects[0]`. Carries the three facts a reader
 * needs to act — which connection, what it silently would have picked, and how many
 * candidates there were — because a loud failure that does not say what to do next is only
 * a different kind of misdirection.
 */
export class AmbientProjectFallbackError extends Error {
  constructor(
    readonly connectionId: string,
    readonly wouldHavePicked: string,
    readonly candidateCount: number
  ) {
    super(
      `[AMBIENT_PROJECT_FALLBACK] connection '${connectionId}' never chose a project, so the ` +
        `project ladder fell through to Priority 4 — projects[0] — and would have used ` +
        `'${wouldHavePicked}' out of ${candidateCount} candidates. projects[0] is ` +
        `ORDER BY updated_at DESC: it is whichever project this DATABASE touched most ` +
        `recently, not anything about this test, so any assertion made after it is a coin ` +
        `flip on row ordering. Choose a project: bind the connection ` +
        `(tests/helpers/projectBinding.ts bindConnectionToProject), pass an explicit ` +
        `projectId, or project_switch first. This is loud in NODE_ENV=test ONLY; ` +
        `production behaviour is unchanged, because an unbound real client legitimately ` +
        `relies on this rung.`
    );
    this.name = 'AmbientProjectFallbackError';
  }
}
