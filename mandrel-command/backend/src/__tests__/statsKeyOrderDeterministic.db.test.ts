/**
 * /api/contexts/stats and /api/projects/stats must serialise to the SAME BYTES for the
 * same data. Their `by_type` / `by_project` / `contexts_by_type` maps are
 * built by iterating `GROUP BY` rows; without an ORDER BY the row order — and therefore
 * the JSON key order — is whatever aggregation strategy the planner picked. A fresh
 * database flips strategy (HashAggregate <-> Sort+GroupAggregate) the moment autovacuum
 * refreshes statistics, so two back-to-back reads differed with no write in between and
 * tripped the unscoped-list ratchet's self-jitter check.
 *
 * Proved by FORCING each strategy on one connection and requiring identical output.
 */
import { describeDb } from './helpers/dbContractGate';
import { db } from '../database/connection';
import { ContextService } from '../services/context';
import { ProjectService } from '../services/project';
import { allProjects } from '../services/projectListScope';

const P1 = 'f5f5f5f5-0000-4000-8000-f5f5f5f5f5f1';
const P2 = 'f5f5f5f5-0000-4000-8000-f5f5f5f5f5f2';
// Deliberately NOT alphabetical in insertion order, and names that sort differently
// from their ids, so no accidental physical order equals the sorted order.
const TYPES = ['note', 'code', 'milestone', 'decision', 'error', 'planning'];

describeDb('stats endpoints serialise deterministically (DB integration)', () => {
  beforeAll(async () => {
    await db.query(
      `INSERT INTO projects (id, name) VALUES ($1,'zz-stats-order'),($2,'aa-stats-order')`,
      [P1, P2]
    );
    for (const [i, t] of TYPES.entries()) {
      for (let n = 0; n <= i; n++) {
        await db.query(
          `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,$2,'stats order')`,
          [i % 2 ? P1 : P2, t]
        );
      }
    }
  });

  afterAll(async () => {
    await db.query('DELETE FROM contexts WHERE project_id = ANY($1)', [[P1, P2]]);
    await db.query('DELETE FROM projects WHERE id = ANY($1)', [[P1, P2]]);
  });

  /** Run `fn` with every pool.query pinned to one connection under a forced agg strategy. */
  const underPlan = async <T>(hashagg: 'on' | 'off', fn: () => Promise<T>): Promise<T> => {
    const client = await (db as any).connect();
    const spy = jest.spyOn(db as any, 'query').mockImplementation(((...a: any[]) => client.query(...a)) as any);
    try {
      await client.query(`SET enable_hashagg = ${hashagg}`);
      await client.query(`SET enable_sort = ${hashagg === 'on' ? 'off' : 'on'}`);
      return await fn();
    } finally {
      spy.mockRestore();
      await client.query('RESET enable_hashagg');
      await client.query('RESET enable_sort');
      client.release();
    }
  };

  it('/api/contexts/stats body is byte-identical under hash and sort aggregation', async () => {
    const h = await underPlan('on', async () => JSON.stringify(await ContextService.getContextStats(allProjects)));
    const s = await underPlan('off', async () => JSON.stringify(await ContextService.getContextStats(allProjects)));
    expect(Object.keys(JSON.parse(h).by_type).length).toBeGreaterThan(3);
    expect(s).toBe(h);
  });

  it('/api/projects/stats body is byte-identical under hash and sort aggregation', async () => {
    const h = await underPlan('on', async () => JSON.stringify(await ProjectService.getProjectStats(allProjects)));
    const s = await underPlan('off', async () => JSON.stringify(await ProjectService.getProjectStats(allProjects)));
    expect(Object.keys(JSON.parse(h).contexts_by_type).length).toBeGreaterThan(3);
    expect(s).toBe(h);
  });
});
