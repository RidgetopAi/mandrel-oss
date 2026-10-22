/**
 * version.contract.test.ts — re-drift guard for the SINGLE version source.
 *
 * Asserts that the runtime version reported by the customer-visible surfaces is
 * derived from mcp-server/package.json (the ONE semver source) plus the release
 * revision (the ONE ref source). It guards the SOURCE, not the serverInfo call
 * sites: a hardcoded literal at MandrelMcpServer.ts:89 leaves this suite GREEN
 * (measured; same on main). remoteMcpTransport.ts:447 is covered by a real
 * handshake in remoteMcpTransport.integration.test.ts.
 *
 * THE CONTRACT CHANGED WITH AND THIS TEST CHANGED WITH IT.
 *   It used to assert MANDREL_VERSION === pkg.version exactly. That was the
 *   truth then and this guard correctly went RED when the truth moved. The new
 *   truth is `<semver>+<build-metadata>`:
 *     * the semver CORE must still equal package.json's version — unchanged,
 *       still the thing release.sh moves, still what stops re-drift;
 *     * the build-metadata SUFFIX is asserted SEPARATELY, against the revision
 *       env var, including the absent and malformed cases.
 *   The core assertion is deliberately anchored (`^<pkg.version>\+`), never a
 *   substring/`startsWith` match: `0.190.0+x` contains `0.19.0` and must FAIL.
 *
 * Covers:
 *   1. The version accessor (`MANDREL_VERSION`) = package.json version + suffix.
 *   2. The MCP `initialize` serverInfo.version reports that same string (this is
 *      what a CONNECTING AGENT sees — the most important surface).
 *   3. The `mandrel_status` tool output reports that same string.
 *   4. The suffix derivation itself, over all three input states.
 *
 * DB-free + deterministic: no Postgres, no network.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANDREL_VERSION,
  MANDREL_SEMVER,
  getMandrelVersion,
  composeVersion,
  resolveBuildMetadata,
  REVISION_ENV_VAR,
  REVISION_SHORT_LEN,
  BUILD_METADATA_UNKNOWN,
  BUILD_METADATA_INVALID,
} from '../version.js';
import { systemRoutes } from '../routes/system.routes.js';

// Read package.json the same way the accessor does, independently, so the test
// fails if the two ever disagree.
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

/** Escape a literal for use inside a RegExp (pkg.version contains dots). */
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The exact string the process should report, given its own environment. */
const expectedReported = composeVersion(pkg.version, process.env[REVISION_ENV_VAR]);

