-- ROLLBACK for 075_user_project_access.sql
--
-- Drops the per-user project access table. ONLY safe if the command backend deployed
-- alongside it has also been rolled back (the enforcing projectContextMiddleware fails
-- closed — 500s on the access query — if this table is missing while that code runs).
DROP INDEX IF EXISTS idx_user_project_access_project;
DROP TABLE IF EXISTS user_project_access;
