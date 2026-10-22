-- Migration 077: FEEDBACK OWNERSHIP MOVES TO AN IMMUTABLE KEY — `feedback.user_id`
-- an earlier task.
--
-- ── WHAT THIS CLOSES ──────────────────────────────────────────────────────────────────
-- `GET /api/feedback` scoped a caller to their own rows by comparing `feedback.username`
-- to the request's username. `admin_users.username` is a RECYCLABLE HANDLE: any
-- authenticated user may rewrite their own via `PUT /api/users/profile`, whose only
-- constraint is that the new name is not currently taken, and the auth middleware
-- re-reads the user row from the database on every request, so a rename takes effect on
-- the next call with no re-login. So a victim who vacates a username (self-rename, or an
-- admin freeing it) can have it claimed by a different account, which then reads the
-- victim's rows; and a user who renames themselves loses sight of their own.
--
-- `admin_users.id` is a `gen_random_uuid()` primary key (migration 040): it is never
-- rewritten by any endpoint and is never reissued. Keying ownership on it closes the
-- whole class BY CONSTRUCTION rather than by a check somebody has to remember to write.
--
-- ── BACKFILL, AND WHAT HAPPENS TO ROWS THAT DO NOT RESOLVE ────────────────────────────
-- Existing rows are matched to `admin_users` by the username already stored on them, so
-- every row whose author still holds that name keeps its owner across the migration.
--
-- A row whose username does not resolve (the author was deleted, or renamed away before
-- this migration, or the row was written with a NULL username — `feedback.username` has
-- always been nullable) is an ORPHAN. Orphans are:
--   * KEPT. The row is never deleted; the message is the product of this table.
--   * LEFT NULL, which makes them UNREACHABLE THROUGH THE API — `WHERE user_id = $1`
--     is never true for a NULL. That is fail-closed on purpose: the alternative is
--     guessing an owner from a recyclable string, which is the exact defect being fixed.
--   * COUNTED, NOT LOGGED: migrate.ts discards the WARNING (node-postgres, no listener).
--     Count: SELECT count(*) FROM feedback WHERE user_id IS NULL.
--   * STILL READ BY HUMANS. out-of-band feedback reports
--     read this table directly over psql with no owner predicate, so orphaned feedback
--     continues to reach the operator/the coordinator exactly as before. Nothing is lost — only the
--     self-service API view of it is withheld, which is the correct fail-closed default.
--
-- ── WHY THE COLUMN STAYS NULLABLE AFTER THE BACKFILL ──────────────────────────────────
-- It cannot be NOT NULL, for two independent reasons:
--   1. Orphans (above) legitimately have no owner, and a NOT NULL would force the
--      migration to either delete them or invent an owner. Both are worse.
--   2. `ON DELETE SET NULL` requires a nullable column. That behaviour is the one we
--      want: deleting a user must not delete their submitted feedback (CASCADE) and must
--      not be blocked by it (RESTRICT). The row survives, ownerless and API-unreachable,
--      and the out-of-band readers still show it.
-- NULL therefore has ONE consistent meaning everywhere: "no live account owns this row",
-- and the read path treats it as nobody's.
--
-- ── `username` IS NOW A LABEL, NOT AN AUTHORIZATION KEY ───────────────────────────────
-- The column is kept and the write path keeps stamping it, because the two shell readers
-- above render it as the human-readable "who said this". It is denormalized display
-- text: nothing in the API authorizes on it any more. It may go stale after a rename and
-- that is acceptable for a label — it is exactly what made it unusable as a key.
--
-- ── ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE ───────────────────────────────────────
--   * ADD/CREATE IF NOT EXISTS. DO NOT RE-RUN BY HAND — only the _aidis_migrations tracker
--     makes this one-shot; re-running after a label is re-claimed re-leaks (measured, 2).
--   * Nothing existing is altered or dropped. Readers selecting named columns are
--     unaffected; neither shell reader selects `*` or references `user_id`.
--   * scripts/schema-reference.sql.txt regenerated so the CI drift gate (0c) stays honest.

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS user_id UUID NULL
        REFERENCES admin_users(id) ON DELETE SET NULL;

-- The read path is `WHERE user_id = $1 ORDER BY created_at DESC`; this serves it, and
-- keeps `DELETE FROM admin_users` from sequentially scanning feedback to apply SET NULL.
CREATE INDEX IF NOT EXISTS idx_feedback_user_id_created_at
    ON feedback(user_id, created_at DESC);

COMMENT ON COLUMN feedback.user_id IS
    'Owning admin_users.id — the immutable ownership key the API authorizes on. NULL means no live account owns this row (author deleted, renamed away before migration 077, or submitted with no username); such rows are withheld from the API and remain visible only to the out-of-band psql readers.';

-- Migration 044 set this to "... username is JWT-derived", which is not how it is
-- produced: authenticateToken re-reads the row from admin_users on every request, which
-- is exactly why a rename takes effect without a new token and why the handle could not
-- serve as the key.
COMMENT ON TABLE feedback IS
    'Tester-submitted feedback (bug/idea/question) from the Mandrel Command dashboard. Owner is user_id (immutable admin_users.id); username is a stale-able display label re-read from admin_users at request time, not an authorization key.';

COMMENT ON COLUMN feedback.username IS
    'Denormalized human-readable author label for the out-of-band readers (out-of-band feedback reports). NOT an authorization key: usernames are user-editable and recyclable. Authorization uses user_id.';

DO $$
DECLARE
    claimed  bigint;
    orphans  bigint;
    names    text;
BEGIN
    UPDATE feedback f
       SET user_id = u.id
      FROM admin_users u
     WHERE f.user_id IS NULL
       AND f.username IS NOT NULL
       AND f.username = u.username;
    GET DIAGNOSTICS claimed = ROW_COUNT;

    SELECT count(*), coalesce(string_agg(DISTINCT coalesce(username, '<null>'), ', '), '')
      INTO orphans, names
      FROM feedback
     WHERE user_id IS NULL;

    RAISE NOTICE 'migration 077: backfilled owner for % feedback row(s) by username', claimed;

    IF orphans > 0 THEN
        RAISE WARNING 'migration 077: % feedback row(s) have no resolvable owner and stay NULL (KEPT, withheld from the API, still visible to an out-of-band feedback report). Unresolved author labels: %', orphans, names;
    END IF;
END
$$;
