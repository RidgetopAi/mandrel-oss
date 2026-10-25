/**
 * CONTRACT: no test file may pin a TCP port as a LITERAL. Ports come from the OS.
 *
 * WHY THIS EXISTS, AND WHY THE SIBLING GUARD WAS NOT ENOUGH
 * --------------------------------------------------------
 * `reservedTestPorts.contract.test.ts` bans literals inside the ranges the tenant fleet
 * binds. That is a real rule and it is not this one. A port is exclusive to a HOST, not
 * to a range — so a literal can be perfectly correct about avoiding the fleet and still
 * collide, with ANOTHER COPY OF ITSELF.
 *
 * That is what happened, three times, all outside the reserved ranges and therefore all
 * invisible to the sibling guard:
 *   - 19098, shared by oauthDcrCapAndSignup + seedFirstOAuthUser (fixed in an earlier task)
 *   - 19099, oauthDcrRateLimitAndSignup
 *   - 19097, betterAuthOAuth — REPRODUCED 2026-08-26: two simultaneous
 *     runs, each with its own database so the port was the only shared resource; laneA
 *     11 passed, laneB died `Error: listen EADDRINUSE: address already in use :::19097`.
 *     Measured the same day: TEN sibling worktrees on the box carried that constant.
 *
 * It fails as an EADDRINUSE inside a beforeAll — i.e. as a hook timeout with the file's
 * tests SKIPPED, not as an assertion — so it reads as infrastructure noise and gets waved
 * through. Establishing that one such failure was NOT a real regression cost an Reviewer
 * five independent lines of evidence.
 *
 * WHY NOT "PICK A BIGGER NUMBER" OR "DERIVE ONE PER WORKTREE"
 * ----------------------------------------------------------
 * A bigger literal is the same bug with a later date. A per-worktree derivation is closer
 * but still wrong: two runs INSIDE one worktree share it again (that is the ordinary case
 * — a full-suite run and a single-file run at once), and it assumes every future lane
 * agrees on the derivation. The OS is the only allocator on the box that knows what is
 * actually free right now, and `listen(0)` is how you ask it. See
 * `helpers/ephemeralPort.ts` — including the ordering constraint that makes a bare
 * `listen(0)` insufficient on its own for the OAuth servers (the port must be known
 * BEFORE the transport freezes allowedHosts in its constructor).
 *
 * HOW IT ANCHORS
 * --------------
 * Comments are STRIPPED before scanning (helpers/testFileSweep.ts), and that is
 * deliberate rather than lazy: a port
 * named in prose binds nothing, and forcing annotations onto doc comments buys churn and
 * no safety. (Measured: stripping removes 4 `DATABASE_PORT=15432` doc-comment lines that
 * are pure documentation.) Blank-preserving strip keeps line numbers exact so a violation
 * is reported at its real line.
 *
 * Then three spellings of "a literal port" in CODE:
 *   1. a port-named identifier initialised to a numeric literal — `TEST_PORT = 19097`,
 *      `port: 5432`, `MANDREL_AIDIS_MCP_PORT: '19097'`
 *   2. `.listen(<literal>)`
 *   3. a literal authority in a URL — `http://127.0.0.1:19097/mcp`
 *
 * `listen(0)` and `PORT = 0` are CLEAN by construction: anything below 1024 is ignored,
 * so the correct answer can never be flagged by the guard that demands it.
 *
 * WHAT THIS DOES NOT CLAIM: it cannot catch a port assembled to evade it (`19000 + 97`),
 * and it does not police non-test source. It matches the three spellings above; a bind
 * reached some fourth way is not covered, and this file does not pretend otherwise.
 *
 * ESCAPE HATCH, CO-LOCATED: `fixed-port-ok: <reason>` on the SAME line.
 * Co-located rather than a central registry, so forgetting it is a RED in the same
 * reviewed diff instead of a silent omission somewhere else.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { collectTestFiles, SCAN_ROOTS, stripComments } from './helpers/testFileSweep.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * Markers that account for a literal that is genuinely not a port this suite uses.
 *
 * BOTH spellings are honoured, and that is a single-source decision rather than sloppiness:
 * `reservedTestPorts.contract.test.ts` already asks an annotation the SAME question — "is
 * this number a port this suite actually uses?" — so one honest annotation answers both
 * guards. Requiring a second marker beside every existing one would have bought a
 * double-annotation diff across five files and no additional safety, while giving the two
 * hatches room to drift out of agreement. `fixed-port-ok:` is the spelling to use for new
 * code; `reserved-port-ok:` is accepted because it already means this.
 */
