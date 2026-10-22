/**
 * SessionRepo - Database operations for sessions table
 */

import { db } from '../../../../config/database.js';
import { logger } from '../../../../utils/logger.js';
import type { SessionData } from '../../types.js';
import type { SessionCreationReason } from '../../../../config/sessionIdentityConfig.js';
import { SESSION_OPEN_STATES } from '../../../../config/sessionIdentityConfig.js';
import type { SessionIdentityRow } from '../../domain/identity/sessionIdentity.js';

export interface CreateSessionParams {
  sessionId: string;
  projectId: string | null;
  sessionType: string;
  startTime: Date;
  /**
   * Amp-orb eval W3: WHY this session row is being created. REQUIRED, and
   * required ON PURPOSE — this repo is the CHOKE POINT every session INSERT passes through,
   * so making it a required field means a new create path physically cannot forget to declare
   * its reason. It is the compiler, not a convention, that keeps the column honest.
   *
   * The alternative (an optional field with a default) would let a future path silently record
   * a plausible-but-wrong reason, which is exactly the class of silence this field exists to
   * remove. Callers pass a value from SESSION_CREATION_REASONS; the DB CHECK (migration 068)
   * rejects anything else.
   */
  creationReason: SessionCreationReason;
  title?: string | null;
  description?: string | null;
  sessionGoal?: string | null;
  tags?: string[];
  aiModel?: string | null;
  activeBranch?: string | null;
  workingCommitSha?: string | null;
  metadata?: Record<string, any>;
  /**
   * SR-1: the stable per-connection identity (X-Connection-ID). Persisted so a
   * server restart re-attaches to the open session for this connection instead of
   * minting a new one. NULL/undefined = a session that never re-attaches (safe).
   */
  connectionId?: string | null;
  /**
   * Sessions Foundation Phase 1: the stable principal that OWNS this session
   * (operator, coordinator, builder-<id8>, tick, deploy-smoke, anonymous…). ADDITIVE — stamped
   * on creation for attribution/coverage but NOT yet part of resolution (connection_id
   * remains the key until Phase 2). The caller derives it at the edge via `deriveActor`, whose
   * combining rule is flag-gated: by default the auth `sub` overrides the
   * declared X-Actor-ID; with composites enabled the `sub` SCOPES it, so this column may hold a
   * `<principal>/<handle>` composite containing the `/` delimiter. NULL/undefined = column left
   * NULL (legacy paths).
   */
  actor?: string | null;
  /**
   * Sessions Foundation Phase 2b: TELEMETRY — the physical connection id that minted this
   * row on the actor-mode create path. In actor mode `connection_id` is written NULL (so the
   * connection-scoped partial unique index can't conflict when two actors share one
   * connection); this preserves "which connection created it" for debugging. Written ONLY by
   * createForActorLocked; NOT identity, never read for behavior. Migration 064.
   */
  createdViaConnection?: string | null;
}

/**
 * The AUTHORITATIVE, post-increment counts for a session, read back from the database
 * (child tables for the recomputable ones, the `total_tokens` column for tokens, which
 * has no child table and is therefore not recomputable — see `getFinalCounts`).
 *
 * `finish()` takes these only to render the human-readable `context_summary` and the
 * `metadata` audit blob. It does NOT write them to the counter columns — see the big
 * comment on `finish()`.
 */
export interface FinalSessionCounts {
  contexts_created: number;
  decisions_created: number;
  tasks_created: number;
  tasks_updated: number;
  tasks_completed: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/**
 * A counter DELTA — never a total. Every field is REQUIRED so a caller that adds a new
 * counter half cannot silently omit it (the compiler is the guard, not a convention);
 * a caller that owns only one half zero-fills the other, in writing, at the call site.
 * Consumed by `SessionRepo.applyCounterDelta`, the one statement that writes these columns.
 */
export interface SessionCounterDelta {
  tasks_created: number;
  tasks_updated: number;
  tasks_completed: number;
  contexts_created: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface EndSessionParams {
  sessionId: string;
  endTime: Date;
  durationMs: number;
  /**
   * Authoritative post-increment counts, for the summary/metadata TEXT only.
   * NOTE: deliberately NOT named `activityCounts`/`tokenUsage` any more — those names
   * carried in-memory DELTAS, and `finish()` used to SET the counter columns to them,
   * which is exactly the bug this type rename exists to make un-reintroducible.
   */
  finalCounts: FinalSessionCounts;
  operationsCount: number;
  productivityScore: number;
}

export const SessionRepo = {
  /**
   * Create a new session record
   */
  async create(params: CreateSessionParams): Promise<{ id: string; started_at: Date } | null> {
    try {
      const sql = `
        INSERT INTO sessions (
          id, project_id, agent_type, started_at, last_activity_at, title, description,
          session_goal, tags, ai_model, active_branch, working_commit_sha, metadata,
          connection_id, actor, creation_reason
        ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id, started_at
      `;

      const result = await db.query(sql, [
        params.sessionId,
        params.projectId,
        params.sessionType,
        params.startTime,
        params.title || null,
        params.description || null,
        params.sessionGoal || null,
        params.tags || [],
        params.aiModel || null,
        params.activeBranch || null,
        params.workingCommitSha || null,
        JSON.stringify(params.metadata || {}),
        params.connectionId || null,
        // Phase 1: stamp the resolved actor (already normalized/anonymous-defaulted by the
        // lifecycle service). Additive — never affects resolution in this phase.
        params.actor || null,
        // W3: WHY this row exists. Not defaulted here — the caller declared it
        // (required param), and the DB CHECK rejects anything outside the vocabulary.
        params.creationReason
      ]);

      return result.rows[0] || null;

    } catch (error) {
      logger.error('Failed to create session', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'create',
        metadata: { sessionId: params.sessionId }
      });
      throw error;
    }
  },

