/**
 * TreeWalkerWhyService — GET /api/treewalker/record/:id/why: "why does this record exist, and
 * what did it lead to", for ANY live record in scope (including one outside the walked branch).
 *
 * THE RULE THIS FILE EXISTS TO KEEP (design): a CAUSE is a DECLARED
 * edge, never a guess. Causes are the record's OUTGOING declared links of the configured cause
 * types; a `possibly_supersedes` link is a GUESS and only ever feeds the SERIES (and the guessed
 * count), never a cause. "Just before" is read off the branch by TIME and is flagged byTime —
 * it is not an edge.
 *
 * Everything shaped here is a flat set-keyed read; vocabulary and caps come from
 * config/treewalkerConfig.ts (`why`, `branch`).
 */
import type { Pool } from 'pg';
import { db } from '../database/connection';
import { ALL_PROJECTS, type ProjectListScope } from './projectListScope';
import { logger } from '../config/logger';
import { TREEWALKER_CONFIG, type TreewalkerConfig } from '../config/treewalkerConfig';
import {
  TreeWalkerService,
  branchNameOf,
  deriveTrust,
  isoOf,
  kindOf,
  type GatheredTrustSignals,
  type RawRecord,
  type RecordKind,
  type TrustLevel,
} from './treewalker';

/** A record as the Why view shows it: the thread-v2 node fields, without branch membership. */
export interface WhyNode {
  id: string;
  kind: RecordKind;
  title: string;
  createdAt: string;
  trust: TrustLevel;
  contextType?: string | null;
  status?: string | null;
  outcomeStatus?: string | null;
}

/** The declared causes of one edge type. */
export interface WhyCauseGroup {
  edgeType: string;
  targets: WhyNode[];
}

/** The records a decision cause spawned (other records declared decided_by it). */
export interface WhySpawned {
  decisionId: string;
  /** TRUE number of other records with a declared decided_by edge to the decision. */
  total: number;
  /** Up to `why.spawnedMax` of them, newest first. */
  records: WhyNode[];
}

export interface WhySeriesEntry extends WhyNode {
  /** Always true: a series link is suggested (possibly_supersedes), never declared. */
  guessed: true;
  isCurrent: boolean;
}

export interface WhyBeforeEntry extends WhyNode {
  /** Always true: placed by createdAt on the branch, NOT by an edge. */
  byTime: true;
}

export interface WhyResult {
  record: WhyNode;
  causes: WhyCauseGroup[];
  spawned: WhySpawned[];
  branch: { id: string; title: string } | null;
  series: WhySeriesEntry[];
  before: WhyBeforeEntry[];
  counts: { declared: number; guessed: number };
}

/** Raised when the record is not a live record in the caller's scope (→ 404, no record fields). */
export class WhyRecordNotFoundError extends Error {
  constructor(id: string) {
    super(`No live record found for ${id}`);
    this.name = 'WhyRecordNotFoundError';
  }
}

const NO_SIGNALS: GatheredTrustSignals = { outcomes: [], supersededDeclared: false, supersededSoft: false };

/** createdAt ASC, id tiebreak — the one ordering used for series and before. */
function chronological(a: WhyNode, b: WhyNode): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
}

export function toWhyNode(rec: RawRecord, trust: TrustLevel): WhyNode {
  return {
    id: rec.id,
    kind: kindOf(rec),
    title: rec.title,
    createdAt: isoOf(rec.createdAt),
    trust,
    ...(rec.type === 'context' ? { contextType: rec.contextType ?? null } : {}),
    ...(rec.type === 'task' ? { status: rec.status ?? null } : {}),
    ...(rec.type === 'decision' ? { outcomeStatus: rec.outcomeStatus ?? null } : {}),
  };
}

/**
 * A series member must read as the same kind of record: same kind, and — for contexts — the
 * same contextType (a milestone's series is milestones, not the discussions that mention it).
 */
export function sameSeriesKind(
  a: Pick<RawRecord, 'type' | 'contextType'>,
  b: Pick<RawRecord, 'type' | 'contextType'>,
): boolean {
  return kindOf(a) === kindOf(b) && (a.contextType ?? null) === (b.contextType ?? null);
}