const ANNOTATIONS = ['fixed-port-ok:', 'reserved-port-ok:'] as const;
const ANNOTATION = ANNOTATIONS[0];

/**
 * Below this, a literal is not a port a test can be pinning by accident — and, more
 * importantly, it is where the CORRECT answers live: `listen(0)` / `PORT = 0` must be
 * clean, or the guard would forbid the very thing it demands (CLASSES.md C3: when you
 * widen a population, check what you just made illegal).
 */
const MIN_PORT = 1024; // fixed-port-ok: this guard's own floor, binds nothing

export interface FixedPortViolation {
  file: string;
  line: number;
  port: number;
  why: string;
  text: string;
}

/**
 * The three spellings. Each capture group ends with the port digits, so the detector
 * reads `m[m.length - 1]` uniformly and a new pattern cannot silently report the wrong
 * number.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // The leading `[\w$]*` is OPTIONAL on purpose: a bare `port: 5432` is the commonest
  // spelling of all, and requiring a prefix character silently exempted it.
  [/(?<![\w$.])[\w$]*[Pp][Oo][Rr][Tt][\w$]*\s*[=:]\s*['"`]?(\d{2,5})['"`]?(?![\w.])/g,
   'a port-named identifier pinned to a literal'],
  [/\.listen\(\s*['"`]?(\d{2,5})['"`]?(?![\w.])/g, 'listen() called with a literal port'],
  [/:\/\/[A-Za-z0-9_.-]+:(\d{2,5})(?![\w.])/g, 'a literal port in a URL authority'],
];

/** THE DETECTOR. Exported and called directly by the teeth tests — never re-declared. */
export function scanForFixedPorts(text: string, file = '<memory>'): FixedPortViolation[] {
  const violations: FixedPortViolation[] = [];
  // The annotation is read from the RAW line and the digits from the STRIPPED one. They
  // have to be two reads: the hatch lives IN a comment, so checking it after stripping
  // would delete every escape hatch in the repo and the guard would be unsatisfiable.
  // (It was written that way first; the sibling guard's two annotated fixture lines went
  // RED and said so.) stripComments is blank-preserving, so the two arrays line up index
  // for index — asserted by the line-number teeth test below.
  const raw = text.split('\n');
  stripComments(text).split('\n').forEach((line, idx) => {
    const rawLine = raw[idx] ?? '';
    if (ANNOTATIONS.some(a => rawLine.includes(a))) return; // co-located, reviewed escape hatch
    for (const [re, why] of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const port = Number(m[m.length - 1]);
        if (port < MIN_PORT) continue;
        violations.push({ file, line: idx + 1, port, why, text: line.trim() });
      }
    }
  });
  return violations;
}

/**
 * Assert the sweep actually swept. A scan over ZERO files reports "no violations" and is
 * indistinguishable from a broken walk (CLASSES.md C3: probe the empty population).
 * Floor pinned well below the 519 test files measured across the scan roots when this
 * landed (`node` walk over mcp-server/src + mandrel-command, 2026-08-26), so ordinary
 * churn never trips it while a roots-are-broken regression cannot be silent.
 */
export function assertSweptFileFloor(files: readonly string[], floor: number): void {
  if (files.length < floor) {
    throw new Error(
      `fixed-port sweep covered ${files.length} test file(s), below the pinned floor of ` +
        `${floor}. The sweep is not measuring what it claims — check SCAN_ROOTS ` +
        `(${SCAN_ROOTS.join(', ')}) before touching the floor.`
    );
  }
}

const SWEPT_FILE_FLOOR = 300;

