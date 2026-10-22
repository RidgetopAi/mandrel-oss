/**
 * PROJECT BRIEFING config — WS2 "living summary" (plan 4333eaae).
 *
 * STANDING PRINCIPLE (the operator, configs-not-hardcoded): every tunable the briefing renderer
 * uses lives HERE — a named value with a sane default + a one-line comment + an env
 * override — never a literal buried in the renderer. Same pattern as config/recallConfig.ts.
 *
 * READS ENV AT CALL TIME, not at module load — every knob below is a `READ_*()` function and
 * `briefingConfig()` calls them on each invocation. Bad/missing values still fall back to the
 * documented default; only the TIMING changed.
 *
 * WHY (SK5 round 2). Module-load consts made the config UNTESTABLE from a
 * test: a value frozen at import cannot be varied per case, so the ON-state tests for the
 * branch-scope flag were rewired to hand `buildProjectBriefing` a spine directly — which
 * meant NOTHING asserted that the ROUTE derives one. The reviewer proved that hole by deleting
 * the route's wire entirely and watching 52/52 stay green. The seam, not the test, was the
 * defect: a load-time read forces every future flag test into a `resetModules` workaround.
 * Deleting it costs a pair of parentheses per knob and makes those tests ordinary.
 *
 * There is no cost to pay here: these are string/number/bool env parses, called once per
 * briefing render. Nothing memoizes them and nothing needs them to be constant — verified
 * before the change by enumerating every consumer, of which there was exactly one
 * (services/projectBriefing.ts's briefingConfig(); zero elsewhere in the repo).
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a boolean env var, falling back to `fallback` on missing/unknown. Accepts (case- and
 * whitespace-insensitive) 1/true/yes/on -> true and 0/false/no/off -> false; anything else
 * (incl. empty/missing) -> `fallback`. Copied in shape from config/claimConfig.ts's envBool
 * so a reader who knows one knows all of them.
 *
 * THE EMPTY STRING MATTERS HERE, not as a nicety: the fleet compose declares posture flags
 * as PASSTHROUGHS (`"${VAR:-}"`), which render the key SET TO '' in the container rather than
 * unset. Folding '' into `fallback` is what makes an undeclared-but-passed-through flag reach
 * the code default instead of parsing as garbage.
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
 * Read a STRING env var, falling back on missing. Whitespace is PRESERVED (unlike envCsv's
 * trim): the one string knob here is a render FORMAT whose leading space is load-bearing —
 * trimming it would silently glue the stamp onto the id. Only a genuinely absent variable
 * falls back; an empty string is honoured as "render nothing", which is a real operator
 * intent and a second way to turn the stamp text off without touching the enable flag.
 */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined ? fallback : raw;
}

/**
 * Read a NON-NEGATIVE-integer env var (a protection rank), falling back on missing/garbage.
 *
 * SEPARATE FROM envInt ON PURPOSE. `envInt` rejects 0 because every knob it reads is a size
 * or a count where 0 is garbage. A RANK's zero is meaningful — it is "no protection", the
 * band every unprotected record already occupies — so an operator must be able to demote a
 * band all the way to it. That is also what makes the drop-order ladder falsifiable from the
 * outside: setting the new bands to 0 restores the pre-ranking order exactly, with no code
 * edit, which is how the mutation probe for this ladder is run.
 */
function envRank(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** Read a CSV env var into a trimmed, de-duplicated, non-empty string list. */
function envCsv(name: string, fallback: readonly string[]): readonly string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parts = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
  return parts.length > 0 ? parts : fallback;
}

/**
 * BRIEFING_MAX_CHARS — the size cap for the rendered briefing markdown, in characters.
 * Enforced by DROPPING whole records, least-protected first (see the protection ladder at
 * the foot of this file), least-trusted-oldest within a band (never by truncating what
 * remains — the eval's hard rule: complete records or absent records). The briefing goes
 * into SessionStart hook injections and dispatch prompts, so the cap bounds prompt cost.
 * (env: MANDREL_BRIEFING_MAX_CHARS)
 */
export const READ_BRIEFING_MAX_CHARS = (): ReturnType<typeof envInt> => envInt('MANDREL_BRIEFING_MAX_CHARS', 24000);

/**
 * BRIEFING_CONVENTION_TAGS — the tag vocabulary that marks a context as a
 * convention/constraint record for the briefing's Conventions section. A context
 * qualifies iff any of its tags EQUALS one of these values or is PREFIXED by
 * `<value>:` (the house `ref:`-style namespacing). Grounded in what exists: contexts
 * carry a free-form text[] `tags` column (no dedicated type), so membership is a tag
 * convention, and the vocabulary is deliberately config — not an invented taxonomy.
 * (env: MANDREL_BRIEFING_CONVENTION_TAGS, CSV)
 */
