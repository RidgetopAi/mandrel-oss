/**
 * "WAITING ON A HUMAN" config — P5.5 (SCOPE §2 P5.5 / §8.6).
 *
 * THE DEFECT THIS CONFIGURES AGAINST. The section a human operator reads first — what is
 * waiting on ME — had no server concept. Our shell selected it BY TAG from a four-tag
 * vocabulary we invented, and asking a customer to invent and apply that vocabulary in
 * order to unlock their most valuable section is the failure the P5 tranche exists to
 * delete. Migration 093 makes it a COLUMN, so the section selects by `WHERE`.
 *
 * STANDING PRINCIPLE (the operator, configs-not-hardcoded): every tunable lives HERE, as a named
 * value with a documented default, read AT CALL TIME through a `READ_*()` function so a
 * test can vary it without module surgery. Same shape as config/briefingConfig.ts and
 * config/handoffHeadConfig.ts.
 *
 * ═══ WHAT IS DELIBERATELY *NOT* AN ENV KNOB ═══════════════════════════════════════════
 * `BLOCKED_ON_VALUES` and `BLOCKED_ON_HUMAN` are plain constants. They mirror migration
 * 093's CHECK constraint, and a deployment that widened or renamed them would produce a
 * validator that accepts values the database rejects — direction (b) of the drift class
 * config/fieldLimits.ts exists to kill, which fails as a raw Postgres 23514 surfaced as a
 * 500 rather than an actionable message. The enum has ONE home and it is the constraint;
 * this is the mirror, asserted against the live information_schema by
 * src/tests/blockedOnSchema.contract.test.ts.
 *
 * ═══ WHAT IS DELIBERATELY *NOT* HERE: OUR VOCABULARY ══════════════════════════════════
 * `needs-operator`, `needs:operator`, `decision-needed`, `decision-gate` appear NOWHERE in this
 * file and nowhere in the product (SCOPE §4: our vocabulary must not become a product
 * default). The section does not read tags at all. The one place tags are still touched is
 * the SPELLING-COLLISION finding below, and that check carries no vocabulary either — it
 * is a structural property of a project's own tag set (see TAG_COLLISION_NORMALIZE_RE).
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a NON-NEGATIVE-integer env var (0 is a legal, meaningful value: "probe every call"). */
function envIntZeroOk(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** Read a boolean env var; anything but the literal 'true'/'false' falls back. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

/** Read a STRING env var, falling back only when the variable is genuinely absent. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined ? fallback : raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENUM — the mirror of migration 093's CHECK constraint. Not tunable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `tasks.blocked_on` value set, in the order the constraint declares it.
 * NULL is NOT a member: it is the column's default and means "not blocked on anyone in
 * particular", which is an ABSENCE of this claim rather than a fourth value of it.
 */
export const BLOCKED_ON_VALUES = Object.freeze(['human', 'agent', 'external'] as const);
export type BlockedOn = (typeof BLOCKED_ON_VALUES)[number];

/** The one value the "Waiting on a human" section selects on. */
export const BLOCKED_ON_HUMAN: BlockedOn = 'human';

/** The `tasks` columns migration 093 adds — named once, read by the capability probe. */
export const BLOCKED_ON_COLUMN = 'blocked_on';
export const DUE_AT_COLUMN = 'due_at';
/** The CHECK constraint migration 093 adds — named once, asserted by the schema contract. */
export const BLOCKED_ON_CHECK_CONSTRAINT = 'tasks_blocked_on_check';
/** The migration a reader names in-band when it finds the columns absent. */
export const BLOCKED_ON_MIGRATION = '093_task_blocked_on_and_due_at.sql';

// ─────────────────────────────────────────────────────────────────────────────
// THE CAPABILITY PROBE (SCOPE §8.6: code must tolerate the ABSENT column)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a column-presence probe result is reused, in ms. The probe is one
 * `information_schema.columns` read; caching it stops the briefing paying for it on every
 * call, and the TTL bounds how long a just-migrated instance keeps saying ABSENT.
 *
 * DEFAULT 60_000 (one minute): a migration is applied once and never un-applied in normal
 * operation, so a minute of staleness is invisible; but the value is bounded rather than
 * infinite so an instance migrated WHILE RUNNING self-corrects without a restart. Set 0 to
 * probe every call (what the contract tests do).
 */
export const READ_BLOCKED_ON_CAPABILITY_TTL_MS = (): number =>
  envIntZeroOk('MANDREL_BLOCKED_ON_CAPABILITY_TTL_MS', 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// THE SECTION
// ─────────────────────────────────────────────────────────────────────────────

/** The section's kill switch. Default TRUE — a flag flip, not a rollback, if it surprises. */
export const READ_WAITING_SECTION_ENABLED = (): boolean =>
  envBool('MANDREL_BRIEFING_WAITING_ENABLED', true);

/** The section's rendered heading. */
export const WAITING_SECTION_LABEL = 'Waiting on a human';

/** Most rows the section's query fetches. Bounded like every other briefing section. */
export const READ_WAITING_MAX_RECORDS = (): number =>
  envInt('MANDREL_BRIEFING_WAITING_MAX_RECORDS', 25);

/**
 * The section's reserved char sub-budget, on the same mechanism the dead-ends and branch
 * sections use (projectBriefing.fitToReservedBudget). It does NOT join the global drop
 * pool: this section is the operator's action list, and a section that competes with
 * project-wide newest for the cap is a section that empties itself on a busy project —
 * which is the defect SK5 was raised for, one section over.
 */
export const READ_WAITING_RESERVED_CHARS = (): number =>
  envInt('MANDREL_BRIEFING_WAITING_RESERVED_CHARS', 2_500);

/**
 * THE INTERIM FALLBACK's selection, while `blocked_on` is unpopulated or absent.
 * `status='blocked'` is a DIFFERENT QUESTION (see migration 093's header) and is shipped
 * only because an empty section teaches a reader there is no waiting work. It is always
 * rendered with the precision caveat below — the label is not decoration, it is the reason
 * shipping this is defensible at all.
 */
export const READ_WAITING_FALLBACK_STATUSES = (): readonly string[] => ['blocked'];

/**
 * THE PRECISION CAVEAT, in the authors' own measured numbers, ATTRIBUTED AS OURS.
 *
 * Worded as a statement about the AUTHORS' project and not the reader's, because we have
 * not measured the reader's (CLASSES.md C2: state the result no wider than your sample).
 * When the COLUMN IS PRESENT the renderer computes the reader's OWN precision from their
 * own rows and prints that as well — a derived number beats a borrowed one. This sentence
 * is what remains available when the column is absent and the number cannot be computed.
 */
export const READ_WAITING_FALLBACK_CAVEAT = (): string =>
  envStr(
    'MANDREL_BRIEFING_WAITING_FALLBACK_CAVEAT',
    "LOW PRECISION — these rows were selected by status='blocked', which answers \"is this " +
      'task stopped\", not "is a PERSON the thing it is stopped on". Most blocked tasks are ' +
      "waiting on another TASK. Measured on the authors' own project: 1 of 13 status=blocked " +
      "tasks was actually waiting on a human. Set tasks.blocked_on='human' and this section " +
      'selects exactly — no guessing, no tag convention',
  );

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO-TIER DEADLINE (SCOPE §2 P5.5 item 4) — a DEADLINE and a HINT are not the
// same claim, and the render may never let a reader mistake one for the other.
// ─────────────────────────────────────────────────────────────────────────────

/** The marker for a STRUCTURED deadline (the `due_at` column). Authoritative; it SORTS. */
export const WAITING_DUE_MARKER = 'due';
/** The marker for a date found in PROSE. A hint. It does NOT sort. */
export const WAITING_DUE_HINT_MARKER = 'due?';

/**
 * THE PROSE-DATE SCAN — deliberately ISO-8601 CALENDAR DATES ONLY (`YYYY-MM-DD`).
 *
 * NARROW ON PURPOSE, and the narrowness is STATED IN THE RENDER rather than hidden. Every
 * other common written form is either locale-ambiguous (`03/04/2026` is two different days
 * on two continents) or needs a natural-language date parser, and a parser that is wrong 5%
 * of the time inside a section headed "deadline" is worse than one that reads only the
 * unambiguous form. This states what it MATCHES; it makes no claim about what a date it
 * misses cannot be.
 *
 * THIS TIER NEEDS NO CONVENTION AND NO MIGRATION. It reads whatever prose a customer has
 * written today, which is why it ships whether or not `due_at` is ever populated.
 */
export const WAITING_DUE_HINT_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/** What the render says a `due?` marker means. The honesty of the second tier lives here. */
export const READ_WAITING_DUE_HINT_CAVEAT = (): string =>
  envStr(
    'MANDREL_BRIEFING_WAITING_DUE_HINT_CAVEAT',
    `a \`${WAITING_DUE_HINT_MARKER}\` value is an ISO date found in the task's own PROSE. ` +
      'It is NOT the due_at field, it does NOT sort, and it may not be a deadline at all — ' +
      'a date in a title is as likely to be a release, a measurement or a filename. Only a ' +
      `\`${WAITING_DUE_MARKER}\` value is a deadline`,
  );

// ─────────────────────────────────────────────────────────────────────────────
// THE DATA-QUALITY FINDING (SCOPE §2 P5.5 item 6) — surface the defect, do NOT fix it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SPELLING-COLLISION CHECK, AND WHY IT CARRIES NO VOCABULARY.
 *
 * The concrete defect is ours: `needs-operator` and `needs:operator` are ONE CONCEPT SPELLED TWO
 * WAYS, both live, so a consumer that picks one spelling sees a fraction of the truth. The
 * naive fix is a synonym table — which would put OUR person's name in the product (SCOPE §4
 * forbids exactly that) and would only ever find the collisions we already knew about.
 *
 * So the check is STRUCTURAL instead: two tags collide when they differ ONLY in their
 * separators. `needs-operator`, `needs:operator`, `needs_operator` and `Needs Operator` all fold to one
 * key; `needs-operator` and `needs-coordinator` do not. That detects our own defect, needs no
 * convention, and works on any customer's tag set on day one.
 *
 * ⚠️ IT REPORTS. IT DOES NOT NORMALISE. Folding the two spellings together would hide the
 * defect one layer down and leave the customer's stored rows still split — the surfacing IS
 * the feature (SCOPE §2 P5.5 item 6).
 */
export const TAG_COLLISION_NORMALIZE_RE = /[-:_\s]+/g;
export const TAG_COLLISION_SEPARATOR = '-';

/**
 * FOLD A TAG TO ITS SPELLING KEY: lowercase, then collapse every run of separator
 * characters to one. `needs-operator`, `needs:operator`, `needs_operator`, `Needs  Operator` → the same
 * key. `needs-operator` and `needs-coordinator` stay different.
 *
 * NOTE WHAT THIS IS NOT: it is not a normaliser any write path applies. Nothing stores its
 * output. It exists only to GROUP spellings so the difference can be REPORTED — at read
 * time by the briefing finding, and at write time by services/tagSpellingWriteCheck.ts.
 *
 * It lives in this config module, not beside either consumer, because it is the ONE
 * definition of the rule and both halves must fold identically — a read-time finding and a
 * write-time warning that disagreed about what collides would be worse than either alone.
 */
export function tagSpellingKey(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(TAG_COLLISION_NORMALIZE_RE, TAG_COLLISION_SEPARATOR);
}

/** Whether the briefing reports tag-spelling collisions at all. Default TRUE. */
export const READ_TAG_COLLISION_FINDING_ENABLED = (): boolean =>
  envBool('MANDREL_BRIEFING_TAG_COLLISION_ENABLED', true);

/**
 * How many collision groups the finding names before it stops listing and starts counting.
 * A finding that prints 400 lines is a finding nobody reads.
 */
export const READ_TAG_COLLISION_MAX_GROUPS = (): number =>
  envInt('MANDREL_BRIEFING_TAG_COLLISION_MAX_GROUPS', 5);

// ─────────────────────────────────────────────────────────────────────────────
// READING BACK WHAT 093 LET US WRITE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ORDERINGS `task_list` will apply, as a closed named set (the operator's standing
 * configs-not-hardcoded rule, and the same "one declaration, no second list" shape
 * `threadingVocabConfig.LENS_AXES` uses — `middleware/validation.ts` builds its enum from
 * THIS array, so the advertised surface and the enforced SQL cannot disagree).
 *
 * `priority` is the historical default and is unchanged: priority DESC, created_at DESC,
 * id DESC. `dueAt` is what makes "what is due in the next N days" answerable — it orders
 * `due_at ASC NULLS LAST` and then falls through to the SAME total order, because the
 * deadline column is null for all but a handful of rows and a partial order under
 * OFFSET paging can show one task twice and hide another.
 */
