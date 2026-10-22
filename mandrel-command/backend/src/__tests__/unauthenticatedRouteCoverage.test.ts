/**
 * unauthenticatedRouteCoverage.test.ts — the WHOLE-CLASS guard for an earlier task and
 * ecb37d02: **no route reaches customers without a credential unless somebody wrote down
 * why.**
 *
 * ## What was actually wrong
 *
 * Seven routes were 200-with-no-credential on prod and all seven tenants —
 * `POST /api/git/push-stats` (a state-changing WRITE), `/api/db-status` (postgres version
 * + live pool internals), `/api/version` (node version + NODE_ENV), `/api/health`
 * (`process.memoryUsage()` + NODE_ENV), `/api/healthz` (pool internals + heap figures),
 * and the whole `/api/openapi/*` family (the complete API map). Two more,
 * `GET /` and `GET /api/feature-flags`, were open and undeclared.
 *
 * Fixing seven routes fixes seven routes. This file is the part that makes the eighth
 * impossible to ship quietly.
 *
 * ## The rule
 *
 * For EVERY route the app serves, of EVERY verb, one of two things must be true:
 *
 *   (a) an ENFORCING classification (`admin` / `authenticated`) is in its effective
 *       chain — own handlers or an enclosing `router.use(...)`, because
 *       `router.use(authenticateToken)` genuinely does refuse every request beneath it; or
 *   (b) the route itself carries `declareIntentionallyUnauthenticated('why')`.
 *
 * There is no third option, no allow-list to append to, and no name pattern to match.
 * A route this file has never heard of is a FAILURE, not a pass.
 *
 * ## Why this is not `mutatingRouteAuthzCoverage`
 *
 * That file requires a ROUTE-LEVEL classification on state-changing verbs, and inheritance
 * deliberately does not satisfy it — one `router.use(declareAnyAuthenticatedMayWrite(…))`
 * would otherwise mute a whole router in a line. Different question, so a different rule
 * over the SAME walk (`helpers/routeCensus.ts`). "Who may WRITE" and "is this reachable
 * anonymously" are not the same property, and collapsing them is how the second one went
 * unasked for the life of the repo.
 *
 * The previous Builder on ecb37d02 explicitly declined to widen the mutating guard to all
 * pre-auth GETs, reasoning that it would make the health family illegal on day one and
 * force edits into another Builder's in-flight files — "a guard that blocks correct work
 * mid-flight gets reverted." That judgement was right and it is why this file could only
 * be written AFTER the policy for the health family was decided (see routes/health.ts).
 * The guard now matches a policy instead of demanding exemptions.
 *
 * ## The part that stops this from being a paperwork guard
 *
 * (a) is satisfied by a DECLARATION — `markAuthenticator(fn, 'why')` — and a declaration
 * can lie. So the last describe below takes every distinct handler that claims
 * `kind: 'authenticated'` ANYWHERE on the served surface, drives it with a real
 * credential-free request, and requires a 401. A passthrough wearing an authenticator's
 * mark is RED there. The population is derived from the walk, so a fourth authenticator
 * written next month is probed automatically.
 *
 * ## Mutation probes (run 2026-08-25, output in the task report)
 *   • drop `authenticateToken` from routes/openapi.ts       → RED, naming 4 routes
 *   • drop the marker from routes/health.ts's `/livez`      → RED, naming GET /api/livez
 *   • strip `markAuthenticator` off `authenticateToken`     → RED, naming ~150 routes
 *   • make a marked authenticator a passthrough             → RED in the behavioural probe
 *   • unmutated control                                     → GREEN
 *
 * DB-free: the app is imported for its SHAPE, and the authenticator probe drives only the
 * middleware, never a handler.
 */

