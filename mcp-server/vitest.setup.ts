import { vi, beforeEach, afterAll } from 'vitest';

// BL-9 belief hook: DISARM the live post-store belief hook for the whole suite. The hook
// (services/belief/beliefHook.ts) fires adjudicateNeighbourhood on every committed
// context_store / decision_record, and its default provider is a REAL Anthropic/Groq call —
// which the suite must never make (spec: NO live LLM/paid calls in tests). beliefConfig reads
// MANDREL_BELIEF_ENABLED at MODULE LOAD, and setupFiles execute BEFORE any test file imports
// the handlers/config, so setting it here pins BELIEF_CONFIG.beliefEnabled=false process-wide.
// The hook's OWN tests (beliefHook.unit.test.ts) exercise the enabled path explicitly with
// INJECTED fake cfg/queue (no provider), and the config tests prove the shipped default is TRUE
// via a fresh env-cleared re-import — so the prod default-true contract stays covered.
process.env.MANDREL_BELIEF_ENABLED = 'false';

// Re-embed self-heal worker: keep its SCHEDULED start OFF during the suite so
// no background timer sweeps the shared CI DB mid-test (contention/order-flake). Tests exercise
// the worker by calling ReembedWorker.runOnce() directly, which is NOT gated by this flag — so
// coverage of the heal + single-flight path is unaffected. Set before ENV_SNAPSHOT so it is the
// captured baseline (the env-leak guard treats it as the expected value, not a leak).
process.env.MANDREL_REEMBED_WORKER_ENABLED = 'false';

// On-box MCP bridge auth gate: PHASE 2 flips MCP_BRIDGE_AUTH_ENABLED to default
// TRUE (fail-CLOSED) in bridgeAuthConfig.ts — an UNSET flag now ENFORCES on /mcp/tools/*. Many
// contract/integration tests here drive that real tool surface WITHOUT a credential (httpContract,
// contextStoreLongContent, taskCreateLongDescription, sessionIsolation, …) to exercise handler
// behavior, not auth. So the suite EXPLICITLY opts out of the gate here — exactly the escape hatch
// the new default provides ("require the token unless explicitly disabled") — mirroring how the
// belief hook and reembed worker above are disabled suite-wide. Set BEFORE ENV_SNAPSHOT so the
// leak-guard treats 'false' as the expected baseline. bridgeAuth.test.ts flips this per-test to
// prove BOTH the enforcing default and the disabled pass-through, and restores it to 'false'; the
// new-default value itself is asserted at the source in bridgeAuthConfig.unit.test.ts.
process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';

// Record-permalink origin (customer bug 2026-07-30). commandUrlConfig.ts
// used to carry a hardcoded `https://command.example.com` default, so every suite that
// rendered a permalink got a stable https origin for free. That default is GONE — it was the
// bug (every tenant emitted links into our instance) — and the origin is now derived from the
// instance's own MCP_ALLOWED_HOSTS, falling back to a local http:// dev origin. Under the
// clean gate neither var is set, so recordPermalinks.contract.test.ts started seeing
// http://localhost:3000 and its "emitted permalink is an https URL" assertion went RED.
// Pin a known origin suite-wide so permalink assertions test the CONTRACT rather than
// whatever the ambient environment happens to be. Set BEFORE ENV_SNAPSHOT so the leak-guard
// treats this as the expected baseline. commandUrlConfig's own unit test clears both vars and
// re-imports, so it still proves the real resolution ladder (explicit > derived > local dev).
process.env.COMMAND_BASE_URL = 'https://command.test.invalid';

