/**
 * BRIEFING RENDER ALTITUDE + SELECTION config — P5.1 (scope
 * riverbend/reports/artifacts/p5-briefing-parity/SCOPE.md §2 P5.1, acceptance §8.2,
 * risk §8.4).
 *
 * ═══ THE DEFECT THIS CONFIGURES AGAINST ══════════════════════════════════════════════
 *
 * MEASURED on prod `riverbend` 2026-08-24 through the REAL gather and the REAL render
 * (artifact reports/artifacts/p5-1-briefing-altitude/precheck.json, produced before a line
 * of this feature was written):
 *
 *     sizeChars 23922 of a 24000 cap — saturated
 *     droppedRecords 364
 *     served: tasks 5 of 179 · decisions 1 of 167 · conventions 0 of 1
 *
 * The renderer had ONE altitude. Every record was complete-or-absent, so a 24000-char budget
 * ate the project and THE SIZE CAP CHOSE THE CONTENT. A briefing that serves 5 of 179 tasks
 * is not a briefing of the project; it is a briefing of whatever the drop comparator happened
 * to favour, and the reader cannot tell the difference from inside the document.
 *
 * ═══ WHY "SHAPE-RENDER EVERYTHING" IS NOT THE FIX — arithmetic, not opinion ═══════════
 *
 * Same measurement, same population, building the ACTUAL one-line shape string for every
 * record and summing it:
 *
 *     416 records · 61216 shape chars · mean line 147
 *     + the exempt handoff (5053)  =  66269  =  2.76x the 24000 cap
 *
 * Shape-rendering the whole population OVERFLOWS TOO, before the frame and before a single
 * full-prose slot. So the lever is shape PLUS UPSTREAM SELECTION: decide what gets in BEFORE
 * the budget is consulted, then render the choice cheaply.
 *
 * ═══ THE SELECTION RULE IS THE DELIVERABLE ═══════════════════════════════════════════
 *
 * Its argument, in full, because a quota with no argument is a magic number:
 *
 *   A briefing is an INDEX plus a few whole records. A returning reader cannot act on 179
 *   one-line tasks any more than they can act on 5 complete ones — but they CAN act on the
 *   30 that a stated rule says matter most, AND they can see from the counted `not served`
 *   line exactly what the rule set aside and which knob widens it.
 *
 * The ORDER a quota applies is NOT a new ranking. It is the EXISTING drop ladder read
 * best-first — BRIEFING_PROTECTION_RANK_* then trust then recency then id (briefingConfig.ts
 * and the comparator in services/projectBriefing.ts). Promoting that order from a tiebreak
 * to a stated rule is the whole change. One ranking, not two: a second one would be a second
 * thing to keep in step, and the first divergence would be invisible.
 *
 * Consequence, and it is the property acceptance §8.2 asks for: a record that does not render
 * is EXCLUDED BY A NAMED RULE WITH A COUNT, not EVICTED because the budget ran out. Those two
 * absences are reported as separate fields (`excludedBySelection` / `evictedByCap`), because
 * they are different facts and a reader who cannot tell them apart cannot act on either.
 *
 * STANDING PRINCIPLE (the operator, configs-not-hardcoded): every tunable lives HERE, as a named
 * value with a documented default and an env override — never a literal in the renderer.
 * READ-AT-CALL-TIME, the same shape config/briefingConfig.ts and config/handoffHeadConfig.ts
 * use, so a test can vary a knob without module surgery.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a NON-NEGATIVE-integer env var (a QUOTA), falling back on missing/garbage.
 *
 * SEPARATE FROM envInt ON PURPOSE, exactly as briefingConfig.ts's envRank is. envInt rejects
 * 0 because every knob it reads is a SIZE, where 0 is garbage. A QUOTA's zero is meaningful —
 * "serve none of this section" — and it is also how a quota is falsified from the outside
 * with no code edit, which is how the mutation probe for the selection rule is run.
 */