import express, { Router, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';
import {
  AuthzClassification,
  readAuthzClassification,
  markAuthenticator,
  declareIntentionallyUnauthenticated,
  isEnforcing,
} from '../middleware/authz';
import { discoverRoutes, DiscoveredRoute } from './helpers/routeCensus';

// The ONLY module-load side effect in server.ts; see mutatingRouteAuthzCoverage.test.ts.
// It registers, reorders and classifies exactly nothing.
jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

import app from '../server';

const allRoutes = discoverRoutes(app);

const isCovered = (r: DiscoveredRoute): boolean =>
  isEnforcing(r.enforcedBy) || r.classification?.kind === 'unauthenticated';

const label = (r: DiscoveredRoute): string => `${r.method} ${r.path}`;

describe('every served route is credential-gated or declared public', () => {
  it('the walk actually found the app — an empty population would pass everything vacuously', () => {
    // CLASSES.md C3: probe the empty population. Every assertion below iterates
    // `allRoutes`. If the walk broke (an Express upgrade renaming `_router`, an import
    // failing soft) this file would report green while checking nothing.
    expect(allRoutes.length).toBeGreaterThan(100);
    // and it reaches OUTSIDE the /api aggregator, where two of the nine open routes lived
    expect(allRoutes.map(label)).toEqual(
      expect.arrayContaining(['GET /', 'GET /api/feature-flags'])
    );
  });

  it('DENY BY DEFAULT: no route is reachable without a credential unless it says so', () => {
    const uncovered = allRoutes.filter((r) => !isCovered(r));

    // The message is the product here: whoever adds route number 168 reads THIS.
    const detail = uncovered
      .map((r) => `  ${r.method.padEnd(6)} ${r.path}\n      chain: ${r.chainNames.join(' → ')}`)
      .join('\n');

    expect(
      uncovered.length === 0
        ? ''
        : `\n${uncovered.length} route(s) are reachable with NO credential and carry no decision:\n${detail}\n\n` +
            'Every route the app serves must be one of:\n' +
            '  • behind an authenticator      — authenticateToken / ensureAuthForSse /\n' +
            '                                   authenticateAgentOrUser, on the route or on an\n' +
            '                                   enclosing router.use(...)\n' +
            "  • declareIntentionallyUnauthenticated('why')  — at the route, saying WHO calls it\n" +
            '                                                 anonymously and what it does NOT leak\n\n' +
            'If you wrote a NEW authenticator, mark it: markAuthenticator(fn, "why").\n' +
            'This guard has no allow-list. See src/middleware/authz.ts.\n'
    ).toBe('');
  });

  it('every public declaration carries a non-blank written reason', () => {
    const open = allRoutes.filter((r) => r.classification?.kind === 'unauthenticated');
    expect(open.filter((r) => !r.classification!.reason.trim()).map(label)).toEqual([]);
  });

  it('PINS the public surface — adding to it is a visible diff in a security test', () => {
    // Not the gate (the deny-by-default test above is). This pins the smallest and most
    // dangerous bucket so that opening route number ten cannot be one more green run.
    // Each entry's justification lives at the route, next to the code.
    const open = allRoutes.filter((r) => r.classification?.kind === 'unauthenticated');
    expect(open.map(label).sort()).toEqual([
      'GET /',                    // reduced banner: no version, no build detail
      'GET /api/feature-flags',   // uptime probes + the SPA reads it pre-login
      'GET /api/health',          // docker-compose healthcheck + fleet-deploy/prod-rollback smoke
      'GET /api/healthz',         // readiness prober, reduced to per-check up/down
      'GET /api/livez',           // liveness prober
      'GET /api/readyz',          // readiness prober, reduced to ready/not-ready
      'POST /api/auth/login',     // you cannot authenticate to the authentication endpoint
    ]);
  });

  it('ANCHOR — POST /api/git/push-stats is no longer an unauthenticated WRITE', () => {
    // The specific hole an earlier task was filed for: the only state-changing route on the
    // whole surface anyone on the internet could call. Asserted on kind === 'authenticated'
    // rather than "has a classification", so swapping the middleware back for a declare*
    // marker is RED too.
    const route = allRoutes.find((r) => label(r) === 'POST /api/git/push-stats');
    expect(route).toBeDefined();
    expect(route!.enforcedBy?.kind).toBe('authenticated');
    expect(route!.classification?.kind).not.toBe('unauthenticated');
  });

  it('ANCHOR — the infra-metadata routes from ecb37d02 all require a credential', () => {
    // These were each measured at HTTP 200 with no credential on prod and all 7 tenants.
    const mustBeGated = [
      'GET /api/db-status',
      'GET /api/version',
      'GET /api/openapi',
      'GET /api/openapi/openapi.json',
      'GET /api/openapi/postman.json',
      'GET /api/openapi/docs',
    ];
    const gated = allRoutes.filter((r) => mustBeGated.includes(label(r)) && isEnforcing(r.enforcedBy));
    expect(gated.map(label).sort()).toEqual([...mustBeGated].sort());
  });

  it('ANCHOR — the SSE family is covered by ensureAuthForSse, which a NAME sweep missed', () => {
    // Worth pinning: the first census keyed on `authenticateToken` in the chain and
    // reported these three as OPEN. They never were. The correction is the reason
    // authenticators are read from a MARK and not from a name.
    const sse = ['GET /api/events', 'GET /api/events/stats', 'GET /api/events/clients'];
    const covered = allRoutes.filter((r) => sse.includes(label(r)) && isEnforcing(r.enforcedBy));
    expect(covered.map(label).sort()).toEqual([...sse].sort());
    expect(covered.every((r) => r.chainNames.includes('ensureAuthForSse'))).toBe(true);
  });

  it('the public surface is a small MINORITY of the whole one (a sanity check on magnitude)', () => {
    // A too-SMALL count reads as "clean" and is the dangerous failure mode. If a future
    // refactor made `isCovered` return true for everything, the deny test would go green
    // and this would not: the open bucket must stay non-empty (login must be reachable)
    // and tiny.
    const open = allRoutes.filter((r) => r.classification?.kind === 'unauthenticated');
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan(allRoutes.length / 10);
  });
});

describe('the LIVE OpenAPI spec does not contradict the census on who needs a credential', () => {
  /**
   * A partial fold-in of and its LIMITS are stated rather than implied.
   *
   * WHAT THIS COVERS: the spec `routes/openapi.ts` actually serves, built by swagger-jsdoc
   * from the annotations in `routes/*.ts`. `config/openapi` sets a GLOBAL
   * `security: [{bearerAuth: []}]`, so an operation that is reachable anonymously
   * contradicts the shipped artifact unless it overrides with `security: []`. Measured
   * 2026-08-25: `POST /auth/login` did exactly that — the spec told customers, and told
   * every generated client, that the LOGIN endpoint needs a bearer token.
   *
   * WHAT THIS DOES NOT COVER, and why it is not silently narrower than it looks: only 3 of
   * the app's 167 routes and only 1 of its 7 anonymous routes are DOCUMENTED at all, so a
   * "for every public route" loop here would iterate a one-member population and read as
   * far stronger than it is. It is written as a named assertion for that reason.
   *
   * ee74cd4d proper — drift between the annotations, the checked-in
   * `frontend/.openapi/openapi.json`, and the generated client — is NOT closed by this and
   * cannot be closed from inside `routes/**`: its own preferred fix is to generate both
   * artifacts at build time and delete the checked-in copies, which spans the frontend
   * generator and CI.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spec = require('../config/openapi').default as any;

  it('the spec is non-empty and its GLOBAL default demands a credential', () => {
    // An empty spec, or a global `security: []`, would satisfy every claim below
    // vacuously — and the second one would mean the artifact says the whole API is open.
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(20);
    expect(Array.isArray(spec.security)).toBe(true);
    expect(spec.security.length).toBeGreaterThan(0);
    expect(spec.security.every((req: any) => Object.keys(req).length > 0)).toBe(true);
  });

  it('every security scheme an operation NAMES actually exists in components', () => {
    /**
     * The real class behind a `security` annotation: a scheme name that resolves to
     * nothing documents NO authentication at all, while reading exactly like it documents
     * some. A generated client attaches nothing and a customer is told nothing true.
     *
     * Population: every operation-level and global `security` requirement in the whole
     * live spec — 70 operations as of 2026-08-25 — not a list anybody maintains.
     * (This is how the duplicate `bearerAuth` / `BearerAuth` schemes were found: both
     * are defined, so nothing is broken, but the two-copies-of-one-truth is real. Noted
     * for ee74cd4d rather than churned here.)
     */
    const defined = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
    expect(defined.size).toBeGreaterThan(0);

    const named: string[] = [];
    const collect = (reqs: any) => {
      for (const req of reqs ?? []) named.push(...Object.keys(req));
    };
    collect(spec.security);
    for (const ops of Object.values<any>(spec.paths ?? {})) {
      for (const op of Object.values<any>(ops)) {
        if (op && typeof op === 'object') collect(op.security);
      }
    }
    expect(named.length).toBeGreaterThan(0); // not a vacuous sweep
    expect([...new Set(named)].filter((n) => !defined.has(n))).toEqual([]);
  });

  it('POST /auth/login is documented as needing NO credential, matching the route', () => {
    const census = allRoutes.find((r) => label(r) === 'POST /api/auth/login');
    expect(census?.classification?.kind).toBe('unauthenticated');
    expect(spec.paths['/auth/login'].post.security).toEqual([]);
  });

  it('GET /openapi.json is NOT documented as anonymous — it now requires a credential', () => {
    // The mirror direction: a `security: []` left behind on a route that was CLOSED is the
    // exact defect ee74cd4d was filed for.
    expect(spec.paths['/openapi.json'].get.security).toBeUndefined();
  });
});

