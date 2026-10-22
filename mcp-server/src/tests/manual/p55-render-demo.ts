/**
 * WHAT THE SECTION ACTUALLY LOOKS LIKE — the rendered output for each of the states P5.5
 * distinguishes, printed side by side so the honesty labelling can be READ rather than
 * inferred from assertions.
 *
 * Not a test. The instrument that produced reports/artifacts/p5-5-blocked-on/render-demo.txt.
 *
 * RUN: DATABASE_NAME=… npx tsx src/tests/manual/p55-render-demo.ts
 */
import { Pool } from 'pg';
import {
  renderBriefing,
  briefingConfig,
  EMPTY_CENSUS,
  type BriefingData,
} from '../../services/projectBriefing.js';
import { gatherWaitingOnHuman } from '../../services/waitingOnHuman.js';

const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  max: 2,
});

const OPEN = ['todo', 'in_progress', 'blocked'];
const NAME = `p55-render-demo-${Date.now()}`;

/** The minimum BriefingData the renderer needs, with only the waiting section populated. */
function shell(projectId: string, waiting: BriefingData['waiting']): BriefingData {
  return {
    projectId,
    projectName: NAME,
    handoffHead: { status: 'absent', headId: null, candidates: [], walks: [], concurringSeeds: [], refusal: null } as any,
    handoff: null,
    tasks: [], decisions: [], conventions: [], deadEnds: [], branch: null,
    waiting,
    census: {
      tasks: EMPTY_CENSUS, decisions: EMPTY_CENSUS, conventions: EMPTY_CENSUS,
      deadEnds: EMPTY_CENSUS, branchMembers: EMPTY_CENSUS,
    },
  };
}

/** Just the "Waiting on a human" section of a render. */
function section(md: string): string {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => l.startsWith('## Waiting on a human'));
  if (i < 0) return '(the section did not render)';
  const rest = lines.slice(i + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return [lines[i], ...(end < 0 ? rest : rest.slice(0, end))].join('\n').trimEnd();
}

async function show(label: string, projectId: string): Promise<void> {
  const waiting = await gatherWaitingOnHuman(projectId, OPEN, pool);
  console.log('\n' + '═'.repeat(78));
  console.log(`${label}   [source: ${waiting.source}]`);
  console.log('═'.repeat(78));
  console.log(section(renderBriefing(shell(projectId, waiting), briefingConfig()).markdown));
}

async function main(): Promise<void> {
  const proj = (
    await pool.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [NAME])
  ).rows[0].id;
  const empty = (
    await pool.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [`${NAME}-empty`])
  ).rows[0].id;
  try {
    await pool.query(
      `INSERT INTO tasks (project_id, title, status, blocked_on, due_at, tags) VALUES
        ($1, 'Approve the CN1 fleet roll',            'todo',        'human', '2030-01-15Z', ARRAY['needs-operator']),
        ($1, 'Sign off the pricing page copy',        'todo',        'human', '2030-12-01Z', ARRAY['needs:operator']),
        ($1, 'Decide: keep or retire /srv/app',   'in_progress', 'human', NULL,          ARRAY['decision-needed']),
        ($1, 'Review the 2031-03-04 launch draft',    'todo',        'human', NULL,          ARRAY['decision-gate']),
        ($1, 'Re-embed the stale task vectors',       'todo',        'agent', NULL,          ARRAY['scope:product']),
        ($1, 'Waiting on the upstream CVE patch',     'blocked',     NULL,    NULL,          ARRAY['scope:infra'])`,
      [proj],
    );
    await pool.query(
      `INSERT INTO tasks (project_id, title, status) VALUES
        ($1, 'Blocked on another task, not a person', 'blocked'),
        ($1, 'Ordinary open work', 'todo')`,
      [empty],
    );

    await show('A. THE COLUMN IS POPULATED — exact selection, no convention', proj);
    await show('B. 093 APPLIED BUT UNPOPULATED — the labelled interim fallback', empty);
  } finally {
    for (const id of [proj, empty]) {
      await pool.query('DELETE FROM tasks WHERE project_id = $1', [id]);
      await pool.query('DELETE FROM projects WHERE id = $1', [id]);
    }
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
