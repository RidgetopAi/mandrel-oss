-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 109 — one login: the Command dashboard authenticates through better-auth
--        (option A decided by the operator 2026-10-22)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- BEFORE: a hosted customer had two credentials. The welcome link set their better-auth
-- password (the OAuth login Claude Code / Claude.ai use); the Command dashboard had its own
-- admin_users login that the customer was never given — and Settings → API tokens lives
-- behind that dashboard login.
--
-- AFTER: an admin_users row may be LINKED to a better-auth user. A linked row is signed into
-- with the better-auth email + password (verified by better-auth itself, in the mcp-server;
-- the Command backend never sees a better-auth hash). admin_users stays the AUTHORIZATION
-- record — role, is_active, default project, preferences, project access, API tokens all
-- still key on admin_users.id — so nothing that references it moves. better-auth owns the
-- CREDENTIAL; admin_users owns what that identity may DO on this instance.
--
-- WHAT EACH STATEMENT IS FOR
--   auth_user_id           the link. NULL = a legacy dashboard-only login (prod's admin, a
--                          self-hoster's admin, every tenant's operator `admin`) — unchanged.
--                          UNIQUE: one dashboard row per better-auth user, so a sign-in can
--                          never resolve to two different authorizations.
--                          ON DELETE SET NULL: removing the better-auth user removes the link.
--   password_hash nullable a row created FOR a better-auth user has no dashboard password —
--                          there is nothing to verify locally, so nothing is stored.
--   has_credential CHECK   every row keeps at least one way in. It also turns the SET NULL
--                          above into a refusal for a password-less row: better-auth cannot
--                          delete a user whose dashboard row would be left with no credential
--                          (deactivate or delete the dashboard row first). Enforced HERE, at
--                          the lowest layer, so no code path can produce a dead row.
--   auth_session_id        a dashboard session opened through better-auth is BOUND to the
--                          better-auth session it was minted from. ON DELETE CASCADE: when
--                          better-auth ends that session — the customer spends a set-password
--                          link (revokeSessionsOnPasswordReset), or the session is deleted —
--                          the dashboard session row goes with it and the next request is 401.
--
-- NOBODY IS LOCKED OUT: every existing row keeps its password_hash and auth_user_id NULL, so
-- every existing dashboard login (and every API token those users own) works exactly as it
-- did. Linking is an explicit operator act (seed-first-oauth-user links the customer it
-- seeds), never inferred at sign-in time from a matching email.
--
-- The better-auth tables exist on every instance (migration 052 is a standard migration), so
-- the foreign keys below always have a target.
--
-- IDEMPOTENT: IF NOT EXISTS / guarded DO blocks throughout; safe to re-run.
-- ROLLBACK: rollback/109_dashboard_better_auth_login_ROLLBACK.sql.

BEGIN;

ALTER TABLE public.admin_users ADD COLUMN IF NOT EXISTS auth_user_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_auth_user_id_fkey'
  ) THEN
    ALTER TABLE public.admin_users
      ADD CONSTRAINT admin_users_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES public."user"(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_auth_user_id
    ON public.admin_users (auth_user_id)
    WHERE auth_user_id IS NOT NULL;

ALTER TABLE public.admin_users ALTER COLUMN password_hash DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_has_credential_check'
  ) THEN
    ALTER TABLE public.admin_users
      ADD CONSTRAINT admin_users_has_credential_check
      CHECK (password_hash IS NOT NULL OR auth_user_id IS NOT NULL);
  END IF;
END $$;

ALTER TABLE public.auth_tokens ADD COLUMN IF NOT EXISTS auth_session_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_tokens_auth_session_id_fkey'
  ) THEN
    ALTER TABLE public.auth_tokens
      ADD CONSTRAINT auth_tokens_auth_session_id_fkey
      FOREIGN KEY (auth_session_id) REFERENCES public."session"(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_auth_tokens_auth_session_id
    ON public.auth_tokens (auth_session_id)
    WHERE auth_session_id IS NOT NULL;

COMMIT;
