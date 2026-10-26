/**
 * STAGE-1 CANDIDATE PAIRING (design §2/§3).
 *
 * Cosine NOMINATES; it never adjudicates (the relevance-vs-truth axiom). For a given
 * record, find its top-K same-project neighbours whose gemma cosine is WITHIN the belief
 * pair BAND [pairMinCosine, pairMaxCosine]. Those pairs — and ONLY those — are handed to
 * the Stage-2 adjudicator. This bounds adjudicator load (embedder stays priority) and is
 * the cheap gate that keeps the expensive LLM off obvious non-pairs.
 *
 * ANTI-JUNK (measured 2026-07-06 on decision-run — the picker, not the model, was
 * the flag-storm source): the band has BOTH ends — a floor cuts low-cosine `unrelated`
 * noise, and a CEILING (~0.95+) cuts near-identical DUPLICATE RESTATEMENTS (a record
 * re-stored, not "this replaced that") that the adjudicator false-fired supersedes on. And
 * periodic machine-written AUTO-RECORDS (tick-proposal / dispatch-proof / pick-log /
 * gate-log logs, identified by their structured `metadata->>'kind'`) are excluded as EITHER
 * endpoint — they dominated the raw nomination but are never belief atoms. HISTORICAL
 * auto-records written before they carried a kind (e.g. the pre-fix "Picked by …" scoper
 * snapshots + "CN1 (…) tripped by…" gate rationales) are
 * ALSO excluded by CONTENT PREFIX (pairExcludeContentPrefixes) as either endpoint — the
 * belt-and-braces complement to the kind marker. All are config-driven
 * (beliefConfig) with measured defaults; confirmed to retain every oracle-labelled true
 * supersession.
 *
 * REUSE, DON'T REINVENT: the cosine is the SAME pgvector expression
 * anchorGate / context_search use — `1 - (embedding <=> $vec::vector)` — over the ACTIVE
 * embedding column (embeddingConfig.activeEmbeddingColumn()), so a gemma cutover can't leave a
 * legacy-column reference behind. Same-project only (design §9f privacy: never pair across
 * tenants / Daisy / personal).
 *
 * ROBUSTNESS: this NEVER throws — a measurement failure never sinks a caller. But it is no
 * longer SILENT. Until 2026-08-31 a failed measurement returned the same `[]`
 * a healthy empty neighbourhood returns, so "there were no candidates" and "the candidate
 * query blew up" were THE SAME OBSERVABLE. The whole neighbourhood was then lost, the
 * adjudicator was never consulted, the attempt ledger booked the miss as `completed`, and the
 * two belief contract tests failed with "expected 0 to be greater than 0" — a message that
 * names a symptom and no cause. Cost: two aborted fleet deploys in one day, at ~6% per
 * full-suite run (1 in 17 observed). This is CLASSES.md C1's third instrument state: *yes*,
 * *no*, and *I could not measure* — and code that folds the third onto one of the first two.
 *
 * So the return type is DISCRIMINATED: `{ok:true, candidates}` for a measurement that ran,
 * `{ok:false, reason, partial}` for one that did not. The fail-open BEHAVIOUR is unchanged
 * (still no throw, the partial result is still carried); only its legibility changed. The
 * two arms name the list DIFFERENTLY on purpose, so the compiler refuses a call site that
 * reads the list without testing `.ok`. `readRecordCreatedAt` below is the same three states
 * for the source record's CLOCK, for the same reason.
 */

import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import { activeEmbeddingColumn } from '../../config/embeddingConfig.js';
import { BELIEF_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefConfig } from '../../config/beliefConfig.js';
import type { EdgeNodeType } from '../../config/edgeTypes.js';
import { logger } from '../../utils/logger.js';

/** A record whose neighbours we want to pair (the "left" side of the candidate pairs). */
export interface PairingSource {
  id: string;
  type: EdgeNodeType;
  projectId: string | null;
}

/** One nominated candidate neighbour + the cosine that nominated it. */
export interface Candidate {
  id: string;
  type: EdgeNodeType;
  content: string;
  createdAt: Date | null;
  cosine: number;
}

/** Which query inside the pairing stage failed. Narrower than the ledger's `failed_stage`. */
export const PAIRING_FAILURE_STAGES = ['source_row', 'candidate_query', 'created_at'] as const;
export type PairingFailureStage = (typeof PAIRING_FAILURE_STAGES)[number];

