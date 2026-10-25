/**
 * REPAIR — `links` rows whose `to_type='decision'` names an id that is NOT a decision.
 * (forward fix for the minting path shipped in 130f00d.)
 *
 * ═══ WHAT WENT WRONG ═══
 * Before the resolveMintEndpoint guard, autoMintFromDecision's evidence fallback
 * (decision → context) was DEAD CODE for full UUIDs: resolveRefSafe returned any full UUID
 * unconditionally, so `to_type` was ALWAYS 'decision' and the context branch was
 * unreachable. Evidence that actually pointed at a CONTEXT was minted with
 * to_type:decision, and evidence pointing at NOTHING was minted at all. The forward fix
 * stops new ones; this script is for the rows that already exist.
 *
 * ═══ THE POPULATION AND WHAT HAPPENS TO EACH MEMBER ═══
 *   links WHERE to_type='decision' AND to_id NOT IN technical_decisions, classified:
 *     RETYPE          to_id is a context in the SAME project (or the edge has no project)
 *                     -> UPDATE to_type='context', metadata gets a `repair` stamp.
 *     DELETE          to_id resolves to nothing -> DELETE, the full row is written to the
 *                     undo manifest.
 *     CROSS_PROJECT   to_id is a context in a DIFFERENT project -> reported, NOT touched. A
 *                     cross-project edge is the other thing the dead fallback let through
 *                     and re-typing it would legitimise it; that is a human call.
 *     RESOLVES_TO_TASK to_id is a task -> reported, NOT touched. Not the shape this task
 *                     names; a human decides whether that edge means anything.
 *
 * ═══ SAFETY — the same discipline as scripts/backfill-task-edges.ts ═══
 *   * DRY RUN IS THE DEFAULT, and it is the REAL statements inside a transaction that is
 *     rolled back — not a second estimating implementation. Dry-run counts == apply counts
 *     by construction.
 *   * --apply additionally requires --i-mean-it and a --manifest path. The manifest is the
 *     undo for the DELETE half (a deleted row has no provenance stamp to key on), so an
 *     apply that cannot write it refuses before touching anything.
 *   * PROVENANCE. A re-typed row keeps its created_by (changing it would lie about who
 *     minted the edge — the same reason graphBackfill writes `metadata.provenance` and
 *     not created_by) and gets `metadata.repair = { script, task, at, from_to_type }`.
 *     The undo's re-type half is ONE statement scoped on exactly that key, mirroring the
 *     task-edge backfill's created_by-scoped undo.
 *   * --undo --manifest <path>: re-types every row carrying this script's `repair` stamp
 *     back to 'decision' and strips the stamp, then re-inserts every deleted row from the
 *     manifest (ON CONFLICT DO NOTHING). Also dry-run by default.
 *
 * USAGE
 *   npx tsx scripts/repair-mistyped-decision-edges.ts                          # DRY RUN
 *   npx tsx scripts/repair-mistyped-decision-edges.ts --project <uuid>         # DRY RUN, one project
 *   npx tsx scripts/repair-mistyped-decision-edges.ts --apply --i-mean-it --manifest <path>
 *   npx tsx scripts/repair-mistyped-decision-edges.ts --undo --manifest <path>              # DRY RUN of the undo
 *   npx tsx scripts/repair-mistyped-decision-edges.ts --undo --manifest <path> --apply --i-mean-it
 *
 * MEASURED ON PROD 2026-09-08 (read-only): the population is EMPTY — 0 of 1010 to_type=
 * 'decision' rows fail to resolve. The script exists so the class has a scripted, tested
 * answer on every instance, not because prod needs it today.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';

/** The provenance stamp key and value. The undo is scoped on EXACTLY these. */
export const REPAIR_SCRIPT_ID = 'repair-mistyped-decision-edges';
export const REPAIR_TASK_ID = '642ef00d';

export type Classification = 'RETYPE' | 'DELETE' | 'CROSS_PROJECT' | 'RESOLVES_TO_TASK';

export interface PopulationRow {
  id: string;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  edge_type: string;
  project_id: string | null;
  created_at: string;
  created_by: string | null;
  mint_via: string;
  metadata: Record<string, unknown>;
  classification: Classification;
}

export interface RepairSummary {
  dryRun: boolean;
  population: number;
  retyped: number;
  deleted: number;
  crossProject: number;
  resolvesToTask: number;
  rows: PopulationRow[];
}

