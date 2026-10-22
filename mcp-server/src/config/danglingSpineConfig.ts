/**
 * A POSITION MAY NOT OUTLIVE ITS SPINE — the named rule (signal 2).
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. The rule lives here, as named
 * exports, beside the reason it exists.
 *
 * ── WHAT WAS MEASURED ────────────────────────────────────────────────────────────────
 * The coordinator, on its own prod session 2026-09-03:
 *
 *   graph({action:'branch_current'})   -> position cited an earlier task
 *   task({action:'details', f50b8f30}) -> {"ok":true,"found":false}
 *   context({action:'search', id:...}) -> "❌ Context not found"
 *
 * The API asserted `spineType: "task"` for an id that is not a task and is not anything.
 * Reproduced from a clean DB in tests/danglingSpine.contract.test.ts by the sequence that
 * actually produced it — open a position on a task, delete the task — which measured two
 * things, neither of them cosmetic:
 *   1. `branch_current` rendered the dead spine as an ORDINARY OPEN BRANCH (origin
 *      'declared', spineType 'task'), distinguishable from a healthy one only by a null
 *      title — and `spineTitle()` returns null for "no title" as well, so the two states
 *      shared one value (C1's third state: could-not-resolve wearing a real answer's face).
 *   2. A plain `context_store` from that position minted a REAL edge:
 *      `{edge_type: 'informs', created_by: 'auto:positional'}` pointing at a record that
 *      does not exist.
 *
 * (2) is the reason this is a data-integrity rule and not tidiness. Positional membership
 * is DECLARED and trust-bearing precisely so a reader can rely on it without discounting
 * it. A dangling position does not degrade to "no membership" — it degrades to
 * high-confidence membership of nothing, which is the one failure the mechanism was built
 * to be incapable of.
 *
 * ── WHY IT CAN HAPPEN AT ALL ─────────────────────────────────────────────────────────
 * `branch_open` validates its spine (services/spineResolver.ts), so a position is REAL when
 * taken. `branch_positions.spine_id` is then a SOFT reference — migration 080 says so in as
 * many words, "no FK; endpoints span three tables, same reasoning as links" — and nothing
 * deletes the row when the record goes. The soft reference is not the defect and is not
 * changed here: three-table endpoints genuinely cannot carry one FK. What was missing is
 * that NOTHING RE-CHECKED IT ON READ. A soft reference is a promise to validate at use.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────
 * THREE READS REVALIDATE, AND THEY ARE NAMED HERE RATHER THAN GENERALISED. This paragraph
 * used to open "every read of a position revalidates its spine", which was false: see the
 * exception below. A rule stated wider than the code is worse than a narrow one, because it
 * is the sentence that stops the next reader checking — the same defect this file's own
 * `spineLiveness` comment was rejected for claiming about an exhaustive switch.
 *
 * When the spine resolves to NO RECORD:
 *   • `branch_current` does NOT render it as a position, and does NOT smuggle it out under
 *     the trunk path's `revertedFrom` provenance field either (the exact shape signal 2 was
 *     observed in). It reports `danglingSpine` instead.
 *   • the WRITE path (services/positionalMint.ts) mints NO membership and NO edge, with
 *     reason MEMBERSHIP_SPINE_MISSING. Both ends are checked, root and tip.
 *   • `project_briefing`'s AMBIENT spine is refused with SPINE_REFUSAL.notFound — the same
 *     typed reason its explicit `spine` argument already returned. That route is the one a
 *     cold boot takes.
 * When the spine EXISTS BUT IS ARCHIVED, all three accept it and SAY SO
 * (`position.spineArchived` / `revertedFrom.spineArchived` / the briefing's `spineArchived`),
 * because an archived record is real and its branch still carries the work — what a caller
 * needs is to be able to reconcile it with a by-id read that returns nothing.
 *
 * WHAT DECIDES WHICH READS ARE IN THAT LIST — the line, so this does not have to be
 * rediscovered as a file enumeration that goes stale:
 *
 *   A position is revalidated where its spine is about to be USED — rendered as WHERE YOU
 *   ARE STANDING, or minted to. It is NOT revalidated where a position is reported as
 *   ABANDONED or as PRIOR STATE.
 *
 * The second group names a spineType too, so the "provenance is still an assertion about a
 * record" argument does reach it; what it cannot reach is any harm. Those ids are already
 * being left, nothing mints to them, and a caller's next act on one is a `branch_open`,
 * which resolves the id properly and refuses it if it is gone. Revalidating them would buy
 * a DB read per call to change nothing anyone routes on. The three, named so the claim above
 * is falsifiable rather than merely plausible:
 *   • `branch_open`'s `previousPosition` and its "(was: …)" pop-back hint — the position
 *     being replaced, in the same call that replaces it.
 *   • `branch_close`'s `closedPosition` — the position that was just deleted.
 *   • the byproduct-open read behind `byproductPositionLines`' KEPT / CONTESTED lines
 *     (services/positionalMint.ts) — a position being yielded to or contested, neither of
 *     which mints. A dangling spine reached this way is still caught on the very next write
 *     by the write-path rule above, and by `branch_current`.
 * If any of these ever becomes something a consumer routes on, it moves into the first list.
 *
 * (First written as "the ONE read that does not revalidate", naming only `branch_open`.
 * There were three. An enumeration is a count, and a count carries the command that produced
 * it: `grep -rn 'readPositionAny\|closePositionAny' src/ --include=*.ts` excluding tests and
 * the store itself, then reading each call site's render.)
 *
 * ── THE THREE OBSERVABLES MUST STAY DISTINCT ─────────────────────────────────────────
 * ABSENT (no row) · TRUNK (a row that mints nothing, whose spine_id is provenance) ·
 * DANGLING (a row whose spine is gone). A caller BRANCHES on these, so collapsing DANGLING
 * onto ABSENT would fix the wrong edge while hiding the reason a branch's work vanished —
 * "I opened a branch and my writes stopped threading" and "I never opened one" are
 * different problems with different fixes. Pinned by an executed probe rather than by this
 * paragraph: tests/danglingSpine.contract.test.ts asserts the two responses are NOT equal.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
 * It does not DELETE the offending row. Surfacing is the requirement; deleting would
 * destroy the only remaining evidence of which branch a confused session thought it was on,
 * and self-healing state a human is still trying to read is the clobber this house forbids.
 * `branch_close` already removes it in one call, and the response says so.
 */

/**
 * The membership outcome a write reports when the position's spine no longer resolves.
 * Named here rather than spelled inline at its two consumers (the outcome list and the
 * blocked-ladder arm) so the reason string cannot drift from the rule that produces it.
 */
export const MEMBERSHIP_SPINE_MISSING = 'spine-missing' as const;

/**
 * IS THE RULE IN FORCE? Default ON — a position that cannot name a real record must not
 * mint a trust-bearing edge, so the safe state is the enforcing one.
 *
 * The flag exists for the same reason its two siblings' do (positionKeyConfig,
 * positionContentionConfig): the rule adds a per-read existence lookup and changes a
 * rendering a client may already parse, and one env var must be able to restore the
 * previous behaviour whole. It is NOT a performance knob — the check is a single indexed
 * primary-key lookup on the one table the spine's type names.
 *
 * Read at CALL time, not at import time, so a probe can flip it without re-importing.
 */
export const DANGLING_SPINE_ENV = 'MANDREL_DANGLING_SPINE_REFUSED';

export function danglingSpineRefused(): boolean {
  return (process.env[DANGLING_SPINE_ENV] ?? 'true').toLowerCase() !== 'false'; // env-read: MANDREL_DANGLING_SPINE_REFUSED
}
