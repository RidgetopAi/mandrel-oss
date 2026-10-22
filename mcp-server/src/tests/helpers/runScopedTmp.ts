/**
 * runScopedTmp — the ONE way a test names a file in the temp namespace.
 *
 * WHY THIS FILE EXISTS (measured, 2026-08-01/02)
 *   Two overlapping `scripts/ci-clean-gate.sh` runs fabricated a RED on a healthy ref,
 *   repeatedly. One of the reasons was tests naming FIXED absolute paths in the shared
 *   temp namespace — six suites pinned `/tmp/mandrel-<name>-port-registry.json` — so two
 *   concurrent runs read and wrote each other's file. `/tmp` on the gate box is a single
 *   12G tmpfs shared by everything on it; a hardcoded path there is a global variable
 *   with no owner.
 *
 * WHAT IT DOES
 *   Resolves under `os.tmpdir()`, which honours $TMPDIR. ci-clean-gate.sh now EXPORTS a
 *   per-run TMPDIR inside its throwaway worktree parent, so every path built here is
 *   automatically private to one gate run and is deleted with it. Nothing else is
 *   required of the caller, which is the point: the safe form has to be the easy one or
 *   it does not get used.
 *
 * THE HONEST SCOPE
 *   This gives per-RUN isolation, not per-FILE isolation. Two suites inside the SAME run
 *   that ask for the same name still share a file — deliberately: the port registry is
 *   meant to be shared within a run so suites do not collide on ports. If you need a path
 *   nobody else can touch at all, pass `unique: true` and get a per-process suffix.
 *
 * ENFORCEMENT
 *   scripts/test/shared-namespace-guard.test.sh REDs on a test file that writes a literal
 *   '/tmp/...' path, so the rule cannot be un-learned by the next test.
 */

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A path in THIS RUN's temp directory.
 *
 * @param name  the basename, e.g. 'mandrel-ba1-port-registry.json'
 * @param opts.unique  also mix in the pid, for a path no other process can collide with
 */
export function runScopedTmpPath(name: string, opts: { unique?: boolean } = {}): string {
  if (!name || name.includes('/')) {
    // Fail loudly rather than silently producing something outside the run's tmpdir —
    // a '../' here would put the file straight back in the shared namespace.
    throw new Error(`runScopedTmpPath: expected a bare basename, got '${name}'`);
  }
  const base = opts.unique ? `${process.pid}-${name}` : name;
  return path.join(os.tmpdir(), base);
}
