/**
 * AIDIS Technical Decisions Handler
 * 
 * This is the INSTITUTIONAL MEMORY KEEPER - preventing teams from repeating mistakes!
 * 
 * Functions:
 * - Record architectural decisions with full context and rationale
 * - Track alternatives considered and why they were rejected
 * - Monitor decision outcomes and lessons learned
 * - Search decisions by impact, component, or topic
 * - Manage decision lifecycle (active -> deprecated -> superseded)
 * - Generate decision reports and summaries
 * 
 * This solves critical problems:
 * - "Why did we choose this library/framework/pattern?"
 * - "What were the trade-offs when we made this choice?"
 * - "Have we tried this approach before? What happened?"
 * - "What decisions are affecting this component?"
 * - Knowledge loss when team members leave
 */

import { db } from '../config/database.js';
import { embeddingService } from '../services/embedding.js';
import { activeEmbeddingColumn, boundEmbeddingText } from '../config/embeddingConfig.js';
import { projectHandler } from './project.js';
import { logDecisionEvent, logEvent } from '../middleware/eventLogger.js';
import { logger } from '../utils/logger.js';
// SCOPE §3.3, folded into P5.5. `decision_record` / `decision_update` stored tags COMPLETELY
// RAW — the ONLY callers of validateAndNormalizeTags were handlers/context.ts:302 and :1414.
// ⚠️ IT WARNS AND STORES. The function's contract is "NEVER throws, NEVER rejects, NEVER
// drops a tag" (utils/threadingTags.ts:137-138) and that is load-bearing: this change rides
// inside a schema migration, and a validator that began REJECTING would be a breaking change
// for every customer in the worst possible packaging (SCOPE §8.6).
import { validateAndNormalizeTags } from '../utils/threadingTags.js';
// Tag-spelling collisions — see services/tagSpellingWriteCheck.ts. Decisions are the other write path
// that stored tags unvalidated, so they get the same warning as tasks.
import { tagSpellingWriteWarnings } from '../services/tagSpellingWriteCheck.js';
import { recordWriteWithoutSession } from '../utils/sessionObservability.js';
import { metadataMergeSql } from '../utils/metadataMerge.js';
import { buildSearchMatchPredicate, capSearchLimit } from '../utils/idResolver.js';
import { triggerBeliefAdjudication } from '../services/belief/beliefHook.js';
import { onEmbedFailure } from '../services/embedResilience.js';
import { IMPLEMENTATION_STATUSES } from '../config/decisionVocab.js';
import type { OutcomeStatus, ImplementationStatus, AnswerStatus } from '../config/decisionVocab.js';
import { persistDeclaredLimbsForRow } from '../services/declaredLimbsStore.js';

/**
 * Build the hybrid embedding text for a decision, mirroring how context_store
 * combines title + tags + type + content. A decision's "content" is the union of
 * its human-authored prose fields — title, description, rationale, and (when set)
 * the problem statement and success criteria — so a semantically-equivalent query
 * ('critical security decision', 'authentication') lands near the right row.
 *
 * Pure + side-effect-free so it can be reused by record, update, and the backfill.
 */
export function buildDecisionEmbeddingText(parts: {
  decisionType?: string | null;
  title?: string | null;
  description?: string | null;
  rationale?: string | null;
  problemStatement?: string | null;
  successCriteria?: string | null;
  tags?: string[] | null;
}): string {
  const text = [
    parts.decisionType ? `Type: ${parts.decisionType}` : '',
    parts.tags && parts.tags.length ? `Tags: ${parts.tags.join(', ')}` : '',
    parts.title || '',
    parts.description || '',
    parts.rationale || '',
    parts.problemStatement || '',
    parts.successCriteria || '',
  ].map(s => (s || '').trim()).filter(Boolean).join('\n');

  // EMBED-BOUNDED — the decision-side counterpart of the invariant
  // handlers/context.ts has always had (it embeds only content.substring(0, 1000)).
  //
  // THE BUG THIS CLOSES: this text concatenates description + rationale + problemStatement
  // + successCriteria UNBOUNDED and hands the whole thing to the embedder, which THROWS
  // above EMBEDDING_MAX_TEXT_LENGTH (8000). Both call sites catch that throw and store the
  // decision WITHOUT an embedding — so a long decision silently drops out of semantic
  // search. This was already reachable BEFORE the field-cap fix (the old caps summed to
  // ~11,255 chars > 8000); raising the prose fields to their TEXT columns' ceiling would
  // have made it routine. Bounding HERE (in the one shared builder, not at the two call
  // sites) means record AND re-embed are both covered and a third call site inherits it.
  //
  // Truncating the EMBED INPUT never truncates the STORED decision — the full prose is
  // persisted either way. Leading text still retrieves; no embedding retrieves nothing.
  return boundEmbeddingText(text);
}

/** Format a JS number[] as a pgvector literal: `[a,b,c]`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export interface TechnicalDecision {
  id: string;
  projectId: string;
  sessionId: string | null;
  decisionType: DecisionType;
  title: string;
  description: string;
  rationale: string;
  problemStatement: string | null;
  successCriteria: string | null;
  alternativesConsidered: Alternative[];
  decisionDate: Date;
  decidedBy: string | null;
  stakeholders: string[];
  status: DecisionStatus;
  supersededBy: string | null;
  supersededDate: Date | null;
  supersededReason: string | null;
  impactLevel: ImpactLevel;
  affectedComponents: string[];
  tags: string[];
  category: string | null;
  outcomeStatus: OutcomeStatus;
  outcomeNotes: string | null;
  lessonsLearned: string | null;
  implementationStatus: ImplementationStatus;
  /** SOFT-DELETE stamp; absent when the projection did not select it. */
  archivedAt?: Date | null;
  /**
   * Arbitrary structured annotations (jsonb, default {}). Persisted from
   * decision_record(metadata:{...}) (migration 047); mirrors contexts/tasks metadata.
   */
  metadata: Record<string, any>;
  /**
   * Tag-grammar warnings from THIS write (SCOPE §3.3). Present only when the write produced
   * one. NOTHING WAS REJECTED AND NOTHING WAS DROPPED — the tag is stored as given (after
   * canonical casing); this says it probably will not thread the way its prefix implies.
   */
  tagWarnings?: string[];
  /**
   * Vector-similarity score (0–100) to the search query, populated ONLY by
   * searchDecisions when a semantic `query` was supplied. Mirrors the `similarity`
   * surfaced by context_search so callers/UI can rank + display a relevance number.
   * Undefined for record/update results and for filter-only searches.
   */
  similarity?: number;

  // ── THE DECISION INBOX ──────────────────────
  /** open | discussing | decided. DEFAULT 'decided' — see config/decisionVocab.ts. */
  answerStatus: AnswerStatus;
  /** The one-sentence thing being decided. Required (non-empty) whenever answerStatus='open'. */
  question: string | null;
  /** Required >=2 entries, each with >=1 pro and >=1 con, whenever answerStatus='open'. */
  options: DecisionOption[];
  /** The `options[].key` decision_answer selected. Null until answered. */
  chosen: string | null;
  answeredAt: Date | null;
  answeredBy: string | null;
  answerNote: string | null;
  deadline: Date | null;
}

/**
 * One choice in an open decision's `options` array (migration 104). `pros`/`cons` are
 * REQUIRED non-empty whenever the owning decision's answerStatus is 'open' — enforced by
 * `validateOpenDecisionShape` below, not by this type (a record/update call with
 * answerStatus omitted or 'discussing'/'decided' may carry options with empty pros/cons,
 * or no options at all; the shape is shared, the RULE is conditional on the lane).
 */
export interface DecisionOption {
  key: string;
  label: string;
  pros: string[];
  cons: string[];
  recommended?: boolean;
}

/**
 * Typed refusal for a malformed OPEN decision: "an OPEN
 * decision carries a question + options with pros/cons, or is refused." Thrown BEFORE any
 * INSERT/UPDATE runs (see validateOpenDecisionShape's call sites in recordDecision /
 * updateDecision) — NOTHING IS WRITTEN. `field` names exactly which part of the shape
 * failed, so the caller can fix that one thing rather than re-guess the whole payload.
 */
export class DecisionOpenValidationError extends Error {
  readonly code = 'DECISION_OPEN_INVALID';

  constructor(public readonly field: string, message: string) {
    super(`${message} NOTHING WAS WRITTEN. [DECISION_OPEN_INVALID:${field}]`);
    this.name = 'DecisionOpenValidationError';
  }
}

/**
 * The invariant: an OPEN decision must carry a non-empty `question` AND >=2 `options`,
 * each with >=1 pro and >=1 con (and a non-empty, unique `key`+`label` — required for
 * `decision_answer` to be able to select one unambiguously). Checked in this ORDER
 * (question -> option count -> per-option shape) so the refusal names the FIRST thing
 * wrong, matching the acceptance order (an earlier decision item 1: "no question, or one
 * option, or an option with empty pros or empty cons").
 *
 * PURE — no DB, no throw-vs-return ambiguity (it only ever throws or returns void) — so
 * both recordDecision (the call's own fields) and updateDecision (the MERGED row: existing
 * question/options overridden by whichever this call supplied) share ONE definition of
 * "well-formed".
 */
