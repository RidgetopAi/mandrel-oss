/**
 * NO NUL BYTE IN A TRACKED TEXT FILE — contract test (folded in
 * from lane M-7).
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────────────────────
 * A NUL byte was shipped inside a TypeScript file. Git treats a blob containing a NUL as
 * BINARY, so `git diff` printed `Binary files a/… and b/… differ` and the change became
 * UNREVIEWABLE — a script carrying a live UPDATE statement reached review with its
 * contents hidden. Nothing caught it: the file still parsed, tsc was happy, and gitleaks
 * looks for secret SHAPES, which a binary blob does not present.
 *
 * The damage is not the character. It is that the review surface silently stopped showing
 * the diff, so the guard that catches everything else — a human reading the change — was
 * switched off with no signal at all.
 *
 * ── WHY THE RULE LIVES IN A SHELL SCRIPT AND THIS FILE ONLY DRIVES IT ────────────────
 * `scripts/check-no-nul-bytes.sh` is the single copy of the predicate and the population.
 * Two triggers run that one file:
 *   - `hooks/pre-commit --staged` — blocks the byte BEFORE it becomes history, which is
 *     the only place the review problem can actually be prevented;
 *   - this test — the whole repo, riding the gate's vitest stage, where it cannot be
 *     skipped with `--no-verify` or by a clone that never ran `npm install`.
 * Re-implementing the scan in TypeScript would be a second copy of a rule, which is how a
 * rule gets weakened in one place while the other keeps reporting success.
 *
 * ── NON-VACUITY ──────────────────────────────────────────────────────────────────────
 * The steady state is zero offenders, so "it found one" can never be this guard's
 * liveness proof. Three things carry it instead: the script exits 2 rather than 0 on an
 * empty population, it self-checks its own predicate against a synthetic NUL before
 * trusting it, and the tests below assert the scanned COUNT is non-trivial and that a
 * planted NUL is actually detected and NAMED.
 */

import { describe, test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** repo root — this file is at `<repo>/mcp-server/src/tests/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-no-nul-bytes.sh');

/** Minimum tracked text files we expect. Deliberately far below the real count (~2,000): */
/* this asserts the population is not EMPTY or truncated, not that the repo is a size.   */
const MIN_POPULATION = 200;

function runScan(cwd: string): { status: number; out: string } {
  const r = spawnSync('bash', [SCRIPT], { cwd, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('no NUL byte in any tracked text file', () => {
  test('the real repository is CLEAN, and a non-trivial population was scanned', () => {
    const { status, out } = runScan(REPO_ROOT);
    // The offender list is printed by the script, so a failure here names the files
    // rather than saying only that a number was wrong.
    expect(out).not.toContain('BLOCKED');
    expect(status).toBe(0);

    // The count, from the script's own success line — a scan over nothing would report
    // the same GREEN. (The script also exits 2 on an empty population; this is the
    // belt to that braces, and it is what notices a population that merely SHRANK.)
    const m = out.match(/(\d+) tracked text file\(s\) scanned/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(MIN_POPULATION);
  });

  test('a PLANTED NUL is detected and the offending file is NAMED', () => {
    // The mutation, run against a throwaway repo so the real tree is never mutated and
    // this test cannot leave debris behind if it fails mid-way. A synthetic repo is the
    // right subject here precisely because the predicate is `git ls-files`-shaped: the
    // thing under test is "does the script notice a NUL in a tracked text file", and a
    // two-file repo answers that as well as a two-thousand-file one.
    const dir = mkdtempSync(path.join(tmpdir(), 'nulguard-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'nul guard test');
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, 'src', 'clean.ts'), 'export const ok = 1;\n');
      // Enough files to clear the script's empty-population floor is not required — the
      // floor is "> 0" in the script; MIN_POPULATION above applies to the real repo only.
      writeFileSync(path.join(dir, 'src', 'dirty.ts'), Buffer.from('export const bad = "a\0b";\n'));
      git('add', '-A');

      const { status, out } = runScan(dir);
      expect(status).toBe(1); // RED, and specifically RED — not 2 (could-not-measure)
      expect(out).toContain('BLOCKED');
      expect(out).toContain('src/dirty.ts');
      // SPECIFICITY: the clean sibling must NOT be named. A scanner that flags the whole
      // directory would satisfy the assertion above and be useless.
      expect(out).not.toContain('src/clean.ts');

      // THE CONTROL that makes the RED mean something: remove the byte, nothing else
      // changes, and the same script on the same repo goes GREEN.
      writeFileSync(path.join(dir, 'src', 'dirty.ts'), 'export const bad = "ab";\n');
      git('add', '-A');
      const after = runScan(dir);
      expect(after.status).toBe(0);
      expect(after.out).not.toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an ESCAPED NUL is legal — the guard forbids the raw byte, not the value zero', () => {
    // This is what keeps the guard from being deleted the first time it is inconvenient.
    // Both real pre-existing offenders it found on the base ref were CORRECT code (a test
    // feeding a NUL username; a NUL-prefixed sentinel that no env var can collide with),
    // and both are still expressed — as '\u0000'. If this went RED, the guard would be
    // banning legitimate work and would need deleting rather than exempting.
    const dir = mkdtempSync(path.join(tmpdir(), 'nulguard-esc-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'nul guard test');
      // The literal two-character escape, not a NUL: written via an escaped backslash so
      // this source file itself contains no NUL (which this very guard would flag).
      writeFileSync(path.join(dir, 'sentinel.ts'), 'export const S = "\\u0000UNSET";\n');
      git('add', '-A');

      const { status, out } = runScan(dir);
      expect(status).toBe(0);
      expect(out).not.toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
