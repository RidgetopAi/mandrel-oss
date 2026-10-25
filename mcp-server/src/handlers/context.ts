/**
 * AIDIS Context Handler
 *
 * This handles all context management operations:
 * - Storing context with automatic embedding generation
 * - Searching context using vector similarity
 * - Managing context metadata and relationships
 *
 * This is where AI agents store their memories and retrieve them later!
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SINGLE-ENGINE RULE (search consolidation):                │
 * │   ALL matching/ranking for contexts lives HERE (contextHandler.          │
 * │   searchContext) — the ONE semantic engine. The Command backend          │
 * │   (mandrel-command) may ONLY filter by structured columns and must       │
 * │   NEVER match text; its "search" is a THIN PROXY to this engine.         │
 * │   Do not add a second matcher anywhere else.                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { db } from '../config/database.js';
import { embeddingService } from '../services/embedding.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { onEmbedFailure } from '../services/embedResilience.js';
import {
  buildSearchMatchPredicate,
  extractIdTokens,
  type SearchMatchClause,
} from '../utils/idResolver.js';
import { SEARCH_ID_MATCH_SCORE_BOOST } from '../config/searchConfig.js';
import type { ContextType } from '../config/contextTypes.js';
import { RANK_WEIGHTS, buildCombinedScoreSql } from '../config/rankingConfig.js';

/**
 * Extract a title from context content (markdown header / bold / short first line /
 * first 50 chars). Module-level so the store path, the edit re-embed path, AND the
 * gemma backfill all build the SAME embedding text — one source, no drift.
 */
export function extractContextTitle(content: string): string {
  const trimmed = content.trim();
  const markdownTitleMatch = trimmed.match(/^#{1,6}\s*(.+)|^\*\*(.+?)\*\*/);
  if (markdownTitleMatch) {
    return markdownTitleMatch[1] || markdownTitleMatch[2];
  }
  const firstLine = trimmed.split('\n')[0];
  if (firstLine && firstLine.length <= 100 && firstLine.length >= 10) {
    if (!/[.!?]$/.test(firstLine) || /[:-]$/.test(firstLine)) {
      return firstLine;
    }
  }
  return trimmed.substring(0, 50).replace(/\s+$/, '');
}

/**
 * Build the hybrid embedding text for a context, EXACTLY as context_store does
 * (Type + Tags + title + first 1000 chars). Shared by store, edit-re-embed, and backfill.
 */
export function buildContextEmbeddingText(contextType: string, tags: string[], content: string): string {
  return [
    `Type: ${contextType}`,
    tags.length ? `Tags: ${tags.join(', ')}` : '',
    extractContextTitle(content),
    content.substring(0, 1000),
  ].filter(Boolean).join('\n');
}
import { dimensionalityReductionService } from '../services/dimensionality-reduction.js';
import { projectHandler } from './project.js';
import { logContextEvent, logHierarchicalMemorySearch } from '../middleware/eventLogger.js';
import { logger } from '../utils/logger.js';
import { recordWriteWithoutSession } from '../utils/sessionObservability.js';
import { isValidUuid } from '../utils/uuid.js';
import { validateAndNormalizeTags } from '../utils/threadingTags.js';
import { ensureResumePointer, type ResumePointerReport } from '../services/handoffResumePointer.js';
import { metadataMergeSql } from '../utils/metadataMerge.js';
import { applyCarriedFields, type CarriedFieldsReport } from '../services/handoffCarriedFields.js';
import { triggerBeliefAdjudication } from '../services/belief/beliefHook.js';
import { persistDeclaredLimbsForRow } from '../services/declaredLimbsStore.js';

export interface StoreContextRequest {
  projectId?: string;
  sessionId?: string;
  /**
   * Connection scope for session attribution. When set, the active session is
   * resolved per-connection (no global "last active anywhere" fallback), closing
   * the cross-connection attribution leak.
   */
  connectionId?: string;
  type: ContextType;
  content: string;
  tags?: string[];
  relevanceScore?: number;
  metadata?: Record<string, any>;
  /**
   * CARRIED FIELDS (P5.4) — the declared working MODE this handoff hands forward, e.g.
   * `build`. Optional; recognised against a server vocabulary but NEVER rejected, and
   * stored at `metadata.handoff.mode`. Only meaningful on a `handoff`; supplied on any
   * other type it is dropped WITH A WARNING (see services/handoffCarriedFields.ts).
   */
  mode?: string;
  /**
   * CARRIED FIELDS (P5.4) — the record this handoff RESUMES (a task, decision or context;
   * id8 or full UUID). Stored at `metadata.handoff.spine`. Existence is NOT checked here:
   * it is measured at render time against today's database, so the reader gets today's
   * truth rather than the author's snapshot.
   */
  spine?: string;
}

export interface ContextEntry {
  id: string;
  projectId: string;
  sessionId: string | null;
  contextType: string;
  content: string;
  createdAt: Date;
  relevanceScore: number;
  tags: string[];
  metadata: Record<string, any>;
  /** SOFT-DELETE stamp; absent when the projection did not select it. */
  archivedAt?: Date | null;
  embedding?: number[];
  /**
   * Non-fatal warnings produced while storing — currently ref-grammar normalization
   * notes (e.g. a malformed `ref:` tag that was normalized or could not be fixed).
   * Empty/absent on a clean store. The route surfaces these to the caller.
   */
  warnings?: string[];
  /**
   * RESUME POINTER: what the handoff resume-pointer layer did for this
   * write — `null` for every non-handoff type, `{added:false}` when the caller already
   * supplied `ref:resume`, `{added:true}` when the SERVER appended it. Reported so a
   * caller can always tell "I passed this" from "Mandrel added this".
   */
  resumePointer?: ResumePointerReport | null;
  /**
   * CARRIED FIELDS (P5.4): what the mode/spine layer did for this write. `null` when the
   * caller supplied neither field (and for every non-handoff type), so a machine reader
   * can tell "nothing was declared" from "something was declared and normalized".
   */
  carriedFields?: CarriedFieldsReport | null;
}

/**
 * ONE mapping from a `contexts` row to the read model. The route's by-id and
 * tags-only search branches used to read raw snake_case rows straight into hand-written wire
 * literals; they now map through this and serialize through services/serializers, so a
 * column reaches the wire by being named HERE, once.
 */
export function mapContextRow(row: any): ContextEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    contextType: row.context_type,
    content: row.content,
    createdAt: row.created_at,
    relevanceScore: row.relevance_score,
    tags: row.tags || [],
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    ...('archived_at' in row ? { archivedAt: row.archived_at } : {}),
  };
}

export interface SearchContextRequest {
  projectId?: string;
  query: string;
  type?: string;
  limit?: number;
  offset?: number;
  minSimilarity?: number;
  tags?: string[];
  // SOFT-DELETE: when falsy (default), exclude archived rows
  // (archived_at IS NULL). When true, include archived rows too.
  includeArchived?: boolean;
  // ADDITIVE STRUCTURED FILTERS (an earlier task — search consolidation). Same additive
  // pattern as `type`: a plain extra WHERE predicate that narrows the candidate set
  // BEFORE ranking. No behavior change for callers that omit them. These let the
  // Command UI's canonical proxy carry its browse-style filters into the one engine.
  sessionId?: string;
  /** ISO timestamp lower bound (inclusive): created_at >= dateFrom. */
  dateFrom?: string;
  /** ISO timestamp upper bound (inclusive): created_at <= dateTo. */
  dateTo?: string;
  /**
   * WHICH RANK PROFILE THIS SEARCH MAY USE.
   *
   * 'auto' (the DEFAULT, and byte-identical to previous behaviour): isRecencyQuery() may
   * switch this search to the 0.90-recency profile, which also applies a hard 60-day
   * `created_at` window. Every existing caller — context_search included — omits this
   * field and therefore keeps exactly that behaviour.
   *
   * 'balanced': PIN the balanced profile; the recency switch is not consulted. smart_search
   * passes this so a merged, globally-sorted result set cannot contain rows scored under
   * two different profiles. See SEARCH_MERGE_APPLY_RECENCY_PROFILE in
   * config/searchMergeConfig.ts for the measurement behind that choice.
   */
  rankProfile?: 'auto' | 'balanced';
}

export interface SearchResult extends ContextEntry {
  similarity?: number;
  /**
   * The relevance score (0–100) the row ACTUALLY ranked on — i.e. the sort key
   * expressed as a percentage. In hierarchical mode this is `combined_score`*100;
   * in baseline mode it equals `similarity`. Display this so the
   * shown number always agrees with the sort order: #1 shows the highest number.
   * `similarity` remains available as the raw vector-similarity component.
   */
  relevance?: number;
  searchReason?: string;
  // Score components for observability (Instance #49)
  recency_score?: number;
  importance_score?: number;
  type_weight?: number;
  combined_score?: number;
}

