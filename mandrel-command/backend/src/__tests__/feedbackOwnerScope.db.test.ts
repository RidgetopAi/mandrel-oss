/**
 * feedbackOwnerScope — owner-scoping guard for the /api/feedback surface
 *.
 *
 * =============================================================================
 * THE DEFECT
 * =============================================================================
 * `GET /api/feedback` ran `SELECT ... FROM feedback ORDER BY created_at DESC LIMIT $1`
 * with no owner predicate and no role check, so any authenticated user read every other
 * user's free-text submissions — including a customer tenant's. It was contained only by
 * the UI not rendering the list, which is luck, not a fix.
 *
 * =============================================================================
 * THE DEFECT IN THE FIRST FIX
 * =============================================================================
 * The first fix scoped on `username`, which is a RECYCLABLE HANDLE, so it was still a
 * leak. `req.user` is DB-DERIVED, not JWT-derived: `authenticateToken` re-reads the row
 * from `admin_users` on every request, so a username change takes effect on the next
 * call with no re-login and no new token. Any authenticated user may rewrite their own
 * username through `PUT /api/users/profile` (authenticateToken only; the sole constraint
 * is that the name is not currently taken). Vacate a username, claim it from another
 * account, and a username predicate hands over the vacated owner's rows — and the
 * renamed user loses sight of their own. Both halves are exercised below against the
 * REAL profile endpoint.
 *
 * =============================================================================
 * THE DECISION THIS ENCODES
 * =============================================================================
 * OWN-ROWS-ONLY, keyed on `feedback.user_id` -> `admin_users.id` (migration 077): a
 * gen_random_uuid() primary key that no endpoint rewrites and that is never reissued.
 * There is deliberately NO admin bypass: a feedback inbox, if we ever want one, is a
 * separate endpoint designed for that job, not a role check bolted onto a leaking list.
 * `feedback.username` survives as a denormalized display label for the out-of-band psql
 * readers and carries no authorization weight.
 *
 * =============================================================================
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3)
 * =============================================================================
 * Not a remembered list of paths. `feedbackRouteInventory()` below reads the routes off
 * the LIVE Express app exported by `src/server.ts` and keeps every one mounted under
 * /api/feedback, whatever its method. Two properties are asserted from it:
 *
 *   (a) the READ surface is swept — every GET route it finds is called as user A and
 *       must not contain B's row. A future `GET /api/feedback/:id` or `/stats` enters
 *       this sweep by EXISTING, without anyone remembering to add it.
 *   (b) the inventory itself is frozen — any new feedback route of any method fails this
 *       suite until someone states its scoping intent here. That is the tripwire for the
 *       mutating siblings (PATCH/DELETE), which cannot be leak-tested by reading a body.
 *
 * The assertion is on the SEEDED STRING, never on a count: a count assertion passes
 * against an empty response and hides a broken fixture.
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';

/** Dedicated id + name prefix: this suite shares one database with ~74 others. */
const U_A = 'fb000001-0000-4000-8000-fb000000000a';
const U_B = 'fb000002-0000-4000-8000-fb000000000b';
const U_EMPTY = 'fb000003-0000-4000-8000-fb000000000c';
const U_VICTIM = 'fb000004-0000-4000-8000-fb000000000d';
const U_ATTACKER = 'fb000005-0000-4000-8000-fb000000000e';
/** A live account whose username equals an UNOWNED row's stale label. See the orphan block. */
const U_LABEL = 'fb000006-0000-4000-8000-fb000000000f';

const NAME_A = 'fbprobealice';
const NAME_B = 'fbprobebob';
const NAME_EMPTY = 'fbprobenull';

/** The handle the attack recycles, the name the victim escapes to, the attacker's own. */
/**
 * The password every seeded persona shares. Only used to satisfy the re-auth on
 * PUT /api/users/profile — this suite is about OWNERSHIP scoping,
 * not about authentication, so the value is deliberately uninteresting.
 */
const SEEDED_PASSWORD = 'fixture-password-not-a-secret';
const NAME_VICTIM = 'fbprobevictim';
const NAME_VICTIM_NEW = 'fbprobevictimrenamed';
const NAME_ATTACKER = 'fbprobeattacker';
const NAME_LABEL = 'fbprobeorphanlabel';

/** The strings the assertions are anchored on. Distinctive enough to grep a whole body. */
const MARK_A = 'FEEDBACKOWNMARKERALICE';
const MARK_B = 'FEEDBACKLEAKMARKERBOB';
const MARK_VICTIM = 'FEEDBACKRENAMEVICTIMMARKER';
const MARK_ORPHAN = 'FEEDBACKUNOWNEDORPHANMARKER';

