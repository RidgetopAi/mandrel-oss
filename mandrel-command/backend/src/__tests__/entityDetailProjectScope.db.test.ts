/**
 * entityDetailProjectScope — THE WHOLE-CLASS GUARD for parameterised (by-id) reads
 * (the entity-detail half of item 7).
 *
 * =============================================================================
 * THE DEFECT
 * =============================================================================
 * The list half of this task made an unscoped list mean "the caller's projects". The reads
 * beside them that take an id in the PATH took no authority at all — `getTaskById(id)` and
 * `getContextById(id)` had no scope argument — so the branch ended up in exactly the state
 * it exists to abolish, one family over: `/api/projects/:id` tight, `/api/tasks/:id` open.
 *
 * Measured with a zero-grant non-admin and ids seeded into a project it holds no grant on:
 * `/api/tasks/:id`, `/api/contexts/:id`, `/api/sessions/:id`,
 * `/api/session-code/session/:sessionId`, `/api/treewalker/:anchorId/thread` and
 * `/api/resolve/:id` all answered 200 with the victim's rows; `/api/r/:id` answered 302 to
 * `/tasks/<id>`, which discloses the id is real and what kind of record it is.
 *
 * =============================================================================
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3)
 * =============================================================================
 * EVERY GET route registered on the real Express `app` whose path carries a `:param`, read
 * out of `app._router.stack` at runtime — the same derivation the bare-route sweep and
 * `mutatingRouteAuthzCoverage.test.ts` use. 30 of the 109 GET routes.
 *
 * The rule is DENY BY DEFAULT: every derived parameterised route must either be named in
 * NOT_PROJECT_SCOPED below (with a reason) or survive the attack. A route this file has
 * never heard of is a FAILURE, not a pass — which is what makes a new `/:id` route added
 * tomorrow a red test rather than a silent hole.
 *
 * =============================================================================
 * WHY IT IS BEHAVIOURAL, AND WHERE THE SIGNAL COMES FROM
 * =============================================================================
 * The anchor discipline from the bare-route sweep applies here too: the signal must come
 * from something THE TEST CONTROLS, never from comparing two responses of the code under
 * test. Here that anchor is a planted MARKER — every victim row carries a string this file
 * chose, so "the response contains it" is a fact about the response, not a differential
 * that a scope-blind endpoint can equalise away.
 *
 * A marker check alone is not enough for a route that discloses without echoing content
 * (the `/api/r/:id` 302 carries only a type and an id), so the STATUS is asserted too.
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
import { PROJECT_OWNED_TABLES } from '../services/entityProjectScope';

const P_VICTIM = 'e0e0e0e0-0000-4000-8000-e0e0e0e0e0e0';
const P_GRANTED = 'e1e1e1e1-0000-4000-8000-e1e1e1e1e1e1';
const U_ADMIN = 'e2e2e2e2-0000-4000-8000-e2e2e2e2e2e2';
const U_GRANT = 'e3e3e3e3-0000-4000-8000-e3e3e3e3e3e3';
const U_ZERO = 'e4e4e4e4-0000-4000-8000-e4e4e4e4e4e4';

const VICTIM_MARK = 'ENTVICTIMMARKER';
const GRANT_MARK = 'ENTGRANTEDMARKER';

/** Ids the test plants. Every one lives in P_VICTIM. */
const V = {
  task: 'e5e5e5e5-0000-4000-8000-e5e5e5e5e5e5',
  context: 'e6e6e6e6-0000-4000-8000-e6e6e6e6e6e6',
  decision: 'e7e7e7e7-0000-4000-8000-e7e7e7e7e7e7',
  session: 'e8e8e8e8-0000-4000-8000-e8e8e8e8e8e8',
} as const;

/** A session owned by NO project — `sessions.project_id` is NULLABLE. See the seed note. */
const ORPHAN_SESSION = 'edededed-0000-4000-8000-edededededed';

