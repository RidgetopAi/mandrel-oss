/**
 * BELIEF ATTEMPT LEDGER — real-DB contract test AND the three-assertion mutation probe
 * (observability).
 *
 * WHAT IT PROVES, against a REAL migrated Postgres (the disposable ci_* DB) and the REAL shipped
 * path — adjudicatePair → TieredAdjudicator → OpenAICompatAdjudicator → fetch → ledger:
 *
 *   CONTROL GREEN   an unforced adjudication records outcome='completed' and ZERO failures.
 *   MUTATION LANDED the forced tier-1 endpoint actually SERVED the 400 (asserted from the fake
 *                   host's own request log — an edit in a file proves nothing RAN).
 *   GUARD RED       that failure is COUNTABLE at the surface: rollupAttempts reports failed=1
 *                   with failed_tier='tier1' and http_status=400, from the same one query that
 *                   reports the completions.
 *
 * WHY IT DRIVES A REAL HTTP 400 rather than a throwing fake provider: the defect was measured as
 * Groq returning HTTP 400 `json_validate_failed`, and the whole attribution chain under test —
 * status → typed error → tier re-tag → ledger columns — only exists between the wire and the DB.
 * A fake that throws a bare Error would skip every link the fix added.
 *
 * The fake host stands in for Groq's endpoint ONLY. Everything between it and the ledger is the
 * shipped code: the real provider class, the real composite tiered provider, the real
 * adjudicatePair, the real SQL.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

/** Probe output goes STRAIGHT to stdout: the app logger patches console, and a probe whose
 *  evidence can be swallowed by the thing under test is not evidence. */
const probe = (line: string) => process.stdout.write(`${line}\n`);
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from '../config/database.js';
import { embedDim } from './helpers/embedGeometry.js';
import { adjudicatePair, adjudicateNeighbourhood } from '../services/belief/beliefAdjudicator.js';
import { rollupAttempts } from '../services/belief/attemptLedger.js';
import { createTieredAdjudicator } from '../services/belief/tieredAdjudicator.js';
import { OpenAICompatAdjudicator } from '../services/belief/openaiAdjudicator.js';
import { BELIEF_TIERED_CONFIG } from '../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../config/beliefConfig.js';
import type {
  AdjudicationProvider,
  AdjudicationRecord,
  AdjudicatorVerdict,
} from '../services/belief/types.js';

// ── The fake tier-1 host (stands in for Groq's /v1/chat/completions ONLY) ────────────────────

type HostMode = 'ok' | 'json_validate_failed';

interface FakeHost {
  url: string;
  /** What the next request gets. */
  mode: HostMode;
  /** Every response this host actually SERVED — the witness that the mutation RAN. */
  served: Array<{ status: number }>;
  close: () => Promise<void>;
}