export interface UndoManifest {
  script: typeof REPAIR_SCRIPT_ID;
  task: typeof REPAIR_TASK_ID;
  appliedAt: string;
  projectId: string | null;
  retypedIds: string[];
  deletedRows: Omit<PopulationRow, 'classification'>[];
}

/**
 * The population, classified in SQL so the classification is one query and not a loop of
 * per-row lookups that could disagree with each other.
 */
export const POPULATION_SQL = `
  SELECT l.id, l.from_id, l.from_type, l.to_id, l.to_type, l.edge_type, l.project_id,
         l.created_at, l.created_by, l.mint_via, l.metadata,
         CASE
           WHEN c.id IS NOT NULL AND (l.project_id IS NULL OR c.project_id = l.project_id) THEN 'RETYPE'
           WHEN c.id IS NOT NULL THEN 'CROSS_PROJECT'
           WHEN t.id IS NOT NULL THEN 'RESOLVES_TO_TASK'
           ELSE 'DELETE'
         END AS classification
    FROM links l
    LEFT JOIN contexts c ON c.id = l.to_id
    LEFT JOIN tasks    t ON t.id = l.to_id
   WHERE l.to_type = 'decision'
     AND NOT EXISTS (SELECT 1 FROM technical_decisions d WHERE d.id = l.to_id)
     AND ($1::uuid IS NULL OR l.project_id = $1::uuid)
   ORDER BY l.created_at, l.id`;

export async function loadPopulation(
  q: Pool | PoolClient,
  projectId: string | null,
): Promise<PopulationRow[]> {
  const r = await q.query(POPULATION_SQL, [projectId]);
  return r.rows as PopulationRow[];
}

/**
 * Run the repair. Dry run (the default) executes the real statements and rolls back.
 * The manifest is returned rather than written here so the CLI owns the file and the test
 * can inspect it without a filesystem round-trip.
 */