export const TASK_LIST_SORTS = Object.freeze(['priority', 'dueAt'] as const);
export type TaskListSort = (typeof TASK_LIST_SORTS)[number];

/** The ordering applied when the caller asks for none. */
export const TASK_LIST_SORT_DEFAULT: TaskListSort = 'priority';
// THE WRITE-TIME HALF OF THE SAME CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY A READ-TIME FINDING WAS NOT ENOUGH, measured.
 *
 * The briefing finding above SURFACES a collision that already exists. It cannot stop one
 * from being created, and a cleanup that nothing defends silently undoes itself the next
 * time somebody types the other spelling. So the same structural rule runs at the WRITE
 * boundary, in exactly the shape an invalid `scope:` value already gets: the write is
 * ACCEPTED, the tag is stored untouched, the problem is NAMED, and the caller is told the
 * spelling this project already uses.
 *
 * THE MEASUREMENT THAT SIZED IT (2026-08-31, project riverbend, all 1152 tasks, no tag
 * filter — the population was swept rather than queried for spellings someone guessed):
 * 1511 distinct tags, 13 separator-only collision groups. `needs-operator`/`needs:operator` was
 * one of them and not the worst. The `phase-N`/`phase:N` family was FIVE groups, and it is
 * the one that bites a SHIPPED FILTER: task_list's `phase` parameter matches only
 * `phase-<n>`, so 16 tasks — whole phased programmes — are invisible to it. Verified live:
 * `task_list phase:"5"` returns 0 while a task tagged `phase:5` exists. Zero results reads
 * as "no such phase", which is the dangerous direction of a wrong count.
 *
 * IT STILL CARRIES NO VOCABULARY. Same fold as TAG_COLLISION_NORMALIZE_RE, and the
 * suggested spelling is whichever one THIS PROJECT already uses most — a fact about the
 * caller's own data, not a preference of ours. There is no synonym table and no list of
 * our tags anywhere in this path.
 */

/** Whether the task/decision write boundary warns about a colliding tag spelling. Default TRUE. */
export const READ_TAG_COLLISION_WRITE_WARNING_ENABLED = (): boolean =>
  envBool('MANDREL_TAG_COLLISION_WRITE_WARNING_ENABLED', true);

/**
 * How many colliding tags one write reports before it stops naming and starts counting.
 * A write that returns 40 warnings has buried the one that mattered.
 */
export const READ_TAG_COLLISION_WRITE_MAX_WARNINGS = (): number =>
  envInt('MANDREL_TAG_COLLISION_WRITE_MAX_WARNINGS', 3);

/**
 * How many existing spellings a single warning names before it summarises. Bounded for the
 * same reason, and low because a group with more than a couple of spellings is already a
 * finding the reader will act on.
 */
export const READ_TAG_COLLISION_WRITE_MAX_EXISTING = (): number =>
  envInt('MANDREL_TAG_COLLISION_WRITE_MAX_EXISTING', 3);
