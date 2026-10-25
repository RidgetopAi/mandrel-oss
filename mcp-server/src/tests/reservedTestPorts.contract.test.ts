/**
 * CONTRACT: no test file may hardcode a port inside a range the tenant fleet binds.
 *
 * NOTE ON THIS FILE'S OWN NUMBERS: this guard is subject to itself — it is NOT excluded
 * from its own sweep, because a self-exemption is exactly the hole these lessons keep
 * biting us on. Every reserved-range number below therefore carries the same co-located
 * `reserved-port-ok:` annotation any other test file would need.
 *
 * WHY THIS EXISTS
 * ---------------
 * `projectScopeChokePoint.contract.test.ts` pinned a fixed test port in the tenant block.
 * On the control host dev box there is no Docker fleet, so it bound fine and every local run was
 * green. On the prod prod box a tenant container's docker-proxy already holds that
 * port, so the same test threw EADDRINUSE inside a beforeAll hook — which surfaced as a
 * 10s hook timeout and FAIL-CLOSED aborted a prod fleet deploy at the clean gate.
 *
 * The rule already existed. `betterAuthOAuth.integration.test.ts` carried an accurate
 * comment naming these exact ranges. It prevented nothing, because **a comment is not a
 * guard**: nothing forces a later author to read it, and the box where the
 * rule matters is not the box where tests get written. So the rule is now executable.
 *
 * HOW IT ANCHORS (a past incident — deny-by-default, not an allow-list)
 * ----------------------------------------------------------------
 * The naive guard greps for `TEST_PORT = <n>` or `listen(<n>)`. Both are SHAPES, and both
 * would have MISSED the very bug that motivated this file: the offending test never
 * called `listen` with a port at all — it stubbed `MANDREL_AIDIS_MCP_PORT` and let the
 * product bind. A guard built around the shapes the author had in mind is the allow-list
 * they were trying to kill.
 *
 * The choke point every instance must pass through is THE DIGITS. However a test causes a
 * bind — a literal, an env stub, a template string, a URL, a string-parsed number — the
 * reserved port appears as digits in the file's text. So we scan raw text for any integer
 * in a reserved range and require EVERY occurrence to be accounted for. Unrecognised
 * occurrence => RED naming file:line. We deliberately do NOT try to decide "is this number
 * really a port?" — that judgement call is precisely where a silent pass would live.
 *
 * ESCAPE HATCH, CO-LOCATED: a genuine non-port use carries
 * `reserved-port-ok: <reason>` on the SAME line. Co-located, not a central registry: a
 * central list is remembered elsewhere and forgetting it is silent, whereas forgetting an
 * annotation is a RED that lands in the same reviewed diff. The only way through is a
 * deliberately dishonest annotation, which is a reviewer's job to catch, not a test's.
 *
 * WHAT THIS DOES NOT CLAIM: it cannot catch a port assembled to evade it (`17999 + 100`),
 * and it does not police non-reserved ports — 11111, 12345, 18000, 13753 and 19097 stay
 * exactly as they are, outside the fleet's ranges and none of this guard's business.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

import { collectTestFiles, SCAN_ROOTS } from './helpers/testFileSweep.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * The ranges the tenant fleet binds on the prod box, PINNED AS LITERALS with the reason
 * co-located (a past incident rule 8: a guard that derives its constant from the product cannot
 * detect a change to that constant). `pins the reserved ranges` below asserts these exact
 * values, so widening or narrowing this table is a two-place diff — a decision, not drift.
 *
 * MEASURED on prod with `ss -lntp` (2026-07-27), not assumed. The fleet's docker-proxy
 * processes hold four blocks; the two enforced here are the redis block and the mcp-http
 * block. reserved-port-ok: the table below states them as data, and binds nothing.
 */
