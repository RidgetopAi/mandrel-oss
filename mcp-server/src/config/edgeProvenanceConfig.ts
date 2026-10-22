/**
 * EDGE MINT PROVENANCE — the ONE normalized label every edge carries (SK4).
 *
 * ── WHAT PROBLEM THIS CLOSES ─────────────────────────────────────────────────────────
 * Before SK4 the "which path minted this edge?" fact was written into `links.metadata`
 * under FOUR different keys by different call sites — `source_tag`, `source`, `via`,
 * `provenance` — and one live path (`link` tool → links.routes.handleLink) wrote NO label
 * at all, because the tool requires no metadata. So the question "was this edge declared or
 * inferred?" had no single place to read, and 15% of recent edges answered it with nothing.
 *
 * ── THE FIX, AND WHY IT IS A COLUMN AND NOT A METADATA KEY ───────────────────────────
 * The label is `links.mint_via` — a NOT NULL text COLUMN (migration 085), not a jsonb key.
 * A column is strictly the stronger encoding, on three counts that matter here:
 *   1. NOT NULL is enforced by the DB for EVERY writer, including raw SQL, a psql session
 *      and a future service nobody has written. A `metadata ? 'via'` CHECK would enforce
 *      presence but not non-emptiness without more expression, and jsonb has no NOT NULL.
 *   2. It is cheap to query and index — SK5's selection filters on provenance, and asking
 *      it to parse jsonb per row on a growing table is a cost we would pay forever.
 *   3. `provenance_class` (declared/guessed) is a STORED GENERATED column derived from it
 *      (migration 085), so the classification cannot drift from the label: there is one
 *      expression, evaluated by Postgres, and no code path can write the two out of step.
 *
 * ── WHAT WAS **NOT** COLLAPSED, AND WHY (the pushback) ───────────────────────────────
 * The four keys were not four names for one thing. Measured by reading every writer and
 * every reader, they sit on THREE axes, and only two of the keys shared one:
 *
 *   AXIS 1 — WHICH PATH MINTED IT.  `source` (links.ts / threadInference / tasks.routes)
 *     and `via` (positionalMint / handoffSupersession) are the SAME axis under two names.
 *     THESE ARE THE ONES THAT COLLAPSE, into this file's vocabulary + the mint_via column.
 *
 *   AXIS 2 — PER-EDGE DETAIL.  `source_tag` holds the RAW TAG TEXT ("task:1a2b3c4d") — an
 *     unbounded, writer-supplied value, not a label from a closed set. Folding it into the
 *     normalized label would make the label's domain open, which destroys exactly the
 *     countability this task exists to create. It stays in metadata alongside `ref`,
 *     `similarity`, `method` and the belief fields, which are also detail. (The positional
 *     mint's `spineType` metadata key was DELETED by SK2/086 — the branch a write was made
 *     on is the `branch_memberships` row, and a jsonb copy of it would be a second author
 *     for a fact that is a query predicate.)
 *
 *   AXIS 3 — REPAIR HONESTY.  `metadata.provenance` ('backfill' | 'guess', graphBackfill)
 *     does NOT mean "which path minted this". It means "this edge's similarity has been
 *     MEASURED and recorded honestly", and it is written by the repair leg onto edges
 *     OTHER mechanisms minted — deliberately without touching created_by, because
 *     "calling it 'backfill' would be a lie about who minted it" (graphBackfillConfig.ts).
 *     THIS KEY IS THE REPAIR LEG'S SELECTOR (REPAIR_POPULATION_SQL, graphBackfill.ts) and
 *     must not be removed: a row is in the repair population precisely while it does NOT
 *     carry it. Stated as a property of the query, not as a prediction about running work —
 *     measured on prod 2026-08-15, ZERO rows carry 'guess' or 'backfill' today, so the
 *     population is currently empty and "removing it would break a running mechanism" would
 *     be a stronger claim than the corpus supports.
 *
 * The one genuine redundancy found on axis 3 was `provenance: BELIEF_EDGE_CREATED_BY` on
 * the SOFT belief edge — a verbatim copy of the row's own created_by, read by nothing
 * (grep for readers below). It is deleted; `mint_via='belief-adjudication'` carries it now.
 *
 * ── HOW AN UNLABELLED MINT IS MADE UNREACHABLE (three layers, three surfaces) ─────────
 *   TYPE   — `MintEdgeInput.via` is REQUIRED and narrowed to {@link EdgeMintVia}. Omitting
 *            it, or passing a string outside the set, does not compile. This is the layer
 *            that covers the 14 in-repo mint sites.
 *   RUNTIME— mintEdge() rejects a via outside the set with InvalidEdgeError, for callers
 *            that reach it through `any` (links.routes.handleLink takes `args: any`).
 *   DB     — `links.mint_via` is NOT NULL with no DEFAULT, so an INSERT that names no via
 *            fails regardless of which language issued it. This is the only layer that
 *            holds against raw SQL, and it is why the fix is a column.
 *
 * NO HARDCODED VARIABLES: this file is the single named home for the vocabulary. The
 * declared/guessed CLASSIFICATION of each via is deliberately NOT re-spelled here — it is
 * SQL (the generated column in migration 085), read back, exactly as provenanceMeter reads
 * `provenance_class` rather than recomputing it. src/tests/linkProvenanceMeter.contract.test.ts
 * is the executable contract between this vocabulary and that SQL.
 */

