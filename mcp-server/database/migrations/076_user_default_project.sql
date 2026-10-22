-- Migration 076: PER-USER DEFAULT PROJECT — `admin_users.default_project_id`
-- Epic: 41293984 (Command UI project-selector rework, spec §A)
--
-- ── WHAT THIS CLOSES ──────────────────────────────────────────────────────────────────
-- The Command UI's "default project" was NOT per-user. It was the instance-wide
-- `projects.metadata->>'is_primary'` flag (mandrel-command/backend/src/controllers/
-- project.ts clearPrimary/setPrimary), so ONE user changing their default changed it for
-- EVERYONE — `clearPrimary` runs an UPDATE over the whole projects table with no user
-- scoping at all. It was also carried through the UI as a project NAME string
-- (frontend/src/types/settings.ts), so renaming a project silently broke the default.
--
-- This column is the per-user replacement, and it stores the UUID: the rename bug is
-- closed BY CONSTRUCTION (an id does not change when a name does), not by a check
-- somebody has to remember to write.
--
-- ── DELIBERATELY NOT DONE HERE ────────────────────────────────────────────────────────
-- `projects.metadata.is_primary` is LEFT ALONE. It has non-UI consumers (mcp-server
-- bootstrap), and the set-primary / clear-primary endpoints keep working unchanged. This
-- migration stops the UI depending on the instance flag; retiring the flag is a separate
-- job with its own survey of consumers.
--
-- ── KEY DESIGN ────────────────────────────────────────────────────────────────────────
-- NULL is a first-class, meaningful value: "this user has set no default". It is the
-- column's initial state for every existing row and the UI has an explicit affordance for
-- it (a "Set a default project" link, never a blank). No backfill: guessing a default
-- from the instance-wide is_primary flag would silently hand every user a preference
-- they never expressed, and would re-import the very global-state coupling being removed.
--
-- ON DELETE SET NULL (not CASCADE, not RESTRICT): deleting a project must not delete the
-- user, and must not be blocked by somebody's preference. The user simply falls back to
-- "no default set" and the UI shows the affordance. This means the column can NEVER hold
-- a dangling project id — an authorization check downstream can therefore treat a
-- non-null value as a project that exists, and only has to answer "may this user see it".
--
-- ── ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE ───────────────────────────────────────
--   * ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Nothing existing is altered or dropped; every existing row gets NULL.
--   * scripts/schema-reference.sql.txt regenerated so the CI drift gate (0c) stays honest.

ALTER TABLE admin_users
    ADD COLUMN IF NOT EXISTS default_project_id UUID NULL
        REFERENCES projects(id) ON DELETE SET NULL;

-- The FK's referencing side is unindexed by default in Postgres, which makes every
-- `DELETE FROM projects` do a sequential scan of admin_users to enforce ON DELETE SET
-- NULL. Small table today; the index keeps project deletion cheap regardless, and serves
-- the reverse lookup ("who defaults to this project?") the admin UI will want.
CREATE INDEX IF NOT EXISTS idx_admin_users_default_project
    ON admin_users(default_project_id);
