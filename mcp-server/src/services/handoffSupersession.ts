/**
 * HANDOFF SUPERSESSION MINTING — the trunk's own declared-edge feed (PHASE 2 item g,
 * an earlier task; folded from an earlier change / D5-A; tree model).
 *
 * THE MODEL: the TRUNK is the project's handoff TIMELINE — time orders it, always
 * (an earlier change: a naive supersedes walk measured 22,482,181 rows; supersedes is
 * CORROBORATION, never ordering). But the corroboration itself was starved: at the
 * measured baseline only 177 of 1,249 handoff-chain links (14.2%) were DECLARED. This
 * service closes that at the WRITE: storing a new handoff deterministically mints ONE
 * declared `supersedes` edge from the new handoff to the project's previous newest
 * handoff. No similarity, no judgment call — pure created_at adjacency, which is why the
 * stamp is DECLARED-grade: the predecessor is structurally named, not guessed.
 *
 * TRUST CONSEQUENCE (deliberate): services/trust.ts classifies a `supersedes` edge whose
 * created_by is not the belief adjudicator as a DECLARED supersession → the superseded
 * handoff hard-caps to band 'superseded'. That is the semantic we want: the newest
 * handoff IS the resume point; a superseded handoff is kept for lineage, not for acting on.
 *
 * WHICH PREDECESSOR (an earlier task — the 2026-10-23/24 cross-lane flip-flop, six edges):
 *   1. EXPLICIT wins. A `supersedes:<id8|uuid>` tag naming a live handoff in the same
 *      project (any lane), or failing that EXACTLY ONE `context:<id>` tag that resolves to a
 *      live handoff in the SAME EXACT LANE, is the target; the timeline is not consulted.
 *   2. Otherwise the TIMELINE, paired on the EXACT lane tag: untagged pairs only with
 *      untagged, `ws:x` only with `ws:x`. The read rule (mandrel_handoff_lane maps untagged
 *      to the default lane, which the boot hook depends on) is NOT the write rule — pairing
 *      on it let a session that forgot its `ws:` tag silently supersede the coordinator's head.
 *   An untagged handoff is said out loud in the report (warning), whichever path ran.
 *   Provenance is identical on both paths (created_by / via); metadata.predecessor_source
 *   records which path named the target, so the lane repair can leave a deliberate
 *   `supersedes:` cross-lane edge alone.
 *
 * ROBUSTNESS: mintHandoffSupersession NEVER throws — the handoff row is already
 * persisted; a failed corroboration mint must not break or roll back the store (same
 * contract as positionalMint / tag minting).
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { mintEdge } from './links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import {
  READ_HANDOFF_LANE_TAG_PREFIX,
  READ_HANDOFF_DEFAULT_LANE,
  READ_HANDOFF_SUPERSEDES_TAG_PREFIX,
} from '../config/handoffLaneConfig.js';
import { tagToEdgeIntent } from '../config/tagEdgeConfig.js';
import { resolveMintEndpoint, AmbiguousIdError, IdNotFoundError } from '../utils/idResolver.js';

/**
 * The provenance stamp for a handoff-timeline supersession edge. DECLARED in the
 * link_provenance view (migration 081) — the target is structurally named (the project's
 * previous newest handoff), not similarity-guessed. Also DECLARED for trust.ts: any
 * `supersedes` created_by other than the belief adjudicator hard-caps.
 * Single source — never re-literal this string.
 */
export const HANDOFF_SUPERSESSION_CREATED_BY = 'auto:handoff-supersession';

/** The context_type whose writes feed the trunk timeline. */
export const TRUNK_CONTEXT_TYPE = 'handoff';

/**
 * Which path named the predecessor — stored on the edge as `metadata.predecessor_source`
 *. Single source — never re-literal.
 */
