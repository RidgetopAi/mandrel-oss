/**
 * an earlier Task — single source of truth for the auth token (stale-token fix).
 *
 * THE BUG:
 *   hooks/useAuth.ts used to pin a STATIC token/headers onto the global OpenAPI
 *   config (`OpenAPI.TOKEN = '<captured string>'`,
 *   `OpenAPI.HEADERS = { Authorization: 'Bearer <captured string>' }`) at
 *   module-load and on every login. That static value raced with — and could
 *   clobber — api/client.ts's FUNCTION resolver that reads localStorage fresh.
 *   After a stale token was captured, some parallel authed calls sent the STALE
 *   token (→ 401) while siblings sent the fresh one. A single such 401 then
 *   tripped the force-logout → logout loop.
 *
 * THE FIX:
 *   localStorage 'aidis_token' is the ONLY source of truth. api/client.ts's
 *   OpenAPI.TOKEN is a function that reads it fresh on every request, and
 *   useAuth.ts only writes localStorage (it no longer pins a static copy).
 *
 * WHAT THIS PROVES:
 *   - OpenAPI.TOKEN is a FUNCTION (not a pinned string).
 *   - It always resolves to whatever is CURRENTLY in localStorage — including
 *     across a "stale token present, then fresh login replaces it" sequence —
 *     so it is impossible for one call to carry a stale token while a sibling
 *     carries the fresh one.
 */
import { OpenAPI } from './client';

const resolveToken = async (): Promise<string> => {
  const t = OpenAPI.TOKEN;
  if (typeof t === 'function') {
    return (await (t as any)({} as any)) as string;
  }
  // Bug guard: a pinned string here is the regression we are preventing.
  return (t as unknown as string) ?? '';
};

beforeEach(() => {
  localStorage.clear();
});

describe('OpenAPI token is a fresh single-source resolver (no stale pin)', () => {
  test('OpenAPI.TOKEN is a function, not a pinned static value', () => {
    expect(typeof OpenAPI.TOKEN).toBe('function');
  });

  test('resolves to the CURRENT localStorage token', async () => {
    localStorage.setItem('aidis_token', 'token-A');
    await expect(resolveToken()).resolves.toBe('token-A');
  });

  test('stale-token-then-fresh-login: every resolve sees the FRESH token', async () => {
    // 1) Stale token left in storage (the laptop scenario).
    localStorage.setItem('aidis_token', 'STALE-token');
    await expect(resolveToken()).resolves.toBe('STALE-token');

    // 2) Fresh login replaces it (what useAuth.useLogin now does: write
    //    localStorage only — no static pin onto OpenAPI config).
    localStorage.setItem('aidis_token', 'FRESH-token');

    // 3) Parallel calls resolving "the same instant" all read the fresh token —
    //    none can pick up a stale pinned copy.
    const results = await Promise.all([resolveToken(), resolveToken(), resolveToken()]);
    expect(results).toEqual(['FRESH-token', 'FRESH-token', 'FRESH-token']);
  });

  test('empty when no token stored (logged out)', async () => {
    await expect(resolveToken()).resolves.toBe('');
  });
});
