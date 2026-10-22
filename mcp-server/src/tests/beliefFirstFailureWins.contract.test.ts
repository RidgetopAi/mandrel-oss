/**
 * BELIEF PAIRING — FIRST-FAILURE-WINS under DOUBLE failure (NIT-1).
 *
 * WHY THIS EXISTS. The merged fail-open fix (9305a39a) establishes an exactly-one invariant:
 * a neighbourhood books EXACTLY ONE ledger row, whatever fails inside it. The follow-on branch
 * removed the unreachable catch in beliefAdjudicator and replaced it with bookPairingFailure,
 * whose first-failure-wins guard is the `&& !pairingFailure` at the clock-read site.
 *
 * Reviewer measured that guard as UNGUARDED: deleting `&& !pairingFailure` leaves the entire
 * shipped belief suite GREEN (9/9) while the invariant is broken — two rows for one
 * neighbourhood. The product code was correct; nothing asserted it, so the next author to touch
 * that line gets no signal. This is the C3 class: a guard is a product, and only a mutation
 * proves it. Verdict 1da12a18.
 *
 * WHAT IT PROVES, against a REAL migrated Postgres and the REAL shipped path:
 *   Both the candidate query AND the clock read throw. Then:
 *     - EXACTLY ONE attempt row exists for the neighbourhood (not two),
 *     - it is outcome='failed',
 *     - it carries the FIRST failure (the candidate query), not the later clock read,
 *     - no throw crosses the adjudicateNeighbourhood boundary (results === []).
 *
 * MUTATION THAT MUST TURN THIS RED (re-run it if you touch bookPairingFailure):
 *   beliefAdjudicator.ts — `if (!clock.ok && !pairingFailure)` -> `if (!clock.ok)`
 *   Expected: "expected 2 to be 1".
 *
 * Self-cleaning: it creates its own project and deletes its rows in afterAll.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { adjudicateNeighbourhood } from '../services/belief/beliefAdjudicator.js';
import type { AdjudicationProvider, AdjudicatorVerdict } from '../services/belief/types.js';
import { embedDim } from './helpers/embedGeometry.js';

class StubProvider implements AdjudicationProvider {
  readonly name = 'first-failure-wins-stub';
  readonly model = 'probe-1';
  async adjudicate(): Promise<AdjudicatorVerdict> {
    return { sameSubject: false, subject: 'p', verdict: 'unrelated', direction: 'none', mode: 'none', confidence: 0, rationale: 'p' };
  }
}

describe('belief pairing — first-failure-wins when BOTH the candidate query and the clock read fail', () => {
  let projectId: string;
  beforeAll(async () => {
    projectId = (await db.query(`INSERT INTO projects (name, description) VALUES ('a2a4fbbd-first-failure-wins','') RETURNING id`)).rows[0].id;
  });
  afterAll(async () => {
    await db.query('DELETE FROM belief_adjudication_attempts WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  test('exactly ONE row, and no throw crosses the boundary', async () => {
    const sourceId = '88888888-8888-4888-8888-888888888888';
    const counters = { clock: 0, cand: 0 };
    const seen: string[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        seen.push(String(sql).slice(0,60).replace(/\s+/g,' '));
        if (typeof sql === 'string' && sql.includes('AS kind')) {
          return { rows: [{ embedding: `[${new Array(embedDim()).fill(0.01).join(',')}]`, kind: null, content: 'x' }] };
        }
        if (typeof sql === 'string' && sql.includes('AS cosine')) { counters.cand += 1; throw new Error('PROBE_CAND_FAIL'); }
        if (typeof sql === 'string' && sql.includes('AS created_at')) { counters.clock += 1; throw new Error('PROBE_CLOCK_FAIL'); }
        return db.query(sql, params as never);
      },
    } as unknown as typeof db;

    const results = await adjudicateNeighbourhood(
      { id: sourceId, type: 'context', projectId, content: 'x' }, { provider: new StubProvider() }, pool
    );
    expect(results).toEqual([]);
    expect(counters.cand).toBeGreaterThan(0);
    expect(counters.clock).toBe(1);

    const rows = (await db.query(
      `SELECT outcome, failed_stage, error_message FROM belief_adjudication_attempts WHERE project_id=$1 AND source_id=$2`,
      [projectId, sourceId])).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('failed');
    // FIRST failure wins => the candidate query, not the clock.
    expect(rows[0].error_message).toContain('PROBE_CAND_FAIL');
  });
});
