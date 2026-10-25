import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { metadataMergeSql, mergeMetadata } from '../utils/metadataMerge.js';
import { appendJsonbLogSql } from '../utils/taskNoteLog.js';
import {
    TASK_NOTES_CONFIG,
    TASK_NOTE_LOG_KEY,
    TASK_DESCRIPTION_HISTORY_KEY,
} from '../config/taskNotes.js';

/**
 * an earlier Task — the ANNOTATE fields, kept in their own trailing object for the same
 * reason `waiting` is: `updateTaskStatus` already takes fourteen positional parameters,
 * and a fifteenth positional argument is how a call site silently passes the right value
 * in the wrong slot.
 */
export interface TaskAnnotateFields {
    /** A status note. APPENDS to `metadata.noteLog`; never touches `description`. */
    notes?: string;
}

/**
 * Batch-5 lane K — the CLASSIFY field, in its own trailing object for exactly the reason
 * `waiting` and `annotate` are: this signature is already long enough that a further
 * positional argument is how a call site silently passes the right value in the wrong slot.
 *
 * `type` is a real `tasks` column that `task_create` writes and `task_list` filters on, and
 * this UPDATE path had no way to write it at all — the value set is owned by `taskTypeEnum`
 * in middleware/validation.ts (one definition, mirroring the DB CHECK constraint), so this
 * handler deliberately does NOT re-state the list.
 */
export interface TaskClassifyFields {
    /** The task's `type`. Omitted => the UPDATE does not name the column at all. */
    type?: string;
}
import { IdNotFoundError } from '../utils/idResolver.js';
import { recordWriteWithoutSession } from '../utils/sessionObservability.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { assigneeAssignmentSql } from '../config/assigneeStamp.js';
import { cap } from '../config/fieldLimits.js';
import { persistDeclaredLimbsForRow, persistDeclaredLimbsForRows } from '../services/declaredLimbsStore.js';
import {
    claimFenceClause,
    taskClaimService,
} from '../services/taskClaim.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { buildSearchMatchPredicate, capSearchLimit } from '../utils/idResolver.js';
import { SEARCH_ID_MATCH_SCORE_BOOST } from '../config/searchConfig.js';
import { TASK_SEARCH_DEFAULT_LIMIT, TASK_SEARCH_TRGM_ADMIT_FLOOR } from '../config/taskConfig.js';
import { logger } from '../utils/logger.js';
import { DUE_AT_COLUMN, type TaskListSort } from '../config/blockedOnConfig.js';
import {
    phaseTagCandidates,
    phaseTagCanonicalSql,
    phaseTagRecognizerSql,
} from '../config/phaseTagConfig.js';

/**
 * The deadline-aware half of a `task_list` request.
 *
 * A SEPARATE OBJECT, not two more positional params: listTasks already takes eleven, and
 * the eleventh is a boolean — the next caller to add one in the wrong slot would pass a
 * filter as a flag and get a wrong list with no error. It also keeps the three consumers
 * (listTasks / countTasks / buildTaskFilter) taking ONE value, so the LIST and its GRAND
 * TOTAL cannot be filtered differently, which is the property countTasks exists to hold.
 */
export interface TaskListOptions {
    /**
     * Upper bound on `due_at`, inclusive, as an ISO-8601 instant. Rows with NO deadline are
     * EXCLUDED — "not due before X" and "has no deadline" are different answers.
     */
    dueBefore?: string;
    /** Which ordering to apply. Validated against TASK_LIST_SORTS at the tool boundary. */
    sort?: TaskListSort;
    /**
     * THE FLOW FILTERS (gap 4). Lower bound on `created_at` and upper bound on
     * `created_at`, both inclusive, as ISO-8601 instants.
     *
     * WHY THEY DID NOT EXIST AND WHY IT COST: `dueBefore` filters the DEADLINE only, so there
     * was NO way to ask "what was filed this week". Answering "do we generate more tasks than
     * we close?" therefore cost a full list sweep of 1,212 rows plus 1,212 `task_details`
     * calls — which means the report gets run once, by hand, and never again.
     */
    createdAfter?: string;
    createdBefore?: string;
    /**
     * Lower bound on `closed_at` (migration 098), inclusive. Rows that are still OPEN are
     * excluded — "not closed since X" and "never closed" are different answers, and the
     * clause says so explicitly rather than leaving it to NULL comparison semantics.
     *
     * DELIBERATELY `closedAfter` AND NOT `completedAfter`, which is what the gap was
     * originally filed as. A flow question that counts only completions is the WRONG
     * QUESTION — it is exactly the arithmetic that hid the 2026-08-19 cull of 107 tasks,
     * the single largest outflow event in our history, because those tasks were cancelled
     * rather than completed. `closed_at` covers both terminal doors; `completedAt` remains
     * on the record for anyone who genuinely wants completions only.
     *
     * Guarded by assertClosedAtQueryable at the tool boundary — on a pre-098 database this
     * is REFUSED, never silently dropped.
     */
    closedAfter?: string;
    /**
     * THE PUNCH LIST LANE FILTER (migration 101). A single stage or an
     * array of stages ("everything in ready or claimed" is one call). Rows with stage NULL
     * (cancelled, or a legacy row) never match.
     */
    stage?: string | string[];
}
import { embeddingService } from '../services/embedding.js';
import { onEmbedFailure } from '../services/embedResilience.js';
import { buildTaskEmbeddingTextFromRow } from '../services/embedding/taskEmbeddingText.js';
// SCOPE §3.3, folded into P5.5. Until now `validateAndNormalizeTags` was called ONLY from
// handlers/context.ts:302 and :1414 — `task_create`/`task_update` stored tags COMPLETELY
// RAW: unvalidated, un-normalized, unwarned. That is why the tranche: census
// found 60% of values out-of-enum. It WARNS AND STORES: the function's own contract says
// "NEVER throws, NEVER rejects, NEVER drops a tag" (utils/threadingTags.ts:137-138), and
// that is load-bearing here — this change rides inside a schema migration, and a validator
// that started REJECTING would be a breaking change for every customer in the worst
// possible packaging (SCOPE §8.6).
import { validateAndNormalizeTags } from '../utils/threadingTags.js';
// TAG SPELLING — the write-time half of the tag-spelling collision check. Structural, carries
// no vocabulary, and warns without changing the tag. See services/tagSpellingWriteCheck.ts.
import { tagSpellingWriteWarnings, tagSpellingWriteWarningsForTask } from '../services/tagSpellingWriteCheck.js';
// P5.5 / migration 093. The write path must tolerate a database that does not have the
// columns yet — but it must NOT silently swallow a value a caller explicitly supplied.
import {
  assertBlockedOnWritable,
  type TaskWaitingFields,
} from '../services/taskBlockedOnCapability.js';
// an earlier Task — the task record's own lifecycle. Three rules, three files, each one the
// SINGLE declaration of its rule so the twin write sites cannot drift the way completed_at's
// did:
//   · resolveTaskAuthor  — gap 3: created_by comes from the actor the write already carries.
//   · assertBlockerNamed — gap 2: a block with no named blocker is refused, not stored.
// Gap 1 (`closed_at`) appears nowhere in this file BY DESIGN: migration 098's trigger owns
// that column outright, so no write statement here names it and the fleet roll is
// order-independent by construction. See services/taskClosedAtCapability.ts.
import { resolveTaskAuthor } from '../services/taskAuthorStamp.js';
import { assertBlockerNamed } from '../services/taskBlockerRequired.js';
import { CLOSED_AT_COLUMN } from '../config/taskLifecycleConfig.js';
// THE PUNCH LIST LANE (migration 101). stage is a REAL column
// (source of truth over status; the DB trigger derives status from it) and `punch` lives
// at metadata.punch. assertPunchComplete is the gate: setting stage='ready' REQUIRES
// title + metadata.punch.doneWhen + metadata.punch.proofKind + a resolved project.
import { assertPunchComplete, missingPunchFields, PunchIncompleteError } from '../services/taskPunchCompleteness.js';
import { PUNCH_METADATA_KEY, PUNCH_GATE_STAGE } from '../config/taskStageConfig.js';
import { punchMergeSql } from '../utils/punchMerge.js';

/**
 * THE ACTIVE EMBEDDING COLUMN for `tasks` (migration 088 adds both `embedding` (1536-d,
 * MiniLM — the legacy column, still selectable for rollback) and `embedding_gemma` (768-d —
 * the code default since 2026-08-19 and what every instance runs since the 08-13 fleet
 * cutover); config decides which one this process reads and writes).
 *
 * A trusted identifier from config, never user input, so it is safe to interpolate into SQL —
 * the same contract services/reembedBackfill.ts relies on. Resolved once at module load,
 * matching that engine: MANDREL_EMBEDDER does not change within a process.
 */
const TASK_EMBED_COL = activeEmbeddingColumn();

/**
 * A pgvector literal from a raw embedding. ONE definition in this module because both the
 * WRITE path (embedTaskInline) and the SEARCH path (searchTasks) must produce the same
 * literal form — the write side and the read side disagreeing on formatting is a class of
 * bug that presents as "similarity is subtly wrong", not as an error.
 */
function toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
}

/**
 * Embed a task's text INLINE, degrading rather than failing (the DEGRADE + PERSIST + ALERT
 * pattern established at handlers/context.ts storeContext and handlers/decisions.ts
 * recordDecision).
 *
 * Returns a pgvector literal, or NULL when there is nothing to embed OR the embedder failed.
 * NULL IS THE NEEDS-EMBEDDING MARKER the self-heal worker and the backfill both select on
 * (services/reembedBackfill.ts needsReembedSql), so a degraded write is automatically
 * recovered on the next 15-minute sweep. It NEVER throws: the caller is about to persist the
 * task, and an embedder outage must never cost a user their task (that exact data-loss bug is
 * what site C of the resilience task fixed for contexts).
 *
 * EMPTY TEXT short-circuits without calling the embedder. A task with no title, no
 * description, no tags, no type and no priority has no meaning to embed, and an embedding of
 * '' would be a NOT-NULL vector — which would look "embedded" to the NULL predicate above and
 * never be revisited even after the row gained real content.
 */
async function embedTaskInline(
    text: string,
    op: 'create' | 'update',
    recordId?: string,
): Promise<string | null> {
    if (!text.trim()) return null;
    try {
        const result = await embeddingService.generateEmbedding({ text, role: 'document' });
        return toVectorLiteral(result.embedding);
    } catch (embedError) {
        onEmbedFailure({ table: 'tasks', op, recordId, error: embedError });
        return null;
    }
}