/**
 * Hierarchical-memory ranking BLEND weights — made configurable.
 *
 * context_search combines four signals into `combined_score`:
 *   similarity  — cosine similarity to the query (the semantic match)
 *   recency     — EXP time-decay of created_at (half-life configurable)
 *   importance  — relevance_score/10
 *   type_weight — milestone 1.0 … discussion 0.4
 *
 * Historically these were HARDCODED into the SQL:
 *   BALANCED  = (similarity + recency + importance + type) / 4   → 0.25 each
 *   RECENCY   = 0.05·sim + 0.90·recency + 0.025·imp + 0.025·type
 *
 * They are now lifted into env-overridable config so a ranking sweep can change the
 * blend WITHOUT editing code. The DEFAULTS below reproduce the previous hardcoded
 * behavior EXACTLY: BALANCED 0.25/0.25/0.25/0.25 is algebraically identical to the
 * old `(a+b+c+d)/4`, and the RECENCY defaults match the old literals. Decay
 * half-lives (in days) are also configurable; defaults are the historical 30d
 * (balanced) and 7d (recency-focused).
 *
 * Env overrides (all optional; bad/missing values fall back to the default):
 *   MANDREL_RANK_BAL_SIM, MANDREL_RANK_BAL_REC, MANDREL_RANK_BAL_IMP, MANDREL_RANK_BAL_TYPE
 *   MANDREL_RANK_REC_SIM, MANDREL_RANK_REC_REC, MANDREL_RANK_REC_IMP, MANDREL_RANK_REC_TYPE
 *   MANDREL_RANK_BAL_HALFLIFE_DAYS (default 30), MANDREL_RANK_REC_HALFLIFE_DAYS (default 7)
 *
 * NOTE: weights are NOT auto-normalized — the defaults intentionally do not sum to 1
 * for the recency profile (matching history). The sweep supplies its own sets.
 */
// RANK_WEIGHTS + buildCombinedScoreSql MOVED to config/rankingConfig.ts.
// The blend is now a CROSS-HANDLER contract: smart_search merges rows from several
// sources into one globally-sorted list, and a global sort is only meaningful if every
// source scores on the same scale. A contract cannot live inside one of its parties.
// Imported at the top of this file; the weights, defaults and env names are unchanged.

/** Read a finite float env var, falling back to `fallback` on missing/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Retrieval HONESTY FLOOR.
 *
 * context_search / smart_search always return the top-k rows by score. When the
 * single BEST row is still a weak match, presenting those rows with no caveat reads
 * as a confident answer — surfacing noise as a hit. The floor adds an honest LABEL
 * (a warning header) when the best row's relevance is below the threshold. It does
 * NOT suppress or hide any row — recall is untouched; this is honest labeling only.
 *
 * The number compared against the floor is the SAME relevance the rows are sorted
 * and displayed on — the row's sort-key relevance as a fraction in
 * [0,1] — so the header, the displayed per-row number, and the sort order all agree.
 *
 * DEFAULT 0.35 (35%) — justification:
 *   - The per-row searchReason buckets in searchContext already treat >40% as
 *     "Moderate" and ≤40% as "Low"; 35% sits just inside "Low", so the floor fires
 *     precisely when the best row is in (or barely above) the Low band — i.e. when
 *     there is genuinely no strong match to stand behind.
 *   - It is BELOW the gold-match band for answerable questions (whose correct
 *     context embeds at high similarity, comfortably above the floor), so the header
 *     does NOT fire on answerable Qs → no recall/QA regression. It SHOULD help
 *     abstention on unanswerable Qs, where even the best row is weak.
 *   - Env-overridable (MANDREL_SEARCH_MIN_SIMILARITY) following the RANK_WEIGHTS
 *     pattern, so the eval gate can sweep it without a code edit. Bad /
 *     missing values fall back to the default. Accepts either a fraction (0.35) or a
 *     percentage (35) — values > 1 are read as a percentage.
 */
function envFloorFraction(name: string, fallback: number): number {
  const v = envFloat(name, fallback);
  // Permit a percentage form (e.g. "35") as well as a fraction ("0.35").
  const frac = v > 1 ? v / 100 : v;
  // Clamp to a sane [0,1]; a non-positive floor disables the header.
  return Math.min(1, Math.max(0, frac));
}

const SEARCH_MIN_SIMILARITY = envFloorFraction('MANDREL_SEARCH_MIN_SIMILARITY', 0.35);

/**
 * Build the honesty-floor warning header for a result set, or `null` if the best
 * row clears the floor (or there are no rows). `bestRelevancePct` is the top row's
 * relevance as a 0–100 number — the SAME number that is sorted/displayed on, so the
 * header is always consistent with row #1.
 */
export function buildHonestyHeader(bestRelevancePct: number | undefined): string | null {
  if (SEARCH_MIN_SIMILARITY <= 0) return null; // floor disabled
  if (bestRelevancePct === undefined) return null;
  if (bestRelevancePct >= SEARCH_MIN_SIMILARITY * 100) return null;
  const pct = Math.round(bestRelevancePct);
  return `No strong match — best ${pct}%; results may not be relevant.`;
}

class ContextHandler {

  /**
   * Extract meaningful title from content for hybrid embeddings
   */
  private extractTitle(content: string): string {
    return extractContextTitle(content);
  }