export function validateOpenDecisionShape(
  question: string | null | undefined,
  options: DecisionOption[] | null | undefined,
): void {
  if (!question || !question.trim()) {
    throw new DecisionOpenValidationError(
      'question',
      "An OPEN decision requires a non-empty `question` — the one sentence being decided."
    );
  }

  const opts = options ?? [];
  if (opts.length < 2) {
    throw new DecisionOpenValidationError(
      'options',
      `An OPEN decision requires at least 2 options to choose between (got ${opts.length}).`
    );
  }

  const seenKeys = new Set<string>();
  opts.forEach((opt, i) => {
    const label = `options[${i}]`;
    if (!opt?.key || !opt.key.trim()) {
      throw new DecisionOpenValidationError('options', `${label} is missing a non-empty \`key\`.`);
    }
    if (seenKeys.has(opt.key)) {
      throw new DecisionOpenValidationError(
        'options',
        `${label} reuses key "${opt.key}" — option keys must be unique so decision_answer can select one unambiguously.`
      );
    }
    seenKeys.add(opt.key);
    if (!opt.label || !opt.label.trim()) {
      throw new DecisionOpenValidationError('options', `${label} ("${opt.key}") is missing a non-empty \`label\`.`);
    }
    if (!opt.pros || opt.pros.length === 0) {
      throw new DecisionOpenValidationError(
        'options[].pros',
        `${label} ("${opt.key}") has no pros — every option needs at least one pro.`
      );
    }
    if (!opt.cons || opt.cons.length === 0) {
      throw new DecisionOpenValidationError(
        'options[].cons',
        `${label} ("${opt.key}") has no cons — every option needs at least one con.`
      );
    }
  });
}

/**
 * Typed refusal for `decision_answer` / `decision_discuss`.
 * Distinct from DecisionOpenValidationError: this is not "malformed shape", it's "the
 * ACTION doesn't apply to this row's current state" — already decided, or an option key
 * that doesn't exist on this row's own `options`. Thrown before any UPDATE — the row is
 * unchanged.
 */
export class DecisionInboxActionError extends Error {
  constructor(
    public readonly code: 'DECISION_ALREADY_DECIDED' | 'DECISION_UNKNOWN_OPTION',
    message: string,
  ) {
    super(`${message} [${code}]`);
    this.name = 'DecisionInboxActionError';
  }
}

export type DecisionType = 
  | 'architecture' | 'library' | 'framework' | 'pattern' | 'api_design' 
  | 'database' | 'deployment' | 'security' | 'performance' | 'ui_ux' 
  | 'testing' | 'tooling' | 'process' | 'naming_convention' | 'code_style';

export type DecisionStatus = 'active' | 'deprecated' | 'superseded' | 'under_review';

export type ImpactLevel = 'low' | 'medium' | 'high' | 'critical';

// LEARNING-LOOP VOCABULARY — re-exported from the single-source domain
// (config/decisionVocab.ts) rather than re-declared here. These two unions
// used to be hand-written copies of the same lists the zod validator, the opRegistry help
// text, and the DB CHECK constraints each spell out independently; adding the read filter
// this task needed would have made a fifth and sixth copy.
export type { OutcomeStatus, ImplementationStatus } from '../config/decisionVocab.js';

/**
 * Normalize a caller-supplied pagination offset to a non-negative integer.
 *
 * ONE definition, exported, because TWO consumers need the SAME number and a disagreement
 * between them is a lying `hasMore`: the handler uses it to build `OFFSET $n`, and the route
 * uses it to compute `offset + returned < total`. If the route clamped differently from the
 * SQL, `hasMore` would describe a window the query never returned. Absent, null, negative,
 * NaN and non-integer all collapse to 0 — i.e. the first page, which is exactly the
 * pre-change behaviour.
 */
export function normalizeOffset(offset: unknown): number {
  return typeof offset === 'number' && Number.isInteger(offset) && offset > 0 ? offset : 0;
}

export interface Alternative {
  name: string;
  pros: string[];
  cons: string[];
  reasonRejected: string;
  cost?: string;
  timeframe?: string;
}

export interface RecordDecisionRequest {
  projectId?: string;
  sessionId?: string;
  /** Connection scope for per-connection session attribution (no global fallback). */
  connectionId?: string;
  decisionType: DecisionType;
  title: string;
  description: string;
  rationale: string;
  problemStatement?: string;
  successCriteria?: string;
  implementationStatus?: ImplementationStatus;
  // A1: outcome fields are settable up front at record time (mirroring
  // implementationStatus). Default outcome_status stays 'unknown' in the DB if unset.
  outcomeStatus?: OutcomeStatus;
  outcomeNotes?: string;
  lessonsLearned?: string;
  alternativesConsidered?: Alternative[];
  decidedBy?: string;
  stakeholders?: string[];
  impactLevel: ImpactLevel;
  affectedComponents?: string[];
  tags?: string[];
  category?: string;
  /** Arbitrary structured annotations persisted to technical_decisions.metadata (jsonb). */
  metadata?: Record<string, any>;
  // ── THE DECISION INBOX ──────────────────────────────────
  /** Omitted -> stored as 'decided' (today's behaviour, unchanged). */
  answerStatus?: AnswerStatus;
  /** REQUIRED (non-empty) when answerStatus='open' — see validateOpenDecisionShape. */
  question?: string;
  /** REQUIRED >=2 entries when answerStatus='open' — see validateOpenDecisionShape. */
  options?: DecisionOption[];
  deadline?: string | null;
}

export interface UpdateDecisionRequest {
  decisionId: string;
  status?: DecisionStatus;
  outcomeStatus?: OutcomeStatus;
  outcomeNotes?: string;
  lessonsLearned?: string;
  implementationStatus?: ImplementationStatus;
  successCriteria?: string;
  problemStatement?: string;
  supersededBy?: string;
  supersededReason?: string;
  // CURATE (T1 item 5): editable core prose + tags. T1 item 6: metadata is MERGED
  // (null deletes a key), never a wholesale replace.
  title?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, any>;
  // ── THE DECISION INBOX ──────────────────────────────────
  // Setting answerStatus='open' applies validateOpenDecisionShape against the MERGED row
  // (this call's question/options if supplied, else the EXISTING row's) — see updateDecision.
  answerStatus?: AnswerStatus;
  question?: string;
  options?: DecisionOption[];
  deadline?: string | null;
}

export interface SearchDecisionsRequest {
  projectId?: string;
  decisionType?: DecisionType;
  status?: DecisionStatus;
  // outcomeStatus filters the learning-loop RESULT column (outcome_status), which is a
  // DIFFERENT column from `status` (the active/deprecated/… lifecycle). This is the
  // moat-critical read filter: "which decisions FAILED / SUCCEEDED?" — what the GAP1
  // Evaluator needs and what `status` cannot express.
  outcomeStatus?: OutcomeStatus;
  // implementationStatus filters the BUILD column (implementation_status) — a THIRD column,
  // distinct from both `status` (lifecycle) and `outcomeStatus` (result). This is the
  // half-executed-decision read: "which decisions are still only PLANNED?" The field was
  // already returned in every result row but was not queryable, so nothing ever read it in
  // aggregate and nothing corrected it.
  implementationStatus?: ImplementationStatus;
  // THE DECISION INBOX filter: open | discussing | decided —
  // a FOURTH status column, distinct from status/outcomeStatus/implementationStatus.
  // answerStatus:'open' is the inbox read: "every decision waiting on a human."
  answerStatus?: AnswerStatus;
  impactLevel?: ImpactLevel;
  component?: string;
  tags?: string[];
  query?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  /**
   * REAL PAGINATION: the window START. With `limit` capped at 100 and no
   * offset, a filter class larger than 100 was not enumerable through the public tool at all.
   * Zero/absent = the first page (identical to the pre-change behaviour).
   */
  offset?: number;
  /**
   * Sort direction over decision_date. 'newest' (default, and the only behaviour that existed
   * before) = DESC; 'oldest' = ASC, which is what the staleness question ("planned the
   * longest") actually asks for. On a semantic query this is the tiebreaker AFTER
   * search_score, so relevance ranking is unchanged.
   */
  sortDirection?: 'newest' | 'oldest';
  // A6: surfaced through the route so the filter the model can set actually arrives.
  // The handler ALWAYS selects the outcome columns (SELECT *) and the route maps
  // outcomeStatus/outcomeNotes/lessonsLearned into every result, so this is the
  // display/intent hint the search advertises; accepting it here keeps the
  // declared==forwarded==accepted contract intact (no silently-dropped param).
  includeOutcome?: boolean;
  // SOFT-DELETE: when falsy (default), exclude archived rows
  // (archived_at IS NULL); when true, include archived rows too.
  includeArchived?: boolean;
}

class DecisionsHandler {

