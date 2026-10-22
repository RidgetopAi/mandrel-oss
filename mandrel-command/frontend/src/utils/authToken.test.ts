/**
 * Unit tests for the single token-validity source (R6).
 *
 * These exercise the REAL getValidToken/isTokenExpired/isAuthedByToken — the one
 * gate every "am I authed?" reader now uses. jwt-decode only DECODES (no
 * signature verification), so a hand-crafted `header.payload.sig` with a real
 * `exp` claim is a faithful fixture.
 */
import {
  getValidToken,
  isAuthedByToken,
  isTokenExpired,
  purgeStoredAuthToken,
} from './authToken';

const base64url = (obj: object): string =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** Build a decodable (unsigned-for-test) JWT carrying the given payload. */
const makeJwt = (payload: object): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.testsig`;

const nowSec = () => Math.floor(Date.now() / 1000);
const futureExpToken = () => makeJwt({ exp: nowSec() + 3600 });
const pastExpToken = () => makeJwt({ exp: nowSec() - 3600 });

beforeEach(() => {
  localStorage.clear();
});

describe('getValidToken', () => {
  test('present + unexpired token → returns the token', () => {
    const token = futureExpToken();
    localStorage.setItem('aidis_token', token);
    expect(getValidToken()).toBe(token);
  });

  test('expired token → null AND purges aidis_token + aidis_user', () => {
    localStorage.setItem('aidis_token', pastExpToken());
    localStorage.setItem('aidis_user', JSON.stringify({ id: 'u1' }));

    expect(getValidToken()).toBeNull();
    expect(localStorage.getItem('aidis_token')).toBeNull();
    expect(localStorage.getItem('aidis_user')).toBeNull();
  });

  test('absent token → null', () => {
    expect(getValidToken()).toBeNull();
  });

  test('malformed (non-JWT) token → null and purged', () => {
    localStorage.setItem('aidis_token', 'not-a-real-jwt');
    expect(getValidToken()).toBeNull();
    expect(localStorage.getItem('aidis_token')).toBeNull();
  });

  test('token with no exp claim → treated as valid (server stays the authority)', () => {
    const token = makeJwt({ sub: 'u1' });
    localStorage.setItem('aidis_token', token);
    expect(getValidToken()).toBe(token);
  });
});

describe('clock-skew leeway (configs-not-hardcoded, default 30s)', () => {
  test('token a few seconds past exp but within leeway → still valid', () => {
    // exp 10s ago; default leeway is 30s, so it is NOT yet treated as expired.
    localStorage.setItem('aidis_token', makeJwt({ exp: nowSec() - 10 }));
    expect(isAuthedByToken()).toBe(true);
  });

  test('token well past exp + leeway → expired', () => {
    localStorage.setItem('aidis_token', makeJwt({ exp: nowSec() - 120 }));
    expect(isAuthedByToken()).toBe(false);
  });
});

describe('isTokenExpired (pure)', () => {
  test('future exp → not expired', () => {
    expect(isTokenExpired(futureExpToken())).toBe(false);
  });
  test('past exp → expired', () => {
    expect(isTokenExpired(pastExpToken())).toBe(true);
  });
  test('undecodable → expired/invalid', () => {
    expect(isTokenExpired('garbage')).toBe(true);
  });
});

describe('isAuthedByToken + purgeStoredAuthToken', () => {
  test('true only for a present, unexpired token', () => {
    expect(isAuthedByToken()).toBe(false);
    localStorage.setItem('aidis_token', futureExpToken());
    expect(isAuthedByToken()).toBe(true);
  });

  test('purgeStoredAuthToken removes both token and user', () => {
    localStorage.setItem('aidis_token', futureExpToken());
    localStorage.setItem('aidis_user', JSON.stringify({ id: 'u1' }));
    purgeStoredAuthToken();
    expect(localStorage.getItem('aidis_token')).toBeNull();
    expect(localStorage.getItem('aidis_user')).toBeNull();
  });
});
