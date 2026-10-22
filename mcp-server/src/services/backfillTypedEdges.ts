/**
 * BACKFILL TYPED EDGES — core logic (Mandrel Core Redesign T2a).
 *
 * Lives under src/ so it is type-checked + importable by the contract test (the runner
 * scripts/backfill-typed-edges.ts is a thin wrapper around runBackfill()).
 *
 * Mints typed edges for EXISTING records from the signals they already carry, so the
 * graph is populated from our real data and T2b (trust) / T3 (recall_thread) have
 * something to traverse on day one. Sources (identical mapping to the write-time
 * auto-mint, so backfilled edges == newly-written edges):
 *   - contexts.tags                    : task:/decision:/context: → informs/decided_by/learned_from
 *   - technical_decisions.tags         : same threading-tag mapping
 *   - technical_decisions.metadata     : evidence/learned_from/parents → learned_from
 *   - technical_decisions.superseded_by: → a `supersedes` edge (mirrors the column)
 *
 * IDEMPOTENT: every edge is minted through mintEdge(), which relies on
 * UNIQUE(from_id,to_id,edge_type) + ON CONFLICT DO NOTHING — re-running produces NO
 * duplicates. PROJECT-SCOPED: refs resolve within the record's own project, like the
 * write path. ROBUST: a per-row error is logged and the run continues.
 */

import { db, initializeDatabase } from '../config/database.js';
import { autoMintFromTags, autoMintFromDecision } from './links.js';

export interface BackfillStats {
  contextsScanned: number;
  decisionsScanned: number;
  edgesAttempted: number;
  edgesCreated: number;
  /** intents that resolved to an already-existing edge OR did not resolve (no new row). */
  edgesSkipped: number;
  errors: Array<{ recordType: string; id: string; error: string }>;
}

export interface BackfillOptions {
  /** When true, perform all mints inside a transaction that is ROLLED BACK (no writes). */
  dryRun?: boolean;
}

/**
 * Run the typed-edge backfill against the DB the process is pointed at. Returns honest
 * counts. On dryRun the mints execute inside a rolled-back transaction so the "created"
 * count is the accurate WOULD-CREATE count and nothing persists.
 */
export async function runBackfill(opts: BackfillOptions = {}): Promise<BackfillStats> {
  const dryRun = opts.dryRun === true;
  await initializeDatabase();

  const stats: BackfillStats = {
    contextsScanned: 0,
    decisionsScanned: 0,
    edgesAttempted: 0,
    edgesCreated: 0,
    edgesSkipped: 0,
    errors: [],
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── Contexts: threading-tag edges ──────────────────────────────────────────
    const contexts = await client.query<{ id: string; project_id: string | null; tags: string[] | null }>(
      `SELECT id, project_id, tags FROM contexts
       WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
       ORDER BY created_at ASC`
    );
    for (const row of contexts.rows) {
      stats.contextsScanned++;
      try {
        const res = await autoMintFromTags(
          {
            fromId: row.id,
            fromType: 'context',
            tags: row.tags ?? [],
            projectId: row.project_id ?? undefined,
            createdBy: 'backfill',
          },
          client as any
        );
        stats.edgesAttempted += res.attempted;
        stats.edgesCreated += res.minted;
      } catch (e) {
        stats.errors.push({ recordType: 'context', id: row.id, error: (e as Error)?.message ?? 'error' });
      }
    }

    // ── Decisions: threading-tag + evidence + supersession edges ────────────────
    const decisions = await client.query<{
      id: string;
      project_id: string | null;
      tags: string[] | null;
      metadata: any;
      superseded_by: string | null;
    }>(
      `SELECT id, project_id, tags, metadata, superseded_by FROM technical_decisions
       ORDER BY decision_date ASC`
    );
    for (const row of decisions.rows) {
      stats.decisionsScanned++;
      try {
        const tagRes = await autoMintFromTags(
          {
            fromId: row.id,
            fromType: 'decision',
            tags: row.tags ?? [],
            projectId: row.project_id ?? undefined,
            createdBy: 'backfill',
          },
          client as any
        );
        const decRes = await autoMintFromDecision(
          {
            decisionId: row.id,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {},
            supersededBy: row.superseded_by,
            projectId: row.project_id ?? undefined,
            createdBy: 'backfill',
          },
          client as any
        );
        stats.edgesAttempted += tagRes.attempted + decRes.attempted;
        stats.edgesCreated += tagRes.minted + decRes.minted;
      } catch (e) {
        stats.errors.push({ recordType: 'decision', id: row.id, error: (e as Error)?.message ?? 'error' });
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  stats.edgesSkipped = stats.edgesAttempted - stats.edgesCreated;
  return stats;
}

/** Pretty-print the stats (used by the CLI runner). */
export function formatBackfillStats(stats: BackfillStats, dryRun: boolean): string {
  const lines = [
    '\n📊 Backfill summary',
    `   Contexts scanned:        ${stats.contextsScanned}`,
    `   Decisions scanned:       ${stats.decisionsScanned}`,
    `   Edge intents attempted:  ${stats.edgesAttempted}`,
    `   Edges ${dryRun ? 'WOULD create' : 'created'}:   ${stats.edgesCreated}`,
    `   Skipped (already existed / unresolved): ${stats.edgesSkipped}`,
  ];
  if (stats.errors.length > 0) {
    lines.push(`   ⚠️  Per-row errors: ${stats.errors.length}`);
    for (const err of stats.errors.slice(0, 10)) {
      lines.push(`      - ${err.recordType} ${err.id}: ${err.error}`);
    }
  }
  return lines.join('\n');
}