const ALL_IDS = [U_A, U_B, U_EMPTY, U_VICTIM, U_ATTACKER, U_LABEL];

type Persona = 'a' | 'b' | 'empty' | 'victim' | 'attacker' | 'label';

/**
 * Every route mounted under /api/feedback on the real app, read out of the router stack.
 * Same derivation mechanics as unscopedListProjectScope.db.test.ts, for the same reason:
 * a hand-written list is exactly the population that drifts from what is served.
 */
function feedbackRouteInventory(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const mountPrefix = (layer: any): string => {
    if (typeof layer.path === 'string') return layer.path;
    const src: string = layer.regexp?.source ?? '';
    if (src === '^\\/?(?=\\/|$)') return '';
    const m = src.match(/^\^\\\/(.*)\\\/\?\(\?=\\\/\|\$\)$/);
    return m ? '/' + m[1].replace(/\\\//g, '/') : '';
  };
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const p = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.push({ method: method.toUpperCase(), path: p || '/' });
        }
      } else if (typeof layer.handle === 'function' && Array.isArray((layer.handle as any).stack)) {
        walk((layer.handle as any).stack, prefix + mountPrefix(layer));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out
    .filter((r) => r.path === '/api/feedback' || r.path.startsWith('/api/feedback/'))
    .sort((x, y) => `${x.method} ${x.path}`.localeCompare(`${y.method} ${y.path}`));
}

