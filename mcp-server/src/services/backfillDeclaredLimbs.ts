/**
 * BACKFILL DECLARED LIMBS — materialise `declared_limbs` for records that already exist.
 * BRANCH-1 (an earlier decision Phase 1).
 *
 * WHY THIS IS PART OF THE SAME CHANGE, NOT A FOLLOW-UP
 * The precision this build rests on (P 0.756) was measured on EXISTING records. A
 * write-time-only hook leaves every record written before today with no limbs — which
 * makes every one of them unassignable, therefore terminal under Phase 2, therefore
 * branches collapse toward depth-1 on the day the flag goes on. The measured number would
 * be unreachable and nobody would be able to tell why.
 *
 * IDENTICAL MAPPING TO THE WRITE PATH — the same discipline backfillTypedEdges.ts states
 * and for the same reason: this file contains NO derivation logic. It selects rows, calls
 * the same `composeLimbBody` + `deriveDeclaredLimbs` the handlers call, and writes the
 * result. A backfilled row is therefore byte-identical to the same row written today.
 * The only difference is the RESOLVER: the write path loads the handful of id8s one record
 * names, while the backfill loads the whole node table ONCE (~14k rows) and resolves in
 * memory — 10,000 records × 3 index lookups is the wrong shape for a batch job. Both go
 * through `buildId8Resolver`, so the ambiguity rule cannot differ between them.
 *
 * RE-RUNNABLE AND IDEMPOTENT: it recomputes from each record's CURRENT tags and prose and
 * overwrites. Running it twice produces the same values; running it after an edit corrects
 * the row. `--only-missing` restricts it to rows that have never been derived (NULL).
 */

import type { Pool } from 'pg';
import { db, initializeDatabase } from '../config/database.js';
import { DECLARED_LIMBS_CONFIG, LIMB_TAG_PATTERN } from '../config/declaredLimbsConfig.js';
import {
  buildId8Resolver,
  collectNamedId8s,
  composeLimbBody,
  deriveDeclaredLimbs,
  type Id8Resolver,
  type LimbResolvableType,
} from './declaredLimbs.js';

/**
 * The census the decision pre-registered, per record kind. It is what acceptance is judged
 * on and it is the ADOPTION instrument: the split between "the writer tagged it" and "the
 * writer only named an id in prose" is the measurement that killed the tags-only shortcut,
 * so it is reported every run rather than recomputed by hand later.
 */
export interface LimbCensus {
  /** Rows considered. */
  scanned: number;
  /** Carries at least one `task:`/`decision:`/`epic:` tag (whether or not it resolves). */
  limbTagPresent: number;
  /** No limb tag, but at least one id8 in the prose resolved to a limb root. */
  bodyId8NoTag: number;
  /** Neither — the writer left nothing to place this record by. Terminal under Phase 2. */
  neither: number;
  /** Rows whose derived limb set is non-empty. */
  withLimbs: number;
  /** Rows whose derived limb set is empty (DERIVED, declares nothing — not "not derived"). */
  empty: number;
  /** Total 8-hex mentions dropped because the prefix matched more than one record. */
  ambiguousDrops: number;
  /** Rows carrying at least one ambiguous drop. */
  rowsWithAmbiguousDrops: number;
}

export interface DeclaredLimbsBackfillStats {
  resolverNodes: number;
  perType: Record<LimbResolvableType, LimbCensus>;
  rowsWritten: number;
  errors: Array<{ recordType: string; id: string; error: string }>;
}

export interface DeclaredLimbsBackfillOptions {
  /** Compute and report, write nothing. */
  dryRun?: boolean;
  /** Restrict the rows UPDATED to one project by name. The resolver stays global. */
  projectName?: string;
  /** Only touch rows that have never been derived (`declared_limbs IS NULL`). */
  onlyMissing?: boolean;
  /** Restrict to rows created at/after this ISO timestamp (census population control). */
  createdAtFrom?: string;
  pool?: Pool;
}

