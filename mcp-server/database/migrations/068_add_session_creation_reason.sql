-- Migration 068: sessions.creation_reason — WHY this session row exists
-- (Amp-orb eval finding W3).
--
-- WHY (eval report `docs/amp-orb-eval/mandrel-orb-orchestration-baseline-2026-07-24.md`
-- lines 413-456, Priority 1): the evaluator could not verify ATTRIBUTION. The session tools
-- exposed only a truncated id, the project, and active/inactive — so there was no way to tell
-- whether a session existed because the orb EXPLICITLY started it or because a write lazily
-- minted one. Screenshot + timestamp correlation was the only recourse. W1 (atomic task claim,
-- an earlier change) and W2 (actor-bound session resolution) built the mechanism; this is the
-- instrument that lets an operator CHECK it.
--
-- WHY A COLUMN AND NOT A DERIVATION: "why does this row exist" is a fact known exactly once —
-- at INSERT, by the code path doing the inserting. Reconstructing it later from heuristics
-- (metadata.auto_created, a NULL connection_id, the row's shape) is guesswork that renders a
-- PLAUSIBLE answer when it does not know — precisely the silent failure this workstream exists
-- to kill. Stamped at the two INSERT sites, it is either recorded or explicitly NOT RECORDED.
--
-- THE VOCABULARY (single source in TypeScript: mcp-server/src/config/sessionIdentityConfig.ts
-- → SESSION_CREATION_REASONS; the CHECK below is kept in lockstep by
-- src/tests/sessionCreationReasonContract.contract.test.ts, which PARSES this file and compares
-- it to that constant — so neither copy can be weakened without the other going RED):
--   'explicit'         — a caller explicitly opened it (the session_start MCP tool, or the
--                        REST /api/v2/sessions/start).
--   'automatic-write'  — the lazy action gate minted it because a content-producing tool
--                        (context_store / task_create / decision_record) needed a session.
--   'reconnect'        — DECLARED BY THE CONTRACT, NOT CURRENTLY PRODUCED. Reserved for a
--                        resume path that MINTS a row. Measured on the 2026-07-25 tree: every
--                        reconnect/reattach path (SessionLifecycleService.getActiveSession
--                        step 2 → SessionRepo.findReattachable, and the actor-mode
--                        resolveSession pin/newest-open branches) RESUMES an existing row and
--                        inserts nothing, so no row can honestly be born 'reconnect' today.
--                        Admitting the value here means a future resume-that-mints path has a
--                        truthful value to write instead of inventing one.
--
-- NULL means NOT RECORDED — every row created before this migration. The read model reports
-- that explicitly ("NOT RECORDED — session predates creation-reason tracking"); it never
-- renders a blank or guesses a reason.
--
-- SCOPE — ADDITIVE, zero behavior change on deploy:
--   * ONE new NULLABLE TEXT column + ONE CHECK constraint. No index is added, dropped, or
--     re-keyed. No existing column, constraint, or query changes. Nothing READS this column
--     for behavior — it is observability only.
--   * The CHECK admits NULL, so every pre-existing row stays valid and the migration cannot
--     fail on real data. It is otherwise DENY-BY-DEFAULT: an unrecognized value is rejected by
--     Postgres, not silently stored (a past incident — unrecognized input must be a loud RED).
--
-- Idempotent / safe on fresh + existing: ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT.
-- 068 is ABOVE BASELINE_THROUGH (42), so it runs on BOTH fresh builds (after the 000 baseline)
-- and already-baselined instances. The schema-contract reference
-- (scripts/schema-reference.sql.txt) is regenerated to include the new column + constraint so
-- the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS creation_reason TEXT;

-- Deny-by-default value gate. NULL is admitted (= NOT RECORDED, every pre-068 row); anything
-- outside the declared vocabulary is a hard DB error rather than a silently-stored surprise.
-- Drop + re-add (a CHECK cannot be altered in place); DROP IF EXISTS makes it idempotent.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_creation_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_creation_reason_check
  CHECK (creation_reason IS NULL OR creation_reason = ANY (ARRAY[
    'explicit'::text,
    'automatic-write'::text,
    'reconnect'::text
  ]));

COMMENT ON COLUMN sessions.creation_reason IS
  'Amp-orb eval W3: WHY this session row exists, stamped at INSERT by the '
  'creating path. explicit = a caller opened it (session_start tool / REST start); '
  'automatic-write = the lazy action gate minted it for a content-producing write; reconnect = '
  'contract-declared but not currently produced (every reconnect path RESUMES an existing row). '
  'NULL = NOT RECORDED (a row created before this migration) — the read model says so '
  'explicitly rather than rendering a blank. Observability only: never read for behavior, '
  'never part of session resolution. Vocabulary single-sourced in '
  'src/config/sessionIdentityConfig.ts (SESSION_CREATION_REASONS), kept in lockstep with this '
  'CHECK by sessionCreationReasonContract.contract.test.ts.';