// =============================================================================
// ENV-LEAK GUARD — a test file MUST leave process.env as it found it.
// =============================================================================
// WHY THIS EXISTS: vitest.config pins the ENTIRE suite to one process
// (fileParallelism:false + singleFork:true). Module registries are isolated per file, but
// process.env is a PROCESS global — it is the one piece of state every file shares. So a
// file that writes env at module scope (or in a hook) without restoring it silently
// reconfigures every file that runs after it. Product config modules
// (betterAuthConfig/embeddingConfig/...) read env at MODULE LOAD, so the pollution is read
// back as if it were real configuration.
//
// That is not hypothetical: betterAuthOAuth.integration.test.ts set MANDREL_OAUTH_ENABLED=
// 'true' at module scope with no cleanup. It leaked into bridgeAuth.test.ts, whose
// fail-closed "no credential source → 503" case then saw a credential source and got 401.
// Stage 1 went RED and ABORTED every fleet deploy — and the failure surfaced in an innocent
// file, far from the culprit, only when the two shared a run. It also fired when the
// polluting file's own beforeAll THREW, because module eval happens regardless.
//
// WHY A RUNTIME ASSERTION (and not the alternatives):
//   - vitest's `unstubEnvs: true` would call unstubAllEnvs BEFORE EACH TEST, destroying the
//     beforeAll-applied stubs the fixed files now rely on — and it only knows about
//     vi.stubEnv, so it would not have caught either real leak (both were raw assignment).
//     It would have given false confidence.
//   - An eslint rule against top-level `process.env` assignment catches only that ONE
//     syntax. It would have missed remoteMcpTransport's real leak (a beforeAll that stubbed
//     four vars and an afterAll that deleted one) — that is a cleanup bug, not a syntax one.
//   - This check is mechanism-agnostic: raw assignment, vi.stubEnv, vi.hoisted, or a hook
//     that forgets a var all trip it, and it fails the CULPRIT file with the var name —
//     which is precisely the diagnostic that was missing when this cost us a deploy.
//
// The snapshot is taken HERE, at setup-module scope: setupFiles execute BEFORE the test
// file is evaluated, so module-scope writes land after this line and are caught. The
// afterAll below is registered FIRST (setup runs before the test file), and vitest runs
// afterAll hooks in reverse registration order, so it runs LAST — after each file's own
// restore hooks have had their chance.
// The check is DENY-LIST, not allow-list: every var is watched unless it is listed here,
// so a NEW product flag is guarded automatically and cannot drift out of coverage. Only
// vars owned by third-party NATIVE modules — which no test author can restore, and which
// our config never reads — are exempt. Each entry needs evidence, not a hunch.
const THIRD_PARTY_ENV = new Set<string>([
  // Set to its build prefix ("/target") by libvips when sharp's native addon loads.
  // Proven: `strings node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3`
  // contains both "VIPSHOME" and "/target". Not written by any file under src/.
  'VIPSHOME',
]);

const ENV_SNAPSHOT: Readonly<Record<string, string | undefined>> = { ...process.env };

/** Never print a secret's value; identifying the VAR is enough to fix the leak. */
const isSecret = (key: string) => /(SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)/i.test(key);
const show = (key: string, value: string | undefined) =>
  value === undefined ? '<unset>' : isSecret(key) ? '<redacted>' : JSON.stringify(value);

afterAll(() => {
  const keys = new Set([...Object.keys(ENV_SNAPSHOT), ...Object.keys(process.env)]);
  const leaked = [...keys]
    .filter((key) => !THIRD_PARTY_ENV.has(key) && ENV_SNAPSHOT[key] !== process.env[key])
    .map((key) => `  - ${key}: ${show(key, ENV_SNAPSHOT[key])} → ${show(key, process.env[key])}`);

  if (leaked.length > 0) {
    // Restore, so ONE offender fails one file instead of cascading into every later file.
    for (const key of keys) {
      if (ENV_SNAPSHOT[key] === undefined) delete process.env[key];
      else process.env[key] = ENV_SNAPSHOT[key] as string;
    }
    throw new Error(
      `ENV LEAK — this test file changed process.env and did not restore it:\n${leaked.join('\n')}\n\n` +
      'Every test file shares ONE process (vitest.config: singleFork), so this silently ' +
      'reconfigures every file that runs after it and makes OTHER files fail.\n' +
      'FIX: set env with vi.stubEnv() inside beforeAll/beforeEach (NOT at module scope — that ' +
      'runs even when your hooks throw) and restore with vi.unstubAllEnvs() in afterAll/' +
      'afterEach, in a `finally` so it runs on every path.'
    );
  }
});

