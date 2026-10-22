/**
 * unscopedListProjectScope — THE WHOLE-CLASS GUARD for "unscoped must not mean all
 * projects" (item 7).
 *
 * =============================================================================
 * THE DEFECT
 * =============================================================================
 * Every list controller resolved its project the same way —
 *   `const projectId = getRequestProjectId(req); if (projectId) filter.project_id = …`
 * — so a request that named NO project got NO filter, i.e. every project's rows, to any
 * authenticated user. `/api/embedding/list` had already been fixed on this branch, which
 * made the state worse than either extreme: one endpoint confined the caller to its
 * grants while eighteen did not, and nothing in the tree said which was intended.
 *
 * =============================================================================
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3)
 * =============================================================================
 * EVERY GET route registered on the real Express `app` exported by `src/server.ts`, read
 * out of `app._router.stack` at runtime and walked recursively through every mounted
 * sub-router — the same derivation `mutatingRouteAuthzCoverage.test.ts` uses, and for the
 * same reason: `server.ts` mounts routers that `routes/index.ts` never sees, so walking
 * the aggregator measures a PROXY for the served surface. Routes carrying a `:param` are
 * excluded from the sweep (they cannot be called bare) and are covered separately below.
 *
 * There is NO hand-written list of "endpoints that return rows". A route enters the
 * leak-check by existing. A route enters the stricter differential check by DEMONSTRATING
 * it carries project data — an admin's unscoped response contains a seeded marker — which
 * is measured per run, not remembered.
 *
 * =============================================================================
 * WHY IT IS BEHAVIOURAL AND DB-BACKED
 * =============================================================================
 * The defect is invisible to every name-based gate we own: nothing about
 * `if (projectId) filter.project_id = projectId` is wrong to look at. Only running the
 * route with a real zero-grant non-admin against real rows in two real projects shows it.
 * Real migrated Postgres, real middleware chain, real auth, real ProjectAccessService.
 *
 * =============================================================================
 * THE FOUR QUESTIONS, PER ENDPOINT (all four, or the guard is one-sided)
 * =============================================================================
 *   1. unscoped non-admin with ZERO grants  → sees NOTHING (not everything)
 *   2. unscoped non-admin WITH a grant      → sees only that grant's rows
 *   3. unscoped ADMIN                       → sees everything (or the fix is "deny all",
 *                                             which passes every deny-test and is useless)
 *   4. granted non-admin scoping explicitly → still works (no functional regression)
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { backendPool } from '../database/poolManager';

const P_VICTIM = 'f0f0f0f0-0000-4000-8000-f0f0f0f0f0f0';
const P_GRANTED = 'f1f1f1f1-0000-4000-8000-f1f1f1f1f1f1';
const U_ADMIN = 'f2f2f2f2-0000-4000-8000-f2f2f2f2f2f2';
const U_GRANT = 'f3f3f3f3-0000-4000-8000-f3f3f3f3f3f3';
const U_ZERO = 'f4f4f4f4-0000-4000-8000-f4f4f4f4f4f4';

/**
 * Two markers, not one. A guard that only looks for the VICTIM's marker misses the case
 * that actually bit `/api/sessions/current`: a ZERO-grant caller seeing the GRANTED
 * project's row. `granted` is not granted to `nobody`, so for that persona ANY marker is
 * a leak. This distinction was measured, not imagined — the first pass of this sweep
 * reported those three endpoints clean.
 */
const VICTIM_MARK = 'VICTIMLEAKMARKER';
const GRANT_MARK = 'GRANTEDROWMARKER';

/** Routes whose path carries a param; they cannot be swept bare. Asserted separately. */
const PARAMETERISED_COVERED_SEPARATELY = [
  '/api/projects/:id',
  '/api/projects/:id/insights',
  '/api/projects/:id/sessions',
] as const;

type Persona = 'admin' | 'granted' | 'zero';

const TODAY = new Date().toISOString().slice(0, 10);

/** GET routes that need query params before they return anything but a 400. */
const PARAMETERISED_QUERY: ReadonlyArray<{ path: string; qs: string }> = [
  { path: '/api/day-summary', qs: `?date=${TODAY}` },
  { path: '/api/momentum-series', qs: `?from=${TODAY}&to=${TODAY}` },
];

