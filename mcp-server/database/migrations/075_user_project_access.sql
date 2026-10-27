-- Migration 075: PER-USER PROJECT ACCESS — the `user_project_access` table
-- Task: an earlier change (durable F-01/F-04 fix — single trust boundary through the command backend)
--
-- ── WHAT THIS CLOSES (F-04) ───────────────────────────────────────────────────────────
-- The command backend's projectContextMiddleware (mandrel-command/backend/src/middleware/
-- project.ts) trusted the browser-supplied X-Project-ID header after only a UUID-format
-- check — an explicit TODO ("Add project access validation when user-project relationships
-- are implemented") that shipped for the whole life of the repo. Any authenticated user
-- could scope any request to ANY project. This table IS the user-project relationship that
-- TODO was waiting for; the enforcement lands in the same middleware.
--
-- ── KEY DESIGN ────────────────────────────────────────────────────────────────────────
-- (user_id, project_id) PRIMARY KEY: a grant is a bare edge — a user either may scope
-- requests to a project or may not. No per-project roles yet (the admin/user split lives
-- on admin_users.role and admins BYPASS this table in code — an admin is all-projects by
-- definition, so materializing admin rows here would just be a second copy of `role`
-- that drifts).
--
-- FKs CASCADE both ways: deleting a user or a project silently drops its grants, so an
-- access check can never resolve against a dead principal or a dead project.
--
-- granted_by is attribution (which admin granted), NOT authorization input. Nullable +
-- ON DELETE SET NULL: losing the granting admin must not revoke the grant.
--
-- ── SEED (deliberate, preserves today's observed behavior at cutover) ─────────────────
-- Enforcement is deny-by-default for NON-ADMIN users. Today every active user de facto
-- has full access (the header was trusted). So this migration seeds a grant for every
-- ACTIVE NON-ADMIN admin_users row × every project: nobody loses access at the moment
-- the check turns on (no privilege escalation either — they already had it), while every
-- FUTURE user/project pairing starts denied until an admin grants it.
-- Idempotent via ON CONFLICT DO NOTHING.
--
-- ── ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE ───────────────────────────────────────
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Brand-new table; nothing existing is altered or dropped.
--   * scripts/schema-reference.sql.txt regenerated so the CI drift gate (0c) stays honest.

CREATE TABLE IF NOT EXISTS user_project_access (
    user_id    UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, project_id)
);

-- The access check filters by user_id (PK prefix covers it); project-side lookups
-- ("who can see this project") need the reverse index.
CREATE INDEX IF NOT EXISTS idx_user_project_access_project
    ON user_project_access(project_id);

-- Seed: preserve current de-facto access for existing ACTIVE NON-ADMIN users.
-- Admins bypass in code and are deliberately NOT seeded.
INSERT INTO user_project_access (user_id, project_id, granted_by)
SELECT u.id, p.id, NULL
FROM admin_users u
CROSS JOIN projects p
WHERE u.is_active = true
  AND COALESCE(u.role, '') <> 'admin'
ON CONFLICT (user_id, project_id) DO NOTHING;
