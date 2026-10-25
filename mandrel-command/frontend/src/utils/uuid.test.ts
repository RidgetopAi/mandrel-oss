import {
  newCorrelationId,
  isValidUuid,
  UNASSIGNED_PROJECT_ID,
  PROJECT_STORAGE_KEYS,
  clearStoredProject,
} from './uuid';

/**
 * Guard test for the customer-reported "Failed to Load Project Insights — Bad
 * Request". isValidUuid is the gate that stops the UI from calling UUID-validated
 * backend routes (insights/sessions/etc.) with an id that would 400.
 */
describe('isValidUuid', () => {
  test('accepts a real canonical UUID (any case)', () => {
    expect(isValidUuid('11111111-2222-4333-8444-555555555555')).toBe(true);
    expect(isValidUuid('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true);
  });

  test('rejects the UNASSIGNED / nil sentinel', () => {
    // The backend Zod uuid() would ACCEPT this, so the frontend MUST reject it
    // — this is the load-bearing half of the Bug B fix.
    expect(isValidUuid(UNASSIGNED_PROJECT_ID)).toBe(false);
    expect(isValidUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  test('rejects synthetic aidis-<name> ids (the actual root cause)', () => {
    expect(isValidUuid('aidis-my-project')).toBe(false);
    expect(isValidUuid('aidis-personal-project')).toBe(false);
  });

  test('rejects undefined / null / non-string / empty / garbage', () => {
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid(null)).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('undefined')).toBe(false);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid(12345)).toBe(false);
    expect(isValidUuid({})).toBe(false);
  });

  test('rejects the contoso corrupt id `session_voiceitt-bridge`', () => {
    // The exact client-side value that drove /api/projects/{badid} and the SSE
    // projectId into repeated 400s on the customer dashboard.
    expect(isValidUuid('session_voiceitt-bridge')).toBe(false);
  });
});

/**
 * Self-heal guard (contoso dashboard bug). A corrupt persisted project id like
 * `session_voiceitt-bridge` must be purged so the app recovers on its own.
 *
 * `loadValidStoredProject` and its six cases were DELETED with the page-scope epic: that commit
 * removed its last production caller, leaving a function referenced only by its own test —
 * a guard guarding nothing. The self-heal it performed still exists and is still tested:
 * `resolveProjectHeader` does the purge now, over a four-rung ladder rather than one key
 * (api/http/projectHeaders.ts + projectHeaders.test.ts). What remains here is
 * `clearStoredProject`, which is the primitive both that ladder and logout call.
 */
describe('clearStoredProject (self-heal primitive)', () => {
  const VALID_PROJECT = {
    id: 'c875b2af-9020-41b7-9595-d70221603464',
    name: 'voiceitt-bridge',
  };

  test('clearStoredProject removes every project key', () => {
    for (const key of PROJECT_STORAGE_KEYS) {
      localStorage.setItem(key, JSON.stringify(VALID_PROJECT));
    }
    clearStoredProject();
    for (const key of PROJECT_STORAGE_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });
});

/**
 * INSECURE-CONTEXT LOGIN GUARD (2026-08-11).
 *
 * `crypto.randomUUID` exists ONLY in a secure context. Served over plain http on a
 * non-localhost host it is undefined, and the correlation-header code path threw
 * `TypeError: crypto.randomUUID is not a function` — which broke EVERY request,
 * including login, with a bare `status: 0`. Measured live on a Tailscale IP.
 *
 * These tests run the insecure-context shapes explicitly, because that is the
 * population the original code was never exercised against.
 */
describe('newCorrelationId — must not require a secure context', () => {
  const realCrypto = globalThis.crypto;
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: realCrypto,
      configurable: true,
      writable: true,
    });
  });

  const setCrypto = (value: unknown) =>
    Object.defineProperty(globalThis, 'crypto', {
      value,
      configurable: true,
      writable: true,
    });

  test('uses randomUUID when the context IS secure', () => {
    setCrypto({ randomUUID: () => '11111111-2222-4333-8444-555555555555' });
    expect(newCorrelationId()).toBe('11111111-2222-4333-8444-555555555555');
  });

  test('INSECURE CONTEXT: randomUUID absent -> still returns a valid v4 (this is the bug)', () => {
    // Exactly what a browser exposes over plain http on a non-localhost origin:
    // getRandomValues is present, randomUUID is NOT.
    setCrypto({
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 3) & 0xff;
        return arr;
      },
    });
    const id = newCorrelationId();
    expect(id).toMatch(V4);
  });

  test('no Web Crypto at all -> still returns a valid v4 rather than throwing', () => {
    setCrypto(undefined);
    expect(newCorrelationId()).toMatch(V4);
  });

  test('produces distinct ids (a constant would still match the regex)', () => {
    setCrypto({
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    });
    const ids = new Set(Array.from({ length: 50 }, () => newCorrelationId()));
    expect(ids.size).toBe(50);
  });
});