// ── the derivation (identical mechanics to mutatingRouteAuthzCoverage.test.ts) ─────────
function mountPrefix(layer: any): string {
  if (typeof layer.path === 'string') return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

function discoverGetRoutes(): string[] {
  const out: string[] = [];
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const p = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        if (layer.route.methods.get) out.push(p || '/');
      } else if (typeof layer.handle === 'function' && Array.isArray((layer.handle as any).stack)) {
        walk((layer.handle as any).stack, prefix + mountPrefix(layer));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out;
}

const ALL_GET_ROUTES = discoverGetRoutes();
/** Server-Sent-Events endpoints never terminate; they are excluded by SHAPE, not by name. */
const SWEEPABLE = ALL_GET_ROUTES.filter(
  (p) => !p.includes(':') && !p.includes('*') && !p.startsWith('/api/events') && !p.includes('stream')
);

/**
 * THE DECLARED INSTRUMENT-NOISE SET — frozen, and a SUPERSET of what any single run
 * measures. Shared by the perturbation property AND the ratchet, because both compare two
 * responses and both are fooled by the same thing.
 *
 * Two samples cannot classify a route whose output depends on HOW MANY REQUESTS have been
 * made or how long they took: `/api/monitoring/*` reports live `responseTime` and request
 * counters that this very sweep moves. Measured self-jitter is checked to be a SUBSET of
 * this list rather than used as the exclusion itself — otherwise the exclusion is decided
 * by sampling luck, which is the "population computed from the code's own behaviour"
 * defect this file exists to avoid.
 *
 * Nothing here returns project rows; that is asserted in RESIDUAL (a).
 */
const RATCHET_EXCLUDED: readonly string[] = [
      '/',
      '/api/feature-flags',
      '/api/health',
      '/api/healthz',
      // Added 2026-08-11 after RESIDUAL (a) went RED on it — which is the assertion
      // working: a newly-jittering route must be decided on, not absorbed. This one
      // relays mcp-server's own liveness payload (routes/mcp.ts:197 ->
      // McpProxyService.forwardHealthz), so it moves on upstream uptime with no
      // perturbation in between, and it takes no project scope. It is in the same
      // class as '/api/healthz' directly above. Listing it here is not a waiver:
      // RESIDUAL (a) hits every FROZEN_VOLATILE route and asserts it carries neither
      // the victim nor the grant marker, so the exclusion buys coverage rather than
      // dropping it.
      '/api/mcp/healthz',
      '/api/livez',
      '/api/readyz',
      '/api/db-status',
      '/api/version',
      '/api/openapi',
      '/api/openapi/openapi.json',
      '/api/openapi/postman.json',
      '/api/monitoring/health',
      '/api/monitoring/metrics',
      '/api/monitoring/trends',
      '/api/monitoring/services',
      '/api/monitoring/stats',
      '/api/monitoring/alerts',
      '/api/monitoring/alert-rules',
      '/api/monitoring/status',
      '/api/monitoring/dashboard',
      '/api/validation/schemas',
      '/api/validation/stats',
      '/api/validation/test/projects',
      '/api/validation/test/tasks',
      '/api/validation/health',
      '/api/type-safety/demo',
      '/api/type-safety/consistency',
      '/api/type-safety/schema-sync',
      '/api/type-safety/health',
];

describeDb('unscoped list reads are confined to the caller\'s projects', () => {
  /**
   * THE APP'S OWN POOL, not a second one. This suite imports `../server`, which opens the
   * shared pool; adding a private `new Pool(contractDbConfig)` on top of it doubled this
   * process's client slots against a throwaway role that carries `CONNECTION LIMIT 40`
   * (scripts/provision-test-db.sh). MEASURED: the full backend suite was GREEN with this
   * file excluded (72 suites / 1089 tests) and produced 6 unrelated DB-suite failures with
   * it included, in a set that MOVED between runs — the tell of exhaustion rather than a
   * data collision. `db` is also what the routes under test read, so the fixtures are
   * guaranteed visible to them.
   */
  const pool = db;
  const tokens: Record<Persona, string> = {} as never;

  beforeAll(async () => {
    await assertDbReachable(pool);

    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    for (const t of ['tasks', 'contexts', 'technical_decisions', 'sessions']) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[P_VICTIM, P_GRANTED]]);
    }
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_VICTIM, P_GRANTED]]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [[U_ADMIN, U_GRANT, U_ZERO]]);

    await pool.query('INSERT INTO projects (id, name, description) VALUES ($1,$2,$3),($4,$5,$6)', [
      P_VICTIM, `victim-${VICTIM_MARK}`, `desc ${VICTIM_MARK}`,
      P_GRANTED, `granted-${GRANT_MARK}`, `desc ${GRANT_MARK}`,
    ]);

    for (const [pid, mark] of [[P_VICTIM, VICTIM_MARK], [P_GRANTED, GRANT_MARK]] as const) {
      await pool.query(
        `INSERT INTO tasks (project_id, title, description, type, status, priority, assigned_to)
         VALUES ($1,$2,$3,'general','todo','medium',$4)`,
        [pid, `task ${mark}`, `d ${mark}`, `actor-${mark}`]
      );
      await pool.query(
        `INSERT INTO tasks (project_id, title, type, status, priority, completed_at, created_at)
         VALUES ($1,$2,'general','completed','medium', NOW() - interval '1 day', NOW() - interval '3 day')`,
        [pid, `done ${mark}`]
      );
      await pool.query(
        `INSERT INTO contexts (project_id, context_type, content, tags) VALUES ($1,'completion',$2,$3)`,
        [pid, `ctx ${mark}`, ['ref:resume', mark]]
      );
      await pool.query(
        `INSERT INTO technical_decisions (project_id, decision_type, title, description, rationale)
         VALUES ($1,'architecture',$2,$3,$4)`,
        [pid, `dec ${mark}`, `d ${mark}`, `r ${mark}`]
      );
      await pool.query(
        `INSERT INTO sessions (project_id, agent_type, display_id, title, context_summary,
                               tokens_used, started_at, ended_at, ai_model)
         VALUES ($1,'claude',$2,$3,$4,100, NOW() - interval '2 hour', NOW() - interval '1 hour', $5)`,
        [pid, `S-${mark.slice(0, 6)}`, `sess ${mark}`, `summary ${mark}`, `model-${mark}`]
      );
    }

    // ASYMMETRIC ON PURPOSE. The first version of this fixture gave both projects the
    // same number of rows, so `/api/tasks/stats` scoped to VICTIM and scoped to GRANTED
    // returned IDENTICAL counts and the derivation below could not tell that endpoint was
    // project-sensitive at all. Equal populations make every count-based detector blind.
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO tasks (project_id, title, type, status, priority)
         VALUES ($1,$2,'general','in_progress','high')`,
        [P_VICTIM, `extra ${VICTIM_MARK} ${i}`]
      );
      await pool.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2)`,
        [P_VICTIM, `extra ctx ${VICTIM_MARK} ${i}`]
      );
      await pool.query(
        `INSERT INTO sessions (project_id, agent_type, display_id, title, tokens_used,
                               started_at, ended_at)
         VALUES ($1,'claude',$2,$3, 250, NOW() - interval '5 hour', NOW() - interval '4 hour')`,
        [P_VICTIM, `SX-${i}`, `extra sess ${VICTIM_MARK} ${i}`]
      );
    }

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active) VALUES
        ($1,'probeadmin','probeadmin@x.test',$4,'admin',true),
        ($2,'probegrant','probegrant@x.test',$4,'user',true),
        ($3,'probezero','probezero@x.test',$4,'user',true)`,
      [U_ADMIN, U_GRANT, U_ZERO, '$2b$04$notarealhashnotarealhashno']
    );
    await pool.query('INSERT INTO user_project_access (user_id, project_id) VALUES ($1,$2)', [
      U_GRANT, P_GRANTED,
    ]);

    for (const [name, id, role] of [
      ['admin', U_ADMIN, 'admin'],
      ['granted', U_GRANT, 'user'],
      ['zero', U_ZERO, 'user'],
    ] as const) {
      const { tokenId } = await AuthService.createSession(id);
      tokens[name] = AuthService.generateJWT(
        { id, username: `probe${name}`, email: `${name}@x.test`, role } as never,
        tokenId
      );
    }
  }, 120000);

  afterAll(async () => {
    // THIS SUITE SHARES ONE DATABASE WITH 73 OTHERS, run in band. Leaving two projects
    // and five rows-per-table behind broke resolveNav.route.db.test.ts, whose
    // short-prefix ambiguity fixture counted the candidates it found. Seeded ids use a
    // dedicated `f0..f4` prefix AND are removed here — both, because either alone is one
    // rename away from colliding again.
    for (const t of ['tasks', 'contexts', 'technical_decisions', 'sessions']) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[P_VICTIM, P_GRANTED]]);
    }
    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_VICTIM, P_GRANTED]]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [[U_ADMIN, U_GRANT, U_ZERO]]);
    // CLOSE THE POOL. An earlier version of this file said "deliberately NOT pool.end() —
    // this is the shared application pool; closing it would break every suite that runs
    // after this one." THAT WAS WRONG, and the repo already disproved it: jest gives each
    // test FILE its own module registry, so `db` is per-file, not shared across files, and
    // browseArchivedExcluded / decisionLinks / contextLinks / momentumSeries /
    // embeddingDatasetsScope all call pool.end() with nothing downstream breaking.
    //
    // The cost of the mistake was not theoretical: with the handle open, jest never exits.
    // the CI gate runs `npx jest --runInBand --ci` with NO `--forceExit`, so the clean
    // gate HUNG for 3h42m holding its lock and produced no verdict. Every local run here
    // had used --forceExit, which masked it exactly.
    await pool.end();
    // AND THE SECOND POOL. `GET /api/healthz` is the only reachable constructor of the
    // lazy `backendPool` singleton (server.ts:9 keeps the direct import commented out), so
    // this sweep — and only this sweep — brings a whole extra pg.Pool into existence. Its
    // idle sockets are live handles, so jest never exits without this.
    //
    // TRACED, not guessed: bisecting the 79-route sweep isolated /api/healthz (with
    // /api/livez beside it exiting cleanly), and adding this line is what made the probe
    // exit. The interval that pool starts was ALSO pinning the loop and is fixed at source
    // in database/poolManager.ts — both were required, neither was sufficient.
    await backendPool.close();
  });

  const hit = async (path: string, persona: Persona, qs = '') => {
    const res = await request(app)
      .get(path + qs)
      .set('Authorization', `Bearer ${tokens[persona]}`);
    const body = typeof res.text === 'string' && res.text ? res.text : JSON.stringify(res.body);
    return { status: res.status, body };
  };

  // ── the population itself is asserted, per an earlier decision ────────────────────────
  /**
   * WALL-CLOCK NORMALIZATION, and the exact reason it is safe here.
   *
   * MEASURED: `/api/contexts/export` and `/api/treewalker/thread` differ from THEMSELVES
   * between two back-to-back requests, purely on an emitted ISO timestamp — as do
   * `/api/version` and `/`. Without this, both of those DATA endpoints fall into the
   * volatile set and drop out of the non-interference property, which is a real coverage
   * hole on two endpoints that carry project rows.
   *
   * This does NOT weaken the anchor. The anchor of this comparison is the row the TEST
   * inserts, not the clock; a scope-blind endpoint changes its ROWS or its COUNTS when the
   * victim project changes, and none of that is an ISO timestamp. The only thing made
   * invisible is a leak whose ENTIRE observable payload is a timestamp — and the `LANDED`
   * assertion below proves the normalization did not eat the signal, by requiring that the
   * admin view of these same endpoints still moves under perturbation.
   */
  const normalize = (body: string): string =>
    body
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>')
      // LIVE ELAPSED TIME. `duration_minutes` for a session with `ended_at IS NULL` is
      // computed from NOW(), so the row changes continuously with NO WRITER INVOLVED.
      //
      // MEASURED, not guessed (the clean gate caught this on `/api/sessions` and the first
      // hypothesis — that Mandrel's session auto-tracking was writing rows on our own
      // requests — was WRONG). Probe: seed one session with no `ended_at`, sweep every
      // route twice 1.5s apart, diff field-by-field. `/api/sessions` drifts on EXACTLY
      // `data.sessions[].duration_minutes` and nothing else; every other drifting route was
      // already in FROZEN_VOLATILE and drifts only on correlationId / responseTime /
      // connection counts. It is intermittent because it needs an ACTIVE session to exist
      // in the shared DB — which depends on which suite ran before this one.
      //
      // It is NORMALISED rather than excluded because excluding it would drop a route this
      // branch just fixed out of the property test — the exact coverage loss the frozen-set
      // assertion exists to prevent. Normalising loses nothing real: a leaked session is a
      // ROW, and its id / title / project_id / display_id are all still compared. The
      // LANDED assertion below requires `/api/sessions` to still move under perturbation,
      // which is the proof this did not eat the signal.
      // ...and the whole DURATION FAMILY, not just the one field name that happened to
      // fail first. `/api/sessions` exposes sub-second precision so it drifts on every
      // sample; the aggregates (`total_duration_minutes`, `avg_duration_minutes`,
      // `averageDuration`) round to integers and only flip when the elapsed time crosses a
      // whole-minute boundary — a rare, non-deterministic version of the SAME cause, which
      // is exactly why they failed the gate and not any local run. Matching on the key
      // substring rather than an enumerated list of names, because enumerating the names I
      // happen to have seen is the mistake this whole task keeps making.
      .replace(/"(\w*[Dd]uration\w*)":\s*"?-?[\d.]+"?/g, '"$1":<elapsed>');

  const hitAll = async (persona: Persona): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const p of SWEEPABLE) out[p] = normalize((await hit(p, persona)).body);
    for (const { path, qs } of PARAMETERISED_QUERY) {
      out[path + qs] = normalize((await hit(path, persona, qs)).body);
    }
    return out;
  };

  const changedBetween = (a: Record<string, string>, b: Record<string, string>): string[] =>
    Object.keys(a).filter((k) => a[k] !== b[k]);

  // ── the population itself is asserted, per an earlier decision ────────────────────────
  it('the NORMALIZER cannot blind the detector: it preserves every identifying value', () => {
    // A GUARD ON THE INSTRUMENT. `normalize()` exists to remove wall-clock jitter, and each
    // widening of it has been justified by a LANDED assertion — but LANDED only requires a
    // response to MOVE, and a response still moves when ids and counts change. Measured: a
    // mutation that additionally blinded title/display_id/project_name/content left all 14
    // tests GREEN. So the property that actually matters is asserted directly here.
    //
    // Everything the detector reads to decide "this is a leak" must survive normalization:
    // the planted markers, and the identifying fields a leaked row would carry.
    const sample = JSON.stringify({
      sessions: [
        {
          id: '11111111-2222-4333-8444-555555555555',
          title: `sess ${VICTIM_MARK}`,
          display_id: 'SS-VICT',
          project_id: P_VICTIM,
          project_name: `victim-${VICTIM_MARK}`,
          content: `ctx ${GRANT_MARK}`,
          duration_minutes: '180.0003815333333333',
          total_duration_minutes: 180,
          created_at: '2026-08-07T21:13:22.367Z',
        },
      ],
      total: 1,
    });
    const out = normalize(sample);

    // The jitter IS removed...
    expect(out).not.toContain('180.0003815333333333');
    expect(out).toContain('<elapsed>');
    expect(out).toContain('<ts>');
    // ...and nothing that identifies a record is.
    for (const kept of [
      VICTIM_MARK,
      GRANT_MARK,
      '11111111-2222-4333-8444-555555555555',
      'SS-VICT',
      P_VICTIM,
      '"total":1',
    ]) {
      expect({ kept, present: out.includes(kept) }).toEqual({ kept, present: true });
    }
  });

  describe('the population', () => {
    it('the derived GET route set is non-empty and contains the known scoped surfaces', () => {
      // NON-EMPTY TRAP. Every assertion below is a for-each over this set; if the walk
      // ever returned nothing, all of them would pass vacuously.
      expect(SWEEPABLE.length).toBeGreaterThan(40);

      // HAND-WRITTEN SNAPSHOT asserted AGAINST the derived set — never used in place of
      // it. If one of these disappears from the walk, the walk is broken, not the list.
      const KNOWN_SCOPED_SURFACES = [
        '/api/tasks',
        '/api/tasks/stats',
        '/api/contexts',
        '/api/contexts/stats',
        '/api/contexts/weekly-velocity',
        '/api/contexts/export',
        '/api/sessions',
        '/api/sessions/current',
        '/api/sessions/summaries',
        '/api/projects',
        '/api/projects/sessions/all',
        '/api/dashboard/stats',
        '/api/treewalker/thread',
        '/api/embedding/list',
      ];
      for (const p of KNOWN_SCOPED_SURFACES) expect(SWEEPABLE).toContain(p);
    });

    it('the parameterised routes named below are really registered', () => {
      for (const p of PARAMETERISED_COVERED_SEPARATELY) expect(ALL_GET_ROUTES).toContain(p);
      for (const { path } of PARAMETERISED_QUERY) expect(SWEEPABLE).toContain(path);
    });
  });

  // ── Q1 / Q2: DIRECT MARKER EVIDENCE. Strongest where it applies, blind to counts. ───
  it('Q1: a ZERO-GRANT non-admin, UNSCOPED, sees NO row from ANY project — every GET route', async () => {
    const leaks: string[] = [];
    for (const p of SWEEPABLE) {
      const res = await hit(p, 'zero');
      if (res.body.includes(VICTIM_MARK) || res.body.includes(GRANT_MARK)) {
        leaks.push(`${p} [${res.status}]`);
      }
    }
    for (const { path, qs } of PARAMETERISED_QUERY) {
      const res = await hit(path, 'zero', qs);
      if (res.body.includes(VICTIM_MARK) || res.body.includes(GRANT_MARK)) {
        leaks.push(`${path}${qs} [${res.status}]`);
      }
    }
    expect(leaks).toEqual([]);
  }, 180000);

  it('Q2: a GRANTED non-admin, UNSCOPED, sees its grant and never the victim', async () => {
    const leaks: string[] = [];
    for (const p of SWEEPABLE) {
      const res = await hit(p, 'granted');
      if (res.body.includes(VICTIM_MARK)) leaks.push(`${p} [${res.status}]`);
    }
    expect(leaks).toEqual([]);
  }, 180000);

  // ── Q3: prove the DETECTOR works before trusting any negative ───────────────────────
  it('Q3: an ADMIN unscoped DOES see both projects (the markers are detectable at all)', async () => {
    const res = await hit('/api/tasks', 'admin');
    expect(res.status).toBe(200);
    // If this ever goes false, every "sees NOTHING" assertion above is unfalsifiable.
    expect(res.body).toContain(VICTIM_MARK);
    expect(res.body).toContain(GRANT_MARK);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════
   * THE NON-INTERFERENCE TEST — perturb the secret, assert the unauthorized views do
   * not move. This is the trust path. Everything else in this file is corroboration.
   * ══════════════════════════════════════════════════════════════════════════════════
   *
   * WHY THE SCOPE-DIFFERENTIAL DETECTOR THAT USED TO LIVE HERE WAS UNSOUND, MEASURED.
   * It derived a PROJECT_SENSITIVE set as `admin@VICTIM != admin@GRANTED` and asserted
   * only over members of that set. A scope-IGNORING mutation makes those two responses
   * EQUAL, so the mutated endpoint DROPS OUT OF THE POPULATION and the assertion never
   * looks at it. Reviewer round 5 demonstrated it:
   *
   *     getWeeklyVelocity(await resolveListScope(req)) -> getWeeklyVelocity(allProjects)
   *     WITH MUTATION: zero-grant GET /api/contexts/weekly-velocity
   *                    -> 200 {"weeklyVelocity":[{"contexts":6,...}]}     <- a real leak
   *     CONTROL:       -> 200 {"weeklyVelocity":[]}
   *     guard verdict under mutation: 9 passed, 9 total                   <- FALSE GREEN
   *
   * A population computed from post-mutation behaviour cannot see a mutation that removes
   * a member from the population. Only the nine-name hand snapshot beside it caught the
   * dashboard mutation, which is precisely what deriving was supposed to make unnecessary.
   *
   * THE FIX THAT WAS ALSO WRONG, and why it is not here: comparing granted-unscoped vs
   * granted-scoped across all routes. `getWeeklyVelocity` takes ONE argument and
   * `scopeWhere(scope, 'project_id', params)` is its ONLY project filter — replace `scope`
   * with a constant and the response stops depending on the request at all, so
   * unscoped == scoped TAUTOLOGICALLY. That moves the self-erasure out of the population
   * and into the predicate; it does not remove it.
   *
   * ── THE GENERALISATION ────────────────────────────────────────────────────────────
   *   Every comparison a guard makes needs at least ONE ANCHOR THE CODE UNDER TEST
   *   CANNOT MOVE. A second request to the same code is not an anchor. A population
   *   derived from the code's own responses is not an anchor. A planted marker is. A
   *   test-controlled WRITE is.
   *
   * So: the test writes rows into the VICTIM project and asserts that no unauthorized
   * view moves. A scope-ignoring endpoint is MAXIMALLY sensitive to victim perturbation —
   * the mutation that erased itself from the derived set is the one that fires loudest
   * here — and no code under test can equalise away a row the test itself inserted.
   */
  describe('non-interference under victim perturbation', () => {
    /**
     * The tables and time ranges this perturbation actually moves. RESIDUAL (b), asserted
     * rather than described: an aggregate over a table absent from this list, or over a
     * date range these rows miss, is NOT covered by this axis until it is added. This is a
     * hand-list — of PERTURBATIONS, where a miss degrades to the marker detector rather
     * than below it, unlike a hand-list of endpoints where a miss is silence.
     */
    const PERTURBED = ['contexts', 'tasks', 'sessions'] as const;

    /**
     * THE DECLARED EXCLUSION SET — frozen, and a SUPERSET of what is measured.
     *
     * Two samples cannot reliably classify a route whose output depends on HOW MANY
     * REQUESTS have been made: `/api/monitoring/stats` scrapes live request counters that
     * this very sweep increments, so it can look stable across one adjacent pair and move
     * across the next. Measured self-jitter is therefore checked to be a SUBSET of this
     * list rather than used as the exclusion itself — otherwise the exclusion would be
     * decided by sampling luck, which is the same "population computed from the code's own
     * behaviour" defect this whole file exists to avoid.
     *
     * Nothing here returns project rows; that is asserted in RESIDUAL (a) below.
     */
    const FROZEN_VOLATILE = RATCHET_EXCLUDED;
    const excluded = (p: string) => FROZEN_VOLATILE.includes(p) || selfJitter.has(p);

    let baselineA: Record<Persona, Record<string, string>>;
    let baselineB: Record<Persona, Record<string, string>>;
    let after: Record<Persona, Record<string, string>>;
    let selfJitter: Set<string>;

    beforeAll(async () => {
      baselineA = { zero: await hitAll('zero'), granted: await hitAll('granted'), admin: await hitAll('admin') };
      baselineB = { zero: await hitAll('zero'), granted: await hitAll('granted'), admin: await hitAll('admin') };

      // VOLATILE = differs from ITSELF with no perturbation in between. Measured, never a
      // name pattern: the first version of this exclusion listed health/monitoring/openapi
      // and was falsified immediately by /api/validation/* and /api/type-safety/*.
      selfJitter = new Set([
        ...changedBetween(baselineA.zero, baselineB.zero),
        ...changedBetween(baselineA.granted, baselineB.granted),
        ...changedBetween(baselineA.admin, baselineB.admin),
      ]);

      // ── THE PERTURBATION ──────────────────────────────────────────────────────────
      // Dated NOW so per-day aggregates (day-summary, momentum-series, throughput,
      // trends, weekly-velocity) move, not just row listings.
      await pool.query(
        // TAGGED `ref:resume` ON PURPOSE. TreeWalker's anchor is "the newest ref:resume
        // context in scope", so an untagged row does not move it and the first version of
        // this perturbation left /api/treewalker/thread unexercised on this axis. Tagged,
        // this row becomes the newest resume anchor ON THE BOX — which is exactly the
        // pre-fix leak that endpoint had.
        `INSERT INTO contexts (project_id, context_type, content, tags, created_at)
         VALUES ($1,'code',$2,$3, NOW())`,
        [P_VICTIM, `PERTURB ${VICTIM_MARK}`, ['ref:resume']]
      );
      await pool.query(
        `INSERT INTO tasks (project_id, title, type, status, priority, created_at, completed_at)
         VALUES ($1,$2,'general','completed','high', NOW() - interval '2 day', NOW())`,
        [P_VICTIM, `PERTURB ${VICTIM_MARK}`]
      );
      await pool.query(
        `INSERT INTO sessions (project_id, agent_type, display_id, title, tokens_used,
                               started_at, ended_at, last_activity_at)
         VALUES ($1,'claude',$2,$3, 999, NOW() - interval '10 minute', NOW(), NOW())`,
        [P_VICTIM, 'SPERTURB', `PERTURB ${VICTIM_MARK}`]
      );

      after = { zero: await hitAll('zero'), granted: await hitAll('granted'), admin: await hitAll('admin') };
    }, 300000);

    it('CONTROL: with NO perturbation, repeated sweeps are byte-stable outside the measured volatile set', () => {
      const unstable = changedBetween(baselineA.zero, baselineB.zero).filter((p) => !excluded(p));
      expect(unstable).toEqual([]);
      // NON-EMPTY TRAP on the comparison itself: if the sweep returned nothing, or every
      // route were volatile, the assertion above would be vacuous.
      const compared = SWEEPABLE.filter((p) => !excluded(p));
      expect(compared.length).toBeGreaterThan(20);
    });

    it('LANDED: the perturbation is VISIBLE to the authorized view (admin)', () => {
      // Without this, every negative below is vacuous — an INSERT that failed silently, or
      // a set of endpoints that ignore these tables, would produce "nothing moved" for
      // every persona and read as a pass.
      const movedForAdmin = changedBetween(baselineB.admin, after.admin).filter((p) => !excluded(p));
      expect(movedForAdmin.length).toBeGreaterThan(8);
      // And it moved the COUNT-ONLY surfaces specifically — the ones no marker can reach,
      // which are the whole reason this axis exists.
      for (const p of ['/api/dashboard/stats', '/api/contexts/weekly-velocity', '/api/tasks/stats']) {
        expect(movedForAdmin).toContain(p);
      }
      // And the two endpoints the timestamp normalization rescued from the volatile set
      // still carry a live signal through it — proof the normalization removed jitter and
      // not the thing being measured.
      for (const p of ['/api/contexts/export', '/api/treewalker/thread']) {
        expect(movedForAdmin).toContain(p);
      }
      // `/api/sessions` specifically: `duration_minutes` is normalised away above, so this
      // is the assertion that the route still carries a live signal through the
      // normalization instead of being silently inert.
      expect(movedForAdmin).toContain('/api/sessions');
      // The duration family is normalised away above, so these are the assertions that the
      // session aggregates still carry a live signal through it rather than going inert.
      for (const p of ['/api/sessions/trends', '/api/sessions/stats-by-period', '/api/sessions/analytics']) {
        expect(movedForAdmin).toContain(p);
      }
    });

    it('THE PROPERTY: a ZERO-GRANT view does not move when the victim project changes', () => {
      const moved = changedBetween(baselineB.zero, after.zero).filter((p) => !excluded(p));
      expect(moved).toEqual([]);
    });

    it('THE PROPERTY: a GRANTED view does not move when a project it lacks changes', () => {
      const moved = changedBetween(baselineB.granted, after.granted).filter((p) => !excluded(p));
      expect(moved).toEqual([]);
    });

    /**
     * RESIDUAL (a), ASSERTED. Routes excluded from the diff for self-jitter are invisible
     * to this axis — including, honestly, a volatile endpoint that leaks a COUNT, which
     * the marker check below cannot see either. The exclusion is therefore FROZEN: a
     * newly-volatile route fails here and forces a deliberate decision instead of quietly
     * dropping out of coverage.
     */
    it('RESIDUAL (a): measured jitter stays inside the frozen exclusion, which carries no project rows', async () => {
      // Frozen ⊇ measured, in ONE direction on purpose: a route that stops jittering
      // simply gains coverage, which never needs a code change to stay honest. A route
      // that STARTS jittering fails here and forces a deliberate decision instead of
      // quietly dropping out of the property test.
      expect([...selfJitter].filter((p) => !FROZEN_VOLATILE.includes(p))).toEqual([]);

      // What CAN still be said about the excluded set: none of it carries project rows.
      // This is MARKER-based and therefore CANNOT see a volatile endpoint that leaks only
      // a COUNT. That hole is real, is the reason the list is frozen rather than derived,
      // and is not claimed to be closed.
      for (const p of FROZEN_VOLATILE) {
        const res = await hit(p, 'admin');
        expect({ route: p, leaks: res.body.includes(VICTIM_MARK) || res.body.includes(GRANT_MARK) })
          .toEqual({ route: p, leaks: false });
      }
    }, 120000);

    it('RESIDUAL (b): the perturbation touches exactly the tables named, and each one landed', async () => {
      for (const table of PERTURBED) {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id = $1 AND title_or_content LIKE $2`
            .replace('title_or_content', table === 'contexts' ? 'content' : 'title'),
          [P_VICTIM, `PERTURB %`]
        );
        expect({ table, n: rows[0].n }).toEqual({ table, n: 1 });
      }
    });
  });

  /**
   * THE DERIVATION, DEMOTED TO A DRIFT ALARM. It is no longer the trust path — it cannot
   * be, for the self-erasure reason in the block above — but frozen equality in BOTH
   * directions still catches a NEW project-sensitive endpoint appearing (fails: derived
   * has a member frozen lacks) and an existing one silently going scope-blind (fails:
   * frozen has a member derived lacks). Either way a human updates the snapshot on purpose.
   */
  it('RATCHET: the scope-sensitive endpoint set equals its frozen snapshot, both directions', async () => {
    const withScope = (p: string, projectId: string) =>
      p + (p.includes('?') ? '&' : '?') + 'project_id=' + projectId;

    const derived: string[] = [];
    // THE SAME 2-SAMPLE TRAP THE PROPERTY TEST ALREADY SOLVED, and this loop still had it.
    // `/api/monitoring/services` reports a live `responseTime`; two adjacent samples can
    // agree by luck and a third disagree, which puts an instrument-noise route into the
    // "scope-sensitive" set and fails the ratchet at random. Measured: one gate run flagged
    // exactly that route. The declared exclusion is the fix here too.
    const candidates = [
      ...SWEEPABLE.filter((p) => !RATCHET_EXCLUDED.includes(p)),
      ...PARAMETERISED_QUERY.map(({ path, qs }) => path + qs),
    ];
    for (const p of candidates) {
      // Same wall-clock normalization as the property sweep — without it
      // /api/contexts/export and /api/treewalker/thread look self-unstable and silently
      // leave this ratchet's population, which is the exact self-erasure this file is
      // about, one level up.
      const a1 = await hit(withScope(p, P_VICTIM), 'admin');
      const a2 = await hit(withScope(p, P_VICTIM), 'admin');
      if (a1.status !== 200 || normalize(a1.body) !== normalize(a2.body)) continue;
      const b = await hit(withScope(p, P_GRANTED), 'admin');
      if (b.status === 200 && normalize(a1.body) !== normalize(b.body)) derived.push(p);
    }

    const FROZEN_SENSITIVE = [
      '/api/contexts',
      '/api/contexts/stats',
      '/api/contexts/weekly-velocity',
      '/api/contexts/export',
      '/api/projects',
      '/api/projects/stats',
      '/api/projects/sessions/all',
      '/api/sessions/current',
      '/api/sessions/stats',
      '/api/sessions',
      '/api/sessions/analytics',
      '/api/sessions/trends',
      // Contexts grouped by the owning session's actor. Project-
      // sensitive for the same reason /api/tasks/completed-by-actor is: it enumerates WHO
      // produced work inside a project, and its coverage totals count that project's rows.
      '/api/sessions/contexts-by-actor',
      '/api/sessions/token-patterns',
      '/api/sessions/summaries',
      '/api/sessions/stats-by-period',
      '/api/tasks',
      '/api/tasks/stats',
      '/api/tasks/lead-time',
      '/api/tasks/throughput',
      '/api/tasks/completed-by-actor',
      // Assignee suggestions. Project-sensitive because it
      // enumerates WHO has worked in a project — session actors and task assignees.
      '/api/tasks/actor-options',
      '/api/dashboard/stats',
      '/api/treewalker/thread',
      '/api/v2/sessions/current',
      // The embedding analytics REFUSE to run unscoped (400) and so never appear on the
      // unscoped axis at all; scoped, they are project-sensitive like everything else.
      '/api/embedding/relationships',
      '/api/embedding/knowledge-gaps',
      '/api/embedding/usage',
      `/api/day-summary?date=${TODAY}`,
      `/api/momentum-series?from=${TODAY}&to=${TODAY}`,
    ];
    expect([...derived].sort()).toEqual([...FROZEN_SENSITIVE].sort());
  }, 240000);

  it('Q4: a GRANTED non-admin scoping EXPLICITLY still gets its rows (no deny-everyone fix)', async () => {
    // Runs over the FROZEN set, not a derived one: the population of a test that must fail
    // when everything is denied cannot itself be computed from the code's answers.
    const FROZEN_MUST_STILL_WORK = [
      '/api/tasks',
      '/api/tasks/stats',
      '/api/contexts',
      '/api/contexts/stats',
      '/api/sessions',
      '/api/sessions/summaries',
      '/api/projects',
      '/api/dashboard/stats',
    ];
    const broken: string[] = [];
    for (const p of FROZEN_MUST_STILL_WORK) {
      const sep = p.includes('?') ? '&' : '?';
      const scoped = await hit(p, 'granted', `${sep}project_id=${P_GRANTED}`);
      const admin = await hit(p, 'admin', `${sep}project_id=${P_GRANTED}`);
      if (scoped.status !== 200 || scoped.body !== admin.body) broken.push(`${p} [${scoped.status}]`);
    }
    expect(broken).toEqual([]);
    // And the data is really there — a byte-equal pair of EMPTY responses would pass above.
    const tasks = await hit('/api/tasks', 'granted', `?project_id=${P_GRANTED}`);
    expect(tasks.body).toContain(GRANT_MARK);
  }, 120000);

  // ── the path-param family ──────────────────────────────────────────────────────────
  it('a project id in the PATH is authorized (403), not merely uuid-shape-checked', async () => {
    for (const p of PARAMETERISED_COVERED_SEPARATELY) {
      const path = p.replace(':id', P_VICTIM);
      const zero = await hit(path, 'zero');
      expect([403]).toContain(zero.status);
      expect(zero.body).not.toContain(VICTIM_MARK);

      const ok = await hit(p.replace(':id', P_GRANTED), 'granted');
      expect(ok.status).toBe(200);
    }
  }, 60000);
});