describe('the RULE fails closed on shapes it has not seen', () => {
  /**
   * A FRESH handler per use, never a shared one. `classifyAuthz` defines a non-writable,
   * non-configurable own property on the function object, so marking a shared handler
   * mutates it for every later test and the second mark THROWS. (That throw is a feature —
   * a classification cannot be silently re-stated — and it is why this is a factory.)
   */
  const bare = (): RequestHandler => (_req, _res, next) => next();

  it('an unclassified GET in a hand-built router is NOT covered', () => {
    const r = Router();
    r.get('/anything', bare());
    expect(discoverRoutes(r).every(isCovered)).toBe(false);
  });

  it('an INHERITED authenticator DOES cover — router.use(auth) really does refuse', () => {
    const inner = Router();
    inner.use(markAuthenticator(bare(), 'test authenticator'));
    inner.get('/deep', bare());
    const outer = Router();
    outer.use('/x', inner);
    const found = discoverRoutes(outer);
    expect(found.map((f) => f.path)).toEqual(['/x/deep']);
    expect(found.every(isCovered)).toBe(true);
  });

  it('an authenticator registered AFTER a route does NOT cover that route', () => {
    // Express dispatches in registration order; a `use` below a route never runs for it.
    const r = Router();
    r.get('/early', bare());
    r.use(markAuthenticator(bare(), 'registered too late to protect /early'));
    r.get('/late', bare());
    const found = discoverRoutes(r);
    expect(isCovered(found.find((f) => f.path === '/early')!)).toBe(false);
    expect(isCovered(found.find((f) => f.path === '/late')!)).toBe(true);
  });

  it('an INHERITED public declaration does NOT cover — no blanket mute', () => {
    // The mirror of the mutating guard's N1 hole, for reads. One
    // `router.use(declareIntentionallyUnauthenticated(...))` must not open a whole router.
    const r = Router();
    r.use(declareIntentionallyUnauthenticated('blanket mute attempt'));
    r.get('/x', bare());
    const found = discoverRoutes(r);
    expect(found[0].classification).toBeUndefined();
    expect(found[0].inheritedClassification?.kind).toBe('unauthenticated');
    expect(isCovered(found[0])).toBe(false);
  });

  it('an unrecognised classification value is not treated as enforcing', () => {
    // The ABSENT/unknown population: whatever a future edit or a duplicate module realm
    // hands `isEnforcing`, only the two enforcing kinds may return true.
    expect(isEnforcing(undefined)).toBe(false);
    expect(isEnforcing({ kind: 'nonsense' as any, reason: 'x' })).toBe(false);
    expect(isEnforcing({ kind: 'unauthenticated', reason: 'x' })).toBe(false);
    expect(isEnforcing({ kind: 'any-authenticated', reason: 'x' })).toBe(false);
    expect(isEnforcing({ kind: 'authenticated', reason: 'x' })).toBe(true);
    expect(isEnforcing({ kind: 'admin', reason: 'x' })).toBe(true);
  });

  it('an empty router yields an empty population — which is why the magnitude checks exist', () => {
    expect(discoverRoutes(Router())).toEqual([]);
  });
});

