/**
 * TreeWalker DEMO SEED — writes ONE branch into the local dev database so the Story view can
 * be opened for real. Mirrors the committed frontend fixture
 * `mandrel-command/frontend/src/pages/treewalker/demoBranch.fixture.ts`; keep the two in step.
 * (A TypeScript script, not a .sql file: the repo .gitignore ignores every *.sql.)
 *
 * The branch (spine = a planning context) covers three days — Oct 24 / 26 / 28 2026:
 *   a decision with three decided_by tasks (one open), four consecutive reflections, an error,
 *   a milestone, and a ghost cause (a decision OUTSIDE the branch the work leans on).
 * It also plants a guessed `related_to` (mint_via inference) neighbour that is NOT a member and
 * whose edge is not declared — the thread API must not serve it, so the page shows no beat.
 *
 * Idempotent: re-running deletes the demo project (cascade) and re-creates it.
 *
 *   cd mandrel-command/backend && npx tsx scripts/seed-treewalker-demo.ts
 * Connection: DATABASE_USER / _HOST / _NAME / _PASSWORD / _PORT, as the DB test suites use.
 * Then open TreeWalker on the project named by DEMO_PROJECT_NAME, branch label below.
 */
import { Pool } from 'pg';

export const DEMO_PROJECT_NAME = 'treewalker-demo';
export const DEMO_BRANCH_LABEL = 'oss-branch';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
export const SEED_IDS = {
  project: id(0x9),
  spine: id(0xa0),
  decision: id(0xd1),
  taskDone1: id(0xe1),
  taskDone2: id(0xe2),
  taskOpen: id(0xe3),
  milestone: id(0xb1),
  error: id(0xc1),
  ghost: id(0xf1),
  related: id(0xf2),
} as const;

type Ctx = { id: string; type: string; title: string; at: string };
const CONTEXTS: Ctx[] = [
  { id: SEED_IDS.spine, type: 'planning', title: 'Move the product tree to the OSS branch', at: '2026-10-24T15:00:00Z' },
  { id: id(0x11), type: 'note', title: 'Inventory of prod-only files', at: '2026-10-24T18:00:00Z' },
  { id: id(0x21), type: 'reflections', title: 'Second opinion: licence headers', at: '2026-10-26T14:00:00Z' },
  { id: id(0x22), type: 'reflections', title: 'Second opinion: telemetry defaults', at: '2026-10-26T14:30:00Z' },
  { id: id(0x23), type: 'reflections', title: 'Second opinion: migration order', at: '2026-10-26T15:00:00Z' },
  { id: id(0x24), type: 'reflections', title: 'Second opinion: rollback plan', at: '2026-10-26T15:30:00Z' },
  { id: SEED_IDS.error, type: 'error', title: 'Release build leaked a tenant hostname', at: '2026-10-26T18:00:00Z' },
  { id: SEED_IDS.milestone, type: 'milestone', title: 'v0.70.0 shipped to the OSS branch', at: '2026-10-28T15:00:00Z' },
  { id: id(0x31), type: 'note', title: 'Post-release smoke notes', at: '2026-10-28T16:00:00Z' },
];
const TASKS = [
  { id: SEED_IDS.taskDone1, title: 'Strip tenant branding from the bundle', status: 'completed', at: '2026-10-24T17:00:00Z' },
  { id: SEED_IDS.taskDone2, title: 'Cut the OSS release workflow', status: 'completed', at: '2026-10-26T13:00:00Z' },
  { id: SEED_IDS.taskOpen, title: 'Publish the install docs', status: 'in_progress', at: '2026-10-26T13:30:00Z' },
];

export async function seedTreewalkerDemo(pool: Pool): Promise<void> {
  const S = SEED_IDS;
  await pool.query(`DELETE FROM projects WHERE id = $1 OR name = $2`, [S.project, DEMO_PROJECT_NAME]);
  await pool.query(
    `INSERT INTO projects (id, name, description, status, created_at)
     VALUES ($1,$2,'TreeWalker Story demo seed','active',NOW())`,
    [S.project, DEMO_PROJECT_NAME],
  );

  const addContext = (c: Ctx, tags: string[]) =>
    pool.query(
      `INSERT INTO contexts (id, project_id, context_type, content, tags, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [c.id, S.project, c.type, c.title, tags, c.at],
    );
  for (const c of CONTEXTS) await addContext(c, c.id === S.spine ? [`branch:${DEMO_BRANCH_LABEL}`] : []);
  await addContext({ id: S.related, type: 'note', title: 'Guessed neighbour (must not appear)', at: '2026-10-27T12:00:00Z' }, []);

  for (const t of TASKS) {
    await pool.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags, created_at)
       VALUES ($1,$2,$3,'demo','general',$4,'medium',$5,$6)`,
      [t.id, S.project, t.title, t.status, [`branch:${DEMO_BRANCH_LABEL}`], t.at],
    );
  }
  const decision = (did: string, title: string, at: string) =>
    pool.query(
      `INSERT INTO technical_decisions
         (id, project_id, decision_type, title, description, rationale, impact_level, status, outcome_status, decision_date, metadata)
       VALUES ($1,$2,'architecture',$3,'demo','demo','high','active','successful',$4,'{}')`,
      [did, S.project, title, at],
    );
  await decision(S.decision, 'LOCK: ship OSS from the prod tree', '2026-10-24T16:00:00Z');
  await decision(S.ghost, 'Earlier: keep one repo for prod and OSS', '2026-10-01T12:00:00Z');

  // MEMBERSHIP: every branch record except the spine itself, ghost and neighbour.
  const members: Array<[string, 'context' | 'decision' | 'task', string]> = [
    ...CONTEXTS.filter((c) => c.id !== S.spine).map((c): [string, 'context', string] => [c.id, 'context', c.at]),
    ...TASKS.map((t): [string, 'task', string] => [t.id, 'task', t.at]),
    [S.decision, 'decision', '2026-10-24T16:00:00Z'],
  ];
  for (const [rid, rtype, at] of members) {
    await pool.query(
      `INSERT INTO branch_memberships
         (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type, source, project_id, created_at)
       VALUES ($1,$2,$3,'context',$3,'context','recorded',$4,$5)`,
      [rid, rtype, S.spine, S.project, at],
    );
  }

  const link = (from: string, fromType: string, to: string, toType: string, edge: string, via: string) =>
    pool.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
       VALUES ($1,$2,$3,$4,$5,$6,'link',$7)`,
      [from, fromType, to, toType, edge, S.project, via],
    );
  for (const t of TASKS) await link(t.id, 'task', S.decision, 'decision', 'decided_by', 'tag');
  await link(S.decision, 'decision', S.spine, 'context', 'informs', 'tag');
  await link(id(0x11), 'context', S.ghost, 'decision', 'decided_by', 'tag');
  await link(S.related, 'context', S.spine, 'context', 'related_to', 'inference');
}

async function main(): Promise<void> {
  const pool = new Pool({
    user: process.env.DATABASE_USER || 'mandrel',
    host: process.env.DATABASE_HOST || 'localhost',
    database: process.env.DATABASE_NAME || 'mandrel',
    password: process.env.DATABASE_PASSWORD || '',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
  });
  try {
    await seedTreewalkerDemo(pool);
    console.log(`seeded project "${DEMO_PROJECT_NAME}" — branch spine ${SEED_IDS.spine} (${DEMO_BRANCH_LABEL})`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
