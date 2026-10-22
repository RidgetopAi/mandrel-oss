/**
 * bridgeAuthConfig — PURE-logic unit tests for the on-box MCP bridge auth flag.
 * NO DB, NO HTTP.
 *
 * Locks the PHASE 2 contract: bridgeAuthEnabled() now defaults fail-CLOSED (TRUE) — "require the
 * token unless explicitly disabled". This is the single source of truth for the flipped default
 * (bearerAuth's bridgeAuth() and the healthServer mount both read it), so the default value is
 * asserted HERE at the source rather than only through the HTTP harness (whose suite-wide baseline
 * pins MCP_BRIDGE_AUTH_ENABLED='false' so the tool-surface tests can run un-credentialled).
 *
 * bridgeAuthEnabled() reads env at CALL TIME (envBool), so no module reload is needed — each case
 * just sets/clears the one env var and calls. The original value is snapshotted and restored so the
 * suite-wide env-leak guard (vitest.setup.ts) stays satisfied.
 *
 * MUTATION-PROBE: revert the default in bridgeAuthConfig.ts (envBool(..., true) → ..., false) and
 * the "UNSET → true" + the truthy-omission cases below MUST fail — that is what proves this test
 * pins the flipped default, not just the parser.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bridgeAuthEnabled, BRIDGE_AUTH_ENV } from '@/config/bridgeAuthConfig';

const FLAG = BRIDGE_AUTH_ENV.ENABLED; // 'MCP_BRIDGE_AUTH_ENABLED'

describe('bridgeAuthEnabled — fail-CLOSED by default', () => {
  let original: string | undefined;

  beforeAll(() => {
    original = process.env[FLAG];
  });

  afterEach(() => {
    delete process.env[FLAG];
  });

  afterAll(() => {
    // Restore the suite-wide baseline (vitest.setup pins it to 'false') so the env-leak guard passes.
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('UNSET → enforce (true): the flipped production default, fail-CLOSED', () => {
    delete process.env[FLAG];
    expect(bridgeAuthEnabled()).toBe(true);
  });

  it('empty / whitespace → enforce (true): treated as unset, still fail-CLOSED', () => {
    process.env[FLAG] = '';
    expect(bridgeAuthEnabled()).toBe(true);
    process.env[FLAG] = '   ';
    expect(bridgeAuthEnabled()).toBe(true);
  });

  it.each(['false', '0', 'off', 'no', 'FALSE', 'Off'])(
    'explicit falsey %j → disabled (false): the deliberate opt-out',
    (value) => {
      process.env[FLAG] = value;
      expect(bridgeAuthEnabled()).toBe(false);
    },
  );

  it.each(['true', '1', 'on', 'yes', 'TRUE', 'On'])(
    'explicit truthy %j → enforce (true)',
    (value) => {
      process.env[FLAG] = value;
      expect(bridgeAuthEnabled()).toBe(true);
    },
  );

  it('garbage / unrecognized value → enforce (true): not an explicit opt-out, so stays closed', () => {
    // Only the recognized falsey tokens disable the gate; anything else is NOT an explicit
    // "disable", so the fail-closed default wins (a typo can never silently fall open).
    process.env[FLAG] = 'maybe';
    expect(bridgeAuthEnabled()).toBe(true);
  });
});
