-- Migration 069: index technical_decisions(session_id)
-- Task: an earlier change (session counter columns render 0 once a session ends)
--
-- WHY: the fix for that task stops reading the denormalized sessions.decisions_created
-- column (which has NO runtime writer at all — the only assignment anywhere in the tree
-- is `SET decisions_created = 0` in migration 042, so it is permanently 0 on every prod
-- row) and derives the count from the child table instead:
--
--     (SELECT COUNT(*) FROM technical_decisions d WHERE d.session_id = s.id)
--
-- That subquery now runs per session row on the sessions list, the session detail, the
-- session_status / session_get identity read model (SessionRepo.IDENTITY_SELECT already
-- had it), and the v_session_summaries view. contexts and tasks already had the matching
-- index (idx_contexts_session_id from migration 002, idx_tasks_session_id from 021);
-- technical_decisions did NOT — measured on prod 2026-07-26, its 13 indexes covered
-- project/type/status/date/tags/embeddings and nothing on session_id.
--
-- SHAPE: partial (WHERE session_id IS NOT NULL), matching idx_tasks_session_id. 85 of the
-- 772 prod rows have a NULL session_id and can never satisfy `d.session_id = s.id`, so
-- indexing them only costs space. A partial index is still fully usable by that predicate
-- because `= s.id` implies IS NOT NULL.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside a transaction block, and the
-- migration runner wraps each file. technical_decisions is small (772 rows on prod, and
-- every tenant container is smaller), so the brief ACCESS EXCLUSIVE lock is sub-millisecond.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_technical_decisions_session_id
  ON technical_decisions (session_id)
  WHERE session_id IS NOT NULL;

COMMENT ON INDEX idx_technical_decisions_session_id IS
  'Supports per-session decision counts derived from the child table instead of the permanently-zero sessions.decisions_created column.';

COMMIT;
