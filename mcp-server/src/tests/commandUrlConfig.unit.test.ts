/**
 * commandUrlConfig — the ONE shared record-permalink helper ( * an earlier decision). Pure unit test (no DB): proves the helper's contract in isolation.
 *
 *  1. recordUrl(id) builds `${base}/r/<id8>` — the plain full URL, id8 = first 8 chars.
 *  2. formatRecordRef(id) is the house-style permalink line (the plain URL — WS1 an earlier task
 *     dropped the 🔗 marker: MCP text goes to machine readers) — one source.
 *  3. The base URL is CONFIG-DRIVEN: overriding COMMAND_BASE_URL changes the emitted URL
 *     (env override tested via vi.resetModules + dynamic import — the beliefConfig idiom).
 *  4. Only the resolvable record types (context/task/decision/session/project
 *     added the last two) are linkifiable, and that set is held in PARITY with the
 *     Command backend resolver's own enumeration by a cross-boundary guard at the bottom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ENV_KEYS = ['COMMAND_BASE_URL', 'MCP_ALLOWED_HOSTS'] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** Fresh module instance under the given env overrides (undefined = leave unset). */
async function freshConfig(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  clearEnv();
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  vi.resetModules();
  return import('@/config/commandUrlConfig');
}

/**
 * These tests must OWN both env vars (including the "unset" case), so they delete rather than
 * stub. vitest.setup.ts now pins COMMAND_BASE_URL suite-wide, so deleting it would leave
 * process.env different from the snapshot and trip the env-leak guard — the
 * suite shares ONE process. Capture the baseline at module load and put it back after each
 * test, so this file can clear freely without reconfiguring every file that runs after it.
 */
const ENV_BASELINE: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]])
);

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const original = ENV_BASELINE[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
}

beforeEach(clearEnv);
afterEach(restoreEnv);

const UUID = 'd7b47a46-383e-4e29-bc34-a37aba07b693';
const ID8 = 'd7b47a46';

describe('commandUrlConfig — recordUrl (THE shared permalink helper)', () => {
  it('builds a PLAIN full https URL pointing at /r/<id8> (not markdown)', async () => {
    const { recordUrl } = await freshConfig({
      COMMAND_BASE_URL: 'https://command.example.com',
    });
    const url = recordUrl(UUID);
    expect(url).toBe(`https://command.example.com/r/${ID8}`);
    // Plain URL — no markdown link wrapper (would break on X + dumb terminals).
    expect(url).not.toContain('[');
    expect(url).not.toContain('](');
    expect(url).toMatch(/^https:\/\/[^\s]+\/r\/[0-9a-f]{8}$/);
  });

  it('shortens to the first 8 chars (id8), matching the /r/:id resolver contract', async () => {
    const { recordUrl, recordId8 } = await freshConfig({
      COMMAND_BASE_URL: 'https://command.example.com',
    });
    expect(recordId8(UUID)).toBe(ID8);
    // An already-short id passes through unchanged.
    expect(recordUrl(ID8)).toBe(`https://command.example.com/r/${ID8}`);
  });

  it('is CONFIG-DRIVEN: overriding COMMAND_BASE_URL changes the emitted URL', async () => {
    const c = await freshConfig({ COMMAND_BASE_URL: 'https://staging.example.test' });
    expect(c.COMMAND_BASE_URL).toBe('https://staging.example.test');
    expect(c.recordUrl(UUID)).toBe(`https://staging.example.test/r/${ID8}`);
  });

  it('strips a trailing slash on the configured base so the path joins cleanly', async () => {
    const c = await freshConfig({ COMMAND_BASE_URL: 'https://command.example.com/' });
    expect(c.recordUrl(UUID)).toBe(`https://command.example.com/r/${ID8}`);
  });

  it('treats an empty/blank env value as unset and falls through to derivation', async () => {
    const c = await freshConfig({
      COMMAND_BASE_URL: '   ',
      MCP_ALLOWED_HOSTS: 'contoso.mandrel.example.com',
    });
    expect(c.recordUrl(UUID)).toBe(`https://contoso.mandrel.example.com/r/${ID8}`);
  });
});

/**
 * THE REGRESSION GUARD (customer bug, 2026-07-30). The old module defaulted to the literal
 * `https://command.example.com`, so every tenant — all of which run with COMMAND_BASE_URL
 * unset — emitted permalinks into OUR instance. These tests pin the property that actually
 * matters: with NO explicit config, the emitted origin is THIS instance's own host, never a
 * hardcoded foreign one.
 */