function envQuota(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/**
 * Read a boolean env var, falling back on missing/unknown. Same accepted vocabulary and the
 * same empty-string handling as config/briefingConfig.ts's envBool — the fleet compose
 * declares posture flags as PASSTHROUGHS (`"${VAR:-}"`), which render the key SET TO '' in
 * the container rather than unset, so folding '' into the fallback is what makes an
 * undeclared-but-passed-through flag reach the code default instead of parsing as garbage.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * Read a CSV env var into a trimmed, de-duplicated, non-empty string list.
 *
 * AN EMPTY FALLBACK IS A REAL, SUPPORTED VALUE HERE (fullProseExcludeTags ships with one) —
 * `raw === ''` and an absent var both reach it, which is what makes "ship the mechanism, ship
 * no vocabulary" expressible rather than a comment.
 */
function envCsv(name: string, fallback: readonly string[]): readonly string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parts = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
  return parts.length > 0 ? parts : fallback;
}

/**
 * BRIEFING_ALTITUDE_ENABLED — the kill switch for EVERYTHING P5.1 changed: the two render
 * altitudes, the reserved full-prose slots, and the selection quotas. ONE switch, not eight,
 * for the reason briefingConfig.ts's branch-scope flag gives: a flag that gates half a change
 * is the one that gets half-applied.
 *
 * DEFAULT TRUE, and the reasoning is the asymmetry — the same one that defaults the handoff
 * staleness stamp on. The failure it PREVENTS is silent and expensive: a saturated project
 * serves 5 of 179 tasks and the reader has no way to learn that the other 174 were never
 * considered. The failure it can CAUSE is loud and cheap: one-line entries where full prose
 * used to be, in a section the reader is already reading, with the whole record one
 * `task details` call away.
 *
 * THIS DEPARTS FROM BRIEFING_BRANCH_SCOPE_ENABLED's default-OFF, deliberately. That flag's
 * argument was "a new section cannot be UN-SHOWN to a paying tenant". Nothing new is shown
 * here — the same sections carry MORE of the records the tenant already had a claim to, and
 * every absence is now named. An operator who wants the old document sets this false.
 *
 * OFF IS BYTE-IDENTICAL TO PRE-P5.1, and it is the SAME code reading collapsed config rather
 * than a second renderer to keep in step: every quota collapses to unbounded and every record
 * renders at full altitude (applyAltitudeFlag in services/projectBriefing.ts).
 * (env: MANDREL_BRIEFING_ALTITUDE_ENABLED)
 */
export const READ_BRIEFING_ALTITUDE_ENABLED = (): boolean =>
  envBool('MANDREL_BRIEFING_ALTITUDE_ENABLED', true);

/**
 * BRIEFING_SELECT_MAX_TASKS — how many open tasks the SELECTION RULE serves, chosen
 * best-first by the protection ladder. Everything past it is excluded by a NAMED rule and
 * reported with a count in the section's own heading, never evicted silently by the budget.
 *
 * ═══ HOW THE FIVE DEFAULTS WERE SIZED, so they can be re-derived rather than trusted ═══
 *
 * Not chosen for looks and not tuned until a target appeared. A published sweep rendered the
 * REAL riverbend corpus at fourteen candidate quota sets with the CAP HELD FIXED at 24000 —
 * artifact reports/artifacts/p5-1-briefing-altitude/quota-sweep.json — and the shipped set is
 * a visible pick off that table:
 *
 *     variant        size   headroom  evictedByCap  served (t/d/c/e/b)
 *     t30 d18 b22   22991     1009         0        77   30/18/1/6/22
 *     t30 d18 b30   23897      103         0        85   30/18/1/6/30
 *     t30 d18 b35   23937       63         3        87   30/16/0/6/35
 *     t40 d18 b30   23942       58         9        86   40/10/0/6/30
 *   → t28 d16 b26   22718     1282         0        77   28/16/1/6/26   ← SHIPPED
 *
 * The pick is NOT the frontier maximum, deliberately. b30 serves eight more records and
 * leaves 103 chars of headroom — on ONE project, at ONE instant, with ONE handoff. The
 * handoff is EXEMPT from the cap and its size is unbounded and volatile (5053 chars the day
 * this was measured), so a default with a hundred chars of slack is a default whose
 * `evictedByCap` goes positive the first time somebody writes a longer handoff. 1282 chars of
 * headroom is what buys the ~0 the acceptance criterion asks for on a corpus that MOVES.
 *
 * 28 tasks ≈ 4340 chars at the measured 155-char mean task shape line.
 * (env: MANDREL_BRIEFING_SELECT_MAX_TASKS)
 */
