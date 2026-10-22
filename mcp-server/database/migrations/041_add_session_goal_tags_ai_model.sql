-- Migration: 041_add_session_goal_tags_ai_model
-- Description: Add session_goal, tags, ai_model columns to sessions table.
--   These are written by SessionRepo.create()'s INSERT (and read by
--   getSessionData / updateDetails) but were never added by any migration,
--   so POST /api/v2/sessions/start failed with HTTP 500:
--     column "session_goal" of relation "sessions" does not exist.
--   Types are chosen to match exactly how SessionRepo binds them:
--     - session_goal: params.sessionGoal || null  -> TEXT, nullable
--     - tags:         params.tags || []            -> TEXT[] (raw JS array,
--                       NOT JSON.stringify'd like metadata), default '{}'
--     - ai_model:     params.aiModel || null       -> TEXT, nullable
-- Created: 2026-06-10
-- Idempotent: uses ADD COLUMN IF NOT EXISTS so it is safe on every boot.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_goal TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ai_model TEXT;

COMMENT ON COLUMN sessions.session_goal IS 'Optional free-text goal for the session (set at session start or via updateDetails).';
COMMENT ON COLUMN sessions.tags IS 'Free-form text tags for the session; bound as a raw Postgres text array by SessionRepo.';
COMMENT ON COLUMN sessions.ai_model IS 'AI model identifier associated with the session, when provided.';