export const READ_BRIEFING_CONVENTION_TAGS = (): ReturnType<typeof envCsv> => envCsv(
  'MANDREL_BRIEFING_CONVENTION_TAGS',
  ['convention', 'constraint'],
);

/**
 * BRIEFING_DEADEND_RESERVED_CHARS — the Dead ends section's OWN character budget, carved
 * out of BRIEFING_MAX_CHARS. Dead-ends are dropped ONLY against this budget (oldest
 * first); they never enter the global drop pool, so a full briefing can no longer evict
 * them to make room for live records.
 *
 * WHY A BOUNDARY AND NOT A SORT RULE: the global pool sorted dead-ends
 * with a hardcoded `trustScore: null`, which the comparator floors to -1 while real
 * scores live in 0..1 — so every dead-end sorted below every scored record and was
 * evicted FIRST whenever the cap bound. Measured on project riverbend: 417 dead-end
 * candidates existed, the rendered briefing showed `## Dead ends (0)`. Flipping the sort
 * would put a policy inside a shared pool that the next re-sort silently breaks; a
 * separate budget makes that state unreachable.
 *
 * SIZING: dead-ends render as ONE-LINERS (~100-200 chars), the cheapest content per char
 * in the document, so a small slice buys a lot of them. 4000 = 1/6 of the 24000 default
 * cap ≈ 25-40 dead-ends retained. The budget covers the dead-end RECORD LINES only; the
 * section header is frame, like every other section header.
 * (env: MANDREL_BRIEFING_DEADEND_RESERVED_CHARS)
 */
export const READ_BRIEFING_DEADEND_RESERVED_CHARS = (): ReturnType<typeof envInt> => envInt('MANDREL_BRIEFING_DEADEND_RESERVED_CHARS', 4000);

/**
 * BRIEFING_DEADEND_TAGS — the tag vocabulary that marks a context as a RECORDED dead end,
 * independent of any supersession edge. Same matching rule as BRIEFING_CONVENTION_TAGS: a
 * context qualifies iff any of its tags EQUALS one of these values or is PREFIXED by
 * `<value>:`.
 *
 * WHY (part B): the structural intake only recognises contexts with an
 * incoming `supersedes` edge and decisions marked superseded/deprecated/failed. The
 * canonical dead end — a session proves approach X cannot work and records it as a plain
 * `discussion`/`error` context — matches NEITHER, so it never reaches the section at any
 * cap size. A tag is the one signal the author can supply at write time.
 * (env: MANDREL_BRIEFING_DEADEND_TAGS, CSV)
 */
export const READ_BRIEFING_DEADEND_TAGS = (): ReturnType<typeof envCsv> => envCsv(
  'MANDREL_BRIEFING_DEADEND_TAGS',
  ['dead-end', 'deadend', 'rejected'],
);

/**
 * BRIEFING_OPEN_TASK_STATUSES — the task statuses the briefing counts as OPEN work.
 * The tasks.status vocabulary is todo|in_progress|blocked|completed|cancelled
 * (handlers/tasks.ts); open = the three non-terminal states.
 * (env: MANDREL_BRIEFING_OPEN_TASK_STATUSES, CSV)
 */
export const READ_BRIEFING_OPEN_TASK_STATUSES = (): ReturnType<typeof envCsv> => envCsv(
  'MANDREL_BRIEFING_OPEN_TASK_STATUSES',
  ['todo', 'in_progress', 'blocked'],
);

