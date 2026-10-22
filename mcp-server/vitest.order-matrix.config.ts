import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * ORDER-MATRIX HARNESS — the rig that makes the
 * import-order hazard DETERMINISTIC so it can be asserted instead of hoped about.
 *
 * WHY IT EXISTS
 *   The authoritative clean gate went GREEN then RED on the same ref, same box. The
 *   proximate cause was module-scope memoization in config/embeddingConfig.ts: three
 *   `export const`s evaluated at FIRST IMPORT, so the value tracked *when the module
 *   was first evaluated* rather than the environment. The embedder-specific test files
 *   flip `MANDREL_EMBEDDER` in a `vi.hoisted()` block; whenever that module's earlier
 *   evaluation was reused, the flip was inert and the assertion failed with
 *   "expected 'embedding' to be 'embedding_gemma'".
 *
 * WHAT THIS CONFIG CHANGES — exactly two things, both about ORDER, nothing about the
 * tests themselves:
 *   1. `isolate: false`  — all files share ONE module registry. Under the shipped
 *      config (`isolate` defaults to true) vitest USUALLY clears the registry between
 *      files, which is why the failure looked like a rare flake rather than a bug. The
 *      correctness of the product must not rest on that vitest implementation detail,
 *      so this harness removes it and asks the question directly.
 *   2. a fixed sequencer — `ORDER_FIRST` (colon-separated path substrings) pins which
 *      files run first, so BOTH orders can be exercised on demand. The default
 *      sequencer sorts by CACHED PREVIOUS DURATION, which is why the real gate's file
 *      order changed run-to-run on an unchanged tree.
 *
 * This is a HARNESS, not a second gate: nothing runs it implicitly. It is driven by
 * embedderImportOrderMatrix.contract.test.ts, which runs both orders and requires both
 * to pass. Run it by hand with:
 *
 *   ORDER_FIRST=embedResilience.unit.test.ts \
 *     npx vitest run --config vitest.order-matrix.config.ts \
 *     src/tests/embedResilience.unit.test.ts src/tests/embedResilienceGemma.contract.test.ts
 */

/** Path substrings, in the order they must execute. Everything else keeps its order. */
const ORDER_FIRST = (process.env.ORDER_FIRST ?? '').split(':').filter(Boolean);

class FixedOrderSequencer {
  ctx: unknown;
  constructor(ctx: unknown) {
    this.ctx = ctx;
  }

  async shard<T>(files: T[]): Promise<T[]> {
    return files;
  }

  async sort<T>(files: T[]): Promise<T[]> {
    const pathOf = (f: T): string => {
      if (typeof f === 'string') return f;
      const anyF = f as unknown as { moduleId?: string; [k: number]: unknown };
      return String(anyF.moduleId ?? anyF[1] ?? '');
    };
    const rank = (f: T): number => {
      const i = ORDER_FIRST.findIndex((w) => pathOf(f).includes(w));
      return i === -1 ? ORDER_FIRST.length : i;
    };
    // Stable: rank first, original position as tiebreak, so unnamed files keep their order.
    return files
      .map((f, i) => [f, i] as const)
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
      .map(([f]) => f);
  }
}

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // THE POINT OF THIS FILE: one shared module registry for every test file, so an
      // import-order dependency is deterministic rather than intermittent.
      isolate: false,
      env: {
        // A NESTED `vitest run` NEEDS ITS OWN ID REGION. This config is
        // driven from INSIDE the suite by embedderImportOrderMatrix.contract.test.ts, so
        // its files run in a second process with a fresh globalThis — vitest.setup.ts's
        // per-file token would restart at 0 and mint ids the PARENT run's first files
        // also mint, against the same database. Starting the child's file index at 1000
        // puts it in a region the parent (314 files today, ceiling 1024) cannot reach.
        MANDREL_VITEST_FILE_INDEX_BASE: '1000',
      },
      sequence: { sequencer: FixedOrderSequencer as never },
    },
  }),
);
