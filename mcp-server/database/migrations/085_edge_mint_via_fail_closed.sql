-- Migration 085: EDGE PROVENANCE, FAIL-CLOSED — links.mint_via (NOT NULL) + a GENERATED
-- provenance_class, replacing the created_by CASE as the single classifier.
-- (STRONG BONES SK4, an earlier spine.)
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────
-- "Which path minted this edge?" was recorded in `links.metadata` under FOUR different
-- keys (`source_tag`, `source`, `via`, `provenance`) by different call sites, and the
-- public `link` tool wrote NO label at all — it requires no metadata, so
-- `link(from, to, 'supersedes')` produced created_by='link', metadata='{}'. Measured on
-- prod before this migration: 611 of 4,183 recent edges (15%) carried no provenance signal.
-- A fact with four names and one hole is a fact you cannot query, and SK5's selection has
-- to query it.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────
--   1. ADDs `links.mint_via` and BACKFILLs it from what each historical row actually
--      recorded (never invented — see the mapping's own comments).
--   2. Makes it NOT NULL + non-empty, so an edge that names no mint path is UNWRITABLE by
--      any client, in any language, including raw SQL. This is the layer the TypeScript
--      required-parameter cannot reach.
--   3. ADDs `links.provenance_class` as a STORED GENERATED column over mint_via, and
--      RE-CREATES `link_provenance` (079, re-created by 081) to read it. The classification
--      now has ONE home, evaluated by Postgres, so the label and its class cannot drift.
--
-- ── WHY THE CLASSIFIER MOVES OFF created_by (the 079 decision, revisited) ─────────────
-- `created_by` is the MECHANISM STAMP ("who wrote it"); `mint_via` is the DERIVATION PATH
-- ("how the target was chosen"). They are close, and 079 used the former as a proxy for the
-- latter, but they are not the same axis and the proxy is measurably wrong in two places:
--
--   * `created_by='backfill'` (services/backfillTypedEdges.ts) is classified GUESSED by
--     079. That job mints by calling autoMintFromTags / autoMintFromDecision — i.e. from
--     THREADING TAGS and DECISION EVIDENCE IDS, which are at-origin-DECLARED signals. This
--     is the same reasoning 079 itself uses to place `backfill:task_tags` in the declared
--     bucket; the bare stamp simply predates that distinction. Under mint_via these rows
--     classify by what they were derived from (tag / decision-evidence) → DECLARED. That is
--     a deliberate correction, not a regression.
--   * `created_by='link'` is classified DECLARED by 079 — correct in intent (a human named
--     both endpoints) but it was, until SK4, the one stamp that could be minted carrying
--     zero provenance. It now carries mint_via='link-tool' at the route.
--
-- Nothing else changes bucket. Every other stamp's edges map to a via in the same class
-- 079/081 gave them; the executable pin is src/tests/linkProvenanceMeter.contract.test.ts.
--
-- `created_by` is KEPT and unchanged: it is still the mechanism-liveness signal the
-- dead-source alarm watches (services/provenanceAlarm.ts, link_provenance_weekly's
-- created_by grain), which is a different question from declared-vs-guessed. Two columns,
-- two questions, one classifier — not two classifiers.
--
-- ── ADDITIVE / IDEMPOTENT ────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS + a WHERE mint_via IS NULL backfill + CREATE OR REPLACE VIEW.
-- Re-running is a no-op — AND SO IS EDITING IT: on an already-migrated DB the IF NOT EXISTS
-- makes an edit to the provenance_class CASE below silently do nothing, so this file would
-- describe a classifier prod is not running. Change that expression in a NEW migration that
-- DROPs and re-ADDs the column, never here. The schema-contract reference
-- (scripts/schema-reference.sql.txt) is regenerated in the same commit.

ALTER TABLE links ADD COLUMN IF NOT EXISTS mint_via text;

-- ── THE BACKFILL ─────────────────────────────────────────────────────────────────────
-- Executed verbatim by the migration contract test, which reads THIS FILE between the
-- markers below and runs it against synthesized legacy rows. Do not copy this SQL into
-- TypeScript: one rule, one home (C5).
--
-- ORDER OF EVIDENCE, strongest first. Each arm reads a signal the row ITSELF recorded; a
-- row whose signals are all absent becomes 'legacy-unlabeled' rather than being assigned a
-- via by guesswork — an invented label would be indistinguishable from a real one and would
-- make the very count this task exists to produce a lie.
-- @sk4-backfill-begin
UPDATE links SET mint_via =
  CASE
    -- 1. An explicit metadata `via` (positionalMint, handoffSupersession) — already this
    --    exact vocabulary, so it carries across unchanged.
    WHEN metadata->>'via' IN ('position', 'trunk-ref', 'named-ref', 'handoff-timeline')
      THEN metadata->>'via'
    -- 2. An explicit metadata `source` (links.ts, threadInference, tasks.routes) — the same
    --    axis under a different name and a snake_case spelling; this is the rename.
    WHEN metadata->>'source' = 'links_param'           THEN 'links-param'
    WHEN metadata->>'source' = 'dependencies'          THEN 'task-dependencies'
    WHEN metadata->>'source' = 'decision_evidence'     THEN 'decision-evidence'
    WHEN metadata->>'source' = 'superseded_by'         THEN 'decision-superseded-by'
    WHEN metadata->>'source' = 'parent_task_id_param'  THEN 'parent-task-param'
    WHEN metadata->>'source' = 'inference'             THEN 'inference'
    -- 3. `source_tag` present ⇒ the tag path, whatever tag text it holds. The KEY is the
    --    evidence here; the VALUE is unbounded writer-supplied text and stays in metadata.
    WHEN metadata ? 'source_tag'                       THEN 'tag'
    -- 4. created_by, for the paths that recorded no metadata label at all. Only stamps
    --    whose derivation path is UNAMBIGUOUS appear here — created_by IS a recorded
    --    provenance signal, so reading it is not invention; reading an ambiguous one would
    --    be. ('auto:decision_record' spans three paths, so it is deliberately absent.)
    WHEN created_by = 'link'                           THEN 'link-tool'
    WHEN created_by = 'auto:belief-adjudicator'        THEN 'belief-adjudication'
    WHEN created_by = 'auto:inference'                 THEN 'inference'
    WHEN created_by = 'backfill:orphan-threads'        THEN 'inference'
    WHEN created_by = 'auto:handoff-supersession'      THEN 'handoff-timeline'
    -- 5. The RETIRED session anchor (dead 2026-07-28, 0/wk). Not mintable; classified
    --    GUESSED, unchanged from 079.
    WHEN created_by = 'auto:active_thread'             THEN 'anchor'
    -- 6. THE CLOSED LEGACY CLASS: no metadata label, no unambiguous stamp. Explicitly
    --    marked so it is countable and so it cannot be mistaken for a labelled edge:
    --      SELECT count(*) FROM links WHERE mint_via = 'legacy-unlabeled';
    --    It cannot grow — mint_via is NOT NULL below and no code path mints this value.
    ELSE 'legacy-unlabeled'
  END
WHERE mint_via IS NULL;
-- @sk4-backfill-end

ALTER TABLE links ALTER COLUMN mint_via SET NOT NULL;

-- Non-empty, on top of NOT NULL: '' would satisfy NOT NULL and mean nothing.
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_mint_via_nonempty;
ALTER TABLE links ADD CONSTRAINT links_mint_via_nonempty CHECK (btrim(mint_via) <> '');

COMMENT ON COLUMN links.mint_via IS
  'THE mint-path label: which derivation path chose this edge''s target. Vocabulary: src/config/edgeProvenanceConfig.ts (EDGE_MINT_VIA, mintable) + LEGACY_ONLY_MINT_VIA (anchor, legacy-unlabeled — historical only). NOT NULL: an edge that names no mint path cannot be written, by any client. provenance_class is GENERATED from this column.';

-- ── THE CLASSIFIER, now a generated column ───────────────────────────────────────────
-- One expression, evaluated by Postgres on write, indexable — so "declared or inferred?" is
-- a column read for SK5's selection instead of a jsonb parse or a view CASE, and the label
-- and its class are structurally incapable of disagreeing.
--
-- UNCLASSIFIED is the fail-closed default and MUST stay the ELSE arm: a via added in
-- TypeScript without being classified here lands in neither trusted bucket and is surfaced
-- by the meter. src/tests/linkProvenanceMeter.contract.test.ts asserts every mintable via
-- classifies out of it, so the omission goes RED at the gate rather than silently trusted.
ALTER TABLE links ADD COLUMN IF NOT EXISTS provenance_class text
  GENERATED ALWAYS AS (
    CASE
      WHEN mint_via IN (
             -- DECLARED — a human/agent explicitly NAMED the target.
             'tag',                      -- a threading tag names the record
             'links-param',              -- the explicit `links` argument
             'task-dependencies',        -- the task `dependencies` field
             'decision-evidence',        -- evidence ids in a decision's metadata
             'decision-superseded-by',   -- the decision's superseded_by column
             'parent-task-param',        -- task_create's explicit parentTaskId
             'position',                 -- declared/opened branch position (membership)
             'trunk-ref',                -- a task id named in the body of a trunk record
             'named-ref',                -- a single foreign task id named in the body
             'handoff-timeline',         -- predecessor structurally named by created_at
             'link-tool'                 -- both endpoints named by hand via the link tool
           ) THEN 'declared'
      WHEN mint_via IN (
             -- GUESSED — the system inferred which record to point at.
             'inference',                -- embedding-cosine nearest neighbour
             'belief-adjudication',      -- automated supersession verdict
             'anchor'                    -- the retired session anchor (079: a guess)
           ) THEN 'guessed'
      ELSE 'unclassified'                -- incl. 'legacy-unlabeled' and any unknown via
    END
  ) STORED;

COMMENT ON COLUMN links.provenance_class IS
  'THE declared-vs-guessed classification, GENERATED from mint_via (SK4, supersedes the created_by CASE of migrations 079/081 as the single source). declared = the target was explicitly named; guessed = the system inferred it; unclassified = fail-closed (unknown via, or the closed legacy-unlabeled class).';

CREATE INDEX IF NOT EXISTS idx_links_provenance_class ON links (provenance_class);
CREATE INDEX IF NOT EXISTS idx_links_mint_via ON links (mint_via);

-- ── THE VIEW (079 → 081 → here) ──────────────────────────────────────────────────────
-- link_provenance no longer classifies; it SELECTS the generated column. Every consumer
-- (provenanceMeter, provenanceAlarm, projectCoverageCore, search.routes, and the
-- link_provenance_weekly / _weekly_class rollups) keeps reading provenance_class from here,
-- unchanged, and now also gets mint_via.
--
-- CREATE OR REPLACE, AND mint_via APPENDED LAST — deliberately, not for tidiness. A
-- replacement may only APPEND columns, so putting mint_via in its natural place next to
-- created_by would force DROP ... CASCADE instead. That is not a cosmetic difference: this
-- view has FOUR dependents (link_provenance_weekly, link_provenance_weekly_class from 079,
-- and record_declared_inbound → zero_declared_inbound_weekly from 082), and a CASCADE takes
-- every one of them away silently, leaving whichever the author did not think to restate
-- simply missing. Measured while writing this migration: an earlier draft used CASCADE,
-- restated the two rollups it knew about, and dropped 082's two without a word — caught by
-- autoOpenPositions.contract.test.ts, not by anything in this file. Appending has no such
-- failure mode. Keep it appended.
CREATE OR REPLACE VIEW link_provenance AS
SELECT
  l.id,
  l.from_id,
  l.from_type,
  l.to_id,
  l.to_type,
  l.edge_type,
  l.project_id,
  l.created_at,
  l.created_by,
  l.provenance_class,
  l.mint_via
FROM links l;

COMMENT ON VIEW link_provenance IS
  'Edge provenance read surface. The classification itself is NO LONGER HERE (SK4): provenance_class is a GENERATED column on links, derived from links.mint_via, and this view selects it. Consumers are unchanged — they still read provenance_class from this view — and now also get mint_via (the derivation path) alongside created_by (the mechanism stamp). Supersedes the CASE in migrations 079 and 081.';

DO $$
DECLARE
  n_legacy bigint;
  n_total  bigint;
BEGIN
  SELECT count(*) FILTER (WHERE mint_via = 'legacy-unlabeled'), count(*)
    INTO n_legacy, n_total FROM links;
  RAISE NOTICE '✅ 085: links.mint_via NOT NULL + provenance_class GENERATED; link_provenance re-created. Legacy-unlabeled class CLOSED at % of % edges.', n_legacy, n_total;
END $$;