export interface Task {
    id: string;
    projectId: string;
    sessionId?: string;  // TS005-1: Link to session where task was created
    title: string;
    description?: string;
    type: string;
    status: 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
    /**
     * The Punch List lane (migration 101) — SOURCE OF TRUTH over
     * `status`, kept in sync by DB trigger tasks_stage_status_sync. Null when the task is
     * cancelled or predates this migration.
     */
    stage: string | null;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    dependencies: string[];
    tags: string[];
    metadata: Record<string, any>;
    assignedTo?: string;  // Simple string, no FK
    createdBy?: string;   // Simple string, no FK
    progress: number;
    startedAt?: Date;
    completedAt?: Date;
    /**
     * WHEN THIS TASK LEFT THE BOARD, by either terminal door — completed OR cancelled
     * (migration 098). Distinct from `completedAt`, which means "reached
     * completed" and keeps its exact prior meaning. Absent-when-absent, like `blockedOn`.
     */
    closedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    // ── P5.5 / migration 093 ───────────────────────────────────────────────────────
    /**
     * WHO must act next: 'human' | 'agent' | 'external'; null = nobody in particular.
     * OPTIONAL AND ABSENT-WHEN-ABSENT: on a database that has not had migration 093
     * applied, mapTask omits this key entirely rather than reporting `null`. Those are two
     * different claims — "nobody is blocking this" and "this deployment cannot answer" —
     * and a read model that collapses them lies to every consumer downstream.
     */
    blockedOn?: string | null;
    /** The structured DEADLINE. Same absent-when-absent rule as `blockedOn`. */
    dueAt?: Date | null;
    /**
     * SOFT-DELETE stamp (made READABLE by an earlier task). Same absent-when-
     * absent rule: only a projection that selected `archived_at` carries the key, and an
     * `includeArchived:true` list is the read that needs it — without it a caller cannot tell
     * which of the returned rows are the archived ones.
     */
    archivedAt?: Date | null;
    /**
     * THE OTHER CARRIER OF "WHICH BRANCH IS THIS ON" — the declared
     * `branch_memberships` row, as opposed to the `branch:<slug>` TAG in `tags`. Populated
     * by listTasks(), which joins it; see mapTask for why the three states are distinct.
     *
     * ⚠️ A TASK IS BRANCHLESS ONLY WHEN **BOTH** CARRIERS ARE EMPTY. They are different
     * facts and they disagree in BOTH directions on live data: tasks with a declared
     * membership and no tag (invisible to a tag-keyed count), and tasks with a tag and no
     * membership (invisible to graph traversal). A consumer that counts on one of them
     * alone is not measuring "branchless" — it is measuring "missing the carrier I happened
     * to read", which is the miscount this field exists to make fixable.
     */
    branchMembership?: { spineId: string; spineType: string; source: string } | null;
    /**
     * Tag-grammar warnings from THIS write (SCOPE §3.3). Present only when the write
     * produced one. NOTHING WAS REJECTED AND NOTHING WAS DROPPED — the tag is stored; this
     * says it probably will not thread the way its prefix implies.
     */
    tagWarnings?: string[];
    // ── ATOMIC TASK CLAIM (migration 067) ────────────────────────────
    /** Optimistic-lock counter, bumped by a DB trigger on EVERY update (surface-independent). */
    version?: number;
    // NO `claimId` FIELD HERE, DELIBERATELY. A read model is what every reader gets, and a
    // fencing token published to every reader is not a fence — it is a BEARER CAPABILITY:
    // worker B reads A's token off a task read, presents it, and both are live owners. That
    // is the exact bug this feature exists to kill, so the token never leaves the DB on a
    // READ path. It is returned ONLY to the caller that just won or re-affirmed the claim
    // (task_claim / task_renew build their result from CLAIM_SQL's RETURNING, not from here).
    // A reader still gets everything needed to reason about a claim WITHOUT holding it:
    /** Who holds the claim — ATTRIBUTION ONLY, never the lock key. */
    claimActor?: string | null;
    /** Lease deadline; a claim at/after this instant is expired and re-claimable. */
    claimExpiresAt?: Date | null;
    /** True when a claim is present AND its lease has not elapsed. */
    claimLive?: boolean;
    /**
     * Vector-similarity score (0–100) to the search query, populated ONLY by searchTasks()
     * when a semantic `query` was supplied. Mirrors the identically-named
     * field on TechnicalDecision and the `similarity` context_search surfaces, so all three
     * sources hand smart_search the same shape and the merge adapter reads one field name.
     * Undefined for list/details/create/update results and for filter-only searches.
     *
     * IT IS THE COSINE ALONE, clamped to [0,100]. The exact-id / partial-tag BOOST is NOT
     * added into it — it rides `idTagHit` below. See the note in searchTasks() for why this
     * source reports the two facts separately instead of summing them like decisions do.
     *
     * ⚠️ DISPLAY ONLY — IT IS ROUNDED. Do not rank on it; rank on `cosineScore`.
     */
    similarity?: number;
    /**
     * The RAW, UNROUNDED cosine in [0,1] this row ranked on. Populated only
     * by searchTasks().
     *
     * WHY IT IS SEPARATE FROM `similarity`. `similarity` is quantised to one decimal of a
     * PERCENTAGE — i.e. to 0.001 of a cosine — because it is a number rendered to a human.
     * smart_search's merge sorts every source into ONE list, so a source that hands the merge
     * its display number is asking the global sort to rank on a rounded quantity: two rows
     * 0.0004 apart become an exact tie and are then separated by the date/id tiebreakers
     * instead of by relevance. handlers/smartSearch.ts's CONTEXT adapter already states this
     * rule ("RANK ON THE SORT KEY … not the display number"); this field is what lets the task
     * source obey it. MEASURED: with the adapter reading the rounded field, the merged score
     * differed from an independent recomputation by 2.0e-4 — small, but it is drift with no
     * upside, and it is drift in the one number the whole merge is sorted by.
     */
    cosineScore?: number;
    /**
     * TRUE when this row matched the query as an exact-id prefix or a partial tag.
     * Populated ONLY by searchTasks(); undefined everywhere else.
     *
     * It is a BOOLEAN, not a number, on purpose: the magnitude of the boost is a ranking
     * policy owned by ONE constant (SEARCH_ID_MATCH_SCORE_BOOST), and a source that reported
     * its own already-multiplied number would be a second place that policy lives. The row
     * reports the FACT; the merge adapter applies the policy.
     */
    idTagHit?: boolean;
}

/**
 * Request shape for SEMANTIC TASK SEARCH (tranche B). Deliberately narrow:
 * it carries the filters smart_search's task source needs and nothing else. The rich board
 * filters (assignee, phase, status sets, pagination) belong to listTasks and are not
 * duplicated here — a second copy of that filter set is exactly the drift
 * buildDecisionFilterQuery/buildTaskFilter exist to prevent.
 */
export interface SearchTasksRequest {
    projectId: string;
    /** Free text. Empty or '*' means "not a semantic search" and returns no rows. */
    query: string;
    /** Page size. Defaults to TASK_SEARCH_DEFAULT_LIMIT; capped for ambiguous id prefixes. */
    limit?: number;
    /** SOFT-DELETE: archived tasks are EXCLUDED unless this is true. */
    includeArchived?: boolean;
}

class TasksHandler {
    constructor(private pool: Pool = db) {}

    async createTask(
        projectId: string,
        title: string,
        description?: string,
        type: string = 'general',
        priority: Task['priority'] = 'medium',
        assignedTo?: string,
        createdBy?: string,
        tags: string[] = [],
        dependencies: string[] = [],
        metadata: Record<string, any> = {},
        connectionId?: string,
        status?: Task['status'],
        actor?: string,
        /** P5.5 / migration 093. Omitted => the INSERT does not name the columns at all. */
        waiting: TaskWaitingFields = {},
        /** migration 101 / an earlier decision. Omitted => the INSERT does not name the column. */
        stage?: string,
        /** Shallow-merged into `metadata.punch` before the INSERT. See utils/punchMerge.ts. */
        punch?: Record<string, any>
    ): Promise<Task> {
        // Validate project exists before creating task
        const projectExists = await this.pool.query(
            'SELECT 1 FROM projects WHERE id = $1',
            [projectId]
        );
        if (projectExists.rows.length === 0) {
            throw new Error(`Cannot create task: Invalid project ID ${projectId}. Project does not exist.`);
        }

        // SCOPE §3.3 — WARN AND STORE, NEVER REJECT. Runs BEFORE the embedding text is
        // built and before the INSERT, so the tag a caller sees echoed back is exactly the
        // tag that was embedded and stored (the same ordering handlers/context.ts uses —
        // one choke point, not three copies of a normalization).
        const tagValidation = validateAndNormalizeTags(tags);
        tags = tagValidation.tags;
        if (tagValidation.warnings.length > 0) {
            logger.warn(`🏷️  task_create linking-grammar normalization: ${tagValidation.warnings.join(' ')}`);
        }

        // P5.5 — a caller who supplied blocked_on/due_at on a pre-093 database gets a TYPED
        // ERROR naming the migration, never a silent drop. Silently discarding a field the
        // caller explicitly set is the failure mode this whole probe exists to avoid, and
        // it is worse than the 500 it replaces because it succeeds.
        await assertBlockedOnWritable(this.pool, waiting, 'task_create');

        // GAP 2 — a block with no named blocker is not a block. No taskIds:
        // the row does not exist yet, so there is no stored value to fall back on and this
        // call must name one itself. Runs BEFORE the INSERT; nothing is written on refusal.
        // `dependencies` is the SECOND channel and the create path already has it in hand —
        // passing it is what lets a task be filed straight into `blocked` because another task
        // must land first, without being forced onto a `blocked_on` party that would be false.
        await assertBlockerNamed(this.pool, status, waiting, [], 'task_create', dependencies);

        // THE PUNCH LIST LANE (migration 101). On CREATE there is no
        // existing row, so the "merge" is done in JS against the metadata object this call
        // is about to insert — shallow-merge `punch` into `metadata.punch`, explicit nulls
        // dropped (there is nothing to delete FROM on a fresh row, so a null field is simply
        // omitted rather than written). Then the completeness gate: setting stage='ready'
        // REQUIRES title + doneWhen + proofKind + a resolved project. Runs BEFORE the INSERT
        // — nothing is written on refusal. projectId has already been validated to exist
        // above, so the project is always resolved by this point in createTask.
        let finalMetadata = metadata ?? {};
        if (punch) {
            const existingPunch = { ...(finalMetadata[PUNCH_METADATA_KEY] ?? {}) };
            for (const [k, v] of Object.entries(punch)) {
                if (v === null) delete existingPunch[k];
                else existingPunch[k] = v;
            }
            finalMetadata = { ...finalMetadata, [PUNCH_METADATA_KEY]: existingPunch };
        }
        assertPunchComplete('task_create', stage, title, finalMetadata, true);
        metadata = finalMetadata;

        // GAP 3 — created_by comes from the actor the write ALREADY carries.
        // It was being threaded into this function as `actor` and dropped one line before the
        // INSERT that has a column for it, which is why the field was null on 75% of open
        // tasks. An explicit `createdBy` still wins; nothing resolvable still writes NOTHING.
        // See services/taskAuthorStamp.ts for all four rules and why `anonymous` is refused.
        const authorStamp = resolveTaskAuthor(createdBy, actor);

        const client = await this.pool.connect();
        try {
            // TS005-1: Capture active session_id for task-session linking.
            // Connection-scoped: attach to THIS connection's session only (no global
            // fallback) so concurrent connections never cross-attribute tasks.
            const { SessionTracker } = await import('../services/session/SessionTracker.js');
            // Actor threaded (the auditor A) so actor mode resolves the caller's session on a RAM
            // miss (actor rows carry connection_id NULL); ignored in legacy/shadow.
            const sessionId = await SessionTracker.getActiveSession(connectionId, { actor });
            // Observability (Phase 5, F3): task_create writing with NO session attributed
            // (session_id NULL) — surface the attribution loss as a visible counter.
            if (!sessionId) recordWriteWithoutSession('task_create');

            // `status` is optional: when omitted, COALESCE falls back to 'todo' (the
            // same value as the column default) so callers who don't set it are
            // unaffected; when provided (e.g. seeding a task straight into
            // in_progress) it persists instead of being silently dropped.
            // EMBED-ON-WRITE (migration 088). Computed BEFORE the INSERT so the
            // vector lands in the same statement as the row — no second write, no window in
            // which the task exists un-embedded on the happy path. `status` is deliberately NOT
            // part of the embed text (it is spent in the ranking config's importance map
            // instead — see services/embedding/taskEmbeddingText.ts), which is also why the
            // COALESCE default above cannot affect the vector.
            //
            // DEGRADE + PERSIST + ALERT: embedTaskInline never throws. On an embedder failure
            // it alerts and returns null, the INSERT below still runs, and the row persists
            // with a NULL vector that the self-heal worker re-embeds. A task must ALWAYS
            // persist — losing a user's task because an embedder was down is not acceptable.
            const embedLiteral = await embedTaskInline(
                buildTaskEmbeddingTextFromRow({ type, priority, tags, title, description }),
                'create',
            );

            // P5.5: the two 093 columns are appended ONLY when the caller supplied one, so
            // a deployment that has not run the migration issues the IDENTICAL statement it
            // issued before P5.5 — the pre-093 hot path is not merely equivalent, it is the
            // same bytes. `assertBlockedOnWritable` above has already guaranteed that a
            // supplied field means the column exists.
            const extraCols: string[] = [];
            const extraVals: unknown[] = [];
            if (waiting.blockedOn !== undefined) { extraCols.push('blocked_on'); extraVals.push(waiting.blockedOn); }
            if (waiting.dueAt !== undefined) { extraCols.push('due_at'); extraVals.push(waiting.dueAt); }
            // migration 101: named ONLY when the caller supplied one. tasks_stage_status_sync
            // (BEFORE INSERT) derives `status` from it when present — see the migration for
            // the full rule.
            if (stage !== undefined) { extraCols.push('stage'); extraVals.push(stage); }
            const extraColSql = extraCols.length ? `, ${extraCols.join(', ')}` : '';
            const extraValSql = extraCols.map((_, i) => `, $${14 + i}`).join('');

            const result = await client.query(
                `INSERT INTO tasks
                 (project_id, session_id, title, description, type, priority, status, assigned_to, created_by, tags, dependencies, metadata, ${TASK_EMBED_COL}${extraColSql})
                 VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'todo'), $8, $9, $10, $11, $12, $13::vector${extraValSql})
                 RETURNING *`,
                [projectId, sessionId, title, description, type, priority, status, assignedTo, authorStamp, tags, dependencies, metadata, embedLiteral, ...extraVals]
            );

            // DECLARED LIMBS: materialise the limbs this task declares, from
            // the row as WRITTEN. A task IS a limb root, so it always declares at least
            // itself. Degrades on error — never fails the write; see declaredLimbs.ts.
            await persistDeclaredLimbsForRow('task', result.rows[0], client as any);

            // TS004-1: Update session activity after task creation
            if (sessionId) {
                await SessionTracker.updateSessionActivity(sessionId);
                // TS007-2: Record task creation for activity tracking
                SessionTracker.recordTaskCreated(sessionId);
            }

            // SCOPE §3.3: the warning rides back to the CALLER, not just to a server log.
            // A warning only an operator can see is a warning the author of the tag never
            // reads, and the author is the only person who can fix the tag.
            const created = this.mapTask(result.rows[0]);
            // SPELLING COLLISIONS RIDE THE SAME CHANNEL as the grammar warnings,
            // for the same reason: only the tag's author can fix the tag, and only if they
            // are told. Appended AFTER the grammar warnings because a malformed threading
            // value is a broken join and a colliding spelling is a split queue — the broken
            // thing is read first.
            const spellingWarnings = await tagSpellingWriteWarnings(tags, projectId, this.pool);
            const allTagWarnings = [...tagValidation.warnings, ...spellingWarnings];
            if (allTagWarnings.length > 0) created.tagWarnings = allTagWarnings;
            return created;
        } finally {
            client.release();
        }
    }

