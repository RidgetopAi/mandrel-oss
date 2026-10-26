-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 108 — api_tokens: per-user API tokens that authenticate /mcp and /mcp/tools/*
--        (an earlier decision — hosted sign-up)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- A hosted customer's unattended Punch List loop needs a MANDREL_TOKEN. The operator's call: the
-- ONLY way a customer gets one is Settings → API tokens in their own dashboard, never email.
-- The Command backend mints a token for the LOGGED-IN user (admin_users — the identity the
-- Command UI session authenticates), shows the plaintext exactly once, and stores only its
-- SHA-256. The mcp-server's /mcp guards hash a presented `mdl_…` bearer, look the hash up
-- here, and attribute the request to the owning user's username.
--
-- WHY user_id → admin_users AND NOT the better-auth "user" table: the create/list/revoke
-- endpoints sit behind the Command UI's logged-in session, and that session is an
-- admin_users row (mandrel-command/backend/src/middleware/auth.ts). The better-auth user is
-- a separate login with no Command UI session and no key shared with admin_users (an email
-- match is not a key). The owner of a token must be the principal that can SEE and REVOKE it.
--
-- WHY token_hash IS A HEX CHECK: the column can only hold a 64-char lower-case hex digest.
-- A plaintext `mdl_…` token can never be stored here by a future code path — the insert
-- fails. This is the lowest-layer guard against "plaintext stored instead of hash".
--
-- WHY A FAST HASH (SHA-256) AND NOT bcrypt/scrypt: the token carries 256 bits from a CSPRNG,
-- so a preimage search is infeasible at any hash speed; slow KDFs exist to protect
-- LOW-entropy secrets (passwords). An unsalted deterministic digest is also what makes the
-- lookup an indexed equality (the UNIQUE index below) instead of a scan-and-verify.
--
-- ON DELETE CASCADE: deleting a user deletes their tokens. A deactivated user
-- (is_active=false) keeps their rows but is refused at verification time (the verifier
-- joins on is_active).
--
-- IDEMPOTENT: CREATE … IF NOT EXISTS throughout; safe to re-run. Purely additive.
-- ROLLBACK: rollback/108_api_tokens_ROLLBACK.sql (DROP TABLE — every issued token stops
-- authenticating, which is the intended effect of rolling this back).

BEGIN;

CREATE TABLE IF NOT EXISTS public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
    name character varying(100) NOT NULL,
    token_hash character(64) NOT NULL,
    display_prefix character varying(16) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NULL,
    revoked_at timestamptz NULL,
    expires_at timestamptz NULL,
    CONSTRAINT api_tokens_token_hash_hex_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT api_tokens_name_nonblank_check CHECK (length(btrim(name)) > 0)
);

-- The verification lookup: one indexed equality on the digest. UNIQUE also makes a
-- (cosmically unlikely) collision an insert failure rather than an ambiguous match.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash
    ON public.api_tokens (token_hash);

-- The Settings list + the per-user cap count.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_created
    ON public.api_tokens (user_id, created_at DESC);

COMMIT;
