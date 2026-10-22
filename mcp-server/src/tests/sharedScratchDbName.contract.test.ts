/**
 * CONTRACT: no test file may pin a throwaway DATABASE or ROLE name as a literal.
 *
 * WHY THIS IS A THIRD GUARD AND NOT A WIDENING OF EITHER EXISTING ONE
 * -------------------------------------------------------------------
 * This repo already had a guard for fixed shared resources in tests
 * (`reservedTestPorts.contract.test.ts`) and it certified three consecutive instances of
 * the very class it exists for — 19097, 19098 and 19099 all sat OUTSIDE the fleet ranges
 * it scopes on, so every author who picked them was OBEYING it. A guard scoped on the
 * wrong axis does not merely miss a defect; it tells people the coast is clear.
 *
 * So the axis question is asked explicitly here rather than assumed. `hardcodedTestPorts`
 * scans for PORT literals; a database NAME contains no port digits, and that guard's own
 * `AXIS CHECK` test proves — executably, in the file that owns the detector — that it
 * returns clean on a shared-name literal. Neither existing guard sees this. Hence a third.
 *
 * WHAT IT GUARDS
 * --------------
 * Four OAuth integration tests each ended their DB resolution with a literal:
 *   process.env.X_DB_NAME || process.env.DATABASE_NAME || 'ci_better_auth_ba1'
 * so with DATABASE_NAME unset, every lane on the box silently shared ONE database. That is
 * strictly more dangerous than the port literal it sat beside: a port collision costs you a
 * failed run, while `scripts/provision-test-db.sh --drop` destroys BY NAME, runs as the
 * Postgres superuser, and 58 of the 67 copies of it under ~/projects carry no
 * ownership-stamp logic at all (measured 2026-08-26 — a stale copy dropped a stamped
 * foreign database, exit 0, no refusal). A shared name is the one path by which a stale
 * peer can reach a live lane's database.
 *
 * HOW IT ANCHORS
 * --------------
 * `provision-test-db.sh` REFUSES to create or drop any name that is not `ci_*`-prefixed
 * ("REFUSING: '<name>' is not ci_*-prefixed"). That refusal is the choke point: every
 * throwaway database and role in this repo, however it is spelled, is `ci_`-prefixed. So
 * the detector looks for a STATIC `ci_`-prefixed string literal, plus the `throwaway_`
 * password shape the same script derives. A name built by interpolation (`` `ci_${x}` ``)
 * is not matched — it is not a fixed shared value, which is the whole point.
 *
 * Comments are stripped first (helpers/testFileSweep.ts): a name in prose connects to
 * nothing, and the four files above deliberately keep a comment naming the literal they
 * deleted.
 *
 * WHAT THIS DOES NOT CLAIM: it cannot catch a name assembled to evade it
 * (`'ci_' + 'better_auth_ba1'`), and it says nothing about non-test source.
 *
 * ESCAPE HATCH, CO-LOCATED: `shared-scratch-ok: <reason>` on the SAME line.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { collectTestFiles, SCAN_ROOTS, stripComments } from './helpers/testFileSweep.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

const ANNOTATION = 'shared-scratch-ok:';

export interface SharedNameViolation {
  file: string;
  line: number;
  literal: string;
  why: string;
  text: string;
}

/**
 * The two shapes provision-test-db.sh mints. Each pattern's LAST capture group is the
 * literal, so the detector reads it uniformly and a new pattern cannot report the wrong
 * text. The quote must open AND close around a purely static body — an interpolation
 * makes the value per-run, which is the correct answer, not a violation.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `+`, not `*`: a BARE `'ci_'` is a prefix being concatenated onto a per-run suffix —
  // a building block, and the correct answer. Only a COMPLETE name is a pin.
  [/['"`](ci_[A-Za-z0-9_]+)['"`]/g, 'a throwaway database/role name pinned as a literal'],
  [/['"`](throwaway_[A-Za-z0-9_]+)['"`]/g, 'a derived throwaway password pinned as a literal'],
];

/** THE DETECTOR. Exported and called directly by the teeth tests — never re-declared. */
export function scanForSharedScratchNames(text: string, file = '<memory>'): SharedNameViolation[] {
  const violations: SharedNameViolation[] = [];
  const raw = text.split('\n');
  stripComments(text).split('\n').forEach((line, idx) => {
    if ((raw[idx] ?? '').includes(ANNOTATION)) return; // co-located, reviewed escape hatch
    for (const [re, why] of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        violations.push({ file, line: idx + 1, literal: m[m.length - 1], why, text: line.trim() });
      }
    }
  });
  return violations;
}