export class TreeWalkerWhyService {
  static async getWhy(
    id: string,
    scope: ProjectListScope,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<WhyResult> {
    try {
      const live = await TreeWalkerService.liveRecord(id, scope, pool);
      if (!live) throw new WhyRecordNotFoundError(id);
      const projectId = live.projectId;
      const w = config.why;
      const declared = config.branch.declaredProvenance;

      const self = (await TreeWalkerService.fetchRecords([id], pool, projectId)).get(id);
      if (!self) throw new WhyRecordNotFoundError(id);

      // CAUSES: outgoing DECLARED links of the cause types (trunk plumbing excluded).
      const causeRows = await pool.query(
        `SELECT DISTINCT to_id, edge_type FROM links
          WHERE from_id = $1
            AND provenance_class = $2
            AND edge_type = ANY($3::text[])
            AND mint_via <> ALL($4::text[])`,
        [id, declared, [...w.causeEdgeTypes], [...config.branch.excludedMintVia]],
      );
      const causeIds = [...new Set<string>(causeRows.rows.map((r) => r.to_id as string))];

      // SERIES: possibly_supersedes in either direction (guessed), same kind + contextType.
      const seriesRows = await pool.query(
        `SELECT from_id, to_id FROM links
          WHERE edge_type = $2 AND (from_id = $1 OR to_id = $1)`,
        [id, w.seriesEdgeType],
      );
      const seriesIds = [
        ...new Set<string>(seriesRows.rows.map((r) => (r.from_id === id ? r.to_id : r.from_id) as string)),
      ].filter((x) => x !== id);

      // BRANCH + BEFORE: the same spine resolution as thread v2; members read by time.
      const spineId = await TreeWalkerService.membershipSpine({ id, projectId }, scope, pool);
      const branchData = spineId ? await TreeWalkerService.gatherBranch(spineId, projectId, config, pool) : null;

      // SPAWNED: per decision cause, the other records declared decided_by it.
      const spawnedRaw = new Map<string, { total: number; ids: string[] }>();
      const spawnedRecordIds = new Set<string>();

      // Fetch every record we will show in one go.
      const records = await TreeWalkerService.fetchRecords(
        [...new Set([...causeIds, ...seriesIds])],
        pool,
        projectId,
      );
      for (const decisionId of causeIds) {
        if (records.get(decisionId)?.type !== 'decision') continue;
        const res = await pool.query(
          `WITH src AS (
             SELECT DISTINCT from_id FROM links
              WHERE to_id = $1 AND from_id <> $2
                AND provenance_class = $3
                AND edge_type = $4
                AND mint_via <> ALL($5::text[])
           ), live AS (
             SELECT c.id, c.created_at FROM contexts c JOIN src ON src.from_id = c.id
              WHERE c.archived_at IS NULL AND c.project_id = $6
             UNION ALL
             SELECT d.id, d.decision_date FROM technical_decisions d JOIN src ON src.from_id = d.id
              WHERE d.archived_at IS NULL AND d.project_id = $6
             UNION ALL
             SELECT t.id, t.created_at FROM tasks t JOIN src ON src.from_id = t.id
              WHERE t.archived_at IS NULL AND t.project_id = $6
           )
           SELECT id, COUNT(*) OVER () AS total FROM live
            ORDER BY created_at DESC, id LIMIT $7`,
          [decisionId, id, declared, w.spawnEdgeType, [...config.branch.excludedMintVia], projectId, w.spawnedMax],
        );
        const total = res.rows.length ? Number(res.rows[0].total) : 0;
        const ids = res.rows.map((r) => r.id as string);
        spawnedRaw.set(decisionId, { total, ids });
        ids.forEach((x) => spawnedRecordIds.add(x));
      }
      const spawnedRecords = await TreeWalkerService.fetchRecords([...spawnedRecordIds], pool, projectId);

      // COUNTS: every edge touching the record, split by provenance. Guessed ones are counted, never listed.
      const countRows = await pool.query(
        `SELECT provenance_class, COUNT(*)::int AS n FROM links
          WHERE from_id = $1 OR to_id = $1 GROUP BY provenance_class`,
        [id],
      );
      const countOf = (cls: string) => countRows.rows.find((r) => r.provenance_class === cls)?.n ?? 0;

      // TRUST for every node shown.
      const shown = new Map<string, RawRecord>([[id, self]]);
      for (const r of [...records.values(), ...spawnedRecords.values()]) shown.set(r.id, r);
      const before = branchData
        ? [...branchData.records.values()].filter(
            (r) => !branchData.ghostIds.has(r.id) && r.id !== id,
          )
        : [];
      for (const r of before) shown.set(r.id, r);
      const signals = await TreeWalkerService.fetchTrustSignals([...shown.keys()], pool);
      const now = new Date();
      const node = (r: RawRecord): WhyNode =>
        toWhyNode(r, deriveTrust(r, signals.get(r.id) ?? NO_SIGNALS, now));

      const causes: WhyCauseGroup[] = w.causeEdgeTypes
        .map((edgeType) => ({
          edgeType,
          targets: causeRows.rows
            .filter((r) => r.edge_type === edgeType && records.has(r.to_id))
            .map((r) => node(records.get(r.to_id) as RawRecord))
            .sort(chronological),
        }))
        .filter((g) => g.targets.length > 0);

      const spawned: WhySpawned[] = [...spawnedRaw.entries()].map(([decisionId, s]) => ({
        decisionId,
        total: s.total,
        records: s.ids.filter((x) => spawnedRecords.has(x)).map((x) => node(spawnedRecords.get(x) as RawRecord)),
      }));

      const seriesPeers = seriesIds
        .map((x) => records.get(x))
        .filter((r): r is RawRecord => r !== undefined && sameSeriesKind(self, r));
      const series: WhySeriesEntry[] = seriesPeers.length
        ? [self, ...seriesPeers]
            .map((r) => ({ ...node(r), guessed: true as const, isCurrent: r.id === id }))
            .sort(chronological)
        : [];

      const selfNode = node(self);
      const beforeNodes: WhyBeforeEntry[] = before
        .map(node)
        .filter((n) => chronological(n, selfNode) < 0)
        .sort(chronological)
        .slice(-w.beforeMax)
        .map((n) => ({ ...n, byTime: true as const }));

      const spineRec = spineId ? branchData?.records.get(spineId) : undefined;
      return {
        record: selfNode,
        causes,
        spawned,
        branch: spineId && spineRec ? { id: spineId, title: branchNameOf(spineRec, config).name } : null,
        series,
        before: beforeNodes,
        counts: { declared: countOf(declared), guessed: countOf('guessed') },
      };
    } catch (error) {
      if (error instanceof WhyRecordNotFoundError) throw error;
      logger.error('TreeWalker getWhy error', { error, id, unrestricted: scope.mode === ALL_PROJECTS });
      throw new Error('Failed to build the why view');
    }
  }
}
