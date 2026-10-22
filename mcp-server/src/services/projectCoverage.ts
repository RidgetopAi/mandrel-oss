/**
 * GRAPH-AWARE PROJECT INSIGHTS — the DB-backed gather.
 *
 * Mirrors the currentState.ts / currentStateCore.ts split exactly: gather (SQL, ordered) →
 * project (pure). This file selects and hydrates; every RULE lives in projectCoverageCore.ts.
 *
 * WHAT IS AND IS NOT WRITTEN HERE (the design constraint on this task). The only thing this
 * gather defines is WHICH RECORDS ARE IN SCOPE — "every record in this project, most recent
 * first, capped". It defines nothing else:
 *   - hydration        → hydrateNodes() from recallThread.ts (the SAME batched read the
 *                        thread gather uses; exported for this caller, not duplicated).
 *   - trust            → trustForRecords() from trust.ts (the moat; one definition).
 *   - current state    → projectCurrentState(), called by the core. NO frontier query, no
 *                        supersession query and no "latest trusted outcome" query is written
 *                        here or anywhere in part C. That question belongs to part B
 *                        and is asked exactly once in this codebase.
 *   - every ratio/rule → projectCoverageCore.ts.
 *
 * FAIL LOUD (an earlier task's rule, inherited): if the underlying data cannot be read, this
 * throws and the caller surfaces an error. There is no existence check, no try/catch
 * returning defaults and no `|| 0` fallback — a plausible silent zero is how project_insights
 * shipped fabricated health for ten months. Do not add one.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { hydrateNodes } from './recallThread.js';
import { trustForRecords, type RecordRef } from './trust.js';
import {
  projectProjectCoverage,
  type CoverageEdge,
  type CoverageInputNode,
  type ProjectCoverage,
} from './projectCoverageCore.js';
import { COVERAGE_CONFIG, type CoverageConfig } from '../config/coverageConfig.js';
import type { EdgeNodeType } from '../config/edgeTypes.js';

/** One record as the project listing returns it — id, kind, recency key, attribution. */
interface ProjectRecordRef {
  id: string;
  type: EdgeNodeType;
  createdAt: Date | null;
  sessionId: string | null;
}

/**
 * The three entity tables, with the columns this listing needs. Kept as data rather than three
 * copy-pasted blocks so adding a fourth record kind is one row, not a fourth place to forget.
 * `recencyColumn` differs per table (decisions date from `decision_date`), which is exactly
 * the kind of detail that drifts when it is spelled out three times.
 */
const RECORD_SOURCES: ReadonlyArray<{
  type: EdgeNodeType;
  table: string;
  recencyColumn: string;
}> = [
  { type: 'context', table: 'contexts', recencyColumn: 'created_at' },
  { type: 'task', table: 'tasks', recencyColumn: 'created_at' },
  { type: 'decision', table: 'technical_decisions', recencyColumn: 'decision_date' },
];

/**
 * List every record in the project, newest first, with its attribution.
 *
 * Reads ids + dates only (no content, no embedding), so the count is honest even on a large
 * project and the expensive hydrate/trust pass can then be capped against a KNOWN total.
 */
async function listProjectRecords(projectId: string, pool: Pool): Promise<ProjectRecordRef[]> {
  const all: ProjectRecordRef[] = [];
  for (const src of RECORD_SOURCES) {
    const { rows } = await pool.query(
      `SELECT id::text AS id, ${src.recencyColumn} AS recency, session_id::text AS session_id
         FROM ${src.table}
        WHERE project_id = $1`,
      [projectId]
    );
    for (const r of rows) {
      all.push({
        id: r.id,
        type: src.type,
        createdAt: r.recency ?? null,
        sessionId: r.session_id ?? null,
      });
    }
  }
  // DETERMINISTIC total order: newest first, ties broken by id — the same rule the
  // current-state projector orders by, so the capped WINDOW is stable across calls.
  all.sort((a, b) => {
    const ra = a.createdAt ? a.createdAt.getTime() : 0;
    const rb = b.createdAt ? b.createdAt.getTime() : 0;
    if (ra !== rb) return rb - ra;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return all;
}

/**
 * Read every typed edge that touches the examined records, in canonical from→to orientation.
 *
 * Deliberately NOT filtered by `links.project_id`: an edge is judged by its ENDPOINTS. A
 * project-id filter would hide a legitimately cross-referenced edge and make a grounded
 * record read as ungrounded — understating coverage by construction.
 *
 * Reads through the `link_provenance` VIEW (migration 079) rather than the
 * raw table, so every edge carries its declared/guessed class from THE one classification —
 * the coverage answer must show the split beside every coverage number (the 2026-07-28
 * incident: a guess replaced a dead declared mechanism and coverage could not tell).
 */
async function readEdges(ids: string[], pool: Pool): Promise<CoverageEdge[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT from_id::text AS from_id, to_id::text AS to_id, edge_type, provenance_class
       FROM link_provenance
      WHERE from_id = ANY($1::uuid[]) OR to_id = ANY($1::uuid[])`,
    [ids]
  );
  return rows.map((r) => ({
    from: r.from_id,
    to: r.to_id,
    type: r.edge_type,
    provenance: r.provenance_class,
  }));
}

/**
 * Build the graph-aware coverage insight for a project.
 *
 * Throws (never degrades) if any read fails — see the FAIL LOUD note in the header.
 */
export async function buildProjectCoverage(
  projectId: string,
  cfg: CoverageConfig = COVERAGE_CONFIG,
  pool: Pool = db
): Promise<ProjectCoverage> {
  const listed = await listProjectRecords(projectId, pool);
  const window = listed.slice(0, cfg.maxNodes);

  const refs = window.map((r) => ({ id: r.id, type: r.type }));
  const hydrated = await hydrateNodes(refs, pool);

  // A listed id with no hydrated row means the row vanished between the two reads (a delete
  // in flight). Drop it from the EXAMINED set — but it stays counted in recordsInProject, so
  // the scope stays honest rather than quietly shrinking.
  const present = window.filter((r) => hydrated.has(r.id));

  const trustRefs: RecordRef[] = present.map((r) => ({
    id: r.id,
    type: r.type,
    createdAt: r.createdAt ?? undefined,
  }));
  const trusts = await trustForRecords(trustRefs, undefined, pool);

  const nodes: CoverageInputNode[] = present.map((r, i) => {
    const h = hydrated.get(r.id)!;
    return {
      id: r.id,
      type: r.type,
      title: h.title,
      content: h.content,
      createdAt: h.createdAt ?? r.createdAt,
      updatedAt: h.updatedAt ?? h.createdAt ?? r.createdAt,
      status: h.status,
      outcomeStatus: h.outcomeStatus,
      // an earlier task — same field, same hydration, second consumer. project.insights and
      // recall_thread share hydrateNodes() precisely so a field added for one appears in
      // both; forwarding it in only one place would recreate the drift that shape prevents.
      implementationStatus: h.implementationStatus,
      contextType: h.contextType,
      metadata: h.metadata,
      trust: trusts[i],
      sessionId: r.sessionId,
    };
  });

  const edges = await readEdges(
    nodes.map((n) => n.id),
    pool
  );

  return projectProjectCoverage(projectId, nodes, edges, { recordsInProject: listed.length }, cfg);
}
