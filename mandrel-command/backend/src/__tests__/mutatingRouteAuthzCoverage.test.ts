/**
 * mutatingRouteAuthzCoverage.test.ts — the WHOLE-CLASS guard for an earlier task.
 *
 * ## What this guards
 *
 * `DELETE /api/projects/:id` shipped for the life of this repo with `authenticateToken`
 * only, so any authenticated user of any role could cascade-delete a project across 24
 * tables. `requireAdmin` existed the whole time and was used on ONE route.
 *
 * Putting `requireAdmin` on that route fixes that route. This file is the part that makes
 * the NEXT one impossible to ship silently.
 *
 * ## The population, and why it is the whole one
 *
 * The population is **every route registered with a state-changing HTTP verb
 * (POST/PUT/PATCH/DELETE) on the real Express `app` exported by `src/server.ts`** — read
 * out of Express's own `app._router.stack` at runtime and walked recursively through every
 * mounted sub-router.
 *
 * THE WALK NOW LIVES IN `helpers/routeCensus.ts` and is SHARED
 * with `unauthenticatedRouteCoverage.test.ts`, which enforces the all-verb rule over the
 * same enumeration. It was extracted rather than copied because two copies of a walk are
 * two populations that can disagree, and a guard whose population silently shrinks is this
 * file's entire subject. The rule below is unchanged; only where the walk is defined moved.
 *
 * THE APP, NOT THE AGGREGATOR. This is the correction that matters, and the first version
 * of this file got it wrong. It walked `routes/index.ts` and asserted "routes/index.ts is
 * the single aggregator server.ts mounts at /api, so a handler that is reachable is in this
 * walk by construction." **Both halves of that were false.** `server.ts` mounts three more
 * things directly on `app`:
 *
 *     server.ts:82   app.use('/api/resolve', resolveJsonRoutes)   ← NOT in the aggregator
 *     server.ts:92   app.use('/r', resolveRoutes)
 *     server.ts:39   app.get('/api/feature-flags', ...)
 *
 * `routes/resolveJson.ts` is imported ONLY by server.ts, so the aggregator walk could never
 * see it. Reviewer proved the consequence by adding a reachable, unclassified
 * `DELETE /api/resolve/:id/purge`: the old guard reported "18 passed, 0 unclassified" and
 * let it through — the exact acceptance criterion ("must fail closed on a route it does not
 * recognise") inverted. No live hole existed, because both outside routers are GET-only;
 * what was wrong was the RULE, and a rule that is wrong by one `app.use` is the whole
 * failure class this task is about (CLASSES.md C3: name your guard's population and say why
 * it is the whole one).
 *
 * Walking `app` is the fix rather than "hoist resolveJson into the aggregator" or "assert
 * nothing else is mounted under /api", because both of those leave the guard measuring a
 * PROXY for the served surface and need their own guard to stay true. `app._router` IS the
 * served surface: whatever Express will route, this walk sees, including a top-level mount
 * added tomorrow and including paths outside `/api` such as `/r`.
 *
 * ## Why importing server.ts is safe here (and why it looked impossible)
 *
 * `server.ts:212` only calls `startServer()` under `require.main === module`, so importing
 * it binds routes without opening a port or a database. It has exactly ONE module-load side
 * effect — `ensureFeatureFlags()` at line 37 — and left real that call makes this suite time
 * out (measured at 200s). It is mocked below. It touches NOTHING about routing: no route is
 * registered, reordered or classified by it, so the shape under test is untouched. That is
 * the entire mock surface for the population walk.
 *
 * ## Fail-closed
 *
 * The rule is DENY by default: a mutating route with no authz classification FAILS, and the
 * failure names the exact method + path. There is no allow-list to add to and no name
 * pattern to match — the only way to a green test is to put a classification at the route
 * (`requireAdmin`, `declareAnyAuthenticatedMayWrite('why')`, or
 * `declareIntentionallyUnauthenticated('why')`). A route this file has never heard of is a
 * failure, not a pass.
 *
 * A classification is counted ONLY when it sits in the route's own handler list. One
 * `router.use(declareAnyAuthenticatedMayWrite('...'))` at the top of a router would
 * otherwise silence every route beneath it in a single line — a blanket mute is precisely
 * the shape this guard exists to prevent, so an inherited classification is reported as a
 * FAILURE with its own message rather than accepted.
 *
 * ## Mutation probe
 *
 * Delete `requireAdmin` from `routes/projects.ts` → the `DELETE /projects/:id` anchor test
 * goes RED (it asserts the classification is specifically `admin`, so downgrading it to a
 * `declare*` marker is also RED). Delete any `declare*` marker, add a new mutating route
 * anywhere — including in a router mounted outside the aggregator — or try to silence the
 * suite with a router-level marker → the coverage test goes RED naming the route. All four
 * were exercised; see the task report.
 *
 * DB-free: the app is imported for its SHAPE only. No handler is invoked.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RequestHandler } from 'express';
import {
  AUTHZ_CLASSIFICATION,
  AuthzKind,
  classifyAuthz,
  readAuthzClassification,
  declareAnyAuthenticatedMayWrite,
  declareIntentionallyUnauthenticated,
  ALL_AUTHZ_KINDS,
} from '../middleware/authz';
// ONE walk, shared with unauthenticatedRouteCoverage.test.ts. See the header note.
import { discoverRoutes, isMutating } from './helpers/routeCensus';

// The ONLY module-load side effect in server.ts. Real, this suite times out at 200s.
// Mocked, it registers/reorders/classifies exactly nothing — see the header note.
jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

// THE SERVED SURFACE. Not routes/index.ts — see "THE APP, NOT THE AGGREGATOR" above.
import app from '../server';

const allRoutes = discoverRoutes(app);
const mutatingRoutes = allRoutes.filter(isMutating);

/**
 * An INDEPENDENT count of state-changing route registrations, read from the route source
 * files rather than from the router the walk just produced.
 *
 * This exists because a floor like `expect(count).toBeGreaterThan(40)` is not a measurement
 * — nine routes could vanish from the walk and it would still pass. Deriving the floor from
 * the same source the product is built out of means the walk has to keep up with the code:
 * add a route and this number rises on its own; lose routes from the walk and the assertion
 * fails without anyone tuning a constant (CLASSES.md C4 — never hardcode a config-derived
 * value in a test).
 *
 * `>=` rather than `===` is deliberate and not a fudge: `routes/resolve.ts` is mounted
 * TWICE (`/api/r` and `/r`), so the served surface legitimately contains more route
 * instances than there are registration sites.
 */
