/**
 * Single source of truth for the Mandrel MCP server's RUNTIME version.
 *
 * WHY THIS FILE EXISTS
 *   The product version a connecting agent sees (MCP `initialize` serverInfo),
 *   the health endpoints, the HTTP `/healthz` service banner, and the
 *   `mandrel_status` tool MUST all report the SAME number — and that number
 *   must be the ONE fact in `mcp-server/package.json`'s `version` field. We had
 *   the classic duplication disease: that fact was hand-copied into many places
 *   that drifted ('0.1.0-hardened', '1.0.0-core', etc.) and silently diverged
 *   from the package/tag. This module collapses all of that into ONE accessor.
 *
 *   Import `MANDREL_VERSION` (or call `getMandrelVersion()`) anywhere a runtime
 *   version string is needed. Never hard-code a version string again — the
 *   code-health "version sanity" check and a unit test both fail CI on re-drift.
 *
 * HOW IT RESOLVES package.json (ESM + compiled dist, robustly)
 *   This file compiles to `dist/version.js`. `package.json` lives at the
 *   mcp-server package root, i.e. one directory ABOVE `dist/` (`dist/../package.json`).
 *   The SAME `../package.json` relationship holds for the SOURCE layout
 *   (`src/version.ts` -> `src/../package.json`), so a single relative path works
 *   for both tsx-run source and compiled dist.
 *
 *   We deliberately avoid a static `import pkg from '../package.json'` (JSON
 *   import-assertion syntax is brittle across the TS/Node/ESM matrix and can pull
 *   package.json INTO the dist bundle layout). Instead we resolve and read the
 *   file at runtime via `createRequire(import.meta.url)` anchored to THIS module's
 *   own URL, then read+parse it with `fs`. That is layout-correct for both
 *   `src/version.ts` (tsx) and `dist/version.js` (node), and is what the test +
 *   the dist proof exercise.
 *
 * WHY THE REPORTED VERSION CARRIES A BUILD-METADATA SUFFIX
 *   The semver alone could not discriminate between refs: v0.19.0 spanned 62
 *   commits and three separate fleet releases, so a deploy assertion reading
 *   "initialize reports v0.19.0" passed while prod ran a DIFFERENT build
 *. The reported version is therefore `<semver>+<revision>`,
 *   which is spec-legal semver BUILD METADATA (SemVer 2.0.0 §10 — ignored when
 *   determining precedence), so clients that parse semver are unaffected.
 *
 *   `package.json` REMAINS the semver source of truth. No sha is ever written
 *   into it; `scripts/release.sh` is still the only thing that moves the semver.
 *
 * ONE SOURCE FOR "WHICH REF IS THIS" — deliberately not two
 *   The revision comes from the `MANDREL_IMAGE_REVISION` environment variable
 *   and from NOWHERE ELSE. That is the SAME compose variable that
 *   docker-compose.build.yml already requires fail-closed (`:?`) and stamps as
 *   the `org.opencontainers.image.revision` image label, plumbed into the
 *   process by mcp-server/Dockerfile's ARG->ENV in the runner stage. Label and
 *   reported version are therefore physically incapable of disagreeing. We do
 *   NOT shell out to git and do NOT read a build-stamp file: a second path to
 *   "what ref is this" is the failure class this change exists to close.
 *
 * THE UNKNOWN CASE IS LEGIBLE, NEVER SILENT (C1 — an instrument has THREE states)
 *   Outside a fleet image (dev tree, `npm run dev`, a test run) there is no
 *   revision. Reporting a bare `0.19.0` there would look exactly like a clean
 *   release and would reintroduce the ambiguity being removed, so the suffix is
 *   ALWAYS present and names the state it is in:
 *     full 40-hex sha             -> `+<first 12, lowercased>`  (a fleet build)
 *     absent/blank env var        -> `+unknown`  (not a fleet build)
 *     set but not a full 40-hex sha -> `+invalid` (a real build defect, surfaced)
 *   Neither is thrown on: the version string must never be able to take the
 *   server down. Both are semver-legal build-metadata identifiers.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

interface PackageJsonShape {
  version?: unknown;
}

/**
 * Resolve and read the package's own version field at runtime.
 * Anchored to this module's URL so it is correct from BOTH src/ and dist/.
 * Fails LOUD (throws) if the version cannot be determined — a missing/blank
 * version is a real defect we want surfaced, never a silent fallback string.
 */
