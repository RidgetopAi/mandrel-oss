/**
 * Vitest global setup (replaces CRA/jest's implicit setup).
 *
 * The suite was written for jest. Vitest is API-compatible for the common
 * surface (describe/it/test/expect/beforeEach/... are exposed as globals via
 * `test.globals: true` in vite.config.ts). The one gap is the `jest` namespace
 * object: a handful of tests call `jest.fn`, `jest.spyOn`, `jest.useFakeTimers`,
 * `jest.clearAllMocks`, etc. We alias the runtime `jest` object to vitest's `vi`
 * so those keep working unchanged. (Hoisted mock FACTORIES — `jest.mock(...)` —
 * are NOT aliasable at runtime because the bundler must see them statically, so
 * those specific calls were rewritten to `vi.mock(...)` in the test files.)
 */
import { beforeEach, vi } from 'vitest';
import { installMatchMediaMock, resetViewportWidth } from './testUtils/viewport';

// Runtime compat: `jest.fn` / `jest.spyOn` / `jest.useFakeTimers` / timers /
// clear/restoreAllMocks all exist on `vi` with matching signatures.
(globalThis as unknown as { jest: typeof vi }).jest = vi;

// jsdom has no `window.matchMedia` at all (an earlier task — see testUtils/viewport.ts for
// why that made the mobile-overlay branch on Contexts/Decisions structurally unreachable
// by every test). Installed once per test file; each test starts at the desktop-width
// default so this is additive — a suite that never calls `setViewportWidth` behaves
// exactly as it did before this shim existed.
installMatchMediaMock();
beforeEach(() => {
  resetViewportWidth();
});

// React 18 wants this flag set for `act()` used outside a testing-library
// harness (this repo renders with raw react-dom + React.act).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom has no ResizeObserver; recharts' ResponsiveContainer and @xyflow/react
// (P0.6 charts) both reference it. Provide a no-op polyfill so those components
// mount in tests. Additive — only defined if the runtime lacks it.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