/** The same shapes in the project the `granted` persona DOES hold — the Q4 control. */
const G = {
  task: 'e9e9e9e9-0000-4000-8000-e9e9e9e9e9e9',
  context: 'eaeaeaea-0000-4000-8000-eaeaeaeaeaea',
  decision: 'ebebebeb-0000-4000-8000-ebebebebebeb',
  session: 'ecececec-0000-4000-8000-ecececececec',
} as const;

/**
 * ── DECLARED NOT PROJECT-SCOPED ──────────────────────────────────────────────────────
 * Every entry needs a reason, and the reason has to survive being read out loud. These are
 * the only parameterised GET routes exempt from the attack below; anything else must pass
 * it or this suite fails naming the route.
 */
const NOT_PROJECT_SCOPED: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: '/api/users/:userId/project-access',
    why:
      'requireAdmin on the route. It enumerates ANOTHER USER\'s authorization state, which ' +
      'is not a project-owned record — there is no project_id to check it against, and an ' +
      'admin holds every project by definition.',
  },
  {
    path: '/api/monitoring/services/:serviceName',
    why: 'a service health probe. The param names a PROCESS, not a record; no project owns it.',
  },
  {
    path: '/api/naming/check/:name',
    why: 'a name-availability check against the naming registry; the param is a NAME, not a record id.',
  },
  {
    path: '/api/naming/suggest/:name',
    why: 'name suggestions from a NAME; same reason as /check/:name.',
  },
  {
    path: '/api/naming/:id',
    why:
      'the naming registry is a single hardcoded bootstrap project (controllers/naming.ts:491 ' +
      'pins one project uuid for the whole surface), so there is no per-caller project scope ' +
      'to enforce here yet. NOT a clean bill of health: it is out of this task\'s scope and is ' +
      'reported as uncovered rather than silently omitted.',
  },
];