  /**
   * an earlier Task — advisory-locked get-or-create for the CONNECTION-KEYED create.
   *
   * THE RACE THIS CLOSES (measured, not theorised — 25/50 rounds at concurrency 5 on an
   * idle box; see the task record). `ensureActiveSession` is a check-then-insert:
   *
   *     getActiveSession(conn)   // RAM miss → findReattachable → null
   *     startSession(..., conn)  // unconditional INSERT
   *
   * N concurrent first-actions on one connection ALL read null, then ALL insert. Exactly one
   * wins; `uq_sessions_open_per_connection` correctly refuses the other N-1, which surfaced as
   * a raw `duplicate key value violates unique constraint` thrown at the caller. The index was
   * never wrong — it is the only thing preventing duplicate open sessions per connection, and
   * it was doing its job. The application was losing the race and had nowhere to go.
   *
   * The guarantee is "exactly one OPEN session per connection", so the loser of the race must
   * end up READING THE WINNER'S ROW — not erroring, and not creating a second. This method is
   * that resolution, and it is deliberately the same shape as `createForActorLocked` above:
   *
   *   1. BEGIN on a dedicated client + a per-CONNECTION transaction advisory lock
   *      (`pg_advisory_xact_lock(hashtext('session-create:conn:'||connectionId)::bigint)`),
   *      auto-released at COMMIT/ROLLBACK. Distinct connections hash to distinct keys, so
   *      unrelated connections never contend. (A hash collision with the actor-mode key space
   *      would only cost needless serialization, never correctness — both sides re-check under
   *      the lock.)
   *   2. DOUBLE-CHECK UNDER THE LOCK using **the partial index's OWN predicate** — every OPEN
   *      row for this connection (`ended_at IS NULL AND status = ANY(SESSION_OPEN_STATES)`),
   *      NOT `findReattachable`'s. That distinction is load-bearing: findReattachable is
   *      STRICTLY NARROWER (it additionally requires activity inside the re-attach window), so
   *      an open-but-stale row is invisible to it while still being forbidden by the index —
   *      double-checking with the narrow predicate would leave the exact same exception
   *      reachable, just more rarely. The adopt set must equal the set the index refuses.
   *   3. On a hit → adopt it (`created:false`, no INSERT). Otherwise INSERT and COMMIT.
   *
   * THIS METHOD's statuses come from SESSION_OPEN_STATES as a bind parameter rather than being
   * inlined, so THIS predicate adds no new hand-written copy of the openness rule. It declines
   * to add another — deliberately NOT "a fourth", because the count is the thing that keeps
   * getting stated too small (the first version of this very comment said three).
   *
   * THE INLINE COPIES IN THIS FILE, ENUMERATED — grep is `'active', 'interrupted', 'dormant'`,
   * and as of this writing it is the ONLY spelling used here, so this list is exhaustive for
   * this file rather than illustrative:
   *     createForActorLocked · existsActive · findReattachable · newestOpenForActor
   *     · listIdentityRows (the `openOnly` filter)
   * FIVE. Outside this file the same rule is also written in SESSION_OPEN_STATES itself and in
   * migration 065 — twice as index predicates (including uq_sessions_open_per_connection) and
   * once inside a sweep function. Converting the five is out of scope here; this doc is the
   * scoping document for that follow-up, so it names them rather than counting them.
   *
   * ⚠️ AND THE GUARD DOES NOT COVER THEM. `sessionCreateRace.contract.test.ts` reads the LIVE
   * `pg_indexes` definition of uq_sessions_open_per_connection and asserts it names the same
   * status set as SESSION_OPEN_STATES — so a one-sided edit to EITHER OF THOSE TWO goes RED
   *. That pairing is all it proves. Widen the constant and the index together and
   * all five inline literals silently disagree with both while the suite stays green. Anyone
   * changing the openness rule must hand-edit the five above; nothing will tell them.
   *
   * NOT a retry: there is no duplicate-key catch anywhere in this path. The lock makes the
   * outcome deterministic, so no caller ever observes the constraint violation. Fails LOUD on
   * anything else, exactly like the create path it replaces.
   *
   * @returns { sessionId, created } — `created:false` when the double-check adopted an existing
   *          open session for this connection (the INSERT was skipped), `true` when this call
   *          inserted the row. `sessionId` is the WINNER's id, which on an adopt is NOT the
   *          `params.sessionId` the caller minted.
   */
  async createForConnectionLocked(
    params: CreateSessionParams & { connectionId: string }
  ): Promise<{ sessionId: string; created: boolean }> {
    if (!params.connectionId) {
      throw new Error(
        'createForConnectionLocked requires a non-empty connectionId (the header-less/NULL path must use create())'
      );
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Per-connection transaction advisory lock. hashtext() → int4; cast to bigint for the
      // single-arg pg_advisory_xact_lock(bigint). Serializes creates for THIS connection only.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
        `session-create:conn:${params.connectionId}`,
      ]);

      // Double-check UNDER the lock, with the INDEX's predicate (see step 2 in the doc above).
      // Must run on THIS txn client so it sees a sibling's committed row / blocks on the lock
      // against a sibling's in-flight one.
      const existing = await client.query(
        `SELECT id
           FROM sessions
          WHERE connection_id = $1
            AND ended_at IS NULL
            AND status::text = ANY($2::text[])
          ORDER BY COALESCE(last_activity_at, started_at) DESC
          LIMIT 1`,
        [params.connectionId, SESSION_OPEN_STATES as readonly string[]]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { sessionId: existing.rows[0].id, created: false };
      }