// Spy on console methods to reduce test noise.
//
// SPY ONCE PER PROCESS, THEN CLEAR (task: v0.41.0 clean-gate RangeError).
// `console` is a PROCESS global and vitest.config pins the whole suite to one
// process (fileParallelism:false / singleFork:true). tinyspy's internalSpyOn has
// no already-spied guard: re-spying an already-spied method captures the CURRENT
// value as the "original", so a plain `vi.spyOn` in a beforeEach STACKS one
// wrapper per test — measured 2,734 deep, 16k live spy objects, 2.2GB RSS by the
// end of the suite. Any file that then calls vi.restoreAllMocks() clears every
// stacked spy's implementation and leaves console.log pointing mid-chain, so the
// next console call walks all ~2,700 wrappers and dies with
// "RangeError: Maximum call stack size exceeded" — which vitest reports as a
// COLLECTION failure on whichever innocent file logs next.
// Spying only when the method is not already a mock caps the chain at 1;
// mockClear keeps the per-test fresh call history the old code got for free.
// ⚠️ THIS SILENCES YOUR PROBE WITNESS TOO (defect 8e74e121). A mutation
// probe that prints its "the mutant ran" marker with console.* from inside test-run code
// emits NOTHING — the spy is installed before every test — so a LANDED mutation reads as
// "did not land" and burns a round.
// This no longer relies on you remembering it. scripts/mutation-probe.sh owns a witness
// channel nothing here can reach (`--witness-file`), refuses to return a verdict when the
// witness is missing, and names this block as the likely cause when the command looks like
// a test runner. Use --witness-file for any probe of a vitest suite.
// If you change what is silenced below, scripts/test/mutation-probe-witness-channel.test.sh
// measures the consequence against the real runner and will say so.
const SILENCED_CONSOLE_METHODS = ['log', 'error', 'warn', 'info', 'debug'] as const;
beforeEach(() => {
  for (const method of SILENCED_CONSOLE_METHODS) {
    const current = (console as any)[method];
    if (vi.isMockFunction(current)) current.mockClear();
    else vi.spyOn(console, method).mockImplementation(() => {});
  }
});

// Mock UUID generation for recognizable-yet-UNIQUE test ids.
//
// The middle `-4123-4123-8123-` marker is load-bearing: session.e2e.test.ts cleans
// up rows by `id::text LIKE '%-4123-4123-8123-%'`, so it MUST stay. Everything else
// must carry enough entropy that no two calls ever collide — even across parallel
// vitest fork workers running in the SAME wall-clock window. The previous format took only the HIGH 8 hex digits of
// Date.now() (stable for ~16s) and a per-test-reset counter, so two parallel
// session-start contract tests both produced the byte-identical id
// `<stable-ts>-4123-4123-8123-000100000000` → sessions PK collision → start fails.
//
// Fix: a per-FILE token that is UNIQUE BY CONSTRUCTION (below) plus a counter that
// beforeEach does NOT reset, packed into the high and low segments.

