/**
 * route-census.ts — print EVERY route the backend serves, and who may call it.
 *
 * Run:  npx tsx scripts/route-census.ts          # human table + totals
 *       npx tsx scripts/route-census.ts --tsv    # METHOD \t PATH \t VERDICT \t REASON
 *
 * ⚠️ `tsx`, NOT `ts-node`. A few modules import their TypeScript siblings with an
 * ESM-style `.js` extension (`export * from './embedding/index.js'`); tsc and tsx resolve
 * that to the `.ts` file, ts-node does not and dies with MODULE_NOT_FOUND on
 * services/EmbeddingService.ts. It is the same quirk jest.config.js works around with a
 * `moduleNameMapper`.
 *
 * This exists so the census in a security report is a COMMAND, not a number somebody
 * typed. It reuses the exact walk the authz guards enforce over
 * (`src/__tests__/helpers/routeCensus.ts`), reading Express's own `app._router.stack` from
 * the real `src/server.ts`, so it cannot report a different population than the guards do.
 *
 * Verdicts are read from the authz CLASSIFICATION on each middleware, never from a
 * middleware's NAME. A name-keyed sweep reported `/api/events*` as open because those
 * routes are guarded by `ensureAuthForSse` rather than `authenticateToken` — see
 * middleware/authz.ts.
 *
 * Imports server.ts for its SHAPE only: no port is opened, no handler is invoked, and the
 * one module-load side effect (`ensureFeatureFlags`) is left real here because this is a
 * script, not a test — it may take a moment on a cold DB.
 */

import { discoverRoutes } from '../src/__tests__/helpers/routeCensus';
import { isEnforcing } from '../src/middleware/authz';
import app from '../src/server';

const tsv = process.argv.includes('--tsv');
const routes = discoverRoutes(app).sort((a, b) =>
  a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)
);

let gated = 0;
let publicDeclared = 0;
let uncovered = 0;
const lines: string[] = [];

for (const r of routes) {
  let verdict: string;
  let reason: string;
  if (isEnforcing(r.enforcedBy)) {
    verdict = `REQUIRES-AUTH(${r.enforcedBy!.kind})`;
    reason = r.enforcedBy!.reason;
    gated++;
  } else if (r.classification?.kind === 'unauthenticated') {
    verdict = 'PUBLIC-DECLARED';
    reason = r.classification.reason;
    publicDeclared++;
  } else {
    verdict = 'UNCLASSIFIED-AND-OPEN';
    reason = `chain: ${r.chainNames.join(' -> ')}`;
    uncovered++;
  }
  lines.push(
    tsv
      ? `${r.method}\t${r.path}\t${verdict}\t${reason}`
      : `${r.method.padEnd(7)} ${r.path.padEnd(46)} ${verdict}`
  );
}

console.log(lines.join('\n'));
console.log(
  `\nTOTAL ${routes.length}  |  REQUIRES-AUTH ${gated}  |  PUBLIC-DECLARED ${publicDeclared}  |  UNCLASSIFIED-AND-OPEN ${uncovered}`
);
// Non-zero when something is open and undeclared, so this can be used as a check, not just
// a report. The guard suite is the gate; this is the same fact, readable.
process.exit(uncovered === 0 ? 0 : 1);
