/**
 * TYPED-EDGE GRAPH — the links service (Mandrel Core Redesign T2a).
 *
 * The single home for reading/writing the `links` table (migration 049). Everything
 * that touches edges goes through here so the dedup contract, parameterized SQL, and
 * project scoping live in ONE place (one definition, not N copies):
 *
 *   - mintEdge()        — insert one typed edge, idempotent via the UNIQUE constraint.
 *   - unlinkEdge()      — remove one typed edge.
 *   - getLinks()        — read a record's edges (both directions), with the connected
 *                         record's id/type/title for traversal.
 *   - autoMintFromTags()/autoMintFromDecision() — the Q3 "near-free" path: derive typed
 *                         edges from signals the writer already gives (threading tags,
 *                         decision evidence, supersession), resolving id8→uuid
 *                         project-scoped and SKIPPING SILENTLY on an unresolvable ref so
 *                         a bad/typo'd tag NEVER breaks the write.
 *
 * SECURITY: every query binds user-derived values as PARAMETERS — never string-built.
 * The edge_type is validated against the named domain (config/edgeTypes.ts) before it
 * reaches SQL, and the DB CHECK is the backstop.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import {
  EDGE_NODE_TYPES,
  type EdgeNodeType,
  type EdgeType,
  isEdgeType,
  isEdgeNodeType,
} from '../config/edgeTypes.js';
import {
  resolveMintEndpoint,
  probeCrossProject,
  isFullUuid,
  IdNotFoundError,
  AmbiguousIdError,
  type CrossProjectHit,
} from '../utils/idResolver.js';
import { tagToEdgeIntent } from '../config/tagEdgeConfig.js';
import { EDGE_MINT_VIA, isEdgeMintVia, type EdgeMintVia } from '../config/edgeProvenanceConfig.js';
import { ACTIVE_TASK_EDGE_TYPE, ACTIVE_DECISION_EDGE_TYPE } from '../config/autoThreadConfig.js';
import {
  isChronologyOrderedEdgeType,
  CHRONOLOGY_ORDERED_EDGE_TYPES,
  ENTITY_CREATED_AT,
  BACKWARDS_IN_TIME_REASON,
  type ChronologyVerdict,
} from '../config/edgeChronologyConfig.js';

/** One edge as stored. */
export interface Edge {
  id: string;
  fromId: string;
  fromType: EdgeNodeType;
  toId: string;
  toType: EdgeNodeType;
  edgeType: EdgeType;
  projectId: string | null;
  createdAt: string;
  createdBy: string | null;
  metadata: Record<string, any>;
}

/** A record's edge with the CONNECTED node hydrated (id/type/title) for traversal. */
export interface ConnectedEdge {
  /** The edge type. */
  edgeType: EdgeType;
  /** 'out' = this record is from_id; 'in' = this record is to_id. */
  direction: 'out' | 'in';
  /** The id of the record on the OTHER end of the edge. */
  connectedId: string;
  /** The kind of the connected record. */
  connectedType: EdgeNodeType;
  /** A human-readable title/label for the connected record (best-effort). */
  connectedTitle: string | null;
  /** The edge row id (for unlink/repair). */
  edgeId: string;
  /**
   * WHICH MINT PATH produced this edge — read straight off the `links.mint_via` NOT NULL
   * column (SK4), which is the source of truth. It is a FIRST-CLASS field
   * and deliberately NOT re-inserted into `metadata`: SK4 moved this fact out of the blob
   * precisely to end the four-keys-for-one-axis drift, so the read projects the column.
   *
   * Nullable in the type only for rows a future/looser writer could leave unlabelled; the
   * DB constraint makes that unreachable today.
   *
   * SAME VOCABULARY as {@link ReportedMintedEdge.via} (the WRITE-time report) since an earlier task
   * — both are {@link EdgeMintVia}. Until then the two spelled two members
   * differently ('links-arg'/'handoff-supersession' in the response vs
   * 'links-param'/'handoff-timeline' in the column), so a consumer that read the response
   * and a consumer that read the column disagreed about one fact. It stays `string | null`
   * here rather than the narrowed union because this value comes from the DATABASE, and a
   * row written by a future/looser writer must be reportable as-is, never coerced.
   */
  mintVia: string | null;
  /**
   * declared | guessed | unclassified — the GENERATED column over mint_via (migration 085),
   * read back rather than recomputed. It rides along because it is the axis SK5 selects on,
   * and because deriving it in the consumer would re-create a second copy of a classification
   * that exists exactly once, in SQL.
   */
  provenanceClass: string | null;
  metadata: Record<string, any>;
}

export interface MintEdgeInput {
  fromId: string;
  fromType: EdgeNodeType;
  toId: string;
  toType: EdgeNodeType;
  edgeType: EdgeType;
  projectId?: string | null;
  /** Provenance label (e.g. 'auto:context_store', 'link', 'backfill'). */
  createdBy?: string;
  /**
   * REQUIRED (SK4) — WHICH MINT PATH produced this edge, from the closed
   * vocabulary in config/edgeProvenanceConfig.ts. Persisted to the NOT NULL `links.mint_via`
   * column, from which `provenance_class` (declared/guessed) is generated in SQL.
   *
   * It is a required, narrowed-union PARAMETER rather than an optional metadata key on
   * purpose: an unlabelled mint must be UNREACHABLE, not merely discouraged, and the type
   * is the layer that makes it unreachable for every in-repo call site at compile time.
   */
  via: EdgeMintVia;
  metadata?: Record<string, any>;
}

export interface MintResult {
  /** True if a NEW edge row was inserted; false if it already existed (dedup). */
  created: boolean;
  /** The edge id (existing or new) when resolvable. */
  edgeId?: string;
  /**
   * The `links.mint_via` value the row CARRIES. Read back from the row —
   * on a dedup this is the ORIGINAL minter's label, not the one this call passed, which is
   * the whole reason it is returned rather than echoed: a caller that re-mints an existing
   * edge learns who really minted it.
   */
  mintVia?: string | null;
  /** The generated declared|guessed|unclassified over mint_via, read back (never recomputed). */
  provenanceClass?: string | null;
  /**
   * THE THIRD OUTCOME. Not created, not deduped — REFUSED, with a reason.
   * Set to {@link BACKWARDS_IN_TIME_REASON} when a chronology-ordered edge type was asked
   * to point from an OLDER record to a NEWER one. When present, NOTHING was written and
   * `created` is false.
   *
   * WHY A FIELD AND NOT A THROW: mintEdge throws {@link InvalidEdgeError} for SHAPE errors —
   * an unknown edge_type, a self-link — which are programming mistakes. A backwards edge is
   * a DATA condition: the arguments are well-formed and name real records that happen to be
   * in the wrong order. Every auto-mint caller in this file wraps mintEdge in a try/catch
   * that logs "failed … edge", so a throw would land a deliberate refusal in the same bucket
   * as a dropped connection — collapsing "I refused" into "I could not tell" (C1's third
   * state). A field keeps the three outcomes separable by every caller, and lets the `link`
   * tool turn a refusal into an actionable error while an automated mirror just records it.
   */
  refused?: typeof BACKWARDS_IN_TIME_REASON;
  /**
   * What the chronology check actually concluded — including `unknown`, which does NOT
   * refuse (an endpoint with no readable row is not evidence of a backwards edge) but is
   * reported so nobody reads a mint as chronology-checked when it was not. Absent when the
   * edge type carries no time claim.
   */
  chronology?: ChronologyVerdict;
}

