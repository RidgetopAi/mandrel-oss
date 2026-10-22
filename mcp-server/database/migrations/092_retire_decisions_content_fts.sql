-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 092 — RETIRE idx_technical_decisions_content_fts
-- (SEARCH P2b. Migration 091 left this decision to this phase
--  explicitly: "P2b, which decides what search actually reads, is the right place to retire
--  whichever one loses.")
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- WHAT IT IS. A GIN expression index created in migration 004 over
--   to_tsvector('english', title || ' ' || description || ' ' || rationale || ' '
--                          || COALESCE(problem_statement,''))
-- i.e. the same prose vector migration 091 now stores as the GENERATED COLUMN
-- technical_decisions.search_tsv.
--
-- ═══ WHY IT GOES, MEASURED RATHER THAN PREFERRED ═══
-- Removing an index is a change to a shipped surface, so this is settled with numbers, and
-- the numbers were read on LIVE PROD (not the replica, whose statistics are a copy):
--
--   1. IT HAS NEVER BEEN READ. `pg_stat_user_indexes` on prod, counters never reset
--      (pg_stat_database.stats_reset IS NULL) and demonstrably alive — the same table's
--      other indexes carry 706,627 / 626,153 / 31,418 scans, 1,370,148 in total:
--          idx_technical_decisions_content_fts    idx_scan = 0
--      Zero of 1,370,148. This is the check that matters, because "no code queries it" is a
--      claim about a tree and this is a claim about what actually ran.
--
--   2. NOTHING CAN USE IT. The planner matches an expression index only to that EXPRESSION.
--      No query in the repo applies `to_tsvector(...)` to technical_decisions — P2b's
--      services/lexicalSearch.ts reads the stored `search_tsv` COLUMN, which the planner
--      serves from idx_technical_decisions_search_tsv (migration 091), never from this one.
--      Which is why (1) will stay 0 after this phase ships rather than starting to move.
--
--   3. THE REPLACEMENT IS A SUPERSET, NOT A SIDEWAYS MOVE. `search_tsv` coalesces ALL four
--      fields; this expression coalesces only problem_statement, so a NULL title,
--      description or rationale makes the whole concatenation NULL and the row unindexed.
--      Measured on prod: 0 of 879 decisions are NULL under the old expression TODAY — so
--      nothing is lost by the swap right now, and the hole is a latent one the new column
--      does not have.
--
--   4. IT COSTS. 1,416 kB on prod, and GIN maintenance on every INSERT/UPDATE of a table
--      whose rows are large text. An index that is written on every decision and read never
--      is pure write amplification.
--
-- ═══ WHAT WOULD MAKE THIS WRONG ═══
-- An out-of-tree consumer — a psql session, a report, an operator's ad-hoc query — that
-- writes the `to_tsvector(...)` expression by hand. Point (1) is the evidence against that:
-- such a query would have registered a scan, and across the full life of the counters there
-- are none. If one appears, the rollback below restores the index byte-identically.

DROP INDEX IF EXISTS idx_technical_decisions_content_fts;

DO $$
BEGIN
  RAISE NOTICE '✅ 092: retired idx_technical_decisions_content_fts (0 of 1,370,148 index scans on technical_decisions over the life of prod stats; superseded by search_tsv + idx_technical_decisions_search_tsv from migration 091).';
END $$;