/**
 * BRIEFING_BRANCH_SCOPE_ENABLED — the MASTER SWITCH for everything SK5 changed about
 * SELECTION. DEFAULT FALSE. The operator's ruling 2026-08-16: riverbend-first,
 * behind a flag, default OFF.
 *
 * WHY DEFAULT OFF, in his terms: a flag can always be flipped ON, but a new section cannot
 * be UN-SHOWN to a paying tenant. So the deliberate act is turning it on, never remembering
 * to turn it off — an opt-out flag is one forgotten env line away from being an opt-in one.
 *
 * WHAT IT GATES — all of SK5's selection changes, and NOTHING ELSE:
 *   - the `## On this branch` section and branch-scoped drop protection;
 *   - the `parked:*` pre-selection exclusion (BRIEFING_EXCLUDED_TASK_TAGS);
 *   - the always-surface floor (BRIEFING_ALWAYS_SURFACE_TASK_STATUSES).
 * With it OFF the briefing renders exactly as it did before SK5 — same records, same drop
 * order — PLUS the honest per-section census, which is deliberately NOT gated: it retracts a
 * false claim the renderer was making (`## Decisions (0) none` against a population of 156),
 * and a knob that can switch a correction back off is a knob that can re-ship the defect.
 *
 * ONE FLAG, NOT THREE. The three knobs above are all reachable independently, but the FLIP
 * is one value: a flag that gates half a change is the one that gets half-applied.
 *
 * GRANULARITY IS PER-INSTANCE ENV, WITH NO PROJECT-NAME LOGIC ANYWHERE IN THE CODE. Prod
 * systemd serves riverbend and reads /etc/app/prod/mcp.env through
 * docker-compose.prod file's `env_file:`; each tenant runs its own container off
 * /etc/app/tenants/<h>.env. MEASURED 2026-08-16 and it is the reason this name is ALSO
 * declared in docker-compose.yml: fleet-deploy script passes `--env-file`, which is
 * INTERPOLATION ONLY and not container env, so a name nothing declares is a SILENT NO-OP in
 * a tenant env file (the same trap is documented five times in that compose).
 * Default-off is safe either way — absent env reaches this fallback — but without the
 * declaration the flag could never be turned ON for a tenant that wanted it.
 * (env: MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED)
 */
export const READ_BRIEFING_BRANCH_SCOPE_ENABLED = (): ReturnType<typeof envBool> => envBool('MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED', false);

/**
 * BRIEFING_ALWAYS_SURFACE_TASK_STATUSES — task statuses that get the ALWAYS-SURFACE FLOOR:
 * they are evicted by the size cap LAST, after every unprotected record (SK5 scope (b)).
 * Must be a subset of BRIEFING_OPEN_TASK_STATUSES to have any effect — a status the gather
 * never fetches cannot be protected.
 *
 * WHY `blocked`: a blocked task is the highest-value line in the document
 * for a reader deciding what to do next — it is the work that CANNOT proceed — and it had
 * no protection at all. Measured on project riverbend 2026-08-16: 13 open blocked tasks,
 * and the rendered briefing served 1 task of 190. This is a drop ORDER, not an exemption:
 * a protected task still enters the pool, so the cap is still honored.
 * (env: MANDREL_BRIEFING_ALWAYS_SURFACE_TASK_STATUSES, CSV)
 */
export const READ_BRIEFING_ALWAYS_SURFACE_TASK_STATUSES = (): ReturnType<typeof envCsv> => envCsv(
  'MANDREL_BRIEFING_ALWAYS_SURFACE_TASK_STATUSES',
  ['blocked'],
);

/**
 * BRIEFING_EXCLUDED_TASK_TAGS — tag vocabulary marking a task as DELIBERATELY NOT BEING
 * DONE, so it is excluded from Open tasks BEFORE the size cap ever runs. Same matching rule
 * as the other tag vocabularies here: a task qualifies iff any tag EQUALS one of these
 * values or is PREFIXED `<value>:`.
 *
 * WHY (SK5). Two agents working from opposite ends reached
 * the same conclusion: at 94% cap saturation the briefing's quality is governed by BUDGET,
 * not by ordering, so shrinking the served population beats ranking it. `parked:*` is an
 * honest not-served signal the AUTHOR already wrote down — measured on project riverbend
 * 2026-08-16, 27 of 190 open tasks carry one (26 of them `parked:runtime-freeze-2026-08-27`)
 * and are today indistinguishable from active work to the selector.
 *
 * THE EXCLUSION IS DISCLOSED, NEVER SILENT: the count and this vocabulary's name are
 * rendered in the section's `note:` line. An exclusion the reader cannot see is the same
 * defect as the one SK5 exists to fix, one layer over.
 * (env: MANDREL_BRIEFING_EXCLUDED_TASK_TAGS, CSV)
 */
export const READ_BRIEFING_EXCLUDED_TASK_TAGS = (): ReturnType<typeof envCsv> => envCsv(
  'MANDREL_BRIEFING_EXCLUDED_TASK_TAGS',
  ['parked'],
);

/**
 * BRIEFING_BRANCH_RESERVED_CHARS — the "On this branch" section's OWN character budget,
 * carved out of BRIEFING_MAX_CHARS, on the same boundary pattern as the dead-ends budget
 * above (and for the same reason: a policy inside the shared drop pool is one re-sort away
 * from being silently undone).
 *
 * WHY (SK5). The briefing gathered newest-first PROJECT-WIDE and the reader's
 * open branch position was referenced nowhere, so a saturated project served the global
 * newest regardless of what the handoff's PATH said was being resumed. Branch members render
 * as ONE-LINERS (~120-200 chars), so this slice buys ~20-30 of them — a complete index of a
 * real branch — for 1/6 of the cap.
 * (env: MANDREL_BRIEFING_BRANCH_RESERVED_CHARS)
 */