  /**
   * Record a new technical decision
   */
  async recordDecision(request: RecordDecisionRequest): Promise<TechnicalDecision> {
    logger.info(`📝 Recording ${request.decisionType} decision: "${request.title}"`);

    try {
      const projectId = await this.ensureProjectId(request.projectId);

      // Get active session for decision tracking
      let sessionId: string | null = request.sessionId || null;
      if (!sessionId) {
        try {
          const { SessionTracker } = await import('../services/session/SessionTracker.js');
          // Connection-scoped: attach to THIS connection's session only (no leak).
          sessionId = await SessionTracker.getActiveSession(request.connectionId);
          if (sessionId) {
            logger.info(`📋 Linking decision to active session: ${sessionId.substring(0, 8)}...`);
          }
        } catch (error) {
          logger.warn('⚠️  Failed to get active session for decision', { metadata: { error } });
        }
      }
      // Observability (Phase 5, F3): decision_record writing with NO session attributed
      // (session_id NULL) — surface the attribution loss as a visible counter.
      if (!sessionId) recordWriteWithoutSession('decision_record');

      // Validate required fields
      if (!request.title?.trim()) {
        throw new Error('Decision title is required');
      }
      if (!request.description?.trim()) {
        throw new Error('Decision description is required');
      }
      if (!request.rationale?.trim()) {
        throw new Error('Decision rationale is required');
      }

      // THE DECISION INBOX INVARIANT: an OPEN decision carries
      // a question + >=2 options with pros/cons, or is refused — TYPED, naming the field,
      // BEFORE anything is written. `answerStatus` omitted skips this entirely and behaves
      // exactly as today (stored as 'decided' by the INSERT's COALESCE below).
      const answerStatus: AnswerStatus = request.answerStatus ?? 'decided';
      if (answerStatus === 'open') {
        validateOpenDecisionShape(request.question, request.options);
      }

      // Check for duplicate decisions
      const existingDecision = await this.checkForDuplicate(
        projectId,
        request.title,
        request.decisionType
      );

      if (existingDecision) {
        logger.info(`⚠️  Similar decision exists: ${existingDecision.title}`);
        // Could return warning but allow duplicate, or suggest linking
      }

      // SCOPE §3.3 — WARN AND STORE, NEVER REJECT. Placed BEFORE the embedding text is
      // built and before the INSERT (the same ordering handlers/context.ts:302 uses) so the
      // tag a caller copies out of the response is exactly the tag that was embedded and
      // stored — one normalization, not a second spelling downstream.
      const tagValidation = validateAndNormalizeTags(request.tags);
      request = { ...request, tags: tagValidation.tags };
      if (tagValidation.warnings.length > 0) {
        logger.warn(`🏷️  decision_record linking-grammar normalization: ${tagValidation.warnings.join(' ')}`);
      }

      // EMBED-ON-WRITE: generate a semantic embedding from the decision's prose,
      // mirroring context_store. Reuses the SAME local embedder + 1536 dimensions
      // contexts use (FREE — no paid API). If embedding generation fails, we degrade
      // gracefully: store the decision WITHOUT an embedding (search falls back to the
      // trgm path) rather than failing the whole record — the decision must persist.
      const embeddingText = buildDecisionEmbeddingText({
        decisionType: request.decisionType,
        title: request.title,
        description: request.description,
        rationale: request.rationale,
        problemStatement: request.problemStatement,
        successCriteria: request.successCriteria,
        tags: request.tags,
      });
      let embeddingLiteral: string | null = null;
      try {
        const embeddingResult = await embeddingService.generateEmbedding({ text: embeddingText, role: 'document' });
        embeddingLiteral = toVectorLiteral(embeddingResult.embedding);
        logger.info(`🔮 Generated decision embedding (${embeddingResult.dimensions}D, model: ${embeddingResult.model})`);
      } catch (embedError) {
        // DEGRADE + PERSIST + ALERT (unified resilience, site A). The decision
        // still persists with a NULL embedding (recoverable); onEmbedFailure makes it LOUD
        // (structured log + rate-limited chat alert) and the self-heal worker re-embeds it.
        onEmbedFailure({ table: 'technical_decisions', op: 'create', error: embedError });
      }

      // Insert decision.
      // A1: outcome_status/outcome_notes/lessons_learned are now persisted on CREATE
      // (mirroring implementation_status, which already round-tripped on create).
      // outcome_status COALESCEs to 'unknown' (the DB default) when the caller omits it,
      // so existing callers are unaffected; when supplied (e.g. 'too_early') it sticks.
      const result = await db.query(`
        INSERT INTO technical_decisions (
          project_id, session_id, decision_type, title, description, rationale,
          problem_statement, success_criteria, alternatives_considered,
          decided_by, stakeholders, impact_level, affected_components,
          tags, category, implementation_status,
          outcome_status, outcome_notes, lessons_learned, ${activeEmbeddingColumn()}, metadata,
          answer_status, question, options, deadline
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          COALESCE($16, 'planned'), COALESCE($17, 'unknown'), $18, $19, $20::vector,
          COALESCE($21, '{}'::jsonb),
          COALESCE($22, 'decided'), $23, COALESCE($24, '[]'::jsonb), $25)
        RETURNING *
      `, [
        projectId,
        sessionId,
        request.decisionType,
        request.title.trim(),
        request.description.trim(),
        request.rationale.trim(),
        request.problemStatement?.trim() || null,
        request.successCriteria?.trim() || null,
        JSON.stringify(request.alternativesConsidered || []),
        request.decidedBy?.trim() || null,
        request.stakeholders || [],
        request.impactLevel,
        request.affectedComponents || [],
        request.tags || [],
        request.category?.trim() || null,
        request.implementationStatus || null,
        request.outcomeStatus || null,
        request.outcomeNotes?.trim() || null,
        request.lessonsLearned?.trim() || null,
        embeddingLiteral,
        // metadata: jsonb. COALESCE to '{}' when omitted so an absent metadata is an
        // empty object (matching the column default), never NULL.
        request.metadata ? JSON.stringify(request.metadata) : null,
        // THE DECISION INBOX. answerStatus omitted -> COALESCEs
        // to the column default 'decided' — byte-identical to pre-inbox behaviour.
        request.answerStatus || null,
        request.question?.trim() || null,
        request.options ? JSON.stringify(request.options) : null,
        request.deadline || null,
      ]);

      const decision = this.mapDatabaseRowToDecision(result.rows[0]);

      // DECLARED LIMBS: materialise the limbs this decision declares, from
      // the row as WRITTEN. A decision IS a limb root, so it always declares at least itself.
      // Degrades on error — never fails the write; see declaredLimbs.ts.
      await persistDeclaredLimbsForRow('decision', result.rows[0]);

      // TS004-1: Update session activity after decision recording
      if (request.sessionId) {
        const { SessionTracker } = await import('../services/session/SessionTracker.js');
        await SessionTracker.updateSessionActivity(request.sessionId);
      }

      // SCOPE §3.3: the warning rides back to the CALLER, not just to a server log. A
      // warning only an operator sees is one the tag's author never reads, and the author is
      // the only person who can fix the tag.
      const decisionSpellingWarnings = await tagSpellingWriteWarnings(
        tagValidation.tags, decision.projectId, db,
      );
      const decisionTagWarnings = [...tagValidation.warnings, ...decisionSpellingWarnings];
      if (decisionTagWarnings.length > 0) decision.tagWarnings = decisionTagWarnings;

      logger.info(`✅ Decision recorded: ${decision.id.substring(0, 8)}...`);
      logger.info(`🎯 Impact: ${decision.impactLevel} | Type: ${decision.decisionType}`);
      logger.info(`📊 Alternatives considered: ${decision.alternativesConsidered.length}`);

      // Log the decision creation event
      await logDecisionEvent(decision.id, 'recorded', {
        decision_type: decision.decisionType,
        title: decision.title,
        impact_level: decision.impactLevel,
        affected_components: decision.affectedComponents,
        alternatives_count: decision.alternativesConsidered.length,
        tags: decision.tags,
        has_problem_statement: !!decision.problemStatement,
        has_success_criteria: !!decision.successCriteria
      });

      // BL-9 POST-STORE BELIEF HOOK — the decision is now COMMITTED. Trigger belief
      // adjudication in the BACKGROUND: NON-BLOCKING (returns immediately, never awaited),
      // FAIL-SAFE (wrapped — a belief error never touches this store), CONCURRENCY-BOUNDED
      // (serial worker, embedder-priority) and FLAG-GATED (no-op when MANDREL_BELIEF_ENABLED=
      // false). FORWARD-ONLY: only this new write fires it. EMBEDDING GUARD: a decision may be
      // stored WITHOUT an embedding (embed-on-write degrades gracefully), and findCandidates
      // no-ops on a null embedding anyway — so we skip the enqueue entirely when there is no
      // embedding, avoiding a queue slot that would only find zero candidates.
      if (embeddingLiteral !== null) {
        triggerBeliefAdjudication({
          id: decision.id,
          type: 'decision',
          projectId: decision.projectId,
          content: decision.rationale,
          createdAt: decision.decisionDate,
        });
      }

      return decision;

    } catch (error) {
      // TYPED REFUSAL PASS-THROUGH: DecisionOpenValidationError must survive intact
      // (instanceof-checkable by the route, per taskPunchCompleteness.ts's PunchIncompleteError
      // precedent) — wrapping it in a generic Error below would erase `.code`/`.field` and turn
      // a typed, field-naming refusal back into an opaque one.
      if (error instanceof DecisionOpenValidationError) throw error;
      logger.error('❌ Failed to record decision', error as Error);
      throw new Error(`Decision recording failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update an existing decision (status, outcomes, lessons learned)
   */
  async updateDecision(request: UpdateDecisionRequest): Promise<TechnicalDecision> {
    logger.info(`📝 Updating decision: ${request.decisionId.substring(0, 8)}...`);

    try {
      // THE DECISION INBOX INVARIANT, ON UPDATE TOO: setting
      // answerStatus='open' applies the SAME validateOpenDecisionShape predicate — but against
      // the MERGED row, not just this call's own fields. A caller moving an already-fleshed-out
      // decision to 'open' with `{answerStatus:'open'}` alone must succeed if question/options
      // were set on an EARLIER call and still live on the row (same "evaluated against the
      // merged state" discipline taskPunchCompleteness.ts uses for stage='ready'). Runs BEFORE
      // any UPDATE fields are built — a refusal here writes nothing.
      if (request.answerStatus === 'open') {
        let effectiveQuestion = request.question;
        let effectiveOptions = request.options;
        if (effectiveQuestion === undefined || effectiveOptions === undefined) {
          const current = await db.query(
            `SELECT question, options FROM technical_decisions WHERE id = $1`,
            [request.decisionId]
          );
          if (current.rows.length === 0) {
            throw new Error(`Decision ${request.decisionId} not found`);
          }
          if (effectiveQuestion === undefined) effectiveQuestion = current.rows[0].question;
          if (effectiveOptions === undefined) {
            const rawOptions = current.rows[0].options;
            effectiveOptions = (typeof rawOptions === 'string' ? JSON.parse(rawOptions) : rawOptions) || [];
          }
        }
        validateOpenDecisionShape(effectiveQuestion, effectiveOptions);
      }

      // Build dynamic update query
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      // STATUS — SINGLE SOURCE OF TRUTH.
      // `status` can be set two ways: explicitly by the caller, or IMPLIED by
      // `supersededBy` (supersession means the decision is, by definition,
      // 'superseded'). The bug was that BOTH paths used to emit their own
      // `status = …` fragment into the same UPDATE, so passing them together
      // produced two assignments to one column → Postgres "multiple assignments
      // to column status". The class-fix is to resolve ONE effective status here
      // and emit AT MOST ONE `status =` fragment below — no path can ever add a
      // second. Conflicts are rejected loudly rather than silently writing an
      // incoherent row (e.g. status='active' WITH a superseded_by pointer).
      const supersedes = request.supersededBy !== undefined;
      let effectiveStatus: DecisionStatus | undefined = request.status;
      if (supersedes) {
        if (request.status !== undefined && request.status !== 'superseded') {
          throw new Error(
            `Conflicting update: supersededBy implies status='superseded', but ` +
            `status='${request.status}' was also requested. Omit status (it is ` +
            `implied) or pass status='superseded'.`
          );
        }
        effectiveStatus = 'superseded';
      }

      if (effectiveStatus !== undefined) {
        updateFields.push(`status = $${paramIndex}`);
        values.push(effectiveStatus);
        paramIndex++;
      }

      if (request.outcomeStatus !== undefined) {
        updateFields.push(`outcome_status = $${paramIndex}`);
        values.push(request.outcomeStatus);
        paramIndex++;
      }

      if (request.outcomeNotes !== undefined) {
        updateFields.push(`outcome_notes = $${paramIndex}`);
        values.push(request.outcomeNotes);
        paramIndex++;
      }

      if (request.lessonsLearned !== undefined) {
        updateFields.push(`lessons_learned = $${paramIndex}`);
        values.push(request.lessonsLearned);
        paramIndex++;
      }

      if (request.implementationStatus !== undefined) {
        updateFields.push(`implementation_status = $${paramIndex}`);
        values.push(request.implementationStatus);
        paramIndex++;
      }

      if (request.successCriteria !== undefined) {
        updateFields.push(`success_criteria = $${paramIndex}`);
        values.push(request.successCriteria);
        paramIndex++;
      }

      if (request.problemStatement !== undefined) {
        updateFields.push(`problem_statement = $${paramIndex}`);
        values.push(request.problemStatement);
        paramIndex++;
      }

      if (supersedes) {
        updateFields.push(`superseded_by = $${paramIndex}`);
        updateFields.push(`superseded_date = CURRENT_TIMESTAMP`);
        // NOTE: status='superseded' is NOT emitted here. The implied status is
        // resolved once into `effectiveStatus` above and emitted as the single
        // `status =` fragment — so this branch can never add a duplicate.
        values.push(request.supersededBy);
        paramIndex++;
      }

      if (request.supersededReason !== undefined) {
        updateFields.push(`superseded_reason = $${paramIndex}`);
        values.push(request.supersededReason);
        paramIndex++;
      }

      // CURATE (T1 item 5): edit core prose + tags after the fact.
      if (request.title !== undefined) {
        updateFields.push(`title = $${paramIndex}`);
        values.push(request.title.trim());
        paramIndex++;
      }
      if (request.description !== undefined) {
        updateFields.push(`description = $${paramIndex}`);
        values.push(request.description.trim());
        paramIndex++;
      }
      // SCOPE §3.3 on the UPDATE path too. `decision_update` REPLACES the tag set, so a
      // re-tag can break a thread with a malformed join key exactly as a create can; guarding
      // only the create surface would fix the reported half of the class and leave the other
      // half open (CLASSES.md C5: if you fixed one path, show the others).
      let updateTagWarnings: string[] = [];
      if (request.tags !== undefined) {
        const v = validateAndNormalizeTags(request.tags);
        updateTagWarnings = v.warnings;
        if (v.warnings.length > 0) {
          logger.warn(`🏷️  decision_update linking-grammar normalization: ${v.warnings.join(' ')}`);
        }
        updateFields.push(`tags = $${paramIndex}`);
        values.push(v.tags);
        paramIndex++;
      }
      // METADATA MERGE (T1 item 6): shallow-merge incoming over existing in SQL (atomic);
      // explicit null deletes that key. Never a wholesale replace.
      if (request.metadata !== undefined) {
        const merge = metadataMergeSql('metadata', paramIndex, request.metadata);
        updateFields.push(`metadata = ${merge.expr}`);
        values.push(...merge.params);
        paramIndex += merge.params.length;
      }

      // THE DECISION INBOX. Validated (when transitioning to
      // 'open') above, before any field was built.
      if (request.answerStatus !== undefined) {
        updateFields.push(`answer_status = $${paramIndex}`);
        values.push(request.answerStatus);
        paramIndex++;
      }
      if (request.question !== undefined) {
        updateFields.push(`question = $${paramIndex}`);
        values.push(request.question);
        paramIndex++;
      }
      if (request.options !== undefined) {
        updateFields.push(`options = $${paramIndex}::jsonb`);
        values.push(JSON.stringify(request.options));
        paramIndex++;
      }
      if (request.deadline !== undefined) {
        updateFields.push(`deadline = $${paramIndex}`);
        values.push(request.deadline);
        paramIndex++;
      }

      if (updateFields.length === 0) {
        throw new Error('No update fields provided');
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(request.decisionId);

      const sql = `
        UPDATE technical_decisions 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await db.query(sql, values);

      if (result.rows.length === 0) {
        throw new Error(`Decision ${request.decisionId} not found`);
      }

      const decision = this.mapDatabaseRowToDecision(result.rows[0]);

      // DECLARED LIMBS: RE-DERIVE unconditionally from the UPDATED row —
      // never gated on which fields the caller happened to touch. `updateDecision` can edit
      // title, description, problem_statement and tags, all of which feed the derivation;
      // an enumerated predicate here is the drift this re-derivation exists to prevent.
      await persistDeclaredLimbsForRow('decision', result.rows[0]);

      // RE-EMBED ON TEXT CHANGE: if any field that feeds the embedding text changed,
      // regenerate the embedding from the UPDATED row so semantic search stays in sync.
      // T1 item 5 added title/description/tags as editable — those ALSO feed
      // buildDecisionEmbeddingText, so include them in the trigger (previously only
      // problem_statement/success_criteria could change). Best-effort: a failure leaves
      // the prior embedding intact and never fails the update.
      const textChanged =
        request.problemStatement !== undefined || request.successCriteria !== undefined ||
        request.title !== undefined || request.description !== undefined ||
        request.tags !== undefined;
      if (textChanged) {
        try {
          const row = result.rows[0];
          const embeddingText = buildDecisionEmbeddingText({
            decisionType: row.decision_type,
            title: row.title,
            description: row.description,
            rationale: row.rationale,
            problemStatement: row.problem_statement,
            successCriteria: row.success_criteria,
            tags: row.tags,
          });
          const embeddingResult = await embeddingService.generateEmbedding({ text: embeddingText, role: 'document' });
          await db.query(
            `UPDATE technical_decisions SET ${activeEmbeddingColumn()} = $1::vector WHERE id = $2`,
            [toVectorLiteral(embeddingResult.embedding), decision.id]
          );
          logger.info(`🔮 Re-embedded decision ${decision.id.substring(0, 8)}... after text change`);
        } catch (embedError) {
          // DEGRADE + ALERT (unified resilience, site B). The update already
          // succeeded; the prior embedding is retained. onEmbedFailure logs + rate-limited-alerts;
          // the self-heal worker only re-embeds NULL rows, so a retained-prior row is untouched
          // by it (this row stays searchable on its previous vector until the next edit).
          onEmbedFailure({ table: 'technical_decisions', op: 'update', recordId: decision.id, error: embedError });
        }
      }

      logger.info(`✅ Decision updated: ${decision.status} | Outcome: ${decision.outcomeStatus}`);
      
      // Log the decision update event
      await logDecisionEvent(decision.id, 'updated', {
        status: decision.status,
        outcome_status: decision.outcomeStatus,
        outcome_notes: decision.outcomeNotes,
        lessons_learned: decision.lessonsLearned,
        superseded_by: decision.supersededBy,
        superseded_reason: decision.supersededReason,
        update_fields: Object.keys(request).filter(k => k !== 'decisionId' && request[k as keyof typeof request] !== undefined)
      });

      // SCOPE §3.3: surface the re-tag's warnings to the caller as well as the log.
      if (updateTagWarnings.length > 0) decision.tagWarnings = updateTagWarnings;

      return decision;

    } catch (error) {
      // TYPED REFUSAL PASS-THROUGH — see the matching comment in recordDecision.
      if (error instanceof DecisionOpenValidationError) throw error;
      logger.error('❌ Failed to update decision', error as Error);
      throw new Error(`Decision update failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * decision_answer: pick an option on an open/discussing
   * decision. Sets chosen/answered_at/answered_by, flips answer_status to 'decided', and
   * folds every NON-chosen option into `alternatives_considered` — {name:label, pros, cons,
   * reasonRejected: note ?? 'not chosen'} — so the existing learning loop (record ->
   * evaluate) keeps working on answered decisions exactly as it does on decisions answered
   * the old way (alternativesConsidered supplied at record time). Alternatives already on
   * the row (e.g. supplied at record time alongside `options`) are PRESERVED — the fold
   * APPENDS to them, it never overwrites (round-2 critic T1).
   *
   * Refused (row UNCHANGED, nothing written) when: the decision is already `decided`, or
   * `option` does not match any of this row's own `options[].key`. The `WHERE answer_status
   * <> 'decided'` guard on the UPDATE closes the race between the read above and the write
   * (a concurrent second answer): if it matches zero rows, the decision became decided in
   * between and this call is refused exactly as if it had lost the read-check race outright.
   */
  async answerDecision(
    decisionId: string,
    option: string,
    note: string | undefined,
    answeredBy: string | null | undefined,
  ): Promise<TechnicalDecision> {
    logger.info(`📥 Answering decision: ${decisionId.substring(0, 8)}... (option: ${option})`);

    const current = await db.query(
      `SELECT answer_status, options, alternatives_considered FROM technical_decisions WHERE id = $1`,
      [decisionId]
    );
    if (current.rows.length === 0) {
      throw new Error(`Decision ${decisionId} not found`);
    }
    if (current.rows[0].answer_status === 'decided') {
      throw new DecisionInboxActionError(
        'DECISION_ALREADY_DECIDED',
        `Decision ${decisionId} is already decided — refusing to answer again.`
      );
    }
    const rawOptions = current.rows[0].options;
    const options: DecisionOption[] = (typeof rawOptions === 'string' ? JSON.parse(rawOptions) : rawOptions) || [];
    const chosenOption = options.find((o) => o.key === option);
    if (!chosenOption) {
      throw new DecisionInboxActionError(
        'DECISION_UNKNOWN_OPTION',
        `Unknown option "${option}" on decision ${decisionId} — valid keys: ${options.map((o) => o.key).join(', ') || '(none)'}.`
      );
    }

    const rawExistingAlternatives = current.rows[0].alternatives_considered;
    const existingAlternatives: Alternative[] =
      (typeof rawExistingAlternatives === 'string' ? JSON.parse(rawExistingAlternatives) : rawExistingAlternatives) || [];

    const trimmedNote = note?.trim() || null;
    const reasonRejected = trimmedNote || 'not chosen';
    // PRESERVE, THEN APPEND (round-2 critic T1): whatever was already on the row stays
    // exactly as-is, in order; the non-chosen options from THIS answer are folded in after.
    const alternativesConsidered: Alternative[] = [
      ...existingAlternatives,
      ...options
        .filter((o) => o.key !== option)
        .map((o) => ({ name: o.label, pros: o.pros, cons: o.cons, reasonRejected })),
    ];

    const result = await db.query(
      `UPDATE technical_decisions
          SET chosen = $1,
              answered_at = CURRENT_TIMESTAMP,
              answered_by = $2,
              answer_status = 'decided',
              answer_note = $3,
              alternatives_considered = $4::jsonb,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $5 AND answer_status <> 'decided'
        RETURNING *`,
      [option, answeredBy || null, trimmedNote, JSON.stringify(alternativesConsidered), decisionId]
    );
    if (result.rows.length === 0) {
      throw new DecisionInboxActionError(
        'DECISION_ALREADY_DECIDED',
        `Decision ${decisionId} is already decided — refusing to answer again.`
      );
    }

    const decision = this.mapDatabaseRowToDecision(result.rows[0]);
    await persistDeclaredLimbsForRow('decision', result.rows[0]);
    await logDecisionEvent(decision.id, 'answered', {
      option, chosen: decision.chosen, answered_by: decision.answeredBy,
      alternatives_count: decision.alternativesConsidered.length,
    });
    logger.info(`✅ Decision answered: ${decision.id.substring(0, 8)}... chose "${option}"`);
    return decision;
  }

  /**
   * decision_discuss: the escape hatch — kick an open decision
   * back for more context instead of picking an option. Sets answer_status='discussing' and
   * APPENDS `note` to `answer_note` (existing note, if any, is preserved above the new one —
   * discuss is a log, not a replace). Refused (row unchanged) once the decision is already
   * `decided` — you cannot discuss your way out of a choice that's already been made.
   */
  async discussDecision(decisionId: string, note: string | undefined): Promise<TechnicalDecision> {
    logger.info(`💬 Discussing decision: ${decisionId.substring(0, 8)}...`);

    const current = await db.query(
      `SELECT answer_status, answer_note FROM technical_decisions WHERE id = $1`,
      [decisionId]
    );
    if (current.rows.length === 0) {
      throw new Error(`Decision ${decisionId} not found`);
    }
    if (current.rows[0].answer_status === 'decided') {
      throw new DecisionInboxActionError(
        'DECISION_ALREADY_DECIDED',
        `Decision ${decisionId} is already decided — refusing to reopen for discussion.`
      );
    }

    const trimmedNote = note?.trim() || null;
    const existingNote: string | null = current.rows[0].answer_note ?? null;
    const mergedNote = trimmedNote
      ? (existingNote ? `${existingNote}\n${trimmedNote}` : trimmedNote)
      : existingNote;

    const result = await db.query(
      `UPDATE technical_decisions
          SET answer_status = 'discussing',
              answer_note = $1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND answer_status <> 'decided'
        RETURNING *`,
      [mergedNote, decisionId]
    );
    if (result.rows.length === 0) {
      throw new DecisionInboxActionError(
        'DECISION_ALREADY_DECIDED',
        `Decision ${decisionId} is already decided — refusing to reopen for discussion.`
      );
    }

    const decision = this.mapDatabaseRowToDecision(result.rows[0]);
    await logDecisionEvent(decision.id, 'discussed', { note: trimmedNote });
    logger.info(`✅ Decision moved to discussing: ${decision.id.substring(0, 8)}...`);
    return decision;
  }

  /**
   * Search technical decisions with various filters
   */
  async searchDecisions(request: SearchDecisionsRequest): Promise<TechnicalDecision[]> {
    logger.info(`🔍 Searching decisions...`);

    try {
      const projectId = await this.ensureProjectId(request.projectId);

      // SEMANTIC SEARCH (mirrors context_search): when a free-text query is given,
      // rank by vector similarity `1 - (embedding <=> queryVec)` instead of plain
      // text matching, so a semantically-equivalent query surfaces the right
      // decision even with zero literal word overlap (the eval's failing case).
      //
      // The text/trgm signal is BLENDED in as a fallback so:
      //   - un-embedded rows (legacy, pre-backfill) still match on their text, and
      //   - an exact literal hit isn't demoted by a slightly-lower cosine score.
      // A row with NEITHER signal (no embedding AND no text match) is excluded —
      // same effect as the old ILIKE filter, so we never flood results with noise.
      const isSemantic = !!(request.query && request.query.trim() && request.query !== '*');

      let queryEmbeddingLiteral: string | null = null;
      if (isSemantic) {
        try {
          const queryEmbedding = await embeddingService.generateEmbedding({ text: request.query!.trim(), role: 'query' });
          queryEmbeddingLiteral = toVectorLiteral(queryEmbedding.embedding);
        } catch (embedError) {
          // Degrade to pure text matching if the embedder is unavailable.
          logger.warn('⚠️  Failed to embed decision search query — falling back to text matching', {
            metadata: { message: (embedError as Error)?.message }
          });
        }
      }

      // SINGLE SOURCE OF TRUTH for the filter set: build the filtered
      // inner query (WHERE + optional score column, no ORDER/LIMIT) via the shared
      // buildDecisionFilterQuery — the SAME builder countDecisions() uses — so `total`
      // can never drift from the page's filter set (one filter clause, not
      // two). Here we append the ranking + the (capped) page LIMIT on top of it.
      const { baseSql, params, orderBy, nextParamIndex } =
        this.buildDecisionFilterQuery(request, projectId, queryEmbeddingLiteral);

      let sql = `${baseSql}${orderBy} LIMIT $${nextParamIndex}`;
      // AMBIGUITY CAP: an ambiguous (non-full-UUID) id-prefix query can
      // admit many rows via the id-prefix OR-clause; cap its page at SEARCH_ID_MAX_CANDIDATES
      // (mirrors the resolver's LIMIT 25 guard) so an absurdly short prefix can't pull
      // unbounded rows. A full-UUID or non-id query keeps the caller's requested limit.
      params.push(capSearchLimit(request.query, request.limit || 20));

      // REAL PAGINATION: the window START. Appended only when a positive
      // offset was asked for, so the emitted SQL for every existing caller is unchanged.
      // Paired with the id tiebreaker in `orderBy` below — an OFFSET over a non-total order
      // is what silently duplicates and skips rows across page boundaries.
      const offset = normalizeOffset(request.offset);
      if (offset > 0) {
        sql += ` OFFSET $${nextParamIndex + 1}`;
        params.push(offset);
      }

      const result = await db.query(sql, params);
      const decisions = result.rows.map(row => {
        const decision = this.mapDatabaseRowToDecision(row);
        // Surface the similarity/relevance the row ranked on (0–100), consistent
        // with context_search. Only present on semantic searches.
        if (row.search_score !== undefined && row.search_score !== null) {
          const s = parseFloat(row.search_score);
          decision.similarity = Number.isFinite(s)
            ? Math.round(Math.max(0, Math.min(1, s)) * 100 * 10) / 10
            : undefined;
        }
        return decision;
      });

      logger.info(`✅ Found ${decisions.length} matching decisions${isSemantic ? ' (semantic ranking)' : ''}`);
      
      // Log the search event
      await logEvent({
        actor: 'ai',
        event_type: 'decision_search',
        payload: {
          filters: {
            decisionType: request.decisionType,
            status: request.status,
            outcomeStatus: request.outcomeStatus,
            // the new filter + page window are logged alongside the others, so
            // the event log records the ACTUAL query that ran (an unlogged filter makes a
            // logged result count unexplainable after the fact).
            implementationStatus: request.implementationStatus,
            answerStatus: request.answerStatus,
            impactLevel: request.impactLevel,
            component: request.component,
            tags: request.tags,
            query: request.query,
            dateFrom: request.dateFrom,
            dateTo: request.dateTo,
            limit: request.limit,
            offset,
            sortDirection: request.sortDirection
          },
          results_count: decisions.length
        },
        status: 'closed',
        tags: ['decision', 'search']
      });
      
      return decisions;

    } catch (error) {
      logger.error('❌ Failed to search decisions', error as Error);
      throw new Error(`Decision search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * SINGLE SOURCE OF TRUTH for the decision-search filter set.
   *
   * Builds the filtered inner SELECT — the WHERE clause + its bound params + the
   * optional semantic score column — WITHOUT the ORDER BY / LIMIT paging. Both
   * searchDecisions() (which appends ranking + the page LIMIT) and countDecisions()
   * (which wraps this in COUNT(*)) call THIS one method, so the WHERE/filter logic
   * exists exactly once (a past incident — no second, drifting copy). This is why `total`
   * can never diverge from the set the page is drawn from.
   *
   * Returns the base SQL (no ORDER/LIMIT), the params bound to it, the ORDER BY clause
   * to use for the page query, and the next free $n index for the caller's LIMIT param.
   */
  private buildDecisionFilterQuery(
    request: SearchDecisionsRequest,
    projectId: string,
    queryEmbeddingLiteral: string | null
  ): { baseSql: string; params: any[]; orderBy: string; nextParamIndex: number } {
    const isSemantic = !!(request.query && request.query.trim() && request.query !== '*');

    const params: any[] = [projectId];
    let paramIndex = 2;

    // Build the optional semantic-score SELECT expression.
    //
    // TRIGRAM IS AN ADMISSION PREDICATE, NOT A RANKING SIGNAL.
    // This used to be GREATEST(cosine, word_similarity) — "a row ranks on whichever
    // signal is stronger". MEASURED on the jump probe (Q9): that GREATEST inflated
    // decision scores by up to +0.12 over their true cosine, purely from literal token
    // overlap, which is precisely how 19 of 20 top-2 smart_search slots became decisions.
    // A lexical signal is a RESCUE — it decides whether a row is a CANDIDATE at all —
    // and it is admitted as exactly that by the `word_similarity(...) > 0.1` clause in
    // the WHERE gate below, which is deliberately unchanged. It must never decide how
    // high a row ranks, because it is not on the same scale as a cosine and no other
    // source has it.
    //
    // The score is therefore cosine similarity in [0,1] (0 when the row has no
    // embedding). When the EMBEDDER ITSELF is unavailable there is no cosine to rank on
    // at all, so the whole request degrades to the lexical score — a stated,
    // whole-request fallback rather than a per-row blend.
    let scoreSelect = '';
    let queryParamIdx = -1;
    if (isSemantic) {
      queryParamIdx = paramIndex;
      params.push(request.query!.trim()); // text param for trgm fallback ($2)
      paramIndex++;

      if (queryEmbeddingLiteral !== null) {
        const embParamIdx = paramIndex;
        params.push(queryEmbeddingLiteral); // vector param ($3)
        paramIndex++;
        scoreSelect = `,
        CASE WHEN ${activeEmbeddingColumn()} IS NULL THEN 0
             ELSE 1 - (${activeEmbeddingColumn()} <=> $${embParamIdx}::vector) END AS search_score`;
      } else {
        // Embedder unavailable → text-only score.
        scoreSelect = `,
        word_similarity($${queryParamIdx},
          coalesce(title,'') || ' ' || coalesce(description,'') || ' ' ||
          coalesce(rationale,'') || ' ' || coalesce(problem_statement,'')) AS search_score`;
      }
    }

    // ID-PREFIX + PARTIAL-TAG MATCH (an earlier task — the part-2 class-fix).
    // The Command UI Decisions box (and the MCP tool) sends typed text as `query`. A
    // bare id (full UUID or hex prefix) or a partial tag (`ref:`) used to match NOTHING
    // here — search only looked at prose, and tag matching was the EXACT `tags && [..]`
    // (request.tags) path, never the free-text query. buildSearchMatchPredicate
    // (centralized in utils/idResolver — REUSES the resolver's normalizeShortId + the
    // SAME parameterized `id::text LIKE prefix||'%'` contract; NO second id-resolver)
    // returns the ADDITIVE OR-predicate, or null for an empty / `*` query so the
    // non-query path is byte-for-byte unchanged (no regression). Built at the LIVE
    // paramIndex so its $n placeholders + appended params line up exactly. The same
    // fragment is woven into the score (exact id/tag -> rank #1) AND the signal gate
    // (admit a bare-id query that has zero prose overlap). SECURITY: every value is a
    // BOUND parameter — nothing is concatenated into SQL.
    const idTagMatch = isSemantic
      ? buildSearchMatchPredicate(request.query, paramIndex, { idColumn: 'id', tagsColumn: 'tags' })
      : null;
    if (idTagMatch) {
      params.push(...idTagMatch.params);
      paramIndex = idTagMatch.nextParamIndex;
      // Boost an exact id/tag hit ABOVE any semantic/text score (both live in [0,1]) so a
      // bare-id query surfaces the EXACT decision as result #1, without disturbing the
      // ranking of ordinary text queries. Folded INTO the existing search_score column so
      // the OUTPUT SHAPE (search_score -> similarity) stays unchanged.
      if (scoreSelect) {
        scoreSelect = scoreSelect.replace(
          / AS search_score$/,
          ` + (CASE WHEN ${idTagMatch.sql} THEN 1 ELSE 0 END) AS search_score`,
        );
      } else {
        scoreSelect = `, (CASE WHEN ${idTagMatch.sql} THEN 1 ELSE 0 END) AS search_score`;
      }
    }

    let sql = `
        SELECT *${scoreSelect} FROM technical_decisions
        WHERE project_id = $1
      `;

    // SOFT-DELETE: exclude archived decisions by DEFAULT (archived_at
    // IS NULL); includeArchived:true returns them too. Constant predicate, no param.
    if (!request.includeArchived) {
      sql += ` AND archived_at IS NULL`;
    }

    // Add filters
    if (request.decisionType) {
      sql += ` AND decision_type = $${paramIndex}`;
      params.push(request.decisionType);
      paramIndex++;
    }

    if (request.status) {
      sql += ` AND status = $${paramIndex}`;
      params.push(request.status);
      paramIndex++;
    }

    // outcome_status is a SEPARATE column from `status` (lifecycle). This filters the
    // learning-loop result so the GAP1 Evaluator can read back "all the failed/
    // successful decisions" via the tool alone.
    if (request.outcomeStatus) {
      sql += ` AND outcome_status = $${paramIndex}`;
      params.push(request.outcomeStatus);
      paramIndex++;
    }

    // implementation_status is a THIRD column, separate from BOTH `status` (lifecycle) and
    // `outcome_status` (result). This is the filter that makes the half-executed-decision
    // class enumerable — "every decision still only planned". It lives in the
    // SHARED builder, so countDecisions() filters on it identically and `total` can never
    // disagree with the page (the same guarantee an earlier task established).
    if (request.implementationStatus) {
      sql += ` AND implementation_status = $${paramIndex}`;
      params.push(request.implementationStatus);
      paramIndex++;
    }

    // THE DECISION INBOX filter — a FOURTH status column,
    // distinct from status/outcomeStatus/implementationStatus. answerStatus:'open' is the
    // inbox read the operator needs: "every decision waiting on a human." Same shared builder, so
    // countDecisions() and the REST /api/decisions?answerStatus=open page can never disagree.
    if (request.answerStatus) {
      sql += ` AND answer_status = $${paramIndex}`;
      params.push(request.answerStatus);
      paramIndex++;
    }

    if (request.impactLevel) {
      sql += ` AND impact_level = $${paramIndex}`;
      params.push(request.impactLevel);
      paramIndex++;
    }

    if (request.component) {
      sql += ` AND $${paramIndex} = ANY(affected_components)`;
      params.push(request.component);
      paramIndex++;
    }

    if (request.tags && request.tags.length > 0) {
      sql += ` AND tags && $${paramIndex}`;
      params.push(request.tags);
      paramIndex++;
    }

    if (isSemantic) {
      // Keep ONLY rows with a real signal: an embedding (semantic candidate) OR a
      // text/trigram overlap. Mirrors the old ILIKE gate but additionally admits
      // semantic-only matches that share no literal substring.
      //
      // ID/TAG ADMIT: OR in the id-prefix + partial-tag match so a
      // bare-id or partial-tag query — which need NOT share any prose overlap, and may
      // hit an un-embedded legacy row — is admitted by the gate. The match fragment was
      // already bound above (idTagMatch.params pushed), so we only reference its $n here;
      // no new params for it on this line.
      const idTagAdmit = idTagMatch ? `\n          OR ${idTagMatch.sql}` : '';
      sql += ` AND (
          ${activeEmbeddingColumn()} IS NOT NULL OR
          title ILIKE $${paramIndex} OR
          description ILIKE $${paramIndex} OR
          rationale ILIKE $${paramIndex} OR
          problem_statement ILIKE $${paramIndex} OR
          word_similarity($${queryParamIdx},
            coalesce(title,'') || ' ' || coalesce(description,'') || ' ' ||
            coalesce(rationale,'') || ' ' || coalesce(problem_statement,'')) > 0.1${idTagAdmit}
        )`;
      params.push(`%${request.query!.trim()}%`);
      paramIndex++;
    }

    if (request.dateFrom) {
      sql += ` AND decision_date >= $${paramIndex}`;
      params.push(request.dateFrom);
      paramIndex++;
    }

    if (request.dateTo) {
      sql += ` AND decision_date <= $${paramIndex}`;
      params.push(request.dateTo);
      paramIndex++;
    }

    // Rank by semantic relevance when querying; else by decision_date. `sortDirection`
    // flips ONLY the date axis: on a semantic query it is the TIEBREAKER after
    // search_score, so relevance ranking is untouched. Default 'newest' = DESC,
    // byte-identical to the pre-change clause for every existing caller.
    //
    // STABLE ORDER UNDER PAGINATION: `id` is appended as the final tiebreaker. Without it,
    // rows sharing a decision_date (bulk-recorded decisions routinely do) have an UNDEFINED
    // relative order in Postgres, so two different OFFSET windows over the same filter set
    // could return the same row twice and skip another — the page-boundary bug that makes
    // "fully enumerable" quietly false. The COUNT wrapper ignores ORDER BY, so this costs
    // nothing there.
    const dateDir = request.sortDirection === 'oldest' ? 'ASC' : 'DESC';
    const orderBy = isSemantic
      ? ` ORDER BY search_score DESC, decision_date ${dateDir}, id ${dateDir}`
      : ` ORDER BY decision_date ${dateDir}, id ${dateDir}`;

    return { baseSql: sql, params, orderBy, nextParamIndex: paramIndex };
  }

  /**
   * COUNT of ALL decisions matching the SAME filter set as searchDecisions(), with NO
   * page LIMIT — this is what the route surfaces as `total`. Reuses the
   * shared buildDecisionFilterQuery() so the count can never drift from the page's
   * filter set, then wraps the filtered inner query in COUNT(*).
   *
   * Passes a null embedding literal on purpose: COUNT needs only the WHERE clause (the
   * semantic score column is paging/ranking sugar that COUNT ignores), so it skips the
   * embedder round-trip entirely. The WHERE clause is identical whether or not a query
   * embedding was generated, so the count matches the page's filter set exactly.
   */
  async countDecisions(request: SearchDecisionsRequest): Promise<number> {
    const projectId = await this.ensureProjectId(request.projectId);
    // SOFT-DELETE-VIA: baseSql — buildDecisionFilterQuery appends `AND archived_at IS NULL`
    // unless includeArchived was asked for, and this count deliberately reuses that exact
    // builder so it can never drift from the page's filter set. FILTERED, not exempt.
    const { baseSql, params } = this.buildDecisionFilterQuery(request, projectId, null);
    const sql = `SELECT COUNT(*)::int AS count FROM (${baseSql}) AS filtered`;
    const result = await db.query(sql, params);
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Fetch a SINGLE decision by its id with FULL detail (all fields, incl. the
   * learning-loop outcome fields). Mirrors context_search's `id` direct-lookup idiom:
   * a precise by-id read that bypasses semantic search entirely, so the GAP1 Evaluator
   * (and any tool-only agent) can pull one decision's complete outcome record without
   * re-running a fuzzy query.
   *
   * Returns null when no row matches the id — the route turns that into an actionable
   * not-found error. `projectId`, when supplied, scopes the lookup (defence in depth
   * for multi-project callers); omit it to look the decision up by id alone.
   */
  async getDecisionById(decisionId: string, projectId?: string): Promise<TechnicalDecision | null> {
    logger.info(`🔎 Fetching decision by id: ${decisionId.substring(0, 8)}...`);

    const params: any[] = [decisionId];
    let sql = `SELECT * FROM technical_decisions WHERE id = $1`;
    if (projectId) {
      sql += ` AND project_id = $2`;
      params.push(projectId);
    }

    const result = await db.query(sql, params);
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapDatabaseRowToDecision(result.rows[0]);
  }

  /**
   * Get decisions affecting a specific component
   */
  async getDecisionsForComponent(component: string, projectId?: string): Promise<TechnicalDecision[]> {
    logger.info(`🎯 Getting decisions for component: ${component}`);

    return await this.searchDecisions({
      projectId,
      component,
      status: 'active',
      limit: 10
    });
  }

  /**
   * Get recent decisions (last 30 days)
   */
  async getRecentDecisions(projectId?: string, limit: number = 10): Promise<TechnicalDecision[]> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return await this.searchDecisions({
      projectId,
      dateFrom: thirtyDaysAgo,
      limit
    });
  }

  /**
   * Deprecate a decision (mark as no longer active)
   */
  async deprecateDecision(
    decisionId: string, 
    reason: string, 
    replacementId?: string
  ): Promise<TechnicalDecision> {
    logger.info(`📋 Deprecating decision: ${decisionId.substring(0, 8)}...`);

    return await this.updateDecision({
      decisionId,
      status: 'deprecated',
      supersededBy: replacementId,
      supersededReason: reason
    });
  }

  /**
   * Get decision statistics for a project.
   *
   * ARCHIVED ROWS ARE EXCLUDED BY DEFAULT — the SAME semantics, and the
   * SAME param name, as decision_search's `includeArchived`. Before this fix, stats
   * counted archived (soft-deleted) rows while decision_search excluded them, so the two
   * public tools reported different totals for the same corpus (measured on prod
   * 2026-07-30: stats 556 / search 127 — a 4.4x split, with nothing saying which was
   * authoritative). This is the same defect that an earlier task already closed for
   * task_progress_summary vs task_list; decisions was the remaining instance.
   *
   * EVERY breakdown takes the filter, not just the total — a partial fix that left
   * by_project counting archived would be the same bug in a smaller hat. That includes
   * the two GLOBAL (cross-project) aggregates, decisionsByProject and totalProjects: an
   * all-archived project must not keep appearing in the project breakdown.
   *
   * outcomeSuccess is computed over the SAME filtered population, which is the point —
   * the rate's denominator was full of machine-minted records that had just been
   * archived, and the metric could not see it (an earlier decision item 3).
   */
  async getDecisionStats(projectId?: string, includeArchived: boolean = false): Promise<{
    totalDecisions: number;
    decisionsByType: Record<string, number>;
    decisionsByStatus: Record<string, number>;
    decisionsByImpact: Record<string, number>;
    /**
     * BUILD-LIFECYCLE breakdown — decisions grouped by
     * implementation_status. Same shape as decisionsByStatus / decisionsByImpact (a
     * value → count map), NOT a new response shape.
     *
     * IT SUMS TO totalDecisions, deliberately: unlike the `outcomes` query below (which
     * excludes 'unknown' because it feeds a success RATE), this one applies no value filter,
     * and every row that satisfies the project predicate is counted — the column is
     * NOT-NULL-defaulted to 'planned'. A breakdown that quietly dropped a bucket is how you
     * get a number that reads like a total and is not one. A NULL from a legacy row
     * (pre-default) lands in the '(unset)' key rather than vanishing.
     */
    decisionsByImplementationStatus: Record<string, number>;
    decisionsByProject: Record<string, number>;
    outcomeSuccess: number;
    recentActivity: number;
    totalProjects: number;
  }> {
    const actualProjectId = await this.ensureProjectId(projectId);

    // SOFT-DELETE. ONE predicate, built ONCE and interpolated into every
    // aggregate below, so a breakdown cannot be added later that silently forgets it — the
    // same single-source shape tasks.ts uses for task_progress_summary. It is a CONSTANT
    // (no caller input reaches it); the `td.` variant exists only because the by-project
    // aggregate joins and needs the qualified column.
    const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
    const archivedFilterTd = includeArchived ? '' : ' AND td.archived_at IS NULL';

    const [total, byType, byStatus, byImpact, byImplStatus, outcomes, recent, byProject, projectCount] = await Promise.all([
      // Total decisions
      db.query(`SELECT COUNT(*) as count FROM technical_decisions WHERE project_id = $1${archivedFilter}`, [actualProjectId]),

      // Decisions by type
      db.query(`
        SELECT decision_type, COUNT(*) as count
        FROM technical_decisions
        WHERE project_id = $1${archivedFilter}
        GROUP BY decision_type
        ORDER BY count DESC
      `, [actualProjectId]),

      // Decisions by status
      db.query(`
        SELECT status, COUNT(*) as count
        FROM technical_decisions
        WHERE project_id = $1${archivedFilter}
        GROUP BY status
      `, [actualProjectId]),

      // Decisions by impact level
      db.query(`
        SELECT impact_level, COUNT(*) as count
        FROM technical_decisions
        WHERE project_id = $1${archivedFilter}
        GROUP BY impact_level
        ORDER BY
          CASE impact_level
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            WHEN 'low' THEN 4
          END
      `, [actualProjectId]),

      // Decisions by implementation_status — the BUILD lifecycle.
      // NO value filter, so this sums to totalDecisions (see the type comment). Ordered by the
      // vocabulary's OWN lifecycle order via array_position over the single-source list, not by
      // count and not alphabetically, so the rendered breakdown reads
      // planned → in_progress → implemented → validated → deprecated. A value outside the
      // vocabulary (impossible under the DB CHECK, but the ordering must not silently reorder
      // if the CHECK is ever relaxed) sorts last via NULLS LAST.
      db.query(`
        SELECT implementation_status, COUNT(*) as count
        FROM technical_decisions
        WHERE project_id = $1${archivedFilter}
        GROUP BY implementation_status
        ORDER BY array_position($2::text[], implementation_status) NULLS LAST
      `, [actualProjectId, [...IMPLEMENTATION_STATUSES]]),

      // Outcome success rate
      db.query(`
        SELECT outcome_status, COUNT(*) as count
        FROM technical_decisions
        WHERE project_id = $1 AND outcome_status != 'unknown'${archivedFilter}
        GROUP BY outcome_status
      `, [actualProjectId]),

      // Recent activity (last 30 days)
      db.query(`
        SELECT COUNT(*) as count
        FROM technical_decisions
        WHERE project_id = $1 AND decision_date > NOW() - INTERVAL '30 days'${archivedFilter}
      `, [actualProjectId]),

      // Decisions by project (with project names). GLOBAL, not project-scoped — but it
      // still takes the archived filter: a project whose decisions were
      // all archived must stop appearing here, exactly as it stops appearing in search.
      db.query(`
        SELECT p.name as project_name, COUNT(td.id) as count
        FROM technical_decisions td
        JOIN projects p ON td.project_id = p.id
        WHERE true${archivedFilterTd}
        GROUP BY p.id, p.name
        ORDER BY count DESC
      `),

      // Total distinct projects with decisions (global; same archived filter)
      db.query(`
        SELECT COUNT(DISTINCT project_id) as count
        FROM technical_decisions
        WHERE true${archivedFilter}
      `)
    ]);

    const decisionsByType: Record<string, number> = {};
    byType.rows.forEach(row => {
      decisionsByType[row.decision_type] = parseInt(row.count);
    });

    const decisionsByStatus: Record<string, number> = {};
    byStatus.rows.forEach(row => {
      decisionsByStatus[row.status] = parseInt(row.count);
    });

    const decisionsByImpact: Record<string, number> = {};
    byImpact.rows.forEach(row => {
      decisionsByImpact[row.impact_level] = parseInt(row.count);
    });

    // BUILD-LIFECYCLE breakdown. A NULL implementation_status (only reachable
    // on a legacy row written before the column default) is keyed '(unset)' rather than
    // dropped, so the buckets still sum to totalDecisions.
    const decisionsByImplementationStatus: Record<string, number> = {};
    byImplStatus.rows.forEach(row => {
      decisionsByImplementationStatus[row.implementation_status ?? '(unset)'] = parseInt(row.count);
    });

    const decisionsByProject: Record<string, number> = {};
    byProject.rows.forEach(row => {
      decisionsByProject[row.project_name] = parseInt(row.count);
    });

    // Calculate success rate
    let totalOutcomes = 0;
    let successfulOutcomes = 0;
    outcomes.rows.forEach(row => {
      const count = parseInt(row.count);
      totalOutcomes += count;
      if (row.outcome_status === 'successful') {
        successfulOutcomes += count;
      }
    });

    const outcomeSuccess = totalOutcomes > 0 ? Math.round((successfulOutcomes / totalOutcomes) * 100) : 0;

    return {
      totalDecisions: parseInt(total.rows[0].count),
      decisionsByType,
      decisionsByStatus,
      decisionsByImpact,
      decisionsByImplementationStatus,
      decisionsByProject,
      outcomeSuccess,
      recentActivity: parseInt(recent.rows[0].count),
      totalProjects: parseInt(projectCount.rows[0].count)
    };
  }

  /**
   * Generate a decision report for a component or time period
   */
  async generateDecisionReport(
    component?: string, 
    projectId?: string, 
    timeframe?: 'week' | 'month' | 'quarter'
  ): Promise<{
    summary: string;
    keyDecisions: TechnicalDecision[];
    impacts: string[];
    recommendations: string[];
  }> {
    logger.info(`📊 Generating decision report...`);

    const actualProjectId = await this.ensureProjectId(projectId);
    let decisions: TechnicalDecision[] = [];

    if (component) {
      decisions = await this.getDecisionsForComponent(component, actualProjectId);
    } else if (timeframe) {
      const days = timeframe === 'week' ? 7 : timeframe === 'month' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      decisions = await this.searchDecisions({
        projectId: actualProjectId,
        dateFrom: startDate,
        limit: 50
      });
    } else {
      decisions = await this.searchDecisions({
        projectId: actualProjectId,
        limit: 20
      });
    }

    // Analyze decisions for report
    const highImpact = decisions.filter(d => d.impactLevel === 'high' || d.impactLevel === 'critical');
    const successful = decisions.filter(d => d.outcomeStatus === 'successful');
    const failed = decisions.filter(d => d.outcomeStatus === 'failed');

    const summary = `Found ${decisions.length} decisions${component ? ` affecting ${component}` : ''}. ` +
                   `${highImpact.length} high/critical impact decisions. ` +
                   `Success rate: ${successful.length}/${decisions.length} evaluated decisions.`;

    const impacts = [
      ...new Set(decisions.flatMap(d => d.affectedComponents))
    ].slice(0, 10);

    const recommendations = [];
    if (failed.length > successful.length) {
      recommendations.push('Consider reviewing recent decisions - higher failure rate detected');
    }
    if (decisions.some(d => d.outcomeStatus === 'unknown')) {
      recommendations.push('Update outcome status for recent decisions to track effectiveness');
    }
    if (highImpact.length > decisions.length * 0.5) {
      recommendations.push('High concentration of critical decisions - consider breaking down large changes');
    }

    return {
      summary,
      keyDecisions: highImpact.slice(0, 10),
      impacts,
      recommendations
    };
  }

  /**
   * Private helper methods
   */

  private async ensureProjectId(projectId?: string): Promise<string> {
    if (projectId) {
      return projectId;
    }

    await projectHandler.initializeSession();
    // PROJECT-SCOPE: effective — same last-resort write scope as handlers/context.ts.
    const currentProject = await projectHandler.getCurrentProject();
    
    if (currentProject) {
      return currentProject.id;
    }

    throw new Error('No current project set. Use project_switch to set an active project or specify a project ID.');
  }

  private async checkForDuplicate(
    projectId: string, 
    title: string, 
    decisionType: DecisionType
  ): Promise<TechnicalDecision | null> {
    const result = await db.query(`
      SELECT * FROM technical_decisions 
      WHERE project_id = $1 AND decision_type = $2 
        AND similarity(title, $3) > 0.7
      -- 'id DESC' makes the pick reproducible. With several equally-similar
      -- titles above the floor, "which duplicate did it find" was decided by physical row
      -- order, so the same create could report a different existing decision run to run.
      ORDER BY similarity(title, $3) DESC, id DESC
      LIMIT 1
    `, [projectId, decisionType, title]);

    if (result.rows.length > 0) {
      return this.mapDatabaseRowToDecision(result.rows[0]);
    }
    
    return null;
  }

  private mapDatabaseRowToDecision(row: any): TechnicalDecision {
    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      decisionType: row.decision_type,
      title: row.title,
      description: row.description,
      rationale: row.rationale,
      problemStatement: row.problem_statement,
      successCriteria: row.success_criteria,
      alternativesConsidered: typeof row.alternatives_considered === 'string' 
        ? JSON.parse(row.alternatives_considered) 
        : row.alternatives_considered,
      decisionDate: row.decision_date,
      decidedBy: row.decided_by,
      stakeholders: row.stakeholders || [],
      status: row.status,
      supersededBy: row.superseded_by,
      supersededDate: row.superseded_date,
      supersededReason: row.superseded_reason,
      impactLevel: row.impact_level,
      affectedComponents: row.affected_components || [],
      tags: row.tags || [],
      category: row.category,
      outcomeStatus: row.outcome_status,
      outcomeNotes: row.outcome_notes,
      lessonsLearned: row.lessons_learned,
      implementationStatus: row.implementation_status,
      // metadata jsonb → object (default {} when null). Mirrors tasks.mapTask.
      metadata: row.metadata || {},
      // SOFT-DELETE stamp, absent-when-absent: only a projection that selected
      // the column carries the key, so an includeArchived read can tell which rows are archived.
      ...('archived_at' in row ? { archivedAt: row.archived_at } : {}),
      // THE DECISION INBOX (migration 104).
      answerStatus: row.answer_status,
      question: row.question ?? null,
      options: (typeof row.options === 'string' ? JSON.parse(row.options) : row.options) || [],
      chosen: row.chosen ?? null,
      answeredAt: row.answered_at ?? null,
      answeredBy: row.answered_by ?? null,
      answerNote: row.answer_note ?? null,
      deadline: row.deadline ?? null,
    };
  }

  /**
   * SOFT-DELETE / ARCHIVE a decision. Sets archived_at = now(), SCOPED to
   * `projectId` (cannot archive another project's decision). REVERSIBLE — the row is NOT
   * hard-deleted; it stays in the table and disappears only from the DEFAULT
   * decision_search (which filters archived_at IS NULL). Idempotent. `decisionId` is a
   * full UUID (short-id resolution happens in the route before this is called).
   */
  async archiveDecision(decisionId: string, projectId: string): Promise<DecisionArchiveResult> {
    const updated = await db.query(
      `UPDATE technical_decisions SET archived_at = now()
       WHERE id = $1 AND project_id = $2 AND archived_at IS NULL
       RETURNING id::text AS id, archived_at`,
      [decisionId, projectId]
    );
    if (updated.rows.length === 1) {
      return { found: true, alreadyArchived: false, id: updated.rows[0].id, archivedAt: updated.rows[0].archived_at };
    }
    const probe = await db.query(
      `SELECT id::text AS id, archived_at FROM technical_decisions WHERE id = $1 AND project_id = $2`,
      [decisionId, projectId]
    );
    if (probe.rows.length === 0) return { found: false };
    return { found: true, alreadyArchived: true, id: probe.rows[0].id, archivedAt: probe.rows[0].archived_at };
  }

  /**
   * RESTORE (un-archive) a decision. Clears archived_at back to NULL,
   * project-scoped. Idempotent. Mirror of archiveDecision.
   */
  async restoreDecision(decisionId: string, projectId: string): Promise<DecisionArchiveResult> {
    const updated = await db.query(
      `UPDATE technical_decisions SET archived_at = NULL
       WHERE id = $1 AND project_id = $2 AND archived_at IS NOT NULL
       RETURNING id::text AS id`,
      [decisionId, projectId]
    );
    if (updated.rows.length === 1) {
      return { found: true, alreadyArchived: false, id: updated.rows[0].id, archivedAt: null };
    }
    const probe = await db.query(
      `SELECT id::text AS id FROM technical_decisions WHERE id = $1 AND project_id = $2`,
      [decisionId, projectId]
    );
    if (probe.rows.length === 0) return { found: false };
    return { found: true, alreadyArchived: true, id: probe.rows[0].id, archivedAt: null };
  }
}

/** Result of a decision soft-delete archive/restore. */
export interface DecisionArchiveResult {
  found: boolean;
  alreadyArchived?: boolean;
  id?: string;
  archivedAt?: string | Date | null;
}

// Export singleton instance
export const decisionsHandler = new DecisionsHandler();