  /**
   * Store new context with automatic hybrid embedding generation
   * Combines title + tags + type + content for better semantic search
   */
  async storeContext(request: StoreContextRequest): Promise<ContextEntry> {
    if (process.env.AIDIS_DETAILED_LOGGING === 'true') {
        logger.info(`📝 Storing ${request.type} context: "${request.content.substring(0, 60)}..."`);
      }

    try {
      // Validate required fields
      if (!request.content?.trim()) {
        throw new Error('Context content cannot be empty');
      }

      if (!request.type) {
        throw new Error('Context type is required');
      }

      // LINKING-GRAMMAR VALIDATION (tool-native record linking): validate/normalize
      // BOTH ref tags (`ref:<slug>`) AND the threading tags that thread the
      // record-linking model (`task:`/`decision:`/`context:`/`scope:`/`owner:`/
      // `tranche:`) at the write boundary, so a typo'd join key can't silently break
      // the thread. This WARNS + NORMALIZES (never rejects, never drops a tag);
      // non-linking tags pass through untouched. The normalized tags are used for BOTH
      // the embedding text and the stored row so the tag a user copies from the UI is
      // exactly the tag that was indexed.
      const tagValidation = validateAndNormalizeTags(request.tags);
      // RESUME POINTER GUARANTEE: a `handoff` ALWAYS
      // carries `ref:resume`. Three independent consumers (the boot hook, the branch
      // board, the tree-drift cron) resolve "which handoff is live" through that TAG,
      // not through the edge graph — so a correctly-threaded but untagged handoff blinds
      // all three at once, which is precisely what happened on 2026-08-23. Sits HERE, at
      // the one choke point every context_store passes through, so the guaranteed tag is
      // the tag that is embedded, inserted, and reported — never a fourth copy. Appends
      // at most one element; idempotent for a caller who already supplied it; no-op for
      // every other context type. See services/handoffResumePointer.ts.
      const resumePointerResult = ensureResumePointer(request.type, tagValidation.tags);
      const normalizedTags = resumePointerResult.tags;
      const resumePointer = resumePointerResult.report;
      const refWarnings = [...tagValidation.warnings];
      if (resumePointer?.note) refWarnings.push(resumePointer.note);

      // CARRIED FIELDS (P5.4): `mode` + `spine` become SCHEMA on `contexts.metadata`
      // instead of a convention a regex scrapes out of prose. Sits at the SAME choke point
      // as the resume pointer and BEFORE the INSERT, so the metadata that is validated is
      // the metadata that is stored and the metadata that is reported — no fourth copy.
      // Warn-and-store, never reject: a handoff must never fail over an unrecognised mode.
      const carried = applyCarriedFields(request.type, request.metadata, {
        mode: request.mode,
        spine: request.spine,
      });
      const carriedFields = carried.report;
      refWarnings.push(...carried.warnings);
      if (refWarnings.length > 0) {
        logger.warn(`🏷️  Linking-grammar normalization: ${refWarnings.join(' ')}`);
      }

      // Get or create project/session
      const projectId = await this.ensureProjectId(request.projectId);
      const sessionId = await this.ensureSessionId(request.sessionId, projectId, request.connectionId);
      // Observability (Phase 5, F3): this action tool is about to write with NO session
      // attributed (session_id NULL) — make the attribution loss a visible counter, not just a warn.
      if (!sessionId) recordWriteWithoutSession('context_store');

      // Create hybrid embedding text combining title, tags, type, and content
      const extractedTitle = this.extractTitle(request.content);
      const embeddingText = buildContextEmbeddingText(request.type, normalizedTags, request.content);

      // Generate hybrid embedding.
      // DEGRADE + PERSIST + ALERT (unified resilience, site C — the critical
      // data-loss fix). This call was previously UNWRAPPED: an embedder failure threw past the
      // INSERT below and the whole capture was LOST. It is now wrapped exactly like decisions
      // site A: on failure we keep a NULL embedding vector, alert (onEmbedFailure), and STILL
      // insert the row. A context must ALWAYS persist even with no embedding — the self-heal
      // worker re-embeds NULL-active-column rows later. Every downstream use of the vector
      // below is null-safe (coords, INSERT param, belief hook, event log).
      logger.info('🔮 Generating hybrid embedding (title + tags + content)...');
      logger.info(`📋 Extracted title: "${extractedTitle}"`);
      let embeddingVector: number[] | null = null;
      let embeddingModel: string | null = null;
      let embeddingDims: number | null = null;
      try {
        const embeddingResult = await embeddingService.generateEmbedding({
          text: embeddingText,
          role: 'document'
        });
        embeddingVector = embeddingResult.embedding;
        embeddingModel = embeddingResult.model;
        embeddingDims = embeddingResult.dimensions;
      } catch (embedError) {
        onEmbedFailure({ table: 'contexts', op: 'create', error: embedError });
      }

      // Prepare context data
      const contextData = {
        project_id: projectId,
        session_id: sessionId,
        context_type: request.type,
        content: request.content.trim(),
        // NULL when the embedder failed (degraded persist); JSON vector otherwise.
        embedding: embeddingVector ? JSON.stringify(embeddingVector) : null, // PostgreSQL vector format
        relevance_score: request.relevanceScore || 5.0,
        tags: normalizedTags,
        // The carried-fields layer's metadata — the caller's object with the reserved
        // `handoff` namespace merged in (identical to `request.metadata` when no
        // mode/spine was supplied, and on every non-handoff type).
        metadata: JSON.stringify(carried.metadata || {})
      };

      // Generate 3D coordinates for the vector. Null-safe: with no embedding (degraded
      // persist) there is nothing to project, so we keep the (0,0,0) default and skip the
      // work entirely — the self-heal re-embed does not backfill coords, but the row is
      // present + searchable via trgm and re-embeds on the next edit.
      let vectorCoords = { x: 0, y: 0, z: 0 };
      if (embeddingVector) {
        try {
          // Get existing vectors for context-aware mapping
          const existingVectorsResult = await db.query(
            `SELECT ${activeEmbeddingColumn()} AS embedding, vector_x, vector_y, vector_z
             FROM contexts
             WHERE project_id = $1 AND vector_x IS NOT NULL AND ${activeEmbeddingColumn()} IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 100`,
            [projectId]
          );

          if (existingVectorsResult.rows.length > 0) {
            const referenceVectors = existingVectorsResult.rows.map(r =>
              typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding
            );
            const referenceCoords = existingVectorsResult.rows.map(r => [r.vector_x, r.vector_y, r.vector_z]);

            const result = await dimensionalityReductionService.mapSingleVector(
              embeddingVector,
              referenceVectors,
              referenceCoords
            );
            vectorCoords = { x: result.x, y: result.y, z: result.z || 0 };
          } else {
            // First vector in project - use fallback
            const fallback = await dimensionalityReductionService.reduceVectors([embeddingVector], { dimensions: 3 });
            vectorCoords = { x: fallback[0][0], y: fallback[0][1], z: fallback[0][2] };
          }
        } catch (coordError) {
          logger.warn('⚠️  Failed to generate coordinates, using default', { metadata: { coordError } });
        }
      }

      // Insert into database
      const sqlQuery = `
        INSERT INTO contexts (
          project_id, session_id, context_type, content,
          ${activeEmbeddingColumn()}, relevance_score, tags, metadata,
          vector_x, vector_y, vector_z, mapping_method, mapped_at
        ) VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
        RETURNING id, created_at, content, tags
      `;
      
      const sqlParams = [
        contextData.project_id,
        contextData.session_id,
        contextData.context_type,
        contextData.content,
        // NULL when the embedder failed — Postgres stores NULL for `$5::vector`, so the row
        // persists un-embedded (degraded) rather than the write being lost.
        embeddingVector ? `[${embeddingVector.join(',')}]` : null, // Convert to PostgreSQL vector format
        contextData.relevance_score,
        contextData.tags,
        contextData.metadata,
        vectorCoords.x,
        vectorCoords.y,
        vectorCoords.z,
        'umap'
      ];

      if (process.env.AIDIS_DETAILED_LOGGING === 'true') {
        logger.info(`🔍 DEBUG: Executing SQL query with parameters:`);
        logger.info(`🔍 DEBUG: SQL: ${sqlQuery.replace(/\s+/g, ' ').trim()}`);
        logger.info(`🔍 DEBUG: Param $3 (context_type): "${sqlParams[2]}" (${typeof sqlParams[2]})`);
      }
      
      const result = await db.query(sqlQuery, sqlParams);

      // DECLARED LIMBS: materialise the limbs this record declares, from the
      // row as WRITTEN (not from the request), so the stored set always describes the row that
      // actually exists. Degrades on error — never fails the store; see declaredLimbs.ts.
      await persistDeclaredLimbsForRow('context', result.rows[0]);

      // TS004-1: Update session activity after context storage
      if (sessionId) {
        const { SessionTracker } = await import('../services/session/SessionTracker.js');
        await SessionTracker.updateSessionActivity(sessionId);
        // TS007-2: Record context creation for activity tracking
        SessionTracker.recordContextCreated(sessionId);
      }

      const storedContext: ContextEntry = {
        id: result.rows[0].id,
        projectId: projectId,
        sessionId: sessionId,
        contextType: request.type,
        content: request.content,
        createdAt: result.rows[0].created_at,
        relevanceScore: request.relevanceScore || 5.0,
        tags: normalizedTags,
        metadata: carried.metadata || {},
        embedding: embeddingVector ?? undefined,
        warnings: refWarnings.length > 0 ? refWarnings : undefined,
        // Honest per-write report of the resume-pointer layer (null on non-handoffs).
        resumePointer,
        // Honest per-write report of the carried-fields layer (null when none supplied).
        carriedFields
      };

      if (process.env.AIDIS_DETAILED_LOGGING === 'true') {
        logger.info(`✅ Context stored successfully! ID: ${storedContext.id}`);
        logger.info(
          embeddingVector
            ? `🔍 Embedding: ${embeddingDims}D vector (${embeddingModel})`
            : `🔍 Embedding: NONE (degraded persist — self-heal worker will re-embed)`
        );
        logger.info(`🏷️  Tags: [${storedContext.tags.join(', ')}]`);
      }
      
      // Log the context creation event
      await logContextEvent(storedContext.id, 'stored', {
        context_type: storedContext.contextType,
        content_length: storedContext.content.length,
        tags: storedContext.tags,
        relevance_score: storedContext.relevanceScore,
        embedding_model: embeddingModel,
        embedding_dimensions: embeddingDims
      });

      // BL-9 POST-STORE BELIEF HOOK — the record is now COMMITTED (line ~420) WITH its
      // embedding. Trigger belief adjudication in the BACKGROUND: NON-BLOCKING (returns
      // immediately, never awaited), FAIL-SAFE (wrapped — a belief error never touches this
      // store), CONCURRENCY-BOUNDED (serial worker, embedder-priority) and FLAG-GATED
      // (no-op when MANDREL_BELIEF_ENABLED=false). FORWARD-ONLY: only this new write fires it.
      // EMBEDDING GUARD: a degraded persist has NO embedding, and belief
      // adjudication's findCandidates no-ops on a null embedding anyway — so skip the enqueue
      // when there is none (mirrors decisions site A), avoiding a zero-candidate queue slot.
      if (embeddingVector) {
        triggerBeliefAdjudication({
          id: storedContext.id,
          type: 'context',
          projectId,
          content: storedContext.content,
          createdAt: storedContext.createdAt,
        });
      }

      return storedContext;

    } catch (error) {
      logger.error('❌ Failed to store context', error as Error);
      throw new Error(`Context storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if hierarchical memory is enabled for a project
   * Instance #48: Changed to default-on (opt-out instead of opt-in)
   * After 10 instances of validation, hierarchical memory is production-ready
   */
  private async isHierarchicalEnabled(projectId?: string): Promise<boolean> {
    if (!projectId) return false;

    try {
      const result = await db.query(
        `SELECT metadata->>'hierarchical_memory_enabled' as enabled FROM projects WHERE id = $1`,
        [projectId]
      );
      const flagValue = result.rows[0]?.enabled;
      
      // Default to enabled unless explicitly set to 'false'
      // This enables hierarchical memory for all projects by default
      return flagValue !== 'false';
    } catch (error) {
      logger.error('Error checking hierarchical memory flag', error as Error);
      return false;
    }
  }

  /**
   * Detect if query explicitly requests recent/current information
   * Instance #43: Fix for hierarchical memory recency limitation
   */
  private isRecencyQuery(query: string): boolean {
    const recencyKeywords = [
      'recent', 'latest', 'current', 'now',
      'today', 'yesterday', 'this week', 'this month',
      'new', 'newest', 'just', 'last'
    ];

    const queryLower = query.toLowerCase();
    return recencyKeywords.some(keyword => queryLower.includes(keyword));
  }

  /**
   * Extract which recency keywords matched in the query
   * Instance #49: For observability logging
   */
  private extractRecencyKeywords(query: string): string[] {
    const recencyKeywords = [
      'recent', 'latest', 'current', 'now',
      'today', 'yesterday', 'this week', 'this month',
      'new', 'newest', 'just', 'last'
    ];

    const queryLower = query.toLowerCase();
    return recencyKeywords.filter(keyword => queryLower.includes(keyword));
  }

  /**
   * Search contexts using vector similarity and filters
   * Supports hierarchical memory scoring when enabled for project
   */
  async searchContext(request: SearchContextRequest): Promise<SearchResult[]> {
    logger.info(`🔍 Searching contexts: "${request.query}"`);

    // Instance #49: Start performance timing for observability
    const startTime = performance.now();

    try {
      // Generate embedding for search query
      const queryEmbedding = await embeddingService.generateEmbedding({
        text: request.query,
        role: 'query'
      });

      // Check if hierarchical memory is enabled for this project
      const hierarchicalEnabled = await this.isHierarchicalEnabled(request.projectId);

      // Check if query explicitly requests recent information (Instance #43 fix)
      // `rankProfile: 'balanced'` PINS the balanced blend — the recency switch is not
      // consulted at all. Omitted (the default 'auto') leaves the switch exactly as it was.
      const recencyProfileAllowed = (request.rankProfile ?? 'auto') === 'auto';
      const isRecencyFocused =
        hierarchicalEnabled && recencyProfileAllowed && this.isRecencyQuery(request.query);

      // Log scoring mode
      if (hierarchicalEnabled) {
        logger.info(`🧠 Hierarchical memory: ${isRecencyFocused ? 'RECENCY-FOCUSED' : 'BALANCED'}`);
      } else {
        logger.info(`🧠 Hierarchical memory: disabled`);
      }

      // Build search query with filters
      let sql: string;

      // ID-PREFIX + PARTIAL-TAG MATCH — built ONCE, at the live param index
      // right after the query vector ($1), so its $n placeholders line up with the params
      // pushed below. Used for BOTH the score boost and the retrieval gate (same $n reused,
      // no duplicate params). See buildContextIdTagGate for the full contract + why the gate
      // relaxes only for id-shaped queries. Returns a null `match` only for an empty / `*`
      // query, in which case every expression below stays exactly as it is today.
      const ID_TAG_PARAM_START = 2; // $1 is the query vector
      const idTag = this.buildContextIdTagGate(request.query, ID_TAG_PARAM_START, 'rank');

      /**
       * Fold the id/tag boost into a ranking expression. `+0` for every row that does not
       * match, so an ordinary text query's ordering AND scores are unchanged (the additive
       * no-regression contract). Every score below is in [0,1] and the boost is
       * SEARCH_ID_MATCH_SCORE_BOOST (1.0 by default), so a matched row is never OUTRANKED by
       * a non-matching one.
       *
       * IT CAN STILL TIE WITH ONE, and this comment used to deny that: it
       * claimed the matched row "strictly outranks all others → result #1", which is false at
       * the boundary — an un-embedded id match scores 0 + 1.0 = 1.0 and a PERFECT semantic
       * match scores 1.0 + 0 = 1.0. Equal. Ranking #1 is therefore decided by the ORDER BY's
       * tiebreaker, not by the boost, and the boost alone does not guarantee it.
       */
      const withIdBoost = (scoreExpr: string): string =>
        idTag.match
          ? `(${scoreExpr}) + (CASE WHEN ${idTag.match.sql} THEN ${SEARCH_ID_MATCH_SCORE_BOOST} ELSE 0 END)`
          : scoreExpr;

      // Shared signal expressions (referenced by both hierarchical branches and the
      // configurable combined_score builder). Decay half-life (days) is per-profile.
      const TYPE_WEIGHT_CASE = `CASE context_type
              WHEN 'milestone' THEN 1.0
              WHEN 'decision' THEN 0.9
              WHEN 'completion' THEN 0.8
              WHEN 'reflections' THEN 0.7
              WHEN 'planning' THEN 0.6
              WHEN 'code' THEN 0.5
              ELSE 0.4
            END`;
      // NULL-SAFE: `<=>` against a NULL embedding yields NULL, and NULL
      // POISONS the whole arithmetic blend → a NULL combined_score, which `ORDER BY ... DESC`
      // sorts NULLS FIRST — an un-embedded row would take rank #1 carrying a 0% displayed
      // score, and several would order arbitrarily. Now that the relaxed gate can admit an
      // un-embedded id hit, the similarity signal must floor at 0 so the row ranks on its
      // id boost + its real recency/importance signals.
      //
      // A GENUINE NO-OP FOR EMBEDDED ROWS (correct, but INERT on prod today): the un-relaxed
      // gate is `<active column> IS NOT NULL`, so the COALESCE can only ever fire for a row
      // the id-shaped relaxation just admitted. Under prod's active gemma column ZERO rows are
      // NULL (measured 2026-07-17: 0 of 8077), so it never fires there at all. It is load-
      // bearing under a `MANDREL_EMBEDDER=minilm` ROLLBACK, where the active column reverts to
      // `embedding` and 586 rows really are NULL. Same rationale as the gate relaxation above.
      const SIM_EXPR = `COALESCE(1 - (${activeEmbeddingColumn()} <=> $1::vector), 0)`;
      const IMP_EXPR = `COALESCE(relevance_score, 5.0) / 10.0`;
      const recExprFor = (halfLifeDays: number) =>
        `EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / (${halfLifeDays} * 24.0 * 3600))`;

      if (hierarchicalEnabled && isRecencyFocused) {
        // Recency-focused: TEMPORAL FILTER + dominant recency weighting.
        // Instance #43: temporal filter (last 60 days) + recency-dominant blend.
        // Blend weights/half-life now from RANK_WEIGHTS.recency (defaults preserve
        // the historical 0.05/0.90/0.025/0.025 @ 7-day half-life exactly).
        const w = RANK_WEIGHTS.recency;
        const REC_EXPR = recExprFor(w.halfLifeDays);
        sql = `
          SELECT
            id, project_id, session_id, context_type, content,
            created_at, relevance_score, tags, metadata,
            ${SIM_EXPR} as similarity,
            ${REC_EXPR} as recency_score,
            ${IMP_EXPR} as importance_score,
            ${TYPE_WEIGHT_CASE} as type_weight,
            ${withIdBoost(buildCombinedScoreSql(w, SIM_EXPR, REC_EXPR, IMP_EXPR, TYPE_WEIGHT_CASE))} as combined_score
          FROM contexts
          WHERE ${idTag.gateClause}
            AND created_at > NOW() - INTERVAL '60 days'
        `;
      } else if (hierarchicalEnabled) {
        // Balanced: vector similarity + recency + importance + context type weights.
        // Instance #43: 30-day half-life. Blend weights/half-life from RANK_WEIGHTS.balanced.
        // (Stale-comment fix, this said "defaults 0.25 each" — that was true
        // of the ORIGINAL (a+b+c+d)/4 blend, but an earlier task retuned the defaults to the
        // similarity-dominant 0.70/0.10/0.10/0.10. The comment had drifted from the code;
        // caught because an independent oracle in the id-search contract test recomputed the
        // ranking from it and disagreed with the handler. The weights still sum to 1.0.)
        const w = RANK_WEIGHTS.balanced;
        const REC_EXPR = recExprFor(w.halfLifeDays);
        sql = `
          SELECT
            id, project_id, session_id, context_type, content,
            created_at, relevance_score, tags, metadata,
            ${SIM_EXPR} as similarity,
            ${REC_EXPR} as recency_score,
            ${IMP_EXPR} as importance_score,
            ${TYPE_WEIGHT_CASE} as type_weight,
            ${withIdBoost(buildCombinedScoreSql(w, SIM_EXPR, REC_EXPR, IMP_EXPR, TYPE_WEIGHT_CASE))} as combined_score
          FROM contexts
          WHERE ${idTag.gateClause}
        `;
      } else {
        // Baseline: vector similarity only. `similarity` IS the sort key on this branch
        // (there is no combined_score), so the id boost is folded into IT — unlike the
        // hierarchical branches above, where `similarity` stays the RAW vector signal for
        // display and the boost belongs on the combined_score sort key.
        sql = `
          SELECT
            id, project_id, session_id, context_type, content,
            created_at, relevance_score, tags, metadata,
            ${withIdBoost(SIM_EXPR)} as similarity
          FROM contexts
          WHERE ${idTag.gateClause}
        `;
      }

      const params: any[] = [`[${queryEmbedding.embedding.join(',')}]`];
      let paramIndex = ID_TAG_PARAM_START;

      // Bind the id/tag match params immediately after the vector ($1), at exactly the
      // ID_TAG_PARAM_START index the predicate was BUILT at, so its $n placeholders (reused
      // in both the score expression and the retrieval gate) resolve correctly. When the
      // match is null (empty / `*` query) this pushes nothing and paramIndex is untouched —
      // the filters below then start at $2 exactly as they did before this change.
      params.push(...idTag.params);
      paramIndex = idTag.nextParamIndex;

      // SINGLE SOURCE OF TRUTH for the hard-filter set: build the WHERE
      // predicates via the shared buildContextSearchFilters() — the SAME builder
      // countContext() uses — so `total` (a COUNT over these predicates, NO LIMIT) can
      // never drift from the page's filter set (one filter clause, not two
      // drifting copies). The predicates are emitted byte-for-byte as the previous inline
      // block did — same order (archived → project → type → session → dateFrom → dateTo →
      // tags), same $n indices (continuing from the vector's $1) — so the page SQL is
      // unchanged; the ranking + LIMIT/OFFSET are appended on top below exactly as before.
      const filter = this.buildContextSearchFilters(request, paramIndex);
      sql += filter.clause;
      params.push(...filter.params);
      paramIndex = filter.nextParamIndex;

      // TOTAL ORDER, not just a ranked one. The score alone is a PARTIAL
      // order: rows that tie on it have no defined relative position, so Postgres may return
      // them in any order — and the OFFSET below then pages over two independent sorts of the
      // same tied block, which can hand the caller one row twice and never show another. A
      // silently dropped row is a recall defect that raises no error.
      //
      // THE TIEBREAKER IS `created_at DESC, id DESC`, chosen for three properties:
      //   - STABLE: `created_at` is stamped at insert and `id` is the primary key; neither
      //     moves when the row is edited, so a page boundary cannot shift under a concurrent
      //     update. (`updated_at` would, which is exactly why it is not used.)
      //   - UNIQUE: `id` is the PK, so the composite key is total by construction — there is
      //     no residual class of rows left unordered.
      //   - CHEAP: both are already indexed (PK btree), so no new index is implied.
      // Newest-first as the secondary matches how this product reads elsewhere (the decision
      // ranker, the task ranker, handoff head resolution).
      const TIEBREAK = `created_at DESC, id DESC`;
      if (hierarchicalEnabled) {
        sql += ` ORDER BY combined_score DESC, ${TIEBREAK} LIMIT $${paramIndex}`;
      } else {
        sql += ` ORDER BY similarity DESC, ${TIEBREAK} LIMIT $${paramIndex}`;
      }
      params.push(request.limit || 10);
      paramIndex++;

      // OFFSET pagination: zod accepts `offset` but it was previously never applied
      // (silent no-op). Wire it through here. Only the ordering/scoring above is
      // out-of-scope (the MEASURED ranking tranche) — OFFSET is plain pagination
      // applied AFTER ordering, so it does not alter the sort.
      if (request.offset !== undefined && Number.isInteger(request.offset) && request.offset > 0) {
        sql += ` OFFSET $${paramIndex}`;
        params.push(request.offset);
        paramIndex++;
      }

      logger.info('🔍 Executing vector similarity search...');
      const result = await db.query(sql, params);

      // Convert results and calculate similarities with substring boosting
      const results: SearchResult[] = result.rows.map(row => {
        // Handle potential null/undefined similarity values to prevent NaN
        const rawSimilarity = row.similarity;
        let similarity = Math.max(0, (rawSimilarity && !isNaN(parseFloat(rawSimilarity))) ? parseFloat(rawSimilarity) : 0) * 100;

        // Apply substring boosting for exact matches
        const queryLower = request.query.toLowerCase();
        const contentLower = row.content.toLowerCase();
        const tagsLower = (row.tags || []).join(' ').toLowerCase();

        let boost = 0;
        let boostReason = '';

        // Word-level substring matching (improved from whole-phrase matching)
        // Tokenize query into meaningful terms (filter out very short words)
        const queryTerms = queryLower.split(/\s+/).filter(term => term.length >= 3);

        if (queryTerms.length > 0) {
          // Check content for individual word matches
          const contentMatches = queryTerms.filter(term => contentLower.includes(term));
          const contentMatchRatio = contentMatches.length / queryTerms.length;

          // Check tags for individual word matches
          const tagMatches = queryTerms.filter(term => tagsLower.includes(term));
          const tagMatchRatio = tagMatches.length / queryTerms.length;

          // Apply proportional boosts based on match ratio
          // Max +25% for content matches, +15% for tag matches
          if (contentMatchRatio > 0) {
            const contentBoost = Math.round(contentMatchRatio * 25);
            boost += contentBoost;
            boostReason = `${contentMatches.length}/${queryTerms.length} terms matched`;
          }

          if (tagMatchRatio > 0) {
            const tagBoost = Math.round(tagMatchRatio * 15);
            boost += tagBoost;
            const tagReason = `${tagMatches.length}/${queryTerms.length} in tags`;
            boostReason = boostReason ? boostReason + ' + ' + tagReason : tagReason;
          }
        } else if (queryLower.length >= 2) {
          // Fallback for very short queries (1-2 char terms only)
          if (contentLower.includes(queryLower)) {
            boost += 20;
            boostReason = 'Exact match';
          }
          if (tagsLower.includes(queryLower)) {
            boost += 15;
            boostReason = boostReason ? boostReason + ' + tag match' : 'Tag match';
          }
        }

        // Apply boost
        if (boost > 0) {
          similarity = Math.min(100, similarity + boost); // Cap at 100%
        }

        const finalSearchReason = boostReason ?
          `${similarity > 70 ? 'High' : similarity > 40 ? 'Moderate' : 'Low'} similarity match (${boostReason})` :
          similarity > 70 ? 'High similarity match' :
          similarity > 40 ? 'Moderate similarity match' :
          'Low similarity match';

        // DISPLAY CONSISTENCY: the rows are ORDERED by the SQL sort
        // key — `combined_score` when hierarchical, else raw `similarity`. Surface
        // THAT value (as 0–100) as `relevance`, so the displayed number always
        // agrees with the order: row #1 shows the highest number. `combined_score`
        // is a weighted blend of signals each in [0,1], so it is itself in [0,1].
        //
        // DEFERRED (separate MEASURED change — do NOT do here): the JS substring
        // `boost` above adjusts the displayed `similarity` but NOT the SQL sort key,
        // so a boosted row is not re-ranked. Whether the substring boost SHOULD feed
        // the ranking/order is a ranking change that must go through the eval gate
        // (the eval gate); it is intentionally out of scope for this display-only fix.
        const sortKeyFraction = row.combined_score !== undefined && row.combined_score !== null
          ? parseFloat(row.combined_score)
          : (rawSimilarity && !isNaN(parseFloat(rawSimilarity)) ? parseFloat(rawSimilarity) : 0);
        const relevance = Math.round(Math.max(0, Math.min(1, sortKeyFraction)) * 100 * 10) / 10;

        return {
          id: row.id,
          projectId: row.project_id,
          sessionId: row.session_id,
          contextType: row.context_type,
          content: row.content,
          createdAt: row.created_at,
          relevanceScore: row.relevance_score,
          tags: row.tags || [],
          metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
          similarity: Math.round(similarity * 10) / 10, // Round to 1 decimal place (raw vector sim + boost)
          relevance, // the sort-key relevance the row ranked on
          searchReason: finalSearchReason,
          // Include score components for observability (Instance #49)
          recency_score: row.recency_score ? parseFloat(row.recency_score) : undefined,
          importance_score: row.importance_score ? parseFloat(row.importance_score) : undefined,
          type_weight: row.type_weight ? parseFloat(row.type_weight) : undefined,
          combined_score: row.combined_score ? parseFloat(row.combined_score) : undefined
        };
      });

      // Filter by minimum similarity if specified
      const filtered = request.minSimilarity 
        ? results.filter(r => r.similarity! >= request.minSimilarity!)
        : results;

      logger.info(`✅ Found ${filtered.length} matching contexts`);
      if (filtered.length > 0) {
        logger.info(`🎯 Top match: ${filtered[0].similarity}% similarity - "${filtered[0].content.substring(0, 60)}..."`);
      }

      // Instance #49: Calculate query latency and log hierarchical memory search with observability data
      const queryLatency = Math.round(performance.now() - startTime);

      // Determine mode and extract matched keywords
      const mode = hierarchicalEnabled ? (isRecencyFocused ? 'recency' : 'balanced') : 'baseline';
      const intentKeywordsMatched = isRecencyFocused ? this.extractRecencyKeywords(request.query) : [];

      // Log with detailed observability data (Oracle Priority 1)
      await logHierarchicalMemorySearch({
        query: request.query,
        mode: mode,
        intentKeywordsMatched: intentKeywordsMatched,
        results: filtered,
        queryLatencyMs: queryLatency,
        filters: request,
        projectId: request.projectId,
        hierarchicalEnabled: hierarchicalEnabled
      });

      return filtered;

    } catch (error) {
      logger.error('❌ Context search failed', error as Error);
      throw new Error(`Context search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * SINGLE SOURCE OF TRUTH for the context-search id-prefix / partial-tag MATCH and the
   * retrieval GATE it relaxes (an earlier task — the Contexts half of the class-fix
   * whose Decisions half shipped in 7014f77).
   *
   * THE BUG (RANKING, not retrieval): an id8 (`2b3c4d5e`) typed in the Contexts search box
   * matched NOTHING. Hex has no semantic content, so the embedder yields a meaningless vector
   * and the target ranks below unrelated prose — no threshold or model tuning can ever fix
   * that. The FIX that matters on prod is therefore the same one Decisions needed: an exact
   * id/tag match folded into the score so the row ranks #1.
   *
   * MEASURED ON PROD 2026-07-17 (read-only) — recording this because an earlier revision of
   * this comment asserted the OPPOSITE and was wrong:
   *   - prod runs `MANDREL_EMBEDDER=gemma` (verified in the RUNNING process's /proc/environ,
   *     not just .env) → activeEmbeddingColumn() = 'embedding_gemma';
   *   - `SELECT count(*) FILTER (WHERE embedding_gemma IS NULL) FROM contexts` → **0** of 8077;
   *   - `2b3c4d5e` itself: has_gemma = t (768 dims), has_legacy = f.
   * So on the ACTIVE column the gate `embedding_gemma IS NOT NULL` is TRUE for every row: the
   * target was ALWAYS in the candidate set, and the relaxation below changes NOTHING on prod.
   * The legacy `embedding` (minilm, 1536-d) column is the one with 586 NULLs — a column prod
   * does not read. Do not let that number back into a claim about prod behavior.
   *
   * TWO USES, ONE PREDICATE (no extra params — the same $n placeholders are reused):
   *   1. RANK  — folded into the sort key (`combined_score` / `similarity`) as
   *              `+ SEARCH_ID_MATCH_SCORE_BOOST` so an exact hit is result #1. THIS is the
   *              half that fixes the reported bug under the active (gemma) config.
   *   2. GATE  — OR'd into the `<active column> IS NOT NULL` base so an un-embedded id hit is
   *              still RETRIEVABLE. Relaxed ONLY when the query is id-SHAPED.
   *
   * WHY KEEP THE GATE RELAXATION IF IT IS INERT ON PROD — deliberate defense-in-depth, not
   * dead machinery. embeddingConfig.ts is explicitly a REVERSIBLE registry: "Cutover = flip
   * the env + rebuild the index; rollback = flip it back — the old column's data is never
   * destroyed." Under a `MANDREL_EMBEDDER=minilm` rollback the active column becomes
   * `embedding`, where 586 rows genuinely ARE NULL — and then this relaxation (and the
   * COALESCE on SIM_EXPR) is exactly what keeps id-lookup working instead of silently
   * dropping those rows on the floor. It costs one OR'd predicate that is `TRUE OR …` today.
   *
   * WHY THE GATE RELAXES ONLY FOR ID-SHAPED QUERIES (the no-regression contract): the tag arm
   * matches ordinary prose queries too (`ref:res`), and admitting un-embedded rows for those
   * would CHANGE the result set of everyday text searches. Relaxing only for id-shaped queries
   * keeps every non-id search drawing from exactly the candidate set it draws from today, so
   * results are byte-for-byte unchanged. Ranking stays additive on both paths: a row that
   * matches neither the id nor a tag scores `+0` — identical order, identical scores.
   *
   * "ID-SHAPED" IS WIDER THAN IT SOUNDS — measured, not assumed:
   *   the id predicate accepts ANY 8+-char dash-stripped hex string, so
   *   `2026-07-17` -> true, `20260717` -> true, `12345678` -> true, `deadbeef` -> true.
   *   Since an earlier task it is asked of each TOKEN rather than the whole query, so a
   *   sentence CONTAINING such a string is id-shaped too — same predicate, wider reach, and
   *   the same boundedness argument below carries over unchanged.
   *   DATES ARE ID-SHAPED, and this repo's own tags literally contain `2026-07-17`. So a date
   *   query DOES take the relaxed path. That is BOUNDED, not a flood: the relaxation only
   *   admits rows whose id-prefix or tag substring actually matches — never "all un-embedded
   *   rows" — and it is a no-op under gemma anyway. Bounded is not the same as narrow; do not
   *   re-describe this as a narrow safe class.
   *
   * `purpose` exists so the COUNT binds no unused parameters (Postgres rejects a bind with
   * more params than the statement references):
   *   - 'rank'  (searchContext) — build the match for ANY non-empty query: it is needed for
   *             the score boost even when the query is not id-shaped (partial-tag parity).
   *   - 'count' (countContext)  — build it ONLY when it changes the gate (id-shaped), since
   *             the COUNT has no score expression to fold it into.
   * The `idShaped` relaxation rule itself is computed HERE, exactly once, for both callers —
   * the same a past incident discipline as buildContextSearchFilters below: one clause, never two
   * drifting copies. `total` and the page therefore agree on which rows exist.
   *
   * SECURITY: every value is a BOUND parameter (`REPLACE(id::text,'-','') LIKE $n||'%'`,
   * `_tag ILIKE $m`) via the centralized buildSearchMatchPredicate — nothing is concatenated.
   */
  private buildContextIdTagGate(
    query: string | undefined,
    startParamIndex: number,
    purpose: 'rank' | 'count'
  ): {
    match: SearchMatchClause | null;
    gateClause: string;
    params: any[];
    nextParamIndex: number;
    idShaped: boolean;
  } {
    const q = (query ?? '').trim();
    // buildSearchMatchPredicate returns null for an empty / `*` query; mirror that guard
    // here so an id-shaped check never runs on a wildcard.
    // PER-TOKEN, NOT PER-QUERY. This read `queryLooksLikeId(q)` — the WHOLE
    // query — so a record named by id INSIDE A SENTENCE was neither boosted nor (on a
    // rollback config) admitted through the gate. It is now "does the query CONTAIN an
    // id-shaped token", which is the question the arm below actually answers. The widening
    // is bounded exactly as the whole-query form was: the relaxation admits only rows whose
    // id-prefix or tag substring actually matches, never "all un-embedded rows", and a query
    // with no id token behaves byte-for-byte as it does today.
    const idShaped = q !== '' && q !== '*' && extractIdTokens(q).length > 0;
    const wanted = purpose === 'rank' ? true : idShaped;
    const match = wanted
      ? buildSearchMatchPredicate(query, startParamIndex, { idColumn: 'id', tagsColumn: 'tags' })
      : null;

    // The gate: unchanged by DEFAULT (byte-for-byte, and binding nothing), relaxed only to
    // admit an un-embedded row the user asked for BY ID.
    const gateClause =
      match && idShaped
        ? `(${activeEmbeddingColumn()} IS NOT NULL OR ${match.sql})`
        : `${activeEmbeddingColumn()} IS NOT NULL`;

    return {
      match,
      gateClause,
      params: match?.params ?? [],
      nextParamIndex: match?.nextParamIndex ?? startParamIndex,
      idShaped,
    };
  }

  /**
   * SINGLE SOURCE OF TRUTH for the context-search hard-filter set.
   *
   * Emits the WHERE predicates shared by the semantic PAGE query (searchContext, which
   * appends them after its `WHERE embedding IS NOT NULL` base + then ranking + LIMIT) and
   * the COUNT query (countContext, which wraps `WHERE embedding IS NOT NULL` + these
   * predicates in COUNT(*)). Building the filter clause exactly ONCE is why `total` can
   * never drift from the page's filter set (a past incident — no second, drifting copy).
   *
   * `startParamIndex` lets each caller thread its own $n numbering: searchContext passes
   * 2 (its $1 is the query vector), countContext passes 1 (it has no vector param). The
   * predicate ORDER is fixed (archived → project → type → session → dateFrom → dateTo →
   * tags) so the page SQL is byte-for-byte identical to the prior inline block.
   *
   * NOTE (intentional): the JS-side `minSimilarity` trim and the substring `boost` are NOT
   * part of this clause — they are page-local relevance adjustments applied AFTER the SQL
   * (post-LIMIT), never SQL predicates. `total` therefore reports the size of the rankable
   * candidate set (all embedded rows passing these hard filters) — exactly the set the
   * paginated page is drawn from, which is what an offset-paginating caller needs.
   */
  private buildContextSearchFilters(
    request: Pick<SearchContextRequest,
      'projectId' | 'type' | 'sessionId' | 'dateFrom' | 'dateTo' | 'tags' | 'includeArchived'>,
    startParamIndex: number
  ): { clause: string; params: any[]; nextParamIndex: number } {
    let clause = '';
    const params: any[] = [];
    let paramIndex = startParamIndex;

    // SOFT-DELETE: exclude archived by DEFAULT (constant predicate, no param).
    if (!request.includeArchived) {
      clause += ` AND archived_at IS NULL`;
    }

    if (request.projectId) {
      clause += ` AND project_id = $${paramIndex}`;
      params.push(request.projectId);
      paramIndex++;
    }

    if (request.type) {
      clause += ` AND context_type = $${paramIndex}`;
      params.push(request.type);
      paramIndex++;
    }

    // ADDITIVE STRUCTURED FILTERS: session + created_at range.
    if (request.sessionId) {
      clause += ` AND session_id = $${paramIndex}`;
      params.push(request.sessionId);
      paramIndex++;
    }

    if (request.dateFrom) {
      clause += ` AND created_at >= $${paramIndex}`;
      params.push(request.dateFrom);
      paramIndex++;
    }

    if (request.dateTo) {
      clause += ` AND created_at <= $${paramIndex}`;
      params.push(request.dateTo);
      paramIndex++;
    }

    if (request.tags && request.tags.length > 0) {
      clause += ` AND tags && $${paramIndex}`;
      params.push(request.tags);
      paramIndex++;
    }

    return { clause, params, nextParamIndex: paramIndex };
  }

  /**
   * COUNT of ALL contexts matching the SAME hard-filter set as the semantic
   * searchContext() page, with NO LIMIT/OFFSET — this is what the route surfaces as
   * `total`. The old bug was `total = results.length` (the LIMIT-capped
   * page), so `total` silently maxed out at the page size once the match set exceeded one
   * page. Reuses the shared buildContextSearchFilters() so the count can never drift from
   * the page's filter set.
   *
   * Runs NO embedder round-trip (the query only ranks the candidate set; it is not a hard
   * filter) — it counts the rankable candidate set (the retrieval gate) + the hard filters,
   * exactly the set the paginated page is drawn from.
   *
   * `query` is OPTIONAL and is used ONLY to reproduce searchContext's
   * retrieval GATE, never to rank. It matters because the gate is no longer a constant: an
   * id-shaped query relaxes `embedding IS NOT NULL` to also admit the un-embedded row the
   * user asked for by id. If the COUNT kept the un-relaxed gate it would report `total: 0`
   * for the very search that returns a row — the page and `total` disagreeing is exactly the
   * two-drifting-copies bug that buildContextSearchFilters was written to
   * prevent. Both callers therefore go through the SAME buildContextIdTagGate. Omitting
   * `query` (or passing a non-id one) yields the unchanged constant gate, binding no params.
   */
  async countContext(
    request: Pick<SearchContextRequest,
      'projectId' | 'type' | 'sessionId' | 'dateFrom' | 'dateTo' | 'tags' | 'includeArchived'>
      & { query?: string }
  ): Promise<number> {
    // 'count' purpose: build the match ONLY when it actually changes the gate, so a plain
    // text query binds no parameter the statement never references (Postgres rejects that).
    const gate = this.buildContextIdTagGate(request.query, 1, 'count');
    const filter = this.buildContextSearchFilters(request, gate.nextParamIndex);
    // SOFT-DELETE-VIA: filter — the archived predicate is INSIDE filter.clause, built by the same
    // buildContextFilter() that builds the page query (see the `AND archived_at IS NULL` it
    // appends when includeArchived is falsy). Inlining it here would be a SECOND copy that
    // could disagree with the page — the count and the page must share one filter or `total`
    // drifts from the rows. Verified by reading the builder, not assumed.
    const sql = `SELECT COUNT(*)::int AS count FROM contexts WHERE ${gate.gateClause}${filter.clause}`;
    const result = await db.query(sql, [...gate.params, ...filter.params]);
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Ensure we have a valid project ID (get current project or specified project)
   * Accepts both UUID and project name
   */
  private async ensureProjectId(projectId?: string): Promise<string> {
    if (projectId) {
      // Check if projectId is a valid UUID format
      const isUuid = isValidUuid(projectId);

      // Query by UUID or name
      const result = await db.query(
        isUuid
          ? 'SELECT id FROM projects WHERE id = $1'
          : 'SELECT id FROM projects WHERE name = $1',
        [projectId]
      );

      if (result.rows.length > 0) {
        return result.rows[0].id;
      }
      throw new Error(`Project ${projectId} not found`);
    }

    // Use current active project from project handler
    await projectHandler.initializeSession(); // Ensure session is initialized
    // PROJECT-SCOPE: effective — the LAST-RESORT project for a write that named none. A bound
    // client never reaches here (the route gate materialises the binding into `projectId`
    // first), but if it did, the write must still land in the bound project.
    const currentProject = await projectHandler.getCurrentProject();

    if (currentProject) {
      logger.info(`📋 Using current project: ${currentProject.name}`);
      return currentProject.id;
    }

    throw new Error('No current project set. Use project_switch to set an active project or specify a project ID.');
  }

  /**
   * Ensure we have a valid session ID (get current or create new)
   */
  private async ensureSessionId(sessionId?: string, _projectId?: string, connectionId?: string): Promise<string | null> {
    if (sessionId) {
      // Verify the session exists
      const result = await db.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
      if (result.rows.length > 0) {
        return sessionId;
      }
      throw new Error(`Session ${sessionId} not found`);
    }

    // Resolve the active session for THIS connection only. No global fallback —
    // a context must never attach to another connection's session (the leak).
    // The route-level action gate lazily creates this connection's session
    // before the write, so this normally resolves to that session.
    try {
      const { SessionTracker } = await import('../services/session/SessionTracker.js');
      const activeSessionId = await SessionTracker.getActiveSession(connectionId);
      if (activeSessionId) {
        // DEFENSIVE HARDENING (belt-and-suspenders): never trust the active-session
        // id blindly. The explicit-sessionId branch above already verifies existence
        // before returning; mirror that here so a stale/missing session can NEVER be
        // passed as a dangling FK to the contexts INSERT (contexts_session_id_fkey).
        // contexts.session_id is NULLABLE, so storing without a session is valid and
        // strictly safer than crashing the user's context_store. The root-cause guard
        // in getActiveSession should already prevent this, but this guarantees the
        // write path itself can never throw an FK error on a bad session id.
        const verify = await db.query('SELECT id FROM sessions WHERE id = $1', [activeSessionId]);
        if (verify.rows.length > 0) {
          logger.info(`📋 Using active session: ${activeSessionId.substring(0, 8)}... for context storage`);
          return activeSessionId;
        }
        logger.warn(
          `⚠️  Active session ${activeSessionId.substring(0, 8)}... not found in database - ` +
          `storing context WITHOUT session association to avoid an FK violation`
        );
        return null;
      }

      logger.warn('⚠️  No active session found - context will be stored without session association');
      return null;
    } catch (error) {
      logger.warn('⚠️  Failed to get active session, storing context without session', { metadata: { error } });
      return null; // Fallback to no session if session tracking fails
    }
  }

  /**
   * Get recent contexts in chronological order (newest first)
   */
  async getRecentContext(projectId?: string, limit: number = 5, includeArchived: boolean = false): Promise<SearchResult[]> {
    logger.info(`📋 Getting ${limit} most recent contexts`);

    try {
      // Ensure we have a valid project
      const actualProjectId = await this.ensureProjectId(projectId);

      // SOFT-DELETE: exclude archived contexts by DEFAULT (archived_at IS
      // NULL); includeArchived:true returns archived rows too.
      const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';

      // Build query to get recent contexts
      const sql = `
        SELECT
          id, project_id, session_id, context_type, content,
          created_at, relevance_score, tags, metadata
        FROM contexts
        WHERE project_id = $1${archivedFilter}
        ORDER BY created_at DESC
        LIMIT $2
      `;
      
      logger.info('🔍 Executing recent contexts query...');
      const result = await db.query(sql, [actualProjectId, limit]);

      // Convert results to SearchResult format (same as searchContext)
      const results: SearchResult[] = result.rows.map(row => ({
        id: row.id,
        projectId: row.project_id,
        sessionId: row.session_id,
        contextType: row.context_type,
        content: row.content,
        createdAt: row.created_at,
        relevanceScore: row.relevance_score,
        tags: row.tags || [],
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        searchReason: 'Recent context (chronological order)'
      }));

      logger.info(`✅ Found ${results.length} recent contexts`);
      if (results.length > 0) {
        logger.info(`📅 Most recent: ${results[0].createdAt} - "${results[0].content.substring(0, 60)}..."`);
      }

      return results;

    } catch (error) {
      logger.error('❌ Failed to get recent contexts', error as Error);
      throw new Error(`Recent context retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get context statistics for a project
   */
  async getContextStats(projectId?: string, includeArchived: boolean = false): Promise<{
    totalContexts: number;
    contextsByType: Record<string, number>;
    recentContexts: number;
    embeddedContexts: number;
  }> {
    const actualProjectId = await this.ensureProjectId(projectId);

    // SOFT-DELETE. ONE predicate, built ONCE and interpolated into all four
    // aggregates below — not four copies, because a rule written in four places can be
    // weakened in one without the others noticing.
    //
    // WHY: these counts used to include ARCHIVED contexts while context_search excludes them
    // by default, so the two public tools disagreed by exactly the archived rows. That is the
    // identical defect measured on prod for decision_stats (556 vs 127) and closed earlier
    // for task_progress_summary vs task_list — the same class, third and
    // final instance among the context/decision/task entities. Guarded at class level by
    // src/tests/statsSearchCountReconcile.contract.test.ts.
    //
    // `embeddedContexts` takes the filter too, deliberately: it is embedding coverage OF THE
    // LIVE CORPUS. Counting embeddings on rows nobody can retrieve would report coverage a
    // search can never benefit from.
    const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';

    const [total, byType, recent, embedded] = await Promise.all([
      // Total contexts
      db.query(`SELECT COUNT(*) as count FROM contexts WHERE project_id = $1${archivedFilter}`, [actualProjectId]),

      // Contexts by type
      db.query(`
        SELECT context_type, COUNT(*) as count
        FROM contexts
        WHERE project_id = $1${archivedFilter}
        GROUP BY context_type
        ORDER BY count DESC
      `, [actualProjectId]),

      // Recent contexts (last 24 hours)
      db.query(`
        SELECT COUNT(*) as count
        FROM contexts
        WHERE project_id = $1 AND created_at > NOW() - INTERVAL '24 hours'${archivedFilter}
      `, [actualProjectId]),

      // Contexts with embeddings (ACTIVE embedder's column — so stats report gemma
      // coverage under gemma, not the legacy 1536-d column)
      db.query(`
        SELECT COUNT(*) as count
        FROM contexts
        WHERE project_id = $1 AND ${activeEmbeddingColumn()} IS NOT NULL${archivedFilter}
      `, [actualProjectId])
    ]);

    const contextsByType: Record<string, number> = {};
    byType.rows.forEach(row => {
      contextsByType[row.context_type] = parseInt(row.count);
    });

    return {
      totalContexts: parseInt(total.rows[0].count),
      contextsByType,
      recentContexts: parseInt(recent.rows[0].count),
      embeddedContexts: parseInt(embedded.rows[0].count)
    };
  }

  /**
   * SOFT-DELETE / ARCHIVE a context.
   *
   * Sets archived_at = now() for the row, SCOPED to `projectId` (cannot archive another
   * project's context). REVERSIBLE: the row is NOT hard-deleted — it stays in the table
   * and disappears only from the DEFAULT list/search (which filter archived_at IS NULL),
   * and restoreContext() clears archived_at back to NULL.
   *
   * Returns:
   *   { found: false }                          — no such row in this project.
   *   { found: true, alreadyArchived: true,  … } — was already archived (idempotent no-op).
   *   { found: true, alreadyArchived: false, … } — newly archived now.
   * The id is bound as a parameter (never concatenated); the short-id → UUID resolution
   * happens in the route BEFORE this is called, so `contextId` here is a full UUID.
   */
  /**
   * ONE context by id, project-scoped, ARCHIVED ROWS INCLUDED — the read
   * the archive/restore echoes use to return the whole record through the shared serializer
   * instead of an `{id}` receipt. Does not filter `archived_at` on purpose: the caller holds
   * the id, and a delete echo that cannot read the row it just archived is a write-only field.
   */
  async getContextById(contextId: string, projectId: string): Promise<ContextEntry | null> {
    const result = await db.query(
      `SELECT id, project_id, session_id, context_type, content, created_at, relevance_score,
              tags, metadata, archived_at
         FROM contexts WHERE id = $1 AND project_id = $2`,
      [contextId, projectId]
    );
    return result.rows.length === 0 ? null : mapContextRow(result.rows[0]);
  }

  async archiveContext(contextId: string, projectId: string): Promise<ArchiveResult> {
    // Only archive a row that is currently LIVE (archived_at IS NULL) AND in this
    // project. The RETURNING tells us whether we actually flipped it. A separate
    // existence probe distinguishes "not found" from "already archived" (idempotent).
    const updated = await db.query(
      `UPDATE contexts SET archived_at = now()
       WHERE id = $1 AND project_id = $2 AND archived_at IS NULL
       RETURNING id::text AS id, archived_at`,
      [contextId, projectId]
    );
    if (updated.rows.length === 1) {
      return { found: true, alreadyArchived: false, id: updated.rows[0].id, archivedAt: updated.rows[0].archived_at };
    }
    // Nothing flipped: either it doesn't exist in this project, or it's already archived.
    const probe = await db.query(
      `SELECT id::text AS id, archived_at FROM contexts WHERE id = $1 AND project_id = $2`,
      [contextId, projectId]
    );
    if (probe.rows.length === 0) return { found: false };
    return { found: true, alreadyArchived: true, id: probe.rows[0].id, archivedAt: probe.rows[0].archived_at };
  }

  /**
   * RESTORE (un-archive) a context. Clears archived_at back to NULL,
   * project-scoped. Idempotent. Mirror of archiveContext.
   */
  async restoreContext(contextId: string, projectId: string): Promise<ArchiveResult> {
    const updated = await db.query(
      `UPDATE contexts SET archived_at = NULL
       WHERE id = $1 AND project_id = $2 AND archived_at IS NOT NULL
       RETURNING id::text AS id`,
      [contextId, projectId]
    );
    if (updated.rows.length === 1) {
      return { found: true, alreadyArchived: false, id: updated.rows[0].id, archivedAt: null };
    }
    const probe = await db.query(
      `SELECT id::text AS id FROM contexts WHERE id = $1 AND project_id = $2`,
      [contextId, projectId]
    );
    if (probe.rows.length === 0) return { found: false };
    // Found but wasn't archived → restore is a no-op (already live).
    return { found: true, alreadyArchived: true, id: probe.rows[0].id, archivedAt: null };
  }

  /**
   * UPDATE (edit) a stored context — CURATE (T1 item 4). Contexts were immutable after
   * write; this makes the linking grammar REPAIRABLE: edit content, re-tag/re-thread,
   * fix a metadata back-link, or adjust the relevance score. SCOPED to `projectId` (a
   * context in another project is not editable). `contextId` is a full UUID (short-id →
   * UUID resolution happens in the route before this is called).
   *
   * Semantics:
   *   - `content`        → REPLACES content (and triggers a re-embed, below).
   *   - `tags`           → REPLACES the tag set, after the SAME validate/normalize pass as
   *                         store (so re-threading with a typo'd tag is warned, never
   *                         silently broken); triggers a re-embed (tags feed the vector).
   *   - `metadata`       → MERGED shallow over the existing metadata (T1 item 6); an
   *                         explicit null value DELETES that key. NEVER a wholesale replace.
   *   - `relevanceScore` → REPLACES the score.
   * Only the provided fields are touched; omitted fields are left exactly as they were.
   *
   * Returns { found:false } when no such row in this project (route → actionable error),
   * else the updated row + any tag-normalization warnings (surfaced to the caller).
   */
  async updateContext(request: UpdateContextRequest): Promise<UpdateContextResult> {
    // Validate/normalize the incoming tags the SAME way store does, so a re-tag can't
    // silently break a thread with a malformed join key (warn-only, never rejected).
    let normalizedTags: string[] | undefined;
    let refWarnings: string[] = [];
    if (request.tags !== undefined) {
      const tagValidation = validateAndNormalizeTags(request.tags);
      normalizedTags = tagValidation.tags;
      refWarnings = tagValidation.warnings;
      if (refWarnings.length > 0) {
        logger.warn(`🏷️  context_update linking-grammar normalization: ${refWarnings.join(' ')}`);
      }
    }

    // Build the dynamic SET clause from ONLY the provided fields (the zod .refine
    // guarantees at least one is present). Parameterized throughout — no concatenated
    // user input.
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (request.content !== undefined) {
      updates.push(`content = $${paramIndex}`);
      params.push(request.content.trim());
      paramIndex++;
    }
    if (normalizedTags !== undefined) {
      updates.push(`tags = $${paramIndex}`);
      params.push(normalizedTags);
      paramIndex++;
    }
    if (request.metadata !== undefined) {
      // METADATA MERGE (T1 item 6): shallow-merge incoming over existing in SQL (atomic,
      // no read-modify-write race); explicit null values delete those keys.
      const merge = metadataMergeSql('metadata', paramIndex, request.metadata);
      updates.push(`metadata = ${merge.expr}`);
      params.push(...merge.params);
      paramIndex += merge.params.length;
    }
    if (request.relevanceScore !== undefined) {
      updates.push(`relevance_score = $${paramIndex}`);
      params.push(request.relevanceScore);
      paramIndex++;
    }

    // WHERE id = $n AND project_id = $n+1 (project-scoped; never edit across projects).
    params.push(request.contextId);
    const idIdx = paramIndex;
    paramIndex++;
    params.push(request.projectId);
    const projIdx = paramIndex;
    paramIndex++;

    const sql = `
      UPDATE contexts
      SET ${updates.join(', ')}
      WHERE id = $${idIdx} AND project_id = $${projIdx}
      RETURNING id::text AS id, project_id, session_id, context_type, content,
                created_at, relevance_score, tags, metadata
    `;
    const result = await db.query(sql, params);
    if (result.rows.length === 0) {
      return { found: false };
    }
    const row = result.rows[0];

    // DECLARED LIMBS: RE-DERIVE unconditionally from the UPDATED row. Not
    // gated on "did content or tags change" — that predicate is an enumeration of the
    // columns that feed the derivation, and an enumeration is what goes stale the next time
    // one is added, leaving the stored set silently disagreeing with the tags it came from.
    await persistDeclaredLimbsForRow('context', row);

    // RE-EMBED ON TEXT/TAG CHANGE: content + tags feed the hybrid embedding (storeContext
    // builds it from type + tags + title + content). If either changed, regenerate the
    // embedding from the UPDATED row so semantic search stays in sync. Best-effort: a
    // failure leaves the prior embedding intact and never fails the edit.
    const embeddingAffected = request.content !== undefined || normalizedTags !== undefined;
    if (embeddingAffected) {
      try {
        const tagsForEmbed: string[] = row.tags || [];
        const embeddingText = buildContextEmbeddingText(row.context_type, tagsForEmbed, String(row.content));
        const embeddingResult = await embeddingService.generateEmbedding({ text: embeddingText, role: 'document' });
        await db.query(
          `UPDATE contexts SET ${activeEmbeddingColumn()} = $1::vector WHERE id = $2`,
          [`[${embeddingResult.embedding.join(',')}]`, row.id]
        );
        logger.info(`🔮 Re-embedded context ${String(row.id).substring(0, 8)}... after edit`);
      } catch (embedError) {
        // DEGRADE + ALERT (unified resilience, site D). The edit already
        // succeeded; the prior embedding is retained (row stays searchable on it). onEmbedFailure
        // logs + rate-limited-alerts. The self-heal worker only touches NULL rows, so a
        // retained-prior row is left as-is until the next edit re-embeds it.
        onEmbedFailure({ table: 'contexts', op: 'update', recordId: row.id, error: embedError });
      }
    }

    return {
      found: true,
      context: {
        id: row.id,
        projectId: row.project_id,
        sessionId: row.session_id,
        contextType: row.context_type,
        content: row.content,
        createdAt: row.created_at,
        relevanceScore: row.relevance_score,
        tags: row.tags || [],
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
      },
      warnings: refWarnings.length > 0 ? refWarnings : undefined,
    };
  }
}

/**
 * Result of a soft-delete archive/restore operation. `alreadyArchived`
 * doubles as "already in the target state" for both directions (archive: already
 * archived; restore: already live) so the route can report an idempotent no-op.
 */
export interface ArchiveResult {
  found: boolean;
  alreadyArchived?: boolean;
  id?: string;
  archivedAt?: string | Date | null;
}

/**
 * context_update request (CURATE, T1 item 4). `contextId` is a full UUID (resolved in the
 * route). Only the provided fields are edited; `metadata` is MERGED (null deletes a key).
 */
export interface UpdateContextRequest {
  contextId: string;
  projectId: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, any>;
  relevanceScore?: number;
}

/** Result of context_update. `found:false` → no such context in the project. */
export interface UpdateContextResult {
  found: boolean;
  context?: {
    id: string;
    projectId: string;
    sessionId: string | null;
    contextType: string;
    content: string;
    createdAt: Date;
    relevanceScore: number;
    tags: string[];
    metadata: Record<string, any>;
  };
  /** Tag-normalization warnings (re-tag with a malformed join key), surfaced to the caller. */
  warnings?: string[];
}

// Export singleton instance
export const contextHandler = new ContextHandler();