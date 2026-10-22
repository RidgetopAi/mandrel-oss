/**
 * WHICH HANDOFF IS LIVE — resolved by WALKING the declared supersession chain, from TWO
 * independent seeds, refusing rather than guessing when they do not agree. (P5.2; scope
 * riverbend/reports/artifacts/p5-briefing-parity/SCOPE.md §2 P5.2, §3.1, §3.2, §8.5.)
 *
 * ── WHAT IT REPLACES ────────────────────────────────────────────────────────────────
 * services/projectBriefing.ts used to select the handoff with:
 *
 *     NOT EXISTS (SELECT 1 FROM links l WHERE l.to_id = c.id AND l.edge_type='supersedes')
 *
 * ONE HOP. Three things that predicate cannot see, each of which we have measured:
 *   1. It is not a walk. It asks "is anything pointing at this row", which is a different
 *      question from "is this the end of the chain".
 *   2. It does not care WHO is pointing. An ARCHIVED record keeps its edges; a link row
 *      belonging to ANOTHER PROJECT satisfies it just as well; so does an edge from a
 *      record that is not a handoff at all. Any one of those poisons the true head, and
 *      the query then falls through to the newest row that happens to have no inbound
 *      edge — which, in a chain with a gap in it, is a DEAD handoff several generations
 *      back. That is the shape that served a four-generations-dead handoff on 2026-08-23
 *     .
 *   3. It has no third state. Ambiguity and absence both render as "none recorded".
 *
 * ── THE ALGORITHM, IN ONE PARAGRAPH ─────────────────────────────────────────────────
 * The write path mints exactly one DECLARED `supersedes` edge per handoff, NEWER → OLDER
 * (services/handoffSupersession.ts). So the head is the node with no INCOMING edge, and
 * "walking forward in time" means following edges BACKWARD: from node X, its successors
 * are the rows `l.to_id = X`. We walk from two seeds — the newest live handoff (RECENCY)
 * and the newest live handoff carrying `ref:resume` (TAG) — to their terminals. Agreement
 * is the head. Disagreement, a fork (a node with two declared successors), a cycle, or the
 * hop bound is a REFUSAL.
 *
 * THEN THE LINEAGE SCAN, AND IT IS NOT OPTIONAL. On modern data both seeds land on the SAME
 * record — the write path stamps `ref:resume` on every handoff, so the newest handoff is
 * also the newest tagged one — and a seed that is ALREADY at a terminal walks zero hops and
 * therefore sees nothing. Forward walking alone would have made the fork check dead code on
 * exactly the corpus a customer has. So after the head is found, we walk BACKWARD through
 * its lineage looking for a node with two declared successors: that is the fork, and the
 * other arm has its own terminal that is just as live. The backward scan is bounded by the
 * same hop cap; when it does not complete, `lineage.scanComplete` says so as a FIELD rather
 * than the resolution quietly claiming a coverage it did not have.
 *
 * ── REFUSE TO PICK, BUT NEVER RENDER NOTHING (SCOPE §8.5) ───────────────────────────
 * Our shell resolver refuses and renders nothing, because the coordinator is present to repair the
 * graph. On a CUSTOMER boot surface that is the dangerous option: we measured a 40-minute
 * broken boot from exactly that refusal, and a fork arises from an ordinary mishap (a
 * handoff misfiled into the wrong project — SCOPE §3.2, it happened to us). So this module
 * returns the CANDIDATE SET on every refusal, with timestamps and headlines, and the
 * renderer is required to show them plus an in-band remedy. Refusing to pick and refusing
 * to speak are not the same act.
 *
 * ── THREE STATES, NEVER TWO (C1) ────────────────────────────────────────────────────
 * `status` is 'resolved' | 'refused' | 'absent'. "I could not measure" (refused) never
 * shares a branch with "there is no handoff" (absent). A caller can tell them apart from a
 * FIELD without parsing prose.
 *
 * ── WHAT THE TWO SEEDS DO *NOT* BUY — the residual, named ────────────────────────────
 * Ported from runtime/lib/handoff-head.sh's own header, because overstating a cross-check
 * is the same defect class this module exists to fix. Both seeds are wrong TOGETHER when:
 *   1. a handoff-shaped record is stored under a DIFFERENT context_type — invisible to the
 *      chain (which is minted only for `handoff`) and to both seed queries;
 *   2. a misfiled handoff is written INTO this project — it is then genuinely this
 *      project's newest handoff and carries the server-stamped tag, so both seeds land on
 *      it in step. Project scoping cannot help; the record really is here.
 *   3. a fork exists on a chain NEITHER seed sits on. Fork detection covers the seeds'
 *      LINEAGE (their descendants, and the resolved head's ancestors up to the hop bound),
 *      not the whole project — a whole-project multi-terminal scan would refuse permanently
 *      on any project with legacy handoffs written before the chain was minted at all.
 * What they DO buy: a tag pointing into a DIFFERENT chain becomes a refusal instead of a
 * coin flip, and a forked chain becomes a could-not-measure instead of a silent pick.
 *
 * SECRETS: none. Record ids, timestamps, integers.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { TRUNK_CONTEXT_TYPE } from './handoffSupersession.js';
import { RESUME_POINTER_TAG } from '../config/handoffResumePointerConfig.js';
import {
  HANDOFF_HEAD_EDGE_TYPE,
  HANDOFF_HEAD_REQUIRED_PROVENANCE_CLASS,
  READ_HANDOFF_HEAD_MAX_HOPS,
} from '../config/handoffHeadConfig.js';

/** The two independent ways the walk is seeded. */
export const HANDOFF_HEAD_SEED = {
  /** The project's newest live handoff row. */
  recency: 'recency',
  /** The project's newest live handoff carrying the resume pointer tag. */
  tag: 'tag',
} as const;
export type HandoffHeadSeed = (typeof HANDOFF_HEAD_SEED)[keyof typeof HANDOFF_HEAD_SEED];

