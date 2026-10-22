-- Migration: 042_reconcile_sessions_schema
-- Description: Reconcile the app-instance `sessions` table with PROD.
--   After 041 added session_goal/tags/ai_model the INSERT in SessionRepo.create()
--   succeeds (HTTP 201), but POST /api/v2/sessions/start still returned
--   `data: null` because SessionRepo.getSessionData()'s SELECT (and the file/
--   activity/decision update paths) reference MORE columns the app DB never had,
--   so the read-back SELECT throws and getSessionData() returns null.
--
--   A schema diff between PROD (`mandrel` on the personal node, treated here as the
--   known-good reference) and the app-instance DB (`mandrel-app-postgres`) shows the
--   app `sessions` table is missing exactly these 11 columns:
--
--     activity_count        integer        NULL     default 0      (read: getSessionData; written: updateActivityCount)
--     decisions_created     integer        NOT NULL default 0      (read: getSessionData fills 0 in code; column exists in prod)
--     files_modified_count  integer        NULL     default 0      (read: getSessionData; written: updateFileMetrics)
--     ip_address            inet           NULL     (no default)   (prod col; request metadata)
--     lines_added           integer        NULL     default 0      (read: getSessionData; written: updateFileMetrics)
--     lines_deleted         integer        NULL     default 0      (read: getSessionData; written: updateFileMetrics)
--     lines_net             integer        NULL     default 0      (read: getSessionData; written: updateFileMetrics)
--     productivity_score    numeric(5,2)   NULL     (no default)   (read: getSessionData; written: updateProductivityScore)
--     token_id              varchar(255)   NULL     (no default)   (prod col; auth/request metadata)
--     user_agent            text           NULL     (no default)   (prod col; request metadata)
--     user_id               uuid           NULL     (no default)   (prod col; FK -> admin_users(id) ON DELETE SET NULL)
--
--   Types / nullability / defaults below are copied from PROD's
--   information_schema.columns for the sessions table (the authoritative source).
--
-- Created: 2026-06-10
-- Idempotent: ADD COLUMN IF NOT EXISTS / IF EXISTS guards make this safe on every boot.

-- Read-back + metric columns that SessionRepo.getSessionData()/updateFileMetrics()/
-- updateActivityCount()/updateProductivityScore() reference. Defaults match prod.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS activity_count       integer      DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS files_modified_count integer      DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lines_added          integer      DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lines_deleted        integer      DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lines_net            integer      DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS productivity_score   numeric(5,2);

-- decisions_created is NOT NULL DEFAULT 0 in prod. Add with default first so any
-- existing rows backfill to 0, then enforce NOT NULL to match prod exactly.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS decisions_created    integer      DEFAULT 0;
UPDATE sessions SET decisions_created = 0 WHERE decisions_created IS NULL;
ALTER TABLE sessions ALTER COLUMN decisions_created SET NOT NULL;

-- Request / auth metadata columns present in prod (no defaults, nullable).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address           inet;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_id             varchar(255);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent           text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id              uuid;

-- user_id FK -> admin_users(id) ON DELETE SET NULL, matching prod
-- (sessions_user_id_fkey). Guarded so the migration is idempotent. admin_users is
-- created by migration 040 in this same DB.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_user_id_fkey' AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Partial indexes that back the newly-added columns in prod, for parity.
CREATE INDEX IF NOT EXISTS idx_sessions_productivity_score
  ON sessions (productivity_score) WHERE productivity_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_files_modified
  ON sessions (files_modified_count) WHERE files_modified_count > 0;

COMMENT ON COLUMN sessions.activity_count       IS 'Count of session_activities rows; maintained by SessionRepo.updateActivityCount.';
COMMENT ON COLUMN sessions.files_modified_count IS 'Distinct files modified; maintained by SessionRepo.updateFileMetrics.';
COMMENT ON COLUMN sessions.lines_added          IS 'Sum of lines added across session_files; maintained by updateFileMetrics.';
COMMENT ON COLUMN sessions.lines_deleted        IS 'Sum of lines deleted across session_files; maintained by updateFileMetrics.';
COMMENT ON COLUMN sessions.lines_net            IS 'Net lines (added - deleted) across session_files; maintained by updateFileMetrics.';
COMMENT ON COLUMN sessions.productivity_score   IS 'Computed productivity score; set by SessionRepo.updateProductivityScore.';
COMMENT ON COLUMN sessions.decisions_created    IS 'Count of technical_decisions created during the session.';
COMMENT ON COLUMN sessions.ip_address           IS 'Client IP recorded at session start (request metadata).';
COMMENT ON COLUMN sessions.token_id             IS 'Auth token identifier associated with the session, when present.';
COMMENT ON COLUMN sessions.user_agent           IS 'Client User-Agent recorded at session start (request metadata).';
COMMENT ON COLUMN sessions.user_id              IS 'Owning admin user (FK admin_users.id, ON DELETE SET NULL).';
