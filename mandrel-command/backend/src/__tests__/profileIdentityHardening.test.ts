/**
 * profileIdentityHardening.test.ts — issues 1 (re-auth) and 3 (validation).
 *
 * Issue 2 (rate limit) is proved in `profileUpdateRateLimit.test.ts`, in a SEPARATE FILE
 * on purpose: `express-rate-limit` keeps counter state in module scope, so a suite that
 * makes dozens of profile requests would exhaust the budget and turn every later
 * assertion into an accidental 429. Jest gives each file its own module registry, so the
 * limiter is neutralised here and exercised for real there. **A pass in this file is
 * therefore NOT evidence about the rate limit, and vice versa** — the task's three defects
 * are three separate fixes and each has its own proof.
 *
 * ## What is real and what is mocked, and why that split
 *
 * REAL: the Express app, the route chain, and `validateUsername`/`validateEmail`. Format
 * validation is the thing under test in half this file, so mocking it would be testing the
 * mock.
 *
 * MOCKED: the DB-touching `UserService` statics and `AuthService`. These carry no logic
 * this file is asserting, and mocking them is what lets the suite run with no database.
 * Note what the mocks CANNOT do: they cannot manufacture a 401 or a 400 — every refusal
 * below is decided in the route, above the mock boundary. And the strongest assertion in
 * this file is not a status code at all, it is `expect(updateUser).not.toHaveBeenCalled()`
 * — the write did not happen, which is the actual security property.
 */

import request from 'supertest';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

/**
 * Rate limiting OFF for this file — see the header. This is a pass-through, so the route
 * chain is otherwise untouched.
 */
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const VALID_JWT = 'header.payload.signature';
const USER_ID = 'test-user-id';

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: jest.fn((token: string) =>
      token === 'header.payload.signature' ? { userId: 'test-user-id', tokenId: 'tid' } : null
    ),
    validateSession: jest.fn(async () => true),
    findUserById: jest.fn(async () => ({
      id: 'test-user-id',
      username: 'victim',
      email: 'victim@example.com',
      role: 'user',
      is_active: true,
    })),
    verifyPassword: jest.fn(async () => false),
  },
}));

jest.mock('../services/user', () => {
  const actual = jest.requireActual('../services/user');
  return {
    ...actual,
    UserService: {
      getUserById: jest.fn(),
      verifyCurrentPassword: jest.fn(),
      isUsernameTaken: jest.fn(),
      isEmailTaken: jest.fn(),
      updateUser: jest.fn(),
    },
  };
});

jest.mock('../database/connection', () => ({
  db: {
    query: jest.fn(async () => {
      throw new Error('TEST GUARD: the route must go through UserService, not raw SQL');
    }),
    connect: jest.fn(async () => ({
      query: jest.fn(async () => {
        throw new Error('TEST GUARD: this probe must never reach the database');
      }),
      release: jest.fn(),
    })),
  },
  checkDatabaseHealth: jest.fn(async () => ({ connected: true, healthy: true })),
  getDatabaseStats: jest.fn(async () => ({ tables: 0 })),
  initializeDatabase: jest.fn(async () => undefined),
}));

import app from '../server';
import { UserService, USERNAME_RULES, EMAIL_RULES } from '../services/user';

const ROUTE = '/api/users/profile';
const CURRENT = {
  id: USER_ID,
  username: 'victim',
  email: 'victim@example.com',
  role: 'user',
  is_active: true,
};

const mocked = UserService as unknown as {
  getUserById: jest.Mock;
  verifyCurrentPassword: jest.Mock;
  isUsernameTaken: jest.Mock;
  isEmailTaken: jest.Mock;
  updateUser: jest.Mock;
};

/** The hijacked-session attacker: a perfectly valid session, no knowledge of the password. */
const asHijackedSession = (body: Record<string, unknown>) =>
  request(app).put(ROUTE).set('Authorization', `Bearer ${VALID_JWT}`).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  mocked.getUserById.mockResolvedValue({ ...CURRENT });
  mocked.isUsernameTaken.mockResolvedValue(false);
  mocked.isEmailTaken.mockResolvedValue(false);
  mocked.updateUser.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
    ...CURRENT,
    ...data,
  }));
  // Default: the attacker does NOT know the password.
  mocked.verifyCurrentPassword.mockResolvedValue(false);
});