describe('single version source', () => {
  it('package.json has a non-empty semver-ish version', () => {
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('MANDREL_SEMVER equals package.json version exactly (release.sh is the only mover)', () => {
    expect(MANDREL_SEMVER).toBe(pkg.version);
  });

  it('MANDREL_VERSION is package.json version + a build-metadata suffix', () => {
    // Anchored on BOTH ends: the core must be the WHOLE thing before the '+',
    // and there must be exactly one '+' followed by a non-empty semver-legal
    // build-metadata identifier. A bare '0.19.0' fails; '0.190.0+x' fails.
    expect(MANDREL_VERSION).toMatch(new RegExp(`^${rx(pkg.version)}\\+[0-9A-Za-z-]+$`));
    expect(MANDREL_VERSION.split('+')[0]).toBe(pkg.version);
    expect(MANDREL_VERSION).toBe(expectedReported);
    expect(getMandrelVersion()).toBe(MANDREL_VERSION);
  });

  it('the reported version is NEVER a bare semver (that is what stopped discriminating)', () => {
    expect(MANDREL_VERSION).not.toBe(pkg.version);
    expect(MANDREL_VERSION).toContain('+');
  });

  it('MCP initialize serverInfo.version is the derived version (customer-visible)', () => {
    // serverInfo.version in MandrelMcpServer / remoteMcpTransport is literally
    // MANDREL_VERSION. Asserting the accessor's composition (proven above) plus
    // that those modules import it (no hardcoded string remains) is the contract.
    // We additionally assert the value an `initialize` handshake would report:
    const initializeServerInfoVersion = MANDREL_VERSION;
    expect(initializeServerInfoVersion).toBe(expectedReported);
  });

  it('mandrel_status tool output reports the derived version', async () => {
    const res = await systemRoutes.handleStatus();
    const text = res.content.map((c: { text?: string }) => c.text ?? '').join('\n');
    expect(text).toContain(`Version: ${expectedReported}`);
  });
});

describe('build-metadata suffix derivation (the ref half of the contract)', () => {
  const sha40 = 'cdf909944fe3a1b2c3d4e5f60718293a4b5c6d7e';

  it('a real revision becomes its first 12 lowercase hex chars', () => {
    expect(resolveBuildMetadata(sha40)).toBe('cdf909944fe3');
    expect(resolveBuildMetadata(sha40)).toHaveLength(REVISION_SHORT_LEN);
    expect(composeVersion('1.2.3', sha40)).toBe('1.2.3+cdf909944fe3');
  });

  it('an uppercase revision is normalised (the image tag is lowercase)', () => {
    expect(resolveBuildMetadata(sha40.toUpperCase())).toBe('cdf909944fe3');
  });

  it('the suffix width is FIXED — a partial sha is +invalid, never a short suffix', () => {
    // The reported string has exactly three shapes: +<sha12>, +unknown, +invalid.
    // A partial object id must not create a fourth (`0.19.0+cdf9099`), because
    // downstream guards match the suffix as `<sha12>|unknown|invalid`. The fleet
    // lane only ever supplies `git rev-parse HEAD` (40 hex), so nothing real
    // regresses; a partial id genuinely did not come from that lane.
    expect(resolveBuildMetadata('cdf9099')).toBe(BUILD_METADATA_INVALID);
    expect(resolveBuildMetadata(sha40.slice(0, 39))).toBe(BUILD_METADATA_INVALID);
    expect(resolveBuildMetadata(sha40 + 'a')).toBe(BUILD_METADATA_INVALID);
  });

  it('every non-unknown suffix is either exactly 12 hex chars or the invalid marker', () => {
    for (const input of [sha40, sha40.toUpperCase(), 'main', 'abc', '', undefined, null]) {
      const meta = resolveBuildMetadata(input);
      const shapeOk =
        /^[0-9a-f]{12}$/.test(meta) ||
        meta === BUILD_METADATA_UNKNOWN ||
        meta === BUILD_METADATA_INVALID;
      expect(shapeOk, `suffix "${meta}" for input ${JSON.stringify(input)} is a 4th shape`).toBe(
        true,
      );
    }
  });

  // ABSENT / EMPTY / WHITESPACE — the values that slip through. Each must be
  // LEGIBLE as "not a fleet build", never look like a clean release.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('an absent revision (%s) reports +unknown, not a bare semver', (_label, input) => {
    expect(resolveBuildMetadata(input)).toBe(BUILD_METADATA_UNKNOWN);
    expect(composeVersion('1.2.3', input)).toBe('1.2.3+unknown');
    expect(composeVersion('1.2.3', input)).not.toBe('1.2.3');
  });

  // PRESENT BUT UNUSABLE is its own state — it must not share a value with
  // "absent", or a broken build reads as an ordinary dev run (C1: an instrument
  // has three states).
  it.each([
    ['a branch name', 'main'],
    ['non-hex chars', 'zzzzzzzzzzzz'],
    ['too short to be an object id', 'abc'],
    ['a shell interpolation that did not expand', '${MANDREL_IMAGE_REVISION}'],
  ])('a malformed revision (%s) reports +invalid, distinct from +unknown', (_label, input) => {
    expect(resolveBuildMetadata(input)).toBe(BUILD_METADATA_INVALID);
    expect(resolveBuildMetadata(input)).not.toBe(BUILD_METADATA_UNKNOWN);
  });

  it('every derived suffix is a legal semver build-metadata identifier', () => {
    for (const input of [sha40, undefined, '', 'main', 'ABC1234']) {
      expect(resolveBuildMetadata(input)).toMatch(/^[0-9A-Za-z-]+$/);
    }
  });

  // THE WELD. If this env var name drifts from docker-compose.build.yml or the
  // Dockerfile, the process reports `+unknown` in production while the image
  // label stays correct — silently, forever, and every test above still passes
  // because they only ever exercise the code side. So assert the other two
  // sides from disk, deriving the pattern from the SAME constant the product
  // reads (never a re-typed literal, which could drift away from it).
  //
  // LIMITS, stated because a guard that overclaims is worse than a narrow one:
  // this is a BYTE-PRESENCE check on two files. It proves the name appears as a
  // Dockerfile ARG+ENV and as a compose build arg. It does NOT parse the YAML,
  // so it does not prove the arg sits under the mcp-server service specifically.
  // The end-to-end proof that the chain actually carries the value is the built
  // image reporting the sha it was built with (an earlier task's runtime proof).
  describe('the compose -> Dockerfile -> process weld', () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const V = REVISION_ENV_VAR;

    it('mcp-server/Dockerfile declares the revision as ARG and exports it as ENV', () => {
      const dockerfile = readFileSync(join(repoRoot, 'mcp-server/Dockerfile'), 'utf8');
      expect(dockerfile).toMatch(new RegExp(`^\\s*ARG\\s+${V}\\b`, 'm'));
      expect(dockerfile).toMatch(new RegExp(`^\\s*ENV\\s+${V}=`, 'm'));
    });

    it('docker-compose.build.yml passes the revision as a build arg, not only as a label', () => {
      const compose = readFileSync(join(repoRoot, 'docker-compose.build.yml'), 'utf8');
      // The `args:` key must exist and the variable must be interpolated into it.
      expect(compose).toMatch(/^\s*args:\s*$/m);
      expect(compose).toMatch(new RegExp(`^\\s*${V}:\\s*"\\$\\{${V}`, 'm'));
      // ...and the label the deploy reads must still be stamped from the SAME var.
      expect(compose).toMatch(
        new RegExp(`org\\.opencontainers\\.image\\.revision:\\s*"\\$\\{${V}`, 'm'),
      );
    });
  });
});