export const READ_BRIEFING_BRANCH_RESERVED_CHARS = (): ReturnType<typeof envInt> => envInt('MANDREL_BRIEFING_BRANCH_RESERVED_CHARS', 4000);

/**
 * BRIEFING_SECTION_MAX_RECORDS — the per-query fetch bound for each list section (open
 * tasks / decisions / conventions / dead-ends). A bound on the GATHER, not a render
 * truncation: the size cap then drops whole records from what was fetched. Keeps a
 * pathological project (thousands of rows) from making the renderer unbounded.
 *
 * THIS IS THE SECOND, INDEPENDENT NARROWING (SK5), and it used to be
 * invisible in the output: a section that hit this bound reported a population that was a
 * FLOOR while reading as a total. The renderer now labels it — the census carries
 * `fetchBoundReached` and the section prints `N+` plus a note naming this env var. Do not
 * conflate it with the size cap: one bounds the QUERY, the other drops from what it returned.
 * (env: MANDREL_BRIEFING_SECTION_MAX_RECORDS)
 */
export const READ_BRIEFING_SECTION_MAX_RECORDS = (): ReturnType<typeof envInt> => envInt('MANDREL_BRIEFING_SECTION_MAX_RECORDS', 200);

// ─────────────────────────────────────────────────────────────────────────────
// THE DROP-ORDER PROTECTION LADDER (task: briefing drop order, 2026-08-20)
//
// The size cap evicts the drop pool in ascending rank, so a HIGHER rank is evicted LATER.
// Every band is a named value here; the comparator in projectBriefing.ts reads them and
// contains no numeric literal of its own (standing principle at the top of this file).
//
// WHY A LADDER AND NOT A BOOLEAN. Before this, `protectedRank` was 0|1 — 1 for branch
// members and `blocked` tasks, 0 for everything else — and the secondary key did the rest.
// Measured on project riverbend 2026-08-20 through the real gather + real render (artifact
// reports/artifacts/briefing-drop-order-2026-08-20/metrics-before.json): 43 open high-priority
// tasks older than 7 days sat in the candidate pool and rendered ZERO times, while 314 of 320
// candidates were dropped. Priority and age were invisible to the selector; a returning
// session was shown neither.
//
// FIVE BANDS OVER 4/3/3/2/1 — conventions tie with always-surface. The values are NOT sparse:
// envRank accepts integers only (see envRank above), so there is no free value between adjacent
// bands and a new band cannot be inserted without renumbering the ones already deployed in
// tenant env files.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rank of a record with NO protection — the band every ordinary candidate occupies, and
 * the one the cap drains first. Not env-overridable: it is the floor the other bands are
 * defined against, not a tunable. Exported so the comparator names it instead of writing 0.
 */
export const BRIEFING_PROTECTION_RANK_NONE = 0;

/**
 * BRIEFING_PROTECTION_RANK_BRANCH_MEMBER — the reader's OWN branch members (SK5 scope (a)).
 * Top of the ladder: this is the one population the reader explicitly declared they are
 * resuming, so nothing project-wide may outrank it.
 * (env: MANDREL_BRIEFING_PROTECTION_RANK_BRANCH_MEMBER)
 */
export const READ_BRIEFING_PROTECTION_RANK_BRANCH_MEMBER = (): ReturnType<typeof envRank> =>
  envRank('MANDREL_BRIEFING_PROTECTION_RANK_BRANCH_MEMBER', 4);

/**
 * BRIEFING_PROTECTION_RANK_ALWAYS_SURFACE — tasks whose STATUS is in
 * BRIEFING_ALWAYS_SURFACE_TASK_STATUSES (today: `blocked`). Unchanged in meaning from SK5;
 * it simply gets its own number now that there is more than one protected band.
 * (env: MANDREL_BRIEFING_PROTECTION_RANK_ALWAYS_SURFACE)
 */
export const READ_BRIEFING_PROTECTION_RANK_ALWAYS_SURFACE = (): ReturnType<typeof envRank> =>
  envRank('MANDREL_BRIEFING_PROTECTION_RANK_ALWAYS_SURFACE', 3);