export const HANDOFF_PREDECESSOR_SOURCE = Object.freeze({
  supersedesTag: 'supersedes-tag',
  contextTag: 'context-tag',
  timeline: 'timeline',
} as const);
export type HandoffPredecessorSource =
  (typeof HANDOFF_PREDECESSOR_SOURCE)[keyof typeof HANDOFF_PREDECESSOR_SOURCE];
/**
 * The sources that may legitimately CROSS a lane — the repair's skip set
 * (services/handoffLaneRepair.ts). Only `supersedes:` is a deliberate cross-lane override; a
 * `context:` predecessor is same-lane by construction (round 2, Reviewer P7), so a
 * cross-lane edge claiming that source is a defect the repair must still delete.
 */
export const HANDOFF_CROSS_LANE_PREDECESSOR_SOURCES: readonly HandoffPredecessorSource[] = Object.freeze([
  HANDOFF_PREDECESSOR_SOURCE.supersedesTag,
]);

/** The honest report of what the handoff-supersession layer did for one write. */
export interface HandoffSupersessionReport {
  /** The predecessor handoff's id (null = nothing to mint: first in its lane, or refused). */
  predecessorId: string | null;
  /** True iff a NEW edge row was inserted (false on dedup or no predecessor). */
  created: boolean;
  /** Which path named the predecessor (null when none was minted). */
  source: HandoffPredecessorSource | null;
  /** Failure / attention surfacing (never thrown). Several notes are joined with '; '. */
  warning: string | null;
}

/** The untagged-handoff note (an earlier task item c). Exported so the contract test reads it. */
export function untaggedHandoffWarning(): string {
  return (
    'handoff has no workstream tag; paired only with untagged handoffs; ' +
    `the boot hook reads it as lane '${READ_HANDOFF_DEFAULT_LANE()}'`
  );
}

interface ExplicitPick {
  id: string | null;
  source: HandoffPredecessorSource | null;
  sourceTag: string | null;
  /** True when explicit intent CONFLICTS (several supersedes: targets): mint nothing at all. */
  blocked: boolean;
  notes: string[];
}

/**
 * Resolve the EXPLICIT predecessor named in the new handoff's own tags, or null.
 * `supersedes:` tags first (any lane — the one deliberate cross-lane override); only if none
 * of them names a live handoff, `context:` tags — and those only when EXACTLY ONE resolves to
 * a live handoff in the SAME EXACT LANE as the new one. A context: tag is also a plain
 * citation: citing another lane's head must never supersede it (Reviewer P7, which
 * reproduced the incident's harm through an ordinary citation), and two same-lane ones are
 * no statement of which one this replaces.
 * Unresolvable / ambiguous names are NOTED (surfaced in the report), never thrown.
 */