    /**
     * Build the shared WHERE clause + params for task listing/counting. ONE source of
     * truth so `listTasks` (the limited slice) and `countTasks` (the grand total) filter
     * IDENTICALLY — the undercount bug was `total` reporting the returned
     * slice length while the real matching count was larger. Returns the clause (starting
     * with `WHERE project_id = $1 ...`) and the positional params; the caller appends its
     * own ORDER/LIMIT/OFFSET using `nextParamIndex`.
     */
    private buildTaskFilter(
        projectId: string,
        assignedTo?: string,
        status?: string,
        type?: string,
        tags?: string[],
        priority?: string,
        phase?: string,
        statuses?: string[],
        includeArchived?: boolean,
        opts?: TaskListOptions
    ): { clause: string; params: any[]; nextParamIndex: number } {
        // SOFT-DELETE: exclude archived tasks by DEFAULT (archived_at
        // IS NULL); includeArchived:true returns them too. Constant predicate, no param.
        const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
        let clause = `WHERE project_id = $1${archivedFilter}`;
        const params: any[] = [projectId];
        let paramIndex = 2;

        if (assignedTo) {
            clause += ` AND assigned_to = $${paramIndex}`;
            params.push(assignedTo);
            paramIndex++;
        }

        // Handle single status vs multiple statuses
        if (statuses && statuses.length > 0) {
            const statusPlaceholders = statuses.map(() => `$${paramIndex++}`).join(', ');
            clause += ` AND status IN (${statusPlaceholders})`;
            params.push(...statuses);
        } else if (status) {
            clause += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (type) {
            clause += ` AND type = $${paramIndex}`;
            params.push(type);
            paramIndex++;
        }

        // Tag filtering - match ANY of the provided tags
        if (tags && tags.length > 0) {
            clause += ` AND tags && $${paramIndex}`;
            params.push(tags);
            paramIndex++;
        }

        if (priority) {
            clause += ` AND priority = $${paramIndex}`;
            params.push(priority);
            paramIndex++;
        }

        // PHASE FILTERING — MATCH EVERY SPELLING OF THE PHASE, NOT ONE.
        //
        // This used to build the single literal `phase-${phase}` (twice, OR'd against
        // itself — two spellings of one predicate, which is its own small joke about this
        // bug). A task tagged `phase:5` or `phase5` was therefore INVISIBLE to the filter
        // built to find it, and the caller saw `total: 0` — indistinguishable from a phase
        // that has no tasks. Verified at the live tool surface before the fix:
        // task_list(projectId:"riverbend", phase:"5") returned total:0 with phase:5 and
        // phase5 tasks in that project.
        //
        // `phaseTagCandidates` states the grammar in ONE place (config/phaseTagConfig.ts),
        // including WHY this tolerates rather than closing the vocabulary, and why it
        // cannot reuse the collision fold. This covers the band a collision-based remedy
        // structurally cannot: `phase:2c` and `phase:5` have NO `phase-` counterpart, so
        // no pairing of spellings found in the data will ever name them — candidates are
        // generated from the QUERY, so their existence in the data is irrelevant.
        //
        // MEASURED, prod, largest project (1209 live tasks): 3.5ms vs 0.5ms for the old
        // predicate, same `idx_tasks_live` bitmap scan for the project — the tags array was
        // never index-searched under either form, so this costs an unnest per candidate row
        // and no plan regression. `EXPLAIN (ANALYZE, BUFFERS)` output is in the run report.
        if (phase) {
            // NEVER DROP THE PREDICATE. A whitespace-only phase yields no candidates, and
            // omitting the clause would answer "tasks in phase ' '" with the WHOLE backLOG —
            // the same failure mode assertDueAtQueryable exists to prevent one filter over.
            // An empty candidate array matches nothing, which is what the old literal
            // `phase- ` did too, so a caller who filters on nonsense still gets nothing.
            const candidates = phaseTagCandidates(phase);
            clause += ` AND EXISTS (SELECT 1 FROM unnest(tags) AS phase_tag` +
                      ` WHERE lower(phase_tag) = ANY($${paramIndex}::text[]))`;
            params.push(candidates);
            paramIndex++;
        }

        // THE DEADLINE FILTER. `due_at IS NOT NULL` is stated EXPLICITLY
        // rather than left to the comparison: a NULL compared to anything is NULL, so the
        // rows would be excluded either way — but a reader of this clause should not have
        // to know that to know whether "no deadline" counts as "not due before X". It does
        // not, and this says so.
        if (opts?.dueBefore) {
            clause += ` AND ${DUE_AT_COLUMN} IS NOT NULL AND ${DUE_AT_COLUMN} <= $${paramIndex}`;
            params.push(opts.dueBefore);
            paramIndex++;
        }

        // THE FLOW FILTERS (gap 4). `created_at` is NOT NULL on every row by
        // schema, so these two need no IS NOT NULL guard and no capability probe — a
        // difference from both the deadline filter above and the close filter below that is
        // worth noticing rather than copying a guard for symmetry.
        if (opts?.createdAfter) {
            clause += ` AND created_at >= $${paramIndex}`;
            params.push(opts.createdAfter);
            paramIndex++;
        }
        if (opts?.createdBefore) {
            clause += ` AND created_at <= $${paramIndex}`;
            params.push(opts.createdBefore);
            paramIndex++;
        }

        // THE CLOSE FILTER. `closed_at IS NOT NULL` is stated EXPLICITLY rather than left to
        // the comparison — a NULL compared to anything is NULL so open rows are excluded
        // either way, but a reader of this clause should not have to know that to know
        // whether "still open" counts as "not closed after X". It does not, and this says so.
        // Same reasoning as the deadline clause above.
        //
        // REACHING THIS LINE MEANS THE COLUMN EXISTS: assertClosedAtQueryable has already run
        // at the tool boundary and REFUSED the call otherwise. That ordering is the contract —
        // this clause must never be built speculatively, because naming an absent column here
        // is a 42703 that takes down the whole task_list.
        if (opts?.closedAfter) {
            clause += ` AND ${CLOSED_AT_COLUMN} IS NOT NULL AND ${CLOSED_AT_COLUMN} >= $${paramIndex}`;
            params.push(opts.closedAfter);
            paramIndex++;
        }

        // THE PUNCH LIST LANE FILTER (migration 101). Single value or array, same shape as
        // `statuses` above. `stage IS NOT NULL` is stated explicitly for the same reason the
        // deadline/close filters state their guard: a NULL compared to any value is NULL so
        // a cancelled/legacy row is excluded either way, but a reader should not have to know
        // that to know whether "no stage recorded" counts as a match. It does not.
        if (opts?.stage !== undefined) {
            const stages = Array.isArray(opts.stage) ? opts.stage : [opts.stage];
            if (stages.length > 0) {
                const placeholders = stages.map(() => `$${paramIndex++}`).join(', ');
                clause += ` AND stage IS NOT NULL AND stage IN (${placeholders})`;
                params.push(...stages);
            }
        }

        return { clause, params, nextParamIndex: paramIndex };
    }

    async listTasks(
        projectId: string,
        assignedTo?: string,
        status?: string,
        type?: string,
        tags?: string[],
        priority?: string,
        phase?: string,
        statuses?: string[],
        limit?: number,
        offset?: number,
        includeArchived?: boolean,
        opts?: TaskListOptions
    ): Promise<Task[]> {
        const client = await this.pool.connect();
        try {
            const { clause, params, nextParamIndex } = this.buildTaskFilter(
                projectId, assignedTo, status, type, tags, priority, phase, statuses, includeArchived, opts
            );
            let paramIndex = nextParamIndex;
            // DECLARED BRANCH MEMBERSHIP RIDES THE LIST (step 1).
            //
            // A task's branch is carried TWO unrelated ways — a `branch:<slug>` TAG naming a
            // workstream, and a `branch_memberships` row naming the SPINE RECORD it was
            // written on — and until now only the tag was readable off a LIST, because the
            // tag happens to live in `tags`. So every branch-keyed consumer of task_list
            // answered "which branch?" from the tag alone, and a task with a DECLARED
            // membership and no tag was counted as belonging to NOTHING. Measured by
            // The reviewer by running runtime's branch-board: its "no-branch open = 100",
            // labelled a drift signal, counted 14 declared spine members as branchless.
            // task_details has returned both carriers since an earlier change; the LIST could not,
            // and the list is what a board reads.
            //
            // A JOIN, NOT A PER-ROW READ. The obvious workaround — call readMembershipOf per
            // returned row — is an N+1 on a paged list, and it trades a wrong number for a
            // slow one while leaving the wrong number reachable by everything else that asks.
            //
            // IT CANNOT FAN OUT, and that is a property of the schema rather than a hope:
            // branch_memberships_pkey is PRIMARY KEY (record_id), so the LEFT JOIN is
            // one-to-at-most-one. That matters because `total` comes from countTasks, which
            // does NOT join — a join that duplicated rows would make the page and the total
            // disagree, silently. Asserted in the contract test rather than left as a claim.
            //
            // The join projects a NARROW subquery instead of the whole table on purpose:
            // branch_memberships also has `project_id` and `created_at`, and the shared
            // filter clause + ORDER BY below name those columns UNQUALIFIED. Exposing them
            // would make this query ambiguous rather than wrong, which is the good failure —
            // but only until someone adds a column, so the projection is narrowed here.
            let query = `SELECT tasks.*,
                                bm.spine_id   AS membership_spine_id,
                                bm.spine_type AS membership_spine_type,
                                bm.source     AS membership_source
                           FROM tasks
                           LEFT JOIN (
                                SELECT record_id, spine_id::text AS spine_id, spine_type, source
                                  FROM branch_memberships
                           ) bm ON bm.record_id = tasks.id
                           ${clause}`;

            // DEADLINE ORDER: `due_at ASC NULLS LAST` FIRST, then the
            // historical total order underneath it verbatim. Not a replacement — the
            // deadline column is null on all but a handful of rows, so without the
            // fall-through this ordering would be almost entirely arbitrary, and it is
            // OFFSET-paged (a partial order there shows one row twice and hides another).
            // The value is checked against the closed set, never interpolated from input:
            // this is the one place in the query built by string concatenation rather than
            // a bound parameter, because ORDER BY cannot take one.
            const dueFirst = opts?.sort === 'dueAt' ? `${DUE_AT_COLUMN} ASC NULLS LAST,\n                ` : '';

            query += ` ORDER BY
                ${dueFirst}CASE priority
                    WHEN 'urgent' THEN 4
                    WHEN 'high' THEN 3
                    WHEN 'medium' THEN 2
                    WHEN 'low' THEN 1
                    ELSE 0
                END DESC,
                created_at DESC,
                -- TOTAL ORDER: priority + created_at tie routinely (a board
                -- of same-priority tasks filed in one batch), and this list is OFFSET-paged
                -- below — a partial order there can show a task twice and hide another. The
                -- PK is unique, stable under edits, and already indexed.
                id DESC`;

            // Apply LIMIT when provided. Previously absent: the zod-validated `limit`
            // param was accepted but never reached SQL, so `limit:3` returned ALL
            // rows. Guard the value (positive integer) before interpolating.
            if (limit !== undefined && Number.isInteger(limit) && limit > 0) {
                query += ` LIMIT $${paramIndex}`;
                params.push(limit);
                paramIndex++;
            }

            // A7: pagination. Apply OFFSET when provided so rows beyond the (default 10,
            // max 100) limit window are reachable. Mirrors context_search's offset. Guard
            // to a non-negative integer before interpolating.
            if (offset !== undefined && Number.isInteger(offset) && offset >= 0) {
                query += ` OFFSET $${paramIndex}`;
                params.push(offset);
                paramIndex++;
            }

            const result = await client.query(query, params);
            return result.rows.map(row => this.mapTask(row));
        } finally {
            client.release();
        }
    }

    /**
     * SEMANTIC TASK SEARCH — the reader for the vectors migration 088 baked (an earlier task
     * , tranche B: "turn the task source on").
     *
     * WHY IT DID NOT ALREADY EXIST. Tranche B built the whole WRITE half — the columns, the
     * inline embed on create/update, the embed text, the backfill registration — and 3,807
     * task rows carry vectors on prod with zero nulls. Nothing read them. `tasks` had exactly
     * one search surface, listTasks, which is a metadata FILTER (status/type/tags/assignee)
     * and does no similarity at all, so "find the task about expiring credentials" was
     * unanswerable however well the row was embedded.
     *
     * SHAPED AFTER decisionsHandler.searchDecisions ON PURPOSE — the two are read by the same
     * merge and must present the same score. Specifically, and each of these is load-bearing:
     *
     *  · THE ACTIVE COLUMN IS RESOLVED PER CALL, via activeEmbeddingColumn(). NOT the module's
     *    TASK_EMBED_COL, and never a hardcoded 'embedding'/'embedding_gemma'. The two columns
     *    are DIFFERENT WIDTHS (1536-d minilm vs 768-d gemma), so a stale name is not a
     *    slightly-wrong result — it is a dimension-mismatch error, or worse a query against a
     *    column holding nothing written since the fleet cutover, which returns EMPTY with no
     *    error and no alert. That is the exact defect an earlier decision was recorded about,
     *    and the reason embeddingConfig.ts memoizes nothing.
     *
     *  · TRIGRAM IS AN ADMISSION PREDICATE ON THE EMBEDDED PATH. The lexical
     *    word_similarity term appears only in the WHERE gate (at
     *    TASK_SEARCH_TRGM_ADMIT_FLOOR), so it decides whether a row is a CANDIDATE and never
     *    how high it ranks. A GREATEST(cosine, lexical) here would inflate task scores by
     *    pure token overlap on a scale no other source has — measured at up to +0.12 on
     *    decisions, and how 19 of 20 top-2 smart_search slots became decisions before
     *    an earlier task deleted it. Do not reintroduce it.
     *    THE ONE EXCEPTION, stated so this bullet and the code do not contradict each
     *    other: on the EMBEDDER-DOWN path there is no cosine to rank by, so scoreSelect
     *    falls back to word_similarity as the ordering signal for that request. That is a
     *    degraded answer beating an empty one, and it is confined to the fallback branch —
     *    it must never leak into the embedded path, where it would be defect D1 again.
     *
     *  · SOFT-DELETE IS ON BY DEFAULT. `archived_at IS NULL` unless includeArchived, the same
     *    predicate listTasks and searchDecisions apply. A search that
     *    resurrects archived rows is a soft-delete that does not delete.
     *
     *  · THE WHOLE-REQUEST EMBEDDER FALLBACK. If the embedder is down there is no cosine to
     *    rank on at all, so the request degrades to the lexical score for EVERY row rather
     *    than blending two scales per-row. Stated as a whole-request fallback, exactly as
     *    decisions do it.
     *
     * SECURITY: every caller value is a BOUND parameter. The only interpolated strings are
     * activeEmbeddingColumn() and the id/tag predicate's SQL, both trusted identifiers built
     * from config / the shared resolver — never user input.
     */
    async searchTasks(request: SearchTasksRequest): Promise<Task[]> {
        const query = (request.query ?? '').trim();
        // NOT A SEMANTIC SEARCH. An empty (or wildcard) query has no direction to search in,
        // and this method has no non-semantic mode — listTasks is the filter surface. Return
        // nothing rather than silently degrading to "every task in the project", which as a
        // smart_search source would flood the merge with unranked rows.
        if (!query || query === '*') return [];

        let queryEmbeddingLiteral: string | null = null;
        try {
            const queryEmbedding = await embeddingService.generateEmbedding({ text: query, role: 'query' });
            queryEmbeddingLiteral = toVectorLiteral(queryEmbedding.embedding);
        } catch (embedError) {
            // Degrade to pure text matching, loudly. Mirrors searchDecisions.
            logger.warn('⚠️  Failed to embed task search query — falling back to text matching', {
                metadata: { message: (embedError as Error)?.message }
            });
        }

        const params: any[] = [request.projectId, query];
        // $1 = projectId, $2 = the raw query text (trgm). Both are always bound, so the
        // lexical gate works identically on the embedded and the degraded path.
        let paramIndex = 3;

        // COSINE, floored at 0 for an un-embedded row. `<=>` against NULL yields NULL, and a
        // NULL search_score sorts NULLS FIRST under `ORDER BY ... DESC` — an un-embedded row
        // would take rank #1 carrying a 0% displayed score. Same null-safety the context
        // ranker applies.
        let scoreSelect: string;
        if (queryEmbeddingLiteral !== null) {
            const embParamIdx = paramIndex++;
            params.push(queryEmbeddingLiteral);
            scoreSelect = `CASE WHEN ${activeEmbeddingColumn()} IS NULL THEN 0
                                ELSE 1 - (${activeEmbeddingColumn()} <=> $${embParamIdx}::vector) END`;
        } else {
            scoreSelect = `word_similarity($2, coalesce(title,'') || ' ' || coalesce(description,''))`;
        }

        // ID-PREFIX + PARTIAL-TAG MATCH via the SHARED predicate builder —
        // the same one decisions use, so a bare id or a partial `ref:`/`task:` tag resolves
        // identically whichever source answers. It is woven into BOTH the ORDER BY (exact hit
        // → rank #1) and the admission gate (a bare-id query shares no prose overlap and may
        // hit an un-embedded row).
        //
        // ⚠️ THE BOOST IS REPORTED SEPARATELY, NOT FOLDED INTO THE SCORE — and that is a
        // deliberate divergence from how decisions do it. There the boost is ADDED into the
        // one `search_score` column, and smart_search's decision adapter recovers the cosine
        // by inference: `cosine = min(1, raw)`, `boost = max(0, raw - 1)`. That inversion is
        // only correct while the boost is EXACTLY 1 — SEARCH_ID_MATCH_SCORE_BOOST is
        // env-overridable, and at, say, 0.5 a boosted 0.4-cosine row yields raw 0.9, which
        // the inversion reads as an unboosted cosine of 0.9. The information needed to split
        // it was destroyed by the addition. So this source emits the two facts as two
        // columns and nothing downstream has to guess. (The decision side is untouched here:
        // changing its arithmetic is a ranking change to a shipped source and does not belong
        // in the same commit as turning a new one on.)
        const idTagMatch = buildSearchMatchPredicate(query, paramIndex, {
            idColumn: 'id',
            tagsColumn: 'tags',
        });
        let idTagHitSelect = 'false';
        if (idTagMatch) {
            params.push(...idTagMatch.params);
            paramIndex = idTagMatch.nextParamIndex;
            idTagHitSelect = `(${idTagMatch.sql})`;
        }

        const archivedFilter = request.includeArchived ? '' : ' AND archived_at IS NULL';
        const idTagAdmit = idTagMatch ? `\n              OR ${idTagMatch.sql}` : '';
        const ilikeIdx = paramIndex++;
        params.push(`%${query}%`);

        // ADMISSION GATE. Keep only rows with a real signal: an embedding (semantic
        // candidate), a literal substring hit, a trigram overlap above the configured floor,
        // or an id/tag hit. A row with none of those is noise, not a low-ranked result.
        //
        // TOTAL ORDER. The rank key is the cosine PLUS the boost (so an exact id/tag hit is
        // #1), then created_at, then `id` — the final tiebreaker for the same reason it is
        // one in compareCandidates and in the decision ranker: rows sharing a score AND a
        // timestamp have an UNDEFINED relative order in Postgres, which makes every ranking
        // guard over this source flaky and its RED unfalsifiable.
        const sql = `
            SELECT *,
                   ${scoreSelect} AS search_score,
                   ${idTagHitSelect} AS id_tag_hit
              FROM tasks
             WHERE project_id = $1${archivedFilter}
               AND (
                 ${activeEmbeddingColumn()} IS NOT NULL
              OR title ILIKE $${ilikeIdx}
              OR description ILIKE $${ilikeIdx}
              OR word_similarity($2, coalesce(title,'') || ' ' || coalesce(description,''))
                   > ${TASK_SEARCH_TRGM_ADMIT_FLOOR}${idTagAdmit}
               )
             ORDER BY (${scoreSelect}
                       + CASE WHEN ${idTagHitSelect} THEN ${SEARCH_ID_MATCH_SCORE_BOOST} ELSE 0 END) DESC,
                      created_at DESC, id DESC
             LIMIT $${paramIndex}`;
        params.push(capSearchLimit(query, request.limit ?? TASK_SEARCH_DEFAULT_LIMIT));

        const client = await this.pool.connect();
        try {
            const result = await client.query(sql, params);
            return result.rows.map(row => {
                const task = this.mapTask(row);
                // TWO NUMBERS, ONE FACT, AND THE RANKER GETS THE UNROUNDED ONE.
                // `cosineScore` is the raw [0,1] sort key the merge consumes; `similarity`
                // is the same value as a 0–100 percentage rounded for display, consistent
                // with decision_search and context_search. Both are the COSINE ALONE — the
                // id/tag boost is NOT in either; that rides `idTagHit`. (A displayed
                // relevance that can read 187% is not a relevance.)
                const s = parseFloat(row.search_score);
                const c = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : undefined;
                task.cosineScore = c;
                task.similarity = c === undefined ? undefined : Math.round(c * 100 * 10) / 10;
                task.idTagHit = row.id_tag_hit === true;
                return task;
            });
        } finally {
            client.release();
        }
    }

    /**
     * Count ALL tasks matching the SAME filter as `listTasks` (ignoring limit/offset).
     * This is the GRAND TOTAL the route reports as `total` — so a limited
     * / paginated response never silently under-reports how many tasks actually match.
     */
    async countTasks(
        projectId: string,
        assignedTo?: string,
        status?: string,
        type?: string,
        tags?: string[],
        priority?: string,
        phase?: string,
        statuses?: string[],
        includeArchived?: boolean,
        opts?: TaskListOptions
    ): Promise<number> {
        const client = await this.pool.connect();
        try {
            const { clause, params } = this.buildTaskFilter(
                projectId, assignedTo, status, type, tags, priority, phase, statuses, includeArchived, opts
            );
            // SOFT-DELETE-VIA: clause — the archived predicate is INSIDE it, produced by
            // buildTaskFilter() above — the SAME builder listTasks uses, which is the whole
            // point of this method (the grand total must match the listed rows' filter
            // exactly). A literal predicate here would be a second copy that can drift.
            const result = await client.query(`SELECT COUNT(*)::int AS total FROM tasks ${clause}`, params);
            return result.rows[0]?.total ?? 0;
        } finally {
            client.release();
        }
    }

    /**
     * Update a task. CLAIM-FENCED since an earlier task (SPEC §6.5); fence WIDENED to every
     * field by an earlier task.
     *
     * TWO RULES, both enforced by the same WHERE predicate on the single UPDATE below:
     *   1. While a claim is LIVE, EVERY task_update mutation — content fields included —
     *      requires the matching `claimId` or the audited `force:true` override. The first
     *      build fenced only status/assignedTo, and that field list was the hole: a forged
     *      token touching only progress/metadata was accepted and persisted during someone
     *      else's live claim (verified live on the operator tenant, 2026-07-28).
     *   2. A supplied `claimId` is an OWNERSHIP ASSERTION and is validated on EVERY update
     *      regardless of fields touched — an invalid token is a typed rejection with ZERO
     *      mutation, never silently ignored (the second half of the same defect: on an
     *      unclaimed task a bogus token used to be dropped on the floor).
     *
     * The fence is a PREDICATE on the same single UPDATE (conditional mutation, the house
     * archiveTask CAS idiom), never a read-then-write: a SELECT-then-UPDATE fence would carry
     * the very TOCTOU window the claim exists to close. Zero rows updated ⇒ zero mutation
     * (no data, metadata, version, or timestamp change); the typed classification
     * (held / claim-mismatch / claim-expired / claim-lost) happens on a follow-up read.
     *
     * BEARER POLICY (pinned): the token is a bearer secret — a VALID token
     * presented by a DIFFERENT resolved actor IS authorized. See claimFenceClause.
     *
     * @param claimId  the token you hold. Presenting it (a) satisfies the fence, (b) IMPLICITLY
     *                 RENEWS the lease, and (c) CLEARS the claim when the write moves the task
     *                 to a terminal status (fenced completion, SPEC §6.6). A token that is no
     *                 longer live yields a typed claim-mismatch/claim-expired/claim-lost — the
     *                 only honest way a mid-flight worker learns it lost.
     * @param force    the audited human escape hatch: override a live claim deliberately.
     */
    async updateTaskStatus(
        taskId: string,
        status?: string,
        assignedTo?: string,
        metadata?: any,
        connectionId?: string,
        priority?: string,
        progress?: number,
        title?: string,
        description?: string,
        tags?: string[],
        actor?: string,
        claimId?: string,
        force?: boolean,
        /** P5.5 / migration 093. Omitted => the UPDATE does not name the columns at all. */
        waiting: TaskWaitingFields = {},
        /**
         * DEPENDENCIES, NOW EDITABLE. Resolved to full UUIDs by the route,
         * exactly as the create path resolves them. `undefined` => the column is not named in
         * the SET clause at all, so every call that predates this parameter is byte-identical.
         */
        dependencies?: string[],
        /**
         * an earlier Task. `notes` APPENDS a timestamped, actor-attributed entry to the
         * append-only log in `tasks.metadata.noteLog`; it never touches `description`.
         * Omitted => the metadata expression is byte-identical to what it was before.
         */
        annotate: TaskAnnotateFields = {},
        /**
         * Batch-5 lane K. `type` re-classifies the task. Omitted => the SET clause is
         * byte-identical to what it was before this parameter existed.
         */
        classify: TaskClassifyFields = {},
        /** migration 101 / an earlier decision. Omitted => the SET clause does not name it. */
        stage?: string,
        /** Shallow-merged into `metadata.punch`. See utils/punchMerge.ts. */
        punch?: Record<string, any>,
        /**
         * an earlier Task clause 11. True when `punch` above carries ONLY a `dependsOn` key
         * mirrored from the `dependencies` argument — i.e. this call named no other punch
         * field (not via `punch`, not via `metadata.punch`). Tells the gate below to drop the
         * mirror rather than synthesize a `metadata.punch` object on a row that has none. See
         * routes/tasks.routes.ts handleUpdate and utils/punchMerge.ts reconcilePunchDependsOn.
         */
        dependsOnMirrorOnly: boolean = false
    ): Promise<{ tagWarnings: string[]; descriptionPreserved: boolean }> {
        // SCOPE §3.3 — WARN AND STORE, NEVER REJECT, on the UPDATE path too. `task_update`
        // REPLACES the tag set, so a re-tag is exactly as able to break a thread with a
        // malformed join key as a create is; guarding only the create surface would fix the
        // reported half of the class and leave the other half open (CLASSES.md C5: if you
        // fixed one path, show the others).
        const tagWarnings: string[] = [];
        if (tags !== undefined) {
            const v = validateAndNormalizeTags(tags);
            tags = v.tags;
            tagWarnings.push(...v.warnings);
            if (v.warnings.length > 0) {
                logger.warn(`🏷️  task_update linking-grammar normalization: ${v.warnings.join(' ')}`);
            }
            // Tag spelling — the UPDATE path too. task_update REPLACES the tag set, so a re-tag
            // introduces a colliding spelling exactly as readily as a create does; warning
            // only on create would fix the reported half and leave the other open
            // (CLASSES.md C5 — if you fixed one path, show the others).
            tagWarnings.push(...(await tagSpellingWriteWarningsForTask(tags, taskId, this.pool)));
        }

        // P5.5 — refuse rather than silently drop, BEFORE anything is written. See
        // assertBlockedOnWritable for why this refuses while the tag path above warns.
        await assertBlockedOnWritable(this.pool, waiting, 'task_update');

        // GAP 2. A blocker ALREADY on this row satisfies the rule — re-saving
        // an already-justified blocked task must not demand the justification again. Runs
        // BEFORE the UPDATE; nothing is written on refusal.
        await assertBlockerNamed(this.pool, status, waiting, [taskId], 'task_update', dependencies);

        // THE PUNCH LIST LANE COMPLETENESS GATE (migration 101). Evaluated
        // against the MERGED state (existing row + this call's shallow merges), never against
        // only the fields this call happens to name — a caller finishing an earlier `draft`
        // with `{ stage: 'ready' }` alone must succeed off the punch fields a prior call
        // already stored. Runs BEFORE the UPDATE; nothing is written on refusal.
        // Non-transactional (a SELECT, then a separate UPDATE), same class of check-then-write
        // `assertBlockerNamed` already accepts for this table (see its F6 note) — a guard
        // against the ordinary mistake, not a serializable invariant.
        //
        // KEYED ON THE MERGED ROW'S STAGE, NOT THE CALL'S OWN `stage` ARGUMENT (an earlier task
        // clause 10). A call that omits `stage` on a row ALREADY at `ready` can still leave
        // `doneWhen` malformed via `metadata`/`punch` alone — checking only `stage === 'ready'`
        // left that write ungated. The SELECT runs whenever this call could plausibly change
        // the resulting stage/title/metadata (or needs the existing row to resolve the
        // dependsOn-mirror-only question below); the gate itself still fires only when the
        // MERGED stage (`stage ?? existingRow.stage`) is the gated value.
        const needsExistingRowForGate =
            stage !== undefined ||
            title !== undefined ||
            metadata !== undefined ||
            punch !== undefined ||
            dependsOnMirrorOnly;
        if (needsExistingRowForGate) {
            const existing = await this.pool.query(
                'SELECT title, metadata, stage FROM tasks WHERE id = $1',
                [taskId],
            );
            const existingRow = existing.rows[0];
            if (existingRow) {
                // CLAUSE 11: `punch.dependsOn` mirrored purely from a `dependencies` argument
                // (this call named no OTHER punch field, via `punch` or `metadata.punch`) must
                // not synthesize a `metadata.punch` object on a row that has none — mirror it
                // only when the row ALREADY carries a punch. See utils/punchMerge.ts
                // reconcilePunchDependsOn for the create-path half of this same rule.
                if (dependsOnMirrorOnly && !(existingRow.metadata && existingRow.metadata[PUNCH_METADATA_KEY])) {
                    punch = undefined;
                }
                const resultingStage = stage !== undefined ? stage : existingRow.stage;
                if (resultingStage === PUNCH_GATE_STAGE) {
                    const resultingTitle = title !== undefined ? title : existingRow.title;
                    let mergedMetadata = mergeMetadata(existingRow.metadata, metadata);
                    if (punch) {
                        mergedMetadata = {
                            ...mergedMetadata,
                            [PUNCH_METADATA_KEY]: mergeMetadata(mergedMetadata[PUNCH_METADATA_KEY], punch),
                        };
                    }
                    assertPunchComplete('task_update', resultingStage, resultingTitle, mergedMetadata, true);
                }
            }
        }

        const client = await this.pool.connect();
        try {
            // status is now OPTIONAL: a caller may update only priority/progress/assignee
            // without changing status. Build the SET clause from whatever was provided
            // (the zod .refine guarantees at least one field is present).
            const updates = ['updated_at = CURRENT_TIMESTAMP'];
            const params: any[] = [];
            let paramIndex = 1;

            if (status !== undefined) {
                updates.push(`status = $${paramIndex}`);
                params.push(status);
                paramIndex++;
                if (status === 'in_progress') updates.push(`started_at = CURRENT_TIMESTAMP`);
                // completed_at is OWNED BY THE TRIGGER (migration 099): it stamps on the
                // transition INTO completed and clears on the transition OUT, and does nothing
                // on a re-assert. An app-side COALESCE here fabricated a date on any supplied
                // status:'completed' — measured against a legacy NULL row, 2026-09-08.
            }

            // TRANSITION STAMP (an earlier task Phase 2) — the whole `assigned_to` decision for
            // this UPDATE, made in ONE place shared with the Command backend. Was a bare
            // `assigned_to = $n` guarded by `assignedTo !== undefined`, which is why a task
            // that reached `completed` without ever being CLAIMED lost its doer (364 such rows
            // on prod). See config/assigneeStamp.ts for the rule and its four constraints.
            // Same call in bulkUpdateTasks below — the twin site; change both or neither.
            const assignee = assigneeAssignmentSql(
                status,
                assignedTo,
                actor,
                cap('tasks.assigned_to'),
                paramIndex,
            );
            if (assignee.clause !== null) {
                updates.push(assignee.clause);
                params.push(...assignee.params);
                paramIndex += assignee.params.length;
            }
            // A4: priority + progress are REAL columns on `tasks`; previously the route
            // forwarded only status/assignedTo/metadata so these were accepted by zod
            // then silently dropped (task_update returned success but wrote nothing).
            if (priority !== undefined) {
                updates.push(`priority = $${paramIndex}`);
                params.push(priority);
                paramIndex++;
            }
            // RE-CLASSIFY (batch-5 lane K). The twin of `priority` above in every respect:
            // a plain enum-constrained column, validated at the edge against the SAME
            // taskTypeEnum task_create uses. `!== undefined` and not truthiness — there is
            // no falsy member of the enum today, but the truthiness form is how a future
            // legal value gets silently dropped. Named ONLY when the caller supplied one,
            // so an update that does not mention type never touches the column.
            if (classify.type !== undefined) {
                updates.push(`type = $${paramIndex}`);
                params.push(classify.type);
                paramIndex++;
            }
            if (progress !== undefined) {
                updates.push(`progress = $${paramIndex}`);
                params.push(progress);
                paramIndex++;
            }
            // CURATE (T1 item 5): edit title / description / tags after the fact.
            if (title !== undefined) {
                updates.push(`title = $${paramIndex}`);
                params.push(title);
                paramIndex++;
            }
            // Remembered so the description-history expression below can compare the OLD
            // value against the NEW one without binding the same text twice.
            let descriptionParamIndex = 0;
            if (description !== undefined) {
                descriptionParamIndex = paramIndex;
                updates.push(`description = $${paramIndex}`);
                params.push(description);
                paramIndex++;
            }
            if (tags !== undefined) {
                updates.push(`tags = $${paramIndex}`);
                params.push(tags);
                paramIndex++;
            }
            // P5.5 / migration 093. Named ONLY when the caller supplied one, so an update
            // that predates P5.5 emits the identical SET clause it emitted before — and on a
            // pre-093 database these identifiers never reach Postgres at all.
            // `!== undefined` and not a truthiness test: `null` is a legitimate, meaningful
            // value here (the caller CLEARING the field), and `blockedOn: null` under a
            // truthiness test would be silently ignored — which is the same
            // silently-dropped-intent defect assertBlockedOnWritable exists to prevent, one
            // layer down and in the path that is actually easy to get wrong.
            // DEPENDENCIES. `!== undefined` and not a truthiness test, so an
            // explicit `[]` CLEARS them rather than being silently ignored — the gate above has
            // already refused the one combination that must not reach here (erasing the only
            // channel justifying a blocked row). Omitted leaves the column unnamed.
            if (dependencies !== undefined) {
                updates.push(`dependencies = $${paramIndex}`);
                params.push(dependencies);
                paramIndex++;
            }

            if (waiting.blockedOn !== undefined) {
                updates.push(`blocked_on = $${paramIndex}`);
                params.push(waiting.blockedOn);
                paramIndex++;
            }
            if (waiting.dueAt !== undefined) {
                updates.push(`due_at = $${paramIndex}`);
                params.push(waiting.dueAt);
                paramIndex++;
            }
            // migration 101 / named ONLY when the caller supplied one.
            // tasks_stage_status_sync (BEFORE UPDATE) derives `status` from it — see the
            // migration for the full rule, and updateTaskStatus's own `status` handling
            // above for why an app-side `completed_at`/`closed_at` COALESCE is unnecessary
            // either way (094/098/099's triggers own those columns outright).
            if (stage !== undefined) {
                updates.push(`stage = $${paramIndex}`);
                params.push(stage);
                paramIndex++;
            }
            // ── ONE `metadata = ...` ASSIGNMENT, COMPOSED ────────────
            // Three things can now write this column in a single update: the shallow
            // metadata merge, the note-log append, and the description-history preserve.
            // Postgres rejects two assignments to one column, so they NEST — each takes
            // the previous expression as its input — and exactly one SET clause is emitted.
            // The order is deliberate: the caller's own metadata merge runs first, so a
            // caller cannot clobber the log entry this same call is recording.
            let metadataExpr: string | null = null;
            if (metadata !== undefined) {
                // METADATA MERGE (T1 item 6): shallow-merge incoming over existing in SQL
                // (atomic; no read-modify-write race) instead of the old wholesale REPLACE
                // that silently dropped untouched keys. Explicit null deletes that key.
                const merge = metadataMergeSql('metadata', paramIndex, metadata);
                metadataExpr = merge.expr;
                params.push(...merge.params);
                paramIndex += merge.params.length;
            }

            // THE PUNCH LIST LANE (migration 101). Shallow-merges into
            // `metadata.punch` ATOMICALLY in SQL (no read-modify-write race for the actual
            // write — the completeness gate's own SELECT above is a separate, deliberately
            // non-transactional pre-check). Nests on `metadataExpr` exactly like `notes`/
            // `description` below: the caller's own top-level metadata merge runs first, so
            // a caller cannot clobber a punch field this same call is also setting via the
            // sub-key path (order matches this file's existing composition contract).
            if (punch !== undefined) {
                const merge = punchMergeSql(metadataExpr ?? 'metadata', paramIndex, punch);
                metadataExpr = merge.expr;
                params.push(...merge.params);
                paramIndex += merge.params.length;
            }

            // THE APPEND AFFORDANCE. `notes` is why this task exists: "record where this
            // task now stands" had no home, so callers reached for `description`, which is
            // a silent full replace, and destroyed the spec. This APPENDS and cannot lose
            // anything — the entry is built inside the UPDATE so two concurrent notes
            // cannot overwrite each other.
            if (annotate.notes !== undefined) {
                const notesParam = paramIndex;
                params.push(JSON.stringify([{
                    at: new Date().toISOString(),
                    // NEVER invented: an unattributed note says so rather than guessing.
                    actor: actor ?? null,
                    note: annotate.notes,
                }]));
                paramIndex++;
                const appended = appendJsonbLogSql(
                    metadataExpr ?? 'metadata',
                    TASK_NOTE_LOG_KEY,
                    `$${notesParam}::jsonb`,
                    paramIndex,
                    TASK_NOTES_CONFIG.maxNoteEntries,
                );
                metadataExpr = appended.expr;
                params.push(...appended.params);
                paramIndex += appended.params.length;
            }

            // THE REPLACE BECOMES RECOVERABLE. `description` stays a full replace — every
            // existing caller keeps working — but the text it replaces is PRESERVED in the
            // same record instead of being destroyed. A bare `description` inside a SET
            // expression is the OLD row's value, which is precisely the value that would
            // otherwise be gone. Nothing is recorded when the old description was empty or
            // unchanged: the entries expression yields `[]` and the append is a no-op.
            if (description !== undefined) {
                const actorParam = paramIndex;
                params.push(actor ?? null);
                paramIndex++;
                const entriesExpr = `CASE
                    WHEN COALESCE(description, '') = '' OR description = $${descriptionParamIndex}
                    THEN '[]'::jsonb
                    ELSE jsonb_build_array(jsonb_build_object(
                        'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'actor', $${actorParam}::text,
                        'description', description
                    ))
                END`;
                const preserved = appendJsonbLogSql(
                    metadataExpr ?? 'metadata',
                    TASK_DESCRIPTION_HISTORY_KEY,
                    entriesExpr,
                    paramIndex,
                    TASK_NOTES_CONFIG.maxDescriptionHistory,
                );
                metadataExpr = preserved.expr;
                params.push(...preserved.params);
                paramIndex += preserved.params.length;
            }

            if (metadataExpr !== null) {
                updates.push(`metadata = ${metadataExpr}`);
            }

            // ── CLAIM FENCE (an earlier task SPEC §6.5; widened by an earlier task) ──────
            // Applies to EVERY mutating update while the feature is enabled — deliberately
            // NOT gated on which fields are touched (the field list WAS the hole; see the
            // method doc). When the feature is off, `fence.clause` is empty and the SQL
            // below is byte-identical to the pre-claim statement — the Lesson-025
            // "legacy == today" invariant, held by construction, not by a parallel path.
            const fencing = TASK_CLAIM_CONFIG.enabled;
            const holderWrite = fencing && !force && claimId !== undefined;
            // A fenced HOLDER write that moves the task to a terminal status CLEARS the claim
            // (fenced completion); otherwise it IMPLICITLY RENEWS the lease. Without the clear,
            // a finished task sits "held" until expiry and its zombie holder could still write.
            const clearsClaim =
                fencing && status !== undefined && TASK_CLAIM_CONFIG.clearingStatuses.includes(status);
            if (clearsClaim && (holderWrite || force)) {
                updates.push('claim_id = NULL', 'claim_actor = NULL', 'claim_expires_at = NULL');
            } else if (holderWrite) {
                updates.push(
                    `claim_expires_at = now() + ($${paramIndex}::int || ' seconds')::interval`
                );
                params.push(TASK_CLAIM_CONFIG.defaultLeaseSeconds);
                paramIndex++;
            }

            // PRE-IMAGE for the force-override audit: read the claim being overridden BEFORE
            // the write erases it (a post-image read would record "nothing was overridden").
            const forcePreImage =
                fencing && force ? await taskClaimService.probe(taskId, client) : null;

            params.push(taskId);
            const taskIdIndex = paramIndex;
            paramIndex++;
            const fence = fencing
                ? claimFenceClause({ claimId, force }, paramIndex)
                : { clause: '', params: [] as any[] };
            params.push(...fence.params);
            // EXISTENCE ENFORCEMENT: the id resolver short-circuits a full
            // UUID WITHOUT a DB round-trip, so a syntactically-valid but NON-EXISTENT UUID
            // reached here and the bare UPDATE matched 0 rows SILENTLY — yet the route still
            // reported `action:updated, ok:true` (phantom success). RETURNING id + a rowCount
            // check makes the write honest: 0 rows affected → the task doesn't exist → throw
            // IdNotFoundError so the route surfaces an actionable not-found (never a lie).
            // Matches the established pattern decision_update already uses (RETURNING + guard).
            const updateResult = await client.query(
                `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${taskIdIndex}${fence.clause}
                 RETURNING id, title, description, tags, type, priority`,
                params
            );
            if (updateResult.rowCount === 0) {
                // Two reasons the guarded write can match nothing: the task does not exist
                // (today's contract — IdNotFoundError) or the CLAIM FENCE refused it. Probe to
                // tell them apart so the caller never gets "not found" for a task that plainly
                // exists and is simply held by someone else.
                if (fence.clause) {
                    const fenced = await taskClaimService.fenceRejection(taskId, force ? undefined : claimId, client);
                    if (fenced) throw fenced;
                }
                throw new IdNotFoundError(taskId);
            }

            // ── RE-EMBED ON WRITE ──────────────────────────────────────
            // Only when a field the embed text actually READS changed. The embed text is
            // type/priority/tags/title/description (services/embedding/taskEmbeddingText.ts),
            // and since batch-5 lane K made `type` editable here, the trigger set is all
            // FIVE of them. (This comment read "`type` is not editable through this path, so
            // the trigger set is exactly these four" — true when it was written, and adding
            // the write path without adding the trigger would have left every re-typed task
            // retrievable forever under its OLD type with nothing NULL for the self-heal
            // worker to notice.) A pure status / progress / metadata / assignee edit leaves
            // the vector correct, and re-embedding it would spend an embedder call to
            // produce the identical vector.
            //
            // Built from the POST-IMAGE (updateResult.rows[0]), not from the arguments: a
            // partial update supplies only the changed field, so the arguments alone cannot
            // reconstruct the row's full text.
            //
            // ON FAILURE WE NULL THE COLUMN — deliberately unlike the decision/context UPDATE
            // sites, which RETAIN the prior vector. Here the prior vector describes text that
            // no longer exists: keeping it would leave the row confidently retrievable under
            // its OLD title forever, with nothing NULL for the self-heal worker to notice.
            // NULL is the needs-reembed marker, so nulling makes the staleness self-correcting
            // (worst case a 15-minute window where the task is lexically searchable only).
            const embedFieldChanged =
                title !== undefined || description !== undefined ||
                tags !== undefined || priority !== undefined ||
                classify.type !== undefined;
            if (embedFieldChanged) {
                const updatedRow = updateResult.rows[0];
                const reembedLiteral = await embedTaskInline(
                    buildTaskEmbeddingTextFromRow(updatedRow),
                    'update',
                    updatedRow.id,
                );
                await client.query(
                    `UPDATE tasks SET ${TASK_EMBED_COL} = $1::vector WHERE id = $2`,
                    [reembedLiteral, updatedRow.id],
                );
            }

            // DECLARED LIMBS: RE-DERIVE unconditionally from the UPDATED row.
            // `task_update` can edit title, description AND tags — every source the derivation
            // reads — so a stored set that is not re-derived here silently drifts from the tags
            // it came from. Unconditional rather than gated on which fields were touched: the
            // gate would be an enumeration of columns, and that enumeration is what rots.
            await persistDeclaredLimbsForRow('task', updateResult.rows[0], client as any);

            // Audit the claim-lifecycle side effects of this ordinary write (best-effort
            // observability; the write itself has already committed).
            if (fencing && force && forcePreImage) {
                await taskClaimService.recordForceOverride(taskId, 'task_update', actor, forcePreImage, client);
            } else if (holderWrite) {
                await taskClaimService.recordHolderWrite(taskId, claimId!, clearsClaim, 'task_update', client);
            }

            // TS004-1: Update session activity after task update (connection-scoped).
            // Actor threaded (the auditor A) so actor mode resolves the caller's session on a RAM
            // miss; ignored in legacy/shadow.
            const { SessionTracker } = await import('../services/session/SessionTracker.js');
            const sessionId = await SessionTracker.getActiveSession(connectionId, { actor });
            if (sessionId) {
                await SessionTracker.updateSessionActivity(sessionId);
                // TS007-2: Record task update for activity tracking
                const isCompleted = status === 'completed';
                SessionTracker.recordTaskUpdated(sessionId, isCompleted);
            }

            // SCOPE §3.3: hand the tag warnings back to the caller. Returning a value where
            // this used to return void is deliberate — a warning that exists only in a server
            // log is read by an operator, and the operator is not the person who wrote the
            // tag. Callers that ignore the return keep working unchanged.
            // Whether a superseded description was PRESERVED, so the route can say so at
            // the moment of need — the point of the affordance is lost if the caller who
            // just replaced a spec is not told where the old one went.
            return { tagWarnings, descriptionPreserved: description !== undefined };
        } finally {
            client.release();
        }
    }

    /**
     * Bulk update multiple tasks atomically
     * @param taskIds Array of task IDs to update
     * @param updates Partial task updates to apply
     * @returns Summary of update operation
     */
    /**
     * Bulk update. CLAIM-AWARE since an earlier task (SPEC §6.8).
     *
     * WHY THIS PATH MATTERS: `UPDATE tasks … WHERE id = ANY($1)` stomps N claims in ONE
     * statement. Leaving it unguarded is precisely how this fix would become the next
     * dispatch-claim.ts — a lock that holds on the surface everyone tested and leaks on the
     * one nobody did (fix the class, not the instance).
     *
     * Chosen shape (the spec's second option): add the claim predicate and REPORT the skipped
     * rows through the EXISTING `failed`/`errors` contract, so a live-claimed task is silently
     * neither updated nor lost — the caller is told exactly which ids were fenced. `force:
     * true` overrides, audited per-row.
     */
    async bulkUpdateTasks(
        taskIds: string[],
        updates: {
            status?: Task['status'];
            assignedTo?: string;
            priority?: Task['priority'];
            type?: Task['type'];
            metadata?: Record<string, any>;
            notes?: string;
            projectId?: string; // For validation only
            force?: boolean;
            /**
             * P5.5 / migration 093, extended to bulk by an earlier task (gap 2).
             *
             * IT HAD TO COME TO THIS PATH TOO. Gap 2 makes a move to `blocked` refuse unless a
             * blocker is named, and `task_bulk_update` is a real way tasks get blocked — a
             * board sweep blocks ten tasks behind one freeze in one call. Leaving the field off
             * bulk would have made the fail-closed rule unsatisfiable HERE, which is a rule
             * that closes the product rather than a hole: the caller would have had to unblock
             * the sweep by not using the tool. Same reason the completed_at lifecycle and the
             * assignee stamp are both implemented at both sites (CLASSES.md C5).
             *
             * `undefined` = the caller said nothing (the column is not named in the SET clause
             * at all); `null` = the caller explicitly CLEARED it. Different intents, kept
             * different, which is why this is `| null` and not a plain optional.
             */
            blockedOn?: string | null;
            /** migration 101 / an earlier decision. Applied to ALL targeted rows. */
            stage?: string;
            /** Shallow-merged into each targeted row's `metadata.punch`. */
            punch?: Record<string, any>;
        },
        connectionId?: string,
        actor?: string
    ): Promise<{
        totalRequested: number;
        successfullyUpdated: number;
        failed: number;
        updatedTaskIds: string[];
        errors: string[];
    }> {
        if (!taskIds || taskIds.length === 0) {
            throw new Error('No task IDs provided for bulk update');
        }

        // THE TWIN SITE for both P5.5 gates, run BEFORE the transaction opens so a refusal
        // costs no rollback. REFUSE, DO NOT DROP: a `blockedOn` supplied against a pre-093
        // database fails with a typed error naming the migration rather than silently
        // discarding what the caller asked for across N rows at once.
        const bulkWaiting: TaskWaitingFields =
            updates.blockedOn !== undefined ? { blockedOn: updates.blockedOn } : {};
        await assertBlockedOnWritable(this.pool, bulkWaiting, 'task_bulk_update');
        // GAP 2 — the twin site. Rows that ALREADY carry a blocker satisfy the
        // rule; the error reports HOW MANY of the targeted rows do not, which on a bulk sweep
        // is the number the caller actually needs.
        await assertBlockerNamed(this.pool, updates.status, bulkWaiting, taskIds, 'task_bulk_update');

        // THE PUNCH LIST LANE COMPLETENESS GATE, BULK (migration 101).
        // A sweep into stage='ready' refuses the WHOLE call if ANY targeted row would end up
        // incomplete — matching this tool's existing atomic-bulk contract (never a partial
        // apply). Evaluated per row against the MERGED state (existing metadata + this
        // call's shallow merges); bulk_update has no `title` param, so the existing title
        // always stands. Runs BEFORE the transaction opens, the twin-site pattern this file
        // already uses for the blockedOn gates above.
        if (updates.stage === PUNCH_GATE_STAGE) {
            const rows = await this.pool.query(
                'SELECT id, title, metadata FROM tasks WHERE id = ANY($1)',
                [taskIds],
            );
            const bulkMetadataOverlay: Record<string, any> = {};
            if (updates.metadata !== undefined) Object.assign(bulkMetadataOverlay, updates.metadata);
            const incomplete: { taskId: string; missing: string[] }[] = [];
            for (const row of rows.rows) {
                let merged = mergeMetadata(row.metadata, bulkMetadataOverlay);
                if (updates.punch) {
                    merged = { ...merged, [PUNCH_METADATA_KEY]: mergeMetadata(merged[PUNCH_METADATA_KEY], updates.punch) };
                }
                const missing = missingPunchFields(row.title, merged, true);
                if (missing.length > 0) incomplete.push({ taskId: row.id, missing });
            }
            if (incomplete.length > 0) throw new PunchIncompleteError('task_bulk_update', [], incomplete);
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // First, validate all task IDs exist
            const existenceCheck = await client.query(
                'SELECT id FROM tasks WHERE id = ANY($1)',
                [taskIds]
            );

            const existingTaskIds = existenceCheck.rows.map(row => row.id);
            const missingTaskIds = taskIds.filter(id => !existingTaskIds.includes(id));

            if (missingTaskIds.length > 0) {
                await client.query('ROLLBACK');
                throw new Error(`Tasks not found: ${missingTaskIds.join(', ')}`);
            }

            // Optional: Validate project ownership if projectId is provided
            if (updates.projectId) {
                const projectCheck = await client.query(
                    'SELECT id FROM tasks WHERE id = ANY($1) AND project_id != $2',
                    [taskIds, updates.projectId]
                );

                if (projectCheck.rows.length > 0) {
                    await client.query('ROLLBACK');
                    const wrongProjectTasks = projectCheck.rows.map(row => row.id);
                    throw new Error(`Tasks belong to different project: ${wrongProjectTasks.join(', ')}`);
                }
            }

            // Build dynamic update query
            const updateClauses = ['updated_at = CURRENT_TIMESTAMP'];
            const params: any[] = [];
            let paramIndex = 1;

            if (updates.status !== undefined) {
                updateClauses.push(`status = $${paramIndex}`);
                params.push(updates.status);
                paramIndex++;

                // Handle status-specific timestamp updates
                if (updates.status === 'in_progress') {
                    updateClauses.push('started_at = CURRENT_TIMESTAMP');
                }
                // completed_at is OWNED BY THE TRIGGER (migration 099) — see the single-row
                // path above. A bulk re-assert of status:'completed' over a legacy NULL row
                // stamped it through this clause; the trigger is transition-only.
            }

            // `blocked_on` ON THE BULK PATH (gap 2). OUTSIDE the status block on
            // purpose: naming a blocker is a legitimate edit on its own, without a status move
            // — that is how you correct a blocker that changed while the task stayed blocked.
            // `!== undefined` and not a truthiness test, so an explicit null CLEARS the field
            // rather than being silently ignored; the gate above has already refused the one
            // combination that must not reach here (clearing it while moving TO blocked).
            // No `closed_at` clause anywhere in this method — migration 098's trigger owns
            // that column, which is what keeps this statement pre-098-safe.
            if (updates.blockedOn !== undefined) {
                updateClauses.push(`blocked_on = $${paramIndex}`);
                params.push(updates.blockedOn);
                paramIndex++;
            }

            // migration 101 / named ONLY when the caller supplied one.
            // tasks_stage_status_sync (BEFORE UPDATE) derives `status` PER ROW from it.
            if (updates.stage !== undefined) {
                updateClauses.push(`stage = $${paramIndex}`);
                params.push(updates.stage);
                paramIndex++;
            }

            // TRANSITION STAMP (an earlier task Phase 2) — THE TWIN SITE. Identical semantic to
            // updateTaskStatus above, through the SAME shared builder, so bulk cannot drift
            // from single the way the completed_at lifecycle did. It matters here for the same
            // reason it matters there: a bulk move to `completed` is a real way work finishes,
            // and it left no doer behind. The CASE is evaluated PER ROW by Postgres, so rows
            // that already have an assignee keep theirs and only the empty ones are stamped.
            const bulkAssignee = assigneeAssignmentSql(
                updates.status,
                updates.assignedTo,
                actor,
                cap('tasks.assigned_to'),
                paramIndex,
            );
            if (bulkAssignee.clause !== null) {
                updateClauses.push(bulkAssignee.clause);
                params.push(...bulkAssignee.params);
                paramIndex += bulkAssignee.params.length;
            }

            if (updates.priority !== undefined) {
                updateClauses.push(`priority = $${paramIndex}`);
                params.push(updates.priority);
                paramIndex++;
            }

            // RE-TYPE IN BULK — THE TWIN SITE of the `type = $n` clause Lane K
            // added to the single task_update path. `type` was declared nowhere and written
            // nowhere here, so a task's KIND was write-once in bulk. The value is gated by the
            // SAME taskTypeEnum the single path uses, so the two cannot disagree about the set.
            // NOTE the coupling below: `type` feeds the embed text, so this clause and the
            // embedding-invalidation clause must be added together or not at all — see the
            // STALE-EMBEDDING block.
            if (updates.type !== undefined) {
                updateClauses.push(`type = $${paramIndex}`);
                params.push(updates.type);
                paramIndex++;
            }

            // METADATA MERGE: route bulk metadata through the SAME
            // metadataMergeSql helper the single task_update path uses, instead of the old
            // wholesale `metadata = $n` REPLACE that silently DROPPED every sibling key not
            // in the incoming object. That REPLACE left the Lesson-011 "whole class"
            // incomplete after the single-path merge fix (f7af00d) — bulk clobbered while
            // single merged. Now both share the shallow-merge semantics: set/overwrite
            // incoming keys, keep untouched keys, and an explicit `null` deletes a key.
            //
            // `notes` is folded into the SAME merge object so metadata + notes emit ONE
            // `metadata = ...` SET clause. Two separate `metadata = ...` assignments would
            // be a Postgres "multiple assignments to same column" error — a latent bug the
            // moment both were passed together (the route allows it). Notes still carries
            // its `lastUpdated` marker, and now merges (no longer clobbers sibling keys).
            const metadataMerge: Record<string, any> = {};
            if (updates.metadata !== undefined) {
                Object.assign(metadataMerge, updates.metadata);
            }
            if (updates.notes !== undefined) {
                metadataMerge.notes = updates.notes;
                metadataMerge.lastUpdated = new Date().toISOString();
            }
            let bulkMetadataExpr: string | null = null;
            if (Object.keys(metadataMerge).length > 0) {
                const merge = metadataMergeSql('metadata', paramIndex, metadataMerge);
                bulkMetadataExpr = merge.expr;
                params.push(...merge.params);
                paramIndex += merge.params.length;
            }
            // THE PUNCH LIST LANE, BULK (migration 101). Same nesting contract as the
            // single-row path: takes whatever metadata expression is already composed as its
            // base, so it cannot clobber the top-level merge above.
            if (updates.punch !== undefined) {
                const merge = punchMergeSql(bulkMetadataExpr ?? 'metadata', paramIndex, updates.punch);
                bulkMetadataExpr = merge.expr;
                params.push(...merge.params);
                paramIndex += merge.params.length;
            }
            if (bulkMetadataExpr !== null) {
                updateClauses.push(`metadata = ${bulkMetadataExpr}`);
            }

            // ── STALE-EMBEDDING INVALIDATION, NOT RE-EMBEDDING ─────────
            // THIS PATH NEVER CALLS THE EMBEDDER. It runs inside the BEGIN/COMMIT opened at
            // the top of this method, so an inline embed would hold an open transaction (and
            // its row locks on up to N tasks) across N network round-trips to the embedder —
            // an embedder that is slow or hung would convert a bulk edit into a lock-holding
            // stall for every other writer. The single-task paths embed inline precisely
            // because they hold no transaction; this one cannot.
            //
            // Instead we NULL the active embedding column in the SAME statement as the edit.
            // NULL is the needs-reembed marker (services/reembedBackfill.ts needsReembedSql),
            // so the self-heal worker re-embeds these rows on its next sweep. Atomic with the
            // edit: there is no instant at which the new text and the old vector are both
            // committed.
            //
            // ONLY when an embed-relevant field changed. Of everything this method can write
            // (status / assignedTo / priority / type / metadata / notes) exactly TWO feed the
            // embed text: `priority` and `type`. status is deliberately not in the embed text
            // (it is spent in the ranking importance map), and assignee/metadata/notes never
            // were. Nulling on a status-only bulk edit would dump every touched row into the
            // heal set for no change in meaning — a self-inflicted re-embed storm on the most
            // common bulk op.
            //
            // `type` JOINED THIS SET IN THE SAME COMMIT THAT MADE IT WRITABLE,
            // and that ordering is the whole point: a bulk re-type WITHOUT this line leaves
            // every re-typed row carrying the vector it was embedded with under its OLD type,
            // with nothing NULL for services/reembedBackfill.ts to notice — search degrades
            // silently and no instrument anywhere reports it. Asserted in BOTH directions by
            // src/tests/taskBulkUpdateType.contract.test.ts.
            const bulkInvalidatesEmbedding =
                updates.priority !== undefined || updates.type !== undefined;
            if (bulkInvalidatesEmbedding) {
                updateClauses.push(`${TASK_EMBED_COL} = NULL`);
            }

            // ── CLAIM FENCE (an earlier task SPEC §6.8; widened by an earlier task) ──────
            // A bulk write cannot hold N claims, so there is no claimId to present: the only
            // coherent rule is "a LIVE claim blocks the write; a dead one does not". Applies
            // to EVERY bulk mutation, not just ownership fields — the field-shaped hole was
            // the same here as on task_update (a metadata/priority bulk write walked straight
            // through a live claim). Live-claimed rows are SKIPPED and REPORTED through the
            // existing failed/errors contract. Empty clause (byte-identical to today's SQL)
            // whenever the flag is off or force:true was passed.
            const bulkFencing = TASK_CLAIM_CONFIG.enabled && !updates.force;
            // Capture the fenced ids BEFORE the write so they can be reported precisely (after
            // the update the claim state may have moved on).
            let fencedIds: string[] = [];
            if (bulkFencing) {
                const held = await client.query(
                    `SELECT id::text AS id, claim_actor, claim_expires_at
                       FROM tasks
                      WHERE id = ANY($1) AND claim_id IS NOT NULL AND claim_expires_at > now()`,
                    [taskIds]
                );
                fencedIds = held.rows.map(r => r.id);
            }

            // Add task IDs as final parameter
            params.push(taskIds);

            // Execute bulk update
            const updateQuery = `
                UPDATE tasks
                SET ${updateClauses.join(', ')}
                WHERE id = ANY($${paramIndex})${
                    bulkFencing ? ' AND (claim_id IS NULL OR claim_expires_at <= now())' : ''
                }
                RETURNING id, title, description, tags
            `;

            const updateResult = await client.query(updateQuery, params);
            const updatedTaskIds = updateResult.rows.map(row => row.id);

            await client.query('COMMIT');

            // DECLARED LIMBS: re-derive for every row this write touched.
            // Bulk is a write path like any other — leaving it out would make the stored set
            // depend on WHICH endpoint edited the record, which is exactly the drift the
            // unconditional re-derivation removes. After COMMIT: the rows are durable, and a
            // derivation failure degrades to NOT-DERIVED instead of rolling back the user's
            // update — AND (the reviewer) it is what makes the rollback-degradation
            // path safe, since this is the only write path holding an explicit transaction.
            // THE POSITION IS UNCHANGED BY still after COMMIT, still degrading.
            //
            // BATCHED, NOT PER ROW: the serial loop that used to live here did
            // one resolver load + one UPDATE per row — 2N round trips hung off a call whose
            // whole design point is to be a single statement. Same rule, same composition, same
            // degradation; one resolver load and one UPDATE for the batch. Bounded by
            // TASK_BULK_MAX_IDS, which is why persistDeclaredLimbsForRows does not chunk.
            await persistDeclaredLimbsForRows('task', updateResult.rows, client as any);

            // Audit: every id we refused, and (under force) every live claim we overrode.
            if (bulkFencing) {
                for (const id of fencedIds) {
                    await taskClaimService.fenceRejection(id, undefined, client, 'task_bulk_update');
                }
            } else if (TASK_CLAIM_CONFIG.enabled && updates.force) {
                for (const id of updatedTaskIds) {
                    const pre = await taskClaimService.probe(id, client);
                    await taskClaimService.recordForceOverride(id, 'task_bulk_update', actor, pre, client);
                }
            }

            // TS007-2: Record task updates for activity tracking (connection-scoped).
            // Actor threaded (the auditor A) so actor mode resolves the caller's session on a RAM
            // miss; ignored in legacy/shadow.
            const { SessionTracker } = await import('../services/session/SessionTracker.js');
            const sessionId = await SessionTracker.getActiveSession(connectionId, { actor });
            if (sessionId && updatedTaskIds.length > 0) {
                // LIVENESS (folded in from lane M-5): this line was MISSING,
                // and it was the only task write path missing it. createTask and
                // updateTaskStatus both end with this exact call; bulk resolved the session,
                // bumped the in-RAM counter below, and never advanced
                // `sessions.last_activity_at` — so the one write that can move fifty rows was
                // the one write that left no mark on the column every liveness consumer is
                // defined off (the Sessions UI, LIVE NOW, the dormant/close windows).
                // The SAME seam as the single path, deliberately: routing this through
                // SessionRepo.touchActivity directly would put a fourth spelling of one rule
                // in the tree. Guarded by src/tests/taskBulkUpdateSessionActivity.contract.test.ts.
                await SessionTracker.updateSessionActivity(sessionId);
                const isCompleted = updates.status === 'completed';
                // Record one update per task that was successfully updated
                for (let i = 0; i < updatedTaskIds.length; i++) {
                    SessionTracker.recordTaskUpdated(sessionId, isCompleted);
                }
            }

            // Report fenced rows through the EXISTING failed/errors contract — a skipped row
            // must never look like a successful one (a silent skip here is the same class of
            // lie the whole claim exists to kill).
            const errors = fencedIds.length > 0
                ? [
                    `${fencedIds.length} task(s) skipped: held by a live claim. ` +
                    `Acquire the claim (task claim) or pass force:true to override. Ids: ${fencedIds.join(', ')}`
                  ]
                : [];

            return {
                totalRequested: taskIds.length,
                successfullyUpdated: updatedTaskIds.length,
                failed: taskIds.length - updatedTaskIds.length,
                updatedTaskIds,
                errors
            };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get task progress summary with grouping options
     * @param projectId Project to analyze
     * @param groupBy Grouping option: 'phase', 'status', 'priority', 'type', 'assignedTo'
     * @returns Progress summary with counts and percentages
     */
    async getTaskProgressSummary(
        projectId: string,
        groupBy: 'phase' | 'status' | 'priority' | 'type' | 'assignedTo' = 'phase',
        includeArchived: boolean = false
    ): Promise<{
        totalTasks: number;
        groupedProgress: Array<{
            group: string;
            totalTasks: number;
            completedTasks: number;
            completionPercentage: number;
            pendingTasks: number;
            inProgressTasks: number;
            blockedTasks: number;
        }>;
        overallProgress: {
            completed: number;
            total: number;
            percentage: number;
        };
    }> {
        const client = await this.pool.connect();
        try {
            let groupColumn: string;

            switch (groupBy) {
                case 'phase':
                    // THE SECOND PHASE READ PATH, FIXED WITH THE FIRST.
                    // `tag LIKE 'phase-%'` is task_list's bug one surface over: it saw the
                    // dash spelling only, so a task tagged `phase:5` or `phase5` was absent
                    // from the summary that is supposed to account for it. MEASURED on prod,
                    // project riverbend, live tasks: 120 seen, 43 with a phase tag and no
                    // `phase-` spelling at all — a quarter of the population missing from a
                    // progress report, silently.
                    //   WITH s AS (SELECT tk.id, tk.tags FROM tasks tk JOIN projects pr
                    //              ON pr.id=tk.project_id WHERE pr.name='riverbend'
                    //              AND tk.archived_at IS NULL)
                    //   SELECT count(*) FROM s WHERE EXISTS (SELECT 1 FROM unnest(tags) g
                    //          WHERE lower(g) ~ '^phase[-_:. ]?[a-z0-9]')
                    //     AND NOT EXISTS (SELECT 1 FROM unnest(tags) g WHERE g LIKE 'phase-%');
                    //
                    // The key is CANONICALISED rather than taken raw, so the spellings of one
                    // phase form ONE group instead of three side by side — and so the ORDER BY
                    // below, which matches `^phase-[0-9]+$`, sorts them numerically as it was
                    // always meant to instead of dumping `phase3` into its ELSE 999 bucket.
                    // ORDER BY tag makes the pick deterministic for a task carrying two
                    // spellings; the previous bare LIMIT 1 took whatever the array yielded.
                    groupColumn = `(
                        SELECT ${phaseTagCanonicalSql('tag')}
                        FROM unnest(tags) as tag
                        WHERE ${phaseTagRecognizerSql('tag')}
                        ORDER BY tag
                        LIMIT 1
                    )`;
                    break;
                case 'status':
                    groupColumn = 'status';
                    break;
                case 'priority':
                    groupColumn = 'priority';
                    break;
                case 'type':
                    groupColumn = 'type';
                    break;
                case 'assignedTo':
                    groupColumn = 'COALESCE(assigned_to, \'unassigned\')';
                    break;
                default:
                    groupColumn = 'status';
            }

            // RECONCILE WITH task_list: task_list excludes archived tasks
            // by DEFAULT, but this summary used to count them — so the board counts (e.g.
            // "todo" in the summary vs a status-filtered task_list) DISAGREED by exactly the
            // archived rows. Apply the SAME archived filter here (default exclude;
            // includeArchived:true to count them), so the two tools always reconcile.
            const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';

            // Get grouped progress summary
            const progressQuery = `
                WITH task_groups AS (
                    SELECT
                        ${groupColumn} as group_name,
                        COUNT(*) as total_tasks,
                        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
                        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as pending_tasks,
                        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_tasks,
                        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked_tasks
                    FROM tasks
                    WHERE project_id = $1${archivedFilter}
                        AND ${groupColumn} IS NOT NULL
                    GROUP BY ${groupColumn}
                ),
                overall_stats AS (
                    SELECT
                        COUNT(*) as total_tasks,
                        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks
                    FROM tasks
                    WHERE project_id = $1${archivedFilter}
                )
                SELECT
                    tg.group_name,
                    tg.total_tasks,
                    tg.completed_tasks,
                    ROUND((tg.completed_tasks::numeric / tg.total_tasks::numeric) * 100, 1) as completion_percentage,
                    tg.pending_tasks,
                    tg.in_progress_tasks,
                    tg.blocked_tasks,
                    os.total_tasks as overall_total,
                    os.completed_tasks as overall_completed,
                    ROUND((os.completed_tasks::numeric / os.total_tasks::numeric) * 100, 1) as overall_percentage
                FROM task_groups tg
                CROSS JOIN overall_stats os
                ORDER BY
                    CASE
                        WHEN tg.group_name ~ '^phase-[0-9]+$' THEN
                            CAST(regexp_replace(tg.group_name, 'phase-', '') AS INTEGER)
                        WHEN tg.group_name ~ '^phase-[0-9]+[a-zA-Z]+' THEN
                            CAST(regexp_replace(regexp_replace(tg.group_name, 'phase-', ''), '[a-zA-Z].*', '') AS INTEGER) + 0.5
                        ELSE 999
                    END,
                    tg.group_name
            `;

            const result = await client.query(progressQuery, [projectId]);

            // Get overall totals if no grouped results
            if (result.rows.length === 0) {
                const overallQuery = `
                    SELECT
                        COUNT(*) as total_tasks,
                        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks
                    FROM tasks
                    WHERE project_id = $1${archivedFilter}
                `;
                const overallResult = await client.query(overallQuery, [projectId]);
                const overall = overallResult.rows[0];

                return {
                    totalTasks: parseInt(overall.total_tasks) || 0,
                    groupedProgress: [],
                    overallProgress: {
                        completed: parseInt(overall.completed_tasks) || 0,
                        total: parseInt(overall.total_tasks) || 0,
                        percentage: overall.total_tasks > 0
                            ? Math.round((parseInt(overall.completed_tasks) / parseInt(overall.total_tasks)) * 100)
                            : 0
                    }
                };
            }

            const firstRow = result.rows[0];
            const overallTotal = parseInt(firstRow.overall_total) || 0;
            const overallCompleted = parseInt(firstRow.overall_completed) || 0;
            const overallPercentage = overallTotal > 0 ? Math.round((overallCompleted / overallTotal) * 100) : 0;

            return {
                totalTasks: overallTotal,
                groupedProgress: result.rows.map(row => ({
                    group: row.group_name || 'ungrouped',
                    totalTasks: parseInt(row.total_tasks) || 0,
                    completedTasks: parseInt(row.completed_tasks) || 0,
                    completionPercentage: parseFloat(row.completion_percentage) || 0,
                    pendingTasks: parseInt(row.pending_tasks) || 0,
                    inProgressTasks: parseInt(row.in_progress_tasks) || 0,
                    blockedTasks: parseInt(row.blocked_tasks) || 0
                })),
                overallProgress: {
                    completed: overallCompleted,
                    total: overallTotal,
                    percentage: overallPercentage
                }
            };

        } finally {
            client.release();
        }
    }

    /**
     * SOFT-DELETE / ARCHIVE a task. Sets archived_at = now(), SCOPED to
     * `projectId` (cannot archive another project's task). REVERSIBLE — the row is NOT
     * hard-deleted; it stays in the table and disappears only from the DEFAULT task_list
     * (which filters archived_at IS NULL). Idempotent. Distinct from the `cancelled`
     * STATUS, which is a lifecycle state the task keeps while still listed. `taskId` is a
     * full UUID (short-id resolution happens in the route before this is called).
     */
    /**
     * ONE task by id, project-scoped, ARCHIVED ROWS INCLUDED. The read the
     * mutation echoes (task_update / task_delete / task_restore / cancel_task) use to return
     * the whole record through the shared serializer instead of a hand-written receipt. It
     * deliberately does not filter `archived_at`: the caller already holds the id, and a
     * delete echo that could not read the row it just archived would be exactly the write-
     * only field this task exists to remove. Full `SELECT *`, so every absent-when-absent
     * key mapTask knows about is present here.
     */
    async getTaskById(taskId: string, projectId: string): Promise<Task | null> {
        const result = await this.pool.query(
            `SELECT * FROM tasks WHERE id = $1 AND project_id = $2`,
            [taskId, projectId]
        );
        return result.rows.length === 0 ? null : this.mapTask(result.rows[0]);
    }

    async archiveTask(taskId: string, projectId: string, force?: boolean): Promise<TaskArchiveResult> {
        // ── CLAIM AWARENESS (SPEC §6.8) ───────────────────────────────
        // Archiving checked ONLY `archived_at IS NULL`, so it happily archived a task another
        // worker was actively holding — leaving the holder with a task that has silently left
        // the board. REFUSE by default (with `claimHeld` as a distinct typed outcome, so the
        // route can say WHY rather than reporting a bare "already archived"); `force: true` is
        // the audited human override, same machinery as the §6.5 escape hatch.
        const fencing = TASK_CLAIM_CONFIG.enabled && !force;
        const preImage = TASK_CLAIM_CONFIG.enabled && force ? await taskClaimService.probe(taskId) : null;
        const updated = await this.pool.query(
            `UPDATE tasks SET archived_at = now()
             WHERE id = $1 AND project_id = $2 AND archived_at IS NULL${
                 fencing ? ' AND (claim_id IS NULL OR claim_expires_at <= now())' : ''
             }
             RETURNING id::text AS id, archived_at`,
            [taskId, projectId]
        );
        if (updated.rows.length === 1) {
            if (preImage) {
                await taskClaimService.recordForceOverride(taskId, 'task_delete', undefined, preImage);
            }
            return { found: true, alreadyArchived: false, id: updated.rows[0].id, archivedAt: updated.rows[0].archived_at };
        }
        const probe = await this.pool.query(
            `SELECT id::text AS id, archived_at, claim_actor, claim_expires_at,
                    (claim_id IS NOT NULL AND claim_expires_at > now()) AS claim_live
               FROM tasks WHERE id = $1 AND project_id = $2`,
            [taskId, projectId]
        );
        if (probe.rows.length === 0) return { found: false };
        const row = probe.rows[0];
        // Distinguish "the fence refused it" from "it was already archived" — reporting the
        // former as the latter would be a phantom success in a different costume.
        if (fencing && row.claim_live && !row.archived_at) {
            await taskClaimService.fenceRejection(taskId, undefined, undefined, 'task_delete');
            return {
                found: true,
                alreadyArchived: false,
                claimHeld: true,
                claimActor: row.claim_actor,
                claimExpiresAt: row.claim_expires_at,
                id: row.id,
                archivedAt: null,
            };
        }
        return { found: true, alreadyArchived: true, id: row.id, archivedAt: row.archived_at };
    }

    /**
     * RESTORE (un-archive) a task. Clears archived_at back to NULL,
     * project-scoped. Idempotent. Mirror of archiveTask.
     */
    async restoreTask(taskId: string, projectId: string): Promise<TaskArchiveResult> {
        // CLAIM AWARENESS (SPEC §6.8): a task coming back from the archive
        // must not carry a STALE claim with it — whoever held it moved on long ago, and a
        // resurrected lease would fence the very people restoring the task. Clear it.
        const clearStaleClaim = TASK_CLAIM_CONFIG.enabled
            ? ', claim_id = NULL, claim_actor = NULL, claim_expires_at = NULL'
            : '';
        const updated = await this.pool.query(
            `UPDATE tasks SET archived_at = NULL${clearStaleClaim}
             WHERE id = $1 AND project_id = $2 AND archived_at IS NOT NULL
             RETURNING id::text AS id`,
            [taskId, projectId]
        );
        if (updated.rows.length === 1) {
            return { found: true, alreadyArchived: false, id: updated.rows[0].id, archivedAt: null };
        }
        const probe = await this.pool.query(
            `SELECT id::text AS id FROM tasks WHERE id = $1 AND project_id = $2`,
            [taskId, projectId]
        );
        if (probe.rows.length === 0) return { found: false };
        return { found: true, alreadyArchived: true, id: probe.rows[0].id, archivedAt: null };
    }

    private mapTask(row: any): Task {
        return {
            id: row.id,
            projectId: row.project_id,
            sessionId: row.session_id,  // TS005-1: Include session_id in mapped task
            title: row.title,
            description: row.description,
            type: row.type,
            status: row.status,
            // migration 101 / the Punch List lane, source of truth over
            // `status`. Present whenever the row was SELECTed with `*` (every existing task
            // read already is); null on a cancelled task or a legacy row nothing has touched.
            stage: row.stage ?? null,
            priority: row.priority,
            dependencies: row.dependencies || [],
            tags: row.tags || [],
            metadata: row.metadata || {},
            assignedTo: row.assigned_to,
            createdBy: row.created_by,
            progress: row.progress || 0,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            // P5.5: ABSENT-WHEN-ABSENT. `in row` and not `?? null`, because a SELECT that
            // never named the column and a column whose value is NULL are different facts,
            // and only one of them is "nobody is blocking this task".
            ...('blocked_on' in row ? { blockedOn: row.blocked_on } : {}),
            ...('due_at' in row ? { dueAt: row.due_at } : {}),
            ...('archived_at' in row ? { archivedAt: row.archived_at } : {}),
            // 098 / WHEN THIS TASK LEFT THE BOARD, by either terminal door.
            // Same absent-when-absent rule and the same three facts: key ABSENT means this
            // deployment has no such column (pre-098), `null` means the task is still open,
            // a value means it closed. Collapsing the first two would make every task on an
            // un-migrated instance look permanently open.
            ...('closed_at' in row ? { closedAt: row.closed_at } : {}),
            // DECLARED BRANCH MEMBERSHIP, under the SAME absent-when-absent
            // rule and for the same reason: three different facts, three different values,
            // never collapsed.
            //   key ABSENT  — this SELECT did not join membership. Nobody measured.
            //   value null  — it DID join and this task is a member of no branch. A fact.
            //   an object   — the spine it was written on.
            // Collapsing the first two is the bug this field exists to fix, one layer up: a
            // consumer that reads a missing key as "no branch" is exactly the board that
            // called 14 declared members branchless.
            ...('membership_spine_id' in row
                ? {
                    branchMembership: row.membership_spine_id
                        ? {
                            spineId: row.membership_spine_id,
                            spineType: row.membership_spine_type,
                            source: row.membership_source,
                        }
                        : null,
                  }
                : {}),
            // ATOMIC TASK CLAIM: surface the claim state through the TOOL
            // contract, so "who holds this task?" is answerable without reaching past the
            // public surface into SQL ([[no-cheating-feel-the-pain]]). Undefined (not null)
            // when the column is absent from the projection, so partial SELECTs stay honest.
            //
            // THE TOKEN IS WITHHELD HERE, AND THIS IS THE CHOKE POINT THAT ENFORCES IT.
            // `row.claim_id` is read (a plain `SELECT *` returns it) and deliberately NOT
            // mapped: mapTask is the single function every task READ surface — task_details,
            // task_list, create/update responses, the Command UI — renders through, so one
            // omission here withholds the token from ALL of them instead of N per-surface
            // redactions free to drift. A published fencing token is a bearer
            // capability, not a fence. "Who holds it / until when / is it live" is enough to
            // reason about a claim; only the winner needs the key.
            version: row.version,
            claimActor: row.claim_actor,
            claimExpiresAt: row.claim_expires_at,
            claimLive: row.claim_expires_at === undefined && row.claim_id === undefined
                ? undefined // the projection carried no claim columns — stay honest, don't assert "not live"
                : Boolean(row.claim_id && row.claim_expires_at && new Date(row.claim_expires_at).getTime() > Date.now())
        };
    }
}

/** Result of a task soft-delete archive/restore. */
export interface TaskArchiveResult {
    found: boolean;
    alreadyArchived?: boolean;
    id?: string;
    archivedAt?: string | Date | null;
    /** ATOMIC TASK CLAIM (SPEC §6.8): the archive was REFUSED — a live claim holds this task. */
    claimHeld?: boolean;
    /** Who holds it (attribution only). */
    claimActor?: string | null;
    /** When that claim expires. */
    claimExpiresAt?: string | Date | null;
}

export const tasksHandler = new TasksHandler();