const RESERVED_PORT_RANGES: ReadonlyArray<{
  readonly from: number;
  readonly to: number;
  readonly why: string;
}> = [
  // PROD'S OWN BINDS, pinned as singletons (2026-08-04): a test binding one
  // of these reproduces this guard's motivating failure VERBATIM — green on the dev box,
  // EADDRINUSE against the prod listener on the prod box. 8080 = mcp-server (host net), // reserved-port-ok: comment naming the pin
  // 5000 = command-backend (host net), 12000 = command-frontend's loopback publish in // reserved-port-ok: comment naming the pins
  // docker-compose.prod file (127.0.0.1:12000:3000). // reserved-port-ok: comment naming the pin
  { from: 5000, to: 5000, why: 'prod command-backend bind (network_mode: host)' }, // reserved-port-ok: singleton pin, not a bind
  { from: 8080, to: 8080, why: 'prod mcp-server bind (network_mode: host)' }, // reserved-port-ok: singleton pin, not a bind
  { from: 12000, to: 12000, why: 'prod command-frontend host publish' }, // reserved-port-ok: singleton pin, not a bind
  { from: 16000, to: 16999, why: 'tenant redis; whole block reserved' }, // reserved-port-ok: range bound, not a bind
  { from: 18080, to: 18099, why: 'tenant mcp http; block fully populated' }, // reserved-port-ok: range bound, not a bind
];

/** Marker that accounts for a reserved-range number that is NOT a port this suite binds. */
const ANNOTATION = 'reserved-port-ok:';

export interface PortViolation {
  file: string;
  line: number;
  port: number;
  text: string;
}

function isReserved(port: number): boolean {
  return RESERVED_PORT_RANGES.some(r => port >= r.from && port <= r.to);
}

/**
 * THE DETECTOR. Scans raw text for integers in a reserved range and reports every
 * occurrence not accounted for by a co-located annotation.
 *
 * Exported and called directly by the teeth tests below. A teeth test that re-declared
 * this regex inline would leave the real detector freely regressable with every test still
 * green — the exact defect a past incident catalogues.
 */
export function scanForReservedPorts(text: string, file = '<memory>'): PortViolation[] {
  const violations: PortViolation[] = [];
  text.split('\n').forEach((line, idx) => {
    if (line.includes(ANNOTATION)) return; // co-located, reviewed escape hatch
    // Digit runs with boundaries that reject a number embedded in a longer number or
    // identifier, so a bigger integer or a decimal does not masquerade as a port.
    for (const m of line.matchAll(/(?<![\w.])(\d{4,5})(?![\w.])/g)) {
      const port = Number(m[1]);
      if (isReserved(port)) violations.push({ file, line: idx + 1, port, text: line.trim() });
    }
  });
  return violations;
}

/**
 * Assert a sweep actually swept something.
 *
 * WHY THIS IS A SEPARATE, EXPORTED FUNCTION: a coverage check over ZERO files passes
 * vacuously — if a scan root is renamed or the walk silently throws, "no violations found"
 * is indistinguishable from "nothing was looked at". So the emptiness check is something
 * the tests can CALL with a hostile input, rather than a condition that only ever sees the
 * happy path (a past incident rule 7: mutation-probe the PROBE; zero/empty/absent are the
 * values that slip through).
 */
export function assertSweptFileFloor(files: readonly string[], floor: number): void {
  if (files.length < floor) {
    throw new Error(
      `reserved-port sweep covered ${files.length} test file(s), below the pinned floor of ` +
        `${floor}. The sweep is not measuring what it claims — check SCAN_ROOTS ` +
        `(${SCAN_ROOTS.join(', ')}) before touching the floor.`
    );
  }
}

/**
 * Pinned floor. The repo had 315 test files across the scan roots when this guard landed
 * (169 under mcp-server/src + 146 under mandrel-command). Pinned well below that so
 * ordinary churn never trips it, while a roots-are-broken regression cannot be silent.
 */
const SWEPT_FILE_FLOOR = 200;