/**
 * Assert the sweep actually swept. A scan over ZERO files reports "no violations" and is
 * indistinguishable from a broken walk (CLASSES.md C3 — probe the empty population).
 */
export function assertSweptFileFloor(files: readonly string[], floor: number): void {
  if (files.length < floor) {
    throw new Error(
      `shared-scratch-name sweep covered ${files.length} test file(s), below the pinned ` +
        `floor of ${floor}. The sweep is not measuring what it claims — check SCAN_ROOTS ` +
        `(${SCAN_ROOTS.join(', ')}) before touching the floor.`
    );
  }
}

const SWEPT_FILE_FLOOR = 300;

describe('shared scratch DB names — a name is exclusive to a SERVER, and --drop destroys by name', () => {
  const files = SCAN_ROOTS.flatMap(r => collectTestFiles(resolve(REPO_ROOT, r)));

  test('the sweep actually covers the test tree (never vacuously green)', () => {
    expect(() => assertSweptFileFloor(files, SWEPT_FILE_FLOOR)).not.toThrow();
  });

  test('no test file pins a throwaway database or role name as a literal', () => {
    const violations = files.flatMap(f =>
      scanForSharedScratchNames(readFileSync(f, 'utf8'), relative(REPO_ROOT, f))
    );
    const rendered = violations.map(v => `  ${v.file}:${v.line}  ${v.literal}  ${v.why}\n      ${v.text}`);
    expect(
      violations,
      violations.length === 0
        ? ''
        : `Literal throwaway database/role name(s) found in test files. With DATABASE_NAME ` +
            `unset, every lane on the box shares this one database — and ` +
            `provision-test-db.sh --drop destroys BY NAME as the Postgres superuser, so a ` +
            `concurrent or stale lane can take it out from under you mid-suite.\n` +
            `${rendered.join('\n')}\n` +
            `Fix: requireScratchDb() from ./helpers/scratchTestDb.js — it throws rather than ` +
            `inventing a name. If the literal is genuinely not a database or role this ` +
            `suite touches, put "${ANNOTATION} <reason>" on the same line.`
    ).toEqual([]);
  });

  describe('teeth — the detector and its emptiness check both fail loudly', () => {
    test('THE REGRESSION IT EXISTS FOR: the exact pre-fix line goes RED', () => {
      // Verbatim from betterAuthOAuth.integration.test.ts:53 as it stood before this
      // change. Both the database name and the role name are separate violations.
      const preFix =
        "const SCRATCH_DB = process.env.BA1_DB_NAME || process.env.DATABASE_NAME || 'ci_better_auth_ba1';\n" + // shared-scratch-ok: fixture
        "const SCRATCH_USER = process.env.BA1_DB_USER || process.env.DATABASE_USER || 'ci_role_better_auth_ba1';\n" + // shared-scratch-ok: fixture
        "const SCRATCH_PASS = process.env.BA1_DB_PASS || 'throwaway_7320f4cd5b6e1346';\n"; // shared-scratch-ok: fixture
      const v = scanForSharedScratchNames(preFix, 'betterAuthOAuth.integration.test.ts');
      expect(v.map(x => [x.line, x.literal])).toEqual([
        [1, 'ci_better_auth_ba1'], // shared-scratch-ok: expectation
        [2, 'ci_role_better_auth_ba1'], // shared-scratch-ok: expectation
        [3, 'throwaway_7320f4cd5b6e1346'], // shared-scratch-ok: expectation
      ]);
    });

    test('the CORRECT answer is clean — the guard cannot forbid what it demands', () => {
      // requireScratchDb, and any per-run name, must never be flagged. If they were, the
      // guard would be unsatisfiable and would be deleted the first time it was awkward.
      expect(scanForSharedScratchNames("const SCRATCH = requireScratchDb('BA1');")).toEqual([]);
      expect(scanForSharedScratchNames('const SCRATCH_DB = SCRATCH.name;')).toEqual([]);
      expect(scanForSharedScratchNames('const db = process.env.DATABASE_NAME;')).toEqual([]);
      // an interpolated / per-run name is the right answer, not a violation
      expect(scanForSharedScratchNames('const db = `ci_${prefix}_${Date.now()}`;')).toEqual([]);
      // Clean by the PATTERN, not by an annotation — an annotated fixture here would
      // assert nothing at all. This is the concatenation gap the header states outright.
      expect(scanForSharedScratchNames("const db = 'ci_' + suffix;")).toEqual([]);
    });

    test('flags a role name and a password shape, not just a database name', () => {
      expect(scanForSharedScratchNames("user: 'ci_role_shared';").map(v => v.literal)) // shared-scratch-ok: fixture
        .toEqual(['ci_role_shared']); // shared-scratch-ok: expectation
      expect(scanForSharedScratchNames('password: "throwaway_abc123";').map(v => v.literal)) // shared-scratch-ok: fixture
        .toEqual(['throwaway_abc123']); // shared-scratch-ok: expectation
    });

    test('does not match an unrelated identifier that merely starts with the same letters', () => {
      expect(scanForSharedScratchNames("const s = 'circus';")).toEqual([]);
      expect(scanForSharedScratchNames("const s = 'cite_me';")).toEqual([]);
      expect(scanForSharedScratchNames("const s = 'throwawayish';")).toEqual([]);
    });

    test('comments are stripped — the four fixed files keep prose naming what they deleted', () => {
      expect(scanForSharedScratchNames("// here — 'ci_better_auth_ba1' / 'ci_role_better_auth_ba1' — gave")).toEqual([]);
      const multi = "/*\n * 'ci_better_auth_ba1'\n */\nconst db = 'ci_leftover';"; // shared-scratch-ok: fixture
      expect(scanForSharedScratchNames(multi).map(v => [v.line, v.literal])).toEqual([[4, 'ci_leftover']]); // shared-scratch-ok: expectation
    });

    test('a co-located annotation accounts for a genuine non-database use, its line only', () => {
      expect(scanForSharedScratchNames(`const s = 'ci_x'; // ${ANNOTATION} a label`)).toEqual([]); // shared-scratch-ok: fixture (the marker above is interpolated, so this line needs its own)
      const leaky = `// ${ANNOTATION} explained up here\nconst db = 'ci_x';`; // shared-scratch-ok: fixture
      expect(scanForSharedScratchNames(leaky)).toHaveLength(1);
    });

    test('PROBE THE PROBE: the floor check throws on an empty file set', () => {
      expect(() => assertSweptFileFloor([], SWEPT_FILE_FLOOR)).toThrow(/covered 0 test file/);
      expect(() => assertSweptFileFloor(['a.test.ts'], SWEPT_FILE_FLOOR)).toThrow(/below the pinned floor/);
      const enough = Array.from({ length: SWEPT_FILE_FLOOR }, (_, i) => `f${i}.test.ts`);
      expect(() => assertSweptFileFloor(enough, SWEPT_FILE_FLOOR)).not.toThrow();
    });

    test('PROBE THE PROBE: the floor is a positive number, not a no-op', () => {
      expect(SWEPT_FILE_FLOOR).toBeGreaterThan(0);
      expect(() => assertSweptFileFloor([], 0)).not.toThrow(); // proves 0 IS the no-op
    });
  });
});