function countMutatingRegistrationsInSource(): number {
  const routesDir = path.join(__dirname, '..', 'routes');
  const re = /router\s*\.\s*(post|put|patch|delete)\s*\(/g;
  let total = 0;
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    total += (src.match(re) ?? []).length;
  }
  return total;
}

const sourceMutatingCount = countMutatingRegistrationsInSource();

describe('authz coverage over the REAL served app', () => {
  it('the walk reaches the whole SERVED surface, not just the /api aggregator', () => {
    // The blocker this file was rejected for. `routes/resolveJson.ts` is mounted at
    // server.ts:82 and is unreachable from routes/index.ts, so a walk of the aggregator
    // could never see it. Asserting a route from OUTSIDE the aggregator is present is what
    // stops this file from silently narrowing back to the aggregator later.
    const paths = allRoutes.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(['/api/resolve/:id'])); // mounted in server.ts
    expect(paths).toEqual(expect.arrayContaining(['/r/:id'])); // mounted in server.ts
    expect(paths).toEqual(expect.arrayContaining(['/api/projects/:id'])); // via the aggregator
  });

  it('the walk actually found the app — a zero/empty population would pass everything vacuously', () => {
    // CLASSES.md C3: probe the empty population. Every assertion below iterates
    // `mutatingRoutes`. If the walk broke (an Express upgrade renaming `_router`, an import
    // failing soft) that array would be EMPTY and the whole guard would report green while
    // checking nothing.
    expect(sourceMutatingCount).toBeGreaterThan(0); // the derived floor is itself not vacuous
    expect(mutatingRoutes.length).toBeGreaterThanOrEqual(sourceMutatingCount);
    expect(allRoutes.length).toBeGreaterThan(mutatingRoutes.length);
  });

  it('DENY BY DEFAULT: every state-changing route carries an explicit authz classification', () => {
    const unclassified = mutatingRoutes.filter((r) => !r.classification);

    // The message is the product here: whoever adds an unclassified route reads THIS.
    const detail = unclassified
      .map(
        (r) =>
          `  ${r.method.padEnd(6)} ${r.path}\n      chain: ${r.chainNames.join(' → ')}` +
          (r.inheritedClassification
            ? `\n      NOTE: a '${r.inheritedClassification.kind}' classification is visible from an` +
              ' enclosing router.use(...), but an INHERITED one does not count.\n      One router-level' +
              ' marker would silence every route beneath it in a single line. Put it on the route.'
            : '')
      )
      .join('\n');

    expect(
      unclassified.length === 0
        ? ''
        : `\n${unclassified.length} state-changing route(s) have NO authz classification:\n${detail}\n\n` +
            'Every POST/PUT/PATCH/DELETE the app serves must say who may call it, AT THE ROUTE:\n' +
            '  • requireAdmin                                  (enforced: admin only)\n' +
            "  • declareAnyAuthenticatedMayWrite('why')        (declared: any logged-in user)\n" +
            "  • declareIntentionallyUnauthenticated('why')    (declared: no credential needed)\n" +
            'This guard has no allow-list. See src/middleware/authz.ts.\n'
    ).toBe('');
  });

  it('NO BLANKET MUTE: not one route is satisfied by an inherited router-level classification', () => {
    // Independent of the rule above (which only reports them). If a future edit moves a
    // marker from a route up to a `router.use`, this names it.
    const inherited = mutatingRoutes
      .filter((r) => r.inheritedClassification && !r.classification)
      .map((r) => `${r.method} ${r.path}`);
    expect(inherited).toEqual([]);
  });

  it('ANCHOR — DELETE /api/projects/:id is admin-enforced, and authenticated BEFORE it', () => {
    // The specific hole this task was filed for. Asserted on `kind === 'admin'`, not merely
    // "has a classification", so swapping requireAdmin for a declare* marker is RED too.
    const route = mutatingRoutes.find(
      (r) => r.method === 'DELETE' && r.path === '/api/projects/:id'
    );
    expect(route).toBeDefined();
    expect(route!.classification?.kind).toBe('admin');

    // requireAdmin reads req.user.role, which only authenticateToken populates. If the order
    // ever inverted, requireAdmin would 401 every caller and look like a working gate.
    const authIdx = route!.chainNames.indexOf('authenticateToken');
    const adminIdx = route!.chainNames.indexOf('requireRoleMiddleware');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(adminIdx).toBeGreaterThan(authIdx);
  });

  it('every classification carries a non-blank written reason', () => {
    const blank = mutatingRoutes.filter((r) => !r.classification?.reason?.trim());
    expect(blank.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('records the current classification census (a change here is a change in who may write)', () => {
    const census: Record<string, number> = {};
    for (const r of mutatingRoutes) {
      const kind = r.classification?.kind ?? 'UNCLASSIFIED';
      census[kind] = (census[kind] ?? 0) + 1;
    }
    expect(census.UNCLASSIFIED ?? 0).toBe(0);
    // Derived from AuthzKind itself, not restated here: adding a kind must not require
    // editing this assertion, and must not be able to slip past it either.
    expect(Object.keys(census).sort()).toEqual(
      [...ALL_AUTHZ_KINDS].filter((k) => k in census).sort()
    );
  });

  it('the two intentionally-unauthenticated writes are exactly the two we know about', () => {
    // Not an allow-list that gates anything — the deny-by-default test above is the gate.
    // This pins the smallest and most dangerous bucket so that ADDING to it is a visible
    // diff in a security test rather than one more green run.
    const open = mutatingRoutes
      .filter((r) => r.classification?.kind === 'unauthenticated')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    // WAS ['POST /api/auth/login', 'POST /api/git/push-stats']. an earlier Task put
    // push-stats behind `authenticateAgentOrUser` (the MANDREL_AGENT_TOKEN service
    // credential or a user JWT), so the set of state-changing routes anyone on the
    // internet can call is down to the one that MUST be open: login itself.
    expect(open).toEqual(['POST /api/auth/login']);
  });
});

describe('the classification channel itself cannot be satisfied vacuously', () => {
  const noop: RequestHandler = (_req, _res, next) => next();

  it.each(['', '   ', '\n\t'])('classifyAuthz rejects a blank reason (%j)', (reason) => {
    expect(() => classifyAuthz(noop, { kind: 'admin', reason })).toThrow(/non-blank reason/);
  });

  it.each(['', '  '])('the declare* markers reject a blank reason (%j) too', (reason) => {
    expect(() => declareAnyAuthenticatedMayWrite(reason)).toThrow(/non-blank reason/);
    expect(() => declareIntentionallyUnauthenticated(reason)).toThrow(/non-blank reason/);
  });

  it('readAuthzClassification returns undefined for the ABSENT population', () => {
    // absent / non-function / plain object — the values a walk over changed Express
    // internals could hand it. None may be mistaken for "classified".
    expect(readAuthzClassification(noop)).toBeUndefined();
    expect(readAuthzClassification(undefined)).toBeUndefined();
    expect(readAuthzClassification(null)).toBeUndefined();
    expect(readAuthzClassification({})).toBeUndefined();
    expect(readAuthzClassification('requireAdmin')).toBeUndefined();
  });

  it('a classification cannot be overwritten in place after it is attached', () => {
    const h = declareAnyAuthenticatedMayWrite('original reason');
    expect(() => {
      (h as any)[AUTHZ_CLASSIFICATION] = { kind: 'admin' as AuthzKind, reason: 'forged' };
    }).toThrow();
    expect(readAuthzClassification(h)!.kind).toBe('any-authenticated');
  });

  it('each declare* call produces its OWN handler, so reasons cannot bleed between routes', () => {
    const a = declareAnyAuthenticatedMayWrite('reason A');
    const b = declareAnyAuthenticatedMayWrite('reason B');
    expect(a).not.toBe(b);
    expect(readAuthzClassification(a)!.reason).toBe('reason A');
    expect(readAuthzClassification(b)!.reason).toBe('reason B');
  });
});

describe('the WALK fails closed on shapes it does not recognise', () => {
  // The guard is itself a product (C3). Its most dangerous failure is not a false RED — it
  // is silently discovering fewer routes than exist, which is exactly how the aggregator
  // version of this file passed a reachable unclassified DELETE. These feed it hand-built
  // routers whose correct answer is known.
  const { Router } = require('express');

  it('finds an unclassified route buried two sub-routers deep and reports it', () => {
    const inner = Router();
    inner.delete('/:id', (_req: any, res: any) => res.end());
    const middle = Router();
    middle.use('/things', inner);
    const outer = Router();
    outer.use('/deep', middle);

    const found = discoverRoutes(outer).filter((r) => r.method === 'DELETE');
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('/deep/things/:id');
    expect(found[0].classification).toBeUndefined(); // → the deny-by-default test would FAIL it
  });

  it('REJECTS a router-level classification — a blanket mute does not satisfy the rule', () => {
    // The N1 hole: `router.use(declareAnyAuthenticatedMayWrite('...'))` once at the top of
    // the aggregator would have turned every route green in a single line.
    const r = Router();
    r.use(declareAnyAuthenticatedMayWrite('blanket mute attempt'));
    r.post('/x', (_req: any, res: any) => res.end());

    const found = discoverRoutes(r);
    expect(found[0].classification).toBeUndefined(); // does NOT count
    expect(found[0].inheritedClassification?.kind).toBe('any-authenticated'); // but IS reported
  });

  it('does NOT credit a classification registered AFTER the route it supposedly covers', () => {
    // Express dispatches in registration order, so a `use` below a route never runs for it.
    const r = Router();
    r.post('/early', (_req: any, res: any) => res.end());
    r.use(declareAnyAuthenticatedMayWrite('registered too late to protect /early'));
    r.post('/late', (_req: any, res: any) => res.end());

    const found = discoverRoutes(r);
    const early = found.find((x) => x.path === '/early')!;
    const late = found.find((x) => x.path === '/late')!;
    expect(early.classification).toBeUndefined();
    expect(early.inheritedClassification).toBeUndefined(); // not even visible
    expect(late.classification).toBeUndefined(); // inherited never counts
    expect(late.inheritedClassification?.kind).toBe('any-authenticated');
  });

  it('counts a route-level classification, wherever it sits in the handler list', () => {
    const r = Router();
    const h = (_req: any, res: any) => res.end();
    r.post('/first', declareAnyAuthenticatedMayWrite('leading marker'), h);
    r.post('/middle', h as any, declareIntentionallyUnauthenticated('trailing marker'), h);

    const found = discoverRoutes(r);
    expect(found.find((x) => x.path === '/first')!.classification?.kind).toBe('any-authenticated');
    expect(found.find((x) => x.path === '/middle')!.classification?.kind).toBe('unauthenticated');
  });

  it('an empty router yields an empty population — which is why the census assertions exist', () => {
    expect(discoverRoutes(Router())).toEqual([]);
  });
});
