/**
 * THE ASSISTED BACKFILL REPORT — P5.5 (SCOPE §8.6).
 *
 * ⚠️ THIS WRITES NOTHING. It is a REPORT, deliberately, and that is the design decision, not
 * a limitation of the script.
 *
 * ═══ WHY NOT AUTO-BACKFILL ═══
 * The obvious move is `UPDATE tasks SET blocked_on='human' WHERE 'needs-operator' = ANY(tags)`.
 * We are not doing that. A tag is a LABEL somebody attached; `blocked_on` is a CLAIM ABOUT
 * THE WORLD that the briefing then acts on. Deriving the second from the first writes a
 * GUESS ABOUT INTENT into a schema field, where it becomes indistinguishable from a value a
 * human actually set — and the whole point of the column is that it is a fact rather than an
 * inference. Once written, nothing downstream can tell the two apart, ever.
 *
 * It is also unnecessary. The section already degrades honestly without a backfill: it falls
 * back to `status='blocked'` and SAYS SO. A wrong backfill would be worse than the fallback,
 * because the fallback is labelled and a backfill is not.
 *
 * ═══ WHAT THIS IS FOR ═══
 * It prints the candidate rows and what a backfill WOULD set, so a human can look at them
 * and decide. The generated UPDATE statements are printed as text for a person to read,
 * edit and run — never executed here.
 *
 * ═══ THE HEURISTIC, AND ITS HONEST LIMIT ═══
 * A candidate is an open task whose tag set contains a tag that FOLDS (separator-insensitive)
 * to one of the keys named in `--keys`. There is NO built-in vocabulary: `needs-operator` is
 * OURS and must not become a product default (SCOPE §4), so the caller supplies the keys.
 * The fold is the same one the briefing's collision finding uses, so `needs-operator` and
 * `needs:operator` are one key here — which is the point, since that split is exactly why a
 * hand-written backfill query would have found half the rows.
 *
 * RUN:
 *   DATABASE_NAME=… npx tsx src/tests/manual/p55-backfill-report.ts \
 *     --project <id-or-name> --keys needs-operator,decision-needed
 */
import { Pool } from 'pg';
import { tagSpellingKey } from '../../services/waitingOnHuman.js';
import { BLOCKED_ON_HUMAN } from '../../config/blockedOnConfig.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const projectRef = arg('project');
const keys = (arg('keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean).map(tagSpellingKey);

if (!projectRef || keys.length === 0) {
  console.error('usage: --project <id-or-name> --keys <tag,tag,...>');
  console.error('  there is NO default key list on purpose: a candidate vocabulary is the');
  console.error('  caller\'s, not the product\'s (SCOPE §4).');
  process.exit(2);
}

const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  max: 2,
});

async function main(): Promise<void> {
  const proj = (
    await pool.query(
      `SELECT id, name FROM projects WHERE id::text = $1 OR name = $1`,
      [projectRef],
    )
  ).rows[0];
  if (!proj) {
    console.error(`no such project: ${projectRef}`);
    process.exit(2);
  }

  const { rows } = await pool.query(
    `SELECT id, title, status, tags, blocked_on
       FROM tasks
      WHERE project_id = $1 AND archived_at IS NULL
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY created_at DESC`,
    [proj.id],
  );

  const candidates = rows.filter((r: any) =>
    (r.tags ?? []).some((t: string) => keys.includes(tagSpellingKey(t))),
  );

  console.log(`# P5.5 assisted-backfill REPORT — nothing was written`);
  console.log(`project      : ${proj.name} (${proj.id})`);
  console.log(`folded keys  : ${keys.join(', ')}`);
  console.log(`open tasks   : ${rows.length}`);
  console.log(`candidates   : ${candidates.length}`);
  console.log(
    `already set  : ${rows.filter((r: any) => r.blocked_on !== null).length} ` +
      `(a task that already carries a value is NOT re-derived — a human's answer outranks a guess)`,
  );
  console.log();

  if (candidates.length === 0) {
    console.log('No candidates. Nothing to approve.');
    return;
  }

  console.log('## Candidates — WHAT a backfill WOULD set, and the tag it inferred it FROM');
  for (const r of candidates) {
    const matched = (r.tags ?? []).filter((t: string) => keys.includes(tagSpellingKey(t)));
    const already = r.blocked_on !== null ? `  ⚠️ ALREADY blocked_on='${r.blocked_on}' — SKIP` : '';
    console.log(
      `- ${String(r.id).slice(0, 8)}  [status:${r.status}]  ${r.title}\n` +
        `    would set blocked_on='${BLOCKED_ON_HUMAN}'  inferred from tag(s): ${matched.join(', ')}${already}`,
    );
  }

  console.log();
  console.log('## The statements — FOR A HUMAN TO READ, EDIT AND RUN. Not executed here.');
  console.log('-- Review every line. A tag is a label; blocked_on is a claim the briefing acts on.');
  for (const r of candidates) {
    if (r.blocked_on !== null) continue;
    console.log(`UPDATE tasks SET blocked_on = '${BLOCKED_ON_HUMAN}' WHERE id = '${r.id}'; -- ${r.title}`);
  }
}

main()
  .catch((e) => {
    console.error('report failed:', e);
    process.exit(1);
  })
  .finally(() => pool.end());
