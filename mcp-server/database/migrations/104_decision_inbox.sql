-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 104 — decision inbox: an OPEN decision carries a question + options with pros/cons
--       (Punch List)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHAT THIS ADDS ═══
-- `technical_decisions` gains an `answer_status` lane — open | discussing | decided — that
-- is ORTHOGONAL to both the existing `status` column (active/deprecated/superseded/
-- under_review — a RECORD lifecycle) and `outcome_status` (the learning-loop RESULT).
-- `answer_status` answers a third, different question: "has a human actually chosen an
-- option yet?" Alongside it: `question` (the one sentence being decided), `options` (jsonb
-- array of {key,label,pros,cons,recommended?}), and the answer/discuss bookkeeping —
-- `chosen`, `answered_at`, `answered_by`, `answer_note`, `deadline`.
--
-- ═══ WHY `answer_status` DEFAULTS TO 'decided' ═══
-- Every row that exists today, and every future `decision_record` call that never mentions
-- answer_status, must read as 'decided' — so the inbox (`decision_search({answerStatus:
-- 'open'})`) never surfaces a single legacy decision. This is the SAME "additive column,
-- DEFAULT preserves current behaviour" discipline migration 101 used for `tasks.stage`.
--
-- ═══ WHY THE INVARIANT ("an open decision carries a question + options") IS APP-LEVEL,
-- NOT A CHECK CONSTRAINT ═══
-- The rule ("open" requires a non-empty question AND >=2 options AND every option carries
-- >=1 pro and >=1 con) reaches INSIDE the `options` jsonb array — expressible in a Postgres
-- CHECK only via a brittle jsonb_path_exists/jsonb_array_length expression that duplicates
-- the same predicate the TypeScript validator (handlers/decisions.ts,
-- validateOpenDecisionShape) already enforces before the INSERT/UPDATE ever reaches SQL, and
-- that would surface a raw 23514 instead of the TYPED, field-naming refusal the punch
-- requires ("typed refusal naming the field... no row is written"). One source of truth,
-- enforced at the boundary the error message needs to come from.
--
-- ═══ WHY `chosen` IS `text`, NOT A FOREIGN KEY ═══
-- It names a `key` inside THIS row's own `options` jsonb array, not another table's row —
-- there is nothing to reference. Validity ("is this key one of the row's own options") is
-- enforced by `decision_answer` (handlers/decisions.ts) at write time.
--
-- Safe: purely additive (new columns + one partial index), reversible while no row has ever
-- used the new columns (the rollback DROPs them — see rollback/104_decision_inbox_ROLLBACK.sql
-- for the data-loss caveat on any row that HAS used them by the time of a rollback).

BEGIN;

ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS answer_status varchar(20) NOT NULL DEFAULT 'decided';
ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS question text;
ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS chosen text;
ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS answered_at timestamptz;
ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS answered_by text;
ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS answer_note text;
ALTER TABLE technical_decisions ADD COLUMN IF NOT EXISTS deadline timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'technical_decisions_answer_status_check'
  ) THEN
    ALTER TABLE technical_decisions
      ADD CONSTRAINT technical_decisions_answer_status_check
      CHECK (answer_status IN ('open', 'discussing', 'decided'));
  END IF;
END $$;

-- THE INBOX QUERY: "every decision waiting on a human" — open OR discussing, never decided.
-- Partial so a project with thousands of long-decided rows costs this index nothing.
CREATE INDEX IF NOT EXISTS idx_technical_decisions_answer_status
  ON technical_decisions (project_id, answer_status)
  WHERE answer_status <> 'decided';

COMMENT ON COLUMN technical_decisions.answer_status IS
  'The decision inbox lane: open | discussing | decided. DEFAULT decided — orthogonal to `status` (record lifecycle) and `outcome_status` (learning-loop result). An open row must carry a non-empty `question` and >=2 `options`, each with >=1 pro and >=1 con (enforced by handlers/decisions.ts, not a DB CHECK).';
COMMENT ON COLUMN technical_decisions.question IS
  'The one-sentence thing being decided. Required (non-empty) whenever answer_status=''open''.';
COMMENT ON COLUMN technical_decisions.options IS
  'jsonb array of {key, label, pros: string[], cons: string[], recommended?: boolean}. Required >=2 entries, each with >=1 pro and >=1 con, whenever answer_status=''open''.';
COMMENT ON COLUMN technical_decisions.chosen IS
  'The `options[].key` decision_answer selected. Set only once answer_status transitions to decided via decision_answer.';
COMMENT ON COLUMN technical_decisions.answered_at IS
  'When decision_answer was called. NULL until answered.';
COMMENT ON COLUMN technical_decisions.answered_by IS
  'The actor (X-Actor-ID) who called decision_answer. NULL until answered.';
COMMENT ON COLUMN technical_decisions.answer_note IS
  'Free-text note carried by decision_answer (folded into alternatives_considered.reasonRejected for every non-chosen option) and/or appended to by decision_discuss.';
COMMENT ON COLUMN technical_decisions.deadline IS
  'Optional: when this decision needs an answer by. Purely informational — nothing auto-transitions on it.';

COMMIT;

-- Verify
DO $$
DECLARE
  col_count integer;
BEGIN
  SELECT count(*) INTO col_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'technical_decisions'
     AND column_name IN ('answer_status', 'question', 'options', 'chosen', 'answered_at', 'answered_by', 'answer_note', 'deadline');
  IF col_count <> 8 THEN
    RAISE EXCEPTION '104_decision_inbox: expected 8 new columns on technical_decisions, found %', col_count;
  END IF;
  RAISE NOTICE '104: technical_decisions gained the decision-inbox columns (answer_status DEFAULT ''decided''); idx_technical_decisions_answer_status installed.';
END $$;
