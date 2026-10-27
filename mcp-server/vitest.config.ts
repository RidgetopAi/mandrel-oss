import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 10000,
    setupFiles: ['./vitest.setup.ts'],
    // FLAKE-PROOFING: the DB-backed *.contract.test.ts files all run
    // against ONE shared CI Postgres (the CI gate provisions a single disposable
    // ci_* DB), and several integration tests boot a real server on a FIXED port.
    // Running test FILES in parallel forks therefore causes cross-file contention:
    // two files mutate/read the same tables in an overlapping window (order-dependent
    // flake — Reviewer hit it on the decision tests) and two server-boot files race
    // for the same port. Pin file execution to a SINGLE fork so files run one-at-a-time,
    // making the suite ORDER-INDEPENDENT and contention-free. `it`/`test` cases within a
    // file still run normally; only cross-FILE parallelism is removed. Runtime cost is
    // small (the suite is I/O-bound on the shared DB anyway, which serialized contention
    // was already throttling).
    fileParallelism: false,
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