describeDb('GET /api/feedback returns only the caller\'s own submissions', () => {
  const pool = db;
  const tokens: Record<Persona, string> = {} as never;

  const purge = async (): Promise<void> => {
    // Feedback is purged by OWNER ID, not by label: the attack renames users, so a
    // username-keyed cleanup would leave rows behind under a stale label.
    await pool.query('DELETE FROM feedback WHERE user_id = ANY($1::uuid[])', [ALL_IDS]);
    await pool.query('DELETE FROM feedback WHERE username = ANY($1::text[])', [
      [NAME_A, NAME_B, NAME_EMPTY, NAME_VICTIM, NAME_VICTIM_NEW, NAME_ATTACKER, NAME_LABEL],
    ]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [ALL_IDS]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [ALL_IDS]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await purge();

    // A REAL bcrypt hash, produced by the same AuthService the route verifies through.
    // It used to be a fake literal, which was fine while PUT /api/users/profile needed no
    // password — an earlier task made a real change require `currentPassword`, so this
    // fixture now has to be verifiable or the rename steps below 401. Hashing here rather
    // than pasting a literal keeps the fixture from drifting away from the real verifier.
    const seededHash = await AuthService.hashPassword(SEEDED_PASSWORD);

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active) VALUES
        ($1,$6,'fba@x.test',$13,'user',true),
        ($2,$7,'fbb@x.test',$13,'user',true),
        ($3,$8,'fbc@x.test',$13,'user',true),
        ($4,$9,'fbd@x.test',$13,'user',true),
        ($5,$10,'fbe@x.test',$13,'user',true),
        ($11,$12,'fbf@x.test',$13,'user',true)`,
      [
        U_A, U_B, U_EMPTY, U_VICTIM, U_ATTACKER,
        NAME_A, NAME_B, NAME_EMPTY, NAME_VICTIM, NAME_ATTACKER,
        U_LABEL, NAME_LABEL,
        seededHash,
      ]
    );

    // Alice owns two rows, Bob owns one. ASYMMETRIC on purpose: equal populations make
    // any accidental count-shaped check blind to the difference.
    await pool.query(
      `INSERT INTO feedback (user_id, username, type, severity, message, page) VALUES
        ($1,$3,'bug','high',$5,'/dashboard'),
        ($1,$3,'idea','low',$6,'/tasks'),
        ($2,$4,'bug','high',$7,'/dashboard')`,
      [U_A, U_B, NAME_A, NAME_B, `alice one ${MARK_A}`, `alice two ${MARK_A}`, `bob secret ${MARK_B}`]
    );

    for (const [persona, id, username] of [
      ['a', U_A, NAME_A],
      ['b', U_B, NAME_B],
      ['empty', U_EMPTY, NAME_EMPTY],
      ['victim', U_VICTIM, NAME_VICTIM],
      ['attacker', U_ATTACKER, NAME_ATTACKER],
      ['label', U_LABEL, NAME_LABEL],
    ] as const) {
      const { tokenId } = await AuthService.createSession(id);
      tokens[persona] = AuthService.generateJWT(
        { id, username, email: `${username}@x.test`, role: 'user' } as never,
        tokenId
      );
    }
  }, 120000);

  afterAll(async () => {
    await purge();
    await pool.end();
  });

  const getAs = async (path: string, persona: Persona, qs = '') => {
    const res = await request(app)
      .get(path + qs)
      .set('Authorization', `Bearer ${tokens[persona]}`);
    const body = typeof res.text === 'string' && res.text ? res.text : JSON.stringify(res.body);
    return { status: res.status, body, json: res.body };
  };

  // ── the fixture itself, asserted before anything is concluded from it ───────────────
  it('the fixture really seeded both users\' rows (a broken fixture must not read as clean)', async () => {
    const { rows } = await pool.query(
      'SELECT username, message FROM feedback WHERE username = ANY($1::text[]) ORDER BY username',
      [[NAME_A, NAME_B]]
    );
    expect(rows.map((r) => r.username)).toEqual([NAME_A, NAME_A, NAME_B]);
    expect(rows.filter((r) => r.message.includes(MARK_B))).toHaveLength(1);
  });

  // ── (b) the inventory tripwire ─────────────────────────────────────────────────────
  it('the /api/feedback route inventory is exactly the two scoped routes', () => {
    // POST / — write, owner is server-derived from req.user.id; it cannot leak a read.
    // GET /  — the read swept below.
    // A new route of ANY method fails here until its scoping intent is stated. That is
    // the only coverage a PATCH/DELETE sibling could get from a read-shaped guard.
    expect(feedbackRouteInventory()).toEqual([
      { method: 'GET', path: '/api/feedback' },
      { method: 'POST', path: '/api/feedback' },
    ]);
  });

  // ── (a) the read sweep ─────────────────────────────────────────────────────────────
  it('every GET route under /api/feedback withholds another user\'s row from Alice', async () => {
    const reads = feedbackRouteInventory().filter((r) => r.method === 'GET' && !r.path.includes(':'));
    expect(reads.length).toBeGreaterThan(0);

    for (const r of reads) {
      const { status, body } = await getAs(r.path, 'a');
      expect(status).toBe(200);
      expect(body).toContain(MARK_A);
      // The load-bearing assertion: Bob's actual seeded text, not a count.
      expect(body).not.toContain(MARK_B);
      expect(body).not.toContain(NAME_B);
    }
  });

  it('Alice gets both of her own rows back', async () => {
    const { json } = await getAs('/api/feedback', 'a');
    const messages: string[] = json.data.feedback.map((f: any) => f.message);
    expect(messages).toEqual(
      expect.arrayContaining([`alice one ${MARK_A}`, `alice two ${MARK_A}`])
    );
    expect(json.data.feedback.every((f: any) => f.username === NAME_A)).toBe(true);
  });

  it('Bob sees his own row and none of Alice\'s (the mirror direction)', async () => {
    const { body } = await getAs('/api/feedback', 'b');
    expect(body).toContain(MARK_B);
    expect(body).not.toContain(MARK_A);
  });

  it('a user with NO submissions gets an empty list, not everyone\'s', async () => {
    const { status, json, body } = await getAs('/api/feedback', 'empty');
    expect(status).toBe(200);
    expect(json.data.feedback).toEqual([]);
    expect(body).not.toContain(MARK_A);
    expect(body).not.toContain(MARK_B);
  });

  it('the limit parameter cannot widen the scope past the caller', async () => {
    const { body } = await getAs('/api/feedback', 'a', '?limit=500');
    expect(body).toContain(MARK_A);
    expect(body).not.toContain(MARK_B);
  });

  it('the write path stamps the immutable owner id, not just the label', async () => {
    const marker = 'FEEDBACKWRITEPATHOWNERMARKER';
    const post = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${tokens.b}`)
      .send({ type: 'bug', severity: 'low', message: `bob writes ${marker}`, page: '/x' });
    expect(post.status).toBe(201);

    const { rows } = await pool.query(
      'SELECT user_id, username FROM feedback WHERE message LIKE $1',
      [`%${marker}%`]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(U_B);
    expect(rows[0].username).toBe(NAME_B);
  });

  // ── the orphan population: rows migration 077 could not resolve to an owner ─────────
  //
  // This is not hypothetical. Measured on the live fleet 2026-08-09, per tenant
  // container, with:
  //   docker exec mandrel-<t>-postgres psql -U mandrel -d mandrel -tAc \
  //     "SELECT count(*) FROM feedback f LEFT JOIN admin_users u ON u.username=f.username
  //      WHERE u.id IS NULL;"
  // the operator tenant returns 3 and the contoso tenant returns 0 — feedback lives in
  // per-tenant databases and the username->id join resolves differently in each. The
  // operator rows were submitted as `admin`; that account is now `operator`, so the vacating
  // half of the attack above ALREADY HAPPENED in our own production data, and the freed
  // handle is claimable there today.
  //
  // Migration 077's stated decision: such a row KEEPS its content and gets a NULL owner.
  // It is never dropped, and no owner is guessed from the label — guessing "admin must
  // have meant operator" is the same mutable-handle reasoning that caused the bug. The
  // consequence is that NULL user_id must be UNREACHABLE over the API: nobody's rows are
  // nobody's. That is what these two tests execute, with the label deliberately set to a
  // LIVE account's username — the exact production shape.
  describe('a row with no resolvable owner is nobody\'s', () => {
    beforeAll(async () => {
      await pool.query(
        `INSERT INTO feedback (user_id, username, type, severity, message, page)
         VALUES (NULL, $1, 'bug', 'high', $2, '/dashboard')`,
        [NAME_LABEL, `unowned ${MARK_ORPHAN}`]
      );
    }, 120000);

    it('survives with its content intact and no owner', async () => {
      const { rows } = await pool.query(
        'SELECT user_id, username, message FROM feedback WHERE message LIKE $1',
        [`%${MARK_ORPHAN}%`]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeNull();
      expect(rows[0].message).toBe(`unowned ${MARK_ORPHAN}`);
      // and the label really does name a LIVE account — otherwise the next test is vacuous
      const live = await pool.query('SELECT id FROM admin_users WHERE username = $1', [
        rows[0].username,
      ]);
      expect(live.rows.map((r) => r.id)).toEqual([U_LABEL]);
    });

    it('is returned to NOBODY over HTTP, including the account whose name it carries', async () => {
      for (const persona of ['a', 'b', 'empty', 'victim', 'attacker', 'label'] as const) {
        const { status, body } = await getAs('/api/feedback', persona);
        expect(status).toBe(200);
        expect(body).not.toContain(MARK_ORPHAN);
      }
    });
  });

  // ── the recycled-username attack, run through the REAL endpoints ────────────────────
  describe('a recycled username does not carry ownership with it', () => {
    beforeAll(async () => {
      // 1. the victim submits feedback through the real write path.
      const submit = await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${tokens.victim}`)
        .send({ type: 'bug', severity: 'high', message: `victim says ${MARK_VICTIM}`, page: '/dashboard' });
      expect(submit.status).toBe(201);

      // 2. the victim renames themselves away through the REAL profile endpoint,
      //    vacating the handle. No admin involved; no re-login; the same token stays
      //    valid because authenticateToken re-reads admin_users on every request.
      const vacate = await request(app)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${tokens.victim}`)
        .send({ username: NAME_VICTIM_NEW, currentPassword: SEEDED_PASSWORD });
      expect(vacate.status).toBe(200);

      // 3. a DIFFERENT non-admin account claims the freed handle through the same
      //    real endpoint. This is the whole exploit; nothing here is privileged.
      const claim = await request(app)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${tokens.attacker}`)
        .send({ username: NAME_VICTIM, currentPassword: SEEDED_PASSWORD });
      expect(claim.status).toBe(200);

      // the attack landed: the attacker's row now carries the victim's old handle, and
      // the victim's feedback row still carries it as its stale label.
      const { rows } = await pool.query(
        'SELECT id, username FROM admin_users WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[U_VICTIM, U_ATTACKER]]
      );
      expect(rows.map((r) => r.username)).toEqual([NAME_VICTIM_NEW, NAME_VICTIM]);
      // The row is located by its MESSAGE, not by either owner field, so this landing
      // check holds identically against a username-keyed build and an id-keyed one —
      // the leak assertions below are then the only thing that can differ between them.
      const fb = await pool.query('SELECT username FROM feedback WHERE message LIKE $1', [
        `%${MARK_VICTIM}%`,
      ]);
      expect(fb.rows.map((r) => r.username)).toEqual([NAME_VICTIM]);
    }, 120000);

    it('the attacker holding the recycled handle does NOT receive the victim\'s row', async () => {
      const { status, body } = await getAs('/api/feedback', 'attacker');
      expect(status).toBe(200);
      // Anchored on the victim's seeded text, never on a count.
      expect(body).not.toContain(MARK_VICTIM);
    });

    it('the victim STILL sees their own row after renaming (ownership followed identity)', async () => {
      const { status, body } = await getAs('/api/feedback', 'victim');
      expect(status).toBe(200);
      expect(body).toContain(MARK_VICTIM);
    });
  });
});
