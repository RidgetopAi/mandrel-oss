-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 108 — drop api_tokens
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ EFFECT: every issued API token stops authenticating immediately, and the rows (hashes,
-- names, last-used times) are destroyed. Customers whose Punch List loop runs on one of these
-- tokens lose access until they are given another credential. The code paths that read the
-- table must be rolled back FIRST (an mcp-server that still looks up `mdl_` tokens against a
-- missing table answers 503 for those requests — fail-closed, never open).

BEGIN;

DROP INDEX IF EXISTS public.idx_api_tokens_user_created;
DROP INDEX IF EXISTS public.idx_api_tokens_token_hash;
DROP TABLE IF EXISTS public.api_tokens;

COMMIT;
