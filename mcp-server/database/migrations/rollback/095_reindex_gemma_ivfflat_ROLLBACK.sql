-- ROLLBACK for 095 — intentionally a NO-OP.
--
-- 095 changes no schema: no column, constraint, index definition or reloption differs before
-- and after it. It only rebuilds the CONTENTS of two existing ivfflat indexes so their
-- centroids describe the rows that are actually present.
--
-- There is therefore nothing to undo, and nothing worth undoing: the "before" state is an
-- index whose centroids were trained on an empty column (measured recall@50 0.783 vs 0.953
-- at production probes=10 — see the 095 header). Deliberately reconstructing that state
-- would mean re-inflicting a measured recall defect on a live instance.
--
-- If a rebuilt index must genuinely be reverted, the honest operation is a targeted
-- `REINDEX INDEX <name>` at the desired moment, not a scripted downgrade.

DO $$
BEGIN
  RAISE NOTICE '095 ROLLBACK: no-op — 095 altered no schema, only ivfflat centroid contents.';
END $$;
