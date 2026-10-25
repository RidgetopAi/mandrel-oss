/**
 * TRUST PARITY — the executable drift guard for the mirrored canonical trust model
 * (PHASE 2 item e, the graph audit "no parity test" finding).
 *
 * TreeWalker's backend cannot IMPORT mcp-server source (measured: backend/Dockerfile
 * copies only backend/ into the build context; the packages also differ CJS vs ESM), so
 * config/treewalkerTrustModel.ts is a MIRROR — and a mirror is only honest while a guard
 * executes both sides. This suite loads the REAL mcp-server modules off disk (ts-jest
 * transforms them; the repo checkout is the test's ground truth) and REFUSES TO PASS if
 * they cannot be found — a missing canonical file must never become a silent green
 * (same technique as frontend fieldLimits' drift guard).
 *
 * What is pinned, executably:
 *   1. The band vocabulary (TRUST_BANDS) — exact array equality.
 *   2. The config: default values AND env var names (the mirror re-reads the same env).
 *   3. The belief stamp + the outcome edge-type set.
 *   4. BAND/SCORE/ABSTAIN PARITY over a fixture matrix run through BOTH computeTrust
 *      implementations — including the acceptance-4 trio: a STALE record, a declared-
 *      SUPERSEDED record, and an outcome-proven record — plus soft-supersession,
 *      cold-start, contradiction, boundary scores, and the empty/zero populations.
 *   5. THE MAPPERS, over the full status vocabularies derived from the product.
 *   6. The same fixtures END-TO-END from raw status strings, each side mapping with its
 *      OWN mapper, so a mapper divergence surfaces as the band/abstain split it is.
 *
 * 5 and 6 exist because 1–4 could not see the mappers at all: every fixture in 4 supplies
 * PRE-MAPPED literal values, so corrupting BOTH mirror mappers wholesale left this suite
 * green (measured). That blindness is how the mirror kept `cancelled → 0`
 * after the canonical model dropped it.
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  TRUST_BANDS,
  TRUST_CONFIG,
  BELIEF_EDGE_CREATED_BY,
  OUTCOME_OUT_EDGE_TYPES,
  computeTrustVerdict,
  mapTaskOutcome,
  mapDecisionOutcome,
  type TrustSignals,
} from '../config/treewalkerTrustModel';

// The canonical modules, loaded off disk from the repo checkout. Path is derived from
// THIS file's location (backend/src/__tests__ → repo root → mcp-server) so the guard
// holds in any checkout location.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CANONICAL_MODEL = path.join(REPO_ROOT, 'mcp-server/src/services/trustModel.ts');
const CANONICAL_CONFIG = path.join(REPO_ROOT, 'mcp-server/src/config/trustConfig.ts');
const CANONICAL_BELIEF = path.join(REPO_ROOT, 'mcp-server/src/config/beliefConfig.ts');
const CANONICAL_TRUST_SERVICE = path.join(REPO_ROOT, 'mcp-server/src/services/trust.ts');

describe('treewalker trust — parity with the canonical mcp-server model', () => {
  // REFUSE to pass without the canonical files: a guard that cannot find its ground
  // truth must fail loudly, never skip (Lesson: silent green erosion).
  it('the canonical files exist (the guard has ground truth)', () => {
    for (const f of [CANONICAL_MODEL, CANONICAL_CONFIG, CANONICAL_BELIEF]) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  // LITERAL specifiers, deliberately (dbTestGateCoverage forbids computed require — an
  // unresolvable specifier could hide a DB import). The path constants above remain the
  // existence check's ground truth; these literals point at the same files.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const canonicalModel = require('../../../../mcp-server/src/services/trustModel');
  const canonicalConfig = require('../../../../mcp-server/src/config/trustConfig');
  const canonicalBelief = require('../../../../mcp-server/src/config/beliefConfig');
  // The decision outcome_status vocabulary — the canonical SINGLE SOURCE for that value
  // domain (config/decisionVocab.ts OUTCOME_STATUSES, which the DB CHECK constraint and
  // the zod enum both derive from). Used as the mapper-parity population below.
  const canonicalVocab = require('../../../../mcp-server/src/config/decisionVocab');
  /* eslint-enable @typescript-eslint/no-var-requires */

  it('1. band vocabulary is EXACTLY the canonical TRUST_BANDS', () => {
    expect([...TRUST_BANDS]).toEqual([...canonicalConfig.TRUST_BANDS]);
  });

  it('2a. config DEFAULTS match the canonical defaults (no MANDREL_TRUST_* env set in tests)', () => {
    // Guard the guard's own precondition: if a MANDREL_TRUST_* var leaked into this
    // process both sides would read it and a default drift could hide behind it.
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('MANDREL_TRUST_'));
    expect(leaked).toEqual([]);
    expect(TRUST_CONFIG).toEqual(canonicalConfig.TRUST_CONFIG);
  });

  it('2b. the mirror reads the SAME env var names (source-level pin, both directions)', () => {
    const mirrorSrc = fs.readFileSync(
      path.join(__dirname, '../config/treewalkerTrustModel.ts'),
      'utf8',
    );
    const canonicalSrc = fs.readFileSync(CANONICAL_CONFIG, 'utf8');
    const envNames = (src: string) => (src.match(/MANDREL_TRUST_[A-Z_]+/g) ?? []).sort();
    expect([...new Set(envNames(mirrorSrc))]).toEqual([...new Set(envNames(canonicalSrc))]);
  });

  it('3. the belief stamp and the outcome edge-type set match the canonical exports', () => {
    expect(BELIEF_EDGE_CREATED_BY).toBe(canonicalBelief.BELIEF_EDGE_CREATED_BY);
    // OUTCOME_OUT_EDGE_TYPES lives in services/trust.ts, which imports the db module —
    // requiring it here would spin a pool. Pin against the canonical SOURCE text instead:
    // the literal array must appear verbatim (services/trust.ts exports it as a const).
    const trustSrc = fs.readFileSync(CANONICAL_TRUST_SERVICE, 'utf8');
    expect(trustSrc).toContain(
      `export const OUTCOME_OUT_EDGE_TYPES = [${OUTCOME_OUT_EDGE_TYPES.map((t) => `'${t}'`).join(', ')}] as const;`,
    );
  });

  // ── 4. BAND/SCORE/ABSTAIN PARITY over the fixture matrix ─────────────────────────
  type Sig = TrustSignals & { name: string };
  const sig = (name: string, s: Partial<TrustSignals>): Sig => ({
    name,
    outcomes: [],
    ageDays: 0,
    supersededDeclared: false,
    supersededSoft: false,
    contradicted: false,
    ...s,
  });

  const MATRIX: Sig[] = [
    // The acceptance-4 trio:
    sig('STALE — old cold-start record (age 200d)', { ageDays: 200 }),
    sig('SUPERSEDED — declared supersession over a successful outcome', {
      outcomes: [{ value: 1, source: 'decision' }],
      ageDays: 3,
      supersededDeclared: true,
    }),
    sig('TRUSTED — fresh record with a successful downstream outcome', {
      outcomes: [{ value: 1, source: 'decision' }],
      ageDays: 3,
    }),
    // The rest of the branch space:
    sig('cold-start fresh (age 0) → unproven', {}),
    sig('soft-superseded fresh cold-start (demoted, not capped)', { supersededSoft: true }),
    sig('declared WINS over soft when both are present', {
      supersededDeclared: true,
      supersededSoft: true,
    }),
    sig('contradicted', { contradicted: true }),
    sig('ok — mixed outcome at mid-age', {
      outcomes: [{ value: 0.5, source: 'decision' }],
      ageDays: 15,
    }),
    sig('failed outcome → score sinks (stale/abstain territory)', {
      outcomes: [{ value: 0, source: 'decision' }],
      ageDays: 3,
    }),
    sig('ignored samples only (too_early/unknown mapped to null) → still cold-start', {
      outcomes: [
        { value: null, source: 'decision' },
        { value: null, source: 'task' },
      ],
      ageDays: 3,
    }),
    sig('mixed decision + completed task blend', {
      outcomes: [
        { value: 0.5, source: 'decision' },
        { value: 1, source: 'task' },
      ],
      ageDays: 10,
    }),
    sig('empty population: zero outcomes, zero age', { outcomes: [], ageDays: 0 }),
    sig('negative age clamps (future-dated row is not extra-fresh)', { ageDays: -5 }),
    sig('exact one-half-life age (boundary)', { ageDays: 30 }),
  ];

  test.each(MATRIX.map((m) => [m.name, m] as const))('parity: %s', (_name, s) => {
    const mirror = computeTrustVerdict(s);
    const canonical = canonicalModel.computeTrust(
      {
        outcomes: s.outcomes,
        ageDays: s.ageDays,
        supersededDeclared: s.supersededDeclared,
        supersededSoft: s.supersededSoft,
        contradicted: s.contradicted,
      },
      canonicalConfig.TRUST_CONFIG,
    );
    expect(mirror.band).toBe(canonical.band);
    expect(mirror.abstain).toBe(canonical.abstain);
    expect(mirror.score).toBeCloseTo(canonical.score as number, 12);
  });

  // ── 5. THE MAPPERS — the half of the mirror the matrix above cannot see ──────────
  // MEASURED HOLE: every fixture in MATRIX supplies PRE-MAPPED literal
  // values, so mapTaskOutcome/mapDecisionOutcome are never invoked on either side. Both
  // mirror mappers could be corrupted wholesale and this suite stayed 19/19 green — and
  // that is exactly how `cancelled → 0` survived here after the canonical model dropped
  // it. The mappers are the mirror's OTHER half; a parity guard that skips them lets a
  // record read `unproven` on the MCP surface and `stale/abstain` on the Command UI.
  //
  // The population is the FULL status vocabulary, DERIVED from the product rather than
  // hand-listed here (a guard written against remembered shapes passes the case you
  // forgot), plus the out-of-vocabulary values a column can still hand a mapper.

  /** The task-status vocabulary, read from mcp-server's ONE centralized definition
   *  (middleware/validation.ts `taskStatusEnum` — tasks.status carries no DB CHECK, so
   *  the zod enum on the write path is the lowest layer that actually governs it).
   *  FAIL-CLOSED: an unparseable source is a FINDING, never an empty (vacuously green)
   *  population. */
  const taskStatusVocabulary = (): string[] => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'mcp-server/src/middleware/validation.ts'),
      'utf8',
    );
    const m = src.match(/taskStatusEnum\s*=\s*z\.enum\(\[([^\]]*)\]\)/);
    if (m === null) {
      throw new Error(
        'trust parity guard: could not locate `taskStatusEnum = z.enum([...])` in ' +
          'mcp-server/src/middleware/validation.ts. The status vocabulary moved; fix this ' +
          'derivation rather than letting the mapper population silently empty out.',
      );
    }
    return (m[1].match(/'([^']+)'/g) ?? []).map((q) => q.slice(1, -1));
  };

  const TASK_STATUSES = taskStatusVocabulary();
  const DECISION_OUTCOME_STATUSES: string[] = [...canonicalVocab.OUTCOME_STATUSES];
  /** Values a column/caller can still produce that are in NO vocabulary. */
  const OUT_OF_VOCAB = [null, undefined, '', 'not_a_status'] as const;

  it('5a. the derived vocabularies are real (the mapper population is not vacuous)', () => {
    // Without this the regex above could match something empty and every mapper test
    // below would pass by having nothing to compare — a green that means "I measured
    // nothing". The two statuses named are the ones the task mapper DISCRIMINATES, so
    // their absence would make the guard blind to the exact drift it exists for.
    expect(TASK_STATUSES).toContain('completed');
    expect(TASK_STATUSES).toContain('cancelled');
    expect(DECISION_OUTCOME_STATUSES.length).toBeGreaterThan(1);
  });

  test.each([...TASK_STATUSES, ...OUT_OF_VOCAB].map((s) => [String(s), s] as const))(
    '5b. mapTaskOutcome parity — task status %s',
    (_label, status) => {
      // toBe is Object.is: it separates null (NO sample) from 0 (a FAILURE sample), which
      // is the entire distinction this mapper turns on.
      expect(mapTaskOutcome(status as string | null | undefined)).toBe(
        canonicalModel.mapTaskOutcome(status),
      );
    },
  );

  test.each([...DECISION_OUTCOME_STATUSES, ...OUT_OF_VOCAB].map((s) => [String(s), s] as const))(
    '5c. mapDecisionOutcome parity — outcome_status %s',
    (_label, status) => {
      expect(mapDecisionOutcome(status as string | null | undefined)).toBe(
        canonicalModel.mapDecisionOutcome(status),
      );
    },
  );

  // ── 6. END-TO-END: the SAME fixtures, each side mapping with ITS OWN mapper ──────
  // 5b/5c compare the mappers directly; this asserts the consequence a user would see —
  // build the outcome samples from raw STATUS STRINGS, mirror side through the mirror's
  // mappers and canonical side through the canonical's, then compare the rendered
  // verdict. A mapper divergence surfaces here as the band/abstain split it actually is.
  interface StatusFixture {
    name: string;
    taskStatuses: readonly (string | null)[];
    decisionStatuses: readonly (string | null)[];
    ageDays: number;
  }
  const statusFixture = (
    name: string,
    taskStatuses: readonly (string | null)[],
    decisionStatuses: readonly (string | null)[],
    ageDays: number,
  ): StatusFixture => ({ name, taskStatuses, decisionStatuses, ageDays });

  const STATUS_MATRIX: StatusFixture[] = [
    // The SK7 case itself: one hygiene cancellation is the record's only linked work.
    statusFixture('one cancelled task, fresh (the cancelled-task case)', ['cancelled'], [], 3),
    statusFixture('a cancelled task alongside a completed one', ['completed', 'cancelled'], [], 3),
    statusFixture('cancelled task at half-life age', ['cancelled'], [], 30),
    // The whole vocabulary at once, both directions.
    statusFixture('every task status at once', TASK_STATUSES, [], 3),
    statusFixture('every decision outcome at once', [], DECISION_OUTCOME_STATUSES, 3),
    statusFixture('both vocabularies at once', TASK_STATUSES, DECISION_OUTCOME_STATUSES, 10),
    // The empty population: no linked work at all.
    statusFixture('no linked work (empty population)', [], [], 3),
  ];

  type Mapper = (s: string | null | undefined) => number | null;
  const samplesFrom = (f: StatusFixture, mapTask: Mapper, mapDecision: Mapper) => [
    ...f.taskStatuses.map((s) => ({ value: mapTask(s), source: 'task' as const })),
    ...f.decisionStatuses.map((s) => ({ value: mapDecision(s), source: 'decision' as const })),
  ];

  test.each(STATUS_MATRIX.map((f) => [f.name, f] as const))(
    '6. status-driven parity: %s',
    (_name, f) => {
      const mirror = computeTrustVerdict({
        outcomes: samplesFrom(f, mapTaskOutcome, mapDecisionOutcome),
        ageDays: f.ageDays,
        supersededDeclared: false,
        supersededSoft: false,
        contradicted: false,
      });
      const canonical = canonicalModel.computeTrust(
        {
          outcomes: samplesFrom(f, canonicalModel.mapTaskOutcome, canonicalModel.mapDecisionOutcome),
          ageDays: f.ageDays,
          supersededDeclared: false,
          supersededSoft: false,
          contradicted: false,
        },
        canonicalConfig.TRUST_CONFIG,
      );
      expect(mirror.band).toBe(canonical.band);
      expect(mirror.abstain).toBe(canonical.abstain);
      expect(mirror.score).toBeCloseTo(canonical.score as number, 12);
    },
  );
});
