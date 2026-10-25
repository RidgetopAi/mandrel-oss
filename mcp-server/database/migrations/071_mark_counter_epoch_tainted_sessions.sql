-- Migration 071: mark sessions whose persisted productivity_score predates the counter fix
-- Session-counter task §10 — "Decide explicitly: recompute, or mark epoch-tainted. Do not drift."
--
-- ── THE DECISION: MARK EPOCH-TAINTED. DO NOT RECOMPUTE. DO NOT NULL. ────────────────────
--
-- WHAT IS ACTUALLY TAINTED (measured on prod 2026-07-26, read-only, not what the spec
-- assumed). The spec said the score is "computed from zeroed tasks and tokens". It is not:
-- calculateBasicProductivity is (contexts*2 + decisions*3) / (hours + 1) — it reads neither
-- tasks nor tokens. The real defects were different and WIDER:
--
--   1. `decisions_created` was STRUCTURALLY 0 in the formula for every session ever scored.
--      SessionRepo.getSessionData hard-codes `decisions_created: 0, // Filled by caller`
--      and endSession never filled it, so the entire decisions term was dead. 24 of the 114
--      finalized prod sessions have decisions the formula ignored.
--   2. The contexts term used a project-guarded count (c.project_id = s.project_id), which
--      differs from the session's true context count on 14 of those 114 rows.
--
--   Net: recomputing today's formula over today's data would CHANGE 42 of the 100 scored
--   `ended` rows (all four numbers measured on prod, query in the task report).
--
-- WHY NOT RECOMPUTE: the formula changed MEANING in this same commit — the decisions term
-- went from structurally-dead to live. Writing new-formula numbers onto old rows with no
-- marker means no future reader can tell which epoch a score came from; a plausible number
-- that silently answers a different question is the exact failure mode this task exists to
-- remove. The marker below makes a later recompute SAFE and targeted, so recompute stays
-- available — it just stops being a silent one.
--
-- WHY NOT NULL THE SCORE: it would destroy the only record of what the product actually
-- reported, and it would not even read as "unknown" — the list serializer does
-- `row.productivity_score?.toString() || '0'`, so a NULL renders as "0", i.e. the same lie
-- with less information. Honest NULL semantics is a wider change than this task's blast
-- radius, and it is a display decision, not a data-integrity one.
--
-- SCOPE OF THE STAMP: `status = 'ended'` is exactly the set that went through
-- SessionRepo.finish() (finish is the only writer of that status; the reaper writes
-- 'inactive' and the dormanter writes 'dormant', and neither calls finish or scores).
--
-- WHAT ACTUALLY KEEPS THIS OFF POST-FIX SESSIONS — and what does NOT. Two real
-- protections, and one line that is NOT one:
--   1. RUN-ONCE. This is a numbered migration; the runner applies it exactly once per
--      database, at the deploy that carries the fix. Sessions finalized AFTER that
--      moment are never seen by this statement at all. This is the primary protection
--      and it is what makes the ordering (migrate, then restart onto the fixed code)
--      load-bearing.
--   2. THE METADATA GUARD (`NOT (metadata ? 'counters_epoch')`). Idempotence: a re-run —
--      including the fleet re-running migrations on a container recreate — re-stamps
--      nothing and changes no row a second time.
--   3. `ended_at < NOW()` is NEITHER. It was previously described here as making the
--      migration "a no-op for any session finalized by the FIXED code". That claim was
--      FALSE: a row's `ended_at` is always in the past at the instant this runs, so the
--      predicate is a tautology with ZERO epoch discrimination. It is kept only as a
--      cheap sanity bound against a clock-skewed / future-dated `ended_at`, and it is
--      not what protects anything. (A real epoch cutoff would need a fixed timestamp
--      literal — deliberately not used, because the honest cutoff differs per database:
--      it is each one's own deploy instant, which is precisely what "run once, at
--      deploy" already encodes.)
--
-- The stamp is additive metadata only. It changes no counter, no score, no status.

BEGIN;

UPDATE sessions
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'counters_epoch', 'pre-3f9fb289',
      'counters_epoch_note',
        'Finalized before an earlier task. sessions.contexts_created / tasks_* / total_tokens '
        || 'on this row were absolute-SET from an in-memory delta and are unreliable; '
        || 'contexts/tasks/decisions are recomputable from the child tables, total_tokens is NOT '
        || '(no child table, no backfill possible — that history is lost). productivity_score '
        || 'was computed with a structurally-zero decisions term and a project-guarded context '
        || 'count; it is NOT recomputed here, deliberately.',
      'counters_epoch_stamped_at', to_jsonb(NOW())
    )
WHERE status = 'ended'
  AND ended_at IS NOT NULL
  AND ended_at < NOW()
  AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'counters_epoch');

COMMIT;