/** Per-kind SELECT list + the columns `composeLimbBody` reads. One home, no drift. */
const SOURCE_QUERIES: Record<LimbResolvableType, { table: string; columns: string; createdAt: string }> = {
  context: {
    table: 'contexts',
    columns: 'id::text AS id, content, tags',
    createdAt: 'created_at',
  },
  task: {
    table: 'tasks',
    columns: 'id::text AS id, title, description, tags',
    createdAt: 'created_at',
  },
  decision: {
    table: 'technical_decisions',
    columns:
      'id::text AS id, title, description, rationale, problem_statement, outcome_notes, tags',
    // technical_decisions has NO created_at column; its birth timestamp is decision_date.
    createdAt: 'decision_date',
  },
};

function emptyCensus(): LimbCensus {
  return {
    scanned: 0,
    limbTagPresent: 0,
    bodyId8NoTag: 0,
    neither: 0,
    withLimbs: 0,
    empty: 0,
    ambiguousDrops: 0,
    rowsWithAmbiguousDrops: 0,
  };
}

/** Load id + type for EVERY record, the resolution universe (see declaredLimbs.loadId8Rows). */
async function loadResolverUniverse(pool: Pool): Promise<Id8Resolver & { size: number }> {
  const res = await pool.query(`
    SELECT id::text AS id, 'task'::text     AS type FROM tasks
    UNION ALL
    SELECT id::text,        'decision'::text        FROM technical_decisions
    UNION ALL
    SELECT id::text,        'context'::text         FROM contexts
  `);
  const rows = res.rows.map(r => ({ id: r.id as string, type: r.type as LimbResolvableType }));
  const resolver = buildId8Resolver(rows);
  return { ...resolver, size: rows.length };
}

/**
 * Run the backfill against the DB the process is pointed at. Returns honest counts:
 * `rowsWritten` is 0 on a dry run and the census is computed either way.
 */
