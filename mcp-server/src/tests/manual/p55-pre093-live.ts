/**
 * PROOF 3, THE STRONGER MEASUREMENT — the shipped reader run against a REAL DATABASE that
 * has never had migration 093 applied.
 *
 * `blockedOnAbsentColumn.contract.test.ts` is the in-CI guard, and it fabricates a schema
 * because the clean gate points a suite at exactly one database. This script is the run that
 * uses a genuinely pre-093 DATABASE — provisioned by scripts/provision-test-db.sh at
 * migration 092 and never migrated further — so nothing about the subject is fabricated.
 *
 * It is NOT a test and NOT on the gate's execution path. It is the instrument that produced
 * the artifact in reports/artifacts/p5-5-blocked-on/. Kept in-tree so the measurement is
 * repeatable rather than a pasted transcript.
 *
 * RUN (against a DB provisioned at 092 and NOT re-migrated):
 *   DATABASE_NAME=<pre093-db> DATABASE_USER=… DATABASE_PASSWORD=… \
 *     npx tsx src/tests/manual/p55-pre093-live.ts
 */
import { Pool } from 'pg';
import { gatherWaitingOnHuman } from '../../services/waitingOnHuman.js';
import {
  readTaskBlockedOnCapability,
  assertBlockedOnWritable,
} from '../../services/taskBlockedOnCapability.js';

const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  max: 2,
});

function ok(label: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log(`database: ${process.env.DATABASE_NAME}`);

  // ── THE CONTROL FIRST. Before any FAIL below can be trusted, show the subject is what
  //    it claims to be: a real `tasks` table, genuinely without the two columns.
  const cols = (
    await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tasks'`,
    )
  ).rows.map((r: any) => r.column_name);
  ok('the tasks table exists (control — the probe is looking at a real table)', cols.includes('title'));
  ok('blocked_on is genuinely ABSENT', !cols.includes('blocked_on'));
  ok('due_at is genuinely ABSENT', !cols.includes('due_at'));
  console.log(`  tasks columns: ${cols.length} (blocked_on/due_at not among them)`);

  const cap = await readTaskBlockedOnCapability(pool);
  console.log(`  capability: ${JSON.stringify(cap)}`);
  ok("the probe says 'absent', not 'unknown'", cap.blockedOn === 'absent' && cap.probeError === null);

  // A project with a blocked task, so the fallback has something to serve.
  const projectId = (
    await pool.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'p55 pre093 live') RETURNING id`,
      [`p55-pre093-${Date.now()}`],
    )
  ).rows[0].id;
  try {
    await pool.query(
      `INSERT INTO tasks (project_id, title, status, tags)
       VALUES ($1, 'pre093 blocked task', 'blocked', ARRAY['needs-operator','needs:operator'])`,
      [projectId],
    );

    const w = await gatherWaitingOnHuman(projectId, ['todo', 'in_progress', 'blocked'], pool);
    console.log(`  source: ${w.source}`);
    console.log(`  served: ${w.items.length} (${w.items.map((t) => t.title).join(', ')})`);
    console.log(`  precision: ${JSON.stringify(w.precision)}`);
    console.log(`  findings: ${JSON.stringify(w.findings)}`);

    ok('the gather did NOT throw 42703 on a pre-093 database', true);
    ok("it degraded to source='fallback-absent-column'", w.source === 'fallback-absent-column');
    ok('it still SERVES the blocked row rather than rendering nothing', w.items.length === 1);
    ok('no row claims a blocked_on it cannot have', w.items.every((t) => t.blockedOn === null));
    ok('precision is null — it is not computable here and nothing was invented', w.precision === null);
    ok(
      'the tag-collision finding still ran (the WHOLE gather survives, not just query one)',
      w.findings.collisionGroupsTotal === 1,
    );

    let refused = false;
    try {
      await assertBlockedOnWritable(pool, { blockedOn: 'human' }, 'task_create');
    } catch (e) {
      refused = true;
      console.log(`  write refusal: ${(e as Error).message.slice(0, 160)}…`);
    }
    ok('a WRITE supplying blocked_on REFUSES rather than silently dropping it', refused);

    let allowed = true;
    try {
      await assertBlockedOnWritable(pool, {}, 'task_create');
    } catch {
      allowed = false;
    }
    ok('CONTROL — a write supplying NEITHER field is untouched by the gate', allowed);
  } finally {
    await pool.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('FAIL  the script itself threw:', e);
  process.exit(1);
});