/**
 * BRIEFING_PROTECTION_RANK_CONVENTION — a convention/constraint context (a record matching
 * BRIEFING_CONVENTION_TAGS, rendered in `## Conventions`).
 *
 * WHAT IT FIXES, measured on prod project `riverbend` 2026-08-24 through the live
 * `project_briefing`: the section rendered `## Conventions (0 of 1)` with the note
 * `1 of 1 not served — the size cap`. Conventions had NO band, so the single standing
 * constraint in the project fell to BRIEFING_PROTECTION_RANK_NONE — the tier the cap drains
 * FIRST — and was evicted on every render. That is backwards for the one record type whose
 * whole purpose is to be a rule the reader must obey.
 *
 * WHY THIS DEFAULT EQUALS THE ALWAYS-SURFACE BAND RATHER THAN SITTING BELOW IT. Two
 * measurements and one asymmetry:
 *   - Band populations on riverbend 2026-08-24:
 *       ssh prod-host "sudo -u postgres psql -d mandrel -X -q -c \"select priority,
 *         count(*) filter (where created_at < now() - interval '7 days') as stale,
 *         count(*) filter (where status='blocked') as blocked, count(*) as total
 *         from tasks where project_id='6a1c953a-0278-4c44-9e01-9e56a374c48c'
 *         and archived_at is null and status in ('todo','in_progress','blocked')
 *         group by 1;\""
 *     -> 13 blocked (the always-surface band) against 61 stale high-priority. Placing a
 *     convention in the STALE_PRIORITY band would drop it into the LARGEST band in the
 *     document, where survival is decided by the within-band keys (trust, then age) against
 *     ~60 competitors — the same mechanism that evicted it in the first place, one tier up.
 *   - Conventions are population-bounded in a way tasks are not: the vocabulary is opt-in
 *     (BRIEFING_CONVENTION_TAGS) and the section's selection quota is
 *     BRIEFING_SELECT_MAX_CONVENTIONS, so this band can never cost more than that many
 *     records' worth of budget.
 *   - The asymmetry: a blocked task the reader does not see fails LOUDLY (they try it and
 *     it is blocked); a convention the reader does not see fails SILENTLY (they do the work
 *     the wrong way and nothing says so).
 *
 * IT IS A TIE, NOT AN OVERRIDE. Equal rank means the existing within-band order (trust asc,
 * then created_at asc, then id) decides, so no blocked task is categorically displaced, and
 * nothing here outranks BRIEFING_PROTECTION_RANK_BRANCH_MEMBER — the reader's own declared
 * position stays top of the ladder.
 *
 * IT IS UNDER THE MASTER SWITCH. This band reorders which records survive the cap, so
 * applySelectionFlag collapses it to BRIEFING_PROTECTION_RANK_NONE when
 * MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED is off — this env var has no effect there.
 * (env: MANDREL_BRIEFING_PROTECTION_RANK_CONVENTION)
 */
export const READ_BRIEFING_PROTECTION_RANK_CONVENTION = (): ReturnType<typeof envRank> =>
  envRank('MANDREL_BRIEFING_PROTECTION_RANK_CONVENTION', 3);

/**
 * BRIEFING_PROTECTION_RANK_STALE_PRIORITY — an open task that is BOTH high-priority
 * (BRIEFING_PROTECTED_TASK_PRIORITIES) and STALE (older than BRIEFING_STALE_TASK_DAYS).
 * This is the forgotten-work band, and it is the one the measurement above says was being
 * thrown away. It ranks ABOVE a fresh high-priority task deliberately: a fresh one is
 * already favoured by the recency tiebreak below it, a forgotten one is favoured by nothing.
 * (env: MANDREL_BRIEFING_PROTECTION_RANK_STALE_PRIORITY)
 */
export const READ_BRIEFING_PROTECTION_RANK_STALE_PRIORITY = (): ReturnType<typeof envRank> =>
  envRank('MANDREL_BRIEFING_PROTECTION_RANK_STALE_PRIORITY', 2);

/**
 * BRIEFING_PROTECTION_RANK_PRIORITY — an open high-priority task that is not yet stale.
 * (env: MANDREL_BRIEFING_PROTECTION_RANK_PRIORITY)
 */
export const READ_BRIEFING_PROTECTION_RANK_PRIORITY = (): ReturnType<typeof envRank> =>
  envRank('MANDREL_BRIEFING_PROTECTION_RANK_PRIORITY', 1);

/**
 * BRIEFING_PROTECTED_TASK_PRIORITIES — the `tasks.priority` values that earn a protection
 * band. The column's vocabulary is low|medium|high|urgent (handlers/tasks.ts); this names the
 * top two. A priority absent from this list gets BRIEFING_PROTECTION_RANK_NONE, so emptying
 * it turns the two priority bands off without touching the ranks.
 * (env: MANDREL_BRIEFING_PROTECTED_TASK_PRIORITIES, CSV)
 */