export const READ_BRIEFING_SELECT_MAX_TASKS = (): number =>
  envQuota('MANDREL_BRIEFING_SELECT_MAX_TASKS', 28);

/**
 * BRIEFING_SELECT_MAX_DECISIONS — the same quota for live decisions (mean shape line 151
 * chars measured on riverbend).
 * (env: MANDREL_BRIEFING_SELECT_MAX_DECISIONS)
 */
export const READ_BRIEFING_SELECT_MAX_DECISIONS = (): number =>
  envQuota('MANDREL_BRIEFING_SELECT_MAX_DECISIONS', 16);

/**
 * BRIEFING_SELECT_MAX_CONVENTIONS — the same quota for convention/constraint contexts.
 *
 * Smaller than the other two because a convention has no title column: its shape headline is
 * the first CONTENT line, and measured on riverbend that is the most expensive line in the
 * document (359 chars against a 147 mean).
 * (env: MANDREL_BRIEFING_SELECT_MAX_CONVENTIONS)
 */
export const READ_BRIEFING_SELECT_MAX_CONVENTIONS = (): number =>
  envQuota('MANDREL_BRIEFING_SELECT_MAX_CONVENTIONS', 5);

/**
 * BRIEFING_SELECT_MAX_DEAD_ENDS — the same quota for the Dead ends section.
 *
 * IT EXISTS FOR COMPLETENESS OF THE RULE, not because dead-ends were the problem (6 of 6
 * served on the measured corpus). Acceptance §8.2 asks that EVERY record which does not
 * render be attributable to a named rule with a count; a section whose only limiter is a
 * char budget attributes its absences to the budget instead. The reserved sub-budget stays
 * underneath as the backstop it always was.
 * (env: MANDREL_BRIEFING_SELECT_MAX_DEAD_ENDS)
 */
export const READ_BRIEFING_SELECT_MAX_DEAD_ENDS = (): number =>
  envQuota('MANDREL_BRIEFING_SELECT_MAX_DEAD_ENDS', 15);

/**
 * BRIEFING_SELECT_MAX_BRANCH_MEMBERS — the same quota for the `On this branch` index.
 *
 * NOTE WHAT THIS ONE COSTS, because it is the one section P5.1 can make WORSE. The branch
 * index is one-liners already, so it was the one section the old renderer served well
 * (measured 40 of 63 on riverbend). A quota below what the reserved budget was already
 * buying is a REGRESSION for that section, paid to fund the others — 26 is the largest value
 * that keeps `evictedByCap` at 0 with real headroom (see the sweep table above).
 * (env: MANDREL_BRIEFING_SELECT_MAX_BRANCH_MEMBERS)
 */
export const READ_BRIEFING_SELECT_MAX_BRANCH_MEMBERS = (): number =>
  envQuota('MANDREL_BRIEFING_SELECT_MAX_BRANCH_MEMBERS', 26);

/**
 * BRIEFING_FULL_PROSE_SLOTS — how many RESERVED full-prose slots the document carries.
 *
 * A slot is offered to the selected records in the SAME best-first order the quotas use, and
 * A SLOT IS NEVER REASSIGNED: a record that misses the type/tag gate CONSUMES its slot and
 * renders its denial IN-BAND. That is the point of a slot discipline — if a denial silently
 * handed the slot to the next record in line, the document's full-prose content would be
 * decided by the GATE rather than by the RANKING, and no reader would ever see it happen.
 * (env: MANDREL_BRIEFING_FULL_PROSE_SLOTS)
 */