async function pickExplicitPredecessor(
  pool: Pool,
  selfId: string,
  projectId: string,
  tags: string[],
  lane: string | null
): Promise<ExplicitPick> {
  const notes: string[] = [];
  const supPrefix = READ_HANDOFF_SUPERSEDES_TAG_PREFIX().toLowerCase();
  const supRefs: Array<{ tag: string; ref: string }> = [];
  const ctxRefs: Array<{ tag: string; ref: string }> = [];
  for (const tag of tags) {
    const t = tag.trim().toLowerCase();
    if (t.startsWith(supPrefix)) {
      const ref = t.slice(supPrefix.length);
      if (ref) supRefs.push({ tag, ref });
      continue;
    }
    const intent = tagToEdgeIntent('context', tag);
    if (intent && intent.toType === 'context') ctxRefs.push({ tag, ref: intent.ref });
  }

  // ref -> uuid (project-scoped; id8 or full uuid), then keep only LIVE HANDOFFS other than self.
  // `sameLaneOnly`: also require the target's EXACT lane to equal the new handoff's — the same
  // mandrel_handoff_lane(..., NULL) IS NOT DISTINCT FROM rule the timeline pairs on.
  const liveHandoffs = async (
    refs: Array<{ tag: string; ref: string }>,
    reportMisses: boolean,
    sameLaneOnly: boolean
  ): Promise<Array<{ id: string; tag: string }>> => {
    const resolved: Array<{ id: string; tag: string }> = [];
    for (const r of refs) {
      try {
        resolved.push({ id: await resolveMintEndpoint('context', r.ref, projectId, pool), tag: r.tag });
      } catch (e) {
        if (!reportMisses) continue;
        notes.push(
          e instanceof AmbiguousIdError
            ? `tag '${r.tag}' is ambiguous (${e.candidates.length} matches) — use the full id`
            : e instanceof IdNotFoundError
              ? `tag '${r.tag}' names no context in this project`
              : `tag '${r.tag}' could not be resolved`
        );
      }
    }
    if (resolved.length === 0) return [];
    const live = await pool.query(
      `SELECT id::text AS id FROM contexts
        WHERE id = ANY($1::uuid[]) AND project_id = $2 AND context_type = $3
          AND archived_at IS NULL AND id <> $4
          AND (NOT $5::boolean
               OR mandrel_handoff_lane(tags, $6::text, NULL::text) IS NOT DISTINCT FROM $7::text)`,
      [
        resolved.map((r) => r.id),
        projectId,
        TRUNK_CONTEXT_TYPE,
        selfId,
        sameLaneOnly,
        READ_HANDOFF_LANE_TAG_PREFIX(),
        lane,
      ]
    );
    const liveIds = new Set(live.rows.map((row) => row.id as string));
    const out: Array<{ id: string; tag: string }> = [];
    for (const r of resolved) {
      if (liveIds.has(r.id)) {
        if (!out.some((o) => o.id === r.id)) out.push(r);
      } else if (reportMisses) {
        notes.push(`tag '${r.tag}' does not name a live handoff in this project`);
      }
    }
    return out;
  };

  const sup = await liveHandoffs(supRefs, true, false);
  if (sup.length === 1) {
    return { id: sup[0].id, source: HANDOFF_PREDECESSOR_SOURCE.supersedesTag, sourceTag: sup[0].tag, blocked: false, notes };
  }
  if (sup.length > 1) {
    // Conflicting explicit intent: never guess between them, and never fall back to the
    // timeline over a writer who named a predecessor. No edge; say why.
    notes.push(
      `${sup.length} '${supPrefix}' tags name different live handoffs (${sup.map((s) => s.id).join(', ')}) — no supersedes edge minted`
    );
    return { id: null, source: null, sourceTag: null, blocked: true, notes };
  }
  const ctx = await liveHandoffs(ctxRefs, false, true);
  if (ctx.length === 1) {
    return { id: ctx[0].id, source: HANDOFF_PREDECESSOR_SOURCE.contextTag, sourceTag: ctx[0].tag, blocked: false, notes };
  }
  if (ctx.length > 1) {
    notes.push(
      `${ctx.length} 'context:' tags name live same-lane handoffs — not a single explicit predecessor; ` +
        `using the timeline (tag '${supPrefix}<id>' to name one)`
    );
  }
  return { id: null, source: null, sourceTag: null, blocked: false, notes };
}

/**
 * Mint the declared `supersedes` edge for a just-stored handoff: to its EXPLICITLY named
 * predecessor when it names one, else to the newest earlier live handoff carrying the EXACT
 * same lane tag ((created_at, id) strictly before this one's — a total order). Bounded
 * queries + ONE idempotent insert — this path never reads the supersedes graph.
 *
 * Call ONLY for a just-persisted context whose context_type is 'handoff'
 * (the caller checks; asserted here fail-loud for defense in depth).
 */