async function startFakeTier1Host(): Promise<FakeHost> {
  const state: { mode: HostMode; served: Array<{ status: number }> } = { mode: 'ok', served: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (state.mode === 'json_validate_failed') {
        // The SHAPE Groq actually returned on 2026-08-28, abridged.
        const payload = JSON.stringify({
          error: {
            message: 'Failed to validate JSON. Please try again.',
            type: 'invalid_request_error',
            code: 'json_validate_failed',
            failed_generation: '',
          },
        });
        state.served.push({ status: 400 });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }
      const verdict = {
        same_subject: false,
        subject: 'probe',
        verdict: 'unrelated',
        direction: 'none',
        mode: 'none',
        confidence: 0.9,
        rationale: 'fake host control response',
      };
      const payload = JSON.stringify({
        choices: [{ message: { content: JSON.stringify(verdict) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      state.served.push({ status: 200 });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get mode() {
      return state.mode;
    },
    set mode(m: HostMode) {
      state.mode = m;
    },
    served: state.served,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Tier-2 stand-in. It THROWS if called: the control verdict is `unrelated`, which must never
 *  escalate, so a call here would mean the routing changed under us. */
const tier2NeverCalled: AdjudicationProvider = {
  name: 'test-tier2',
  model: 'never-called',
  lastUsage: [],
  adjudicate(): Promise<AdjudicatorVerdict> {
    throw new Error('tier-2 must not be called for an `unrelated` tier-1 verdict');
  },
};

describe('belief attempt ledger — real DB, real provider path', () => {
  let host: FakeHost;
  let projectId: string;
  let provider: AdjudicationProvider;
  const recA: AdjudicationRecord = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'context',
    content: 'probe record A',
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };
  const recB: AdjudicationRecord = {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'context',
    content: 'probe record B',
    createdAt: new Date('2026-08-02T00:00:00Z'),
  };

  const cleanup = async () => {
    await db.query('DELETE FROM belief_adjudication_attempts WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM belief_adjudications WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM belief_adjudication_costs WHERE project_id = $1', [projectId]);
  };

  beforeAll(async () => {
    host = await startFakeTier1Host();
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ('b7l9-attempt-ledger','') RETURNING id`
      )
    ).rows[0].id;
    const tier1Cfg: BeliefAdjudicatorConfig = {
      ...BELIEF_TIERED_CONFIG.tier1,
      endpoint: host.url,
      // A deliberately unset var: no Authorization header, and NOTHING reads a real key here.
      apiKeyEnvVar: 'MANDREL_TEST_NO_SUCH_KEY_VAR',
    };
    provider = createTieredAdjudicator(
      (cfg) => (cfg === tier1Cfg ? new OpenAICompatAdjudicator(cfg) : tier2NeverCalled),
      {
        escalateVerdicts: ['supersedes', 'contests'],
        tier1: tier1Cfg,
        // A DISTINCT object, so the builder above can tell the two tiers apart.
        tier2: { ...tier1Cfg, model: 'never-called' },
      }
    );
  });

  afterAll(async () => {
    try {
      await cleanup();
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await host.close();
  });

  test('CONTROL (unmutated) — a successful pair records completed=1, failed=0', async () => {
    await cleanup();
    host.mode = 'ok';
    const servedBefore = host.served.length;

    const res = await adjudicatePair(recA, recB, { cosine: 0.9, projectId, provider }, db);
    expect(res.verdict.verdict).toBe('unrelated');

    // The control genuinely exercised the host (not a no-op that trivially "passes").
    expect(host.served.length).toBe(servedBefore + 1);
    expect(host.served[host.served.length - 1].status).toBe(200);

    const rollup = await rollupAttempts(db, 1, undefined, projectId);
    const pair = rollup.byScope.find((s) => s.scope === 'pair');
    probe(
      `[PROBE] CONTROL  attempted=${pair?.attempted} completed=${pair?.completed} failed=${pair?.failed} rate=${pair?.failureRate}`
    );
    expect(pair?.attempted).toBe(1);
    expect(pair?.completed).toBe(1);
    expect(pair?.failed).toBe(0);
    expect(rollup.failures).toEqual([]);
  });

  test('MUTATION — a forced tier-1 HTTP 400 is COUNTED, attributed to tier1, and still skips the pair', async () => {
    await cleanup();
    host.mode = 'json_validate_failed';
    const servedBefore = host.served.length;

    // DEGRADATION UNCHANGED: adjudicatePair still rejects, so the caller still skips this pair.
    await expect(
      adjudicatePair(recA, recB, { cosine: 0.9, projectId, provider }, db)
    ).rejects.toThrow(/400/);

    // ASSERTION 1 — THE MUTATION LANDED: the fake host SERVED a 400. Not "the file says 400".
    expect(host.served.length).toBe(servedBefore + 1);
    expect(host.served[host.served.length - 1].status).toBe(400);

    // ASSERTION 2 — GUARD RED: the miss is countable at the surface, from ONE query.
    const rollup = await rollupAttempts(db, 1, undefined, projectId);
    const pair = rollup.byScope.find((s) => s.scope === 'pair');
    probe(
      `[PROBE] MUTATION attempted=${pair?.attempted} completed=${pair?.completed} failed=${pair?.failed} rate=${pair?.failureRate}`
    );
    probe(`[PROBE] FAILURES ${JSON.stringify(rollup.failures)}`);
    expect(pair?.attempted).toBe(1);
    expect(pair?.completed).toBe(0);
    expect(pair?.failed).toBe(1);
    expect(pair?.failureRate).toBe(1);

    expect(rollup.failures.length).toBe(1);
    expect(rollup.failures[0]).toMatchObject({
      failedStage: 'provider',
      failedTier: 'tier1',
      httpStatus: 400,
      errorClass: 'BeliefProviderCallError',
      count: 1,
    });

    // The row also carries WHY, so the operator does not have to guess from a status alone.
    const row = (
      await db.query(
        `SELECT error_message, pair_key, a_id, b_id FROM belief_adjudication_attempts
          WHERE project_id = $1 AND outcome = 'failed'`,
        [projectId]
      )
    ).rows[0];
    expect(row.error_message).toContain('json_validate_failed');
    expect(row.a_id).toBe(recA.id);
    expect(row.b_id).toBe(recB.id);
  });

  test('the OLD surfaces still cannot see the miss — which is why this table exists', async () => {
    // Same population as the MUTATION test above (one failed pair, no completions). The verdict
    // table and the cost ledger both report ZERO rows, so a rate computed from either is 0/0 —
    // this is the by-construction blindness restated as an executable fact, not a comment.
    const adj = await db.query('SELECT count(*)::int AS n FROM belief_adjudications WHERE project_id = $1', [projectId]);
    const cost = await db.query('SELECT count(*)::int AS n FROM belief_adjudication_costs WHERE project_id = $1', [projectId]);
    const att = await db.query('SELECT count(*)::int AS n FROM belief_adjudication_attempts WHERE project_id = $1', [projectId]);
    probe(
      `[PROBE] OLD SURFACES belief_adjudications=${adj.rows[0].n} belief_adjudication_costs=${cost.rows[0].n} | NEW belief_adjudication_attempts=${att.rows[0].n}`
    );
    expect(adj.rows[0].n).toBe(0);
    expect(cost.rows[0].n).toBe(0);
    expect(att.rows[0].n).toBe(1);
  });

  test('EMPTY population — no attempts is rate 0, not a divide-by-zero or a false 100%', async () => {
    await cleanup();
    const rollup = await rollupAttempts(db, 1, undefined, projectId);
    const pair = rollup.byScope.find((s) => s.scope === 'pair');
    expect(pair).toBeUndefined(); // no rows ⇒ no scope bucket at all
    expect(rollup.overall.attempted).toBe(0);
    expect(rollup.overall.failureRate).toBe(0);
    expect(Number.isFinite(rollup.overall.failureRate)).toBe(true);
  });
});

// The pool is closed ONCE, after BOTH describes — a describe-scoped db.end() would close it out
// from under the neighbourhood suite below.
afterAll(async () => {
  await db.end();
});

// ── Neighbourhood scope: the failure that reaches NO pair at all ─────────────────────────────

describe('belief attempt ledger — neighbourhood scope (the tenant shape)', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ('b7l9-attempt-neighbourhood','') RETURNING id`
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM belief_adjudication_attempts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
  });

  test('a provider that cannot even be CONSTRUCTED is counted as a failed neighbourhood', async () => {
    // The measured tenant shape (2026-08-28): 7 instances with no belief API key configured
    // threw at provider construction, lost EVERY pair for every record, and left no row anywhere
    // — no pair was attempted, so a pair-scope ledger alone would still have reported nothing.
    vi.resetModules();
    vi.doMock('../services/belief/provider.js', () => ({
      getAdjudicationProvider: () => {
        throw new Error(
          'Anthropic adjudicator needs an API key: env var "ANTHROPIC_API_KEY" is not set.'
        );
      },
    }));
    const { adjudicateNeighbourhood } = await import('../services/belief/beliefAdjudicator.js');

    await expect(
      adjudicateNeighbourhood(
        {
          id: '33333333-3333-4333-8333-333333333333',
          type: 'context',
          projectId,
          content: 'neighbourhood probe source',
          createdAt: new Date('2026-08-03T00:00:00Z'),
        },
        undefined,
        db
      )
    ).rejects.toThrow(/API key/);

    const row = (
      await db.query(
        `SELECT scope, outcome, failed_stage, failed_tier, provider, model, source_id, error_message
           FROM belief_adjudication_attempts WHERE project_id = $1`,
        [projectId]
      )
    ).rows;
    probe(`[PROBE] NEIGHBOURHOOD ${JSON.stringify(row)}`);
    expect(row.length).toBe(1);
    expect(row[0].scope).toBe('neighbourhood');
    expect(row[0].outcome).toBe('failed');
    expect(row[0].failed_stage).toBe('provider_init');
    expect(row[0].failed_tier).toBeNull();
    expect(row[0].provider).toBeNull(); // no provider was ever built — the NULL is the diagnostic
    expect(row[0].source_id).toBe('33333333-3333-4333-8333-333333333333');
    vi.doUnmock('../services/belief/provider.js');
  });
});

// ── Neighbourhood scope: the PAIRING stage ───────────────────────────────────
//
// The defect: findCandidates was fail-open and returned `[]` for a query that THREW, which is
// the same value a healthy empty neighbourhood returns. adjudicateNeighbourhood then iterated
// zero pairs and booked the neighbourhood 'completed' — the ledger whose stated purpose is the
// MISS RATE recorded the miss as a success, ~6% of full-suite runs, twice aborting a fleet
// deploy on 2026-08-31 with "expected 0 to be greater than 0" and no cause.
//
// BOTH directions are asserted, and the SECOND is the one that matters: a fix that calls every
// empty neighbourhood a failure would be worse than the bug.

describe('belief attempt ledger — the PAIRING stage is countable', () => {
  let projectId: string;

  /** A pgvector literal at the ACTIVE embedder's geometry (never a hardcoded 1536 — C4). */
  const stubVectorLiteral = () => `[${new Array(embedDim()).fill(0.01).join(',')}]`;

  /** A provider that must never be reached when pairing fails — its call count is the witness. */
  class NeverCalledProvider implements AdjudicationProvider {
    readonly name = 'probe';
    readonly model = 'probe-1';
    calls = 0;
    async adjudicate(): Promise<AdjudicatorVerdict> {
      this.calls += 1;
      return {
        sameSubject: false,
        subject: 'probe',
        verdict: 'unrelated',
        direction: 'none',
        mode: 'none',
        confidence: 0,
        rationale: 'probe — must never be reached when pairing fails',
      };
    }
  }

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ('b7l9-attempt-pairing','') RETURNING id`
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM belief_adjudication_attempts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
  });

  test('a candidate query that THROWS books ONE failed neighbourhood at stage=pairing (never completed)', async () => {
    // The REAL db for every other query — including the ledger write itself, which is the row
    // under test — with ONLY the neighbour query forced to throw. That is the traced condition
    // driven at the real surface, not a re-modelled pipeline. The source read is answered with a
    // stub row so the run REACHES the neighbour query at all (an unreachable mutation proves
    // nothing — CLASSES.md C3 assertion 1).
    const failingPairingPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('AS kind')) {
          return { rows: [{ embedding: stubVectorLiteral(), kind: null, content: 'pairing probe source' }] };
        }
        if (typeof sql === 'string' && sql.includes('AS cosine')) {
          throw new Error('TRACE8063_FAIL');
        }
        return db.query(sql, params as never);
      },
    } as unknown as typeof db;

    const provider = new NeverCalledProvider();
    const sourceId = '44444444-4444-4444-8444-444444444444';
    const results = await adjudicateNeighbourhood(
      { id: sourceId, type: 'context', projectId, content: 'pairing probe source' },
      { provider },
      failingPairingPool
    );

    // FAIL-OPEN PRESERVED: no throw crossed the boundary and the caller got a result.
    expect(results).toEqual([]);
    // …and no pair was reachable, which is exactly why the ledger row has to say so.
    expect(provider.calls).toBe(0);

    const rows = (
      await db.query(
        `SELECT scope, outcome, failed_stage, error_class, error_message, source_id
           FROM belief_adjudication_attempts WHERE project_id = $1 AND source_id = $2`,
        [projectId, sourceId]
      )
    ).rows;
    probe(`[PROBE] PAIRING ${JSON.stringify(rows)}`);
    // EXACTLY ONE row: booking both a failure and a completion would double-count `attempted`.
    expect(rows.length).toBe(1);
    expect(rows[0].scope).toBe('neighbourhood');
    expect(rows[0].outcome).toBe('failed'); // pre-fix this was 'completed' — the miss booked as a success
    expect(rows[0].failed_stage).toBe('pairing');
    expect(rows[0].error_class).toBe('BeliefPairingError');
    // The DIAGNOSTIC: which query, on which table, with the driver's own message.
    expect(rows[0].error_message).toContain('candidate_query');
    expect(rows[0].error_message).toContain('contexts');
    expect(rows[0].error_message).toContain('TRACE8063_FAIL');
  });

  test('a neighbourhood that legitimately finds ZERO candidates is still COMPLETED, not failed', async () => {
    // THE HOLLOW DIRECTION. This source has no row and no neighbours at all — the pairing stage
    // RAN and honestly measured nothing. If this ever books 'failed', the miss rate becomes
    // noise and every healthy quiet record is reported as a defect.
    const provider = new NeverCalledProvider();
    const sourceId = '55555555-5555-4555-8555-555555555555';
    // Same stubbed source read as the failing case above, so the candidate query REALLY RUNS —
    // against the real DB, in an empty project, where it honestly returns zero rows. Handing it
    // an absent source instead would prove only that a short-circuit is not a failure.
    let candidateQueries = 0;
    const healthyPairingPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('AS kind')) {
          return { rows: [{ embedding: stubVectorLiteral(), kind: null, content: 'empty-but-healthy source' }] };
        }
        if (typeof sql === 'string' && sql.includes('AS cosine')) candidateQueries += 1;
        return db.query(sql, params as never);
      },
    } as unknown as typeof db;
    const results = await adjudicateNeighbourhood(
      { id: sourceId, type: 'context', projectId, content: 'empty-but-healthy source' },
      { provider },
      healthyPairingPool
    );

    // WITNESS: the candidate query really EXECUTED (once per embedded table) and returned
    // nothing. Without this, a short-circuit would satisfy every assertion below.
    expect(candidateQueries).toBeGreaterThan(0);
    expect(results).toEqual([]);
    expect(provider.calls).toBe(0); // same OBSERVABLE as the failure above — that was the bug

    const rows = (
      await db.query(
        `SELECT scope, outcome, failed_stage FROM belief_adjudication_attempts
          WHERE project_id = $1 AND source_id = $2`,
        [projectId, sourceId]
      )
    ).rows;
    probe(`[PROBE] EMPTY-BUT-HEALTHY ${JSON.stringify(rows)}`);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('completed');
    expect(rows[0].failed_stage).toBeNull();
  });
});

// ── Neighbourhood scope: the SOURCE CLOCK read ───────────────────────────────
//
// The same fail-open class as the pairing stage, one field over. readRecordCreatedAt swallowed
// its error and returned the same `null` an absent timestamp returns, so "this record genuinely
// has no clock" and "the clock read blew up" were ONE observable: downstream the pair is refused
// as `chronology_unknown` either way, the neighbourhood was booked 'completed', and supersession
// for that record was silently switched OFF while the ledger reported a clean run.
//
// BOTH directions, and the second is the one that matters: a genuinely clockless record must
// still book 'completed', or every quiet record becomes a reported defect.

describe('belief attempt ledger — the SOURCE CLOCK read is countable', () => {
  let projectId: string;

  const stubVectorLiteral = () => `[${new Array(embedDim()).fill(0.01).join(',')}]`;

  class NeverCalledProvider implements AdjudicationProvider {
    readonly name = 'probe';
    readonly model = 'probe-1';
    calls = 0;
    async adjudicate(): Promise<AdjudicatorVerdict> {
      this.calls += 1;
      return {
        sameSubject: false,
        subject: 'probe',
        verdict: 'unrelated',
        direction: 'none',
        mode: 'none',
        confidence: 0,
        rationale: 'probe — no candidate exists in this empty project',
      };
    }
  }

  /**
   * The real DB for everything EXCEPT the two queries this probe controls. Order matters: the
   * candidate query also selects `AS created_at`, so `AS cosine` is tested FIRST and the clock
   * read is the only remaining `AS created_at`.
   */
  function clockPool(onClock: 'throw' | 'pass', counters: { clockReads: number; candidateQueries: number }) {
    return {
      query: async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('AS kind')) {
          return { rows: [{ embedding: stubVectorLiteral(), kind: null, content: 'clock probe source' }] };
        }
        if (typeof sql === 'string' && sql.includes('AS cosine')) {
          counters.candidateQueries += 1;
          return db.query(sql, params as never);
        }
        if (typeof sql === 'string' && sql.includes('AS created_at')) {
          counters.clockReads += 1;
          if (onClock === 'throw') throw new Error('TRACEA2A4_CLOCK_FAIL');
        }
        return db.query(sql, params as never);
      },
    } as unknown as typeof db;
  }

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ('a2a4-attempt-clock','') RETURNING id`
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM belief_adjudication_attempts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
  });

  test('a clock read that THROWS books ONE failed neighbourhood naming created_at (never completed)', async () => {
    const provider = new NeverCalledProvider();
    const sourceId = '66666666-6666-4666-8666-666666666666';
    const counters = { clockReads: 0, candidateQueries: 0 };
    // No `createdAt` on the source, so the clock read is REACHED — that is the whole trigger.
    const results = await adjudicateNeighbourhood(
      { id: sourceId, type: 'context', projectId, content: 'clock probe source' },
      { provider },
      clockPool('throw', counters)
    );

    // MUTATION LANDED: the mutated query really RAN (an edit that is never reached proves nothing).
    expect(counters.clockReads, 'the clock read was never reached — this probe is vacuous').toBe(1);
    // …and the pairing stage was HEALTHY, so the failure below can only be the clock.
    expect(counters.candidateQueries).toBeGreaterThan(0);
    // FAIL-OPEN PRESERVED: no throw crossed the boundary.
    expect(results).toEqual([]);

    const rows = (
      await db.query(
        `SELECT scope, outcome, failed_stage, error_class, error_message
           FROM belief_adjudication_attempts WHERE project_id = $1 AND source_id = $2`,
        [projectId, sourceId]
      )
    ).rows;
    probe(`[PROBE] CLOCK-FAIL ${JSON.stringify(rows)}`);
    // GUARD RED: exactly one row, and it says FAILED — pre-fix this was a silent 'completed'.
    expect(rows.length).toBe(1);
    expect(rows[0].scope).toBe('neighbourhood');
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].failed_stage).toBe('pairing');
    expect(rows[0].error_class).toBe('BeliefPairingError');
    // The DIAGNOSTIC: which read, on which table, with the driver's own message.
    expect(rows[0].error_message).toContain('created_at');
    expect(rows[0].error_message).toContain('contexts');
    expect(rows[0].error_message).toContain('TRACEA2A4_CLOCK_FAIL');
  });

  test('a record that genuinely HAS no clock is still COMPLETED — the two are distinguishable', async () => {
    // CONTROL GREEN, and the hollow direction. Identical run, identical `chronology_unknown`
    // outcome downstream, one difference: the read RAN and honestly returned no row. If this
    // ever books 'failed', the fix above is worse than the bug it replaces.
    const provider = new NeverCalledProvider();
    const sourceId = '77777777-7777-4777-8777-777777777777';
    const counters = { clockReads: 0, candidateQueries: 0 };
    const results = await adjudicateNeighbourhood(
      { id: sourceId, type: 'context', projectId, content: 'clock probe source' },
      { provider },
      clockPool('pass', counters)
    );

    expect(counters.clockReads, 'the clock read was never reached — this control is vacuous').toBe(1);
    expect(results).toEqual([]);

    const rows = (
      await db.query(
        `SELECT outcome, failed_stage FROM belief_adjudication_attempts
          WHERE project_id = $1 AND source_id = $2`,
        [projectId, sourceId]
      )
    ).rows;
    probe(`[PROBE] CLOCK-GENUINELY-ABSENT ${JSON.stringify(rows)}`);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('completed');
    expect(rows[0].failed_stage).toBeNull();
  });
});