function resolvePackageVersion(): string {
  const require = createRequire(import.meta.url);
  // ../package.json relative to this module (src/version.ts OR dist/version.js).
  const pkgPath = require.resolve('../package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as PackageJsonShape;
  const version = pkg.version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(
      `[version] mcp-server/package.json has no usable "version" field (resolved: ${pkgPath})`,
    );
  }
  return version;
}

/**
 * The env var carrying the release ref. The SAME name docker-compose.build.yml
 * requires at build time and stamps as org.opencontainers.image.revision.
 */
export const REVISION_ENV_VAR = 'MANDREL_IMAGE_REVISION';

/** How many leading chars of the revision go in the suffix. 12 == MANDREL_IMAGE_TAG's
 *  width (`git rev-parse --short=12`), so the suffix IS the release image tag. */
export const REVISION_SHORT_LEN = 12;

/** Suffix when no revision was supplied — i.e. this is not a fleet image build. */
export const BUILD_METADATA_UNKNOWN = 'unknown';

/** Suffix when a revision WAS supplied but is not a git object id — a build defect. */
export const BUILD_METADATA_INVALID = 'invalid';

/**
 * A FULL git object id: exactly 40 hex chars, nothing else.
 *
 * WHY EXACTLY 40 AND NOT A RANGE (7..40) — the suffix width must be FIXED.
 *   The release build (docker-compose.build.yml)
 *   sets MANDREL_IMAGE_REVISION="$(git rev-parse HEAD)" — always a full
 *   40-hex sha. Accepting a shorter id would buy nothing real and would let the
 *   reported string take a FOURTH shape (`0.19.0+cdf9f00`, a 7-char suffix)
 *   beyond the three this contract defines. Downstream guards match the suffix
 *   as `<sha12>|unknown|invalid`; a variable-width suffix is precisely the
 *   "guard's population is narrower than reality" defect this task exists to
 *   close. So a partial id is NOT silently accepted — it reports `+invalid`,
 *   which is the honest reading: it did not come from the release lane.
 */
const REVISION_PATTERN = /^[0-9a-fA-F]{40}$/;

/**
 * Map a raw revision value to the semver build-metadata identifier to report.
 * Total function: every input maps to a legible, semver-legal identifier, and
 * the three states (present / absent / present-but-unusable) stay distinct.
 */
export function resolveBuildMetadata(rawRevision: string | undefined | null): string {
  const rev = (rawRevision ?? '').trim();
  if (rev === '') return BUILD_METADATA_UNKNOWN;
  if (!REVISION_PATTERN.test(rev)) return BUILD_METADATA_INVALID;
  return rev.slice(0, REVISION_SHORT_LEN).toLowerCase();
}

/** Join the semver core and a raw revision into the reported version string. */
export function composeVersion(semver: string, rawRevision: string | undefined | null): string {
  return `${semver}+${resolveBuildMetadata(rawRevision)}`;
}

/**
 * The SEMVER CORE, straight from mcp-server/package.json. This is the number
 * scripts/release.sh moves and the one all five surfaces must agree on.
 */
export const MANDREL_SEMVER: string = resolvePackageVersion();

/**
 * The runtime product version as REPORTED to clients: `<semver>+<revision>`.
 * Derived once at module load — the env var is fixed for the process lifetime.
 */
export const MANDREL_VERSION: string = composeVersion(
  MANDREL_SEMVER,
  process.env[REVISION_ENV_VAR], // env-read: MANDREL_IMAGE_REVISION
);

/**
 * The server NAME reported to clients (MCP `initialize` serverInfo.name), on every transport.
 * The package name (mcp-server/package.json); it replaced the legacy 'aidis-mcp-server'.
 */
export const MANDREL_SERVER_NAME = 'mandrel-mcp-server';

/** Accessor form, for callers that prefer a function. Returns the same value. */
export function getMandrelVersion(): string {
  return MANDREL_VERSION;
}
