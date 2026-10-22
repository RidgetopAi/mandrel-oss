-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 095 — The gemma ivfflat indexes are rebuilt over data that EXISTS.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ THE MECHANISM ═══
-- ivfflat picks its centroids ONCE, at CREATE INDEX time, by k-means over the rows present
-- at that moment. Migration 056 created both gemma indexes immediately after ADDing the
-- columns, so the columns were EMPTY. The rows were backfilled afterwards
-- (scripts/reembed-gemma.ts). An index built that way has centroids that describe nothing,
-- and every subsequent INSERT is assigned to a meaningless list.
--
-- pgvector says so itself at build time:
--   NOTICE:  ivfflat index created with little data
--   DETAIL:  This will cause low recall.
--
-- ═══ MEASURED COST OF THE DEFECT ═══
-- Reproduced on a throwaway DB loaded with all 11,100 real prod context vectors, 100
-- deterministic query vectors, recall vs an exact (off-index) ground truth. Two subjects,
-- identical data, identical lists=100 — the ONLY difference is whether the column held rows
-- when the index was built:
--
--   probes   built-on-EMPTY        built-on-DATA
--            r@10    r@50          r@10    r@50
--   1        0.4530  0.3024        0.8460  0.7128
--   5        0.7320  0.6272        0.9620  0.9044
--   10       0.8520  0.7830        0.9740  0.9528
--   20       0.9390  0.9032        0.9920  0.9876
--
-- At the production probes=10 that is recall@50 0.783 vs 0.953 — a fifth of the true
-- neighbours missing. It is also SLOWER, not just worse: 671ms vs 268ms for the same 100
-- queries, because the lopsided lists force more heap fetches per probe.
--
-- ═══ WHY lists STAYS AT 100 ═══
-- an earlier Task proposed lists = rows/1000 (~11 here). MEASURED, that is wrong, and the
-- naive rule is a trap at this table size. Same 11,100 rows, same probes=10, rebuilt:
--
--   lists   r@10    r@50    exec ms /100q   plan
--   100     0.9740  0.9528  268             Index Scan
--   33      0.9920  0.9866  756             Index Scan
--   11      0.9990  0.9988  6591            Seq Scan   <-- index ABANDONED
--
-- lists=11 only reaches 0.999 by ceasing to be an index: probes=10 of 11 lists covers ~91%
-- of the table, so the planner correctly stops using it and pays a full exact scan (25x the
-- latency). That is not a better index, it is no index. lists=100 is the measured optimum
-- of the four values tested, so 056's value is RE-JUSTIFIED rather than changed, and this
-- migration deliberately preserves it.
--
-- (The recall knob that IS worth moving is ivfflat.probes, not lists — at lists=100 the
-- knee is probes=20: r@50 0.9876 for 531ms/100q, still an Index Scan. That is a RUNTIME
-- config change on the two write-path ANN call sites, gated to the operator under an earlier task
-- , and deliberately NOT made here.)
--
-- ═══ WHAT THIS MIGRATION DOES ═══
-- REINDEX both gemma indexes, which re-runs k-means over the rows now present. Idempotent:
-- reindexing an already-correct index is a no-op in effect, so this is safe to run on an
-- instance that has somehow already been rebuilt.
--
-- ═══ THE EMPTY-TABLE GUARD — THIS IS THE POINT ═══
-- A REINDEX of an EMPTY table reproduces migration 056's bug exactly: it retrains the
-- centroids on nothing. So a table with zero non-null embedding_gemma rows is SKIPPED, not
-- reindexed. Without this guard, running 095 on a fresh install would be a no-op at best
-- and would re-inflict the defect on any instance mid-backfill at worst.
--
-- ═══ LOCKING ═══
-- Plain REINDEX (not CONCURRENTLY) — the runner executes each migration file as one simple
-- multi-statement query, which Postgres wraps in an implicit transaction, and CONCURRENTLY
-- cannot run inside one. REINDEX takes ACCESS EXCLUSIVE on the INDEX (not the table): reads
-- and writes of the table continue; only plans wanting THIS index wait. Measured build cost
-- on 11,100 x 768d: ~13s. Every tenant is <=410 contexts, i.e. sub-second.
-- ═════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  spec   record;
  n_rows bigint;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('contexts',            'idx_contexts_embedding_gemma_cosine'),
      ('technical_decisions', 'idx_technical_decisions_embedding_gemma_cosine')
    ) AS t(tbl, idx)
  LOOP
    -- The index may legitimately be absent (an instance that never ran 056's CREATE, or a
    -- future migration that dropped it). Absent is not an error; it is nothing to rebuild.
    IF to_regclass('public.' || spec.idx) IS NULL THEN
      RAISE NOTICE '095: index % absent — nothing to rebuild.', spec.idx;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(embedding_gemma) FROM public.%I', spec.tbl) INTO n_rows;

    -- THE GUARD: never retrain centroids on an empty population. See header.
    IF n_rows = 0 THEN
      RAISE NOTICE '095: %.embedding_gemma has 0 populated rows — SKIPPING reindex of % '
                   '(rebuilding on an empty column is the very defect this migration fixes; '
                   'run 095 again after the gemma backfill).', spec.tbl, spec.idx;
      CONTINUE;
    END IF;

    RAISE NOTICE '095: rebuilding % over % populated rows in %.', spec.idx, n_rows, spec.tbl;
    EXECUTE format('REINDEX INDEX public.%I', spec.idx);
  END LOOP;
END $$;