/**
 * THE VOCABULARY — one member per real mint path in the repo. Adding a mint site means
 * adding a member here AND classifying it in the migration; a member with no classification
 * fail-closes to 'unclassified' and the contract test goes RED, which is the intended way
 * to find out.
 */
export const EDGE_MINT_VIA = {
  /** A threading tag (`task:`/`decision:`/`context:`) — links.ts autoMintFromTags. */
  tag: 'tag',
  /** The explicit `links` argument on a store/create — links.ts mintExplicitLinks. */
  linksParam: 'links-param',
  /** The task `dependencies` field mirror — links.ts autoMintFromTaskDependencies. */
  taskDependencies: 'task-dependencies',
  /** Evidence/parent ids in a decision's metadata — links.ts autoMintFromDecision. */
  decisionEvidence: 'decision-evidence',
  /** A decision's `superseded_by` column mirror — links.ts autoMintFromDecision. */
  decisionSupersededBy: 'decision-superseded-by',
  /** task_create's explicit `parentTaskId` param → subtask_of — tasks.routes.ts. */
  parentTaskParam: 'parent-task-param',
  /** Branch-position membership (`informs` → the spine) — positionalMint.ts. */
  position: 'position',
  /** A multi-name TRUNK record's per-task weak reference — positionalMint.ts. */
  trunkRef: 'trunk-ref',
  /** A single foreign task id named in the body while positioned — positionalMint.ts. */
  namedRef: 'named-ref',
  /** The trunk timeline's handoff→predecessor supersession — handoffSupersession.ts. */
  handoffTimeline: 'handoff-timeline',
  /** The embedding-similarity no-orphan guess — threadInference.ts. */
  inference: 'inference',
  /** An automated supersession verdict — belief/edgeReconciliation.ts. */
  beliefAdjudication: 'belief-adjudication',
  /** The public `link` tool — links.routes.ts handleLink (both endpoints named by hand). */
  linkTool: 'link-tool',
} as const;

/** The narrowed union. A mint whose `via` is not one of these does not compile. */
export type EdgeMintVia = (typeof EDGE_MINT_VIA)[keyof typeof EDGE_MINT_VIA];

/** Every mintable via, as an array (the contract test's population). */
export const EDGE_MINT_VIA_VALUES: readonly EdgeMintVia[] = Object.freeze(
  Object.values(EDGE_MINT_VIA)
) as readonly EdgeMintVia[];

const VIA_SET: ReadonlySet<string> = new Set<string>(EDGE_MINT_VIA_VALUES);

/** Runtime narrowing — the backstop for callers that arrive through `any`. */
export function isEdgeMintVia(v: unknown): v is EdgeMintVia {
  return typeof v === 'string' && VIA_SET.has(v);
}

/**
 * VIAS THAT EXIST IN THE CORPUS BUT ARE NOT MINTABLE. Migration 085 writes these onto
 * historical rows; no code path may produce them, which is why they are deliberately OUTSIDE
 * {@link EdgeMintVia} — a mint site cannot reach for one even by accident.
 */
export const LEGACY_ONLY_MINT_VIA = {
  /**
   * The RETIRED session-anchor mechanism (`created_by='auto:active_thread'`, dead since
   * 2026-07-28, 0/wk measured). Classified GUESSED, unchanged from migration 079.
   */
  anchor: 'anchor',
  /**
   * THE CLOSED LEGACY CLASS: a pre-085 edge that recorded no provenance signal at all —
   * neither a metadata label nor a recognisable created_by stamp. Classified
   * 'unclassified' (fail-closed: it is not evidence of anything), and countable as
   * `SELECT count(*) FROM links WHERE mint_via = 'legacy-unlabeled'`. The class cannot
   * grow: mint_via is NOT NULL and nothing may mint this value.
   */
  legacyUnlabeled: 'legacy-unlabeled',
} as const;
