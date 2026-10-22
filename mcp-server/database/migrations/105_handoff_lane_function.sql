-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 105 — mandrel_handoff_lane(): the workstream-lane rule for handoffs.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Handoff auto-supersession was project-wide, so a ws:research handoff superseded the live
-- ws:coordinator head. The lane rule lives HERE once; the prefix and default-lane name are ARGUMENTS
-- supplied from config/handoffLaneConfig.ts (no literal of either in SQL or in the service).
--
--   lane = value after `p_prefix` of the FIRST tag starting with it; none/empty -> p_default.
--
-- Pure and IMMUTABLE; CREATE OR REPLACE makes re-running a no-op. The data repair (deleting
-- cross-lane auto:handoff-supersession edges) is services/handoffLaneRepair.ts, run by
-- scripts/migrate.ts after the migrations — it needs the configured values, which a plain
-- SQL migration cannot read. Idempotent.
CREATE OR REPLACE FUNCTION mandrel_handoff_lane(p_tags text[], p_prefix text, p_default text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT NULLIF(substr(u.t, length(p_prefix) + 1), '')
       FROM unnest(COALESCE(p_tags, ARRAY[]::text[])) WITH ORDINALITY AS u(t, ord)
      WHERE left(u.t, length(p_prefix)) = p_prefix
      ORDER BY u.ord
      LIMIT 1),
    p_default)
$$;