export const READ_BRIEFING_PROTECTED_TASK_PRIORITIES = (): ReturnType<typeof envCsv> => envCsv(
  'MANDREL_BRIEFING_PROTECTED_TASK_PRIORITIES',
  ['urgent', 'high'],
);

/**
 * BRIEFING_STALE_TASK_DAYS — how old an open task must be to count as STALE for the band
 * above, in days, measured from `tasks.created_at`.
 *
 * WHY created_at AND NOT updated_at, which is the obvious choice and is wrong here. Measured
 * on prod `riverbend` 2026-08-20:
 *   ssh prod-host "sudo -u postgres psql -d mandrel -X -q -c \"select priority,
 *     count(*) filter (where updated_at < now() - interval '7 days') as stale7,
 *     count(*) filter (where created_at < now() - interval '7 days') as old7, count(*) total
 *     from tasks where project_id='6a1c953a-0278-4c44-9e01-9e56a374c48c' and archived_at is null
 *     and status in ('todo','in_progress','blocked') group by 1;\""
 * -> stale7 = 0 for EVERY priority across all 184 open tasks, while old7 = 154. `updated_at`
 * is last-write-only and 184 of 184 open tasks carry 184 distinct values all inside the last
 * two days, so any background pass that rewrites a row erases the staleness signal for the
 * whole project. `created_at` is immutable, so the band it defines cannot be silently emptied
 * by an unrelated write. `event_log` is empty (0 rows), so there is no third instrument.
 * (env: MANDREL_BRIEFING_STALE_TASK_DAYS)
 */
export const READ_BRIEFING_STALE_TASK_DAYS = (): ReturnType<typeof envInt> => envInt('MANDREL_BRIEFING_STALE_TASK_DAYS', 7);

/**
 * BRIEFING_BACKFILL_ENABLED — after the cap loop stops dropping, walk the dropped candidates
 * back in REVERSE drop order and re-admit any that still fit (first fit, keep walking).
 *
 * WHY. The drop loop stops at the first render that fits, so whatever budget the last drop
 * freed is simply never spent. Measured on project riverbend 2026-08-20 (metrics-before.json):
 * 3233 of the 24000 cap — 13.5% — went unused while 314 records were dropped, including
 * candidates as small as 159 chars.
 *
 * NOT GATED BY THE SK5 SELECTION FLAG, unlike the bands above. It discloses nothing new and
 * changes no ordering: every record it admits was already in the candidate pool, already
 * eligible, and is admitted in the pool's own order. It is the cap loop finishing its job.
 * (env: MANDREL_BRIEFING_BACKFILL_ENABLED)
 */
export const READ_BRIEFING_BACKFILL_ENABLED = (): ReturnType<typeof envBool> => envBool('MANDREL_BRIEFING_BACKFILL_ENABLED', true);

// ─────────────────────────────────────────────────────────────────────────────
// THE HANDOFF STALENESS STAMP (finding bf1980d5)
//
// The renderer annotates each task id NAMED IN THE HANDOFF TEXT with that task's CURRENT
// status, at render time, without ever modifying the stored record. Rationale, the uniform-
// stamping rule and the three unresolvable-id cases: services/handoffStamp.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The token BRIEFING_HANDOFF_STAMP_FORMAT substitutes the status into. Not env-overridable:
 * it is the format string's own grammar, not a tunable, and an operator who could change it
 * could set it to something absent from their format and get a stamp reading literally
 * "{status}". Exported so services/handoffStamp.ts substitutes a named constant rather than
 * writing the placeholder twice.
 */
export const HANDOFF_STAMP_STATUS_PLACEHOLDER = '{status}';

/**
 * BRIEFING_HANDOFF_STAMP_ENABLED — the staleness stamp's kill switch.
 *
 * DEFAULT TRUE, deliberately, and the reasoning is the asymmetry: the failure it prevents is
 * SILENT and EXPENSIVE (a reader rebuilds finished work because a frozen handoff told them
 * to — measured on the 2026-08-21 boot package, found independently by two blind readers),
 * while the failure it can CAUSE is loud and cheap (a few extra chars in a section a reader
 * is already reading). Everything else this renderer ships behind a flag defaults OFF because
 * it changes SELECTION — what survives the cap. This changes no selection; it annotates.
 *
 * OFF is byte-identical to pre-4660f1aa: the gather resolves nothing (no queries at all) and
 * the render applies nothing. Both halves check it — the same two-choke-point rule
 * branchScopeEnabled follows, for the same reason (a caller reaching either exported entry
 * point directly must not obtain the behaviour from a flag-off deployment).
 * (env: MANDREL_BRIEFING_HANDOFF_STAMP_ENABLED)
 */