export const READ_BRIEFING_FULL_PROSE_SLOTS = (): number =>
  envQuota('MANDREL_BRIEFING_FULL_PROSE_SLOTS', 3);

/**
 * BRIEFING_FULL_PROSE_TYPES — which record kinds a full-prose slot may be spent on.
 *
 * `task` IS IN THE DEFAULT, and it is the most load-bearing choice in this file. SCOPE §8.4:
 * the one axis on which Mandrel measurably beat a plain NOTES.md was spec-change RECOVERY
 * SPEED, and the plausible mechanism is DETAIL ON DEMAND — the briefing carried FULL task
 * descriptions, so an agent re-orienting after a spec change did not have to go digging.
 * Shape-rendering every task attacks that mechanism directly. Making tasks eligible for the
 * reserved slots is what keeps it alive while the index gets six times wider.
 *
 * OUR OWN SHELL'S LIST IS `handoff|milestone|decision`; the product does NOT ship that, and
 * the two differences are deliberate:
 *   - `handoff` is absent because the briefing's handoff is EXEMPT from the cap and already
 *     renders in full — listing it would spend a scarce slot on a record that has an
 *     unbounded one.
 *   - `milestone` is absent because it is a CONTEXT TYPE, and the briefing has no section
 *     that serves contexts by type; its context sections are conventions and dead ends.
 * The three kinds this renderer can actually spend a slot on are `task`, `decision` and
 * `convention`.
 * (env: MANDREL_BRIEFING_FULL_PROSE_TYPES, CSV)
 */
export const READ_BRIEFING_FULL_PROSE_TYPES = (): readonly string[] => envCsv(
  'MANDREL_BRIEFING_FULL_PROSE_TYPES',
  ['task', 'decision'],
);

/**
 * BRIEFING_FULL_PROSE_MAX_CHARS — the character bound on ONE full-prose body.
 *
 * TRUNCATION IS LICENSED HERE, and the rendered text says so on the line where it happens.
 * The document's standing rule — a record is complete or absent — still governs the SHAPE
 * tier, where nothing is ever cut. A full-prose slot is a different object: a bounded EXCERPT
 * the reader is TOLD is bounded, in a document whose whole failure mode was that one
 * 8000-char record could starve four hundred others.
 *
 * ═══ THIS KNOB, AND fullProseSlots, ARE THE TASK-DETAIL DIAL (SCOPE §8.4) ═══════════════
 *
 * If spec-change recovery time regresses when the eval wave measures it, THESE TWO ARE WHAT
 * WE TURN — raise either and the document trades index breadth for record depth, with no
 * redesign and no code change. Sized so it matters: measured on prod riverbend 2026-08-24,
 * open task descriptions average 2140 chars and 172 of 205 exceed 900, so this bound BINDS on
 * most of them and 900-vs-1200 is a real difference in how much a reader gets before they
 * have to go and fetch the whole record:
 *   ssh prod-host "sudo -u postgres psql -d mandrel -X -q -c \"select count(*) total,
 *     count(*) filter (where length(description) > 900) over900,
 *     count(*) filter (where length(description) > 1200) over1200,
 *     round(avg(length(description))) avg, max(length(description)) max from tasks
 *     where project_id='6a1cf00d-0278-4c44-9e01-9e56a374c48c' and archived_at is null
 *     and status in ('todo','in_progress','blocked');\""
 *   -> total 205 | over900 172 | over1200 145 | avg 2140 | max 4725
 * 1200 rather than 900 for exactly that reason: 900 buys ~600 more chars of headroom and
 * costs half of every served description, and detail is the advantage §8.4 says to protect.
 * (env: MANDREL_BRIEFING_FULL_PROSE_MAX_CHARS)
 */
export const READ_BRIEFING_FULL_PROSE_MAX_CHARS = (): number =>
  envInt('MANDREL_BRIEFING_FULL_PROSE_MAX_CHARS', 1200);