// ── the derivation ─────────────────────────────────────────────────────────────────────
function mountPrefix(layer: any): string {
  if (typeof layer.path === 'string') return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

function discoverGetRoutes(): string[] {
  const out: string[] = [];
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const p = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        if (layer.route.methods.get) out.push(p || '/');
      } else if (typeof layer.handle === 'function' && Array.isArray((layer.handle as any).stack)) {
        walk((layer.handle as any).stack, prefix + mountPrefix(layer));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out;
}

const ALL_GET_ROUTES = discoverGetRoutes();
const PARAM_ROUTES = ALL_GET_ROUTES.filter((p) => p.includes(':'));
const EXEMPT = new Set(NOT_PROJECT_SCOPED.map((e) => e.path));
const UNDER_ATTACK = PARAM_ROUTES.filter((p) => !EXEMPT.has(p));

/**
 * Substitute victim ids into a path. Keyed by PARAM NAME, not by route, so a new route
 * reusing an existing param name is attacked without anyone adding it here.
 *
 * `:id` and `:anchorId` are ambiguous — they may name any record kind — so every candidate
 * is tried and ALL of them must be refused. Trying only the "right" one per route would be
 * a hand-mapping, and the routes that take `:id` do not agree on what kind it is.
 */
function victimUrlsFor(routePath: string): string[] {
  const perParam: Record<string, string[]> = {
    id: [V.task, V.context, V.decision, V.session, P_VICTIM],
    anchorId: [V.task, V.context, V.decision],
    sessionId: [V.session],
    projectId: [P_VICTIM],
    userId: [U_ZERO],
    jobId: [V.task],
    serviceName: ['mandrel'],
    name: ['whatever'],
  };
  const params = [...routePath.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (params.length === 0) return [];
  let urls = [routePath];
  for (const p of params) {
    const values = perParam[p] ?? [V.task];
    urls = urls.flatMap((u) => values.map((v) => u.replace(`:${p}`, v)));
  }
  return urls;
}

describeDb('by-id reads are authorized against the record\'s project', () => {
  const pool = db;
  const tokens: Record<'admin' | 'granted' | 'zero', string> = {} as never;

  beforeAll(async () => {
    await assertDbReachable(pool);

    const allIds = [...Object.values(V), ...Object.values(G), ORPHAN_SESSION];
    for (const t of ['tasks', 'contexts', 'technical_decisions', 'sessions']) {
      await pool.query(`DELETE FROM ${t} WHERE id = ANY($1::uuid[])`, [allIds]);
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[P_VICTIM, P_GRANTED]]);
    }
    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_VICTIM, P_GRANTED]]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);

    await pool.query('INSERT INTO projects (id, name, description) VALUES ($1,$2,$3),($4,$5,$6)', [
      P_VICTIM, `victim-${VICTIM_MARK}`, `desc ${VICTIM_MARK}`,
      P_GRANTED, `granted-${GRANT_MARK}`, `desc ${GRANT_MARK}`,
    ]);

    for (const [pid, ids, mark] of [
      [P_VICTIM, V, VICTIM_MARK],
      [P_GRANTED, G, GRANT_MARK],
    ] as const) {
      await pool.query(
        `INSERT INTO tasks (id, project_id, title, description, type, status, priority)
         VALUES ($1,$2,$3,$4,'general','todo','medium')`,
        [ids.task, pid, `task ${mark}`, `d ${mark}`]
      );
      await pool.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags)
         VALUES ($1,$2,'completion',$3,$4)`,
        [ids.context, pid, `ctx ${mark}`, ['ref:resume', mark]]
      );
      await pool.query(
        `INSERT INTO technical_decisions (id, project_id, decision_type, title, description, rationale)
         VALUES ($1,$2,'architecture',$3,$4,$5)`,
        [ids.decision, pid, `dec ${mark}`, `d ${mark}`, `r ${mark}`]
      );
      await pool.query(
        `INSERT INTO sessions (id, project_id, agent_type, display_id, title, context_summary,
                               started_at, ended_at)
         VALUES ($1,$2,'claude',$3,$4,$5, NOW() - interval '2 hour', NOW() - interval '1 hour')`,
        [ids.session, pid, `SS-${mark.slice(0, 6)}`, `sess ${mark}`, `summary ${mark}`]
      );
    }

    // THE ABSENT POPULATION (C3). `sessions.project_id` is NULLABLE, so a session owned by
    // NO project is a real state, and "no owner" must behave like "no access" rather than
    // like "no restriction" — the classic fail-open shape.
    await pool.query(
      // `ended_at` IS SET DELIBERATELY. This row only needs a NULL *project* — it is the
      // absent-owner population. Leaving it ACTIVE (ended_at NULL) made its duration a
      // live NOW()-derived value, and because suites share one database that made
      // /api/sessions and the session aggregates drift inside
      // unscopedListProjectScope.db.test.ts's baseline sweeps. A fixture must not be an
      // instrument for the suite next door.
      `INSERT INTO sessions (id, project_id, agent_type, display_id, title, started_at, ended_at)
       VALUES ($1, NULL, 'claude', $2, $3, NOW() - interval '1 hour', NOW() - interval '30 minute')`,
      [ORPHAN_SESSION, 'SS-ORPHAN', `orphan ${VICTIM_MARK}`]
    );

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active) VALUES
        ($1,'entadmin','entadmin@x.test',$4,'admin',true),
        ($2,'entgrant','entgrant@x.test',$4,'user',true),
        ($3,'entzero','entzero@x.test',$4,'user',true)`,
      [U_ADMIN, U_GRANT, U_ZERO, '$2b$04$notarealhashnotarealhashno']
    );
    await pool.query('INSERT INTO user_project_access (user_id, project_id) VALUES ($1,$2)', [
      U_GRANT, P_GRANTED,
    ]);

    for (const [name, id, role] of [
      ['admin', U_ADMIN, 'admin'],
      ['granted', U_GRANT, 'user'],
      ['zero', U_ZERO, 'user'],
    ] as const) {
      const { tokenId } = await AuthService.createSession(id);
      tokens[name] = AuthService.generateJWT(
        { id, username: `ent${name}`, email: `${name}@x.test`, role } as never,
        tokenId
      );
    }
  }, 120000);

  afterAll(async () => {
    // Shared DB, run in band with 74 other suites — clean up, do not leave rows behind.
    const allIds = [...Object.values(V), ...Object.values(G), ORPHAN_SESSION];
    for (const t of ['tasks', 'contexts', 'technical_decisions', 'sessions']) {
      await pool.query(`DELETE FROM ${t} WHERE id = ANY($1::uuid[])`, [allIds]);
    }
    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_VICTIM, P_GRANTED]]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [
      [U_ADMIN, U_GRANT, U_ZERO],
    ]);
    // CLOSE THE POOL — see the note in unscopedListProjectScope.db.test.ts. An open pool
    // handle makes jest hang forever under the gate's `--runInBand --ci` (no --forceExit).
    await pool.end();
  });

  const hit = async (path: string, persona: 'admin' | 'granted' | 'zero') => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${tokens[persona]}`);
    const body = typeof res.text === 'string' && res.text ? res.text : JSON.stringify(res.body);
    return { status: res.status, body, location: res.headers.location as string | undefined };
  };

  describe('the population', () => {
    it('every parameterised GET route is either attacked or declared unscoped — no third state', () => {
      // NON-EMPTY TRAPS on both halves.
      expect(PARAM_ROUTES.length).toBeGreaterThan(25);
      expect(UNDER_ATTACK.length).toBeGreaterThan(18);

      // DENY BY DEFAULT: the exempt list may only name routes that really exist, so a
      // typo cannot quietly excuse a live route.
      for (const { path } of NOT_PROJECT_SCOPED) expect(PARAM_ROUTES).toContain(path);

      // Every exemption carries a reason. An empty string is not a reason.
      for (const { path, why } of NOT_PROJECT_SCOPED) {
        expect({ path, hasReason: why.trim().length > 40 }).toEqual({ path, hasReason: true });
      }

      // HAND-WRITTEN SNAPSHOT asserted AGAINST the derived set, never in place of it.
      for (const p of [
        '/api/tasks/:id',
        '/api/tasks/:id/dependencies',
        '/api/tasks/:id/links',
        '/api/contexts/:id',
        '/api/contexts/:id/links',
        '/api/contexts/:id/related',
        '/api/decisions/:id',
        '/api/decisions/:id/links',
        '/api/sessions/:id',
        '/api/session-code/session/:sessionId',
        '/api/session-code/commits/:sessionId',
        '/api/session-code/metrics/:sessionId',
        '/api/git/session/:sessionId/stats',
        '/api/v2/sessions/:sessionId/files',
        '/api/treewalker/:anchorId/thread',
        '/api/resolve/:id',
        '/api/r/:id',
        '/r/:id',
        '/api/projects/:id',
        '/api/projects/:id/insights',
        '/api/projects/:id/sessions',
      ]) {
        expect(UNDER_ATTACK).toContain(p);
      }
    });

    it('the by-id guard searches every project-owning table', () => {
      // The guard's own population, asserted rather than assumed: if a project-owned table
      // is added and the `any` resolver does not learn about it, an anchor of that kind
      // would resolve to "no row" -> 403, which is fail-closed but silently over-strict.
      expect([...PROJECT_OWNED_TABLES].sort()).toEqual(
        ['contexts', 'sessions', 'tasks', 'technical_decisions'].sort()
      );
    });
  });

  it('DETECTOR IS NOT VACUOUS: an ADMIN reaches every victim record and sees the marker', async () => {
    // If this goes false, every "sees NOTHING" assertion below is unfalsifiable — the ids
    // could simply not exist, or the routes could be broken for everyone.
    const unreachable: string[] = [];
    for (const p of ['/api/tasks/:id', '/api/contexts/:id', '/api/sessions/:id', '/api/resolve/:id']) {
      for (const url of victimUrlsFor(p)) {
        const res = await hit(url, 'admin');
        if (res.status === 200 && res.body.includes(VICTIM_MARK)) {
          unreachable.length = 0;
          break;
        }
        unreachable.push(`${url} [${res.status}]`);
      }
      expect({ route: p, adminSawVictim: unreachable.length === 0 }).toEqual({
        route: p,
        adminSawVictim: true,
      });
      unreachable.length = 0;
    }
  }, 120000);

  it('THE PROPERTY: a ZERO-GRANT non-admin gets no victim data from ANY parameterised route', async () => {
    const leaks: string[] = [];
    for (const routePath of UNDER_ATTACK) {
      for (const url of victimUrlsFor(routePath)) {
        const res = await hit(url, 'zero');
        // (1) no planted marker anywhere in the response body
        if (res.body.includes(VICTIM_MARK) || res.body.includes(GRANT_MARK)) {
          leaks.push(`MARKER ${url} [${res.status}]`);
        }
        // (2) no successful navigation either. A 302 to /tasks/<id> carries no marker but
        // still says the id is real AND what kind of record it is.
        if (res.status >= 200 && res.status < 400) {
          leaks.push(`REACHED ${url} [${res.status}] ${res.location ?? ''}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  }, 300000);

  it('THE PROPERTY: a GRANTED non-admin gets no VICTIM data either', async () => {
    const leaks: string[] = [];
    for (const routePath of UNDER_ATTACK) {
      for (const url of victimUrlsFor(routePath)) {
        const res = await hit(url, 'granted');
        if (res.body.includes(VICTIM_MARK)) leaks.push(`${url} [${res.status}]`);
      }
    }
    expect(leaks).toEqual([]);
  }, 300000);

  it('NOT BROKEN FOR EVERYONE: a GRANTED non-admin still reads its OWN records', async () => {
    // The assertion a deny-everything "fix" cannot pass. Hand-written URLs on purpose:
    // this is a POSITIVE control on named routes, so naming them is the point — unlike the
    // attack above, where a hand-list would be the hole.
    const broken: string[] = [];
    const CASES: ReadonlyArray<[string, boolean]> = [
      [`/api/tasks/${G.task}`, true],
      [`/api/tasks/${G.task}/links`, false],
      [`/api/tasks/${G.task}/dependencies`, false],
      [`/api/contexts/${G.context}`, true],
      [`/api/contexts/${G.context}/links`, false],
      [`/api/contexts/${G.context}/related`, false],
      [`/api/sessions/${G.session}`, true],
      [`/api/session-code/session/${G.session}`, true],
      [`/api/session-code/commits/${G.session}`, false],
      [`/api/session-code/metrics/${G.session}`, false],
      [`/api/git/session/${G.session}/stats`, false],
      [`/api/treewalker/${G.context}/thread`, false],
      [`/api/resolve/${G.task}`, true],
      [`/api/projects/${P_GRANTED}`, true],
    ];
    for (const [url, expectMarker] of CASES) {
      const res = await hit(url, 'granted');
      if (res.status !== 200) broken.push(`${url} [${res.status}]`);
      else if (expectMarker && !res.body.includes(GRANT_MARK)) broken.push(`${url} [no data]`);
    }
    expect(broken).toEqual([]);

    // And the redirect family still navigates for an authorized caller — proof the 404 the
    // attack asserts is a SCOPE miss, not the route being dead.
    const redirect = await hit(`/api/r/${G.task}`, 'granted');
    expect({ status: redirect.status, to: redirect.location }).toEqual({
      status: 302,
      to: `/tasks/${G.task}`,
    });
  }, 120000);

  it('a record owned by NO project is DENIED, not unrestricted (the absent population)', async () => {
    // A NULL owner is "no owner", which must map onto "no access". If it ever mapped onto
    // "no restriction" this is the row that would leak, and nothing else in this file
    // would notice — every other fixture row has an owner.
    for (const url of [
      `/api/sessions/${ORPHAN_SESSION}`,
      `/api/session-code/session/${ORPHAN_SESSION}`,
      `/api/session-code/commits/${ORPHAN_SESSION}`,
      `/api/session-code/metrics/${ORPHAN_SESSION}`,
      `/api/git/session/${ORPHAN_SESSION}/stats`,
    ]) {
      const zero = await hit(url, 'zero');
      expect({ url, status: zero.status }).toEqual({ url, status: 403 });
      expect(zero.body).not.toContain(VICTIM_MARK);

      const granted = await hit(url, 'granted');
      expect({ url, status: granted.status }).toEqual({ url, status: 403 });
    }
    // CONTROL: the row really exists and is reachable by someone, or the 403s above prove
    // nothing. Admin holds every project by definition and bypasses the owner lookup.
    // The control asserts on the ID rather than the marker: MEASURED, this route joins to
    // `projects` and an orphan row comes back with `project_name: null` and no title in the
    // payload, so a marker assertion here would fail for a reason that has nothing to do
    // with authorization. The id echoed in a 200 is unambiguous evidence the row exists and
    // is reachable by someone.
    const admin = await hit(`/api/sessions/${ORPHAN_SESSION}`, 'admin');
    expect({ status: admin.status, sawIt: admin.body.includes(ORPHAN_SESSION) }).toEqual({
      status: 200,
      sawIt: true,
    });
  }, 60000);

  it('NON-DISCLOSING: a NONEXISTENT id and an UNGRANTED id are indistinguishable', async () => {
    // The chosen failure mode, asserted. If these two ever diverge, an unauthorized caller
    // can enumerate ids and learn which are real — and the divergence would otherwise be
    // invisible, because both answers are "not 200".
    const NONEXISTENT = 'ffffffff-0000-4000-8000-ffffffffffff';
    const pairs: Array<{ route: string; ungranted: number; nonexistent: number }> = [];
    for (const routePath of [
      '/api/tasks/:id',
      '/api/contexts/:id',
      '/api/sessions/:id',
      '/api/decisions/:id',
      '/api/session-code/session/:sessionId',
      '/api/git/session/:sessionId/stats',
      '/api/treewalker/:anchorId/thread',
      '/api/projects/:id',
    ]) {
      const ungrantedUrl = routePath.replace(/:\w+/, routePath.includes('session') ? V.session : V.task);
      const missingUrl = routePath.replace(/:\w+/, NONEXISTENT);
      const a = await hit(ungrantedUrl, 'zero');
      const b = await hit(missingUrl, 'zero');
      pairs.push({ route: routePath, ungranted: a.status, nonexistent: b.status });
    }
    for (const p of pairs) {
      expect({ route: p.route, same: p.ungranted === p.nonexistent, status: p.ungranted }).toEqual({
        route: p.route,
        same: true,
        status: 403,
      });
    }
  }, 120000);

  it('the NAVIGATION SPINE answers a scoped MISS, not a 403 (a 403 would confirm the id)', async () => {
    // /api/resolve/:id and /r/:id take a SHORT PREFIX and search several tables at once, so
    // "you may not have this" and "no such id" are the same query result by construction.
    // The honest answer is the existing not-found path; a 403 here would itself be the
    // disclosure the rest of this file prevents.
    for (const url of ['/api/resolve/' + V.task, '/api/r/' + V.task, '/r/' + V.task]) {
      const res = await hit(url, 'zero');
      expect({ url, status: res.status }).toEqual({ url, status: 404 });
      expect(res.body).not.toContain(VICTIM_MARK);
      expect(res.location).toBeUndefined();
    }
  }, 60000);
});