/**
 * ONE edge minted-or-deduped on a WRITE, reported back to the writer.
 * Every write-time mint path (tag / links-param / anchor / inference) reports its edges in
 * this shape so the store response can present ONE unified list — before this, the tag
 * and links-param paths returned bare counts, so a tag-threaded write read as a silent
 * orphan (linksMinted:0) even though its edges existed (dogfood snag).
 */
export interface MintedEdge {
  /** The edge type minted (informs | decided_by | learned_from | related_to | …). */
  edgeType: EdgeType;
  /** The connected record's kind. */
  toType: EdgeNodeType;
  /** The connected record id (full UUID — already resolved at mint time). */
  toId: string;
  /** True iff a NEW edge row was inserted (false on dedup — the edge already existed). */
  created: boolean;
}

/**
 * WHICH write-time path minted an edge — the provenance label the store RESPONSE carries
 * per edge (positional labels added by PHASE 1, which
 * RETIRED the anchor's 'anchor' label).
 *
 * ── ONE FACT, ONE VOCABULARY ─────────────────────────────────────────
 * This used to be its OWN hand-written union, and it spelled two of its members
 * differently from the vocabulary actually written to the `links.mint_via` column:
 * 'links-arg' vs 'links-param', and 'handoff-supersession' vs 'handoff-timeline'. Same
 * edge, same axis ("which path minted it"), two names — so a caller reading the store
 * response and a caller reading the column (or `get_links`.mintVia) disagreed about the
 * same fact, and nothing could tell them they disagreed.
 *
 * It is now an ALIAS of {@link EdgeMintVia}, the closed vocabulary in
 * config/edgeProvenanceConfig.ts. Deliberately an alias and NOT a hand-listed subset:
 * a subset would be a SECOND list that happens to agree today and desynchronizes on the
 * next mint site added. There is one list; the response and the column read from it.
 *
 * The narrowing that a subset would have bought is not lost — it is bought by the fact
 * that each report row is built at the mint site that produced it, and the mint site's
 * own `via` argument is already type-narrowed by mintEdge.
 */
export type MintedEdgeVia = EdgeMintVia;

/** A {@link MintedEdge} labeled with the path that minted it (the unified report row). */
export interface ReportedMintedEdge extends MintedEdge {
  via: MintedEdgeVia;
  /** For via:'tag' — the threading tag that minted this edge (its exact provenance). */
  sourceTag?: string;
}

/** Thrown for a malformed edge request (bad edge_type / node_type / self-link). */
export class InvalidEdgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEdgeError';
  }
}

/**
 * Mint ONE typed edge. Idempotent: the UNIQUE(from_id,to_id,edge_type) constraint +
 * ON CONFLICT DO NOTHING means re-minting the same edge is a no-op (created:false).
 *
 * Validates the shape BEFORE the write (defense in depth; the DB CHECK is the backstop):
 *   - edge_type ∈ the named domain (config/edgeTypes.ts),
 *   - from_type/to_type ∈ the node-type set,
 *   - no self-link (from_id == to_id) — a record cannot edge to itself,
 *   - via ∈ the mint-path vocabulary (config/edgeProvenanceConfig.ts). This is the RUNTIME
 *     layer of the SK4 fail-closed contract; the type is the compile-time layer and the
 *     NOT NULL `mint_via` column is the layer that holds against raw SQL.
 *
 * Then CHRONOLOGY: for an edge type whose direction is a claim about time
 * (config/edgeChronologyConfig.ts), the source must be strictly later than the target. A
 * backwards edge is REFUSED — `{created:false, refused:'direction_backwards_in_time'}`,
 * nothing written, a warning logged. Three outcomes, never two: created · deduped · refused.
 *
 * Returns the row's own `mintVia` / `provenanceClass` so a caller —
 * including the `link` tool, whose output schema advertises both — can report the edge's
 * provenance without a second query, and so a DEDUP reports the ORIGINAL minter's label.
 */
/**
 * IS THIS EDGE POINTING BACKWARDS IN TIME?
 *
 * For a chronology-ordered edge type (config/edgeChronologyConfig.ts) the `from` record
 * must be STRICTLY LATER than the `to` record — "A supersedes B" is a claim that A came
 * after B. Returns the three-state verdict; the caller decides what to do with it.
 *
 * Exported so a detector/report can ask the same question of EXISTING rows using the same
 * predicate the mint site enforces, rather than a second hand-written copy of it.
 */
export async function checkEdgeChronology(
  input: { fromId: string; fromType: EdgeNodeType; toId: string; toType: EdgeNodeType },
  pool: Pool = db
): Promise<ChronologyVerdict> {
  const from = ENTITY_CREATED_AT[input.fromType];
  const to = ENTITY_CREATED_AT[input.toType];
  // The `(ts, id) <` LEXICOGRAPHIC comparison, done in SQL — the SAME total order
  // services/handoffSupersession.ts uses to pick a predecessor. Deliberately not
  // re-implemented in TypeScript: two orderings for one relation is exactly the drift this
  // task exists to end, and a JS Date round-trip loses microseconds that Postgres keeps, so
  // a TS comparison would call distinct instants a tie. The id tiebreak means there is no
  // tie state to handle — for any two DISTINCT rows the order is total, and mintEdge has
  // already rejected the self-link case above.
  //
  // Table/column names are interpolated because they are IDENTIFIERS. They come only from
  // ENTITY_CREATED_AT, keyed by an EdgeNodeType that isEdgeNodeType has already validated
  // against the closed domain; the ids remain bound PARAMETERS.
  const { rows } = await pool.query(
    `SELECT (f.ts, $1::uuid) < (t.ts, $2::uuid) AS backwards
       FROM (SELECT ${from.column} AS ts FROM ${from.table} WHERE id = $1::uuid) f,
            (SELECT ${to.column}   AS ts FROM ${to.table}   WHERE id = $2::uuid) t`,
    [input.fromId, input.toId]
  );
  // No row = at least one endpoint is unreadable (absent, or a NULL timestamp, which makes
  // the comparison NULL). Either way we did not measure it — the third state, kept separate.
  if (rows.length === 0 || rows[0].backwards === null) return 'unknown';
  return rows[0].backwards === true ? 'backwards' : 'ok';
}

