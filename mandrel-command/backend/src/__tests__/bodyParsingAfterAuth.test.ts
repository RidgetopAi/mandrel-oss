/**
 * Body parsing happens only AFTER authentication.
 * An unauthenticated 2 MiB JSON body to an authenticated route must be 401 — not 400/413.
 */
import request from 'supertest';
import express, { Express } from 'express';

const mockVerify = jest.fn();
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (...a: unknown[]) => mockVerify(...a),
    validateSession: jest.fn(async () => true),
    findUserById: jest.fn(async () => ({ id: 'u1', username: 'u', role: 'admin', is_active: true })),
  },
}));

import { bodyParsingAfterAuth } from '../middleware/bodyParsing';
import { authenticateToken } from '../middleware/auth';

const BIG = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
const JWT_SHAPED = 'aaa.bbb.ccc';

let app: Express;
beforeAll(() => {
  delete process.env.ALLOW_DEV_AUTH_BYPASS;
  process.env.NODE_ENV = 'test';
  app = express();
  app.use(bodyParsingAfterAuth);
  app.post('/api/things', authenticateToken, (req, res) => res.json({ ok: true, body: req.body }));
  app.post('/api/auth/login', (req, res) => res.json({ ok: true, body: req.body }));
});
beforeEach(() => mockVerify.mockReset());

describe('body parsing after auth', () => {
  it('unauthenticated 2 MiB JSON body to an authenticated route => 401 (not 413/400)', async () => {
    const res = await request(app).post('/api/things').set('Content-Type', 'application/json').send(BIG);
    expect(res.status).toBe(401);
  });

  it('unauthenticated MALFORMED JSON to an authenticated route => 401 (not 400)', async () => {
    const res = await request(app).post('/api/things').set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(401);
  });

  it('invalid bearer token + 2 MiB body => 401', async () => {
    mockVerify.mockReturnValue(null);
    const res = await request(app).post('/api/things').set('Authorization', `Bearer ${JWT_SHAPED}`)
      .set('Content-Type', 'application/json').send(BIG);
    expect(res.status).toBe(401);
  });

  it('authenticated normal request still works and the body is parsed', async () => {
    mockVerify.mockReturnValue({ userId: 'u1', tokenId: 't1' });
    const res = await request(app).post('/api/things').set('Authorization', `Bearer ${JWT_SHAPED}`)
      .send({ hello: 'world' });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ hello: 'world' });
  });

  it('public login route keeps its own small parser: normal body parses, 2 MiB is refused 413', async () => {
    const ok = await request(app).post('/api/auth/login').send({ username: 'a', password: 'b' });
    expect(ok.status).toBe(200);
    expect(ok.body.body).toEqual({ username: 'a', password: 'b' });
    const big = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(BIG);
    expect(big.status).toBe(413);
  });
});

describe('server.ts wiring', () => {
  it('has no app-wide express.json/urlencoded', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '../server.ts'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/express\.(json|urlencoded)\(/);
    expect(code).toMatch(/app\.use\(bodyParsingAfterAuth\)/);
  });
});

describe('the REAL app (server.ts) — no body parse before auth', () => {
  it('unauthenticated 2 MiB / malformed JSON to a real authenticated route => 401', async () => {
    jest.resetModules();
    jest.doMock('../utils/featureFlags', () => ({
      ensureFeatureFlags: async () => ({ getMetadata: () => ({}), getAllFlags: () => ({}) }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const realApp: Express = require('../server').default;
    const big = await request(realApp).post('/api/auth/register').set('Content-Type', 'application/json').send(BIG);
    expect(big.status).toBe(401);
    const bad = await request(realApp).post('/api/contexts').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(401);
  });
});
