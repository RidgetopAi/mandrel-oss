-- ROLLBACK for migration 091_lexical_search_columns.sql
--
-- WHAT IT DOES: restores `bump_tasks_version` to its migration-078 body, then drops the six
-- GENERATED columns 091 added (their GIN indexes go with them automatically — dropping a
-- column drops every index over it), then the two extractor functions.
--
-- ⚠️ ORDER IS MANDATORY, NOT STYLISTIC. A STORED GENERATED column records a hard dependency
-- on the function in its expression, so `DROP FUNCTION mandrel_search_tsv(text)` while any
-- of these columns exists is REFUSED with "cannot drop function ... because other objects
-- depend on it". Columns first, functions last. (`CASCADE` would also work and is exactly
-- what we do not want here: it would silently drop anything else that had come to depend on
-- these functions, which is the opposite of a reversible rollback.)
--
-- WHAT IT COSTS: nothing that exists only here. Every value in these columns is a pure
-- function of columns that already existed (`contexts.content`, the decision/task text
-- fields), so re-running 091 restores the exact same bytes. What is lost is the ALTER's
-- compute time — measured at well under a minute on a full copy of the prod corpus.
--
-- ORDER OF OPERATIONS IF P2b IS LIVE: turn `MANDREL_LEXICAL_SEARCH_ENABLED` off FIRST (it is
-- config, revertable on its own), THEN run this. Dropping the columns out from under an
-- enabled lexical layer turns every search into an error instead of a degraded result.
-- P2a itself never reads them, so on a P2a-only deployment this ordering is moot.
--
-- Uses IF EXISTS throughout: safe to run against an instance that never got 091.

-- ⚠️ FIRST, RESTORE `bump_tasks_version` TO ITS MIGRATION-078 BODY. 091 amended it to
-- neutralise the two generated columns; plpgsql resolves `probe.search_tsv` at RUN time, so
-- if the columns are dropped while the 091 body is installed, EVERY UPDATE of `tasks` throws
-- "record probe has no field search_tsv". Restoring first leaves a brief window where the
-- columns still exist and an authored-nothing UPDATE would over-bump `version` by one — the
-- 078 defect, for the seconds this script takes. That is the strictly better of the two
-- orderings: a transient off-by-one on an optimistic-lock counter versus a hard error on
-- every task write.
CREATE OR REPLACE FUNCTION public.bump_tasks_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  probe public.tasks;
BEGIN
  probe := NEW;
  probe.declared_limbs := OLD.declared_limbs;
  probe.declared_limbs_ambiguous_drops := OLD.declared_limbs_ambiguous_drops;
  probe.version := OLD.version;
  IF probe IS NOT DISTINCT FROM OLD THEN
    NEW.version := OLD.version;
    RETURN NEW;
  END IF;

  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

ALTER TABLE contexts            DROP COLUMN IF EXISTS search_idents;
ALTER TABLE contexts            DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS search_idents;
ALTER TABLE technical_decisions DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE tasks               DROP COLUMN IF EXISTS search_idents;
ALTER TABLE tasks               DROP COLUMN IF EXISTS search_tsv;

DROP FUNCTION IF EXISTS mandrel_search_idents(text);
DROP FUNCTION IF EXISTS mandrel_search_tsv(text);

DO $$
BEGIN
  RAISE NOTICE '↩️  091 rolled back: search_tsv + search_idents columns, their GIN indexes, and both extractor functions removed. Re-run 091 to restore (every value is recomputable; no pre-existing data was touched).';
END $$;
