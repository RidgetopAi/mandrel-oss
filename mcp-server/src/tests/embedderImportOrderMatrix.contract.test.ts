/**
 * THE CLEAN GATE MUST GIVE THE SAME ANSWER IN BOTH IMPORT ORDERS.
 *
 * This is the ACCEPTANCE test for the non-deterministic-gate bug, and it is deliberately an
 * end-to-end one: embedderSelectionMemoization.unit.test.ts proves the config module no
 * longer memoizes, but the thing that actually went GREEN-then-RED was the *suite*, so the
 * suite is what gets asserted here.
 *
 * WHAT IT DOES
 *   Runs the two real files that disagreed in the field —
 *     src/tests/embedResilience.unit.test.ts        (does NOT flip MANDREL_EMBEDDER)
 *     src/tests/embedResilienceGemma.contract.test.ts (flips MANDREL_EMBEDDER=gemma in vi.hoisted)
 *   in BOTH orders, in a child vitest that SHARES one module registry (`isolate: false`,
 *   see vitest.order-matrix.config.ts). Both orders must pass.
 *
 * WHY `isolate: false` IS THE RIGHT RIG, not a rigged one
 *   Under the shipped config vitest usually clears the module registry between files, which
 *   is exactly why this bug read as a rare flake for two days instead of as a bug: it only
 *   surfaced when that clearing did not happen. Depending on that behaviour is depending on
 *   a vitest implementation detail for product correctness. This harness removes the
 *   dependency and asks the question directly — and it is how the failure was finally
 *   reproduced ON DEMAND at f9df00d, with the field's exact message:
 *
 *     AssertionError: active column must be the gemma column:
 *       expected 'embedding' to be 'embedding_gemma'
 *
 *   BEFORE the fix: ORDER_FIRST=embedResilienceGemma… → 2 passed;
 *                   ORDER_FIRST=embedResilience.unit… → 1 failed | 1 passed.
 *   AFTER the fix:  both orders → 2 passed.
 *
 * WHY A CHILD PROCESS: import order is a property of a whole vitest RUN, so it cannot be
 * asserted from inside one. The child is scoped to exactly two files and inherits this
 * run's DB env, so it costs a few seconds and touches nothing new.
 */
import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The two files whose disagreement made the gate non-deterministic. */
const MINILM_FILE = 'src/tests/embedResilience.unit.test.ts';
const GEMMA_FILE = 'src/tests/embedResilienceGemma.contract.test.ts';

/** Generous: a child vitest pays its own startup + transform, on a possibly loaded CI box. */
const MATRIX_TIMEOUT_MS = 240_000;

interface RunResult {
  status: number | null;
  output: string;
}

/**
 * Strip ANSI SGR sequences so an assertion about the child's summary cannot depend on
 * whether the child decided to colourise.
 *
 * WHY THIS EXISTS (GitHub Actions, red on every push 2026-07-26 → 2026-07-30):
 * the positive control below matched /Test Files\s+2 passed \(2\)/ against the child's
 * RENDERED summary. Locally there is no TTY and no CI var, so picocolors disables colour,
 * the string is plain, and it matched. GitHub Actions sets CI=true, colour turns ON, and
 * the same summary arrives as:
 *
 *   ESC[2m Test Files ESC[22m ESC[1mESC[32m2 passedESC[39mESC[22mESC[90m (2)ESC[39m
 *
 * — escape sequences between every token, so `\s+` cannot bridge them and the control
 * failed while the child itself reported "2 test files, 7 tests, all passed". The guarded
 * property PASSED; only the control was red. That is the worst kind of red: it trains you
 * to ignore the signal.
 *
 * The deeper fault is that a MACHINE fact (did the rig run two files?) was being read out
 * of a HUMAN rendering. Same defect as scraping prose for a count that a structured
 * channel already carries. Belt and braces below: the child is told not to colourise AND
 * the output is stripped before matching, so neither a new CI env nor a tool that ignores
 * NO_COLOR can make this environment-dependent again — which is the entire thesis of this
 * file (the gate must give the SAME answer everywhere).
 */
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the entire point
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function runOrder(firstFile: string): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORDER_FIRST: path.basename(firstFile),
    // Deterministic, uncoloured child output regardless of CI/TTY (see stripAnsi above).
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  // Do NOT let the parent run's vitest wiring leak into the child.
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST_') || k === 'TEST' || k === 'VITEST') delete env[k];
  }
  const r = spawnSync(
    'npx',
    [
      'vitest',
      'run',
      '--config',
      'vitest.order-matrix.config.ts',
      '--reporter',
      'basic',
      MINILM_FILE,
      GEMMA_FILE,
    ],
    { cwd: MCP_DIR, env, encoding: 'utf8', timeout: MATRIX_TIMEOUT_MS - 30_000 },
  );
  // Strip at the BOUNDARY so every consumer (the assertion below and the failure tail)
  // sees the same environment-independent text. Colour carries no information in a log.
  return { status: r.status, output: stripAnsi(`${r.stdout ?? ''}\n${r.stderr ?? ''}`) };
}

/** Last N lines — enough to see the vitest summary and any assertion, without a wall of logs. */
const tail = (s: string, n = 40) => s.trimEnd().split('\n').slice(-n).join('\n');

describe('embedder import-order matrix', () => {
  test(
    'BOTH import orders pass with a SHARED module registry',
    () => {
      const results: Record<string, RunResult> = {};
      for (const first of [GEMMA_FILE, MINILM_FILE]) {
        results[first] = runOrder(first);
      }

      const failures = Object.entries(results).filter(([, r]) => r.status !== 0);

      expect(
        failures.map(([f]) => f),
        'These import orders FAILED. The gate is order-dependent again — something on the\n' +
          'embedder path has been re-memoized at module scope. Do NOT fix this by ordering\n' +
          'the files, retrying, or skipping; find the snapshot and delete it.\n\n' +
          failures.map(([f, r]) => `===== ORDER_FIRST=${f} (rc=${r.status})\n${tail(r.output)}`).join('\n\n'),
      ).toEqual([]);

      // Positive control: prove the child rig actually RAN the two files rather than
      // exiting 0 on an empty selection (a matrix that silently measures nothing is worse
      // than no matrix).
      for (const [first, r] of Object.entries(results)) {
        expect(r.output, `ORDER_FIRST=${first}: child did not report 2 test files`).toMatch(
          /Test Files\s+2 passed \(2\)/,
        );
      }
    },
    MATRIX_TIMEOUT_MS,
  );
});