describe('reserved test ports — the fleet-bound ranges are a guard, not a comment', () => {
  const files = SCAN_ROOTS.flatMap(r => collectTestFiles(resolve(REPO_ROOT, r)));

  test('pins the reserved ranges as literals, so changing them is a decision', () => {
    // Asserted literally rather than derived from the table: a guard that reads its own
    // constant back would widen in lockstep with whoever edited it and detect nothing.
    // reserved-port-ok: pinned expectation, not a bind.
    expect(RESERVED_PORT_RANGES.map(r => [r.from, r.to])).toEqual([
      [5000, 5000], // reserved-port-ok: pinned singleton (prod command-backend)
      [8080, 8080], // reserved-port-ok: pinned singleton (prod mcp-server)
      [12000, 12000], // reserved-port-ok: pinned singleton (prod command-frontend publish)
      [16000, 16999], // reserved-port-ok: pinned range bound
      [18080, 18099], // reserved-port-ok: pinned range bound
    ]);
  });

  test('the sweep actually covers the test tree (never vacuously green)', () => {
    expect(() => assertSweptFileFloor(files, SWEPT_FILE_FLOOR)).not.toThrow();
  });

  test('no test file hardcodes a port in a fleet-reserved range', () => {
    // KNOWN GAP, stated rather than hidden: the 13xxx and 15xxx blocks are ALSO fleet-bound
    // (measured) but are NOT enforced here, because their only occurrences in the tree today
    // are vitest timeouts and doc comments naming a DATABASE_PORT — none of which bind a
    // listener. Enforcing them now would buy ~8 annotations on non-ports and no safety.
    // Raised with Coordinator as a scope decision instead of being silently widened or dropped.
    // NARROWED 2026-08-04: prod's own binds — 8080, 5000, and the new // reserved-port-ok: comment naming the pins
    // 12000 frontend publish — ARE now enforced as singletons. They cost 27 annotations // reserved-port-ok: comment naming the pin
    // (all on ms-timeouts, char budgets, doc comments and URL fixtures — audited one by
    // one), and unlike 13xxx/15xxx they buy real safety: a test binding one of them
    // reproduces the motivating EADDRINUSE-at-the-clean-gate failure verbatim.
    const violations = files.flatMap(f =>
      scanForReservedPorts(readFileSync(f, 'utf8'), relative(REPO_ROOT, f))
    );
    const rendered = violations.map(v => `  ${v.file}:${v.line}  port ${v.port}  ${v.text}`);
    expect(
      violations,
      violations.length === 0
        ? ''
        : `Reserved-range port literal(s) found in test files. The tenant fleet binds ` +
            `${RESERVED_PORT_RANGES.map(r => `${r.from}-${r.to} (${r.why})`).join(', ')}, so ` +
            `these pass on a dev box and EADDRINUSE on the prod box.\n${rendered.join('\n')}\n` +
            `Fix: use reserveEphemeralPort() from ./helpers/ephemeralPort.js. If the number ` +
            `is genuinely not a port this suite binds, put "${ANNOTATION} <reason>" on the ` +
            `same line.`
    ).toEqual([]);
  });

  describe('teeth — the detector and its emptiness check both fail loudly', () => {
    test('flags a reserved port however it is spelled, not just as an assignment', () => {
      // The spellings that matter, INCLUDING the env-stub form a shape-based guard would
      // have missed — the one that actually caused the deploy abort.
      const assignment = scanForReservedPorts('const TEST_PORT = 18099;'); // reserved-port-ok: fixture
      const envStub = scanForReservedPorts("vi.stubEnv('MANDREL_AIDIS_MCP_PORT', '18099');"); // reserved-port-ok: fixture
      const template = scanForReservedPorts('const url = `http://127.0.0.1:18099/mcp`;'); // reserved-port-ok: fixture
      const listenCall = scanForReservedPorts('server.listen(16400);'); // reserved-port-ok: fixture
      for (const v of [assignment, envStub, template, listenCall]) expect(v).toHaveLength(1);
      expect(assignment[0].port).toBe(18099); // reserved-port-ok: asserting the fixture's value
      expect(listenCall[0].port).toBe(16400); // reserved-port-ok: asserting the fixture's value
    });

    test('classifies non-reserved ports as clean (no churn outside the ranges)', () => {
      // The ports deliberately left alone — they must NOT be flagged.
      expect(scanForReservedPorts('a=11111,b=12345,c=18000,d=13753,e=19097,f=15432;')).toEqual([]);
      // Boundaries: just outside each range stays clean…
      expect(scanForReservedPorts('x=15999; y=17000; z=18079; w=18100;')).toEqual([]); // reserved-port-ok: fixture
      // …while the edges themselves are caught.
      expect(scanForReservedPorts('a=16000;').map(v => v.port)).toEqual([16000]); // reserved-port-ok: fixture
      expect(scanForReservedPorts('b=16999;').map(v => v.port)).toEqual([16999]); // reserved-port-ok: fixture
      expect(scanForReservedPorts('c=18080;').map(v => v.port)).toEqual([18080]); // reserved-port-ok: fixture
      expect(scanForReservedPorts('d=18099;').map(v => v.port)).toEqual([18099]); // reserved-port-ok: fixture
      // Prod singleton pins: each port's neighbours stay clean…
      expect(scanForReservedPorts('p=4999; q=5001; r=8079; s=8081; t=11999; u=12001;')).toEqual([]); // reserved-port-ok: fixture
      // …while the pinned ports themselves are caught.
      expect(scanForReservedPorts('e=5000;').map(v => v.port)).toEqual([5000]); // reserved-port-ok: fixture
      expect(scanForReservedPorts('f=8080;').map(v => v.port)).toEqual([8080]); // reserved-port-ok: fixture
      expect(scanForReservedPorts('g=12000;').map(v => v.port)).toEqual([12000]); // reserved-port-ok: fixture
    });

    test('a co-located annotation accounts for a genuine non-port use', () => {
      const annotated = `const bytes = 18099; // ${ANNOTATION} a byte count`; // reserved-port-ok: fixture
      expect(scanForReservedPorts(annotated)).toEqual([]);
      // …and an annotation covers ITS OWN line only, never the whole file.
      const leaky = `// ${ANNOTATION} explained up here\nconst TEST_PORT = 18099;`; // reserved-port-ok: fixture
      expect(scanForReservedPorts(leaky)).toHaveLength(1);
    });

    test('does not match a reserved number embedded in a longer literal', () => {
      expect(scanForReservedPorts('const big = 118099; const dec = 1.18099;')).toEqual([]); // reserved-port-ok: fixture
    });

    test('PROBE THE PROBE: the floor check throws on an empty file set', () => {
      // The vacuous-pass hole itself. `[]` is what a broken walk produces, and a floor
      // written as e.g. `expect(files.length - 1).toBeGreaterThanOrEqual(-1)` would happily
      // report PASS on it. Asserted as a real throw with the message checked, so the
      // emptiness guard cannot be zeroed while still looking green.
      expect(() => assertSweptFileFloor([], SWEPT_FILE_FLOOR)).toThrow(/covered 0 test file/);
      expect(() => assertSweptFileFloor(['a.test.ts'], SWEPT_FILE_FLOOR)).toThrow(
        /below the pinned floor/
      );
      // And it must NOT throw once the floor is genuinely met — a check that always throws
      // is as useless as one that never does.
      const enough = Array.from({ length: SWEPT_FILE_FLOOR }, (_, i) => `f${i}.test.ts`);
      expect(() => assertSweptFileFloor(enough, SWEPT_FILE_FLOOR)).not.toThrow();
    });

    test('PROBE THE PROBE: the floor is a positive number, not a no-op', () => {
      // A floor of 0 makes the emptiness check structurally incapable of failing — the
      // shape that once reported PASS while the floor was zeroed.
      expect(SWEPT_FILE_FLOOR).toBeGreaterThan(0);
      expect(() => assertSweptFileFloor([], 0)).not.toThrow(); // proves 0 IS the no-op
    });
  });
});