// =============================================================================
// THE PER-FILE TOKEN — ENUMERATED, NOT SAMPLED.
// =============================================================================
// This used to be `Math.floor(Math.random() * 0xffff)`: a 16-bit draw taken once per
// test FILE. That is a birthday problem, not a rare event. MEASURED on this tree:
//   - analytic, over the file count `git ls-files 'mcp-server/src/**/*.test.ts'
//     'mcp-server/src/**/*.spec.ts' | wc -l` reports (314) and the 65535-value space
//     the expression actually draws from: 52.81% of runs contain a duplicate.
//   - observed, running the real setup file over 314 files under the real runner:
//     62 of 135 runs (45.9%) drew a duplicate; 93 colliding pairs, 0.689/run against
//     an expectation of 0.750/run.
// Two files with the same token mint byte-identical ids, which surfaces as sqlstate
// 23505 on a unique constraint (sessions_display_id_key) in whichever file lost the
// race. Widening the draw to 32 bits would only lower that number; it is the SAMPLING
// that is wrong, because the runner will ENUMERATE the files for us.
//
// So the token is built from two runner-supplied coordinates that are unique together:
//   1. VITEST_WORKER_ID — vitest's own per-dispatch id (`const workerId = ++id` in the
//      pool, handed to exactly ONE worker process; node_modules/vitest/dist/worker.js
//      sets the env var). Files that share it necessarily share a process.
//   2. FILE_INDEX — a monotonic counter on globalThis, which SURVIVES the per-file
//      module-registry reset (`isolate: true`) and so enumerates the files a single
//      process runs. It is the coordinate that separates files sharing (1).
// Injective by construction: same worker id ⇒ same process ⇒ different file index.
// MEASURED 2026-09-03 with a 314-file probe under both configurations:
//   - shipped config (fileParallelism:false + singleFork): 1 pid, VITEST_WORKER_ID
//     constant at 1, so FILE_INDEX carries all 314 files.
//   - forks in parallel (isolate spawns a process per file): 314 pids, 314 distinct
//     VITEST_WORKER_ID values, FILE_INDEX 0 in each — there the worker id is the whole
//     coordinate, and the run stops at the 64th file on the ceiling below (measured:
//     64 files passed with 64 distinct tokens, the 65th threw). That is deliberate. The
//     shipped config pins singleFork for reasons that predate this block (vitest.config:
//     shared CI database, fixed ports), so a parallel run is an unsupported mode and a
//     loud throw beats a quiet duplicate.
// (VITEST_POOL_ID is NOT usable here: it is the worker SLOT and recycles — the same
// probe saw only the values 1..4 across those 314 processes.)
//
// ONE MORE PROCESS CAN RE-ENTER THIS FILE, AND IT IS NOT A VITEST WORKER: a test may
// spawn its OWN `vitest run`. embedderImportOrderMatrix.contract.test.ts does exactly
// that (twice, with vitest.order-matrix.config.ts). MEASURED on the full suite: 318
// registries reported a token for 314 files — the 4 extra are that child's two files,
// run twice, each starting a fresh globalThis with VITEST_WORKER_ID=1, so they land on
// file indices 0 and 1 and mint ids the parent's first two files also mint. That is a
// DETERMINISTIC duplicate, which is worse than the random one it replaces, so a nested
// run must declare its own index region with MANDREL_VITEST_FILE_INDEX_BASE (the
// order-matrix config sets it). The var is deliberately not VITEST_-prefixed: that
// test strips VITEST_* from the child env.
const WORKER_ID_BITS = 6;   // 64 dispatches
const FILE_INDEX_BITS = 10; // 1024 index slots per process; 314 files today
const FILE_INDEX_KEY = Symbol.for('mandrel.vitest.setup.fileIndex');
const rawIndexBase = process.env.MANDREL_VITEST_FILE_INDEX_BASE ?? '0';
if (!/^(0|[1-9][0-9]*)$/.test(rawIndexBase)) {
  throw new Error(
    `[vitest.setup] MANDREL_VITEST_FILE_INDEX_BASE must be a non-negative integer, got ` +
    `${JSON.stringify(rawIndexBase)}.`,
  );
}
const fileIndexBase = Number(rawIndexBase);
const rawWorkerId = process.env.VITEST_WORKER_ID;
if (!/^[1-9][0-9]*$/.test(rawWorkerId ?? '')) {
  // FAIL LOUD. This file only ever runs as a vitest setupFile, where the worker sets
  // this var before importing anything. Defaulting it would silently re-open the
  // collision this block exists to close.
  throw new Error(
    `[vitest.setup] VITEST_WORKER_ID is ${rawWorkerId === undefined ? 'unset' : JSON.stringify(rawWorkerId)}; ` +
    'the per-file uuid token cannot be made unique without it.',
  );
}
const workerIndex = Number(rawWorkerId) - 1;
const globalScope = globalThis as unknown as Record<symbol, number | undefined>;
const fileIndex =
  (globalScope[FILE_INDEX_KEY] = (globalScope[FILE_INDEX_KEY] ?? fileIndexBase - 1) + 1);