describe('a marked authenticator must actually REFUSE — the mark is driven, not read', () => {
  /**
   * The population: every DISTINCT handler carrying `kind: 'authenticated'` anywhere on
   * the served surface, taken from the walk. Not a list — write a fourth authenticator and
   * it is probed the day it is mounted.
   */
  const authenticators = new Map<RequestHandler, AuthzClassification>();
  for (const route of allRoutes) {
    for (const h of route.chain) {
      const c = readAuthzClassification(h);
      if (c?.kind === 'authenticated') authenticators.set(h, c);
    }
  }
  const cases = [...authenticators.entries()].map(([fn, c]) => [fn.name || '<anonymous>', fn, c] as const);

  it('the probe population is not empty — an empty one would pass every claim vacuously', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.map(([n]) => n).sort()).toEqual([
      'authenticateAgentOrUser',
      'authenticateToken',
      'ensureAuthForSse',
    ]);
  });

  it.each(cases)(
    '%s refuses a request that presents no credential at all',
    async (_name, fn) => {
      // Driven, not inspected. A passthrough wearing this mark reaches `reached` and the
      // status is 200 — which is exactly the lie this test exists to catch.
      const probe = express();
      probe.use(express.json());
      probe.get('/probe', fn as RequestHandler, (_req: Request, res: Response) =>
        res.status(200).json({ reached: true })
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      probe.use((err: any, _req: Request, res: Response, _next: NextFunction) =>
        res.status(500).json({ error: String(err) })
      );

      const res = await request(probe).get('/probe');
      expect(res.status).toBe(401);
      expect(res.body?.reached).toBeUndefined();
    }
  );

  it.each(cases)('%s refuses a garbage bearer token too', async (_name, fn) => {
    const probe = express();
    probe.get('/probe', fn as RequestHandler, (_req: Request, res: Response) =>
      res.status(200).json({ reached: true })
    );
    const res = await request(probe)
      .get('/probe')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body?.reached).toBeUndefined();
  });
});