/** The typed reasons a head could not be picked. Never a free-form string. */
export const HANDOFF_HEAD_REFUSAL = {
  /** The two seeds walked to DIFFERENT terminals — two disjoint chains. */
  seedDisagreement: 'seed-disagreement',
  /** A walked node had more than one declared successor: the chain branches. */
  fork: 'fork',
  /** The walk revisited a node it had already stood on. */
  cycle: 'cycle',
  /** The walk hit MANDREL_HANDOFF_HEAD_MAX_HOPS with the chain still running. */
  hopBound: 'hop-bound',
  /**
   * A seed row was selected and then the walk returned NOTHING for it — a shape the two
   * queries cannot produce between them (the seed query already proved the row is a live
   * handoff in this project, which is exactly the walk's base case). It exists so that an
   * unexplained shape lands in COULD-NOT-MEASURE with its own name, instead of being
   * absorbed into 'fork' and reported as a graph condition that was never observed.
   */
  unresolvable: 'unresolvable',
} as const;
export type HandoffHeadRefusalReason =
  (typeof HANDOFF_HEAD_REFUSAL)[keyof typeof HANDOFF_HEAD_REFUSAL];

/** One handoff that could be the head. Enough to tell two apart and to act on either. */
export interface HandoffHeadCandidate {
  id: string;
  createdAt: Date;
  /**
   * The record's content with runs of whitespace collapsed to single spaces — NOT its first
   * line, and that distinction was measured rather than guessed. The first captured sample
   * of this render showed two candidates as `MODE: debug` and `MODE: build`, because a real
   * handoff opens with a MODE line: the excerpt that was supposed to let a reader tell two
   * records apart was showing them the one line every handoff shares. The renderer decides
   * how much of this to show (config/handoffHeadConfig.ts).
   */
  excerpt: string;
}

/** What one seed's walk found. `seedId` null = that seed does not exist in this project. */
export interface HandoffHeadSeedWalk {
  seed: HandoffHeadSeed;
  seedId: string | null;
  /** Hops from the seed to its terminal; null when there is no seed or the walk refused. */
  hops: number | null;
  /** The terminal this seed reached; null when there is no seed or the walk refused. */
  terminalId: string | null;
  /** Why THIS seed's walk could not terminate, if it could not. */
  refusal: HandoffHeadRefusalReason | null;
}

