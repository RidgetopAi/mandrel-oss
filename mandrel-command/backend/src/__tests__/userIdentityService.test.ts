/**
 * userIdentityService.test.ts — the SERVICE half of an earlier task.
 *
 * `profileIdentityHardening.test.ts` drives the route with `UserService` mocked, so it
 * proves the ROUTE refuses. It cannot prove the service primitives it calls are correct —
 * a mocked `verifyCurrentPassword` returns whatever the test says. This file closes that
 * gap: it exercises the real service functions against a fake pool and a fake AuthService,
 * so both halves of the re-auth claim are measured rather than assumed.
 *
 * The SQL is asserted textually for exactly one property — that the uniqueness comparison
 * is case-folded — because that is the defect ("Operator" and "operator" could coexist) and a
 * behavioural assertion would need a live Postgres to mean anything.
 */

const queryMock = jest.fn();
const verifyPasswordMock = jest.fn();

jest.mock('../database/connection', () => ({
  db: { query: (...args: unknown[]) => queryMock(...args) },
}));

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyPassword: (...args: unknown[]) => verifyPasswordMock(...args),
  },
}));

import {
  UserService,
  validateUsername,
  validateEmail,
  USERNAME_RULES,
  EMAIL_RULES,
} from '../services/user';

beforeEach(() => {
  queryMock.mockReset();
  verifyPasswordMock.mockReset();
});

describe('UserService.verifyCurrentPassword — the re-auth primitive', () => {
  it('returns TRUE only when the hash actually verifies', async () => {
    queryMock.mockResolvedValue({ rows: [{ password_hash: 'stored-hash' }] });
    verifyPasswordMock.mockResolvedValue(true);

    await expect(UserService.verifyCurrentPassword('u1', 'correct')).resolves.toBe(true);
    expect(verifyPasswordMock).toHaveBeenCalledWith('correct', 'stored-hash');
  });

  it('returns FALSE when the hash does not verify', async () => {
    queryMock.mockResolvedValue({ rows: [{ password_hash: 'stored-hash' }] });
    verifyPasswordMock.mockResolvedValue(false);

    await expect(UserService.verifyCurrentPassword('u1', 'wrong')).resolves.toBe(false);
  });

  it('returns FALSE for a user that does not exist — and never consults the hasher', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await expect(UserService.verifyCurrentPassword('nobody', 'anything')).resolves.toBe(false);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
  });

  it('returns FALSE for a row with a NULL hash', async () => {
    queryMock.mockResolvedValue({ rows: [{ password_hash: null }] });

    await expect(UserService.verifyCurrentPassword('u1', 'anything')).resolves.toBe(false);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
  });

  it.each([['empty string', ''], ['undefined', undefined], ['null', null], ['a number', 1], ['an object', {}]])(
    'short-circuits on %s WITHOUT touching the database',
    async (_label, value) => {
      await expect(UserService.verifyCurrentPassword('u1', value)).resolves.toBe(false);
      expect(queryMock).not.toHaveBeenCalled();
      expect(verifyPasswordMock).not.toHaveBeenCalled();
    }
  );
});

describe('uniqueness is CASE-INSENSITIVE (the "Operator"/"operator" defect)', () => {
  it('isUsernameTaken folds case on BOTH sides of the comparison', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await UserService.isUsernameTaken('Operator', 'u1');

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/LOWER\(username\)\s*=\s*LOWER\(\$1\)/);
    expect(params).toEqual(['Operator', 'u1']);
  });

  it('isEmailTaken folds case on BOTH sides of the comparison', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await UserService.isEmailTaken('A@Example.com', 'u1');

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/LOWER\(email\)\s*=\s*LOWER\(\$1\)/);
  });

  it('a returned row means TAKEN, an empty result means FREE', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'other' }] });
    await expect(UserService.isUsernameTaken('operator', 'u1')).resolves.toBe(true);

    queryMock.mockResolvedValue({ rows: [] });
    await expect(UserService.isUsernameTaken('operator', 'u1')).resolves.toBe(false);
  });

  it('excludes the caller themselves, so a no-op rename is not a self-conflict', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await UserService.isUsernameTaken('victim', 'u1');
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/id\s*!=\s*\$2/);
  });
});

describe('validateUsername', () => {
  it('accepts the boundary lengths and rejects one either side', () => {
    expect(validateUsername('a'.repeat(USERNAME_RULES.minLength)).ok).toBe(true);
    expect(validateUsername('a'.repeat(USERNAME_RULES.maxLength)).ok).toBe(true);
    expect(validateUsername('a'.repeat(USERNAME_RULES.minLength - 1)).ok).toBe(false);
    expect(validateUsername('a'.repeat(USERNAME_RULES.maxLength + 1)).ok).toBe(false);
  });

  it('measures length AFTER trimming, so padding cannot buy characters', () => {
    // 3 real characters with padding is VALID; 2 real characters with padding is not.
    expect(validateUsername('   abc   ')).toEqual({ ok: true, value: 'abc' });
    expect(validateUsername('   ab    ').ok).toBe(false);
  });

  it('returns the TRIMMED value as the thing to store', () => {
    expect(validateUsername('\t operator \n')).toEqual({ ok: true, value: 'operator' });
  });

  it('rejects the empty and whitespace-only populations', () => {
    expect(validateUsername('').ok).toBe(false);
    expect(validateUsername('    ').ok).toBe(false);
  });

  it('rejects every non-string type', () => {
    for (const v of [undefined, null, 0, 1, true, false, {}, [], () => {}]) {
      expect(validateUsername(v).ok).toBe(false);
    }
  });

  it('accepts the documented character set and nothing else', () => {
    expect(validateUsername('Aa0._-').ok).toBe(true);
    for (const bad of ['a b', 'a\tb', 'a\nb', 'a/b', 'a@b', 'a#b', 'аbc', 'a​b', 'a‮b']) {
      expect(validateUsername(bad).ok).toBe(false);
    }
  });
});

describe('validateEmail', () => {
  it('accepts an ordinary address and trims it', () => {
    expect(validateEmail('  a@example.com ')).toEqual({ ok: true, value: 'a@example.com' });
  });

  it('rejects shapes that are not addresses', () => {
    for (const bad of ['', '   ', 'a', 'a@', '@b.com', 'a@b', 'a b@c.com', 'a@b c.com']) {
      expect(validateEmail(bad).ok).toBe(false);
    }
  });

  it('enforces the RFC length ceiling on the trimmed value', () => {
    const domain = '@example.com';
    const atLimit = 'x'.repeat(EMAIL_RULES.maxLength - domain.length) + domain;
    expect(atLimit).toHaveLength(EMAIL_RULES.maxLength);
    expect(validateEmail(atLimit).ok).toBe(true);
    expect(validateEmail(`x${atLimit}`).ok).toBe(false);
  });

  it('rejects every non-string type', () => {
    for (const v of [undefined, null, 0, true, {}, []]) {
      expect(validateEmail(v).ok).toBe(false);
    }
  });
});
