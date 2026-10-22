-- Migration 091: THE LEXICAL LAYER — an identifier-preserving tsvector next to a prose one,
-- on contexts, technical_decisions and tasks.
-- (SEARCH P2a, design spike an earlier note.)
--
-- ══ WHY THE OBVIOUS BUILD IS WRONG ═══════════════════════════════════════════════════════
-- "Add a tsvector column and a GIN index" would make our WORST case worse, and it took a
-- measurement to see it. The default parser treats `_` as BLANK:
--
--   to_tsvector('english','MANDREL_SEARCH_MIN_SIMILARITY')
--     → 'mandrel':1 'search':2 'min':3 'similar':4
--
-- A globally unique identifier is shredded into the four commonest words in this corpus, so
-- searching for it returns everything. `ts_debug` shows four `asciiword` tokens — it is the
-- PARSER, not the dictionary, which is why swapping to the `simple` configuration changes
-- nothing (measured: it splits identically). The same class of failure hits file:line refs,
-- which tokenise differently in a document (`services/anchorgate.ts` + `122`) than in a
-- query (`anchorgate.ts:122`), so those never match either.
--
-- So each table gets TWO tsvectors: `search_tsv` (prose, ordinary english stemming) and
-- `search_idents` (identifier tokens, VERBATIM). The second is the one that makes a unique
-- string behave like a unique string.
--
-- ══ THE TWO MECHANICS THAT ARE LOAD-BEARING, NOT STYLE ═══════════════════════════════════
-- Both measured, both fail SILENTLY if changed:
--   * DOCUMENT side — inject with `array_to_tsvector(ARRAY[tok, ...])`. `to_tsvector()`
--     RE-PARSES its input and re-splits on `_`, which puts you back exactly where you
--     started. `array_to_tsvector` takes the strings as given.
--   * QUERY side — build the tsquery by CASTING A QUOTED LITERAL, `'<tok>'::tsquery`.
--     `to_tsquery()` re-parses too. Measured: the cast matches, `to_tsquery` does not.
--     (The query side is not in this file; it is services/absentTerms.ts and, in P2b,
--     search itself. It is stated here because this column is unusable without it.)
--
-- ══ GENERATED COLUMNS, NOT A TRIGGER — and why ═══════════════════════════════════════════
-- The requirement is that these stay correct on UPDATE, not only on INSERT. A trigger can do
-- that; a trigger can also be dropped, disabled (`ALTER TABLE ... DISABLE TRIGGER`), or
-- silently skipped by a `COPY` that another migration writes — and when it is, the column
-- keeps its stale value and looks fine. A STORED GENERATED column cannot drift: Postgres
-- recomputes it on every INSERT and every UPDATE, it cannot be written to directly at all,
-- and there is no enable/disable switch to get out of step with. Fewer moving parts and one
-- less thing that can be true in staging and false in prod.
--
-- THE PRICE, stated plainly: a generated expression that THROWS rejects the WRITE. That is
-- why `mandrel_search_tsv()` truncates (below) — without it a large enough document makes
-- `to_tsvector` raise `string is too long for tsvector` and `context_store` starts failing.
--
-- ⚠️ THE SECOND PRICE, AND IT IS A TRAP I WALKED INTO WHILE WRITING THIS FILE. A dependency
-- exists, but it is ASYMMETRIC, and the asymmetry is the wrong way round from what you would
-- guess. MEASURED on PostgreSQL 16.14 against a full corpus copy:
--   * `DROP FUNCTION mandrel_search_tsv(text)` while the columns exist is REFUSED —
--     "cannot drop function ... because other objects depend on it" (which is why the
--     rollback file drops columns FIRST; that order is mandatory, not stylistic).
--   * `CREATE OR REPLACE FUNCTION` with a DIFFERENT BODY is ALLOWED, and Postgres does NOT
--     recompute the stored columns. Measured: after replacing the body,
--     `SELECT mandrel_search_tsv(content) = search_tsv FROM contexts LIMIT 1` returns FALSE.
--     Every row silently keeps a value its own generation expression no longer produces.
-- So the correct way to change the pattern is: drop the columns, replace the function, re-add
-- the columns — a new migration, which is the right amount of ceremony for changing what the
-- whole corpus is indexed by. Nothing in Postgres FORCES that, so it is guarded instead:
-- src/tests/lexicalSearchSchema.contract.test.ts recomputes the expression over real rows and
-- fails if any stored value disagrees with what the current function produces.
--
-- ══ ONE DEFINITION, TWO LANGUAGES ════════════════════════════════════════════════════════
-- The pattern, the text-search configuration, the truncation budget and the token-length
-- bound below are the SAME values as mcp-server/src/config/lexicalSearchConfig.ts. They are
-- duplicated here because a migration is static SQL and cannot import TypeScript — so the
-- duplication is BOUND BY A TEST rather than by hope:
-- src/tests/lexicalSearchSchema.contract.test.ts reads `pg_get_functiondef` out of the live
-- database and asserts it carries exactly the config's values, and
-- src/tests/lexicalTokens.contract.test.ts runs the Postgres and JavaScript extractors side
-- by side over real corpus rows and fails on any disagreement. If you edit a literal here,
-- edit the config — the tests will tell you immediately if you did not.
--
-- ⚠️ THE ALTERNATION ORDER IN THE PATTERN IS LOAD-BEARING. Postgres uses POSIX leftmost-
-- LONGEST matching; JavaScript uses leftmost-FIRST-alternative. With SCREAMING_SNAKE listed
-- first, `ABC_DEF.ts` yields `abc_def.ts` in Postgres and `ABC_DEF` in JavaScript — the two
-- halves of "one definition" quietly disagree. Listing the file.ext alternative FIRST makes
-- JavaScript's first match coincide with Postgres's longest match; Postgres is unaffected by
-- the order (longest-match is order-independent), which was verified on the real corpus.
--
-- ══ NO BACKFILL STEP, AND THEREFORE NO ABORT GUARD ═══════════════════════════════════════
-- `ADD COLUMN ... GENERATED ALWAYS AS ... STORED` computes the value for every existing row
-- as part of the table rewrite — the backfill IS the ALTER. There is nothing to reconstruct,
-- so there is nothing that can be reconstructed PARTIALLY, so there is no state worth
-- aborting a boot for. (`docker-entrypoint.sh` runs migrations under `set -e` before exec'ing
-- the server, so a `RAISE EXCEPTION` here is a fleet-wide boot loop; 090's header has the
-- full reasoning. It does not apply to this file, and that is worth saying out loud.)
--
-- MEASURED apply cost, on a full copy of the prod corpus (10,438 contexts / 874 decisions /
-- 3,530 tasks) — see the task's report for the exact commands and output.
--
-- SCHEMA CONTRACT: the CI gate STAGE 0c diffs a fresh migrate against
-- scripts/schema-reference.sql.txt. This migration ships with that reference REGENERATED
-- (`bash scripts/schema-contract.sh regenerate`) and committed in the same commit.
--
-- Numbered ABOVE BASELINE_THROUGH (42) so it runs on fresh builds AND on existing/baselined
-- instances via the standard db:migrate runner.
--
-- ROLLBACK: rollback/091_lexical_search_columns_ROLLBACK.sql. Fully reversible — the columns
-- are a pure function of columns that already existed, so a rollback destroys no information
-- that is not recomputable by re-running this file.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. THE PROSE VECTORIZER
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- `left(txt, 65536)` is not cosmetic. `to_tsvector` THROWS
-- `string is too long for tsvector (N bytes, max 1048575 bytes)` past its limit, and in a
-- GENERATED column a throw rejects the INSERT. `contexts.content` is TEXT with a validator
-- ceiling of 5,000,000 chars (config/fieldLimits.ts), so the input can reach it.
--
-- 65536 CHARACTERS, chosen against the MULTI-BYTE worst case because `left()` counts
-- characters and the byte limit counts bytes. Measured on PostgreSQL 16.14, tsvector bytes
-- produced per input character: 0.087 (ascii 1-char words) · 0.292 (ascii unique 2-char) ·
-- 2.081 (3-byte CJK 1-char) · 3.912 (4-byte CJK 1-char) · 4.667 (3-byte CJK 2-char) ·
-- 5.333 (4-byte CJK 2-char, the worst observed). Rounding to 6: 65536 × 6 = 393,216 bytes
-- against a 1,048,575-byte limit, a 2.7× margin. The largest content in the real corpus is
-- 57,192 characters, so nothing we have ever stored is truncated.
CREATE OR REPLACE FUNCTION mandrel_search_tsv(txt text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $fn$
  SELECT to_tsvector('english'::regconfig, left(txt, 65536));
$fn$;

COMMENT ON FUNCTION mandrel_search_tsv(text) IS
  'SEARCH P2a (migration 091): prose half of the lexical layer. english stemming over the '
  'first 65536 characters. The bound is REQUIRED, not tidiness: to_tsvector throws past '
  '1048575 bytes and this feeds a GENERATED column, where a throw rejects the write. '
  'Mirrors LEXICAL_SEARCH_CONFIG.tsConfig / .indexMaxChars in '
  'mcp-server/src/config/lexicalSearchConfig.ts.';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 2. THE IDENTIFIER EXTRACTOR
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Three shapes, and only three, because these are the shapes the parser destroys and that we
-- actually type at each other:
--   file.ext[:line]   anchorGate.ts:122   (matching the TAIL of `services/anchorGate.ts:122`
--                     is exactly why a query for the bare form finds the document form)
--   SCREAMING_SNAKE   MANDREL_SEARCH_MIN_SIMILARITY
--   7-40 char hex     5320bd9 / a commit sha / a record id prefix
--
-- `length(...) <= 128` bounds the unbounded head of the file.ext alternative: a pathological
-- document can otherwise produce a multi-kilobyte "identifier" that bloats the index for
-- nobody's benefit. DISTINCT keeps the array small; array_to_tsvector would dedupe anyway.
-- COALESCE over the aggregate is what makes a document with NO identifiers return an EMPTY
-- tsvector rather than NULL — a NULL there would be a third state for every consumer to
-- handle, and 'no identifiers' is a perfectly ordinary answer, not a missing one.
CREATE OR REPLACE FUNCTION mandrel_search_idents(txt text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $fn$
  SELECT array_to_tsvector(
    COALESCE(
      (SELECT array_agg(DISTINCT lower(m[1]))
         FROM regexp_matches(
                left(txt, 65536),
                '([A-Za-z][A-Za-z0-9_]*\.[a-z]{1,4}(?::[0-9]+)?|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}|\m[0-9a-f]{7,40}\M)',
                'g') AS m
        WHERE length(m[1]) <= 128),
      ARRAY[]::text[]));
$fn$;

COMMENT ON FUNCTION mandrel_search_idents(text) IS
  'SEARCH P2a (migration 091): identifier half of the lexical layer. Extracts file.ext[:line], '
  'SCREAMING_SNAKE and 7-40 char hex tokens and indexes them VERBATIM via array_to_tsvector '
  '(to_tsvector would re-parse and re-split on underscore, which is the bug this exists to '
  'fix). Alternation order is load-bearing: file.ext FIRST so JavaScript leftmost-first '
  'agrees with POSIX leftmost-longest. Mirrors LEXICAL_SEARCH_CONFIG.identifierPatternPg / '
  '.identifierMaxLength in mcp-server/src/config/lexicalSearchConfig.ts.';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 3. THE COLUMNS
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The text expression fed to each pair is THE SAME ONE that table's search already reads:
--   contexts            content                                    (the searched body)
--   technical_decisions title + description + rationale + problem_statement
--                       (handlers/decisions.ts word_similarity expression, verbatim)
--   tasks               title + description
--                       (handlers/tasks.ts word_similarity expression, verbatim)
-- Same coalesce()s and same ' ' joiners as the handlers, so a term that is lexically present
-- here is a term that is textually present there.
--
-- NOTE, NOT ADDRESSED HERE (P2a changes no search behaviour, and removing an index is a
-- behaviour change to a shipped surface): `technical_decisions` ALREADY carries an
-- expression index `idx_technical_decisions_content_fts` over
-- `to_tsvector('english', title || ' ' || description || ' ' || rationale || ' ' ||
-- COALESCE(problem_statement,''))` — the same prose vector this migration now stores as a
-- column, minus the coalesce()s on the first three fields and minus the truncation. So that
-- table has two prose indexes for a while. P2b, which decides what search actually reads,
-- is the right place to retire whichever one loses.

ALTER TABLE contexts
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (mandrel_search_tsv(content)) STORED,
  ADD COLUMN IF NOT EXISTS search_idents tsvector
    GENERATED ALWAYS AS (mandrel_search_idents(content)) STORED;

ALTER TABLE technical_decisions
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (mandrel_search_tsv(
      coalesce(title,'') || ' ' || coalesce(description,'') || ' ' ||
      coalesce(rationale,'') || ' ' || coalesce(problem_statement,''))) STORED,
  ADD COLUMN IF NOT EXISTS search_idents tsvector
    GENERATED ALWAYS AS (mandrel_search_idents(
      coalesce(title,'') || ' ' || coalesce(description,'') || ' ' ||
      coalesce(rationale,'') || ' ' || coalesce(problem_statement,''))) STORED;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (mandrel_search_tsv(
      coalesce(title,'') || ' ' || coalesce(description,''))) STORED,
  ADD COLUMN IF NOT EXISTS search_idents tsvector
    GENERATED ALWAYS AS (mandrel_search_idents(
      coalesce(title,'') || ' ' || coalesce(description,''))) STORED;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 3b. AMENDING `bump_tasks_version` — REQUIRED, not housekeeping
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- ⚠️ CAUGHT BY THE SUITE, NOT ANTICIPATED. `tasks` carries a BEFORE UPDATE trigger
-- (migration 067, amended by 078) whose whole job is to bump `version` only when a write
-- changed AUTHORED state. It decides that by copying NEW into a `public.tasks` probe,
-- neutralising the SERVER-DERIVED columns, and asking whether the probe still differs
-- from OLD.
--
-- A STORED GENERATED column is computed AFTER BEFORE-triggers run, so inside this trigger
-- NEW.search_tsv is NULL while OLD.search_tsv holds the previous value. Every UPDATE
-- therefore looked like a change, and the trigger bumped `version` on writes that authored
-- nothing — exactly the defect 078 exists to prevent. MEASURED before this block was added:
-- 3 failures in the existing suite — declaredLimbsRederive.contract.test.ts ("a
-- derived-column-only UPDATE does NOT bump version": expected 1, got 2; "one task_update =
-- exactly ONE bump": expected 2, got 4) and taskAtomicClaim.contract.test.ts ("the TRIGGER
-- owns the bump": expected 2, got 3). `version` is the optimistic-lock token behind
-- task_claim's expectedVersion CAS, so an extra bump refuses a caller's claim for a change
-- that never happened.
--
-- The fix is the SAME move 078 made for declared_limbs, for the same reason: these columns
-- are a pure function of the row's own authored text and author nothing themselves. THE
-- POPULATION IS ONE FUNCTION, and that is a catalog fact rather than a memory —
-- `SELECT proname FROM pg_proc WHERE prosrc ILIKE '%IS NOT DISTINCT FROM OLD%'` returns
-- exactly `bump_tasks_version`. contexts and technical_decisions carry no whole-row
-- comparison (their only triggers are the id-only NOTIFY and the dual-write shadow), so
-- nothing else needs amending. src/tests/lexicalSearchSchema.contract.test.ts derives the
-- neutralisation set from the catalog and fails if a generated column is ever added to
-- `tasks` without being added here.
CREATE OR REPLACE FUNCTION public.bump_tasks_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  probe public.tasks;
BEGIN
  -- Compare the incoming row against the old one with ONLY the derived columns (and version
  -- itself) neutralised. If they are then identical, this UPDATE authored nothing.
  probe := NEW;
  probe.declared_limbs := OLD.declared_limbs;
  probe.declared_limbs_ambiguous_drops := OLD.declared_limbs_ambiguous_drops;
  -- Migration 091: STORED GENERATED columns are computed AFTER this BEFORE trigger, so NEW
  -- carries NULL for them here while OLD carries the stored value. Without these two lines
  -- every UPDATE reads as a change.
  probe.search_tsv := OLD.search_tsv;
  probe.search_idents := OLD.search_idents;
  probe.version := OLD.version;
  IF probe IS NOT DISTINCT FROM OLD THEN
    NEW.version := OLD.version;
    RETURN NEW;
  END IF;

  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 4. THE INDEXES
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- GIN, the standard access method for `tsvector @@ tsquery`. Unlike the ivfflat case that
-- migration 088's header argues at length, there is no "train it on data first" hazard here:
-- GIN is EXACT, not approximate, and an index built on a populated column (which these are,
-- immediately, because the columns are generated during the ALTER above) has nothing to
-- learn. Plain CREATE INDEX rather than CONCURRENTLY: these tables are thousands of rows,
-- the write lock is momentary, and CONCURRENTLY's constraints are not worth inheriting.

CREATE INDEX IF NOT EXISTS idx_contexts_search_tsv    ON contexts            USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_contexts_search_idents ON contexts            USING gin (search_idents);
CREATE INDEX IF NOT EXISTS idx_decisions_search_tsv   ON technical_decisions USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_decisions_search_idents ON technical_decisions USING gin (search_idents);
CREATE INDEX IF NOT EXISTS idx_tasks_search_tsv       ON tasks               USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_tasks_search_idents    ON tasks               USING gin (search_idents);

DO $$
BEGIN
  RAISE NOTICE '✅ 091 lexical layer: search_tsv + search_idents (GENERATED STORED) + GIN indexes on contexts, technical_decisions, tasks. Backfilled by the ALTER itself. DARK until MANDREL_LEXICAL_SEARCH_ENABLED — P2a changes no search behaviour.';
END $$;
