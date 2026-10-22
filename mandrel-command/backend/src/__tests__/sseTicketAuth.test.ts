/**
 * sseTicketAuth.test.ts — the BACKEND half of an earlier task.
 *
 * ## The defect
 *
 * `middleware/sseAuth.ts` accepted the session JWT as `?token=` in the query string,
 * because `EventSource` cannot set an Authorization header. A credential in a URL is
 * written wherever URLs are written — 333 occurrences were found in nginx access logs and
 * 469 in traefik on 2026-07-30 — and it also reaches browser history and the `Referer`
 * header. Purging those logs was a mitigation. This is the fix: the URL now carries a
 * single-use, seconds-lived opaque TICKET, minted by an authenticated request that carried
 * its JWT in a header.
 *
 * ## What this file drives, and why that is the real surface
 *
 * REAL HTTP through the REAL `app` exported by `src/server.ts` (supertest), so what is
 * asserted is what Express actually serves — mount order, middleware chain and all. A unit
 * test of the middleware in isolation could not catch a route wired past it.
 *
 * ## Why the probes land on `/api/events/stats` rather than `/api/events`
 *
 * `/api/events` is an infinite `text/event-stream`: a SUCCESSFUL request to it never ends,
 * so supertest would hang rather than assert. `/api/events/stats` is guarded by the SAME
 * `ensureAuthForSse` middleware (routes/events.ts) and returns JSON, so it exercises the
 * identical authentication path and can be asserted on. The refusal cases — where nothing
 * is streamed because the request is rejected — ARE probed against `/api/events` itself.
 *
 * ## Every refusal has a positive control
 *
 * A 401 is indistinguishable from a route that was deleted or broken. So each refusal is
 * paired with a credential that IS accepted, proving the route is alive and that the 401
 * came from the credential and not from a corpse.
 *
 * ## Why this needs no database
 *
 * `AuthService` is mocked, so the credentialed paths run without a data tier. Those mocks
 * can only make an authenticated case SUCCEED; they cannot manufacture the 401s, which are
 * decided in `sseAuth.ts` before `AuthService` is consulted.
 */

import request from 'supertest';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

/**
 * A structurally valid, genuinely ACCEPTED session JWT. It is "valid" in the strongest
 * sense available to this suite — `verifyJWT` returns a payload for it and its session
 * validates — which is exactly what makes the `?token=` probes meaningful: they are
 * refused despite the credential being good, not because it is bad.
 */
const VALID_JWT = 'header.payload.signature';

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: jest.fn((token: string) =>
      token === 'header.payload.signature'
        ? { userId: 'test-user-id', tokenId: 'test-token-id' }
        : null
    ),
    validateSession: jest.fn(async (tokenId: string) => tokenId === 'test-token-id'),
    findUserById: jest.fn(async (userId: string) =>
      userId === 'test-user-id'
        ? {
            id: 'test-user-id',
            username: 'tester',
            email: 'tester@example.com',
            role: 'admin',
            is_active: true,
          }
        : null
    ),
  },
}));

jest.mock('../database/connection', () => ({
  db: {
    connect: jest.fn(async () => ({
      query: jest.fn(async () => {
        throw new Error('TEST GUARD: this probe must never reach the database');
      }),
      release: jest.fn(),
    })),
    query: jest.fn(async () => {
      throw new Error('TEST GUARD: this probe must never reach the database');
    }),
  },
  checkDatabaseHealth: jest.fn(async () => ({ connected: true, healthy: true })),
  getDatabaseStats: jest.fn(async () => ({ tables: 0 })),
  initializeDatabase: jest.fn(async () => undefined),
}));

import app from '../server';
import {
  SSE_TICKET_CONFIG,
  issueSseTicket,
  redeemSseTicket,
  _sseTicketCountForTest,
  _resetSseTicketsForTest,
} from '../middleware/sseAuth';

const STATS = '/api/events/stats';
const STREAM = '/api/events';
const MINT = '/api/events/ticket';

/** Mint through the real HTTP endpoint, the way the browser does. */
async function mintTicket(): Promise<string> {
  const res = await request(app).post(MINT).set('Authorization', `Bearer ${VALID_JWT}`);
  expect(res.status).toBe(200);
  expect(typeof res.body?.data?.ticket).toBe('string');
  return res.body.data.ticket as string;
}

beforeEach(() => {
  _resetSseTicketsForTest();
});

