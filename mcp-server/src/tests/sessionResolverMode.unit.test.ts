/**
 * Resolver-mode flag — pure config unit tests (Sessions Foundation Phase 2a).
 * NO DB. Locks the SAFETY DEFAULT: the shared resolver is INERT unless an
 * operator explicitly opts in.
 *
 * The flag is read once at module load (like every other sessionConfig knob), so we re-import
 * the module fresh under different env to assert parsing. This proves:
 *   - DEFAULT is 'legacy' (merging/deploying changes nothing);
 *   - 'shadow' / 'actor' parse (case/whitespace-insensitive);
 *   - garbage / unknown values fall back to 'legacy' (fail safe, never a surprise mode).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'MANDREL_SESSION_RESOLVER_MODE';

async function loadMode(value: string | undefined): Promise<string> {
  vi.resetModules();
  const saved = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    const mod = await import('../config/sessionConfig.js');
    return mod.SESSION_CONFIG.resolverMode;
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
}

afterEach(() => {
  vi.resetModules();
});

describe('SESSION_CONFIG.resolverMode', () => {
  it("DEFAULTS to 'legacy' when the env var is unset (the safe, inert default)", async () => {
    expect(await loadMode(undefined)).toBe('legacy');
  });

  it("parses 'shadow' and 'actor'", async () => {
    expect(await loadMode('shadow')).toBe('shadow');
    expect(await loadMode('actor')).toBe('actor');
  });

  it('is case- and whitespace-insensitive', async () => {
    expect(await loadMode('  Shadow ')).toBe('shadow');
    expect(await loadMode('ACTOR')).toBe('actor');
  });

  it("falls back to 'legacy' on unknown/garbage (fail safe)", async () => {
    expect(await loadMode('bogus')).toBe('legacy');
    expect(await loadMode('')).toBe('legacy');
  });
});

// ── Phase 4: requireActor flag (header-less tightening; DARK by default) ─────────────────
const RA_KEY = 'MANDREL_SESSION_REQUIRE_ACTOR';

async function loadRequireActor(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  const saved = process.env[RA_KEY];
  if (value === undefined) delete process.env[RA_KEY];
  else process.env[RA_KEY] = value;
  try {
    const mod = await import('../config/sessionConfig.js');
    return mod.SESSION_CONFIG.requireActor;
  } finally {
    if (saved === undefined) delete process.env[RA_KEY];
    else process.env[RA_KEY] = saved;
  }
}

describe('SESSION_CONFIG.requireActor', () => {
  it('DEFAULTS to false when the env var is unset (dark — anonymous behavior unchanged)', async () => {
    expect(await loadRequireActor(undefined)).toBe(false);
    expect(await loadRequireActor('')).toBe(false);
  });

  it('parses truthy values (1/true/yes/on), case- and whitespace-insensitive', async () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', '  True ']) {
      expect(await loadRequireActor(v)).toBe(true);
    }
  });

  it('parses falsy values (0/false/no/off)', async () => {
    for (const v of ['0', 'false', 'no', 'off']) {
      expect(await loadRequireActor(v)).toBe(false);
    }
  });

  it('falls back to false on unknown/garbage (fail safe — never surprise-enable)', async () => {
    expect(await loadRequireActor('bogus')).toBe(false);
    expect(await loadRequireActor('maybe')).toBe(false);
  });
});