export const READ_BRIEFING_HANDOFF_STAMP_ENABLED = (): ReturnType<typeof envBool> =>
  envBool('MANDREL_BRIEFING_HANDOFF_STAMP_ENABLED', true);

/**
 * BRIEFING_HANDOFF_STAMP_FORMAT — what a stamp LOOKS like. `{status}` is replaced with the
 * task's current status; everything else is emitted verbatim, including the LEADING SPACE
 * that separates the stamp from the id it follows.
 *
 * THE DEFAULT IS THE CHEAPEST HONEST FORM. The handoff is EXEMPT from the briefing's size cap
 * (projectBriefing.ts), so every char a stamp adds lands in the one section the cap cannot
 * trim — on a package already dropping whole records. ` [now: completed]` is 17 chars; the
 * word "now" is what distinguishes it from the status the handoff's author wrote at write
 * time, which is the whole point of the feature. An operator who wants it terser can say
 * MANDREL_BRIEFING_HANDOFF_STAMP_FORMAT=' [{status}]'.
 * (env: MANDREL_BRIEFING_HANDOFF_STAMP_FORMAT)
 */
export const READ_BRIEFING_HANDOFF_STAMP_FORMAT = (): ReturnType<typeof envStr> =>
  envStr('MANDREL_BRIEFING_HANDOFF_STAMP_FORMAT', ` [now: ${HANDOFF_STAMP_STATUS_PLACEHOLDER}]`);

/**
 * BRIEFING_HANDOFF_STAMP_DELETED_LABEL — the status word stamped for a task that resolves but
 * has been DELETED (`tasks.archived_at IS NOT NULL`).
 *
 * A separate knob because it is the one stamp whose value is NOT read out of `tasks.status`:
 * a deleted task keeps whatever status it had when it was archived, so stamping that status
 * would tell the reader `[now: todo]` about work that no longer exists. `deleted` is the
 * user-facing word for archived_at (task action `delete`), so this is the vocabulary the
 * reader already has.
 * (env: MANDREL_BRIEFING_HANDOFF_STAMP_DELETED_LABEL)
 */
