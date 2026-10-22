/**
 * openapi-served-probe.cjs — load the backend's SERVING module and report how it
 * resolved the OpenAPI spec, in whatever directory arrangement it is handed.
 *
 * Used by scripts/test/openapi-served-spec.test.sh to measure
 * the spec as the IMAGE would serve it: a sourceless dist/, loaded from a CWD with no
 * src/ in it. The probe deliberately does no judging — it prints what it observed and
 * the floor the PRODUCT applied, and the shell guard decides PASS/FAIL. Keeping the
 * verdict out of here means the guard cannot be fooled by a probe that classifies its
 * own output (C3 — read the classifier, not just the check).
 *
 * Usage: node openapi-served-probe.cjs <root-containing-dist>
 *   Run it with CWD set to whatever CWD you want to measure under.
 *
 * Output: KEY=VALUE lines on stdout — SOURCE, PATH_COUNT, DEGRADED, FLOOR, ARTIFACT,
 *         ARTIFACT_EXISTS, CWD, FINDING_EMITTED.
 * Exit:   0 measured (whatever the answer) · 2 could not measure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RC_CANNOT_MEASURE = 2;

function bail(msg) {
  console.error(`[openapi-served-probe] ${msg}`);
  process.exit(RC_CANNOT_MEASURE);
}

const root = process.argv[2];
if (!root) bail('usage: node openapi-served-probe.cjs <root-containing-dist>');

const servingModule = path.join(path.resolve(root), 'dist', 'config', 'openapi');
if (!fs.existsSync(`${servingModule}.js`) && !fs.existsSync(path.join(servingModule, 'index.js'))) {
  bail(`no compiled serving module at ${servingModule} — was the backend built?`);
}

// The FINDING is written to stderr at module load. Capture whether it fired, because
// "the vacuous case is loud" is one of the properties under test and a silent finding
// is exactly the failure this task exists to close.
let findingEmitted = false;
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function (chunk, ...rest) {
  if (typeof chunk === 'string' && chunk.includes('[openapi][FINDING]')) {
    findingEmitted = true;
  }
  return realStderrWrite(chunk, ...rest);
};

let mod;
try {
  mod = require(servingModule);
} catch (err) {
  process.stderr.write = realStderrWrite;
  bail(`serving module threw on load: ${err && err.stack ? err.stack : err}`);
}
process.stderr.write = realStderrWrite;

const res = mod.specResolution;
if (!res || typeof res !== 'object') {
  bail('serving module did not export specResolution — the probe is pointed at the wrong subject.');
}

// The floor the PRODUCT applied, read back out of the product's own config so the
// shell guard never has to restate it.
let floor;
try {
  floor = require(path.join(path.resolve(root), 'dist', 'config', 'openapi', 'spec-source.config.js'))
    .OPENAPI_MIN_PATHS;
} catch {
  floor = '';
}

const out = {
  CWD: process.cwd(),
  SOURCE: res.source,
  PATH_COUNT: res.pathCount,
  DEGRADED: res.degraded ? 'true' : 'false',
  FLOOR: floor,
  ARTIFACT: res.artifactPath === null ? '' : res.artifactPath,
  ARTIFACT_EXISTS: res.artifactPath && fs.existsSync(res.artifactPath) ? 'true' : 'false',
  FINDING_EMITTED: findingEmitted ? 'true' : 'false'
};
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