/**
 * BRIEFING_FULL_PROSE_EXCLUDE_TAGS — tag vocabulary marking a record as NEVER worth a
 * full-prose slot, however well it ranks. Same matching rule as every other tag vocabulary
 * in this renderer: a record qualifies iff any tag EQUALS one of these values or is PREFIXED
 * `<value>:`.
 *
 * THE DEFAULT IS EMPTY, ON PURPOSE. Our own shell sets this to `component-registry`, because
 * OUR corpus contains a long machine-generated record that ranks well and is worthless to
 * read. That is OUR vocabulary, not a product default (SCOPE §4): shipping it would export a
 * tag no customer has ever written as though it meant something. THE MECHANISM SHIPS; THE
 * VOCABULARY DOES NOT.
 * (env: MANDREL_BRIEFING_FULL_PROSE_EXCLUDE_TAGS, CSV)
 */
export const READ_BRIEFING_FULL_PROSE_EXCLUDE_TAGS = (): readonly string[] => envCsv(
  'MANDREL_BRIEFING_FULL_PROSE_EXCLUDE_TAGS',
  [],
);

/**
 * THE UNBOUNDED QUOTA — what every quota collapses to when the altitude flag is OFF.
 *
 * Not env-overridable: it is the value that makes the OFF path the SAME code path rather than
 * a second renderer, so an operator who could change it could make "off" mean something other
 * than "pre-P5.1". Named rather than written as a literal for the same reason
 * BRIEFING_PROTECTION_RANK_NONE is.
 */
export const BRIEFING_QUOTA_UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * THE RENDER ALTITUDES. `full` is the record's whole body (bounded by
 * BRIEFING_FULL_PROSE_MAX_CHARS); `shape` is the one-line form — when · type · id · title.
 * A closed union rather than a boolean so a third altitude cannot be added by accident.
 */
export type RenderAltitude = 'full' | 'shape';

/**
 * THE THREE RECORD KINDS a full-prose slot can be spent on in this renderer — the closed set
 * BRIEFING_FULL_PROSE_TYPES is drawn from. Named so the OFF path can collapse the vocabulary
 * to "all of them" without writing the list twice, and so a kind added to the renderer that
 * is not added here fails to typecheck rather than becoming silently ineligible.
 */
export const BRIEFING_FULL_PROSE_ALL_KINDS: readonly string[] = ['task', 'decision', 'convention'];

/**
 * THE NAMED SELECTION RULES. Every record that does not render is attributed to one of these
 * (or to the cap), and the name is what the heading prints and what `excludedBySelection`
 * keys on — so a rule cannot be reported under a name the code does not use.
 */
export const SELECTION_RULE = {
  taskQuota: 'section quota (MANDREL_BRIEFING_SELECT_MAX_TASKS)',
  decisionQuota: 'section quota (MANDREL_BRIEFING_SELECT_MAX_DECISIONS)',
  conventionQuota: 'section quota (MANDREL_BRIEFING_SELECT_MAX_CONVENTIONS)',
  deadEndQuota: 'section quota (MANDREL_BRIEFING_SELECT_MAX_DEAD_ENDS)',
  branchMemberQuota: 'section quota (MANDREL_BRIEFING_SELECT_MAX_BRANCH_MEMBERS)',
} as const;

export type SelectionRule = (typeof SELECTION_RULE)[keyof typeof SELECTION_RULE];

/**
 * WHY A FULL-PROSE SLOT WAS DENIED. Rendered IN-BAND next to the record that consumed the
 * slot, because a silent downgrade is indistinguishable from the record simply not having
 * ranked — which is the class of silence this whole item exists to delete.
 */
export const FULL_PROSE_DENIAL = {
  typeNotEligible: 'type not in MANDREL_BRIEFING_FULL_PROSE_TYPES',
  excludedByTag: 'tagged in MANDREL_BRIEFING_FULL_PROSE_EXCLUDE_TAGS',
} as const;

export type FullProseDenial = (typeof FULL_PROSE_DENIAL)[keyof typeof FULL_PROSE_DENIAL];