/**
 * A pairing measurement that could not be taken. `subject` names WHAT was being read (the
 * table), so a ledger row / test failure names the failing query rather than just "pairing".
 */
export interface PairingFailure {
  stage: PairingFailureStage;
  subject: string;
  errorClass: string;
  message: string;
}

/**
 * The thrown form of a PairingFailure, for the attempt ledger. `describeFailure` reads
 * `name` + `message` off whatever it is handed, so this is what puts `BeliefPairingError`
 * and the failing table into `belief_adjudication_attempts.error_class/error_message`.
 * It is CONSTRUCTED for the ledger, never thrown across the fail-open boundary.
 */
export class BeliefPairingError extends Error {
  readonly pairingStage: PairingFailureStage;
  readonly subject: string;

  constructor(f: PairingFailure) {
    super(`belief pairing failed at ${f.stage} (${f.subject}): ${f.message}`);
    this.name = 'BeliefPairingError';
    this.pairingStage = f.stage;
    this.subject = f.subject;
  }
}

/**
 * The pairing stage's result. `ok:false` still carries what the OTHER table yielded — a
 * per-table failure degrades to a partial, exactly as before; the caller decides what to do
 * with it. `ok:true` with an EMPTY list is the legitimate, common case (no neighbour in the
 * band) and must never be reported as a failure.
 *
 * THE FAILURE ARM'S FIELD IS NAMED `partial`, NOT `candidates` — deliberately, so the
 * COMPILER is the gate rather than caller discipline. While both arms spelled it
 * `candidates`, `const { candidates } = await findCandidates(...)` type-checked WITHOUT any
 * `.ok` test and silently reproduced the original fail-open defect: a failed measurement
 * read exactly like an empty one at the call site, which is the bug this whole file's header
 * is about. With two names, that destructure does not compile. See the type-level assertion
 * in candidatePairing.unit.test.ts (guard 6).
 */
export type PairingResult =
  | { ok: true; candidates: Candidate[] }
  | { ok: false; reason: PairingFailure; partial: Candidate[] };

/** Describe a thrown value as a PairingFailure. Never throws (a classifier that can throw is a new failure mode). */
function describePairingError(e: unknown, stage: PairingFailureStage, subject: string): PairingFailure {
  const err = e as { name?: unknown; message?: unknown; constructor?: { name?: string } };
  return {
    stage,
    subject,
    errorClass: (typeof err?.name === 'string' && err.name) || err?.constructor?.name || typeof e,
    message: typeof err?.message === 'string' ? err.message : String(e),
  };
}

/**
 * The two record tables that carry embeddings + free-text content. Tasks have no embedding
 * column, so they are not pairing endpoints (they participate in the graph via edges, not
 * as belief atoms). This is a fixed, trusted map (never user input) → safe to build SQL from.
 */
const EMBEDDED_TABLES: ReadonlyArray<{
  table: string;
  type: EdgeNodeType;
  contentCol: string;
  /** Per-table creation-timestamp column (contexts: created_at; decisions: decision_date). */
  createdCol: string;
}> = [
  { table: 'contexts', type: 'context', contentCol: 'content', createdCol: 'created_at' },
  { table: 'technical_decisions', type: 'decision', contentCol: 'rationale', createdCol: 'decision_date' },
];

/**
 * The source record's CLOCK, three-state — exactly like PairingResult, and for the same reason.
 *
 * `ok:true` is a MEASURED answer, including `createdAt: null` (no row, no timestamp, or not an
 * embedded belief atom — all legitimate "this record has no clock"). `ok:false` is a read that
 * BLEW UP. The failure arm deliberately carries NO `createdAt` field, so a caller cannot reach
 * the clock without testing `.ok` — the compiler is the gate, not discipline.
 */
export type RecordClockResult =
  | { ok: true; createdAt: Date | null }
  | { ok: false; reason: PairingFailure };

