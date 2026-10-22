-- ROLLBACK for 104 — decision inbox (question/options/answer_status/…).
--
-- DATA-LOSS CAVEAT: if any row has actually used answer_status='open'/'discussing', or
-- carries a question/options/chosen/answer_note/deadline, that data is PERMANENTLY LOST by
-- this rollback (DROP COLUMN). Safe/no-op on a database where migration 104 shipped but no
-- caller ever wrote the new columns (every row still reads answer_status='decided' with the
-- other seven columns at their defaults).

BEGIN;

DROP INDEX IF EXISTS idx_technical_decisions_answer_status;

ALTER TABLE technical_decisions DROP CONSTRAINT IF EXISTS technical_decisions_answer_status_check;

ALTER TABLE technical_decisions DROP COLUMN IF EXISTS deadline;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS answer_note;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS answered_by;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS answered_at;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS chosen;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS options;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS question;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS answer_status;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '↩️  104 ROLLBACK: technical_decisions decision-inbox columns (answer_status/question/options/chosen/answered_at/answered_by/answer_note/deadline) dropped.';
END $$;
