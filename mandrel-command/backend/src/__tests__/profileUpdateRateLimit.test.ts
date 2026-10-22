/**
 * profileUpdateRateLimit.test.ts — issue 2.
 *
 * ## The defect
 *
 * `PUT /api/users/profile` had NO rate limit, and its uniqueness check answers "is this
 * handle free RIGHT NOW". So an attacker who wants a SPECIFIC handle could poll the
 * endpoint indefinitely and claim it the instant the victim vacated it — the claiming half
 * of the feedback-ownership exploit.
 *
 * ## Why this is a separate file from profileIdentityHardening.test.ts
 *
 * `express-rate-limit` holds its counters in module scope, so any suite that makes more
 * than a handful of profile requests would exhaust the budget and start receiving 429s in
 * unrelated assertions. Jest gives each FILE its own module registry, so this file gets a
 * fresh, real limiter and neutralises nothing.
 *
 * ## This test ATTEMPTS the attack rather than asserting a config value
 *
 * It drives `PROFILE_UPDATE_RATE_LIMIT.max + 1` real HTTP requests through the real app —
 * the polling loop, in miniature — and asserts the last one is refused. The limit is read
 * from the exported config rather than restated, so a change to the number cannot leave
 * this test asserting a stale one (C4: derive from the same source the product reads).
 *
 * The probes are the ATTACKER's shape: a valid session, no password. They therefore 401
 * until the limiter takes over — and the 401→429 TRANSITION is the assertion, because a
 * uniform 401 would prove nothing about rate limiting at all.
 */

import request from 'supertest';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

const VALID_JWT = 'header.payload.signature';

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
  },
}));

jest.mock('../services/user', () => {
  const actual = jest.requireActual('../services/user');
  return {
    ...actual,
    UserService: {
      getUserById: jest.fn(async () => ({
        id: 'test-user-id',
        username: 'victim',
        email: 'victim@example.com',
      })),
      verifyCurrentPassword: jest.fn(async () => false),
      isUsernameTaken: jest.fn(async () => false),
      isEmailTaken: jest.fn(async () => false),
      updateUser: jest.fn(),
    },
  };
});

jest.mock('../database/connection', () => ({
  db: {
    query: jest.fn(async () => {
      throw new Error('TEST GUARD: this probe must never reach the database');
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
import { PROFILE_UPDATE_RATE_LIMIT } from '../routes/users';
import { UserService } from '../services/user';

const ROUTE = '/api/users/profile';

describe('ISSUE 2 — handle-sniping by polling is rate limited', () => {
  it('the poll loop is cut off at the configured ceiling, and nothing is ever written', async () => {
    const statuses: number[] = [];

    for (let i = 0; i < PROFILE_UPDATE_RATE_LIMIT.max + 1; i++) {
      const res = await request(app)
        .put(ROUTE)
        .set('Authorization', `Bearer ${VALID_JWT}`)
        .send({ username: 'coveted-handle' });
      statuses.push(res.status);
    }

    // The first `max` attempts reach the handler and are refused on their own merits
    // (no password). That is the POSITIVE CONTROL: the route was alive and the limiter
    // was not the thing answering.
    const withinBudget = statuses.slice(0, PROFILE_UPDATE_RATE_LIMIT.max);
    expect(withinBudget.every((s) => s === 401)).toBe(true);

    // The one past the ceiling is refused by the LIMITER, and the code differs — which is
    // what makes this a measurement of rate limiting rather than of the 401.
    expect(statuses[PROFILE_UPDATE_RATE_LIMIT.max]).toBe(429);

    expect((UserService as unknown as { updateUser: jest.Mock }).updateUser)
      .not.toHaveBeenCalled();
  });

  it('the limiter stays engaged once tripped', async () => {
    const res = await request(app)
      .put(ROUTE)
      .set('Authorization', `Bearer ${VALID_JWT}`)
      .send({ username: 'coveted-handle' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Too Many Requests');
  });
});