export async function runRepair(
  pool: Pool,
  opts: { apply?: boolean; projectId?: string | null },
): Promise<{ summary: RepairSummary; manifest: UndoManifest }> {
  const apply = opts.apply === true;
  const projectId = opts.projectId ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await loadPopulation(client, projectId);
    const retype = rows.filter((r) => r.classification === 'RETYPE');
    const del = rows.filter((r) => r.classification === 'DELETE');
    const appliedAt = new Date().toISOString();

    let retyped = 0;
    if (retype.length > 0) {
      const stamp = {
        repair: { script: REPAIR_SCRIPT_ID, task: REPAIR_TASK_ID, at: appliedAt, from_to_type: 'decision' },
      };
      const r = await client.query(
        `UPDATE links
            SET to_type = 'context',
                metadata = metadata || $2::jsonb
          WHERE id = ANY($1::uuid[])
            AND to_type = 'decision'`,
        [retype.map((x) => x.id), JSON.stringify(stamp)],
      );
      retyped = r.rowCount ?? 0;
    }

    let deleted = 0;
    if (del.length > 0) {
      const r = await client.query(`DELETE FROM links WHERE id = ANY($1::uuid[])`, [
        del.map((x) => x.id),
      ]);
      deleted = r.rowCount ?? 0;
    }

    // Both halves must have acted on exactly the rows the population named. A mismatch
    // means the table moved under us; refuse rather than report a count that is not true.
    if (retyped !== retype.length || deleted !== del.length) {
      throw new Error(
        `population moved during the run: planned retype=${retype.length}/delete=${del.length}, ` +
          `executed retype=${retyped}/delete=${deleted}. Rolled back; re-run.`,
      );
    }

    await client.query(apply ? 'COMMIT' : 'ROLLBACK');

    const manifest: UndoManifest = {
      script: REPAIR_SCRIPT_ID,
      task: REPAIR_TASK_ID,
      appliedAt,
      projectId,
      retypedIds: retype.map((x) => x.id),
      deletedRows: del.map(({ classification: _c, ...row }) => row),
    };
    const summary: RepairSummary = {
      dryRun: !apply,
      population: rows.length,
      retyped,
      deleted,
      crossProject: rows.filter((r) => r.classification === 'CROSS_PROJECT').length,
      resolvesToTask: rows.filter((r) => r.classification === 'RESOLVES_TO_TASK').length,
      rows,
    };
    return { summary, manifest };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * THE UNDO. Re-type half is provenance-scoped on `metadata.repair.script`; delete half is
 * re-inserted from the manifest. Dry run by default, same rollback mechanism.
 */
export async function undoRepair(
  pool: Pool,
  manifest: UndoManifest,
  opts: { apply?: boolean },
): Promise<{ dryRun: boolean; restoredType: number; reinserted: number }> {
  if (manifest.script !== REPAIR_SCRIPT_ID) {
    throw new Error(`manifest was written by '${manifest.script}', not '${REPAIR_SCRIPT_ID}'`);
  }
  const apply = opts.apply === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r1 = await client.query(
      `UPDATE links
          SET to_type = metadata #>> '{repair,from_to_type}',
              metadata = metadata - 'repair'
        WHERE metadata #>> '{repair,script}' = $1
          AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
      [REPAIR_SCRIPT_ID, manifest.projectId],
    );
    let reinserted = 0;
    for (const row of manifest.deletedRows) {
      const r2 = await client.query(
        `INSERT INTO links (id, from_id, from_type, to_id, to_type, edge_type, project_id,
                            created_at, created_by, mint_via, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (from_id, to_id, edge_type) DO NOTHING`,
        [
          row.id, row.from_id, row.from_type, row.to_id, row.to_type, row.edge_type,
          row.project_id, row.created_at, row.created_by, row.mint_via,
          JSON.stringify(row.metadata ?? {}),
        ],
      );
      reinserted += r2.rowCount ?? 0;
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { dryRun: !apply, restoredType: r1.rowCount ?? 0, reinserted };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export function formatSummary(s: RepairSummary): string {
  const head = s.dryRun ? 'DRY RUN (rolled back — nothing written)' : 'APPLIED';
  const lines = [
    `${head}: ${s.population} link(s) with to_type='decision' whose to_id is not a decision.`,
    `   RETYPE -> context (same project) : ${s.retyped}`,
    `   DELETE (resolves to nothing)      : ${s.deleted}`,
    `   CROSS_PROJECT context — untouched : ${s.crossProject}`,
    `   RESOLVES_TO_TASK — untouched      : ${s.resolvesToTask}`,
  ];
  for (const r of s.rows) {
    lines.push(
      `   ${r.classification.padEnd(16)} ${r.id} ${r.from_type}:${r.from_id.slice(0, 8)} -${r.edge_type}-> ` +
        `${r.to_id.slice(0, 8)} project=${r.project_id ?? 'NULL'} created_by=${r.created_by ?? 'NULL'}`,
    );
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const apply = flag('apply');
  const confirmed = flag('i-mean-it');
  const undo = flag('undo');
  const projectId = arg('project') ?? null;
  const manifestPath = arg('manifest');

  if (apply && !confirmed) {
    console.error(
      '❌ REFUSING to write.\n\n' +
        '   --apply also requires --i-mean-it. This script re-types and deletes edges in the\n' +
        '   live graph. Run without --apply first and read the dry-run report.\n',
    );
    process.exit(2);
  }
  if (apply && !undo && !manifestPath) {
    console.error(
      '❌ REFUSING to write.\n\n' +
        '   --apply requires --manifest <path>: the manifest is the ONLY undo for deleted rows.\n',
    );
    process.exit(2);
  }
  if (undo && !manifestPath) {
    console.error('❌ --undo requires --manifest <path> (the file the apply wrote).');
    process.exit(2);
  }

  const { db } = await import('../src/config/database.js');
  try {
    if (undo) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath!, 'utf8')) as UndoManifest;
      const res = await undoRepair(db, manifest, { apply });
      console.log(
        `${res.dryRun ? '🔍 UNDO DRY RUN' : '✅ UNDO APPLIED'}: ${res.restoredType} row(s) ` +
          `re-typed back to decision (scoped on metadata.repair.script='${REPAIR_SCRIPT_ID}'), ` +
          `${res.reinserted} deleted row(s) re-inserted from ${manifestPath}.` +
          (res.dryRun ? '\n   Re-run with --apply --i-mean-it to write.' : ''),
      );
      return;
    }

    const { summary, manifest } = await runRepair(db, { apply, projectId });
    console.log(formatSummary(summary));
    if (apply) {
      fs.mkdirSync(path.dirname(path.resolve(manifestPath!)), { recursive: true });
      fs.writeFileSync(manifestPath!, JSON.stringify(manifest, null, 2));
      console.log(`\n   UNDO MANIFEST written: ${manifestPath}`);
    } else {
      console.log('\n   Re-run with --apply --i-mean-it --manifest <path> to write these changes.');
    }
  } finally {
    await db.end();
  }
}

// Run main() only when executed directly, so the exports stay importable.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error('❌ repair failed:', e);
    process.exit(1);
  });
}