export async function mintEdge(input: MintEdgeInput, pool: Pool = db): Promise<MintResult> {
  if (!isEdgeMintVia(input.via)) {
    throw new InvalidEdgeError(
      `Unknown mint via "${String(input.via)}". Every edge must name the path that minted ` +
        `it; allowed values are defined in config/edgeProvenanceConfig.ts (EDGE_MINT_VIA).`
    );
  }
  if (!isEdgeType(input.edgeType)) {
    throw new InvalidEdgeError(
      `Unknown edge_type "${input.edgeType}". Allowed values are defined in ` +
        `config/edgeTypes.ts (EDGE_TYPES).`
    );
  }
  if (!isEdgeNodeType(input.fromType) || !isEdgeNodeType(input.toType)) {
    throw new InvalidEdgeError(
      `from_type/to_type must each be one of ${EDGE_NODE_TYPES.join(', ')}.`
    );
  }
  if (input.fromId === input.toId) {
    throw new InvalidEdgeError('Self-links are not allowed (from and to are the same record).');
  }

  // CHRONOLOGY GUARD — at the CHOKE POINT, so every mint site inherits it.
  // Only edge types whose direction is a claim about time are checked; everything else
  // skips the extra round-trip entirely.
  let chronology: ChronologyVerdict | undefined;
  if (isChronologyOrderedEdgeType(input.edgeType)) {
    chronology = await checkEdgeChronology(input, pool);
    if (chronology === 'backwards') {
      // REFUSED, and said out loud. A silently-dropped edge is the failure mode this guard
      // replaces, not the one it introduces: the caller gets `refused` in the result AND
      // this warning names both endpoints so the mint site can be found from a log alone.
      logger.warn(
        `🔗 mint REFUSED (${BACKWARDS_IN_TIME_REASON}): ${input.edgeType} ` +
          `${input.fromType} ${input.fromId} → ${input.toType} ${input.toId} — the source is ` +
          `OLDER than the target, so this edge claims a record superseded its own successor.`,
        { metadata: { edgeType: input.edgeType, via: input.via, createdBy: input.createdBy ?? null } }
      );
      return { created: false, refused: BACKWARDS_IN_TIME_REASON, chronology };
    }
  }

  const result = await pool.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (from_id, to_id, edge_type) DO NOTHING
     RETURNING id, mint_via, provenance_class`,
    [
      input.fromId,
      input.fromType,
      input.toId,
      input.toType,
      input.edgeType,
      input.projectId ?? null,
      input.createdBy ?? null,
      input.via,
      JSON.stringify(input.metadata ?? {}),
    ]
  );

  if (result.rows.length > 0) {
    const r = result.rows[0];
    // mint_via / provenance_class are READ BACK from the inserted row, never echoed from the
    // input: provenance_class is a GENERATED column, so the only honest
    // source for it is the row itself — recomputing it here would be a second author for a
    // classification that exists exactly once, in SQL.
    return {
      created: true,
      edgeId: r.id,
      mintVia: r.mint_via ?? null,
      provenanceClass: r.provenance_class ?? null,
      ...(chronology ? { chronology } : {}),
    };
  }
  // Conflict → the edge already exists. Look up its id AND its provenance, so a dedup
  // reports the ORIGINAL minter's label rather than the label this call would have written.
  const existing = await pool.query(
    `SELECT id, mint_via, provenance_class FROM links
      WHERE from_id = $1 AND to_id = $2 AND edge_type = $3`,
    [input.fromId, input.toId, input.edgeType]
  );
  const e = existing.rows[0];
  return {
    created: false,
    edgeId: e?.id,
    mintVia: e?.mint_via ?? null,
    provenanceClass: e?.provenance_class ?? null,
    ...(chronology ? { chronology } : {}),
  };
}

/**
 * Remove ONE typed edge. Returns whether a row was deleted (idempotent), plus the removed
 * edge's id and endpoint TYPE.
 *
 * WHY id + toType (minor): the DELETE already knows both — the row is right
 * there — and the unlink route was throwing them away, answering a successful removal with
 * `connectedType:"unknown"` and an empty `edgeId`. Same class as the anchor-admission
 * defect this task fixed: reporting less than the code measured. They are OPTIONAL on the
 * return type so existing callers / test doubles that answer `{removed}` still satisfy it.
 *
 * Optional PROVENANCE GUARD: when `createdBy` is supplied, the delete only removes the
 * edge if its `created_by` matches — so an automated reconciler (e.g. the belief
 * adjudicator retracting a stale supersedes edge) can retract ONLY edges it minted and
 * never clobber a human-curated edge on the same (from,to,type). Omitted → unconditional
 * delete (backward-compatible with the previous signature).
 */
export async function unlinkEdge(
  input: { fromId: string; toId: string; edgeType: EdgeType; createdBy?: string },
  pool: Pool = db
): Promise<{
  removed: boolean;
  edgeId?: string | null;
  toType?: EdgeNodeType | null;
  /** The removed row's `links.mint_via` — null when nothing was removed. */
  mintVia?: string | null;
  /** The removed row's generated declared|guessed|unclassified — null when nothing was removed. */
  provenanceClass?: string | null;
}> {
  if (!isEdgeType(input.edgeType)) {
    throw new InvalidEdgeError(`Unknown edge_type "${input.edgeType}".`);
  }
  const result = await pool.query(
    `DELETE FROM links
       WHERE from_id = $1 AND to_id = $2 AND edge_type = $3
         AND ($4::text IS NULL OR created_by = $4)
     RETURNING id, to_type, mint_via, provenance_class`,
    [input.fromId, input.toId, input.edgeType, input.createdBy ?? null]
  );
  const row = result.rows[0];
  // to_type is DB-constrained to the edge-node domain; validate anyway rather than cast —
  // a value the domain does not recognize becomes null (honest), never a fabricated type.
  const toType = row && isEdgeNodeType(row.to_type) ? (row.to_type as EdgeNodeType) : null;
  // The DELETE already knows the provenance of the row it removed — the same reason the
  // e1d42c96 minor added id + to_type here. A removal that cannot say WHAT it removed is a
  // repair with no receipt, and `unlink` ADVERTISES both fields in its output schema.
  return {
    removed: result.rows.length > 0,
    edgeId: row?.id ?? null,
    toType,
    mintVia: row?.mint_via ?? null,
    provenanceClass: row?.provenance_class ?? null,
  };
}

/** Title/label columns per entity for hydrating a connected node (best-effort). */
const TITLE_SELECT: Record<EdgeNodeType, { table: string; expr: string }> = {
  task: { table: 'tasks', expr: 'title' },
  decision: { table: 'technical_decisions', expr: 'title' },
  // Contexts have no title — use a short content snippet so a connected node is human-readable.
  context: { table: 'contexts', expr: "left(regexp_replace(content, '\\s+', ' ', 'g'), 60)" },
};

/**
 * Read a record's edges in BOTH directions, hydrating the connected record's
 * id/type/title. This is what T2b trust + T3 recall_thread consume (zero raw SQL for
 * the consumer). Optionally restrict to a direction and/or a set of edge types.
 *
 * @param id          the record id (full UUID expected; resolve short ids upstream)
 * @param direction   'out' (record is from), 'in' (record is to), or 'both' (default)
 * @param edgeTypes   restrict to these edge types (default: all)
 */
/** One EXISTING edge whose direction contradicts its endpoints' chronology. */
export interface BackwardsEdge {
  edgeId: string;
  edgeType: string;
  mintVia: string | null;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  /** When the EDGE was minted — the axis that says whether a guard was live at the time. */
  edgeCreatedAt: string;
}

/**
 * FIND EXISTING BACKWARDS EDGES — the detection half. `mintEdge` stops new
 * ones; this reports the ones already in the table.
 *
 * READ-ONLY BY CONSTRUCTION: it is a SELECT and there is no repair sibling. Rewriting or
 * deleting historical edges is a separate, consequential decision about somebody's recorded
 * history, and bundling it into the same function as the count is how a report becomes a
 * migration by accident.
 *
 * THE PREDICATE IS THE SAME ONE THE GUARD ENFORCES: the edge-type set and the per-entity
 * timestamp source are read from config/edgeChronologyConfig.ts, and the comparison is the
 * same `(ts, id) <` total order as {@link checkEdgeChronology}. A second hand-written copy
 * of "what backwards means" would let the detector and the guard disagree — which is the
 * exact shape of the defect being fixed, one level up.
 */
export async function findBackwardsEdges(pool: Pool = db): Promise<BackwardsEdge[]> {
  const nodeUnion = EDGE_NODE_TYPES.map((t) => {
    const src = ENTITY_CREATED_AT[t];
    return `SELECT id, ${src.column} AS ts FROM ${src.table}`;
  }).join(' UNION ALL ');
  const { rows } = await pool.query(
    `WITH node AS (${nodeUnion})
     SELECT l.id, l.edge_type, l.mint_via, l.from_id, l.from_type, l.to_id, l.to_type,
            l.created_at
       FROM links l
       JOIN node f ON f.id = l.from_id
       JOIN node t ON t.id = l.to_id
      WHERE l.edge_type = ANY($1::text[])
        AND (f.ts, f.id) < (t.ts, t.id)
      ORDER BY l.created_at DESC`,
    [CHRONOLOGY_ORDERED_EDGE_TYPES as readonly string[]]
  );
  return rows.map((r) => ({
    edgeId: r.id,
    edgeType: r.edge_type,
    mintVia: r.mint_via ?? null,
    fromId: r.from_id,
    fromType: r.from_type,
    toId: r.to_id,
    toType: r.to_type,
    edgeCreatedAt: r.created_at?.toISOString?.() ?? String(r.created_at),
  }));
}

export async function getLinks(
  id: string,
  opts: { direction?: 'out' | 'in' | 'both'; edgeTypes?: EdgeType[] } = {},
  pool: Pool = db
): Promise<ConnectedEdge[]> {
  const direction = opts.direction ?? 'both';
  const edgeTypes = opts.edgeTypes?.filter(isEdgeType);

  const rows: ConnectedEdge[] = [];

  // Forward edges: this record is from_id; the connected node is to_id/to_type.
  if (direction === 'out' || direction === 'both') {
    rows.push(...(await fetchDirection(id, 'out', edgeTypes, pool)));
  }
  // Reverse edges: this record is to_id; the connected node is from_id/from_type.
  if (direction === 'in' || direction === 'both') {
    rows.push(...(await fetchDirection(id, 'in', edgeTypes, pool)));
  }
  return rows;
}

async function fetchDirection(
  id: string,
  direction: 'out' | 'in',
  edgeTypes: EdgeType[] | undefined,
  pool: Pool
): Promise<ConnectedEdge[]> {
  // Which column is THIS record, which is the CONNECTED node.
  const selfCol = direction === 'out' ? 'from_id' : 'to_id';
  const connIdCol = direction === 'out' ? 'to_id' : 'from_id';
  const connTypeCol = direction === 'out' ? 'to_type' : 'from_type';

  const params: any[] = [id];
  let edgeTypeFilter = '';
  if (edgeTypes && edgeTypes.length > 0) {
    params.push(edgeTypes);
    edgeTypeFilter = ` AND edge_type = ANY($${params.length})`;
  }

  const linkRows = (
    await pool.query(
      `SELECT id, edge_type, ${connIdCol} AS conn_id, ${connTypeCol} AS conn_type,
              mint_via, provenance_class, metadata
       FROM links
       WHERE ${selfCol} = $1${edgeTypeFilter}
       ORDER BY created_at ASC`,
      params
    )
  ).rows;

  // Hydrate titles per connected node (best-effort; a missing referent yields null title).
  const out: ConnectedEdge[] = [];
  for (const r of linkRows) {
    const connType = r.conn_type as EdgeNodeType;
    let title: string | null = null;
    if (isEdgeNodeType(connType)) {
      const t = TITLE_SELECT[connType];
      try {
        const titleRow = await pool.query(
          `SELECT ${t.expr} AS label FROM ${t.table} WHERE id = $1`,
          [r.conn_id]
        );
        title = titleRow.rows[0]?.label ?? null;
      } catch {
        title = null; // referent gone / unreadable → leave null, never throw
      }
    }
    out.push({
      edgeType: r.edge_type as EdgeType,
      direction,
      connectedId: r.conn_id,
      connectedType: connType,
      connectedTitle: title,
      edgeId: r.id,
      mintVia: r.mint_via ?? null,
      provenanceClass: r.provenance_class ?? null,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {},
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-MINT (Q3 — the near-free path that makes the graph dense)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tag→edge mapping now lives in config/tagEdgeConfig.ts as an EXPLICIT 9-cell matrix
 * keyed by (source record type, tag prefix) — see that file for why it became
 * source-dependent (an earlier task Q1). It is re-exported here as the single import point the
 * rest of this service uses, so there is exactly ONE mapping in the codebase.
 */

/**
 * True iff `tags` carries at least one TRUST-BEARING threading tag — `task:<ref>` (→ `informs`)
 * or `decision:<ref>` (→ `decided_by`). These are the two tags that compete with the active
 * anchor's own trust edge, so an explicit one is the caller STATING their thread intent.
 *
 * Used by the context_store route as a precedence signal: an explicit
 * `task:`/`decision:` threading tag OUTRANKS the active-thread anchor, so the anchor does not
 * ALSO mint a competing (and possibly stale/unrelated) edge — "explicit tag > active anchor".
 * `context:` (→ `learned_from`, off the trust walk) is a different dimension and does NOT
 * suppress the anchor, so it is deliberately excluded.
 *
 * Reuses {@link tagToEdgeIntent} — the ONE tag→edge mapping — so the precedence check can
 * never drift from what autoMintFromTags actually mints.
 *
 * SOURCE-AWARE: `sourceType` is REQUIRED, with NO default. Whether a tag is
 * trust-bearing now depends on WHO wrote it — `task:` mints the trust-bearing `informs` from a
 * context/decision but the weak, non-trust-bearing `related_to` from a TASK. A default
 * parameter here would silently apply the context row's answer to every future source type,
 * which is precisely the bug class the matrix exists to kill.
 *
 * The predicate is now derived from the MINTED EDGE TYPE against the two edges the ANCHOR
 * itself mints (autoThreadConfig ACTIVE_TASK_EDGE_TYPE / ACTIVE_DECISION_EDGE_TYPE), rather
 * than the old proxy ("the referent is a task or decision"). That is the honest basis: this
 * signal exists to answer "would this tag mint an edge that COMPETES with the anchor's?", and
 * competing means minting the same edge the anchor would.
 *
 * NOTE it is deliberately NOT derived from trust.ts OUTCOME_OUT_EDGE_TYPES, even though that
 * reads like the natural choice. `learned_from` IS an outcome edge, but `context:` tags are
 * documented as NOT suppressing the anchor (a different dimension) — deriving from the trust
 * set would silently flip that established behaviour.
 *
 * The correction the source-awareness buys: a task's `task:` tag mints the weak `related_to`,
 * which competes with nothing, so it no longer suppresses the anchor. The old proxy said it did.
 */
export function hasTrustThreadingTag(
  tags: string[] | undefined,
  sourceType: EdgeNodeType,
): boolean {
  const anchorEdgeTypes: readonly string[] = [ACTIVE_TASK_EDGE_TYPE, ACTIVE_DECISION_EDGE_TYPE];
  for (const tag of tags ?? []) {
    const intent = tagToEdgeIntent(sourceType, tag);
    if (intent && anchorEdgeTypes.includes(intent.edgeType)) return true;
  }
  return false;
}

/**
 * The MACHINE-READABLE reason a referent did not become an edge. The `reason` string is for
 * a human and is free to be reworded; a consumer (or a contract test) that needs to branch on
 * WHY reads this instead, so nobody ends up substring-matching prose.
 *   bad_id_shape       — not a usable id at all (too short / non-hex).
 *   not_found          — matched no record anywhere we looked.
 *   cross_project_ref  — the record EXISTS, in another project, and the ref was a short id.
 *   ambiguous          — the prefix matched several records in scope.
 *   self_link          — the referent is the record being written.
 *   unresolved         — anything else the resolver refused.
 *   mint_failed        — resolution succeeded but writing the edge threw.
 */
export type MintSkipCode =
  | 'bad_id_shape'
  | 'not_found'
  | 'cross_project_ref'
  | 'ambiguous'
  | 'self_link'
  | 'unresolved'
  | 'mint_failed';

/**
 * The PROVENANCE stamped on a link whose endpoint lives in a different project from the
 * record that wrote it. Absent (an empty spread) on the ordinary same-project mint, so a
 * normal edge's metadata is byte-identical to before.
 *
 * WHY ON THE EDGE AND NOT ONLY IN A LOG: `links.project_id` records the WRITER's project, so
 * without this the row is indistinguishable from an in-project edge, and the one question a
 * later audit will ask — "which of our edges cross a project boundary?" — has no answer in
 * the data. It is queryable: `metadata->>'cross_project' = 'true'`.
 */
function crossProjectMetadata(hit: CrossProjectHit | undefined): Record<string, unknown> {
  if (!hit) return {};
  return {
    cross_project: true,
    to_project_id: hit.projectId,
    to_project_name: hit.projectName,
    // Recorded because a cross-project edge is ONLY mintable from a full uuid; if this ever
    // reads anything else, the guard has been widened and this row is the evidence.
    cross_project_ref_form: 'uuid',
  };
}

/** Why a referent did not become an edge — surfaced to the caller, never swallowed. */
export interface MintSkip {
  /** The referent as written (the tag's value / the link spec's ref). */
  ref: string;
  /** The endpoint kind the referent was resolved against. */
  toType: EdgeNodeType;
  /** Human-readable reason (not found / ambiguous / cross-project / self-link). */
  reason: string;
  /** The machine-readable classification of `reason`. */
  code: MintSkipCode;
}

/**
 * Resolve a referent (id8 or full uuid) to a full uuid, project-scoped, returning null
 * (NEVER throwing) when it can't be resolved — a bad/typo'd/ambiguous ref must NOT break
 * the write; it simply doesn't mint that edge.
 *
 * FULL-UUID GUARD: resolution goes through resolveMintEndpoint, which —
 * unlike the old `if (isFullUuid(ref)) return ref` short-circuit — existence- AND
 * project-checks a full UUID exactly as it does an id8. Before this, a pasted/typo'd UUID
 * minted a DANGLING edge (no FK backstop on `links`) and a UUID from another project minted
 * a CROSS-PROJECT edge. See the resolveMintEndpoint doc for the full class.
 *
 * DENY + SURFACE: the reason is returned (not just logged at debug) so the caller can put
 * the skip in its response. A silently-swallowed skip is how the original hole stayed
 * invisible — the write still succeeds, but the user is TOLD their ref minted nothing.
 */
async function resolveRefSafe(
  toType: EdgeNodeType,
  ref: string,
  projectId: string | undefined,
  pool: Pool
): Promise<{ id: string; crossProject?: CrossProjectHit } | { skip: string; skipCode: MintSkipCode }> {
  try {
    return { id: await resolveMintEndpoint(toType, ref, projectId, pool) };
  } catch (e) {
    // ── CROSS-PROJECT: the referent may be real, just not HERE ────────────────────────
    // Measured on the dev snapshot: 25 of 25 `task:<id8>` tags whose referent lives in a
    // sibling project minted zero edges, and the message ("not found in this project")
    // named neither the project it IS in nor any way to reach it. Two different answers are
    // owed, and they are NOT the same answer:
    //
    //   FULL UUID → unambiguous by construction. Mint the edge, and record the crossing on
    //     the link's metadata so the provenance is inspectable rather than inferred.
    //   SHORT ID  → an 8-char prefix is NOT unique across projects. Resolving it here would
    //     mint an edge to whichever row happened to match — the exact wrong-edge class the
    //     mint guard exists to prevent. It still dies. It just dies LOUD, naming the project
    //     the record lives in and the full id to pass instead.
    if (e instanceof IdNotFoundError && !e.reason && projectId) {
      const hits = await probeCrossProject(toType, ref, pool);
      if (hits.length > 0) {
        if (isFullUuid(ref) && hits.length === 1) {
          logger.debug(`🔗 auto-mint: cross-project ${toType} ${ref} resolved by full uuid`);
          return { id: hits[0].id, crossProject: hits[0] };
        }
        const where = hits
          .map((h) => `${h.projectName ?? h.projectId} (${h.id})`)
          .slice(0, 5)
          .join(', ');
        const skip =
          `${toType} "${ref}" is not in this project — it matches ${hits.length} record(s) in: ${where}. ` +
          `A short id is not unique across projects, so no edge was minted. ` +
          `Re-tag with the FULL uuid (${toType}:${hits[0].id}) to link across projects.`;
        logger.debug(`🔗 auto-mint: skipped ${skip} — write unaffected`);
        return { skip, skipCode: 'cross_project_ref' };
      }
    }

    const shapeRejected = e instanceof IdNotFoundError && Boolean(e.reason);
    const reason =
      e instanceof IdNotFoundError
        ? // A shape rejection (too short / non-hex) carries its own reason — surface THAT
          // rather than "not found", which would send the writer hunting for a record that
          // was never the problem.
          (e.reason
            ? `${toType} ref "${ref}" is not a usable id — ${e.reason}`
            : `${toType} "${ref}" not found in this project`)
        : e instanceof AmbiguousIdError
          ? `${toType} "${ref}" is ambiguous (${e.candidates.length} matches) — use the full id`
          : `${toType} "${ref}" could not be resolved`;
    const skipCode: MintSkipCode = shapeRejected
      ? 'bad_id_shape'
      : e instanceof IdNotFoundError
        ? 'not_found'
        : e instanceof AmbiguousIdError
          ? 'ambiguous'
          : 'unresolved';
    logger.debug(`🔗 auto-mint: skipped ${reason} — write unaffected`);
    return { skip: reason, skipCode };
  }
}

/**
 * AUTO-MINT from a record's threading tags (called from context_store / decision_record
 * AFTER the row is persisted). Mints typed edges for every resolvable threading tag.
 *
 * ROBUSTNESS CONTRACT (non-negotiable): this NEVER throws. A bad tag, an unresolvable
 * referent, or a DB hiccup minting one edge must not break (or roll back) the user's
 * write. Each edge is minted independently; failures are logged and swallowed. Returns
 * the count of edges newly created (for observability/tests).
 */
export async function autoMintFromTags(
  args: {
    fromId: string;
    fromType: EdgeNodeType;
    tags: string[] | undefined;
    projectId: string | undefined;
    createdBy: string;
  },
  pool: Pool = db
): Promise<{
  minted: number;
  attempted: number;
  skips: MintSkip[];
  /** Each edge minted-or-deduped, with the tag that minted it. */
  edges: Array<MintedEdge & { sourceTag: string }>;
}> {
  let minted = 0;
  let attempted = 0;
  const skips: MintSkip[] = [];
  const edges: Array<MintedEdge & { sourceTag: string }> = [];
  for (const tag of args.tags ?? []) {
    // SOURCE-DEPENDENT: the edge a tag mints depends on the record type
    // writing it — see config/tagEdgeConfig.ts. Deny-by-default: a tag whose (source, prefix)
    // pair has no cell mints NOTHING and never falls back to another row's semantics.
    const intent = tagToEdgeIntent(args.fromType, tag);
    if (!intent) continue;
    attempted++;
    try {
      const resolved = await resolveRefSafe(intent.toType, intent.ref, args.projectId, pool);
      if ('skip' in resolved) {
        // DENY + SURFACE: unresolvable → no edge, and the reason is
        // RETURNED so the caller can show it. Never a silent swallow.
        skips.push({
          ref: intent.ref,
          toType: intent.toType,
          reason: resolved.skip,
          code: resolved.skipCode,
        });
        continue;
      }
      const toId = resolved.id;
      if (toId === args.fromId) {
        skips.push({
          ref: intent.ref,
          toType: intent.toType,
          reason: 'self-link skipped (a record cannot link to itself)',
          code: 'self_link',
        });
        continue;
      }
      const res = await mintEdge(
        {
          fromId: args.fromId,
          fromType: args.fromType,
          toId,
          toType: intent.toType,
          edgeType: intent.edgeType,
          projectId: args.projectId ?? null,
          createdBy: args.createdBy,
          via: EDGE_MINT_VIA.tag,
          // `source_tag` STAYS: it is the RAW TAG TEXT (a detail), not a label from a closed
          // set. See edgeProvenanceConfig.ts, axis 2 — folding it into mint_via would make
          // the label's domain open and destroy the countability this column exists for.
          metadata: { source_tag: tag, ...crossProjectMetadata(resolved.crossProject) },
        },
        pool
      );
      edges.push({ edgeType: intent.edgeType, toType: intent.toType, toId, created: res.created, sourceTag: tag });
      if (res.created) minted++;
    } catch (e) {
      // A single edge failing must never break the write.
      const reason = `failed to mint edge (${(e as Error)?.message ?? 'error'})`;
      skips.push({ ref: intent.ref, toType: intent.toType, reason, code: 'mint_failed' });
      logger.warn(`🔗 auto-mint: failed to mint edge for tag "${tag}" — write unaffected`, {
        metadata: { error: (e as Error)?.message },
      });
    }
  }
  return { minted, attempted, skips, edges };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPLICIT LINKS (T5a — the first-class `links` write parameter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One explicit link spec as it arrives from a context_store / decision_record call.
 * EITHER form is accepted (the zod schema is the authority on shape):
 *   (a) EXPLICIT  — { edgeType, to, toType }
 *   (b) SHORTHAND — { task } | { decision } | { context }  (a single referent ref)
 * The shorthand keys map to the SAME edges the threading-tag path mints, via
 * tagToEdgeIntent (so the two surfaces can never drift): task→informs,
 * decision→decided_by, context→learned_from.
 */
export interface LinkSpec {
  edgeType?: string;
  to?: string;
  toType?: EdgeNodeType;
  task?: string;
  decision?: string;
  context?: string;
}

/** A rejected explicit link, surfaced as a per-link WARNING (the write still succeeds). */
export interface LinkWarning {
  /** Human-readable reason the link was rejected. */
  reason: string;
  /** The offending spec (echoed back so the caller can see what was dropped). */
  spec: LinkSpec;
}

export interface MintExplicitResult {
  /** Edges newly created. */
  minted: number;
  /** Edges attempted (resolved + shape-valid; includes dedup no-ops). */
  attempted: number;
  /** One warning per REJECTED link (bad edge type / unresolvable ref / self-link). */
  warnings: LinkWarning[];
  /** Each edge minted-or-deduped, for the unified store-response report. */
  edges: MintedEdge[];
}

/**
 * Normalize one LinkSpec to a concrete edge intent (edgeType + toType + referent), or a
 * rejection reason. The SHORTHAND keys reuse tagToEdgeIntent by constructing the
 * equivalent threading tag (`task:<ref>` etc.) so the shorthand→edge mapping is literally
 * the SAME code path as the tag mapping — it cannot drift (one definition).
 */
function normalizeLinkSpec(
  spec: LinkSpec,
  sourceType: EdgeNodeType
): { edgeType: EdgeType; toType: EdgeNodeType; ref: string } | { reject: string } {
  // SHORTHAND: exactly one of task/decision/context. Reuse tagToEdgeIntent's mapping —
  // SOURCE-AWARE, so `{ task: X }` written BY a task yields the same weak
  // `related_to` the `task:X` TAG would. The two surfaces still cannot drift; they now agree
  // on the source-dependent answer instead of a source-blind one.
  const shorthandKey = (['task', 'decision', 'context'] as const).find(
    (k) => spec[k] !== undefined && spec[k] !== null && spec[k] !== ''
  );
  if (shorthandKey) {
    const ref = String(spec[shorthandKey]);
    const intent = tagToEdgeIntent(sourceType, `${shorthandKey}:${ref}`);
    if (!intent) return { reject: `shorthand "${shorthandKey}" did not map to a known edge` };
    return { edgeType: intent.edgeType, toType: intent.toType, ref: intent.ref };
  }

  // EXPLICIT: edgeType + to + toType. (The zod schema already shape-validates the union;
  // this is defense-in-depth so the service is correct even if called directly.)
  if (spec.edgeType && spec.to && spec.toType) {
    if (!isEdgeType(spec.edgeType)) {
      return { reject: `unknown edgeType "${spec.edgeType}" (see config/edgeTypes.ts)` };
    }
    if (!isEdgeNodeType(spec.toType)) {
      return { reject: `unknown toType "${spec.toType}" (must be context|decision|task)` };
    }
    // tagToEdgeIntent lower-cases its ref; do the same for an explicit ref so an id8 with
    // upper-case hex still resolves identically to the tag/shorthand path.
    return { edgeType: spec.edgeType, toType: spec.toType, ref: spec.to.trim().toLowerCase() };
  }

  return { reject: 'link must be either { edgeType, to, toType } or { task|decision|context: <ref> }' };
}

/**
 * MINT EXPLICIT LINKS from a context_store / decision_record `links` parameter (called
 * AFTER the new record is persisted). Each spec is resolved + minted INDEPENDENTLY via
 * mintEdge, reusing resolveRefSafe (project-scoped id8→uuid) so the resolution rules
 * match the tag/shorthand path exactly.
 *
 * ROBUSTNESS CONTRACT (T5a): a bad/unresolvable/typo'd ref or an invalid edgeType must
 * NEVER break or roll back the user's write. UNLIKE the silent tag path, `links` is
 * EXPLICIT user intent — so each rejected link is returned as a WARNING (the caller
 * surfaces it). The record still saves; every GOOD link still mints. This function never
 * throws: a per-link failure becomes a warning, not an exception.
 */
export async function mintExplicitLinks(
  args: {
    fromId: string;
    fromType: EdgeNodeType;
    links: LinkSpec[] | undefined;
    projectId: string | undefined;
    createdBy: string;
  },
  pool: Pool = db
): Promise<MintExplicitResult> {
  const warnings: LinkWarning[] = [];
  const edges: MintedEdge[] = [];
  let minted = 0;
  let attempted = 0;

  for (const spec of args.links ?? []) {
    const norm = normalizeLinkSpec(spec, args.fromType);
    if ('reject' in norm) {
      warnings.push({ reason: norm.reject, spec });
      continue;
    }
    try {
      const resolved = await resolveRefSafe(norm.toType, norm.ref, args.projectId, pool);
      if ('skip' in resolved) {
        // The guard's reason is more specific than the old generic message (it
        // distinguishes not-found from ambiguous), so surface IT rather than a paraphrase.
        warnings.push({ reason: resolved.skip, spec });
        continue;
      }
      const toId = resolved.id;
      if (toId === args.fromId) {
        warnings.push({ reason: 'self-link skipped (a record cannot link to itself)', spec });
        continue;
      }
      attempted++;
      const res = await mintEdge(
        {
          fromId: args.fromId,
          fromType: args.fromType,
          toId,
          toType: norm.toType,
          edgeType: norm.edgeType,
          projectId: args.projectId ?? null,
          createdBy: args.createdBy,
          via: EDGE_MINT_VIA.linksParam,
          metadata: { ...crossProjectMetadata(resolved.crossProject) },
        },
        pool
      );
      edges.push({ edgeType: norm.edgeType, toType: norm.toType, toId, created: res.created });
      if (res.created) minted++;
    } catch (e) {
      // A single edge failing must never break the write — surface it as a warning.
      const reason =
        e instanceof InvalidEdgeError
          ? e.message
          : `failed to mint link (${(e as Error)?.message ?? 'error'})`;
      warnings.push({ reason, spec });
      logger.warn(`🔗 links: rejected explicit link — write unaffected`, {
        metadata: { reason, error: (e as Error)?.message },
      });
    }
  }

  return { minted, attempted, warnings, edges };
}

// (The AUTO-THREAD anchor minter — autoThreadFromActiveAnchor, T5b — was DELETED here by
// PHASE 1 positional membership. The anchor is retired:
// its write-path replacement is services/positionalMint.ts, and migration 080's D1 demoted
// its historical strong mints to the weak tier.)

/**
 * AUTO-MINT `depends_on` edges from a task's `dependencies` COLUMN (an earlier task Q3).
 *
 * THE COLUMN STAYS; THE EDGE MIRRORS IT. This is NOT a new pattern — autoMintFromDecision
 * does exactly this for superseded_by ("the COLUMN is kept (additive); the edge mirrors it").
 * One reconciliation model, not two.
 *
 * WHY MIRROR AND NOT MIGRATE. `dependencies` is verified WRITE-ONCE today (task_update
 * cannot touch it) and nothing reads it for logic, so the drift disease is CONTAINED and a
 * mirror-at-create covers 100% of existing writes. Making edges the authority instead would
 * be a read-path rework across two services for zero user-visible gain — tracked as a
 * post-launch deferral, deliberately not done here.
 *
 * FOR THE FUTURE EDITOR: when `dependencies` becomes editable, this mirror SHOULD reconcile
 * (remove edges for removed deps). That is SAFE to implement because unlinkEdge has a
 * provenance guard (createdBy match) — a reconciler passing TASK_EDGE_CREATED_BY.taskDeps
 * retracts only edges IT minted and can never destroy a human-curated `depends_on` on the
 * same pair. Do not reconcile without that guard.
 *
 * Refs are resolved through the SAME guarded mint-endpoint path as everything else, so a
 * dependency pointing at a nonexistent or cross-project task mints nothing and is surfaced
 * as a skip. Same robustness contract as autoMintFromTags: NEVER throws.
 */
export async function autoMintFromTaskDependencies(
  args: {
    taskId: string;
    /** The dependency refs (already resolved to full UUIDs by the route, but re-checked). */
    dependencies: string[] | undefined;
    projectId: string | undefined;
    createdBy: string;
  },
  pool: Pool = db
): Promise<{ minted: number; attempted: number; skips: MintSkip[] }> {
  let minted = 0;
  let attempted = 0;
  const skips: MintSkip[] = [];

  for (const rawRef of args.dependencies ?? []) {
    const ref = String(rawRef ?? '').trim().toLowerCase();
    if (!ref) continue;
    attempted++;
    try {
      const resolved = await resolveRefSafe('task', ref, args.projectId, pool);
      if ('skip' in resolved) {
        skips.push({ ref, toType: 'task', reason: resolved.skip, code: resolved.skipCode });
        continue;
      }
      if (resolved.id === args.taskId) {
        skips.push({
          ref,
          toType: 'task',
          reason: 'self-dependency skipped (a task cannot depend on itself)',
          code: 'self_link',
        });
        continue;
      }
      const res = await mintEdge(
        {
          fromId: args.taskId,
          fromType: 'task',
          toId: resolved.id,
          toType: 'task',
          edgeType: 'depends_on',
          projectId: args.projectId ?? null,
          createdBy: args.createdBy,
          // The COLUMN mirror (not a tag) — that distinction now lives in mint_via, which is
          // what a future reconciler keys on alongside the createdBy provenance stamp.
          via: EDGE_MINT_VIA.taskDependencies,
          metadata: { ref, ...crossProjectMetadata(resolved.crossProject) },
        },
        pool
      );
      if (res.created) minted++;
    } catch (e) {
      const reason = `failed to mint depends_on edge (${(e as Error)?.message ?? 'error'})`;
      skips.push({ ref, toType: 'task', reason, code: 'mint_failed' });
      logger.warn(`🔗 auto-mint: failed depends_on edge for dependency "${ref}"`, {
        metadata: { error: (e as Error)?.message },
      });
    }
  }

  return { minted, attempted, skips };
}

/**
 * AUTO-MINT decision-specific edges (called from decision_record / decision_update):
 *   - evidence/parent ids carried in metadata (metadata.evidence: [id...] and
 *     metadata.learned_from: [id...]) → `learned_from` edges (decision → referent).
 *   - supersededBy (decision.superseded_by) → a `supersedes` edge (this decision →
 *     the decision it supersedes). The superseded_by COLUMN is kept (additive); the
 *     edge mirrors it so the graph carries the supersession structurally too.
 *
 * Same robustness contract as autoMintFromTags: NEVER throws; unresolvable refs skipped.
 */
export async function autoMintFromDecision(
  args: {
    decisionId: string;
    metadata: Record<string, any> | undefined;
    supersededBy?: string | null;
    projectId: string | undefined;
    createdBy: string;
  },
  pool: Pool = db
): Promise<{ minted: number; attempted: number }> {
  let minted = 0;
  let attempted = 0;

  // Collect evidence/parent ids from metadata (tolerant of string-or-array shapes).
  const evidenceRefs = new Set<string>();
  const meta = args.metadata ?? {};
  for (const key of ['evidence', 'learned_from', 'evidence_ids', 'parents']) {
    const v = (meta as any)[key];
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') evidenceRefs.add(x);
    else if (typeof v === 'string') evidenceRefs.add(v);
  }

  for (const ref of evidenceRefs) {
    attempted++;
    try {
      // Evidence is most often a decision or context; try decision first, then context.
      // NOTE: now that resolveRefSafe existence-checks a full UUID, this
      // two-step fallback finally does what it always READ like it did — pre-guard, a full
      // UUID "resolved" as a decision unconditionally, so an evidence ref pointing at a
      // CONTEXT was mis-typed as toType 'decision' and the context branch was dead code.
      let toType: EdgeNodeType = 'decision';
      let resolved = await resolveRefSafe('decision', ref, args.projectId, pool);
      if ('skip' in resolved) {
        resolved = await resolveRefSafe('context', ref, args.projectId, pool);
        toType = 'context';
      }
      if ('skip' in resolved) continue;
      const toId = resolved.id;
      if (toId === args.decisionId) continue;
      const res = await mintEdge(
        {
          fromId: args.decisionId,
          fromType: 'decision',
          toId,
          toType,
          edgeType: 'learned_from',
          projectId: args.projectId ?? null,
          createdBy: args.createdBy,
          via: EDGE_MINT_VIA.decisionEvidence,
          metadata: {
            ref,
            ...crossProjectMetadata('skip' in resolved ? undefined : resolved.crossProject),
          },
        },
        pool
      );
      if (res.created) minted++;
    } catch (e) {
      logger.warn(`🔗 auto-mint: failed learned_from edge for evidence "${ref}"`, {
        metadata: { error: (e as Error)?.message },
      });
    }
  }

  // Supersession: mirror superseded_by → a `supersedes` edge (this → target).
  if (args.supersededBy) {
    attempted++;
    try {
      const resolved = await resolveRefSafe('decision', args.supersededBy, args.projectId, pool);
      const toId = 'skip' in resolved ? null : resolved.id;
      if (toId && toId !== args.decisionId) {
        const res = await mintEdge(
          {
            fromId: args.decisionId,
            fromType: 'decision',
            toId,
            toType: 'decision',
            edgeType: 'supersedes',
            projectId: args.projectId ?? null,
            createdBy: args.createdBy,
            via: EDGE_MINT_VIA.decisionSupersededBy,
            metadata: {},
          },
          pool
        );
        if (res.created) minted++;
      }
    } catch (e) {
      logger.warn(`🔗 auto-mint: failed supersedes edge for "${args.supersededBy}"`, {
        metadata: { error: (e as Error)?.message },
      });
    }
  }

  return { minted, attempted };
}