export const READ_BRIEFING_HANDOFF_STAMP_DELETED_LABEL = (): ReturnType<typeof envStr> =>
  envStr('MANDREL_BRIEFING_HANDOFF_STAMP_DELETED_LABEL', 'deleted');

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * THE RECORDING DIRECTIVE — the WRITE half of the injected block
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS, MEASURED. Two eval runs compared a session that FETCHES its own state at
 * boot against a session that has this briefing INJECTED. MCP tool calls per 8-session
 * replicate:
 *     arm A  (fetch your own state):  44, 45, 57
 *     arm A' (briefing injected):      9, 10, 17
 *     arm M  (briefing injected):      7,  9,  0
 * The injection cut Mandrel use ~5x, and the loss is not confined to the boot reads it was
 * supposed to replace — replicates went to ZERO, i.e. they stopped WRITING as well.
 *
 * THE MECHANISM IS AN INSTRUCTION, NOT A BUDGET. The text that arrives with an injected
 * briefing is necessarily a READ-side prohibition ("this is ground truth, do not spend turns
 * re-fetching it") and it is unqualified over the noun `Mandrel`, so it generalises from
 * READ to every interaction. The counter-instruction ("record as you go") lives in a static
 * CLAUDE.md the user has to write, and loses on both position and recency to a block that
 * arrives inside the session, at the top, every session.
 *
 * SIZE IS NOT THE DRIVER, so injecting LESS is not the fix: the arm-M replicate that made
 * ZERO calls for all eight sessions was being handed a 214-BYTE empty-shell briefing. A
 * 214-byte document cannot exhaust an attention budget. What it can do — and did — is arrive
 * wrapped in a frame that says the memory step is handled.
 *
 * SO THE COUNTERWEIGHT SHIPS WITH THE DOCUMENT. It is our own text, arriving automatically,
 * in the same block, in the LAST position a reader passes before working. It needs no
 * cooperation from the operator's CLAUDE.md, which is the whole reason it is here rather
 * than in the docs.
 *
 * ⚠️ IT IS NOT CAP-EXEMPT. This block is frame, so it is rendered on every pass of the cap
 * loop and the cap is still honoured — which means on a saturated project it is paid for by
 * evicting records. That is a real cost and it is why the default is kept short; measure it
 * as a component cost, never as a free increment (scoring rule a2243a8d).
 * (env: MANDREL_BRIEFING_RECORDING_DIRECTIVE_ENABLED)
 */
export const READ_BRIEFING_RECORDING_DIRECTIVE_ENABLED = (): ReturnType<typeof envBool> =>
  envBool('MANDREL_BRIEFING_RECORDING_DIRECTIVE_ENABLED', true);

/**
 * THE DIRECTIVE TEXT ITSELF — a knob, because the TOOL NAMES in it are surface-specific.
 *
 * The default is spelled for the GATEWAY surface (`context`/`decision`/`task` with an
 * `action`), which is what the bridge every agent connects through exposes. A deployment
 * whose clients are on the flat per-tool surface calls the same operations
 * `context_store` / `decision_record` / `task_create`, and re-spells this string rather than
 * being told to call tools it cannot see. Naming the tools at all is deliberate: in harnesses
 * where MCP tools load on demand it also removes the discovery step.
 *
 * THREE THINGS THE WORDING IS DOING, none of them decoration:
 *   1. it SEPARATES READ FROM WRITE in as many words, because the generalisation from one to
 *      the other is the measured defect;
 *   2. it states that this document was WRITTEN BY PAST SESSIONS CALLING TOOLS, which is what
 *      makes "the memory step is handled" false rather than merely discouraged;
 *   3. it is LAST in the document, so it is the final thing read before work starts.
 * (env: MANDREL_BRIEFING_RECORDING_DIRECTIVE)
 */
export const BRIEFING_RECORDING_DIRECTIVE_DEFAULT = [
  '## Recording — this document is the READ half of your memory; the WRITE half is yours',
  '',
  'Every line above is here because a past session CALLED A TOOL to write it. Nothing in this',
  'document was produced automatically, and nothing will write this session down for you.',
  'State is injected, so do not spend turns re-fetching it — that is an instruction about',
  'READING and it does not extend to recording. Recording is not optional and is not done.',
  '',
  'As you work, and before you stop:',
  "- decision({action:'record', ...}) — a choice a future session must respect, and WHY.",
  "- context({action:'store', type:'error'|'discussion'|'completion', ...}) — progress, errors,",
  '  and paths that failed so the next session does not re-walk them.',
  "- task({action:'create'|'update', ...}) — open and finished work.",
  "- context({action:'store', type:'handoff', ...}) — LAST, before you stop: where the work",
  '  stands, what works, what is broken, what to do next, and what NOT to redo.',
  '',
  'If this session records nothing, the next one boots on this same document.',
].join('\n');

export const READ_BRIEFING_RECORDING_DIRECTIVE = (): ReturnType<typeof envStr> =>
  envStr('MANDREL_BRIEFING_RECORDING_DIRECTIVE', BRIEFING_RECORDING_DIRECTIVE_DEFAULT);

/**
 * BRIEFING_PROTECTION_RANK_DECISION — a non-superseded decision, rendered in `## Decisions`.
 *
 * ⚠️ THE DEFAULT IS THE FLOOR, SO SHIPPING THIS CHANGES NOTHING. It exists because an earlier task
 * measured that the boot package serves **0 of 162 decisions** on project
 * `riverbend` under the 24,000-char cap — a cold session boots with no access to any
 * decision the project ever made, including the ones that LOCK its current plan. Both blind
 * readers named it unprompted.
 *
 * IT IS A KNOB AND NOT A RULING BECAUSE THE ANSWER IS A MEASUREMENT WE HAVE NOT TAKEN. The
 * cap is already dropping 339 whole records, so any budget a decision band wins is taken
 * from something else, and f176d8a5 says in as many words: MEASURE which loses less, do not
 * guess. A default above the floor would be that guess. Raising this to 1..3 and re-rendering
 * the same project is the experiment; scoring rule a2243a8d governs how the result is stated
 * (component cost, or the whole package, or a swap stated as a swap — never an increment).
 *
 * WHY A RANK RATHER THAN A RESERVED SUB-BUDGET, which is the other candidate f176d8a5 names:
 * a rank is one term in an existing comparator and is exactly reversible by setting it back
 * to 0, so the experiment can be run and unrun on a live instance with an env var. A reserved
 * sub-budget removes decisions from the global pool and is a structural change that cannot be
 * evaluated that cheaply. Take the measurement with this; build the budget only if the
 * measurement says a rank is not enough.
 *
 * UNDER THE MASTER SWITCH, like every other selection-affecting band (applySelectionFlag).
 * (env: MANDREL_BRIEFING_PROTECTION_RANK_DECISION)
 */
export const READ_BRIEFING_PROTECTION_RANK_DECISION = (): ReturnType<typeof envRank> =>
  envRank('MANDREL_BRIEFING_PROTECTION_RANK_DECISION', BRIEFING_PROTECTION_RANK_NONE);
