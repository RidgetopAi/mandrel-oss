/**
 * watchableRequiresAuth.test.ts — the regression guard for an earlier task.
 *
 * ## What this guards
 *
 * `GET /api/projects/watchable` was registered ABOVE `router.use(authenticateToken)` in
 * `routes/projects.ts`, with `security: []` in its swagger block and the comment
 * "Unauthenticated - used by local mandrel-watcher daemon". It was reachable with no
 * credential on prod and all 7 tenants and returned, per project, `id` + `name` +
 * `root_directory` — customer project names and absolute host filesystem paths.
 *
 * Moving the route below the auth line fixes it once. This file is what stops it from
 * moving back, which is a one-line edit that looks harmless in review: in Express the
 * ONLY thing separating a protected route from an open one is registration ORDER, and
 * order is invisible in a diff that just relocates a `router.get`.
 *
 * ## The population, and why it is the whole one
 *
 * The population is **every route the real Express `app` (from `src/server.ts`) serves
 * under `/api/projects`** — read out of Express's own `app._router.stack` at runtime and
 * walked recursively through every mounted sub-router, the same way
 * `mutatingRouteAuthzCoverage.test.ts` does.
 *
 * It is the app and not the route module because `routes/projects.ts` on its own cannot
 * tell you what protects it: `authenticateToken` could be applied by an enclosing router,
 * and the mount order that decides the answer only exists once the app is assembled. The
 * walk sees whatever Express will actually route.
 *
 * This is scoped to `/api/projects` deliberately, and that scope is a decision, not an
 * oversight. The wider rule — "every route with no `authenticateToken` in its chain must
 * carry an explicit authz classification" — is the correct whole-class guard and is
 * recommended as follow-up. It is NOT built here because the routes it would newly make
 * illegal (the `health.ts` and `openapi.ts` families) are owned by concurrent in-flight
 * work, and a guard that forces edits into someone else's files mid-flight gets reverted.
 * See the task report for the measured pre-auth census.
 *
 * ## DB-free
 *
 * The app is imported for its SHAPE only; no handler is invoked and no connection opened.
 * `server.ts` only calls `startServer()` under `require.main === module`. Its one
 * module-load side effect, `ensureFeatureFlags()`, is mocked below exactly as the sibling
 * authz suite does — it registers, reorders and classifies no routes.
 *
 * ## Mutation probe (exercised — see the task report)
 *
 * Move `router.get('/watchable', ...)` back above `router.use(authenticateToken)` →
 * "is protected by authenticateToken" goes RED naming the route. The unmutated control is
 * GREEN. The empty/absent populations are covered by the two vacuity tests below, which
 * fail if the walk ever stops finding the route at all.
 */

import type { RequestHandler } from 'express';

// The ONLY module-load side effect in server.ts (see header).
jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

// THE SERVED SURFACE — not the route module.
import app from '../server';

interface DiscoveredRoute {
  method: string;
  path: string;
  chainNames: string[];
}

/**
 * Reconstruct a mount prefix from an Express 4 layer. Express keeps the mount path only as
 * a compiled regexp on `use` layers. Used for readable paths; it cannot silently shrink the
 * population (a wrong prefix yields a wrong NAME, and the vacuity tests below catch a route
 * that stops being found).
 */
function mountPrefix(layer: any): string {
  if (typeof layer.path === 'string') return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

const handlerName = (fn: unknown): string =>
  typeof fn === 'function' && fn.name ? fn.name : '<anonymous>';

/**
 * Walk an Express router/app collecting every route with the FULL handler chain that will
 * run for it — inherited `use` middleware registered before the route, then the route's own
 * handlers. Middleware registered AFTER a route is correctly not accumulated for it, which
 * is the whole point: that is exactly how the bug worked.
 */
function walk(
  stack: any[],
  prefix: string,
  inherited: RequestHandler[],
  out: DiscoveredRoute[]
): void {
  const accumulated = [...inherited];

  for (const layer of stack) {
    if (layer.route) {
      const routePath = prefix + (layer.route.path === '/' ? '' : layer.route.path);
      const own: RequestHandler[] = layer.route.stack.map((l: any) => l.handle as RequestHandler);
      for (const method of Object.keys(layer.route.methods)) {
        if (!layer.route.methods[method]) continue;
        out.push({
          method: method.toUpperCase(),
          path: routePath || '/',
          chainNames: [...accumulated, ...own].map(handlerName),
        });
      }
    } else if (typeof layer.handle === 'function' && Array.isArray((layer.handle as any).stack)) {
      walk((layer.handle as any).stack, prefix + mountPrefix(layer), accumulated, out);
    } else if (mountPrefix(layer) === '') {
      accumulated.push(layer.handle as RequestHandler);
    }
  }
}

function discoverRoutes(routerOrApp: unknown): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const stack = (routerOrApp as any)?._router?.stack ?? (routerOrApp as any)?.stack;
  walk(stack ?? [], '', [], out);
  return out;
}

const allRoutes = discoverRoutes(app);
const projectRoutes = allRoutes.filter((r) => r.path.startsWith('/api/projects'));
const WATCHABLE = '/api/projects/watchable';

describe('GET /api/projects/watchable requires authentication', () => {
  it('the walk actually found the app — an empty population would pass everything vacuously', () => {
    // CLASSES.md C3: probe the empty population. Every assertion below filters this array.
    // If the walk broke (an Express upgrade renaming `_router`, a soft import failure) it
    // would be EMPTY and the suite would report green while checking nothing.
    expect(allRoutes.length).toBeGreaterThan(0);
    expect(projectRoutes.length).toBeGreaterThan(0);
  });

  it('the route still EXISTS — the leak must not be closed by deleting the consumer', () => {
    // A 401 and a 404 are indistinguishable to the acceptance curl, and deleting the route
    // would satisfy "no longer returns data to an anonymous caller" while breaking the live
    // mandrel-watcher. This is the positive control, asserted on shape.
    const route = allRoutes.find((r) => r.method === 'GET' && r.path === WATCHABLE);
    expect(route).toBeDefined();
  });

  it('is protected by authenticateToken', () => {
    // THE ASSERTION. `authenticateToken` must appear in the chain that Express will
    // actually run for this route. Moving the registration back above
    // `router.use(authenticateToken)` removes it from `accumulated` and fails here.
    const route = allRoutes.find((r) => r.method === 'GET' && r.path === WATCHABLE)!;
    expect(route.chainNames).toContain('authenticateToken');
  });

  it('NO route under /api/projects is reachable without authenticateToken', () => {
    // The local whole-class form: fixing only the route named in the ticket would leave a
    // sibling hole one layer over, which is this repo's most-confirmed failure pattern.
    // Deny-by-default over the whole /api/projects family, with no allow-list.
    const unprotected = projectRoutes
      .filter((r) => !r.chainNames.includes('authenticateToken'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(
      unprotected.length === 0
        ? ''
        : `\n${unprotected.length} route(s) under /api/projects run with NO authenticateToken ` +
            `in their handler chain:\n  ${unprotected.join('\n  ')}\n\n` +
            'In Express this is decided by REGISTRATION ORDER: a route registered above\n' +
            "`router.use(authenticateToken)` in routes/projects.ts is served to anyone.\n" +
            'These routes return project names and absolute host filesystem paths.\n' +
            'See an earlier task.\n'
    ).toBe('');
  });
});
