/**
 * CONTRACT: GET /api/treewalker/record/:id/why (design) — a record's
 * DECLARED causes, the work they spawned, its guessed SERIES, and what came just before it.
 *
 * Fixture (project P):
 *   M  milestone context — the record asked about
 *   D  decision; M --decided_by--> D (declared), and R1..R3 --decided_by--> D (declared)
 *   G  decision; M --decided_by--> G but MINTED BY INFERENCE (guessed) — never a cause
 *   N  context; M --related_to--> N (guessed) — never a cause
 *   A, B  other milestones; M --possibly_supersedes--> A, B --possibly_supersedes--> M
 *   X  a discussion context; M --possibly_supersedes--> X (not the same kind: not in the series)
 *   S  spine task; M, E2, E3, E1 are its members (E2 3d ago, E3 4d... see `daysAgo` below);
 *      O is NOT a member but sits in time between them — must never appear in `before`.
 * Project Q holds a record Z, asked for through P's scope.
 *
 * The route is mounted with the real router, real project middleware and a stub auth that
 * answers 401 without a marker header — so "the route requires authentication" is asserted
 * against the real router wiring (the repo-wide coverage tests pin the same for every route).
 */
import request from 'supertest';
import express from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { projectContextMiddleware } from '../middleware/project';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (
    req: { user?: unknown; headers: Record<string, string | undefined> },
    res: { status: (c: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (req.headers['x-test-auth'] !== 'yes') {
      res.status(401).json({ success: false, error: 'unauthenticated' });
      return;
    }
    req.user = { id: '00000000-0000-4000-8000-000000000001', role: 'admin' };
    next();
  },
}));
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: () => ({ userId: 'why-suite-user', tokenId: 't' }),
    findUserById: async () => ({ id: 'why-suite-user', role: 'admin' }),
  },
}));
jest.mock('../services/projectAccess', () => ({
  ProjectAccessService: { userHasProjectAccess: async () => true },
}));

import { db } from '../database/connection';
import treewalkerRoutes from '../routes/treewalker';
import { TREEWALKER_CONFIG } from '../config/treewalkerConfig';
import { describeDb } from './helpers/dbContractGate';

const app = express();
app.use(express.json());
app.use('/treewalker', projectContextMiddleware);
app.use('/treewalker', treewalkerRoutes);