export async function mintHandoffSupersession(input: {
  /** The just-persisted handoff context. */
  recordId: string;
  contextType: string;
  projectId: string | undefined;
  pool?: Pool;
}): Promise<HandoffSupersessionReport> {
  const pool = input.pool ?? db;
  const report: HandoffSupersessionReport = { predecessorId: null, created: false, source: null, warning: null };
  const notes: string[] = [];
  const finish = (): HandoffSupersessionReport => {
    report.warning = notes.length > 0 ? notes.join('; ') : null;
    return report;
  };
  try {
    if (input.contextType !== TRUNK_CONTEXT_TYPE) {
      // Defense in depth: minting a supersession off a non-handoff write would silently
      // hard-cap an unrelated record's trust. Loud in the report, never thrown.
      notes.push(`handoff supersession skipped: context_type '${input.contextType}' is not '${TRUNK_CONTEXT_TYPE}'`);
      return finish();
    }
    if (!input.projectId) {
      notes.push('handoff supersession skipped: no project id (the trunk is per-project)');
      return finish();
    }

    // The new handoff's tags and its EXACT lane — mandrel_handoff_lane with a NULL default
    // (migration 105, unchanged): NULL = no lane tag. Same lane-tag parse as the read rule,
    // without the read rule's untagged→default mapping.
    const prefix = READ_HANDOFF_LANE_TAG_PREFIX();
    const selfRow = await pool.query(
      `SELECT tags, mandrel_handoff_lane(tags, $2::text, NULL::text) AS lane
         FROM contexts WHERE id = $1`,
      [input.recordId, prefix]
    );
    if (selfRow.rows.length === 0) {
      notes.push(`handoff supersession skipped: context ${input.recordId} not found`);
      return finish();
    }
    const tags = (selfRow.rows[0].tags as string[] | null) ?? [];
    const lane = (selfRow.rows[0].lane as string | null) ?? null;
    if (lane === null) notes.push(untaggedHandoffWarning());

    // 1. EXPLICIT predecessor wins — the timeline is skipped entirely.
    const explicit = await pickExplicitPredecessor(pool, input.recordId, input.projectId, tags, lane);
    notes.push(...explicit.notes);
    let targetId: string | null = explicit.id;
    let source: HandoffPredecessorSource | null = explicit.source;

    // 2. TIMELINE on the EXACT lane tag.
    if (targetId === null && !explicit.blocked) {
      const prior = await pool.query(
        `SELECT c.id
           FROM contexts c, contexts self
          WHERE self.id = $1
            AND c.project_id = self.project_id
            AND c.context_type = $2
            AND c.archived_at IS NULL
            AND c.id <> self.id
            AND mandrel_handoff_lane(c.tags, $3::text, NULL::text) IS NOT DISTINCT FROM $4::text
            AND (c.created_at, c.id) < (self.created_at, self.id)
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT 1`,
        [input.recordId, TRUNK_CONTEXT_TYPE, prefix, lane]
      );
      if (prior.rows.length === 0) return finish(); // first in its lane — nothing to corroborate.
      targetId = prior.rows[0].id as string;
      source = HANDOFF_PREDECESSOR_SOURCE.timeline;
    }
    if (targetId === null) return finish();

    const r = await mintEdge(
      {
        fromId: input.recordId,
        fromType: 'context',
        toId: targetId,
        toType: 'context',
        edgeType: 'supersedes',
        projectId: input.projectId,
        createdBy: HANDOFF_SUPERSESSION_CREATED_BY,
        via: EDGE_MINT_VIA.handoffTimeline,
        metadata: {
          predecessor_source: source,
          ...(explicit.sourceTag && source !== HANDOFF_PREDECESSOR_SOURCE.timeline
            ? { source_tag: explicit.sourceTag }
            : {}),
        },
      },
      pool
    );
    if (r.refused) {
      notes.push(`supersedes → context ${targetId} refused (${r.refused})`);
      return finish();
    }
    report.predecessorId = targetId;
    report.source = source;
    report.created = r.created;
    return finish();
  } catch (error) {
    // Never break the write — the handoff is already persisted (same contract as every
    // other write-time minter). Surfaced in the report AND the log.
    logger.error('❌ handoff supersession mint failed (record already persisted; write not broken)', error as Error);
    notes.push(`handoff supersession mint failed: ${(error as Error).message}`);
    return finish();
  }
}
