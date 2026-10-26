/**
 * Settings → API tokens — the ROUTE, against the REAL migrated schema (migration 108),
 * through the REAL app.
 *
 * THE ANCHOR: every ownership and storage assertion reads `api_tokens` with THIS suite's own
 * SQL. A route is never asked to report on itself: a 404 body is not proof nothing was
 * revoked, and a list that omits the hash is not proof the hash (not the token) was stored.
 *
 * POPULATION
 *   auth     401 on all three verbs without a session; 403 on all three for a role=user
 *            account (tokens carry full MCP access, so they are ADMIN-ONLY — Reviewer F1)
 *   create   201 + plaintext shape + Cache-Control no-store; the stored row holds sha256 of
 *            the plaintext and NO column contains the plaintext or its random body;
 *            400 blank / too-long name, bad expiry; optional expiry stored
 *   list     only the caller's tokens; never the plaintext, never the hash; exact key set;
 *            the ZERO member (a user with no tokens) is an empty list, not an error
 *   revoke   cross-user → 404 and the raw row is UNCHANGED; own → 200 and revoked_at set;
 *            repeat → 404; malformed id → 400; revoked tokens leave the list
 *   cap      at the configured cap → 409, and nothing is inserted
 *   rate     the (max+1)th create in a window → 429, keyed PER USER (another user unaffected)
 *   logs     the plaintext never reaches any winston logger, console, stdout or stderr
 *   digest   the shipped hash reproduces the cross-service golden vector
 *
 *   bash scripts/provision-test-db.sh ci_mytest
 *   eval "$(bash scripts/provision-test-db.sh ci_mytest --print-env)"
 *   cd mandrel-command/backend && npx jest src/__tests__/apiTokens.db.test.ts
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

jest.mock('../services/mcp', () => ({
  McpService: {
    callTool: jest.fn(async () => ({ success: true, data: { id: 'stubbed' } })),
  },
}));

import { createHash } from 'crypto';
import Transport from 'winston-transport';
import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { API_TOKEN_CONFIG, API_TOKEN_GOLDEN_VECTOR } from '../config/apiTokens';
import { hashApiToken } from '../services/apiTokens';
import { logger, securityLogger, dbLogger, requestLogger } from '../config/logger';

// Dedicated `b0bf..` prefix: this suite shares ONE database with the others.
const U_A = 'b0bf0000-0000-4000-8000-b0bf0000aa01';
const U_B = 'b0bf0000-0000-4000-8000-b0bf0000bb02';
const U_CAP = 'b0bf0000-0000-4000-8000-b0bf0000cc03';
const U_RATE = 'b0bf0000-0000-4000-8000-b0bf0000dd04';
const U_RATE2 = 'b0bf0000-0000-4000-8000-b0bf0000ee05';
const U_PLAIN = 'b0bf0000-0000-4000-8000-b0bf0000ff06'; // role=user: may NOT hold tokens
const USERS = [U_A, U_B, U_CAP, U_RATE, U_RATE2, U_PLAIN];
const TOKEN_SHAPE = new RegExp(`^${API_TOKEN_CONFIG.prefix}[A-Za-z0-9_-]{43}$`);

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describeDb('Settings → API tokens (/api/api-tokens)', () => {
  const pool = db;
  const jwt: Record<string, string> = {};
  const plaintexts: string[] = [];
  const captured: string[] = [];
  const restore: Array<() => void> = [];

  const cleanup = async () => {
    await pool.query('DELETE FROM api_tokens WHERE user_id = ANY($1::uuid[])', [USERS]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [USERS]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [USERS]);
  };

  const rawRow = async (id: string) =>
    (await pool.query('SELECT *, row_to_json(t)::text AS whole FROM api_tokens t WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();
    for (const [i, id] of USERS.entries()) {
      const username = `tokuser${i}`;
      const role = id === U_PLAIN ? 'user' : 'admin';
      await pool.query(
        `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
         VALUES ($1,$2,$3,'$2b$04$notarealhashnotarealhashno',$4,true)`,
        [id, username, `${username}@x.test`, role]
      );
      const s = await AuthService.createSession(id);
      jwt[id] = AuthService.generateJWT({ id, username, email: `${username}@x.test`, role } as never, s.tokenId);
    }

    // Capture EVERY log surface, at the most verbose level, before any request runs.
    class Capture extends Transport {
      log(info: unknown, cb: () => void) {
        captured.push(JSON.stringify(info));
        cb();
      }
    }
    for (const l of [logger, securityLogger, dbLogger, requestLogger]) {
      const prev = l.level;
      const t = new Capture({ level: 'silly' });
      l.level = 'silly';
      l.add(t);
      restore.push(() => {
        l.remove(t);
        l.level = prev;
      });
    }
    for (const lvl of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const spy = jest.spyOn(console, lvl).mockImplementation((...a: unknown[]) => {
        captured.push(a.map(String).join(' '));
      });
      restore.push(() => spy.mockRestore());
    }
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      const spy = jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (orig as (...x: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
      restore.push(() => spy.mockRestore());
    }
  }, 120000);

  afterAll(async () => {
    for (const r of restore.reverse()) r();
    await cleanup();
    await pool.end();
  });

  const as = (user: string | null) => ({
    get: () => {
      const r = request(app).get('/api/api-tokens');
      return user ? r.set('Authorization', `Bearer ${jwt[user]}`) : r;
    },
    create: (body: unknown) => {
      const r = request(app).post('/api/api-tokens').send(body as object);
      return user ? r.set('Authorization', `Bearer ${jwt[user]}`) : r;
    },
    revoke: (id: string) => {
      const r = request(app).delete(`/api/api-tokens/${id}`);
      return user ? r.set('Authorization', `Bearer ${jwt[user]}`) : r;
    },
  });

  it('the shipped digest reproduces the cross-service golden vector', () => {
    expect(hashApiToken(API_TOKEN_GOLDEN_VECTOR.plaintext)).toBe(API_TOKEN_GOLDEN_VECTOR.sha256Hex);
  });

  describe('401 without a session', () => {
    it('GET, POST and DELETE all refuse, and POST inserts nothing', async () => {
      const before = (await pool.query('SELECT count(*)::int n FROM api_tokens')).rows[0].n;
      expect((await as(null).get()).status).toBe(401);
      expect((await as(null).create({ name: 'x' })).status).toBe(401);
      expect((await as(null).revoke('b0bf0000-0000-4000-8000-000000000000')).status).toBe(401);
      expect((await pool.query('SELECT count(*)::int n FROM api_tokens')).rows[0].n).toBe(before);
    });
  });

  describe('403 for a non-admin (role=user) — tokens are ADMIN-ONLY', () => {
    it('GET, POST and DELETE all refuse a role=user session, and POST inserts nothing', async () => {
      // A real row the non-admin might try to revoke: an admin's (U_B's) token.
      const victim = await pool.query(
        `INSERT INTO api_tokens (user_id, name, token_hash, display_prefix) VALUES ($1,'victim',$2,'mdl_victim00') RETURNING id`,
        [U_B, sha(`victim-${U_B}`)]
      );
      const before = (await pool.query('SELECT count(*)::int n FROM api_tokens')).rows[0].n;
      expect((await as(U_PLAIN).get()).status).toBe(403);
      const created = await as(U_PLAIN).create({ name: 'should not exist' });
      expect(created.status).toBe(403);
      expect(created.body?.data?.plaintext).toBeUndefined();
      expect((await as(U_PLAIN).revoke(victim.rows[0].id)).status).toBe(403);
      expect((await pool.query('SELECT count(*)::int n FROM api_tokens')).rows[0].n).toBe(before);
      expect((await pool.query('SELECT count(*)::int n FROM api_tokens WHERE user_id = $1', [U_PLAIN])).rows[0].n).toBe(0);
      expect((await rawRow(victim.rows[0].id)).revoked_at).toBeNull();
      await pool.query('DELETE FROM api_tokens WHERE id = $1', [victim.rows[0].id]);
    });
  });

  let tokenA: { id: string; plaintext: string };

  describe('create', () => {
    it('the ZERO member: a user with no tokens lists an empty array', async () => {
      const res = await as(U_A).get();
      expect(res.status).toBe(200);
      expect(res.body.data.tokens).toEqual([]);
    });

    it('returns the plaintext once, no-store, and STORES ONLY ITS SHA-256', async () => {
      const res = await as(U_A).create({ name: '  loop on laptop  ' });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const plaintext: string = res.body.data.plaintext;
      plaintexts.push(plaintext);
      expect(plaintext).toMatch(TOKEN_SHAPE);
      const tok = res.body.data.token;
      expect(tok).toMatchObject({ name: 'loop on laptop', prefix: plaintext.slice(0, API_TOKEN_CONFIG.displayPrefixLength), lastUsedAt: null, expiresAt: null });
      tokenA = { id: tok.id, plaintext };

      const row = await rawRow(tok.id);
      expect(row.user_id).toBe(U_A);
      expect(row.token_hash).toBe(sha(plaintext));
      expect(row.whole.includes(plaintext)).toBe(false);
      expect(row.whole.includes(plaintext.slice(API_TOKEN_CONFIG.prefix.length))).toBe(false);
    });

    it('two creates yield two different tokens', async () => {
      const res = await as(U_A).create({ name: 'second', expiresInDays: 30 });
      expect(res.status).toBe(201);
      plaintexts.push(res.body.data.plaintext);
      expect(res.body.data.plaintext).not.toBe(tokenA.plaintext);
      const exp = new Date(res.body.data.token.expiresAt).getTime();
      const days = (exp - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });

    it.each([
      [{}, /name is required/],
      [{ name: '   ' }, /name is required/],
      [{ name: 'x'.repeat(API_TOKEN_CONFIG.nameMaxLength + 1) }, /at most/],
      [{ name: 'ok', expiresInDays: 0 }, /expiresInDays/],
      [{ name: 'ok', expiresInDays: 1.5 }, /expiresInDays/],
      [{ name: 'ok', expiresInDays: '7' }, /expiresInDays/],
    ])('400 for %j', async (body, msg) => {
      const res = await as(U_B).create(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(msg);
    });
  });

  describe('list — own tokens only, never the secret', () => {
    it('A sees exactly A\'s tokens with the exact key set; B sees none of them', async () => {
      const resA = await as(U_A).get();
      expect(resA.status).toBe(200);
      const raw = JSON.stringify(resA.body);
      for (const p of plaintexts) {
        expect(raw.includes(p)).toBe(false);
        expect(raw.includes(sha(p))).toBe(false);
      }
      const dbIds = (await pool.query('SELECT id FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL', [U_A])).rows
        .map((r) => r.id)
        .sort();
      expect(resA.body.data.tokens.map((t: { id: string }) => t.id).sort()).toEqual(dbIds);
      for (const t of resA.body.data.tokens) {
        expect(Object.keys(t).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'prefix']);
      }

      const resB = await as(U_B).get();
      expect(resB.status).toBe(200);
      expect(resB.body.data.tokens.map((t: { id: string }) => t.id)).not.toContain(tokenA.id);
    });
  });

  describe('revoke — own tokens only', () => {
    it('B revoking A\'s token is 404 and the raw row is untouched', async () => {
      const res = await as(U_B).revoke(tokenA.id);
      expect(res.status).toBe(404);
      expect((await rawRow(tokenA.id)).revoked_at).toBeNull();
    });

    it('a malformed id is 400', async () => {
      expect((await as(U_A).revoke('not-a-uuid')).status).toBe(400);
    });

    it('A revokes A\'s token: 200, revoked_at set, gone from the list; a repeat is 404', async () => {
      const res = await as(U_A).revoke(tokenA.id);
      expect(res.status).toBe(200);
      expect((await rawRow(tokenA.id)).revoked_at).not.toBeNull();
      const list = await as(U_A).get();
      expect(list.body.data.tokens.map((t: { id: string }) => t.id)).not.toContain(tokenA.id);
      expect((await as(U_A).revoke(tokenA.id)).status).toBe(404);
    });
  });

  describe('per-user cap', () => {
    it(`at ${API_TOKEN_CONFIG.maxActivePerUser} live tokens the next create is 409 and inserts nothing`, async () => {
      // Fill to cap-1 directly (a revoked and an expired row do NOT count toward it).
      const fill = API_TOKEN_CONFIG.maxActivePerUser - 1;
      for (let i = 0; i < fill; i++) {
        await pool.query(
          `INSERT INTO api_tokens (user_id, name, token_hash, display_prefix) VALUES ($1, $2, $3, 'mdl_fill0000')`,
          [U_CAP, `fill-${i}`, sha(`fill-${i}-${U_CAP}`)]
        );
      }
      await pool.query(
        `INSERT INTO api_tokens (user_id, name, token_hash, display_prefix, revoked_at) VALUES ($1,'dead',$2,'mdl_dead0000',now())`,
        [U_CAP, sha(`dead-${U_CAP}`)]
      );
      await pool.query(
        `INSERT INTO api_tokens (user_id, name, token_hash, display_prefix, expires_at) VALUES ($1,'old',$2,'mdl_old00000',now() - interval '1 day')`,
        [U_CAP, sha(`old-${U_CAP}`)]
      );
      const last = await as(U_CAP).create({ name: 'the last one' });
      expect(last.status).toBe(201);
      plaintexts.push(last.body.data.plaintext);
      const count = async () => (await pool.query('SELECT count(*)::int n FROM api_tokens WHERE user_id = $1', [U_CAP])).rows[0].n;
      const before = await count();
      const over = await as(U_CAP).create({ name: 'one too many' });
      expect(over.status).toBe(409);
      expect(over.body.code).toBe('TOKEN_LIMIT');
      expect(await count()).toBe(before);
    });
  });

  describe('create rate limit (per user)', () => {
    it(`the ${API_TOKEN_CONFIG.createRateLimit.max + 1}th create in a window is 429; another user is unaffected`, async () => {
      const statuses: number[] = [];
      for (let i = 0; i <= API_TOKEN_CONFIG.createRateLimit.max; i++) {
        const r = await as(U_RATE).create({ name: `r${i}` });
        if (r.body?.data?.plaintext) plaintexts.push(r.body.data.plaintext);
        statuses.push(r.status);
      }
      expect(statuses.slice(0, -1).every((s) => s === 201)).toBe(true);
      expect(statuses[statuses.length - 1]).toBe(429);
      const other = await as(U_RATE2).create({ name: 'unaffected' });
      expect(other.status).toBe(201);
      plaintexts.push(other.body.data.plaintext);
    });
  });

  describe('the plaintext never reaches a log', () => {
    it('no captured line from any logger / console / stdout / stderr contains a plaintext', () => {
      // Witness: capture worked (the requests above produced log lines at all).
      expect(captured.some((l) => l.includes('API token created'))).toBe(true);
      expect(plaintexts.length).toBeGreaterThan(5);
      for (const p of plaintexts) {
        expect(captured.filter((l) => l.includes(p))).toEqual([]);
        expect(captured.filter((l) => l.includes(p.slice(API_TOKEN_CONFIG.prefix.length)))).toEqual([]);
      }
    });
  });
});