describe('the dev auth bypass is OFF, so nothing below is an artifact of it', () => {
  it('NODE_ENV is not development', () => {
    expect(process.env.NODE_ENV).not.toBe('development');
  });
});

describe('THE DEFECT: a session JWT in the query string is REFUSED', () => {
  it('GET /api/events?token=<a genuinely valid JWT> → 401 (this returned a live stream before the fix)', async () => {
    const res = await request(app).get(`${STREAM}?token=${VALID_JWT}`);
    expect(res.status).toBe(401);
    expect(res.text).toContain('may not be supplied in the query string');
  });

  it('GET /api/events/stats?token=<a genuinely valid JWT> → 401', async () => {
    const res = await request(app).get(`${STATS}?token=${VALID_JWT}`);
    expect(res.status).toBe(401);
  });

  it('POSITIVE CONTROL — the SAME JWT in the Authorization HEADER is accepted, so the route is alive and the JWT is good', async () => {
    const res = await request(app).get(STATS).set('Authorization', `Bearer ${VALID_JWT}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totalConnections');
  });

  it('a JWT smuggled in as ?ticket= is refused — the ticket namespace is not a second token door', async () => {
    const res = await request(app).get(`${STATS}?ticket=${VALID_JWT}`);
    expect(res.status).toBe(401);
    expect(res.text).toContain('Invalid or expired connect ticket');
  });

  it('no credential at all → 401, and the message points at the ticket endpoint', async () => {
    const res = await request(app).get(STATS);
    expect(res.status).toBe(401);
    expect(res.text).toContain('POST /api/events/ticket');
  });
});

describe('POST /api/events/ticket — the mint', () => {
  it('requires a credential: no Authorization header → 401', async () => {
    const res = await request(app).post(MINT);
    expect(res.status).toBe(401);
  });

  it('a garbage bearer token → 401', async () => {
    const res = await request(app).post(MINT).set('Authorization', 'Bearer nope.nope.nope');
    expect(res.status).toBe(401);
  });

  it('the JWT may NOT be presented in the query string here either', async () => {
    const res = await request(app).post(`${MINT}?token=${VALID_JWT}`);
    expect(res.status).toBe(401);
  });

  it('POSITIVE CONTROL — a header JWT mints a ticket, and the ticket is not the JWT', async () => {
    const res = await request(app).post(MINT).set('Authorization', `Bearer ${VALID_JWT}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { ticket, expiresInMs } = res.body.data;
    expect(ticket).not.toContain(VALID_JWT);
    expect(ticket).toMatch(/^[0-9a-f]+$/);
    // 32 bytes hex — the entropy claim, asserted rather than asserted-in-a-comment.
    expect(ticket).toHaveLength(SSE_TICKET_CONFIG.byteLength * 2);
    expect(expiresInMs).toBe(SSE_TICKET_CONFIG.ttlMs);
  });

  it('two mints never collide', async () => {
    const a = await mintTicket();
    const b = await mintTicket();
    expect(a).not.toBe(b);
  });
});

describe('a ticket authenticates an SSE connection — once', () => {
  it('a freshly minted ticket is accepted on the query string', async () => {
    const ticket = await mintTicket();
    const res = await request(app).get(`${STATS}?ticket=${ticket}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totalConnections');
  });

  it('SINGLE USE: the SAME ticket a second time → 401 (this is what makes a logged ticket worthless)', async () => {
    const ticket = await mintTicket();

    const first = await request(app).get(`${STATS}?ticket=${ticket}`);
    expect(first.status).toBe(200);

    const replay = await request(app).get(`${STATS}?ticket=${ticket}`);
    expect(replay.status).toBe(401);
    expect(replay.text).toContain('Invalid or expired connect ticket');
  });

  it('an unknown ticket → 401', async () => {
    const res = await request(app).get(`${STATS}?ticket=deadbeef`);
    expect(res.status).toBe(401);
  });

  it('an EMPTY ticket → 401 (the empty population, not just the wrong-value one)', async () => {
    const res = await request(app).get(`${STATS}?ticket=`);
    expect(res.status).toBe(401);
  });

  it('an ARRAY ticket (?ticket=a&ticket=b) → 401 rather than a type confusion', async () => {
    const ticket = await mintTicket();
    const res = await request(app).get(`${STATS}?ticket=${ticket}&ticket=${ticket}`);
    expect(res.status).toBe(401);
  });

  it('a ticket does NOT resurrect a revoked session', async () => {
    const ticket = await mintTicket();

    // The session is revoked between mint and connect.
    const { AuthService } = jest.requireMock('../services/auth');
    AuthService.validateSession.mockImplementationOnce(async () => false);

    const res = await request(app).get(`${STATS}?ticket=${ticket}`);
    expect(res.status).toBe(401);
    expect(res.text).toContain('Session expired');
  });

  it('a ticket does NOT let an INACTIVE user connect', async () => {
    const ticket = await mintTicket();

    const { AuthService } = jest.requireMock('../services/auth');
    AuthService.findUserById.mockImplementationOnce(async () => ({
      id: 'test-user-id',
      username: 'tester',
      email: 'tester@example.com',
      role: 'admin',
      is_active: false,
    }));

    const res = await request(app).get(`${STATS}?ticket=${ticket}`);
    expect(res.status).toBe(403);
  });
});

describe('ticket expiry — the store itself', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a ticket past its TTL is refused, and a ticket inside it is accepted', () => {
    _resetSseTicketsForTest();
    const start = Date.now();
    jest.useFakeTimers().setSystemTime(start);

    const inside = issueSseTicket('u1', 't1').ticket;
    jest.setSystemTime(start + SSE_TICKET_CONFIG.ttlMs - 1);
    expect(redeemSseTicket(inside)).toEqual({ userId: 'u1', tokenId: 't1' });

    const outside = issueSseTicket('u2', 't2').ticket;
    jest.setSystemTime(start + SSE_TICKET_CONFIG.ttlMs * 3);
    expect(redeemSseTicket(outside)).toBeNull();
  });

  it('redeeming BURNS the ticket even when it was already expired', () => {
    _resetSseTicketsForTest();
    const start = Date.now();
    jest.useFakeTimers().setSystemTime(start);

    const ticket = issueSseTicket('u1', 't1').ticket;
    jest.setSystemTime(start + SSE_TICKET_CONFIG.ttlMs + 1);

    expect(redeemSseTicket(ticket)).toBeNull();
    expect(_sseTicketCountForTest()).toBe(0);
  });

  it('minting sweeps expired tickets, so the store does not grow without bound', () => {
    _resetSseTicketsForTest();
    const start = Date.now();
    jest.useFakeTimers().setSystemTime(start);

    for (let i = 0; i < 25; i++) issueSseTicket(`u${i}`, `t${i}`);
    expect(_sseTicketCountForTest()).toBe(25);

    jest.setSystemTime(start + SSE_TICKET_CONFIG.ttlMs + 1);
    issueSseTicket('fresh', 'fresh');
    expect(_sseTicketCountForTest()).toBe(1);
  });

  it('redeeming consumes exactly one entry', () => {
    _resetSseTicketsForTest();
    const a = issueSseTicket('u1', 't1').ticket;
    issueSseTicket('u2', 't2');
    expect(_sseTicketCountForTest()).toBe(2);
    expect(redeemSseTicket(a)).not.toBeNull();
    expect(_sseTicketCountForTest()).toBe(1);
  });
});

/**
 * THE WHOLE-CLASS QUESTION the task asks: is any OTHER credential accepted from a query
 * string anywhere in this backend? Asserted by reading the source rather than by a
 * sentence claiming it, so it stays true as the tree changes.
 *
 * POPULATION: every `.ts` under `backend/src` except tests — i.e. all served code. The
 * enumeration is `fs` walking the directory, not a hand-written list, so a file added
 * tomorrow is in it by construction.
 */
describe('WHOLE CLASS: no served code reads a credential out of the query string', () => {
  it('req.query.token / access_token / apiKey / api_key / jwt appear nowhere in src', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');

    const SRC = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(full);
        }
      }
    };
    walk(SRC);

    // Sanity-check the MAGNITUDE of the population: a walk that silently returned a
    // handful of files would report "clean" for the wrong reason.
    expect(files.length).toBeGreaterThan(50);

    const CREDENTIAL_QUERY_READ =
      /req\.query\s*(?:\.\s*(?:token|access_token|accessToken|apiKey|api_key|jwt|password|secret)\b|\[\s*['"](?:token|access_token|accessToken|apiKey|api_key|jwt|password|secret)['"]\s*\])/;

    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [i, line] of source.split('\n').entries()) {
        // sseAuth.ts reads req.query.token ONLY to REFUSE it. That single line is the
        // fix, and it is named here rather than allow-listed centrally, with its reason.
        if (
          file.endsWith('middleware/sseAuth.ts') &&
          line.includes('rejected-credential-in-query-ok')
        ) {
          continue;
        }
        if (CREDENTIAL_QUERY_READ.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * ── THE TWO HALVES AGREE ─────────────────────────────────────────────────
 *
 * A backend that stops accepting `?token=` while the frontend still sends it passes both
 * halves' unit tests and breaks every real user — the halves are only green SEPARATELY.
 * So this suite does not describe the frontend's contract, it EXTRACTS it from the
 * frontend source and REPLAYS it against the real backend app.
 *
 * What is extracted: the mint path, the HTTP method, the header name the JWT rides in, the
 * SSE query parameter name, and the JSON path the ticket is read from. Every one of them
 * is then exercised. If either side is edited to disagree, this goes RED — and it cannot
 * go green by drifting, because neither side's value is written here.
 *
 * FAIL-CLOSED: an extraction that finds nothing is a FAILURE, never a skip. A scanner that
 * silently matches zero lines is the classic hollow guard (CLASSES.md C3-B).
 */
describe('FRONTEND/BACKEND CONSISTENCY: the shape the client sends is the shape the server accepts', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');

  const FRONTEND_SSE = path.resolve(__dirname, '../../../frontend/src/lib/sse.ts');

  const readFrontend = (): string => {
    expect(fs.existsSync(FRONTEND_SSE)).toBe(true);
    const source = fs.readFileSync(FRONTEND_SSE, 'utf8');
    expect(source.length).toBeGreaterThan(1000);
    return source;
  };

  /** Pull a single capture out of the frontend source, failing loudly when absent. */
  const extract = (source: string, re: RegExp, what: string): string => {
    const m = source.match(re);
    if (!m || !m[1]) {
      throw new Error(
        `Could not extract ${what} from frontend/src/lib/sse.ts. This guard fails closed: ` +
          'an unreadable client contract is a FINDING, not a pass.'
      );
    }
    return m[1];
  };

  it('the mint path the client calls is a live route on this server, and it accepts the client\'s method + header', async () => {
    const source = readFrontend();

    const mintPath = extract(source, /fetch\(`\$\{apiBase\}([^`]+)`/, 'the mint path');
    const method = extract(source, /method:\s*'([A-Z]+)'/, 'the mint HTTP method');
    const headerName = extract(source, /headers:\s*\{\s*(\w+):\s*`Bearer/, 'the auth header name');
    const jsonPath = extract(source, /const ticket = body\?\.(\w+)\?\.(\w+);/, 'the response json path');

    expect(mintPath).toBe(MINT);
    expect(method).toBe('POST');

    // Replay the CLIENT's exact request shape against the REAL app.
    const res = await (request(app) as any)[method.toLowerCase()](mintPath)
      .set(headerName, `Bearer ${VALID_JWT}`);

    expect(res.status).toBe(200);
    // ...and the ticket is where the client looks for it.
    expect(typeof res.body?.[jsonPath]?.ticket).toBe('string');
  });

  it('the query parameter the client sets is the one the server redeems', async () => {
    const source = readFrontend();
    const paramName = extract(source, /params\.set\('(\w+)',\s*ticket\)/, 'the SSE credential query param');

    const ticket = await mintTicket();
    const res = await request(app).get(`${STATS}?${paramName}=${ticket}`);

    expect(res.status).toBe(200);
  });

  it('the client sends NO token query param — the string the server refuses is absent from the client', () => {
    const source = readFrontend();
    // The client must not build a `token=` param anywhere. Asserted on the source that
    // actually ships, so it cannot drift back in unnoticed.
    expect(source).not.toMatch(/params\.set\(\s*'token'/);
    expect(source).not.toMatch(/[?&]token=\$\{/);
  });

  it('the client sends the JWT ONLY as a header — it appears in no URL template', () => {
    const source = readFrontend();
    // `token` may appear as an identifier; what must not appear is it being interpolated
    // into a URL or a query param.
    const urlInterpolations = source.match(/`[^`]*\$\{token\}[^`]*`/g) ?? [];
    for (const literal of urlInterpolations) {
      expect(literal).toMatch(/^`Bearer \$\{token\}`$/);
    }
    expect(urlInterpolations.length).toBeGreaterThan(0); // fail closed: it must be used somewhere
  });
});