export interface HandoffHeadResolution {
  /** THREE STATES. 'absent' = the project has no live handoff at all. */
  status: 'resolved' | 'refused' | 'absent';
  /** The live handoff. Non-null IFF status === 'resolved'. */
  headId: string | null;
  /** Which seeds concurred on `headId`. Empty unless resolved. */
  concurringSeeds: HandoffHeadSeed[];
  /** Per-seed provenance: where it started, how far it walked, what stopped it. */
  walks: HandoffHeadSeedWalk[];
  /** The refusal reason. Non-null IFF status === 'refused'. */
  refusal: HandoffHeadRefusalReason | null;
  /**
   * The candidate heads a refusal could not choose between, newest first. NEVER empty on a
   * refusal — that is the §8.5 guarantee the renderer depends on.
   */
  candidates: HandoffHeadCandidate[];
  /**
   * HOW FAR THE CORROBORATING BACKWARD SCAN GOT. `scanComplete:false` means the ancestor
   * walk hit the hop bound — the head is still the head (the forward walk decided that),
   * but the fork check did not see the whole lineage, and saying so is the difference
   * between a bounded check and a check that pretends to be total.
   */
  lineage: { ancestorsScanned: number; scanComplete: boolean };
  /** The bound in force for this resolution, so a hop-bound refusal names its own knob. */
  maxHops: number;
}

/** One row of the recursive walk. */
interface WalkRow {
  nodeId: string;
  depth: number;
  cycle: boolean;
  /** How many DECLARED successors this node has. 0 = terminal; >1 = the chain forks here. */
  successorCount: number;
}

/**
 * THE TWO DIRECTIONS. The write path mints NEWER --supersedes--> OLDER, so:
 *   successors   — newer records: join on `l.to_id = here`, step to `l.from_id`. Walking
 *                  this direction moves FORWARD in time, toward the head.
 *   predecessors — older records: join on `l.from_id = here`, step to `l.to_id`. Walking
 *                  this direction moves BACK through the lineage the head sits on.
 *
 * Whitelisted pairs, never interpolated from a caller — this is SQL text.
 */
const WALK_DIRECTION = {
  successors: { match: 'l.to_id', step: 'l.from_id' },
  predecessors: { match: 'l.from_id', step: 'l.to_id' },
} as const;
type WalkDirection = keyof typeof WALK_DIRECTION;

/**
 * THE WALK. One recursive CTE, following DECLARED `supersedes` edges in one direction.
 *
 * EVERY STEP IS PROJECT-SCOPED, and all three scopes are load-bearing rather than
 * decorative: the seed row (`c.project_id`), the EDGE (`l.project_id`) and the NEXT record
 * (`nxt.project_id`). The old one-hop predicate scoped NONE of them, which is how another
 * project's link row could delete this project's handoff section.
 *
 * `nxt.archived_at IS NULL` is the other half of that: an archived record keeps its edge
 * rows, and a deleted handoff must not be able to hold the chain open behind it.
 *
 * CYCLE SAFETY is structural, not a bound: each row carries the path it came by, a revisit
 * is marked and NOT expanded. The hop bound is a separate, additional runaway guard.
 *
 * `successor_count` is computed the SAME WAY in both directions — the number of declared
 * successors of the visited node — because terminality and forkedness are properties of the
 * node, not of the direction you arrived from.
 */
