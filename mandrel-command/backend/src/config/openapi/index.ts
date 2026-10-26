/**
 * index.ts — the SERVING path for the OpenAPI spec.
 *
 * THE DEFECT THIS CLOSES (measured on the live fleet)
 * -------------------------------------------------------------------------
 * This module used to BE the swagger-jsdoc call. swagger-jsdoc resolves its `apis`
 * glob ('./src/routes/*.ts') against the PROCESS CWD, and the backend runner image
 * runs from /app/backend with no src/ at all. The glob matched nothing, swagger-jsdoc
 * returned a well-formed document with `paths: {}`, and exited 0. Nothing lied; the
 * artifact was simply empty, and Express served it with a 200.
 *
 * MEASURED 2026-08-31 on the running fleet — all 7 command-backend containers on
 * image 5fe3f00df00d, prod included: GET /api/openapi/openapi.json returned HTTP 200,
 * 33229 bytes, 70 schemas, 11 tags, and `paths: []`. The systemd instance that DOES
 * have src/ was inactive, so every instance actually serving this endpoint served a
 * spec documenting zero endpoints.
 *
 * THE SHAPE OF THE FIX: derived, not resolved-at-runtime.
 * `npm run build` runs scripts/emit-openapi-artifact.cjs, which generates the spec in
 * the builder stage (where src/ exists) and writes it into dist/. Here we LOAD that
 * artifact by a path anchored on __dirname. __dirname is a property of where the code
 * lives, not of where the process was started, so no CWD can empty it.
 *
 * FAIL CLOSED ON THE VACUOUS CASE.
 * Zero paths is not a valid population. If the resolved spec is below the floor, this
 * module records a FINDING at startup (logged at error level, non-silently) and marks
 * the spec DEGRADED. routes/openapi.ts refuses to serve a degraded spec — it returns
 * 503 rather than a 200 carrying an empty contract, so the failure is visible to the
 * consumer instead of being indistinguishable from an API with no endpoints.
 *
 * Why a 503 and not a process exit: the blast radius of the original bug was the docs
 * surface, and coupling every tenant's whole API to spec generation would make a
 * documentation fault an outage. The build-time floor in emit-openapi-artifact.cjs is
 * the hard fail-closed — an image whose spec collapsed cannot be built at all — and
 * this is the runtime backstop for anything that gets past it.
 */

import fs from 'fs';
import path from 'path';
import { OPENAPI_ARTIFACT_BASENAME, OPENAPI_MIN_PATHS } from './spec-source.config';

export interface SpecResolution {
  spec: Record<string, unknown>;
  /** 'artifact' = loaded from dist/, 'generated' = swagger-jsdoc fallback, 'empty' = neither worked. */
  source: 'artifact' | 'generated' | 'empty';
  /** Absolute path of the artifact when source === 'artifact'. */
  artifactPath: string | null;
  pathCount: number;
  /** True when pathCount is below OPENAPI_MIN_PATHS. A degraded spec is never served. */
  degraded: boolean;
  /** Human-readable reason, present iff degraded. */
  finding: string | null;
}

function countPaths(spec: unknown): number {
  const paths = (spec as { paths?: unknown } | null)?.paths;
  return paths && typeof paths === 'object' ? Object.keys(paths as object).length : 0;
}

/**
 * dist/<artifact>. __dirname is dist/config/openapi at runtime, so two levels up is
 * dist/. Under ts-node __dirname is src/config/openapi, where no artifact is written —
 * that resolves to a miss and falls through to generation, which is correct for dev
 * because a ts-node process runs from the backend dir with src/ present.
 */
export const ARTIFACT_PATH = path.join(__dirname, '..', '..', OPENAPI_ARTIFACT_BASENAME);

function resolveSpec(): SpecResolution {
  let spec: Record<string, unknown> | null = null;
  let source: SpecResolution['source'] = 'empty';
  let artifactPath: string | null = null;

  try {
    if (fs.existsSync(ARTIFACT_PATH)) {
      spec = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8')) as Record<string, unknown>;
      source = 'artifact';
      artifactPath = ARTIFACT_PATH;
    }
  } catch (err) {
    // A present-but-unreadable artifact is a THIRD STATE, not "absent". Say so, then
    // fall through to generation rather than pretending the file was never there.
    // eslint-disable-next-line no-console
    console.error(
      `[openapi] build artifact at ${ARTIFACT_PATH} could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!spec) {
    try {
      // Lazy on purpose: the serving path must not depend on swagger-jsdoc or on the
      // route sources. This require only runs in the artifact-absent (dev) case.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { generateSwaggerSpec } = require('./generate') as typeof import('./generate');
      spec = generateSwaggerSpec();
      source = 'generated';
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[openapi] no build artifact and generation failed: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (!spec) {
    spec = {};
    source = 'empty';
  }

  const pathCount = countPaths(spec);
  const degraded = pathCount < OPENAPI_MIN_PATHS;
  const finding = degraded
    ? `OpenAPI spec is VACUOUS: ${pathCount} documented path(s), floor is ${OPENAPI_MIN_PATHS} ` +
      `(source=${source}, artifact=${artifactPath ?? 'absent'}, cwd=${process.cwd()}). ` +
      `The build artifact is missing or empty; this instance will NOT serve a spec. ` +
      `Expected dist/${OPENAPI_ARTIFACT_BASENAME}, written by \`npm run build\`.`
    : null;

  return { spec, source, artifactPath, pathCount, degraded, finding };
}

export const specResolution: SpecResolution = resolveSpec();

if (specResolution.degraded) {
  // STARTUP FINDING. Emitted at module load, on stderr, unconditionally — the point of
  // the whole task is that this case used to be silent. console rather than the winston
  // logger to avoid a config import cycle and so it survives any logger misconfiguration.
  // eslint-disable-next-line no-console
  console.error(`[openapi][FINDING] ${specResolution.finding}`);
}

export const swaggerSpec = specResolution.spec;

export default swaggerSpec;
