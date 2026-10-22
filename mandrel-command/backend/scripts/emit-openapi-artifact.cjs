/**
 * emit-openapi-artifact.cjs — emit the OpenAPI spec as a BUILD ARTIFACT into dist/.
 *
 * WHY
 * ---------------------------
 * swagger-jsdoc resolves its `apis` glob against the PROCESS CWD. The runner image
 * runs from /app/backend and ships no src/, so generating at runtime there produced a
 * well-formed spec with ZERO paths — served as a 200 to every customer. Measured on
 * all 7 running command-backend containers, prod included, 2026-08-31.
 *
 * So we generate ONCE, here, at build time — in the Docker builder stage, where
 * backend/src/ is present by construction — and write dist/openapi.spec.json.
 * src/config/openapi/index.ts loads that file relative to __dirname at runtime. The
 * glob no longer sits on the serving path, so no CWD can empty it.
 *
 * THIS IS THE HARD FAIL-CLOSED. Zero paths is not a valid population. If the spec this
 * generates is below OPENAPI_MIN_PATHS, this script exits NON-ZERO and `npm run build`
 * fails — an image carrying a collapsed spec cannot be produced at all. That is a much
 * better place to fail than in front of a customer, and it is why the runtime check in
 * index.ts is only a backstop.
 *
 * THE THIRD STATE. "Could not measure" gets its own exit code (2), distinct from
 * "measured and too small" (1). A missing dist/, an unloadable generator or a
 * toolchain fault must never be reported as a spec verdict.
 *
 * Run by `npm run build`, AFTER tsc (it requires the compiled generator out of dist/).
 * Exit: 0 wrote a valid artifact · 1 the spec is below the floor · 2 could not measure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RC_OK = 0;
const RC_BELOW_FLOOR = 1;
const RC_CANNOT_MEASURE = 2;

const BACKEND_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(BACKEND_DIR, 'dist');
const GENERATOR = path.join(DIST_DIR, 'config', 'openapi', 'generate.js');
const CONFIG = path.join(DIST_DIR, 'config', 'openapi', 'spec-source.config.js');

function die(rc, msg) {
  console.error(`[emit-openapi-artifact] ${msg}`);
  process.exit(rc);
}

if (!fs.existsSync(GENERATOR)) {
  die(RC_CANNOT_MEASURE, `compiled generator not found at ${GENERATOR}. Run tsc first (npm run build does).`);
}
if (!fs.existsSync(CONFIG)) {
  die(RC_CANNOT_MEASURE, `compiled config not found at ${CONFIG}.`);
}

let basename;
let minPaths;
try {
  const cfg = require(CONFIG);
  basename = cfg.OPENAPI_ARTIFACT_BASENAME;
  minPaths = cfg.OPENAPI_MIN_PATHS;
} catch (err) {
  die(RC_CANNOT_MEASURE, `could not load spec-source config: ${err && err.message}`);
}
if (typeof basename !== 'string' || !basename) {
  die(RC_CANNOT_MEASURE, 'spec-source config did not export a usable OPENAPI_ARTIFACT_BASENAME.');
}
if (!Number.isFinite(minPaths)) {
  die(RC_CANNOT_MEASURE, 'spec-source config did not export a numeric OPENAPI_MIN_PATHS.');
}

/**
 * The generator globs './src/routes/*.ts' relative to process.cwd(), so run it from
 * BACKEND_DIR rather than inheriting whatever CWD npm happened to hand us. Not doing
 * this would reproduce the very defect the artifact exists to prevent — silently.
 */
const originalCwd = process.cwd();
let spec;
try {
  process.chdir(BACKEND_DIR);
  const { generateSwaggerSpec } = require(GENERATOR);
  if (typeof generateSwaggerSpec !== 'function') {
    die(RC_CANNOT_MEASURE, `${GENERATOR} does not export generateSwaggerSpec().`);
  }
  spec = generateSwaggerSpec();
} catch (err) {
  die(RC_CANNOT_MEASURE, `generation threw: ${err && err.stack ? err.stack : err}`);
} finally {
  try { process.chdir(originalCwd); } catch { /* best effort */ }
}

const pathCount = spec && spec.paths && typeof spec.paths === 'object'
  ? Object.keys(spec.paths).length
  : 0;

if (pathCount < minPaths) {
  die(
    RC_BELOW_FLOOR,
    `VACUOUS SPEC — generated ${pathCount} path(s), floor is ${minPaths}.\n` +
      `  Generated from CWD ${BACKEND_DIR}; swagger-jsdoc's apis glob is resolved there.\n` +
      `  Either src/routes/*.ts is missing from this build context, or the @swagger\n` +
      `  annotations were removed. Refusing to write an empty contract into dist/.`
  );
}

const outPath = path.join(DIST_DIR, basename);
try {
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
} catch (err) {
  die(RC_CANNOT_MEASURE, `could not write ${outPath}: ${err && err.message}`);
}

const schemaCount = spec.components && spec.components.schemas
  ? Object.keys(spec.components.schemas).length
  : 0;
console.log(
  `[emit-openapi-artifact] wrote dist/${basename} — ${pathCount} paths, ` +
    `${schemaCount} schemas (floor ${minPaths})`
);
process.exit(RC_OK);