describe('commandUrlConfig — multi-tenant origin (never a foreign instance)', () => {
  it('derives the tenant origin from MCP_ALLOWED_HOSTS when COMMAND_BASE_URL is unset', async () => {
    const c = await freshConfig({
      MCP_ALLOWED_HOSTS: 'contoso.mandrel.example.com,127.0.0.1:18083,localhost:18083', // reserved-port-ok: host-list string fixture, not a bound port
    });
    expect(c.COMMAND_BASE_URL).toBe('https://contoso.mandrel.example.com');
    expect(c.recordUrl(UUID)).toBe(`https://contoso.mandrel.example.com/r/${ID8}`);
  });

  it('NEVER emits a hardcoded foreign origin for an unconfigured tenant', async () => {
    for (const host of ['contoso', 'fabrikam', 'globex', 'initech', 'operator', 'app']) {
      const c = await freshConfig({
        MCP_ALLOWED_HOSTS: `${host}.mandrel.example.com,127.0.0.1:18083`, // reserved-port-ok: host-list string fixture, not a bound port
      });
      expect(c.recordUrl(UUID)).toBe(`https://${host}.mandrel.example.com/r/${ID8}`);
      expect(c.COMMAND_BASE_URL).not.toBe('https://command.example.com');
    }
  });

  it('SKIPS loopback entries rather than taking [0] — nothing orders this list public-first', async () => {
    const c = await freshConfig({
      MCP_ALLOWED_HOSTS: '127.0.0.1:18099,localhost:18099,staging.mandrel.example.com', // reserved-port-ok: host-list string fixture, not a bound port
    });
    expect(c.COMMAND_BASE_URL).toBe('https://staging.mandrel.example.com');
  });

  it('lets explicit COMMAND_BASE_URL beat derivation — the prod case, where the MCP host and the Command UI DIFFER', async () => {
    const c = await freshConfig({
      COMMAND_BASE_URL: 'https://command.example.com',
      MCP_ALLOWED_HOSTS: 'mandrel.example.com',
    });
    expect(c.COMMAND_BASE_URL).toBe('https://command.example.com');
  });

  it('falls back to a LOCAL dev origin when nothing is configured (never a foreign one)', async () => {
    for (const hosts of [undefined, '', '   ', '127.0.0.1:18099,localhost:18099', '::1']) { // reserved-port-ok: host-list string fixture, not a bound port
      const c = await freshConfig(hosts === undefined ? {} : { MCP_ALLOWED_HOSTS: hosts });
      expect(c.COMMAND_BASE_URL).toBe('http://localhost:3000'); // fixed-port-ok: asserts a config default's value; binds nothing
    }
  });
});

describe('commandUrlConfig — formatRecordRef (house-style permalink line)', () => {
  it('emits exactly the recordUrl, plain, with NO emoji marker (WS1 an earlier task)', async () => {
    const { formatRecordRef, recordUrl } = await freshConfig({
      COMMAND_BASE_URL: 'https://command.example.com',
    });
    expect(formatRecordRef(UUID)).toBe(recordUrl(UUID));
    expect(formatRecordRef(UUID)).toBe(`https://command.example.com/r/${ID8}`);
  });

  it('tracks the configured base URL (proving it routes through recordUrl)', async () => {
    const c = await freshConfig({ COMMAND_BASE_URL: 'https://staging.example.test' });
    expect(c.formatRecordRef(UUID)).toBe(`https://staging.example.test/r/${ID8}`);
  });
});

describe('commandUrlConfig — isResolvableRecordType (the /r/:id resolvable set)', () => {
  it('accepts exactly the five types the resolver resolves', async () => {
    const { isResolvableRecordType, RESOLVABLE_RECORD_TYPES } = await freshConfig();
    expect([...RESOLVABLE_RECORD_TYPES].sort()).toEqual([
      'context',
      'decision',
      'project',
      'session',
      'task',
    ]);
    for (const t of RESOLVABLE_RECORD_TYPES) {
      expect(isResolvableRecordType(t)).toBe(true);
    }
  });

  it('rejects non-resolvable / mixed-search types (no 404 permalinks)', async () => {
    const { isResolvableRecordType } = await freshConfig();
    for (const t of ['component', 'naming', 'agent', 'handoff', '', undefined, null]) {
      expect(isResolvableRecordType(t as any)).toBe(false);
    }
  });
});

/**
 * CROSS-BOUNDARY PARITY GUARD.
 *
 * This mcp-server list and the Command backend resolver's own RESOLVABLE_TYPES are two
 * copies of one truth that CANNOT import each other (different tsconfig rootDirs — see the
 * note in commandUrlConfig.ts). Two copies with no guard is precisely how this file spent
 * weeks asserting that a session permalink would 404.
 *
 * The failure this catches is ASYMMETRIC, so both directions are asserted:
 *   - a type here but NOT in the resolver → we emit permalinks that 404 (a dead
 *     link is worse than no link). This is the dangerous direction.
 *   - a type in the resolver but NOT here → a resolvable record silently renders unlinked;
 *     harmless but it is the drift that hid for weeks, so it fails too.
 *
 * POPULATION: exactly the two enumerations named below — this guard's scope is the parity of
 * those two arrays and nothing else. It reads the backend file as TEXT rather than importing
 * it, because importing across the rootDir boundary is the very thing that is impossible.
 */
describe('commandUrlConfig — parity with the Command backend resolver enumeration', () => {
  const RESOLVER_SOURCE = path.resolve(
    HERE,
    '../../../mandrel-command/backend/src/utils/idResolver.ts',
  );

  /** Parse `export const RESOLVABLE_TYPES = [...] as const;` out of the backend source. */
  function backendResolvableTypes(): string[] {
    const src = fs.readFileSync(RESOLVER_SOURCE, 'utf8');
    const block = src.match(/export const RESOLVABLE_TYPES = \[([\s\S]*?)\] as const;/);
    if (block === null) {
      throw new Error(
        `Could not find RESOLVABLE_TYPES in ${RESOLVER_SOURCE}. If the resolver's enumeration ` +
          'was renamed or restructured, update THIS parser — do not delete the guard.',
      );
    }
    return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }

  it('finds a non-empty enumeration in the backend resolver (the guard can actually see it)', () => {
    // Without this, a parser that silently returned [] would make the parity assertion
    // below vacuously pass against an empty population — a hollow guard.
    expect(backendResolvableTypes().length).toBeGreaterThan(0);
  });

  it('linkifies exactly the set the resolver can resolve — no more (404s), no fewer (dead ids)', async () => {
    const { RESOLVABLE_RECORD_TYPES } = await freshConfig();
    expect([...RESOLVABLE_RECORD_TYPES].sort()).toEqual(backendResolvableTypes().sort());
  });
});
