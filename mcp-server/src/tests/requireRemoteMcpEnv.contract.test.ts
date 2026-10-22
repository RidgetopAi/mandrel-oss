/**
 * Contract test for the fail-loud remote-MCP env startup guard.
 *
 * Proves the three behaviors the task requires:
 *   1. Remote-serving mode + a required var MISSING  → guard fires, exit(1), and the
 *      FATAL message NAMES the exact missing var(s).
 *   2. Remote-serving mode + ALL required env present → guard passes (no exit).
 *   3. Plain local/stdio/dev mode (not serving)       → guard is a no-op (no exit),
 *      even with NO MCP_AUTH_TOKEN / MCP_ALLOWED_HOSTS set — does NOT break dev.
 *
 * This targets the PURE evaluator + the injectable-exit wrapper so we assert the
 * real exit code + message without tearing down the vitest process. No DB needed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isRemoteMcpServingMode,
  evaluateRemoteMcpEnv,
  assertRemoteMcpEnvOrExit,
  formatMissingEnvFatal,
  REQUIRED_REMOTE_MCP_VARS,
} from '@/server/requireRemoteMcpEnv';

/** Build a clean env object (no leakage from the host process). */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base;
}

const FULL_REMOTE_ENV = {
  NODE_ENV: 'production',
  MCP_AUTH_TOKEN: 'deadbeefdeadbeefdeadbeefdeadbeef',
  MCP_ALLOWED_HOSTS: 'mandrel.example.com',
};

describe('isRemoteMcpServingMode() — the gate condition', () => {
  it('is TRUE for NODE_ENV=production (tenant docker / prod systemd / staging)', () => {
    expect(isRemoteMcpServingMode(env({ NODE_ENV: 'production' }))).toBe(true);
  });

  it('is FALSE for NODE_ENV=test (CI), development, and unset (local stdio/dev)', () => {
    expect(isRemoteMcpServingMode(env({ NODE_ENV: 'test' }))).toBe(false);
    expect(isRemoteMcpServingMode(env({ NODE_ENV: 'development' }))).toBe(false);
    expect(isRemoteMcpServingMode(env({}))).toBe(false);
  });

  it('honors explicit opt-in MCP_REMOTE_ENABLED=true even outside production', () => {
    expect(isRemoteMcpServingMode(env({ MCP_REMOTE_ENABLED: 'true' }))).toBe(true);
    expect(isRemoteMcpServingMode(env({ MCP_REMOTE_ENABLED: '1' }))).toBe(true);
  });

  it('honors explicit opt-out MCP_REMOTE_ENABLED=false even under production', () => {
    expect(
      isRemoteMcpServingMode(env({ NODE_ENV: 'production', MCP_REMOTE_ENABLED: 'false' }))
    ).toBe(false);
  });
});

describe('evaluateRemoteMcpEnv() — pure decision', () => {
  it('serving + all required present → ok, no missing', () => {
    const r = evaluateRemoteMcpEnv(env(FULL_REMOTE_ENV));
    expect(r.serving).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('serving + MCP_AUTH_TOKEN missing → not ok, names MCP_AUTH_TOKEN', () => {
    const r = evaluateRemoteMcpEnv(
      env({ NODE_ENV: 'production', MCP_ALLOWED_HOSTS: 'mandrel.example.com' })
    );
    expect(r.serving).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('MCP_AUTH_TOKEN');
  });

  it('serving + MCP_ALLOWED_HOSTS missing → not ok, names MCP_ALLOWED_HOSTS', () => {
    const r = evaluateRemoteMcpEnv(
      env({ NODE_ENV: 'production', MCP_AUTH_TOKEN: 'x'.repeat(32) })
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('MCP_ALLOWED_HOSTS');
  });

  it('treats whitespace-only / empty values as MISSING (not configured)', () => {
    const r = evaluateRemoteMcpEnv(
      env({ NODE_ENV: 'production', MCP_AUTH_TOKEN: '   ', MCP_ALLOWED_HOSTS: '' })
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['MCP_AUTH_TOKEN', 'MCP_ALLOWED_HOSTS']);
  });

  it('NOT serving → always ok with nothing required (dev/stdio safe)', () => {
    const r = evaluateRemoteMcpEnv(env({})); // no NODE_ENV, no token, no hosts
    expect(r.serving).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe('assertRemoteMcpEnvOrExit() — fail-loud behavior', () => {
  it('CASE 1: remote enabled + required var missing → exit(1) AND names the var', () => {
    const exit = vi.fn<(code: number) => never>(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // production + token missing (allowed-hosts present, to isolate the token miss)
    assertRemoteMcpEnvOrExit(
      env({ NODE_ENV: 'production', MCP_ALLOWED_HOSTS: 'mandrel.example.com' }),
      exit as unknown as (code: number) => never
    );

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    // The exact missing var name must appear in what we printed to the operator.
    const printed = errSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toContain('MCP_AUTH_TOKEN');
    expect(printed).toContain('FATAL');
    errSpy.mockRestore();
  });

  it('CASE 1b: BOTH missing → exit(1) and BOTH names appear', () => {
    const exit = vi.fn<(code: number) => never>(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    assertRemoteMcpEnvOrExit(
      env({ NODE_ENV: 'production' }),
      exit as unknown as (code: number) => never
    );

    expect(exit).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toContain('MCP_AUTH_TOKEN');
    expect(printed).toContain('MCP_ALLOWED_HOSTS');
    errSpy.mockRestore();
  });

  it('CASE 2: remote enabled + all required present → does NOT exit', () => {
    const exit = vi.fn<(code: number) => never>(() => undefined as never);
    assertRemoteMcpEnvOrExit(
      env(FULL_REMOTE_ENV),
      exit as unknown as (code: number) => never
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('CASE 3: plain local/stdio/dev (not serving), no token/hosts → does NOT exit', () => {
    const exit = vi.fn<(code: number) => never>(() => undefined as never);
    // No NODE_ENV=production, no MCP_AUTH_TOKEN, no MCP_ALLOWED_HOSTS.
    assertRemoteMcpEnvOrExit(
      env({ NODE_ENV: 'development' }),
      exit as unknown as (code: number) => never
    );
    expect(exit).not.toHaveBeenCalled();

    // And with NODE_ENV entirely unset (bare stdio).
    const exit2 = vi.fn<(code: number) => never>(() => undefined as never);
    assertRemoteMcpEnvOrExit(env({}), exit2 as unknown as (code: number) => never);
    expect(exit2).not.toHaveBeenCalled();
  });
});

describe('formatMissingEnvFatal() — message quality', () => {
  it('names every missing var and includes remediation guidance', () => {
    const msg = formatMissingEnvFatal(['MCP_AUTH_TOKEN', 'MCP_ALLOWED_HOSTS']);
    expect(msg).toContain('MCP_AUTH_TOKEN');
    expect(msg).toContain('MCP_ALLOWED_HOSTS');
    expect(msg).toContain('openssl rand -hex 32'); // how to mint the token
    expect(msg).toContain('MCP_REMOTE_ENABLED=false'); // the documented escape hatch
  });

  it('REQUIRED_REMOTE_MCP_VARS is the source of truth (both vars present)', () => {
    const names = REQUIRED_REMOTE_MCP_VARS.map(v => v.name);
    expect(names).toEqual(['MCP_AUTH_TOKEN', 'MCP_ALLOWED_HOSTS']);
  });
});