      await client.query(
        `INSERT INTO sessions (
           id, project_id, agent_type, started_at, last_activity_at, title, description,
           session_goal, tags, ai_model, active_branch, working_commit_sha, metadata,
           connection_id, actor, creation_reason
         ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          params.sessionId,
          params.projectId,
          params.sessionType,
          params.startTime,
          params.title || null,
          params.description || null,
          params.sessionGoal || null,
          params.tags || [],
          params.aiModel || null,
          params.activeBranch || null,
          params.workingCommitSha || null,
          JSON.stringify(params.metadata || {}),
          params.connectionId,
          params.actor || null,
          // W3: WHY this row exists — declared by the caller, CHECK-gated.
          params.creationReason,
        ]
      );
      await client.query('COMMIT');
      return { sessionId: params.sessionId, created: true };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback error — surface the original below */
      }
      logger.error(
        'Failed advisory-locked connection session create',
        error instanceof Error ? error : new Error('Unknown error'),
        {
          component: 'SessionRepo',
          operation: 'createForConnectionLocked',
          metadata: { sessionId: params.sessionId, connectionId: params.connectionId },
        }
      );
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Phase 2b (the auditor fix B) — advisory-locked get-or-create for the ACTOR-MODE lazy-create.
   *
   * The resolver signalled lazy-create for `params.actor` (nothing pinned/open resolved). Two
   * concurrent actions for the SAME actor (e.g. a burst of writes) would otherwise each INSERT
   * a fresh session → duplicate sessions for one actor. This serializes the create per actor:
   *
   *   1. BEGIN a transaction on a dedicated client and take a per-actor TRANSACTION advisory
   *      lock (`pg_advisory_xact_lock(hashtext('session-create:'||actor)::bigint)`) — auto-
   *      released at COMMIT/ROLLBACK. Different actors hash to different keys → no contention
   *      between distinct actors (so two DIFFERENT actors on one connection proceed in
   *      parallel and each get their own row).
   *   2. DOUBLE-CHECK newestOpenForActor UNDER THE LOCK (the same predicate as
   *      SessionRepo.newestOpenForActor — actor-scoped, automation ⇒ same-UTC-day). If a
   *      concurrent create already won, adopt its row (`created:false`) — no second INSERT.
   *   3. Otherwise INSERT with `actor` set and **`connection_id = NULL`** (the key move:
   *      uq_sessions_open_per_connection is `WHERE connection_id IS NOT NULL`, so NULL never
   *      conflicts even when two actors share one physical connection) and stash the creating
   *      connection in `created_via_connection` telemetry (migration 064).
   *
   * Fails LOUD: throws on error (the caller's action-gate wrapper degrades to session-less,
   * exactly like the legacy create path, but the txn itself must not silently half-commit).
   *
   * @returns { sessionId, created } — `created:false` when the double-check adopted an existing
   *          session (the INSERT was skipped), `true` when this call inserted the row.
   */
  async createForActorLocked(
    params: CreateSessionParams & { sameUtcDayOnly: boolean }
  ): Promise<{ sessionId: string; created: boolean }> {
    if (!params.actor) {
      throw new Error('createForActorLocked requires a non-empty actor (normalize/anonymize first)');
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Per-actor transaction advisory lock. hashtext() → int4; cast to bigint for the
      // single-arg pg_advisory_xact_lock(bigint). Serializes creates for THIS actor only.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
        `session-create:${params.actor}`,
      ]);

      // Double-check UNDER the lock — same openness + automation-day predicate as
      // newestOpenForActor (kept in lockstep with that method by design; it must run on THIS
      // txn client to see a sibling's committed row / hold against a sibling's in-flight one).
      const existing = await client.query(
        `SELECT id
           FROM sessions
          WHERE actor = $1
            AND ended_at IS NULL
            AND status::text IN ('active', 'interrupted', 'dormant')
            AND ($2::boolean = false
                 OR started_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
          ORDER BY COALESCE(last_activity_at, started_at) DESC
          LIMIT 1`,
        [params.actor, params.sameUtcDayOnly]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { sessionId: existing.rows[0].id, created: false };
      }

      // No open session for this actor — INSERT. connection_id is FORCED NULL here (never a
      // placeholder — a non-null value would re-enter the connection-scoped unique index); the
      // minting connection is preserved as created_via_connection telemetry only.
      await client.query(
        `INSERT INTO sessions (
           id, project_id, agent_type, started_at, last_activity_at, title, description,
           session_goal, tags, ai_model, active_branch, working_commit_sha, metadata,
           connection_id, actor, created_via_connection, creation_reason
         ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $13, $14, $15)`,
        [
          params.sessionId,
          params.projectId,
          params.sessionType,
          params.startTime,
          params.title || null,
          params.description || null,
          params.sessionGoal || null,
          params.tags || [],
          params.aiModel || null,
          params.activeBranch || null,
          params.workingCommitSha || null,
          JSON.stringify(params.metadata || {}),
          params.actor,
          params.createdViaConnection || null,
          // W3: WHY this row exists — declared by the caller, CHECK-gated.
          params.creationReason,
        ]
      );
      await client.query('COMMIT');
      return { sessionId: params.sessionId, created: true };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback error — surface the original below */
      }
      logger.error(
        'Failed advisory-locked actor session create',
        error instanceof Error ? error : new Error('Unknown error'),
        {
          component: 'SessionRepo',
          operation: 'createForActorLocked',
          metadata: { sessionId: params.sessionId, actor: params.actor },
        }
      );
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Finalize a session: TERMINALIZE ONLY. No counter arithmetic. Ever.
   *
   * ── WHY THERE ARE NO COUNTER COLUMNS IN THIS UPDATE ──────────────
   * This statement used to do an ABSOLUTE `SET total_tokens=$, tasks_created=$,
   * contexts_created=$ …` from the values `SessionLifecycleService.endSession` read out
   * of `OperationTracker.getActivityCounts` / `TokenTracker.get`.
   *
   * Those in-memory values are a DELTA — "activity since the last flush" — not a total.
   * The 30 s flush (`MANDREL_SESSION_FLUSH_SEC`) accumulates the delta into the columns
   * with `col = COALESCE(col,0) + delta` and then EMPTIES the map. So any session that
   * lived longer than one flush interval arrived here with an empty map, and this
   * absolute SET overwrote the accumulated truth with zeros. Measured on prod: 79 of
   * 114 `ended` sessions had `contexts_created = 0` while their contexts still existed.
   * Sessions ended seconds after activity were not spared — they got a PARTIAL count
   * (whatever happened to be un-flushed), which is an undercount, not a zero. Every
   * finalize was wrong; the closer's zero was only the limiting case.
   *
   * The fix is NOT to make this SET defensive (COALESCE / GREATEST). That is a category
   * error: `GREATEST(existing_total, unflushed_delta)` compares a total against a delta
   * and silently DISCARDS legitimate tail activity (column 50000, delta 200 → keeps
   * 50000, loses 200).
   *
   * The fix is ONE WRITE PATH. `endSession` now CONSUMES the delta (get-and-delete,
   * synchronously, before its first await) and pushes it through the same
   * `applyActivityCounts` / `addTokens` choke point the flush already uses. By the time
   * we get here the columns are already correct, and this statement must not touch them.
   * That also makes re-finalize and resume safe for free: a second `finish()` adds a
   * consumed (empty) delta = +0, where the old code re-zeroed the row.
   *
   * `finalCounts` below is read back FROM the database after those increments and is
   * used only to render human-readable summary/metadata text. If you ever find yourself
   * adding a counter column back into this SET list, you are re-opening this bug —
   * `mcp-server/src/tests/sessionCountersSurviveFinalize.contract.test.ts` will fail, and
   * it is right. (That is the REAL file name. This comment previously named
   * `SessionRepo.finish.no-counter-columns.test.ts`, which has never existed — a
   * maintainer who greps it finds nothing and concludes the guard was deleted.)
   *
   * A2 fix (Phase 0, the auditor review): the clean end path MUST terminalize `status`,
   * not just stamp `ended_at`. Before this, cleanly-ended sessions stayed
   * status='active' with ended_at set — a lying column (62 such rows in prod). We
   * set status='ended' (a distinct terminal value from the reaper's 'inactive', so
   * clean-end vs idle-reap stay distinguishable). Migration 061 adds 'ended' to
   * sessions_status_check and reconciles the historical rows.
   */
  async finish(params: EndSessionParams): Promise<boolean> {
    try {
      const sql = `
        UPDATE sessions
        SET status = 'ended',
            ended_at = $1,
            context_summary = $2,
            metadata = metadata || $3::jsonb
        WHERE id = $4
      `;

      const c = params.finalCounts;
      const contextSummary = `Session completed with ${c.tasks_created} tasks and ${c.contexts_created} contexts`;

      await db.query(sql, [
        params.endTime,
        contextSummary,
        JSON.stringify({
          end_time: params.endTime.toISOString(),
          duration_ms: params.durationMs,
          contexts_created: c.contexts_created,
          decisions_created: c.decisions_created,
          tasks_created: c.tasks_created,
          tasks_updated: c.tasks_updated,
          tasks_completed: c.tasks_completed,
          operations_count: params.operationsCount,
          productivity_score: params.productivityScore,
          input_tokens: c.input_tokens,
          output_tokens: c.output_tokens,
          total_tokens: c.total_tokens,
          completed_by: 'aidis-session-tracker'
        }),
        params.sessionId
      ]);

      return true;

    } catch (error) {
      logger.error('Failed to finish session', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'finish',
        metadata: { sessionId: params.sessionId }
      });
      throw error;
    }
  },

  /**
   * Update productivity score
   */
  async updateProductivityScore(sessionId: string, score: number): Promise<void> {
    await db.query('UPDATE sessions SET productivity_score = $1 WHERE id = $2', [score, sessionId]);
  },

  /**
   * Check whether a session row actually exists in the database.
   *
   * Used to validate an in-memory active-session id against the source of truth
   * before any caller trusts it for a FK-bearing write (e.g. contexts.session_id).
   * Returns false (never throws) on a DB error so callers can fail safe — the
   * worst case is we treat a session as missing and re-create/clear it.
   */
  async exists(sessionId: string): Promise<boolean> {
    try {
      const result = await db.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);
      return result.rows.length > 0;
    } catch (error) {
      logger.error('Failed to check session existence', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'exists',
        metadata: { sessionId }
      });
      return false;
    }
  },

  /**
   * SR-1: Check whether a session row exists AND is still OPEN (re-attachable).
   *
   * Unlike exists() (true even for an ended/terminalized row), this returns true
   * only for a session that is still alive — status active|interrupted|dormant AND
   * ended_at NULL (Phase 3: 'dormant' is OPEN/resumable, so a dormant session's cached
   * id stays valid and a returning actor re-joins it). This is the source-of-truth
   * check getActiveSession uses to validate an
   * in-RAM cached id: a cached id whose row has since been reaped/ended is treated
   * as a MISS so the caller re-attaches or mints a real session, instead of writing
   * no-ops against a dead session (the "stale-but-ended" bug, ctx 81901e32). Fails
   * safe: returns false (never throws) on a DB error.
   */
  async existsActive(sessionId: string): Promise<boolean> {
    try {
      const result = await db.query(
        `SELECT 1 FROM sessions
         WHERE id = $1
           AND ended_at IS NULL
           AND status::text IN ('active', 'interrupted', 'dormant')`,
        [sessionId]
      );
      return result.rows.length > 0;
    } catch (error) {
      logger.error('Failed to check active session existence', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'existsActive',
        metadata: { sessionId }
      });
      return false;
    }
  },

  /**
   * SR-1: Find the newest OPEN session for a connection id within the re-attach
   * window — the core of the random-spawning fix.
   *
   * "Open" = ended_at NULL AND status active|interrupted|dormant (interrupted/dormant =
   * a session parked as resumable). "Within window" = last_activity_at (or
   * started_at if never touched) newer than now - windowSec. The newest such row is
   * the one to re-attach to instead of minting a new session. A NULL connectionId
   * NEVER matches (we require a real connection identity to re-attach) — so the
   * header-less/legacy NULL rows are safely non-re-attachable.
   *
   * @returns the session id to re-attach to, or null if none qualifies.
   */
  async findReattachable(connectionId: string, windowSec: number): Promise<string | null> {
    try {
      if (!connectionId) return null;
      const result = await db.query(
        `SELECT id
         FROM sessions
         WHERE connection_id = $1
           AND ended_at IS NULL
           AND status::text IN ('active', 'interrupted', 'dormant')
           AND COALESCE(last_activity_at, started_at) > (CURRENT_TIMESTAMP - ($2 || ' seconds')::interval)
         ORDER BY COALESCE(last_activity_at, started_at) DESC
         LIMIT 1`,
        [connectionId, String(windowSec)]
      );
      return result.rows[0]?.id || null;
    } catch (error) {
      logger.error('Failed to find reattachable session', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'findReattachable',
        metadata: { connectionId, windowSec }
      });
      return null;
    }
  },

  /**
   * SR-1: Re-activate an open session (status → active, refresh last_activity_at).
   *
   * Called when an action re-attaches to a session that was parked 'interrupted' by a
   * graceful shutdown, or 'dormant' by the Phase 3 dormanter / actor-mode shutdown (or to
   * keep an already-active one fresh). Only flips OPEN rows (ended_at NULL) so it can never
   * resurrect a terminalized session — the WHERE clause is status-agnostic among the open
   * states, so dormant→active and interrupted→active both work + refresh last_activity_at.
   * Returns true iff a row was updated.
   */
  async reactivate(sessionId: string): Promise<boolean> {
    try {
      const result = await db.query(
        `UPDATE sessions
         SET status = 'active', last_activity_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND ended_at IS NULL
         RETURNING id`,
        [sessionId]
      );
      return result.rows.length > 0;
    } catch (error) {
      logger.error('Failed to reactivate session', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'reactivate',
        metadata: { sessionId }
      });
      return false;
    }
  },

  /**
   * SR-1: Mark sessions 'interrupted' (resumable) — used by graceful shutdown.
   *
   * Only OPEN active sessions are affected (ended_at NULL AND status='active'); we
   * deliberately leave ended_at NULL so the session stays re-attachable within the
   * window (next action resumes it) and the reaper terminalizes it later if it never
   * resumes. Returns the connection ids of the rows it interrupted so the caller can
   * evict the matching in-RAM entries. Idempotent and safe on an empty set.
   */
  async markInterrupted(sessionIds?: string[]): Promise<string[]> {
    try {
      let result;
      if (sessionIds && sessionIds.length > 0) {
        result = await db.query(
          `UPDATE sessions
           SET status = 'interrupted'
           WHERE id = ANY($1::uuid[])
             AND ended_at IS NULL
             AND status::text = 'active'
           RETURNING id, connection_id`,
          [sessionIds]
        );
      } else {
        // No ids given → mark ALL currently-open active sessions interrupted
        // (graceful shutdown closes the whole fleet of live connections).
        result = await db.query(
          `UPDATE sessions
           SET status = 'interrupted'
           WHERE ended_at IS NULL
             AND status::text = 'active'
           RETURNING id, connection_id`
        );
      }
      return result.rows.map((r: any) => r.connection_id).filter((c: any): c is string => !!c);
    } catch (error) {
      logger.error('Failed to mark sessions interrupted', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'markInterrupted'
      });
      return [];
    }
  },

  /**
   * Phase 3 (actor mode): Mark sessions 'dormant' (resumable) — used by graceful shutdown in
   * ACTOR mode, where 'dormant' subsumes the legacy 'interrupted' park state (the auditor review
   * §4.2 "interrupted becomes redundant"). Only OPEN, still-live rows are affected
   * (ended_at NULL AND status active|interrupted — an already-interrupted legacy row is
   * folded to dormant too), and ended_at is deliberately left NULL so the session stays
   * re-attachable: the next action by the same actor re-joins it (dormant→active via
   * reactivate), and the closer terminalizes it later if it never resumes. Returns the
   * connection ids affected so the caller can evict matching in-RAM entries. Idempotent and
   * safe on an empty set. The LEGACY shutdown path keeps using markInterrupted (unchanged).
   */
  async markDormant(sessionIds?: string[]): Promise<string[]> {
    try {
      let result;
      if (sessionIds && sessionIds.length > 0) {
        result = await db.query(
          `UPDATE sessions
           SET status = 'dormant'
           WHERE id = ANY($1::uuid[])
             AND ended_at IS NULL
             AND status::text IN ('active', 'interrupted')
           RETURNING id, connection_id`,
          [sessionIds]
        );
      } else {
        result = await db.query(
          `UPDATE sessions
           SET status = 'dormant'
           WHERE ended_at IS NULL
             AND status::text IN ('active', 'interrupted')
           RETURNING id, connection_id`
        );
      }
      return result.rows.map((r: any) => r.connection_id).filter((c: any): c is string => !!c);
    } catch (error) {
      logger.error('Failed to mark sessions dormant', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'markDormant'
      });
      return [];
    }
  },

  /**
   * Phase 2a (resolveSession precedence step c): the newest OPEN session OWNED BY an actor.
   *
   * "Open" = ended_at NULL AND status active|interrupted|dormant (same openness predicate as
   * existsActive/findReattachable; Phase 3 'dormant' is resumable so a returning actor re-joins
   * it). Ordered by activity so the freshest wins. This is ACTOR-scoped (never connection,
   * never global) — the resolver's identity spine.
   *
   * `sameUtcDayOnly` (set for actors classified `automation`, e.g. tick/deploy-smoke):
   * additionally require the session to have STARTED on the current UTC calendar day, giving
   * a deterministic daily rollover with no timer (the auditor review §4.3). UTC is chosen and
   * documented so midnight-spanning is unambiguous:
   *   started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
   * i.e. the instant of today's 00:00 UTC. Both sides are timestamptz, so the comparison is
   * timezone-correct regardless of the server's local TZ.
   *
   * Fails safe: returns null (never throws) on a DB error.
   *
   * @param actor          the normalized principal that owns the session.
   * @param sameUtcDayOnly restrict to sessions started today (UTC) — for automation actors.
   * @returns the session id to resolve to, or null if the actor has no qualifying open session.
   */
  async newestOpenForActor(actor: string, sameUtcDayOnly: boolean): Promise<string | null> {
    try {
      if (!actor) return null;
      const result = await db.query(
        `SELECT id
         FROM sessions
         WHERE actor = $1
           AND ended_at IS NULL
           AND status::text IN ('active', 'interrupted', 'dormant')
           AND ($2::boolean = false
                OR started_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
         ORDER BY COALESCE(last_activity_at, started_at) DESC
         LIMIT 1`,
        [actor, sameUtcDayOnly]
      );
      return result.rows[0]?.id || null;
    } catch (error) {
      logger.error('Failed to find newest open session for actor', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'newestOpenForActor',
        metadata: { actor, sameUtcDayOnly },
      });
      return null;
    }
  },

  /**
   * Get the last active (non-ended) session
   */
  async getLastActive(): Promise<string | null> {
    try {
      const sql = `
        SELECT id
        FROM sessions
        WHERE ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      `;

      const result = await db.query(sql);
      return result.rows[0]?.id || null;

    } catch (error) {
      logger.error('Failed to get last active session', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'getLastActive'
      });
      return null;
    }
  },

  /**
   * Update last activity timestamp.
   *
   * `AND status = 'active'` IS DELIBERATE, and became load-bearing when the READ path
   * started calling this (an earlier task bug 2, services/session/activityTouch.ts): this
   * is now reached by ordinary reads, not only by content-producing writes, so what it
   * does to a NON-active session is a behaviour anyone can hit.
   *
   *   ended / inactive / disconnected → NO-OP. Advancing the timestamp on a closed
   *     session yields a row that reads "active a moment ago" while being closed, which
   *     is a worse liveness lie than the one bug 2 fixes.
   *   dormant / interrupted → NO-OP. These are resumable, and resuming them is
   *     `reactivate()`'s job: it flips status AND refreshes the timestamp under the
   *     resolver's re-attach-window policy. A bare timestamp bump here would bypass that
   *     policy and leave a dormant-but-fresh row no consumer knows how to read.
   *
   * So this can only make an ALREADY-LIVE session look live; it can never revive a
   * parked one. A no-op is silent by design (no row is an expected outcome, not an
   * error) — callers that need to know should query, not infer.
   */
  async touchActivity(sessionId: string): Promise<void> {
    try {
      await db.query(
        `UPDATE sessions SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'active'`,
        [sessionId]
      );
    } catch (error) {
      logger.error('Failed to update session activity', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'touchActivity',
        metadata: { sessionId }
      });
    }
  },

  /**
   * Update activity count and last activity
   */
  async updateActivityCount(sessionId: string): Promise<void> {
    try {
      const sql = `
        UPDATE sessions
        SET activity_count = (SELECT COUNT(*) FROM session_activities WHERE session_id = $1),
            last_activity_at = NOW()
        WHERE id = $1
      `;
      await db.query(sql, [sessionId]);
    } catch (error) {
      logger.error('Failed to update activity count', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'updateActivityCount',
        metadata: { sessionId }
      });
    }
  },

  /**
   * Update file aggregate metrics
   */
  async updateFileMetrics(sessionId: string): Promise<void> {
    try {
      const sql = `
        UPDATE sessions
        SET
          files_modified_count = (SELECT COUNT(DISTINCT file_path) FROM session_files WHERE session_id = $1),
          lines_added = (SELECT COALESCE(SUM(lines_added), 0) FROM session_files WHERE session_id = $1),
          lines_deleted = (SELECT COALESCE(SUM(lines_deleted), 0) FROM session_files WHERE session_id = $1),
          lines_net = (SELECT COALESCE(SUM(lines_added - lines_deleted), 0) FROM session_files WHERE session_id = $1)
        WHERE id = $1
      `;
      await db.query(sql, [sessionId]);
    } catch (error) {
      logger.error('Failed to update file metrics', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'updateFileMetrics',
        metadata: { sessionId }
      });
    }
  },

  /**
   * Get full session data
   */
  async getSessionData(sessionId: string): Promise<SessionData | null> {
    try {
      const sql = `
        SELECT
          s.id,
          s.project_id,
          s.started_at,
          s.ended_at,
          s.title,
          s.description,
          s.session_goal,
          s.tags,
          s.lines_added,
          s.lines_deleted,
          s.lines_net,
          s.productivity_score,
          s.ai_model,
          s.files_modified_count,
          s.activity_count,
          s.status,
          s.last_activity_at,
          s.input_tokens,
          s.output_tokens,
          s.total_tokens,
          s.tasks_updated,
          -- Counts DERIVED from the child tables, not the denormalized counter columns
          --. SessionStatsService.calculateProductivity /
          -- calculateProductivityScore call this repo method DIRECTLY (bypassing
          -- SessionTracker.getSessionData), so a caller-side fix would have missed them
          -- and every recomputed score would still have been built on a zeroed count.
          --
          -- SOFT-DELETE: archived rows are EXCLUDED, so "this session created
          -- N contexts" means the N you can still find. Measured on prod 2026-07-30 these were
          -- inflated by 18 archived contexts / 429 decisions / 23 tasks. Found by a reviewer,
          -- NOT by the reconciliation guard, because that guard derived its population from a
          -- NAME pattern (/(_stats|_insights|_progress_summary)$/) and nothing here is named
          -- that way — see OpRegistryEntry.reportsCount, which replaced the pattern.
          --
          -- These are correlated SUBQUERIES, not joins, so the LEFT JOIN trap documented in
          -- handlers/project.ts does NOT apply: narrowing the inner COUNT can only move it
          -- toward 0, and COALESCE(...,0) already covers no-rows, so a session with zero live
          -- records still reports 0 and can never vanish or go NULL.
          --
          -- KNOWN CONSEQUENCE, deliberate: productivity_score is computed from these counts,
          -- so archiving a record now lowers the score of the session that produced it. That
          -- is the same call as excluding archived tasks from teamEfficiency's denominator —
          -- a score over records nobody can retrieve is not a score of anything.
          COALESCE((SELECT COUNT(*) FROM contexts c            WHERE c.session_id = s.id
                                                               AND c.archived_at IS NULL), 0) AS contexts_created,
          COALESCE((SELECT COUNT(*) FROM tasks t               WHERE t.session_id = s.id
                                                               AND t.archived_at IS NULL), 0) AS tasks_created,
          COALESCE((SELECT COUNT(*) FROM tasks t               WHERE t.session_id = s.id
                                                               AND t.archived_at IS NULL
                                                                 AND t.status = 'completed'), 0) AS tasks_completed,
          COALESCE((SELECT COUNT(*) FROM technical_decisions d WHERE d.session_id = s.id
                                                               AND d.archived_at IS NULL), 0) AS decisions_created,
          EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) * 1000 as duration_ms
        FROM sessions s
        WHERE s.id = $1
      `;

      const result = await db.query(sql, [sessionId]);

      if (result.rows.length === 0) {
        return null;
      }

      const session = result.rows[0];

      return {
        session_id: session.id,
        start_time: session.started_at,
        end_time: session.ended_at,
        duration_ms: parseFloat(session.duration_ms) || 0,
        project_id: session.project_id,
        title: session.title,
        description: session.description,
        session_goal: session.session_goal,
        tags: session.tags || [],
        lines_added: session.lines_added || 0,
        lines_deleted: session.lines_deleted || 0,
        lines_net: session.lines_net || 0,
        productivity_score: parseFloat(session.productivity_score) || 0,
        ai_model: session.ai_model,
        files_modified_count: session.files_modified_count || 0,
        activity_count: session.activity_count || 0,
        contexts_created: parseInt(session.contexts_created, 10) || 0,
        // WAS `decisions_created: 0, // Filled by caller` — and no caller ever filled it,
        // so the decisions term of calculateBasicProductivity
        // ((contexts*2 + decisions*3) / (hours+1)) was structurally DEAD on every session
        // ever scored. Derived from the child table now. 24 of the 114
        // finalized prod sessions have decisions this formula was ignoring.
        decisions_created: parseInt(session.decisions_created, 10) || 0,
        operations_count: session.activity_count || 0,
        success_status: !session.ended_at ? 'active' :
                       (session.activity_count > 0 ? 'completed' : 'abandoned'),
        status: session.status || 'active',
        last_activity_at: session.last_activity_at,
        input_tokens: session.input_tokens || 0,
        output_tokens: session.output_tokens || 0,
        total_tokens: session.total_tokens || 0
      };

    } catch (error) {
      logger.error('Failed to get session data', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'getSessionData',
        metadata: { sessionId }
      });
      return null;
    }
  },

  /**
   * Update session details (title, description, goal, tags)
   */
  async updateDetails(
    sessionId: string,
    title?: string,
    description?: string,
    sessionGoal?: string,
    tags?: string[]
  ): Promise<boolean> {
    try {
      const sql = `
        UPDATE sessions
        SET title = COALESCE($2, title),
            description = COALESCE($3, description),
            session_goal = COALESCE($4, session_goal),
            tags = COALESCE($5, tags),
            updated_at = NOW(),
            metadata = metadata || $6::jsonb
        WHERE id = $1
        RETURNING id
      `;

      const result = await db.query(sql, [
        sessionId,
        title || null,
        description || null,
        sessionGoal || null,
        tags || null,
        JSON.stringify({
          title_updated: !!title,
          description_updated: !!description,
          session_goal_updated: !!sessionGoal,
          tags_updated: !!(tags && tags.length > 0),
          updated_by: 'aidis-session-tracker',
          updated_at: new Date().toISOString()
        })
      ]);

      return result.rows.length > 0;

    } catch (error) {
      logger.error('Failed to update session details', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'updateDetails',
        metadata: { sessionId }
      });
      return false;
    }
  },

  /**
   * Get session with basic details
   */
  async getWithDetails(sessionId: string): Promise<{
    id: string;
    title?: string;
    description?: string;
    project_id?: string;
    started_at: Date;
    ended_at?: Date;
  } | null> {
    try {
      const sql = `
        SELECT id, title, description, project_id, started_at, ended_at
        FROM sessions 
        WHERE id = $1
      `;

      const result = await db.query(sql, [sessionId]);
      return result.rows[0] || null;

    } catch (error) {
      logger.error('Failed to get session with details', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'getWithDetails',
        metadata: { sessionId }
      });
      return null;
    }
  },

  /**
   * THE ONE STATEMENT THAT WRITES A SESSION COUNTER COLUMN (the reviewer B1).
   *
   * Every counter column — activity AND tokens — moves through this single
   * `col = COALESCE(col,0) + delta` UPDATE. `applyActivityCounts` and `addTokens` below
   * are thin wrappers over it (they zero-fill the half they do not own), so there is
   * exactly ONE piece of SQL in the codebase that can change these columns.
   *
   * ── WHY ONE STATEMENT AND NOT TWO ────────────────────────────────────────────────
   * `endSession` CONSUMES the in-memory delta (get-and-delete) and must then persist it
   * or hand it BACK. With two sequential writes there is a state in between where the
   * first has COMMITTED and the second has not, and the only honest recovery from there
   * is a partial restore — the caller would have to know which half landed. The previous
   * shape did not: it restored BOTH deltas in one catch, so a failure of the second write
   * re-queued activity that was already on disk and the next flush ADDED IT AGAIN.
   * Measured: a delta of 2 contexts / 1 task created / 1 task updated / 150 tokens ended
   * up as 4 / 2 / 2 / 150. `tasks_updated` has no child table (see `getFinalCounts`), so
   * that over-count is authoritative, reaches the productivity score and is user-visible.
   *
   * A single UPDATE against a single row is atomic in its own implicit transaction: it
   * lands whole or not at all. That makes "restore the whole delta" unconditionally
   * correct, and it removes the half-landed state rather than asking every caller to
   * handle it. A transaction wrapping two statements would also work, but it would leave
   * two writers and would depend on the wrappers below propagating errors — which they
   * deliberately do not (see their comments).
   *
   * THIS METHOD THROWS. It is the error-propagating core: `endSession` needs the failure
   * so it can restore the consumed delta. The swallow lives in the wrappers, where the
   * flush loops want it.
   */
  async applyCounterDelta(sessionId: string, delta: SessionCounterDelta): Promise<void> {
    const sql = `
      UPDATE sessions
      SET tasks_created    = COALESCE(tasks_created, 0)    + $2,
          tasks_updated    = COALESCE(tasks_updated, 0)    + $3,
          tasks_completed  = COALESCE(tasks_completed, 0)  + $4,
          contexts_created = COALESCE(contexts_created, 0) + $5,
          input_tokens     = COALESCE(input_tokens, 0)     + $6,
          output_tokens    = COALESCE(output_tokens, 0)    + $7,
          total_tokens     = COALESCE(total_tokens, 0)     + $8,
          tokens_used      = COALESCE(tokens_used, 0)      + $8,
          last_activity_at = NOW()
      WHERE id = $1
    `;

    await db.query(sql, [
      sessionId,
      delta.tasks_created,
      delta.tasks_updated,
      delta.tasks_completed,
      delta.contexts_created,
      delta.input_tokens,
      delta.output_tokens,
      delta.total_tokens
    ]);
  },

  /**
   * Add tokens to session (for batch flushing).
   *
   * Wrapper over `applyCounterDelta` — the activity half is zero-filled, so this adds
   * nothing to those columns. It SWALLOWS the error on purpose: `TokenTracker.flushToDatabase`
   * iterates every session inside one try, so a throw here would abort the loop and drop
   * the deltas of every session after it. `endSession` does NOT use this path — it calls
   * `applyCounterDelta` directly precisely because it needs the throw.
   */
  async addTokens(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    totalTokens: number
  ): Promise<void> {
    try {
      await SessionRepo.applyCounterDelta(sessionId, {
        tasks_created: 0,
        tasks_updated: 0,
        tasks_completed: 0,
        contexts_created: 0,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens
      });
    } catch (error) {
      logger.error('Failed to add tokens', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'addTokens',
        metadata: { sessionId }
      });
    }
  },

  /**
   * Apply activity counts to session (for batch flushing).
   *
   * Wrapper over `applyCounterDelta` with the token half zero-filled. Swallows for the
   * same reason `addTokens` does — see its comment.
   */
  async applyActivityCounts(
    sessionId: string,
    tasksCreated: number,
    tasksUpdated: number,
    tasksCompleted: number,
    contextsCreated: number
  ): Promise<void> {
    try {
      await SessionRepo.applyCounterDelta(sessionId, {
        tasks_created: tasksCreated,
        tasks_updated: tasksUpdated,
        tasks_completed: tasksCompleted,
        contexts_created: contextsCreated,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      });
    } catch (error) {
      logger.error('Failed to apply activity counts', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'applyActivityCounts',
        metadata: { sessionId }
      });
    }
  },

  /**
   * Get starting commit SHA for a session
   */
  async getStartingCommitSha(sessionId: string): Promise<string | null> {
    try {
      const result = await db.query(
        'SELECT working_commit_sha FROM sessions WHERE id = $1',
        [sessionId]
      );
      return result.rows[0]?.working_commit_sha || null;
    } catch (error) {
      logger.error('Failed to get starting commit SHA', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'getStartingCommitSha',
        metadata: { sessionId }
      });
      return null;
    }
  },

  /**
   * Get project root directory for a session
   */
  async getProjectRootDir(sessionId: string): Promise<string | null> {
    try {
      const result = await db.query(`
        SELECT p.root_directory
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.id = $1
      `, [sessionId]);
      return result.rows[0]?.root_directory || null;
    } catch (error) {
      logger.error('Failed to get project root dir', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'getProjectRootDir',
        metadata: { sessionId }
      });
      return null;
    }
  },

  /**
   * Count decisions for a session
   */
  async countDecisions(sessionId: string): Promise<number> {
    try {
      const result = await db.query(
        // SOFT-DELETE: the ONE session count that is a plain query rather
        // than a correlated subquery, and therefore the one a subquery-shaped sweep misses.
        'SELECT COUNT(*) as count FROM technical_decisions WHERE session_id = $1 AND archived_at IS NULL',
        [sessionId]
      );
      return parseInt(result.rows[0]?.count || '0');
    } catch (error) {
      logger.error('Failed to count decisions', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'countDecisions',
        metadata: { sessionId }
      });
      return 0;
    }
  },

  /**
   * Read a session's AUTHORITATIVE final counts back from the database.
   *
   * Called by `endSession` AFTER the un-flushed delta has been applied through
   * `applyActivityCounts` / `addTokens`, so what comes back is the committed truth —
   * never an in-memory delta.
   *
   * contexts / decisions / tasks come from the CHILD TABLES (rule 1 above: session
   * linkage only), because those are recomputable and therefore cannot lie.
   *
   * TOKENS come from the `sessions.total_tokens` COLUMN, because they are NOT
   * recomputable: `recordTokenUsage` writes only to the in-memory TokenStore, the
   * `session_end` analytics event omits tokens, and nothing on the tool-call path
   * populates `analytics_events.prompt_tokens`/`completion_tokens`. This column is the
   * only durable record of a session's token usage, and for sessions zeroed by the old
   * `finish()` that history is GONE — there is no backfill and none is possible.
   *
   * ── THIS FUNCTION THROWS. IT DOES NOT FAIL SAFE TO ZEROS. ────────────────────────
   * It used to catch a DB error and return the all-zero object below, which is the
   * SAME LIE this whole task exists to delete — one layer up. Its return value is not
   * decoration: `endSession` writes it into `context_summary` ("Session completed with
   * 0 tasks and 0 contexts"), into the `session_end` analytics event, and into the
   * productivity formula (a 0 score). A swallowed read therefore produced a session
   * that CONFIDENTLY reported zero, indistinguishable from a genuinely empty one, with
   * only a log line to say otherwise.
   *
   * Throwing is safe here specifically because of the STEP ordering in `endSession`:
   * the consumed delta is already PERSISTED (STEP 1) before this read (STEP 2), so
   * nothing is in flight and nothing is lost. The end fails loudly, the counter columns
   * are already correct and durable, and a retry (the closer's next sweep, or another
   * `session_end`) consumes an empty delta and adds +0. A late, correct finalize beats
   * an on-time, false one.
   */
  async getFinalCounts(sessionId: string): Promise<FinalSessionCounts> {
    const result = await db.query(
      `SELECT
         COALESCE((SELECT COUNT(*) FROM contexts c            WHERE c.session_id = s.id
                                                              AND c.archived_at IS NULL), 0) AS contexts_created,
         COALESCE((SELECT COUNT(*) FROM technical_decisions d WHERE d.session_id = s.id
                                                              AND d.archived_at IS NULL), 0) AS decisions_created,
         COALESCE((SELECT COUNT(*) FROM tasks t               WHERE t.session_id = s.id
                                                              AND t.archived_at IS NULL), 0) AS tasks_created,
         COALESCE((SELECT COUNT(*) FROM tasks t               WHERE t.session_id = s.id
                                                              AND t.archived_at IS NULL
                                                                AND t.status = 'completed'), 0) AS tasks_completed,
         COALESCE(s.tasks_updated, 0) AS tasks_updated,
         COALESCE(s.input_tokens, 0)  AS input_tokens,
         COALESCE(s.output_tokens, 0) AS output_tokens,
         COALESCE(s.total_tokens, 0)  AS total_tokens
       FROM sessions s
       WHERE s.id = $1`,
      [sessionId]
    );

    const row = result.rows[0];
    // No row = the session does not exist. Same reasoning as the throw above: the
    // caller is about to write this into a human-readable summary and a score, so
    // "there is nothing to read" must not render as "there was nothing to count".
    if (!row) {
      throw new Error(`getFinalCounts: session ${sessionId} not found`);
    }

    return {
      contexts_created: parseInt(row.contexts_created, 10) || 0,
      decisions_created: parseInt(row.decisions_created, 10) || 0,
      tasks_created: parseInt(row.tasks_created, 10) || 0,
      // tasks_updated has NO child-table equivalent (an update leaves no per-session
      // row), so it stays a counter column — correct now that only the incrementing
      // choke point writes it.
      tasks_updated: parseInt(row.tasks_updated, 10) || 0,
      tasks_completed: parseInt(row.tasks_completed, 10) || 0,
      input_tokens: parseInt(row.input_tokens, 10) || 0,
      output_tokens: parseInt(row.output_tokens, 10) || 0,
      total_tokens: parseInt(row.total_tokens, 10) || 0,
    };
  },

  /**
   * ── SESSION IDENTITY READ MODEL (Amp-orb eval W3) ────────────────────────
   *
   * ONE column list, ONE join, ONE count strategy — shared by `getIdentityRow` (session_get /
   * session_status) and `listIdentityRows` (session_list) so a field can never be present on
   * one surface and missing on the other. Selects only OBSERVABILITY columns: no metadata
   * blob, no description, no credential-bearing column exists on this table to select.
   *
   * The counts are computed from the CHILD tables (contexts / tasks / technical_decisions
   * WHERE session_id = s.id) rather than from the denormalised `sessions.contexts_created`
   * counters, because those counters are flushed periodically and lag: an orb that has just
   * written ONE context must be able to see contextCount 1 IMMEDIATELY, which is the eval's
   * literal acceptance criterion ("after ONE write"). A lagging counter would render a
   * plausible zero — the exact silent-wrong-answer this feature exists to remove.
   *
   * COUNT SEMANTICS — this is COPY 2 of a rule with three copies (COPY 1 = the
   * `v_session_summaries` view, migration 070; COPY 3 = mandrel-command backend
   * `services/sessionCounts.ts`). Contexts are counted by SESSION LINKAGE ONLY: do NOT add
   * `AND c.project_id = s.project_id`, which correlates to the SESSION's project and drops
   * 24% of session-linked contexts on prod (long-running sessions did mid-session
   * project_switches). The guard is `mcp-server/src/tests/sessionCountRule.contract.test.ts`
   * (+ its backend twin): they execute all three copies against a CROSS-PROJECT fixture and
   * compare. Re-add the guard here and that suite goes RED — measured, not assumed.
   */
  IDENTITY_SELECT: `
      SELECT
        s.id,
        s.actor,
        s.project_id,
        p.name                                   AS project_name,
        s.status::text                           AS status,
        s.creation_reason,
        s.started_at,
        s.last_activity_at,
        s.ended_at,
        s.title,
        s.connection_id,
        s.created_via_connection,
        COALESCE((SELECT COUNT(*) FROM contexts c            WHERE c.session_id = s.id
                                                             AND c.archived_at IS NULL), 0) AS context_count,
        COALESCE((SELECT COUNT(*) FROM tasks t               WHERE t.session_id = s.id
                                                             AND t.archived_at IS NULL), 0) AS task_count,
        COALESCE((SELECT COUNT(*) FROM technical_decisions d WHERE d.session_id = s.id
                                                             AND d.archived_at IS NULL), 0) AS decision_count
      FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id`,

  /**
   * Fetch ONE session's identity row, or null when no such session exists.
   *
   * Returns null ONLY for "there is no row with this id" — it does NOT swallow errors into
   * null (a DB failure throws), so the caller can tell "not found" apart from "lookup broke"
   * and report each honestly. Every other read in this repo fails-safe to null because it
   * sits on a hot write path; this one is a read tool whose whole job is to be truthful.
   */
  async getIdentityRow(sessionId: string): Promise<SessionIdentityRow | null> {
    const result = await db.query(`${this.IDENTITY_SELECT} WHERE s.id = $1`, [sessionId]);
    return (result.rows[0] as SessionIdentityRow) ?? null;
  },

  /**
   * List session identity rows for correlation, newest activity first.
   *
   * @param filters.projectId  restrict to one project (session_list is project-scoped by
   *                           default — the eval asked for "a project-level session list
   *                           suitable for correlation"). null = every project.
   * @param filters.actor      restrict to one actor (exact match on the stamped principal).
   * @param filters.openOnly   true = only OPEN sessions (the canonical openness predicate:
   *                           ended_at NULL AND status in active|interrupted|dormant).
   * @param filters.limit/offset  bounded page (the caller clamps against the config ceiling).
   */
  async listIdentityRows(filters: {
    projectId?: string | null;
    actor?: string | null;
    openOnly?: boolean;
    limit: number;
    offset: number;
  }): Promise<{ rows: SessionIdentityRow[]; totalCount: number }> {
    const where: string[] = [];
    const params: any[] = [];

    if (filters.projectId) {
      params.push(filters.projectId);
      where.push(`s.project_id = $${params.length}`);
    }
    if (filters.actor) {
      params.push(filters.actor);
      where.push(`s.actor = $${params.length}`);
    }
    if (filters.openOnly) {
      where.push(`s.ended_at IS NULL AND s.status::text IN ('active', 'interrupted', 'dormant')`);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    // The exact total BEFORE the page bound, so a clamped/paged response can report how many
    // it did not show instead of silently implying the page is everything.
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM sessions s${whereSql}`,
      params
    );
    const totalCount: number = countResult.rows[0]?.total ?? 0;

    const pageParams = [...params, filters.limit, filters.offset];
    const result = await db.query(
      // `s.id DESC` makes this LIMIT/OFFSET page a TOTAL order: the
      // COALESCE'd timestamp is not unique, and paging over a partial order can repeat one
      // session and drop another. The PK is unique, stable under edits, already indexed.
      `${this.IDENTITY_SELECT}${whereSql}
       ORDER BY COALESCE(s.last_activity_at, s.started_at) DESC, s.id DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    );
    return { rows: result.rows as SessionIdentityRow[], totalCount };
  },

  /**
   * Get productivity config
   */
  async getProductivityConfig(configName: string = 'default'): Promise<Record<string, any> | null> {
    try {
      const result = await db.query(
        'SELECT formula_weights FROM productivity_config WHERE config_name = $1',
        [configName]
      );
      return result.rows[0]?.formula_weights || null;
    } catch (error) {
      logger.error('Failed to get productivity config', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionRepo',
        operation: 'getProductivityConfig',
        metadata: { configName }
      });
      return null;
    }
  }
};
