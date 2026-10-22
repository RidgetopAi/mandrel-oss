/**
 * spec-source.config.ts — tunables for how the served OpenAPI spec is OBTAINED.
 *
 * WHY THIS FILE EXISTS
 * -------------------------------------------
 * The spec used to be GENERATED at process start by swagger-jsdoc from
 * `apis: ['./src/routes/*.ts']`. swagger-jsdoc resolves that glob against the
 * PROCESS CWD, not against the module's own location. The backend runner image
 * sets WORKDIR /app/backend and ships `dist/` with no `src/` (its Dockerfile says
 * so in its own comment), so the glob matched nothing there.
 *
 * It did not error. swagger-jsdoc returns a well-formed document with `paths: {}`
 * and exits 0 — a vacuous success. MEASURED on the live fleet 2026-08-31: all 7
 * running command-backend containers, prod included, served HTTP 200 / 33 KB /
 * `paths: {}` — 70 schemas, 11 tags, and zero documented endpoints.
 *
 * The fix makes the spec DERIVED rather than resolved-at-runtime: `npm run build`
 * emits it into dist/ (where src/ still exists, in the builder stage) and the
 * runtime LOADS that artifact relative to __dirname. There is no CWD-relative glob
 * on the serving path any more, so there is no path by which CWD can empty it.
 *
 * Tunables live here rather than inline so the emitter, the runtime loader and the
 * guard all read ONE definition of the filename and the floor (configs-not-hardcoded).
 */

/**
 * Basename of the build artifact, written into dist/ by
 * scripts/emit-openapi-artifact.cjs and read back by ./index.ts.
 *
 * NOT `openapi.json`: that name is already taken by the checked-in frontend
 * derivation (mandrel-command/frontend/.openapi/openapi.json) guarded by the
 * artifact-drift stage, and two different files sharing a basename is exactly the
 * kind of ambiguity that makes a guard validate the wrong subject.
 */
export const OPENAPI_ARTIFACT_BASENAME =
  process.env.OPENAPI_ARTIFACT_BASENAME || 'openapi.spec.json';

/**
 * Minimum number of documented paths for a spec to be considered VALID.
 *
 * ZERO IS NOT A VALID POPULATION HERE. The whole defect was a zero-path document
 * being served as though it were the contract, so the floor is what converts a
 * vacuous success into a finding — in the emitter (build fails) and in the loader
 * (startup finding + the route refuses to serve it).
 *
 * The spec carried 60 paths at v0.52.1. The floor sits well below that so ordinary
 * API churn never trips it, and far above zero so a collapsed glob cannot pass.
 * Deliberately the SAME default as OPENAPI_DRIFT_MIN_PATHS in
 * scripts/lib/openapi-drift.config.sh — the two guards measure different
 * populations (source tree vs shipped image) and must not disagree on what "too
 * few" means. Raise both together; never pin to the exact current count.
 */
export const OPENAPI_MIN_PATHS = Number(process.env.OPENAPI_MIN_PATHS || 20);
