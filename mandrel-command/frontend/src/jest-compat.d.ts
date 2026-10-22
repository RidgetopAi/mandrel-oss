/**
 * Type-level compat shim for the jest→vitest migration (P0.1).
 *
 * A few migrated tests still use `jest.Mock` / `jest.SpyInstance` as TYPE
 * annotations (e.g. `foo as jest.Mock`). The runtime `jest` object is aliased to
 * `vi` in src/setupTests.ts; this ambient declaration keeps those TYPE
 * references resolving to vitest's equivalents so `tsc`/editors stay green.
 * (esbuild strips the annotations at test runtime regardless.)
 */
import type { Mock as VMock, MockInstance as VMockInstance } from 'vitest';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    // vitest's Mock/MockInstance are the closest analogues; the test usages are
    // untyped casts (`as jest.Mock`) so the loose aliases are sufficient.
    type Mock = VMock;
    type SpyInstance = VMockInstance;
  }
}

export {};