/**
 * The CLOCK that orders a record, read from the SAME per-table column the candidate side
 * reads (contexts.created_at / technical_decisions.decision_date — EMBEDDED_TABLES above is
 * the single source of that mapping).
 *
 * WHY THIS IS EXPORTED: the chronology gate in beliefDerivation compares the
 * two endpoints' clocks, and the candidate endpoint's clock always comes from the DB while
 * the SOURCE endpoint's is supplied by whoever triggered the adjudication. A caller that
 * omits it would fail the pair closed — correct, but it would silently switch supersession
 * OFF for that record with no error. Resolving it here means BOTH endpoints are ordered by
 * the same column, from the same source of truth, whatever the caller passed.
 *
 * WHY IT IS TYPED: until 2026-08-31 this swallowed its error and returned the
 * same `null` an absent timestamp returns, so "this record genuinely has no clock" and "the
 * clock read blew up" were THE SAME OBSERVABLE — the identical fail-open defect findCandidates
 * had, one field over. Downstream the pair is refused as `chronology_unknown` either way, and
 * NOTHING was written to the attempt ledger, so a supersession silently switched OFF looked
 * like a healthy refusal. It still NEVER throws and still degrades to no-clock; the caller now
 * BOOKS the failed measurement (see adjudicateNeighbourhood).
 */
export async function readRecordCreatedAt(
  src: PairingSource,
  pool: Pool = db
): Promise<RecordClockResult> {
  const spec = EMBEDDED_TABLES.find((t) => t.type === src.type);
  if (!spec) return { ok: true, createdAt: null }; // e.g. a task — not an embedded belief atom
  try {
    const r = await pool.query(
      `SELECT ${spec.createdCol} AS created_at FROM ${spec.table} WHERE id = $1`,
      [src.id]
    );
    return { ok: true, createdAt: r.rows[0]?.created_at ?? null };
  } catch (e) {
    logger.warn(`🧪 belief pairing: failed to read created_at for ${src.type} ${src.id}`, {
      metadata: { error: (e as Error)?.message },
    });
    return { ok: false, reason: describePairingError(e, 'created_at', spec.table) };
  }
}

/** The source record's embedding + its auto-record kind + content (all read in one round-trip). */
interface SourceRow {
  /** pgvector text literal "[...]" of the active embedding column, or null when it has none. */
  embedding: string | null;
  /** metadata->>'kind' (e.g. 'tick-proposal'), or null when the record carries no kind. */
  kind: string | null;
  /** the record's free-text content (contexts.content / decisions.rationale) — for the prefix exclusion. */
  content: string | null;
}

/** Case-insensitive: does `content` START WITH any configured exclude prefix? (mirrors the SQL `ILIKE prefix||'%'`). */
function matchesExcludedPrefix(content: string | null, prefixes: string[]): boolean {
  if (!content || prefixes.length === 0) return false;
  const lc = content.toLowerCase();
  return prefixes.some((p) => p.length > 0 && lc.startsWith(p.toLowerCase()));
}

/**
 * Fetch the source record's stored embedding (as a pgvector text literal), its
 * `metadata->>'kind'`, AND its content in one query. A null embedding (embedding disabled /
 * not yet generated) OR a null row means no candidates. The kind + content let findCandidates
 * exclude an AUTO-RECORD source from nomination — by structured kind OR by content prefix
 * (symmetry with the neighbour-side exclusions) — without a second round-trip.
 *
 * Returns the same three-state answer findCandidates does: the row, NO row (a legitimate
 * "nothing to pair"), or a failed measurement. Folding the last two together is the bug this
 * whole file's header describes.
 */
async function getSourceRow(
  src: PairingSource,
  pool: Pool
): Promise<{ ok: true; row: SourceRow | null } | { ok: false; reason: PairingFailure }> {
  const spec = EMBEDDED_TABLES.find((t) => t.type === src.type);
  if (!spec) return { ok: true, row: null }; // e.g. a task — not an embedded belief atom
  try {
    const r = await pool.query(
      `SELECT ${activeEmbeddingColumn()}::text AS embedding, metadata->>'kind' AS kind, ${spec.contentCol} AS content
         FROM ${spec.table} WHERE id = $1`,
      [src.id]
    );
    if (r.rows.length === 0) return { ok: true, row: null };
    return {
      ok: true,
      row: {
        embedding: r.rows[0].embedding ?? null,
        kind: r.rows[0].kind ?? null,
        content: r.rows[0].content ?? null,
      },
    };
  } catch (e) {
    logger.warn(`🧪 belief pairing: failed to read source row for ${src.type} ${src.id}`, {
      metadata: { error: (e as Error)?.message },
    });
    return { ok: false, reason: describePairingError(e, 'source_row', spec.table) };
  }
}

