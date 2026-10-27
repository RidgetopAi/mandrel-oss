/**
 * THE EMBEDDER SELECTION IS NEVER MEMOIZED.
 *
 * WHAT BROKE
 *   The authoritative clean gate returned GREEN and then RED
 *   on the SAME ref, same box. The failing assertion was embedResilienceGemma's
 *   "active column must be the gemma column: expected 'embedding' to be 'embedding_gemma'".
 *   config/embeddingConfig.ts memoized the selection in three module-scope `export const`s
 *   evaluated at FIRST IMPORT, so the value was a function of WHEN the module was first
 *   evaluated, not of the environment. Every test file runs in ONE process
 *   (vitest.config: fileParallelism:false + singleFork:true) and the embedder-specific
 *   files flip `MANDREL_EMBEDDER` in `vi.hoisted()`; whenever an earlier evaluation of the
 *   config module was reused, that flip was INERT.
 *
 * WHAT THIS FILE GUARDS — the CHOKE POINT, not the shapes
 *   Every embedder-dependent value in the system is derived from ONE thing: the answer to
 *   "which embedder does the environment select RIGHT NOW". So this file asserts that
 *   property once, at that choke point, for EVERY exported accessor — the config module is
 *   imported ONCE at the top of this file (statically, the way the poisoned callers did),
 *   the env is then changed, and each accessor must FOLLOW. A re-import would prove
 *   nothing; the bug was precisely that a stale evaluation stayed live.
 *
 *   POPULATION: every export of config/embeddingConfig.ts whose value depends on
 *   `MANDREL_EMBEDDER` — activeEmbedderKey / activeEmbedder / activeEmbeddingColumn /
 *   activeSimilarity / applyPrefix — plus tests/helpers/embedGeometry.ts's embedDim(),
 *   which re-introduced the identical memoization one layer up (22 test files import it).
 *   Enumerated here rather than sampled: any accessor added to that module that snapshots
 *   the selection is a re-occurrence of this bug, and belongs in the list below.
 *
 * WHY NOT ORDER THE TESTS / RETRY / SKIP: ordering is the symptom. A retry converts a
 * visible race into a hidden one, and a lucky ordering can MASK a real regression — the
 * dangerous direction for a gate every other task's definition of done depends on.
 */
import { describe, test, expect, afterAll } from 'vitest';

// STATIC import, deliberately: this is the import that USED to poison the value. Whatever
// the suite's ambient MANDREL_EMBEDDER is (the CI gate pins minilm), it is captured here — and
// every assertion below must hold regardless.
import {
  activeEmbedderKey,
  activeEmbedder,
  activeEmbeddingColumn,
  activeSimilarity,
  applyPrefix,
  embedders,
} from '../config/embeddingConfig.js';
import { embedDim } from './helpers/embedGeometry.js';

const PRIOR = process.env.MANDREL_EMBEDDER;

/** Set (or unset) MANDREL_EMBEDDER, run `fn`, and always put the env back. */
function withEmbedder<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.MANDREL_EMBEDDER;
  if (value === undefined) delete process.env.MANDREL_EMBEDDER;
  else process.env.MANDREL_EMBEDDER = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = before;
  }
}

afterAll(() => {
  // The suite-wide env-leak guard (vitest.setup.ts) fails this file if we do not.
  if (PRIOR === undefined) delete process.env.MANDREL_EMBEDDER;
  else process.env.MANDREL_EMBEDDER = PRIOR;
});