describe('hardcoded test ports — a port is exclusive to a HOST, not to a range', () => {
  const files = SCAN_ROOTS.flatMap(r => collectTestFiles(resolve(REPO_ROOT, r)));

  test('the sweep actually covers the test tree (never vacuously green)', () => {
    expect(() => assertSweptFileFloor(files, SWEPT_FILE_FLOOR)).not.toThrow();
  });

  test('no test file pins a TCP port as a literal', () => {
    const violations = files.flatMap(f =>
      scanForFixedPorts(readFileSync(f, 'utf8'), relative(REPO_ROOT, f))
    );
    const rendered = violations.map(v => `  ${v.file}:${v.line}  port ${v.port}  ${v.why}\n      ${v.text}`);
    expect(
      violations,
      violations.length === 0
        ? ''
        : `Literal TCP port(s) found in test files. Two simultaneous runs of the same file ` +
            `— the ordinary parallel-worktree case — race for it, and the loser dies with ` +
            `EADDRINUSE inside a hook, which reads as infrastructure noise rather than as a ` +
            `failure.\n${rendered.join('\n')}\n` +
            `Fix: await reserveEphemeralPort() from ./helpers/ephemeralPort.js and derive ` +
            `every issuer/allowed-host/URL from it. If the literal is genuinely not a port ` +
            `this suite uses, put "${ANNOTATION} <reason>" on the same line.`
    ).toEqual([]);
  });

  describe('teeth — the detector and its emptiness check both fail loudly', () => {
    test('flags a literal port however it is spelled', () => {
      const assignment = scanForFixedPorts('const TEST_PORT = 19097;'); // fixed-port-ok: fixture/expectation, binds nothing
      const envStub = scanForFixedPorts("MANDREL_AIDIS_MCP_PORT: '19099',"); // fixed-port-ok: fixture/expectation, binds nothing
      const listenCall = scanForFixedPorts('server.listen(19098);'); // fixed-port-ok: fixture/expectation, binds nothing
      const url = scanForFixedPorts('const ISSUER = "http://127.0.0.1:19097";'); // fixed-port-ok: fixture/expectation, binds nothing
      const poolOpt = scanForFixedPorts('new Pool({ port: 5432 })'); // fixed-port-ok: fixture/expectation, binds nothing
      for (const v of [assignment, envStub, listenCall, url, poolOpt]) expect(v).toHaveLength(1);
      expect(assignment[0].port).toBe(19097); // fixed-port-ok: fixture/expectation, binds nothing
      expect(envStub[0].port).toBe(19099); // fixed-port-ok: fixture/expectation, binds nothing
      expect(listenCall[0].port).toBe(19098); // fixed-port-ok: fixture/expectation, binds nothing
      expect(url[0].port).toBe(19097); // fixed-port-ok: fixture/expectation, binds nothing
      expect(poolOpt[0].port).toBe(5432); // fixed-port-ok: fixture/expectation, binds nothing
    });

    test('THE REGRESSION IT EXISTS FOR: the exact pre-fix line goes RED', () => {
      // Verbatim from betterAuthOAuth.integration.test.ts:58 as it stood before an earlier task
      // , including the comment that accompanied it — which was accurate about
      // the reserved ranges and prevented nothing.
      const preFix = // fixed-port-ok: fixture/expectation, binds nothing
        "// 19097: deliberately OUTSIDE the live fleet's docker-proxy port ranges\n" +
        'const TEST_PORT = 19097;\n' + // fixed-port-ok: fixture/expectation, binds nothing
        'const ISSUER = `http://127.0.0.1:${TEST_PORT}`;\n';
      const v = scanForFixedPorts(preFix, 'betterAuthOAuth.integration.test.ts');
      expect(v.map(x => [x.line, x.port])).toEqual([[2, 19097]]); // fixed-port-ok: fixture/expectation, binds nothing
    });

    test('the CORRECT answer is clean — the guard cannot forbid what it demands', () => {
      // listen(0) / port 0 / an OS-assigned variable are the prescribed fix. If any of
      // these were flagged, the guard would be unsatisfiable and would get deleted.
      expect(scanForFixedPorts('probe.listen(0, () => {});')).toEqual([]);
      expect(scanForFixedPorts('let TEST_PORT: number;')).toEqual([]);
      expect(scanForFixedPorts('TEST_PORT = await reserveEphemeralPort();')).toEqual([]);
      expect(scanForFixedPorts('const ISSUER = `http://127.0.0.1:${TEST_PORT}`;')).toEqual([]);
      expect(scanForFixedPorts("MANDREL_AIDIS_MCP_PORT: String(TEST_PORT),")).toEqual([]);
      // …and privileged/low numbers are out of scope by MIN_PORT, not by luck.
      expect(scanForFixedPorts('const PORT = 80;')).toEqual([]);
      expect(scanForFixedPorts('const PORT = 1023;')).toEqual([]); // fixed-port-ok: fixture/expectation, binds nothing
      expect(scanForFixedPorts('const PORT = 1024;').map(v => v.port)).toEqual([1024]); // fixed-port-ok: fixture/expectation, binds nothing
    });

    test('comments are stripped, and stripping preserves line numbers exactly', () => {
      expect(scanForFixedPorts('// const TEST_PORT = 19097;')).toEqual([]); // fixed-port-ok: fixture/expectation, binds nothing
      // …but a URL scheme's `//` is NOT a comment, or the URL pattern could never fire.
      expect(stripComments('u = "http://h:19097/x"; // note')).toBe('u = "http://h:19097/x";        '); // fixed-port-ok: fixture/expectation, binds nothing
      expect(scanForFixedPorts('/* DATABASE_PORT=15432 */')).toEqual([]); // fixed-port-ok: fixture/expectation, binds nothing
      const multi = '/*\n * DATABASE_PORT=15432\n */\nconst TEST_PORT = 19097;'; // fixed-port-ok: fixture/expectation, binds nothing
      expect(scanForFixedPorts(multi).map(v => [v.line, v.port])).toEqual([[4, 19097]]); // fixed-port-ok: fixture/expectation, binds nothing
      expect(stripComments('a\n//x\nb').split('\n')).toHaveLength(3);
    });

    test('a co-located annotation accounts for a genuine non-port use, its line only', () => {
      expect(scanForFixedPorts(`const n = 19097; // ${ANNOTATION} a sample count`)).toEqual([]);
      // the sibling guard's marker answers the same question and is accepted as-is
      expect(scanForFixedPorts('const TEST_PORT = 19097; // reserved-port-ok: fixture')).toEqual([]); // fixed-port-ok: fixture/expectation, binds nothing
      const leaky = `// ${ANNOTATION} explained up here\nconst TEST_PORT = 19097;`;
      expect(scanForFixedPorts(leaky)).toHaveLength(1);
    });

    test('does not match a port embedded in a longer number or identifier', () => {
      expect(scanForFixedPorts('const PORT = 119097; const x = PORT_A.b;')).toEqual([]); // fixed-port-ok: fixture/expectation, binds nothing
      expect(scanForFixedPorts('const importantly = 5;')).toEqual([]);
    });

    test('AXIS CHECK: this guard does NOT see a shared scratch-DB NAME — a third question', () => {
      // Recorded executably, not as prose, because of what happened to the sibling
      // reserved-range guard: it was assumed to cover fixed ports generally, and instead
      // CERTIFIED three collisions that sat outside its ranges. So before adding
      // sharedScratchDbName.contract.test.ts, the claim "the port axis does not reach a
      // database name" was proved rather than assumed. If someone later widens this
      // detector to cover names, this test goes RED and forces the two scopes to be
      // reconciled deliberately instead of silently overlapping.
      expect(scanForFixedPorts("const SCRATCH_DB = process.env.DATABASE_NAME || 'ci_better_auth_ba1';")).toEqual([]); // shared-scratch-ok: fixture for the sibling guard's axis check; names no database this suite touches
      expect(scanForFixedPorts("const SCRATCH_USER = 'ci_role_better_auth_ba1';")).toEqual([]); // shared-scratch-ok: fixture for the sibling guard's axis check; names no database this suite touches
    });

    test('PROBE THE PROBE: the floor check throws on an empty file set', () => {
      expect(() => assertSweptFileFloor([], SWEPT_FILE_FLOOR)).toThrow(/covered 0 test file/);
      expect(() => assertSweptFileFloor(['a.test.ts'], SWEPT_FILE_FLOOR)).toThrow(
        /below the pinned floor/
      );
      const enough = Array.from({ length: SWEPT_FILE_FLOOR }, (_, i) => `f${i}.test.ts`);
      expect(() => assertSweptFileFloor(enough, SWEPT_FILE_FLOOR)).not.toThrow();
    });

    test('PROBE THE PROBE: the floor is a positive number, not a no-op', () => {
      expect(SWEPT_FILE_FLOOR).toBeGreaterThan(0);
      expect(() => assertSweptFileFloor([], 0)).not.toThrow(); // proves 0 IS the no-op
    });
  });
});