if (workerIndex >= 1 << WORKER_ID_BITS || fileIndex >= 1 << FILE_INDEX_BITS) {
  // FAIL LOUD rather than wrap and re-issue a token. Both ceilings are budget, not
  // physics: widen the segment (and seg1/seg5 with it) if the suite outgrows them.
  throw new Error(
    `[vitest.setup] per-file uuid token overflowed its 16 bits ` +
    `(VITEST_WORKER_ID=${rawWorkerId}, file index=${fileIndex}, base=${fileIndexBase}; ceilings are ` +
    `${1 << WORKER_ID_BITS} dispatches and ${1 << FILE_INDEX_BITS} files per process). ` +
    'Widen WORKER_ID_BITS/FILE_INDEX_BITS and the segments that carry them.',
  );
}
const procSeed = (((workerIndex << FILE_INDEX_BITS) | fileIndex) & 0xffff)
  .toString(16)
  .padStart(4, '0');
// Monotonic within ONE module registry. MEASURED 2026-08-31: vitest runs with
// `isolate: true`, so this setup file is re-evaluated per test FILE even under
// `poolOptions.forks.singleFork` -- searchOrderTotal.contract.test.ts read
// monoCounter 21..24 both standalone and inside the full 307-file run, while a
// counter parked on globalThis had already reached 308 by that point. It is NOT
// process-monotonic. procSeed is likewise recomputed per file — that is what makes it
// a per-FILE token, and the block above is what makes each one distinct.
let monoCounter = 0;
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => {
    monoCounter += 1;
    // High 8 hex: the per-file token + the monotonic counter. THIS SEGMENT MUST BE
    // INJECTIVE ON ITS OWN, because consumers slice it -- a test that derives a unique
    // name from `id.slice(0, 8)` is relying on this segment and on nothing else.
    //
    // It previously XOR'd `Date.now() & 0xffff` with the counter. XOR of two
    // independently varying quantities is not injective: two mints share a prefix
    // exactly when `(T_a ^ T_b) === (mono_a ^ mono_b)`. Because the elapsed-ms gap and
    // the counter gap between nearby mints are both small integers of the same
    // magnitude, that is a RESONANCE, not a birthday event. MEASURED 2026-08-31 on
    // searchOrderTotal.contract.test.ts, whose four fixture ids are minted at counters
    // n..n+3 as two pairs ~5ms apart: 3 of 25 consecutive runs collided on the prefix
    // and raised sqlstate 23505 on projects_name_key. Enumerating the old expression
    // over all 65536 values of `Date.now() & 0xffff` puts the per-run collision rate at
    // 12.5%-62.5% for inter-pair gaps of 1, 2, 3, 5 and 6 ms.
    if (monoCounter > 0xffff) {
      // FAIL LOUD rather than silently re-issuing a prefix. 0xffff is the ceiling this
      // segment can represent; a registry minting more than that needs a wider segment,
      // not a quieter failure.
      throw new Error(
        `[vitest.setup] mocked randomUUID exhausted its 16-bit high segment ` +
        `(monoCounter=${monoCounter}); id.slice(0, 8) can no longer be unique.`,
      );
    }
    const seg1 = `${procSeed}${(monoCounter & 0xffff).toString(16).padStart(4, '0')}`; // 8 hex
    // Low 12 hex: the same per-file token + counter, so it carries exactly the scope
    // seg1 does — unique per FILE, and (since the token block above) across the files
    // of one run, not merely within this module registry.
    const seg5 = `${procSeed}${monoCounter.toString(16).padStart(8, '0')}`; // 12 hex
    return `${seg1}-4123-4123-8123-${seg5}`;
  })
}));