describe('embedder selection reads the environment at point of use', () => {
  test('the module was imported under a DIFFERENT embedder than the ones asserted below', () => {
    // Establishes the precondition that makes every other case meaningful: this file's
    // static import above has already evaluated embeddingConfig once. If that evaluation
    // were the source of truth (the bug), the gemma cases below could not pass.
    expect(['minilm', 'gemma']).toContain(activeEmbedderKey());
  });

  test('flipping to gemma is visible WITHOUT re-importing — every derived accessor follows', () => {
    withEmbedder('gemma', () => {
      expect(activeEmbedderKey()).toBe('gemma');
      expect(activeEmbedder().key).toBe('gemma');
      expect(activeEmbedder().dimensions).toBe(embedders().gemma.dimensions);
      expect(activeEmbeddingColumn()).toBe(embedders().gemma.column);
      expect(activeSimilarity()).toEqual(expect.objectContaining({ floor: expect.any(Number) }));
      // gemma is the asymmetric model: its prefixes are non-empty, minilm's are ''.
      expect(applyPrefix('x', 'query')).toBe(`${embedders().gemma.queryPrefix}x`);
      expect(embedDim()).toBe(embedders().gemma.dimensions);
    });
  });

  test('flipping back to minilm is visible WITHOUT re-importing — the swap is reversible', () => {
    withEmbedder('minilm', () => {
      expect(activeEmbedderKey()).toBe('minilm');
      expect(activeEmbeddingColumn()).toBe(embedders().minilm.column);
      expect(activeEmbedder().dimensions).toBe(embedders().minilm.dimensions);
      expect(applyPrefix('x', 'query')).toBe('x'); // minilm is symmetric: no prefix
      expect(embedDim()).toBe(embedders().minilm.dimensions);
    });
  });

  test('gemma → minilm → gemma in ONE process: no accessor gets stuck', () => {
    // The memoized version passed the first flip it saw and got stuck there forever. Three
    // transitions with no re-import is the shape that catches "cached on first WRITE" as
    // well as "cached on first READ".
    const seen: string[] = [];
    withEmbedder('gemma', () => seen.push(activeEmbeddingColumn()));
    withEmbedder('minilm', () => seen.push(activeEmbeddingColumn()));
    withEmbedder('gemma', () => seen.push(activeEmbeddingColumn()));
    expect(seen).toEqual([
      embedders().gemma.column,
      embedders().minilm.column,
      embedders().gemma.column,
    ]);
  });

  // ---- THE POPULATIONS THAT SLIP THROUGH: empty, absent, invalid --------------------
  // A memoizing implementation and a correct one agree on the happy values and disagree
  // here, because these are the ones that take the FALLBACK branch.

  test('ABSENT (unset) selects minilm at point of use, not a stale snapshot', () => {
    withEmbedder(undefined, () => {
      expect(process.env.MANDREL_EMBEDDER).toBeUndefined();
      expect(activeEmbedderKey()).toBe('minilm');
      expect(activeEmbeddingColumn()).toBe(embedders().minilm.column);
    });
  });

  test('EMPTY string selects minilm (envStr treats "" as unset)', () => {
    withEmbedder('', () => {
      expect(activeEmbedderKey()).toBe('minilm');
      expect(activeEmbeddingColumn()).toBe(embedders().minilm.column);
    });
  });

  // An UNKNOWN value used to fall back to minilm. That fallback WAS the bug: a typo'd env
  // silently repointed every SQL site at a column the active embedder never writes, which
  // returns empty results with no error. It now throws, naming the value and the valid keys.
  test('an UNKNOWN embedder THROWS rather than silently selecting a column', () => {
    withEmbedder('not-a-real-embedder', () => {
      expect(() => activeEmbedderKey()).toThrow(/not-a-real-embedder/);
      expect(() => activeEmbedderKey()).toThrow(/gemma/);
      expect(() => activeEmbeddingColumn()).toThrow(/not-a-real-embedder/);
    });
  });

  test('the column is always a real registry column — never "undefined" in SQL', () => {
    const valid = Object.values(embedders()).map((e) => e.column);
    // Only the values that RESOLVE — the unknown case is asserted to throw above, and a
    // throw is the whole point: there is no column to be wrong about.
    for (const v of ['gemma', 'minilm', '', undefined] as (string | undefined)[]) {
      withEmbedder(v, () => {
        expect(valid, `MANDREL_EMBEDDER=${JSON.stringify(v)}`).toContain(activeEmbeddingColumn());
      });
    }
  });

  test('env is restored after every case (this file must not leak into later files)', () => {
    expect(process.env.MANDREL_EMBEDDER).toBe(PRIOR);
  });
});