export async function runDeclaredLimbsBackfill(
  opts: DeclaredLimbsBackfillOptions = {}
): Promise<DeclaredLimbsBackfillStats> {
  const dryRun = opts.dryRun === true;
  const pool = opts.pool ?? db;
  if (!opts.pool) await initializeDatabase();

  const resolver = await loadResolverUniverse(pool);

  const stats: DeclaredLimbsBackfillStats = {
    resolverNodes: resolver.size,
    perType: { context: emptyCensus(), task: emptyCensus(), decision: emptyCensus() },
    rowsWritten: 0,
    errors: [],
  };

  let projectId: string | null = null;
  if (opts.projectName) {
    const p = await pool.query('SELECT id::text AS id FROM projects WHERE name = $1', [
      opts.projectName,
    ]);
    if (p.rows.length !== 1) {
      throw new Error(
        `--project ${opts.projectName} resolved to ${p.rows.length} projects; refusing to guess`
      );
    }
    projectId = p.rows[0].id;
  }

  const batchSize = DECLARED_LIMBS_CONFIG.backfillBatchSize;

  for (const type of Object.keys(SOURCE_QUERIES) as LimbResolvableType[]) {
    const src = SOURCE_QUERIES[type];
    const census = stats.perType[type];

    // KEYSET pagination on the primary key: stable under concurrent writes and never
    // re-reads a page, unlike OFFSET.
    let lastId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const where: string[] = ['id > $1'];
      const params: any[] = [lastId];
      if (projectId) {
        params.push(projectId);
        where.push(`project_id = $${params.length}`);
      }
      if (opts.onlyMissing) where.push('declared_limbs IS NULL');
      if (opts.createdAtFrom) {
        params.push(opts.createdAtFrom);
        where.push(`${src.createdAt} >= $${params.length}::timestamptz`);
      }
      params.push(batchSize);

      const page = await pool.query(
        `SELECT ${src.columns} FROM ${src.table}
          WHERE ${where.join(' AND ')}
          ORDER BY id ASC
          LIMIT $${params.length}`,
        params
      );
      if (page.rows.length === 0) break;
      lastId = page.rows[page.rows.length - 1].id;

      const writes: Array<{ id: string; limbs: string[]; drops: number }> = [];
      for (const row of page.rows) {
        try {
          const tags: string[] = row.tags ?? [];
          const body = composeLimbBody(type, row);
          const derived = deriveDeclaredLimbs({ id: row.id, type, body, tags }, resolver);

          census.scanned++;
          const hasLimbTag = tags.some(t => LIMB_TAG_PATTERN.test(String(t).trim()));
          const bodyResolves = collectNamedId8s({ id: row.id, type, body, tags }).bodyId8s.some(
            id8 => resolver.resolve(id8).kind === 'limbRoot'
          );
          if (hasLimbTag) census.limbTagPresent++;
          else if (bodyResolves) census.bodyId8NoTag++;
          else census.neither++;

          if (derived.limbs.length > 0) census.withLimbs++;
          else census.empty++;
          census.ambiguousDrops += derived.ambiguousDrops;
          if (derived.ambiguousDrops > 0) census.rowsWithAmbiguousDrops++;

          writes.push({ id: row.id, limbs: derived.limbs, drops: derived.ambiguousDrops });
        } catch (e) {
          stats.errors.push({ recordType: type, id: row.id, error: (e as Error)?.message ?? 'error' });
        }
      }

      if (!dryRun && writes.length > 0) {
        // One statement per page: UPDATE … FROM (unnest) rather than N round-trips.
        const res = await pool.query(
          `UPDATE ${src.table} t
              SET declared_limbs = v.limbs::uuid[],
                  declared_limbs_ambiguous_drops = v.drops
             FROM (SELECT unnest($1::uuid[])   AS id,
                          unnest($2::text[])   AS limbs,
                          unnest($3::int[])    AS drops) v
            WHERE t.id = v.id`,
          [
            writes.map(w => w.id),
            // uuid[] per row cannot be unnested as a 2-D array (Postgres arrays are
            // rectangular), so each row's set travels as its literal text form and is cast.
            writes.map(w => `{${w.limbs.join(',')}}`),
            writes.map(w => w.drops),
          ]
        );
        stats.rowsWritten += res.rowCount ?? 0;
      }
    }
  }

  return stats;
}

/** Pretty-print the stats (used by the CLI runner). */
export function formatDeclaredLimbsStats(
  stats: DeclaredLimbsBackfillStats,
  dryRun: boolean
): string {
  const lines = [`\n🌿 Declared-limbs backfill${dryRun ? ' (DRY RUN — nothing written)' : ''}`];
  lines.push(`   Resolver universe: ${stats.resolverNodes} nodes`);
  for (const type of Object.keys(stats.perType) as LimbResolvableType[]) {
    const c = stats.perType[type];
    if (c.scanned === 0) continue;
    lines.push(`   ── ${type} ──`);
    lines.push(`      scanned .............. ${c.scanned}`);
    lines.push(`      limb TAG present ..... ${c.limbTagPresent}`);
    lines.push(`      id8 in BODY, no tag .. ${c.bodyId8NoTag}`);
    lines.push(`      NEITHER .............. ${c.neither}`);
    lines.push(`      derived non-empty .... ${c.withLimbs}`);
    lines.push(`      derived empty ........ ${c.empty}`);
    lines.push(`      ambiguous drops ...... ${c.ambiguousDrops} (on ${c.rowsWithAmbiguousDrops} rows)`);
  }
  lines.push(`   Rows ${dryRun ? 'WOULD write' : 'written'}: ${stats.rowsWritten}`);
  if (stats.errors.length > 0) {
    lines.push(`   ⚠️  Per-row errors: ${stats.errors.length}`);
    for (const err of stats.errors.slice(0, 10)) {
      lines.push(`      - ${err.recordType} ${err.id}: ${err.error}`);
    }
  }
  return lines.join('\n');
}