async function walk(
  seedId: string,
  projectId: string,
  maxHops: number,
  pool: Pool,
  direction: WalkDirection,
): Promise<WalkRow[]> {
  const { match, step } = WALK_DIRECTION[direction];
  const rows = (
    await pool.query(
      `WITH RECURSIVE walk AS (
         SELECT c.id AS node_id, 0 AS depth, ARRAY[c.id] AS path, false AS cycle
           FROM contexts c
          WHERE c.id = $1
            AND c.project_id = $2
            AND c.context_type = $3
            AND c.archived_at IS NULL
         UNION ALL
         SELECT nxt.id, w.depth + 1, w.path || nxt.id, nxt.id = ANY(w.path)
           FROM walk w
           JOIN links l
             ON ${match} = w.node_id
            AND l.edge_type = $4
            AND l.provenance_class = $5
            AND l.project_id = $2
           JOIN contexts nxt
             ON nxt.id = ${step}
            AND nxt.project_id = $2
            AND nxt.context_type = $3
            AND nxt.archived_at IS NULL
          WHERE NOT w.cycle
            AND w.depth < $6
       )
       SELECT w.node_id, w.depth, w.cycle,
              (SELECT count(*)
                 FROM links l2
                 JOIN contexts s2 ON s2.id = l2.from_id
                WHERE l2.to_id = w.node_id
                  AND l2.edge_type = $4
                  AND l2.provenance_class = $5
                  AND l2.project_id = $2
                  AND s2.project_id = $2
                  AND s2.context_type = $3
                  AND s2.archived_at IS NULL)::int AS successor_count
         FROM walk w`,
      [
        seedId,
        projectId,
        TRUNK_CONTEXT_TYPE,
        HANDOFF_HEAD_EDGE_TYPE,
        HANDOFF_HEAD_REQUIRED_PROVENANCE_CLASS,
        maxHops,
      ],
    )
  ).rows;
  return rows.map((r: any) => ({
    nodeId: r.node_id as string,
    depth: Number(r.depth),
    cycle: r.cycle === true,
    successorCount: Number(r.successor_count),
  }));
}

/** The verdict of ONE seed's forward walk, before the two are compared. */
interface SeedOutcome {
  walk: HandoffHeadSeedWalk;
  /** Every node the walk stood on. */
  visited: WalkRow[];
}

/**
 * Read a forward walk: where did this seed end up, and did anything stop it?
 *
 * ORDER MATTERS. Cycle, then fork, then the hop bound, then terminality — each is a
 * strictly stronger reason to refuse than the next, and reporting the weaker one would
 * describe a condition that is not the operative one.
 */
function evaluateSeed(
  seed: HandoffHeadSeed,
  seedId: string,
  rows: WalkRow[],
  maxHops: number,
): SeedOutcome {
  const base: HandoffHeadSeedWalk = { seed, seedId, hops: null, terminalId: null, refusal: null };
  const refuse = (r: HandoffHeadRefusalReason): SeedOutcome => ({
    walk: { ...base, refusal: r },
    visited: rows,
  });

  if (rows.some((r) => r.cycle)) return refuse(HANDOFF_HEAD_REFUSAL.cycle);
  if (rows.some((r) => r.successorCount > 1)) return refuse(HANDOFF_HEAD_REFUSAL.fork);
  // THE HOP BOUND, checked before terminality: a node sitting AT the bound that still has a
  // successor means the walk was CUT OFF, not finished. Reporting its id as the terminal
  // would be the original defect (a silent stop at the last id seen) wearing a bound.
  if (rows.some((r) => r.depth >= maxHops && r.successorCount > 0)) {
    return refuse(HANDOFF_HEAD_REFUSAL.hopBound);
  }

  const terminals = rows.filter((r) => r.successorCount === 0);
  if (terminals.length !== 1) {
    // A bounded, acyclic, unforked walk has EXACTLY one terminal, so neither 0 nor >1 is
    // reachable from here. Refused rather than resolved, under its own name: an unexplained
    // shape is a could-not-measure, never a pick, and never a borrowed diagnosis.
    return refuse(HANDOFF_HEAD_REFUSAL.unresolvable);
  }
  return {
    walk: { ...base, hops: terminals[0].depth, terminalId: terminals[0].nodeId },
    visited: rows,
  };
}

/** A record's content as one line — what a candidate is recognised by. See HandoffHeadCandidate. */
function collapse(content: string): string {
  return (content ?? '').replace(/\s+/g, ' ').trim();
}