/**
 * THE STAGE-1 NEIGHBOUR STATEMENT, as ONE exported string — and it is DELIBERATELY FENCED
 * FROM THE APPROXIMATE VECTOR INDEX (same class as an earlier task, which fenced
 * threadInference's candidate query on 2026-08-02).
 *
 * WHY THE FENCE. Written as the plain `ORDER BY <col> <=> $1::vector ASC LIMIT n`, this
 * statement is eligible for `contexts_embedding_1536_idx` / `idx_contexts_embedding_gemma_cosine`.
 * pgvector's ivfflat scan returns ONLY the rows in the `ivfflat.probes` lists it visits, and
 * those indexes are created at migrate time on an EMPTY table, so their centroids carry no
 * signal and rows scatter across all 100 lists. MEASURED 2026-09-03 on a migrated ci_* DB with
 * one genuinely-qualifying neighbour at cosine 0.8497 (inside the [0.60, 0.95] band) plus 600
 * filler rows in another project:
 *
 *     planner free (exact scan)                      -> 1 candidate returned
 *     enable_seqscan=off/enable_sort=off (ivfflat)   -> 0 candidates returned
 *
 * Nomination is an EXISTENCE question, not a "give me a good top-K": `findCandidates` returning
 * an empty list is read downstream as "this record has no neighbour worth adjudicating", the
 * adjudicator is never consulted, and the whole neighbourhood is silently lost. "The probed
 * lists were empty" and "there is nothing in the band" are different facts and must not share a
 * return value (CLASSES.md C1 — an instrument has three states). Under the approximate scan the
 * pairing stage reports NO error, so the loss is invisible: this is what made the two belief
 * contract tests non-deterministic in CI (same ref, one FAIL and one PASS), and on any instance
 * whose `contexts` table is large enough for autoanalyze to tilt the planner it silently drops
 * real pairs in production.
 *
 * THE FENCE ITSELF: `AS MATERIALIZED` is a documented optimization barrier (PG12+). The CTE
 * carries no ORDER BY, so the vector index cannot be chosen inside it; the outer ORDER BY is
 * over a computed column of a materialized result, so it cannot be pushed down. The filtered
 * set is then scanned EXACTLY. Asserted by PLAN in inferenceExactCandidateScan.contract.test.ts,
 * which EXPLAINs this exported string rather than a hand-copied lookalike — a second copy of
 * this SQL in a test could be fenced while the shipped one silently is not.
 *
 * `, id ASC` makes the LIMIT a TOTAL order (mirrors an earlier task on the inference side): two
 * neighbours at the SAME distance otherwise make WHICH one is nominated depend on physical row
 * order. It does not touch the fence.
 *
 * Params: $1 source vector, $2 project id, $3 source id, $4 source type, $5 pairMinCosine,
 * $6 pairMaxCosine, $7 excluded auto-record kinds, $8 excluded content-prefix ILIKE patterns,
 * $9 pairTopK.
 */
export function beliefCandidateSql(
  spec: (typeof EMBEDDED_TABLES)[number],
  column: string = activeEmbeddingColumn()
): string {
  // Same-project (privacy) + has-embedding + not-self, cosine within [min,max]. project
  // scoping: match the source's project; when the source project is null we only pair with
  // other null-project rows (defensive — normally set). Auto-record neighbours
  // (metadata->>'kind' in the exclude list) are filtered out (`<> ALL($7)`); an empty list is a
  // no-op (every kind is `<> ALL({})`). Legacy untagged auto-records are ALSO filtered by
  // content prefix (`NOT ... ILIKE ANY($8)`); an empty pattern array makes `ILIKE ANY`
  // vacuously false → NOT(false) = no-op. A NaN distance (a zero-norm/degenerate vector on
  // either side) fails both band comparisons and is excluded here, exactly as before.
  return `WITH candidates AS MATERIALIZED (
            SELECT id,
                   ${spec.contentCol} AS content,
                   ${spec.createdCol} AS created_at,
                   (${column} <=> $1::vector) AS distance
              FROM ${spec.table}
             WHERE ${column} IS NOT NULL
               AND ($2::uuid IS NULL AND project_id IS NULL OR project_id = $2::uuid)
               AND NOT (id = $3::uuid AND $4 = '${spec.type}')
               AND coalesce(metadata->>'kind', '') <> ALL($7::text[])
               AND NOT (coalesce(${spec.contentCol}, '') ILIKE ANY($8::text[]))
          )
          SELECT id::text AS id, content, created_at, 1 - distance AS cosine
            FROM candidates
           WHERE 1 - distance >= $5
             AND 1 - distance <= $6
           ORDER BY distance ASC, id ASC
           LIMIT $9`;
}

