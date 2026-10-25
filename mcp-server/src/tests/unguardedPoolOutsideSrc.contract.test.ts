// GUARDS-CLASS: unguarded-pg-pool
/**
 * NO UNGUARDED pg POOL OUTSIDE `src/` — contract test (tightened by an earlier change).
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * `datastoreErrorBoundary.contract.test.ts` §4 is the choke point that makes the P0 fix
 * (an earlier task — a pool must survive a Postgres bounce) complete: it asserts that every
 * pg Pool constructed under `mcp-server/src/` passes through `guardPool()`. It states its
 * own scope honestly, and that scope is `src/`.
 *
 * That is honest narrowness, not a hollow guard — but it left a blind region: legacy
 * operational scripts sat in the PACKAGE ROOT, outside `src/`, each constructing a bare
 * `new Pool(`. No guard could see them because no guard's population included them. They
 * were deleted (nothing referenced them), which shrinks the population rather than widening
 * a guard. This file is what makes that deletion durable: it names the population §4 does
 * NOT enumerate — everything in this package that is not `src/` — and fails if a pg Pool
 * appears there again.
 *
 * THERE IS NO ALLOWLIST, AND THAT IS THE POINT
 * ------------------------------------------------------
 * The first version of this guard shipped GREEN while four more files of the identical
 * class were still on disk, because it listed them by name as accepted debt. A named
 * exception is an off switch: the next author to add an offending file appends a line and
 * the guard keeps reporting success. So this guard has no exception mechanism of any kind —
 * it is structurally incapable of accepting one. An offender is fixed (`guardPool(new
 * Pool(`) or deleted. Nothing else passes.
 *
 * THE POPULATION THIS GUARD ENUMERATES, STATED PRECISELY (CLASSES.md C3)
 * ---------------------------------------------------------------------
 * Every `.ts` / `.mts` / `.cts` / `.js` / `.mjs` / `.cjs` file under `mcp-server/`,
 * RECURSIVELY, EXCLUDING:
 *   - `src/`        — enumerated by datastoreErrorBoundary §4, which is stricter (it also
 *                     checks value-imports of `Pool`). Two guards, disjoint scopes, no gap
 *                     between them: `src/` ∪ (everything else) is the whole package.
 *   - `node_modules/`, `dist/`, `coverage/`, `.git/` — not our source.
 * There is NO hand-written file list and no directory the author happened to be working in.
 *
 * NON-VACUITY. A scanner over an empty population reports the same GREEN as a clean repo,
 * and the expected steady state here IS zero pools outside `src/` — so "it found an
 * offender" can never be this guard's liveness proof. Two assertions carry it instead:
 * the walk must find a non-trivial file population, and the predicate itself is exercised
 * against synthetic positive/negative sources so a predicate that stopped matching anything
 * goes RED on its own.
 *
 * WHAT THIS GUARD MATCHES: a literal `new Pool(` occurrence, with `//` line comments
 * stripped first. It is the same textual predicate §4 uses for its (a) check. It does not
 * attempt to be exhaustive against an adversary — §4's own header records three spellings
 * that got past textual matching — and no claim is made here about what an evader cannot
 * do. Its job is to stop the ORDINARY reappearance: someone drops another operational
 * script in the package root, writes `new Pool(`, and no guard notices.
 */

import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** `mcp-server/` — this file is at `mcp-server/src/tests/`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(PACKAGE_ROOT, 'src') + path.sep;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'src']);
const CODE_EXT = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && CODE_EXT.includes(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/**
 * The predicate, isolated so it can be exercised on synthetic sources. Returns one
 * `line-number: text` entry per UNGUARDED construction. `//` comments are stripped first —
 * this file's own prose says `new Pool(`, and a comment is not a construction.
 */
function unguardedPoolLines(source: string): string[] {
  const hits: string[] = [];
  source.split('\n').forEach((rawLine, i) => {
    const line = rawLine.replace(/\/\/.*$/, '');
    if (!line.includes('new Pool(')) return;
    if (/guardPool\(\s*new Pool\(/.test(line)) return;
    hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

describe('no unguarded pg Pool outside mcp-server/src', () => {
  const files = walk(PACKAGE_ROOT);

  test('the walk found a real population and never reaches into src/ (an empty scan must FAIL)', () => {
    expect(
      files.length,
      'the non-src walk found (almost) no code files — this guard would be inert'
    ).toBeGreaterThan(10);
    // Disjointness from §4's population, asserted rather than asserted-about.
    expect(files.filter((f) => f.startsWith(SRC))).toEqual([]);
  });

  test('the predicate can still tell an unguarded pool from a guarded one (non-vacuity)', () => {
    // Liveness of the DETECTOR, independent of whether the repo currently has an offender.
    // Without this, a predicate that matched nothing would pass forever over a clean tree.
    expect(unguardedPoolLines('const db = new Pool({ host: "x" });')).toHaveLength(1);
    expect(unguardedPoolLines('const db = guardPool(new Pool({ host: "x" }));')).toEqual([]);
    expect(unguardedPoolLines('// const db = new Pool({});')).toEqual([]);
    expect(unguardedPoolLines('const db = makeThing();')).toEqual([]);
  });

  test('files deleted for this class are GONE and have not come back', () => {
    for (const gone of [
      'mandrel-essential.ts',
      'mandrel-progressive.ts',
      'export-contexts.ts',
      'map-existing-vectors.ts',
      'test-db-env.ts',
      'test-db-debug.ts',
      'test-db-simple.ts',
      'test-db-postgres.ts',
    ]) {
      expect(fs.existsSync(path.join(PACKAGE_ROOT, gone)), `${gone} is back`).toBe(false);
    }
  });

  test('every `new Pool(` outside src/ is guarded — no exceptions exist', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(PACKAGE_ROOT, f);
      for (const hit of unguardedPoolLines(fs.readFileSync(f, 'utf8'))) {
        offenders.push(`${rel}:${hit}`);
      }
    }
    expect(
      offenders,
      `UNGUARDED pg Pool(s) outside mcp-server/src. Fix with guardPool(new Pool(...)) or ` +
        `delete the file — this guard has no allowlist:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
