/**
 * THE COMPOSE PASSTHROUGH MUST LAND ON `enforce` — proved at the REAL consumer.
 *
 * WHAT CHANGED AND WHY THIS FILE EXISTS
 *   docker-compose.yml used to hand every container `MANDREL_PROJECT_SCOPE_GUARD=shadow`,
 *   overwriting the code's fail-closed default at the container boundary. The soak is
 *   over and Operator approved enforcing. The fix is NOT to swap the literal `shadow` for
 *   the literal `enforce` — that leaves the same defect (a per-deployment value baked
 *   into a tracked file) and re-creates the drift the moment the code default moves.
 *   The fix is a PASSTHROUGH: `"${MANDREL_PROJECT_SCOPE_GUARD:-}"`, so an operator who
 *   sets nothing gets the CODE's default rather than compose's opinion of it.
 *
 * THE PREMISE THAT MAKES THAT SAFE, AND WHY IT NEEDED A TEST
 *   A passthrough does NOT produce an UNSET variable. Docker Compose renders the empty
 *   default to an EMPTY STRING and sets the key in the container environment. So the
 *   value the code actually sees is `''`, not `undefined` — a different branch, and the
 *   one that has to fail closed. `readProjectScopeGuardMode('')` is already asserted in
 *   unidentifiedCallerScope.contract.test.ts, but that exercises the PARSE FUNCTION with
 *   an explicit argument. The thing the guard consults is
 *   CALLER_IDENTITY_CONFIG.unidentifiedGuardMode, which is memoized at MODULE LOAD from
 *   process.env. Those are not the same surface (CLASSES.md C2: exercise the surface the
 *   consumer uses, not a convenient proxy), and the default-parameter indirection
 *   (`raw: string | undefined = process.env[...]`) is exactly the kind of seam where an
 *   empty string and an absent value diverge — a default parameter fires on `undefined`
 *   and NOT on `''`.
 *
 * SO THIS FILE DRIVES process.env AND RE-EVALUATES THE MODULE, then reads the memoized
 * config the guard reads. Every case re-imports fresh (vi.resetModules) because the value
 * is captured at load — a single import would prove only whatever the suite's ambient env
 * happened to be.
 *
 * ANTI-VACUOUS: `off` and `shadow` cases are here for one reason — if this module
 * returned 'enforce' unconditionally (a stuck constant, a botched refactor), every
 * fail-closed assertion below would pass for the wrong reason. Those two must come back
 * as themselves or the enforce assertions mean nothing.
 */
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';

const ENV = 'MANDREL_PROJECT_SCOPE_GUARD';
const ORIGINAL = process.env[ENV];

/** Set (or delete) the env var, re-evaluate the config module, return the live mode. */
async function modeUnder(raw: string | undefined): Promise<string> {
  if (raw === undefined) delete process.env[ENV];
  else process.env[ENV] = raw;
  vi.resetModules();
  const mod = await import('../config/callerIdentityConfig.js');
  return mod.CALLER_IDENTITY_CONFIG.unidentifiedGuardMode;
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env[ENV];
  else process.env[ENV] = ORIGINAL;
  vi.resetModules();
});

describe('compose passthrough -> the guard the server actually runs', () => {
  test('EMPTY STRING (what the passthrough renders) resolves to enforce at the memoized config', async () => {
    // THIS IS THE ASSERTION THE COMPOSE CHANGE RESTS ON.
    expect(await modeUnder('')).toBe('enforce');
  });

  test('whitespace-only resolves to enforce (an env file with a trailing space is the same case)', async () => {
    expect(await modeUnder('   ')).toBe('enforce');
    expect(await modeUnder('\t')).toBe('enforce');
  });

  test('UNSET resolves to enforce (the other thing a passthrough can produce)', async () => {
    expect(await modeUnder(undefined)).toBe('enforce');
  });

  test('an UNRECOGNISED value resolves to enforce, never to the permissive branch', async () => {
    expect(await modeUnder('shadwo')).toBe('enforce');
    expect(await modeUnder('disabled')).toBe('enforce');
    expect(await modeUnder('0')).toBe('enforce');
  });

  // --- ANTI-VACUOUS CONTROLS -------------------------------------------------
  // If these came back 'enforce' too, every assertion above would be meaningless.
  test('CONTROL: an explicit `off` really does come back as off (so enforce is not a stuck constant)', async () => {
    expect(await modeUnder('off')).toBe('off');
  });

  test('CONTROL: an explicit `shadow` really does come back as shadow', async () => {
    expect(await modeUnder('shadow')).toBe('shadow');
    // ...and case/whitespace tolerance still applies to a REAL value, not just to the
    // fail-closed branch.
    expect(await modeUnder(' SHADOW ')).toBe('shadow');
  });

  test('CONTROL: an explicit `enforce` is honoured (so a tenant can still pin it deliberately)', async () => {
    expect(await modeUnder('enforce')).toBe('enforce');
  });
});