/** Load candidate rows (id, created_at, excerpt) newest first, project-scoped. */
async function loadCandidates(
  ids: readonly string[],
  projectId: string,
  pool: Pool,
): Promise<HandoffHeadCandidate[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = (
    await pool.query(
      `SELECT id, content, created_at
         FROM contexts
        WHERE id = ANY($1::uuid[]) AND project_id = $2 AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC`,
      [unique, projectId],
    )
  ).rows;
  return rows.map((r: any) => ({
    id: r.id as string,
    createdAt: r.created_at as Date,
    excerpt: collapse(r.content as string),
  }));
}

/**
 * Resolve which handoff is live for one project.
 *
 * NEVER THROWS on graph shape — every unresolvable shape is a typed refusal, because a
 * thrown error would take the whole briefing down over a repairable data condition.
 */
export async function resolveHandoffHead(
  projectId: string,
  pool: Pool = db,
  maxHops: number = READ_HANDOFF_HEAD_MAX_HOPS(),
): Promise<HandoffHeadResolution> {
  // ── THE TWO SEEDS ────────────────────────────────────────────────────────────────
  // Both are project-scoped, both require context_type='handoff', both exclude archived.
  //
  // THE TYPE GATE ON THE TAG SEED IS THE FIX FOR SCOPE §3.1. The auto-STAMP is correctly
  // hard-gated to `type:handoff` (handoffResumePointerConfig.ts), but NOTHING rejects a
  // caller-supplied `ref:resume` on any other type — and a `type:error` record carrying it
  // seeded a resolver for real. The read path gates by type too, so a mistagged record of
  // any other type is simply not a seed.
  const seedRows = (
    await pool.query(
      `SELECT
         (SELECT c.id FROM contexts c
           WHERE c.project_id = $1 AND c.context_type = $2 AND c.archived_at IS NULL
           ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS recency_id,
         (SELECT c.id FROM contexts c
           WHERE c.project_id = $1 AND c.context_type = $2 AND c.archived_at IS NULL
             AND $3 = ANY(c.tags)
           ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS tag_id`,
      [projectId, TRUNK_CONTEXT_TYPE, RESUME_POINTER_TAG],
    )
  ).rows[0];

  const seedIds: Record<HandoffHeadSeed, string | null> = {
    recency: (seedRows?.recency_id as string | null) ?? null,
    tag: (seedRows?.tag_id as string | null) ?? null,
  };

  const absentWalks: HandoffHeadSeedWalk[] = [
    { seed: HANDOFF_HEAD_SEED.recency, seedId: null, hops: null, terminalId: null, refusal: null },
    { seed: HANDOFF_HEAD_SEED.tag, seedId: null, hops: null, terminalId: null, refusal: null },
  ];

  if (seedIds.recency === null && seedIds.tag === null) {
    // ABSENT, not refused: the query ran to completion and the project genuinely has no
    // live handoff. This is the branch that must never be shared with a refusal.
    return {
      status: 'absent',
      headId: null,
      concurringSeeds: [],
      walks: absentWalks,
      refusal: null,
      candidates: [],
      lineage: { ancestorsScanned: 0, scanComplete: true },
      maxHops,
    };
  }

  const outcomes: SeedOutcome[] = [];
  for (const seed of [HANDOFF_HEAD_SEED.recency, HANDOFF_HEAD_SEED.tag] as const) {
    const id = seedIds[seed];
    if (id === null) {
      // A MISSING SEED IS NOT A DISAGREEMENT. A project whose handoffs predate the resume
      // pointer has no tag seed at all; refusing on that would refuse forever on legacy
      // data. It is reported as absent (seedId null) and contributes no opinion.
      outcomes.push({
        walk: { seed, seedId: null, hops: null, terminalId: null, refusal: null },
        visited: [],
      });
      continue;
    }
    const forward = await walk(id, projectId, maxHops, pool, 'successors');
    outcomes.push(evaluateSeed(seed, id, forward, maxHops));
  }

  const walks = outcomes.map((o) => o.walk);

  /**
   * THE CANDIDATE SET FOR A REFUSAL. §8.5 requires it to be NON-EMPTY — the renderer shows
   * these instead of an empty section — so this walks down a ladder rather than trusting one
   * source: the terminals reachable from every fork point, else the terminals seen, else
   * every node visited (a pure cycle has no terminal at all), else the seeds themselves.
   */
  const candidateIdsFrom = async (visited: WalkRow[]): Promise<string[]> => {
    const forks = visited.filter((r) => r.successorCount > 1).map((r) => r.nodeId);
    const fromForks: string[] = [];
    for (const f of forks) {
      // Each ARM of the fork has its own terminal, and those terminals are the competing
      // heads. Only run on a refusal, so the extra queries cost nothing on the happy path.
      for (const r of await walk(f, projectId, maxHops, pool, 'successors')) {
        if (r.successorCount === 0) fromForks.push(r.nodeId);
      }
    }
    if (fromForks.length > 0) return fromForks;
    const terminals = visited.filter((r) => r.successorCount === 0).map((r) => r.nodeId);
    if (terminals.length > 0) return terminals;
    const all = visited.map((r) => r.nodeId);
    if (all.length > 0) return all;
    return Object.values(seedIds).filter((v): v is string => v !== null);
  };

  // ── A SEED THAT COULD NOT TERMINATE REFUSES THE WHOLE RESOLUTION ──────────────────
  const failed = walks.find((w) => w.refusal !== null);
  if (failed) {
    return {
      status: 'refused',
      headId: null,
      concurringSeeds: [],
      walks,
      refusal: failed.refusal,
      candidates: await loadCandidates(
        await candidateIdsFrom(outcomes.flatMap((o) => o.visited)),
        projectId,
        pool,
      ),
      lineage: { ancestorsScanned: 0, scanComplete: false },
      maxHops,
    };
  }

  const terminalIds = [
    ...new Set(walks.map((w) => w.terminalId).filter((t): t is string => t !== null)),
  ];

  if (terminalIds.length > 1) {
    // TWO DISJOINT CHAINS. Neither seed is wrong about its own chain; the corpus has two
    // heads and nothing in the data says which one the reader meant.
    return {
      status: 'refused',
      headId: null,
      concurringSeeds: [],
      walks,
      refusal: HANDOFF_HEAD_REFUSAL.seedDisagreement,
      candidates: await loadCandidates(terminalIds, projectId, pool),
      lineage: { ancestorsScanned: 0, scanComplete: false },
      maxHops,
    };
  }

  const headId = terminalIds[0];

  // ── THE LINEAGE SCAN — see the header. Without it the fork check is dead code on the
  //    corpus a customer actually has, because both seeds sit ON the head and walk 0 hops.
  const ancestors = await walk(headId, projectId, maxHops, pool, 'predecessors');
  const lineageRefusal: HandoffHeadRefusalReason | null = ancestors.some((r) => r.cycle)
    ? HANDOFF_HEAD_REFUSAL.cycle
    : ancestors.some((r) => r.successorCount > 1)
      ? HANDOFF_HEAD_REFUSAL.fork
      : null;
  // The ancestor scan hitting the bound is NOT a refusal: the forward walk already decided
  // the head, and this scan only corroborates. It is reported as coverage, not as a verdict
  // — the opposite treatment from the FORWARD bound, which does decide the head and so must
  // refuse. Two bounds, two consequences, stated rather than shared.
  const scanComplete = !ancestors.some((r) => r.depth >= maxHops);

  if (lineageRefusal !== null) {
    return {
      status: 'refused',
      headId: null,
      concurringSeeds: [],
      walks,
      refusal: lineageRefusal,
      candidates: await loadCandidates(await candidateIdsFrom(ancestors), projectId, pool),
      lineage: { ancestorsScanned: ancestors.length, scanComplete },
      maxHops,
    };
  }

  return {
    status: 'resolved',
    headId,
    concurringSeeds: walks.filter((w) => w.terminalId === headId).map((w) => w.seed),
    walks,
    refusal: null,
    candidates: [],
    lineage: { ancestorsScanned: ancestors.length, scanComplete },
    maxHops,
  };
}