describe('ISSUE 1 — a rename with no re-authentication is REFUSED', () => {
  it('THE ATTACK: a valid session with no password renames the account → 401, and NOTHING is written', async () => {
    const res = await asHijackedSession({ username: 'attacker' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
    // The property that matters. A status code can be right while the write still landed.
    expect(mocked.updateUser).not.toHaveBeenCalled();
  });

  it('a WRONG password renames nothing either', async () => {
    mocked.verifyCurrentPassword.mockResolvedValue(false);

    const res = await asHijackedSession({ username: 'attacker', currentPassword: 'guess' });

    expect(res.status).toBe(401);
    expect(mocked.updateUser).not.toHaveBeenCalled();
  });

  it('an EMAIL change with no password is refused too — email is identity, not a display field', async () => {
    const res = await asHijackedSession({ email: 'attacker@example.com' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
    expect(mocked.updateUser).not.toHaveBeenCalled();
  });

  it('an EMPTY-STRING password is not a password', async () => {
    const res = await asHijackedSession({ username: 'attacker', currentPassword: '' });
    expect(res.status).toBe(401);
    expect(mocked.updateUser).not.toHaveBeenCalled();
  });

  it('a NON-STRING password (true, {}, []) is not a password', async () => {
    for (const bogus of [true, {}, [], 0, null]) {
      mocked.updateUser.mockClear();
      const res = await asHijackedSession({ username: 'attacker', currentPassword: bogus });
      expect(res.status).toBe(401);
      expect(mocked.updateUser).not.toHaveBeenCalled();
    }
  });

  it('POSITIVE CONTROL — the CORRECT password renames the account, so the route is alive', async () => {
    mocked.verifyCurrentPassword.mockResolvedValue(true);

    const res = await asHijackedSession({ username: 'newname', currentPassword: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(mocked.updateUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ username: 'newname' })
    );
  });

  it('a NO-OP put (same values restated) needs no password — a client is not made to collect one for nothing', async () => {
    const res = await asHijackedSession({ username: CURRENT.username, email: CURRENT.email });

    expect(res.status).toBe(200);
    expect(mocked.verifyCurrentPassword).not.toHaveBeenCalled();
  });

  it('the no-op exemption is not a bypass: same username + DIFFERENT email still needs the password', async () => {
    const res = await asHijackedSession({
      username: CURRENT.username,
      email: 'attacker@example.com',
    });

    expect(res.status).toBe(401);
    expect(mocked.updateUser).not.toHaveBeenCalled();
  });

  it('whitespace padding does not smuggle a change past the no-op check', async () => {
    // "  victim  " normalises to the CURRENT username, so this is genuinely a no-op and
    // must be treated as one — proving normalisation happens BEFORE the change comparison,
    // not after.
    const res = await asHijackedSession({ username: '  victim  ' });
    expect(res.status).toBe(200);
    expect(mocked.verifyCurrentPassword).not.toHaveBeenCalled();
  });
});

describe('ISSUE 3 — format validation', () => {
  /** Every rejection below must also prove no write happened. */
  const expectRejected = async (body: Record<string, unknown>) => {
    mocked.updateUser.mockClear();
    const res = await asHijackedSession({ currentPassword: 'correct-horse', ...body });
    expect(mocked.updateUser).not.toHaveBeenCalled();
    return res;
  };

  beforeEach(() => {
    mocked.verifyCurrentPassword.mockResolvedValue(true);
  });

  it.each([
    ['a username of only whitespace', '     '],
    ['a username shorter than the minimum', 'ab'],
    ['a username longer than the maximum', 'x'.repeat(USERNAME_RULES.maxLength + 1)],
    ['a username containing a space', 'ad min'],
    ['a username containing a newline', 'admin\nroot'],
    // '\u0000', not a RAW NUL byte: a raw one makes git render this whole file as
    // `Binary files ... differ`, so every future diff of it is unreviewable. The escape
    // is the identical string at runtime (scripts/check-no-nul-bytes.sh).
    ['a username containing a NUL', 'admin\u0000'],
    ['a username containing an RTL override', 'ad‮nim'],
    ['a username containing a zero-width space', 'ad​min'],
    ['a username that is a lookalike cyrillic "a"', 'аdmin'],
    ['a username containing an @', 'admin@example.com'],
  ])('rejects %s with 400', async (_label, username) => {
    const res = await expectRejected({ username });
    expect(res.status).toBe(400);
  });

  it.each([
    ['a non-string username (number)', 12345],
    ['a non-string username (object)', { toString: 'admin' }],
    ['a non-string username (array)', ['admin']],
    ['a non-string username (boolean)', true],
  ])('rejects %s with 400', async (_label, username) => {
    const res = await expectRejected({ username });
    expect(res.status).toBe(400);
  });

  it.each([
    ['not an address at all', 'notanemail'],
    ['no domain dot', 'a@b'],
    ['a space inside', 'a b@example.com'],
    ['over the RFC length limit', `${'x'.repeat(EMAIL_RULES.maxLength)}@example.com`],
    ['a non-string', 42],
  ])('rejects an email that is %s with 400', async (_label, email) => {
    const res = await expectRejected({ email });
    expect(res.status).toBe(400);
  });

  it('TRIMS before storing — the stored value never carries padding', async () => {
    await asHijackedSession({ username: '  newname  ', currentPassword: 'correct-horse' });

    expect(mocked.updateUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ username: 'newname' })
    );
  });

  it('the uniqueness question asked is the CASE-INSENSITIVE one', async () => {
    // The old check was `WHERE username = $1`, so "Operator" and "operator" could coexist. This
    // asserts the route now consults the case-folding helper at all — its SQL is asserted
    // in userIdentityService.test.ts.
    mocked.isUsernameTaken.mockResolvedValue(true);

    const res = await asHijackedSession({ username: 'Victim2', currentPassword: 'correct-horse' });

    expect(mocked.isUsernameTaken).toHaveBeenCalledWith('Victim2', USER_ID);
    expect(res.status).toBe(409);
    expect(mocked.updateUser).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — a well-formed username is accepted', async () => {
    mocked.verifyCurrentPassword.mockResolvedValue(true);
    const res = await asHijackedSession({ username: 'good.name-1_x', currentPassword: 'ok' });
    expect(res.status).toBe(200);
  });

  it('still 400s when neither field is supplied', async () => {
    const res = await asHijackedSession({ currentPassword: 'ok' });
    expect(res.status).toBe(400);
  });

  it('an unauthenticated caller is still refused before any of this', async () => {
    const res = await request(app).put(ROUTE).send({ username: 'attacker' });
    expect(res.status).toBe(401);
    expect(mocked.updateUser).not.toHaveBeenCalled();
  });
});
