/**
 * routeCensus.ts — ONE walk of the REAL served Express surface, shared by every authz
 * guard.
 *
 * ## Why this is a helper and not copied into each test
 *
 * The walk IS the population. Two copies of it are two populations that can disagree, and
 * a guard whose population silently shrinks is the exact failure this whole family of
 * tests exists to prevent (CLASSES.md C3). `mutatingRouteAuthzCoverage.test.ts` and
 * `unauthenticatedRouteCoverage.test.ts` therefore enforce DIFFERENT RULES over the SAME
 * enumeration, imported from here.
 *
 * ## The population, and why it is the whole one
 *
 * **Every route registered on the real Express `app` exported by `src/server.ts`**, read
 * out of Express's own `app._router.stack` and walked recursively through every mounted
 * sub-router — all verbs, not just the state-changing ones.
 *
 * THE APP, NOT THE AGGREGATOR. `server.ts` mounts three things that `routes/index.ts`
 * never sees (`/api/feature-flags` at server.ts:50, `/api/resolve` at :92, `/` at :114),
 * so a walk of the aggregator would miss them. `app._router` IS the served surface:
 * whatever Express will route, this sees, including a top-level mount added tomorrow and
 * including paths outside `/api`.
 *
 * ## Auth is read from the CLASSIFICATION, never from a middleware NAME
 *
 * The first version of the unauthenticated-route census keyed on `authenticateToken` appearing in the
 * chain and reported `/api/events`, `/api/events/stats` and `/api/events/clients` as
 * unauthenticated. They are not — they are guarded by `ensureAuthForSse`. A name-keyed
 * sweep over-reports today and UNDER-reports the day somebody writes a fourth
 * authenticator, and the under-report is a hole nobody sees. So authenticators carry
 * `markAuthenticator(...)` and this walk reads the mark off the function object.
 */

import type { RequestHandler } from 'express';
import {
  AuthzClassification,
  readAuthzClassification,
  isEnforcing,
} from '../../middleware/authz';

export const MUTATING_METHODS = ['post', 'put', 'patch', 'delete'] as const;

export interface DiscoveredRoute {
  method: string;
  path: string;
  /** Classification found on the route's OWN handler list. */
  classification?: AuthzClassification;
  /**
   * Classification visible only via an enclosing `router.use(...)`. Recorded so a
   * blanket-mute attempt gets a precise failure message instead of passing as
   * "unclassified".
   */
  inheritedClassification?: AuthzClassification;
  /**
   * An ENFORCING classification (`admin` / `authenticated`) anywhere in the effective
   * chain, own or inherited. Inheritance counts HERE and only here: a
   * `router.use(authenticateToken)` genuinely does refuse every request beneath it.
   * The `declare*` kinds grant nothing, so they never count inherited.
   */
  enforcedBy?: AuthzClassification;
  /** Every handler in the effective chain, for the behavioural authenticator probe. */
  chain: RequestHandler[];
  chainNames: string[];
}

/**
 * Reconstruct a mount prefix from an Express 4 layer. Express keeps the mount path only as
 * a compiled regexp on `use` layers, so this un-compiles the two shapes Express emits. It
 * feeds the human-readable path in failure messages ONLY — if it ever returned '' for
 * everything, the same set of routes would still be checked, just with uglier names. It
 * cannot silently shrink the population.
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
      const effective = [...accumulated, ...own];

      const ownClassified = own
        .map(readAuthzClassification)
        .filter(Boolean) as AuthzClassification[];
      const inheritedClassified = accumulated
        .map(readAuthzClassification)
        .filter(Boolean) as AuthzClassification[];
      const enforcedBy = effective
        .map(readAuthzClassification)
        .find((c) => isEnforcing(c));

      for (const method of Object.keys(layer.route.methods)) {
        if (!layer.route.methods[method]) continue;
        out.push({
          method: method.toUpperCase(),
          path: routePath || '/',
          classification: ownClassified[0],
          inheritedClassification: ownClassified[0] ? undefined : inheritedClassified[0],
          enforcedBy,
          chain: effective,
          chainNames: effective.map(handlerName),
        });
      }
    } else if (typeof layer.handle === 'function' && Array.isArray((layer.handle as any).stack)) {
      walk((layer.handle as any).stack, prefix + mountPrefix(layer), accumulated, out);
    } else if (mountPrefix(layer) === '') {
      accumulated.push(layer.handle as RequestHandler);
    }
  }
}

/** Walk any Express app or router. Exported so the guards can feed it hand-built routers. */
export function discoverRoutes(routerOrApp: unknown): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const stack = (routerOrApp as any)?._router?.stack ?? (routerOrApp as any)?.stack;
  walk(stack ?? [], '', [], out);
  return out;
}

export const isMutating = (r: DiscoveredRoute): boolean =>
  (MUTATING_METHODS as readonly string[]).includes(r.method.toLowerCase());