describeDb('TreeWalker Why', () => {
  let pool: Pool;
  let P: string, Q: string;
  const id = {
    M: uuidv4(), D: uuidv4(), G: uuidv4(), N: uuidv4(), A: uuidv4(), B: uuidv4(), X: uuidv4(),
    R1: uuidv4(), R2: uuidv4(), R3: uuidv4(), S: uuidv4(), E1: uuidv4(), E2: uuidv4(), E3: uuidv4(),
    O: uuidv4(), Z: uuidv4(),
  };
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  const why = (rid: string, project: string | null = P, authed = true) => {
    let r = request(app).get(`/treewalker/record/${rid}/why`).set('Authorization', 'Bearer aaa.bbb.ccc');
    if (authed) r = r.set('x-test-auth', 'yes');
    if (project) r = r.set('X-Project-ID', project);
    return r;
  };

  beforeAll(async () => {
    pool = db as unknown as Pool;
    P = uuidv4();
    Q = uuidv4();
    for (const [pid, n] of [[P, 'p'], [Q, 'q']] as const) {
      await pool.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'why fixture', 'active', NOW())`,
        [pid, `why-${n}-${Date.now()}`],
      );
    }
    const ctx = (rid: string, proj: string, type: string, content: string, at: Date) =>
      pool.query(
        `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at)
         VALUES ($1,$2,$3,$4,'{}',$5)`,
        [rid, proj, type, content, at],
      );
    const dec = (rid: string, title: string, at: Date) =>
      pool.query(
        `INSERT INTO technical_decisions
           (id, project_id, decision_type, title, description, rationale, impact_level, metadata, decision_date)
         VALUES ($1,$2,'architecture',$3,'d','r','high','{}',$4)`,
        [rid, P, title, at],
      );
    const task = (rid: string, title: string, at: Date) =>
      pool.query(
        `INSERT INTO tasks (id, project_id, title, status, type, tags, created_at)
         VALUES ($1,$2,$3,'todo','feature','{}',$4)`,
        [rid, P, title, at],
      );
    await ctx(id.M, P, 'milestone', 'M — the milestone asked about', daysAgo(5));
    await ctx(id.A, P, 'milestone', 'A — a later milestone', daysAgo(1));
    await ctx(id.B, P, 'milestone', 'B — an earlier milestone', daysAgo(9));
    await ctx(id.X, P, 'discussion', 'X — a discussion that is not a milestone', daysAgo(6));
    await ctx(id.N, P, 'discussion', 'N — a related_to neighbour', daysAgo(7));
    await ctx(id.E1, P, 'note', 'E1 — branch member AFTER M', daysAgo(2));
    await ctx(id.E2, P, 'note', 'E2 — branch member before M', daysAgo(8));
    await ctx(id.E3, P, 'note', 'E3 — branch member before M', daysAgo(6.5));
    await ctx(id.O, P, 'note', 'O — NOT on the branch, in time before M', daysAgo(5.5));
    await ctx(id.Z, Q, 'milestone', 'Z — a record in another project', daysAgo(3));
    await dec(id.D, 'D — the deciding decision', daysAgo(10));
    await dec(id.G, 'G — a guessed decision', daysAgo(10));
    await task(id.S, 'S — the spine', daysAgo(30));
    await task(id.R1, 'R1 — spawned', daysAgo(4));
    await task(id.R2, 'R2 — spawned', daysAgo(3));
    await task(id.R3, 'R3 — spawned', daysAgo(2));

    const link = (from: string, ft: string, to: string, tt: string, edge: string, mint: string) =>
      pool.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
         VALUES ($1,$2,$3,$4,$5,$6,'why-test',$7)`,
        [from, ft, to, tt, edge, P, mint],
      );
    await link(id.M, 'context', id.D, 'decision', 'decided_by', 'link-tool');
    for (const r of [id.R1, id.R2, id.R3]) await link(r, 'task', id.D, 'decision', 'decided_by', 'link-tool');
    await link(id.M, 'context', id.G, 'decision', 'decided_by', 'inference');
    await link(id.M, 'context', id.N, 'context', 'related_to', 'inference');
    await link(id.M, 'context', id.A, 'context', 'possibly_supersedes', 'inference');
    await link(id.B, 'context', id.M, 'context', 'possibly_supersedes', 'inference');
    await link(id.M, 'context', id.X, 'context', 'possibly_supersedes', 'inference');
    await link(id.E2, 'context', id.M, 'context', 'informs', 'link-tool');

    const member = (rid: string, type: string) =>
      pool.query(
        `INSERT INTO branch_memberships
           (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type, source, project_id, created_at)
         VALUES ($1,$2,$3,'task',$3,'task','recorded',$4,NOW())`,
        [rid, type, id.S, P],
      );
    for (const m of [id.M, id.E1, id.E2, id.E3]) await member(m, 'context');
  });

  afterAll(async () => {
    const ids = Object.values(id);
    await pool.query(`DELETE FROM links WHERE from_id = ANY($1::uuid[]) OR to_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM branch_memberships WHERE project_id = ANY($1::uuid[])`, [[P, Q]]);
    await pool.query(`DELETE FROM tasks WHERE project_id = ANY($1::uuid[])`, [[P, Q]]);
    await pool.query(`DELETE FROM technical_decisions WHERE project_id = ANY($1::uuid[])`, [[P, Q]]);
    await pool.query(`DELETE FROM contexts WHERE project_id = ANY($1::uuid[])`, [[P, Q]]);
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [[P, Q]]);
  });

  describe('the milestone M', () => {
    let body: any;
    beforeAll(async () => {
      const res = await why(id.M);
      expect(res.status).toBe(200);
      body = res.body.data;
    });

    it('returns the record with its thread-v2 fields', () => {
      expect(body.record).toMatchObject({ id: id.M, kind: 'context', contextType: 'milestone' });
      expect(typeof body.record.trust).toBe('string');
      expect(body.record.createdAt).toMatch(/T/);
    });

    it('lists D under decided_by with spawned count 3 (the other declared decided_by records)', () => {
      const group = body.causes.find((g: any) => g.edgeType === 'decided_by');
      expect(group.targets.map((t: any) => t.id)).toEqual([id.D]);
      const spawned = body.spawned.find((s: any) => s.decisionId === id.D);
      expect(spawned.total).toBe(3);
      expect(spawned.records.map((r: any) => r.id).sort()).toEqual([id.R1, id.R2, id.R3].sort());
      // newest first
      expect(spawned.records[0].id).toBe(id.R3);
    });

    it('never lists the related_to neighbour or any guessed record as a cause', () => {
      const causeIds = body.causes.flatMap((g: any) => g.targets.map((t: any) => t.id));
      expect(causeIds).toEqual([id.D]);
      for (const guessed of [id.N, id.G, id.A, id.B, id.X]) expect(causeIds).not.toContain(guessed);
    });

    it('returns a series of exactly the three milestones in createdAt order, all guessed', () => {
      expect(body.series.map((s: any) => s.id)).toEqual([id.B, id.M, id.A]);
      expect(body.series.every((s: any) => s.guessed === true)).toBe(true);
      expect(body.series.filter((s: any) => s.isCurrent).map((s: any) => s.id)).toEqual([id.M]);
      expect(body.series.map((s: any) => s.id)).not.toContain(id.X);
    });

    it('returns before-records only from the branch, flagged byTime', () => {
      expect(body.branch).toMatchObject({ id: id.S });
      // the spine is itself a thread-v2 member (and is older than M), so it leads.
      expect(body.before.map((b: any) => b.id)).toEqual([id.S, id.E2, id.E3]);
      expect(body.before.every((b: any) => b.byTime === true)).toBe(true);
      const ids = body.before.map((b: any) => b.id);
      expect(ids).not.toContain(id.O);
      expect(ids).not.toContain(id.E1);
    });

    it('reports the declared and guessed edge totals without listing guessed ones', () => {
      expect(body.counts).toEqual({ declared: 2, guessed: 5 });
    });
  });

  it('caps spawned and before lists by config but still reports the true spawned total', async () => {
    const w = TREEWALKER_CONFIG.why;
    const saved = w.spawnedMax;
    (w as { spawnedMax: number }).spawnedMax = 2;
    try {
      const res = await why(id.M);
      const s = res.body.data.spawned.find((x: any) => x.decisionId === id.D);
      expect(s.total).toBe(3);
      expect(s.records).toHaveLength(2);
    } finally {
      (w as { spawnedMax: number }).spawnedMax = saved;
    }
  });

  it('a record on no branch has branch null and no before-records', async () => {
    const res = await why(id.O);
    expect(res.status).toBe(200);
    expect(res.body.data.branch).toBeNull();
    expect(res.body.data.before).toEqual([]);
    expect(res.body.data.series).toEqual([]);
  });

  describe('scope + auth', () => {
    it('requires authentication', async () => {
      const res = await why(id.M, P, false);
      expect(res.status).toBe(401);
    });

    it("a record id from another project is a 404 carrying no record fields", async () => {
      const res = await why(id.Z, P);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Z — a record in another project');
      expect(res.body.data).toBeUndefined();
      expect(res.body.record).toBeUndefined();
    });

    it('the same record is readable from its own project (control)', async () => {
      const res = await why(id.Z, Q);
      expect(res.status).toBe(200);
      expect(res.body.data.record.id).toBe(id.Z);
    });

    it('an unknown id is a 404 and a malformed id is a 400', async () => {
      expect((await why(uuidv4())).status).toBe(404);
      expect((await why('not-a-uuid')).status).toBe(400);
    });
  });
});
