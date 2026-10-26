-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 109 — unlink the dashboard from better-auth
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ EFFECT: dashboard rows created FOR a better-auth user (password_hash IS NULL) have no
-- other credential, so this rollback DELETES them. Their dashboard sessions (auth_tokens) are
-- deleted EXPLICITLY first — auth_tokens.user_id has no ON DELETE action, so a row that ever
-- signed in would otherwise block the delete (Reviewer F3). Their API tokens and
-- project grants go by cascade; their feedback rows / agent sessions keep the row with the
-- owner set to NULL. Those customers lose dashboard access and
-- their Punch List loop token until an operator gives them a dashboard password. Rows that
-- kept a password (every legacy admin, and any admin that was linked rather than created)
-- survive with their password login intact. Roll the code back FIRST: a Command backend that
-- still reads auth_user_id / auth_session_id against this schema answers 500 on login.

BEGIN;

DROP INDEX IF EXISTS public.idx_auth_tokens_auth_session_id;
ALTER TABLE public.auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_auth_session_id_fkey;
ALTER TABLE public.auth_tokens DROP COLUMN IF EXISTS auth_session_id;

DELETE FROM public.auth_tokens
 WHERE user_id IN (SELECT id FROM public.admin_users WHERE password_hash IS NULL);
DELETE FROM public.admin_users WHERE password_hash IS NULL;
ALTER TABLE public.admin_users DROP CONSTRAINT IF EXISTS admin_users_has_credential_check;
ALTER TABLE public.admin_users ALTER COLUMN password_hash SET NOT NULL;

DROP INDEX IF EXISTS public.idx_admin_users_auth_user_id;
ALTER TABLE public.admin_users DROP CONSTRAINT IF EXISTS admin_users_auth_user_id_fkey;
ALTER TABLE public.admin_users DROP COLUMN IF EXISTS auth_user_id;

COMMIT;