/**
 * Nominate candidate pairs for `src`: its top-K same-project neighbours (across contexts +
 * technical_decisions) with cosine >= cfg.pairMinCosine, excluding itself. Returns them
 * sorted by cosine desc, capped at cfg.pairTopK. NEVER throws.
 *
 * EVERY `ok:true` return below is a MEASURED answer — including the empty ones (no source
 * row, no embedding, an excluded auto-record, an empty band). Only a query that threw is
 * `ok:false`. That distinction is the entire point of the type.
 */
export async function findCandidates(
  src: PairingSource,
  cfg: BeliefConfig = BELIEF_CONFIG,
  pool: Pool = db
): Promise<PairingResult> {
  const srcRead = await getSourceRow(src, pool);
  if (!srcRead.ok) return { ok: false, reason: srcRead.reason, partial: [] };
  const srcRow = srcRead.row;
  if (!srcRow || !srcRow.embedding) return { ok: true, candidates: [] };
  const srcEmbedding = srcRow.embedding;

  // Auto-record EXCLUSION (source side): a periodic machine-written record (e.g. a
  // tick-proposal / dispatch-proof log) is never a belief atom worth adjudicating — drop it
  // as a nomination SOURCE so it can't seed junk pairs. This mirrors the neighbour-side
  // filter below; together they exclude auto-records as EITHER endpoint. Config-driven.
  const excludeKinds = cfg.pairExcludeAutoRecordKinds;
  if (srcRow.kind !== null && excludeKinds.includes(srcRow.kind)) return { ok: true, candidates: [] };

  // Content-PREFIX exclusion (source side): a historical machine-written auto-record that
  // carries NO structured kind (e.g. a pre-fix "Picked by priority; …" scoper snapshot) is
  // still dropped as a nomination SOURCE when its content starts with a configured prefix.
  // Mirrors the neighbour-side SQL `ILIKE prefix||'%'` filter below; together they exclude
  // legacy untagged auto-records as EITHER endpoint. Config-driven, empty list = no-op.
  const excludePrefixes = cfg.pairExcludeContentPrefixes;
  if (matchesExcludedPrefix(srcRow.content, excludePrefixes)) return { ok: true, candidates: [] };

  // Neighbour-side prefix patterns: each configured prefix → an ILIKE pattern `prefix||'%'`.
  // Passed as a text[]; an empty array makes the `ILIKE ANY` predicate vacuously false → no-op.
  const excludePrefixPatterns = excludePrefixes
    .filter((p) => p.length > 0)
    .map((p) => `${p}%`);

  const out: Candidate[] = [];
  // FIRST failure wins: it is the one closest to the cause, and one reason per neighbourhood
  // is what the ledger row holds. Later tables still run — the degrade is unchanged.
  let failure: PairingFailure | null = null;
  for (const spec of EMBEDDED_TABLES) {
    try {
      // The statement is built by beliefCandidateSql (exported, and PLAN-guarded): its ORDER BY
      // is fenced from the approximate ivfflat index, because nomination is an existence
      // question and an ANN scan cannot answer one. See that function's header.
      const r = await pool.query(
        beliefCandidateSql(spec, activeEmbeddingColumn()),
        [
          srcEmbedding,
          src.projectId,
          src.id,
          src.type,
          cfg.pairMinCosine,
          cfg.pairMaxCosine,
          excludeKinds,
          excludePrefixPatterns,
          cfg.pairTopK,
        ]
      );
      for (const row of r.rows) {
        const cosine = Number(row.cosine);
        if (!Number.isFinite(cosine)) continue;
        out.push({
          id: row.id,
          type: spec.type,
          content: row.content ?? '',
          createdAt: row.created_at ?? null,
          cosine,
        });
      }
    } catch (e) {
      logger.warn(`🧪 belief pairing: candidate query failed on ${spec.table} for ${src.id}`, {
        metadata: { error: (e as Error)?.message },
      });
      // degrade: skip this table, keep whatever we found — but REPORT it.
      failure = failure ?? describePairingError(e, 'candidate_query', spec.table);
    }
  }

  // Global top-K by cosine across both tables.
  out.sort((x, y) => y.cosine - x.cosine);
  const candidates = out.slice(0, cfg.pairTopK);
  return failure ? { ok: false, reason: failure, partial: candidates } : { ok: true, candidates };
}
