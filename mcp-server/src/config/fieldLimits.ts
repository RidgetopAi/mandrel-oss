/**
 * FIELD LIMITS — the single source of truth for every field-size cap the MCP
 * validators enforce.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every field-size tunable lives HERE — a named value with a stated justification —
 * never a magic literal buried in a zod schema. Mirrors config/taskConfig.ts,
 * config/linksConfig.ts, config/recallConfig.ts.
 *
 * ── THE BUG CLASS THIS MODULE EXISTS TO KILL ──────────────────────────────────
 * middleware/validation.ts carried ~30 hand-written `.max(N)` literals that had
 * DRIFTED from the columns they validate, in BOTH directions:
 *
 *   (a) TOO TIGHT — the validator rejected values the DB would happily store.
 *       `task_create.description` capped at 2000 while `tasks.description` is
 *       Postgres TEXT (unbounded). This rejected a live incident record three
 *       times in two minutes and forced a spec out of a task and into a context,
 *       breaking our own "the task is the spine of a thread" doctrine. A cap
 *       exists to stop ABUSE, not to police how much an agent may legitimately
 *       write (the `contexts.content` philosophy — see below).
 *
 *   (b) TOO LOOSE — the validator accepted values the DB will REJECT. `assignedTo`
 *       / `createdBy` were plain unbounded `z.string()`, but `tasks.assigned_to`
 *       and `tasks.created_by` are varchar(200). Nothing truncates in between, so
 *       a 201-char assignee sailed past validation and detonated in Postgres as a
 *       raw 22001 ("value too long") → an HTTP 500 with a driver error instead of
 *       the actionable zod message the caller deserves. (b) is the more dangerous
 *       half of the class and is exactly what a hand-maintained cap list misses.
 *
 * ── THE ANTI-DRIFT MECHANISM (why this can't silently re-drift) ───────────────
 * Caps are DERIVED from the column, not typed by hand:
 *
 *   varcharColumn(table, col, length) → max === length   (use the whole column)
 *   textColumn(table, col)            → max === TEXT_ANTI_ABUSE_CEILING
 *
 * so for a column-backed field there is no free number left to get wrong. The
 * declared `db` shape is then asserted against the LIVE `information_schema` of the
 * real migrated database by tests/fieldLimits.schema.test.ts. That closes the loop:
 *
 *   - Someone ALTERs a column (e.g. varchar(200) → varchar(400))?  The declared
 *     shape no longer matches reality → the test goes RED and names the column.
 *   - Someone hand-edits a cap in validation.ts?  The schemas read `cap()` from
 *     here, the invariant test asserts max === length / ceiling, AND the source
 *     scan rejects a raw `.max(N)` literal on any live z.string() field → RED.
 *
 * ⚠️ WHAT IS **NOT** GUARDED YET — read this before trusting the net:
 *   Adding a NEW column-backed field with a hand-rolled cap is only PARTLY caught.
 *   The source scan rejects a numeric literal (`z.string().max(300)`), but an
 *   UNBOUNDED `z.string()` over a NEW varchar column sails through — nothing walks
 *   the schemas and asserts that every string param touching a bounded column has a
 *   registry entry. That is direction (b), which this very module calls the more
 *   dangerous half: it fails as a raw Postgres 22001 → 500, not an actionable error.
 *   A coverage test that enumerates tool params → columns is the real fix and is a
 *   FOLLOW-UP TASK, not shipped here. Until it exists, a new column-backed field
 *   relies on review. (An earlier draft of this comment claimed such a coverage test
 *   already existed. It never did — and a comment that promises a guard is worse than
 *   no comment, because the next reader trusts it and stops looking. Do not re-add the
 *   claim until the test is green.)
 *
 * A deliberate deviation is still ALLOWED — but it must be declared via
 * `deviationReason`, which the invariant test requires whenever max !== the
 * column's natural bound. "Matches reality, or carries a written justification"
 * is therefore enforced by machinery, not by reviewer memory.
 *
 * NOTE ON SCOPE: this module governs SIZE caps only. Enum/vocabulary drift is
 * already handled by its own single sources (config/edgeTypes.ts, threadConfig.ts,
 * trustConfig.ts) — deliberately not tangled in here.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * The anti-abuse ceiling applied to every UNBOUNDED (Postgres TEXT) column.
 *
 * WHY 5,000,000 — and why the SAME number for every TEXT column: this is the
 * ceiling `contexts.content` has already shipped with, and its rationale is the
 * one we're standardizing on. A TEXT column has NO storage limit, so any cap we
 * choose is arbitrary UNLESS it is justified by a real constraint. The real
 * constraints are:
 *
 *   1. express.json's body limit is 10mb — a request carrying more never reaches
 *      the validator anyway, so a per-field ceiling above ~10mb is fiction.
 *   2. The process must not OOM on a pathological payload.
 *   3. It must sit FAR above any legitimate write (a ~23k-char conversational turn,
 *      a ~3k-char task spec, a long incident record) so it never polices content.
 *
 * 5MB satisfies all three. Using ONE named ceiling for every TEXT column (rather
 * than a bespoke number per field) is the point: a per-field number is a per-field
 * opportunity to drift. This is an ANTI-ABUSE GUARD, NOT A CONTENT CAP.
 *
 * env: MANDREL_TEXT_ANTI_ABUSE_CEILING
 */
export const TEXT_ANTI_ABUSE_CEILING = envInt('MANDREL_TEXT_ANTI_ABUSE_CEILING', 5_000_000);

/** The shape a column really has, as asserted against information_schema. */
export type DbColumnShape =
  | { readonly type: 'text' }
  | { readonly type: 'varchar'; readonly length: number };

/** One validator cap, bound to the real column it protects. */
export interface ColumnBackedLimit {
  /** Postgres table name (information_schema.columns.table_name). */
  readonly table: string;
  /** Postgres column name (information_schema.columns.column_name). */
  readonly column: string;
  /** The column's DECLARED reality — asserted against the live schema by the test. */
  readonly db: DbColumnShape;
  /** The cap the validator enforces. DERIVED from `db` unless deviationReason is set. */
  readonly max: number;
  /** Why this field is capped at all / what the cap protects. Required, non-empty. */
  readonly why: string;
  /**
   * Set ONLY when `max` deliberately differs from the column's natural bound
   * (varchar length, or TEXT_ANTI_ABUSE_CEILING). The invariant test REQUIRES this
   * whenever they differ — a deviation must be argued in writing, never silent.
   */
  readonly deviationReason?: string;
}

/**
 * A varchar(N) column: the cap IS the column length. Using the full column is the
 * only non-arbitrary choice — anything smaller invents a limit the DB doesn't have,
 * anything larger hands Postgres a value it will reject with a raw 22001.
 */
function varcharColumn(
  table: string,
  column: string,
  length: number,
  why: string
): ColumnBackedLimit {
  return { table, column, db: { type: 'varchar', length }, max: length, why };
}

/** An unbounded TEXT column: the cap is the shared anti-abuse ceiling. */
function textColumn(table: string, column: string, why: string): ColumnBackedLimit {
  return { table, column, db: { type: 'text' }, max: TEXT_ANTI_ABUSE_CEILING, why };
}

/**
 * THE REGISTRY — every validator cap that is backed by a real column.
 *
 * Keyed `<table>.<column>` so an entry is trivially cross-checkable against
 * information_schema by eye AND by test. Verified against the live `mandrel`
 * database on 2026-07-17 (see tests/fieldLimits.schema.test.ts, which re-verifies
 * this on every CI run against the disposable migrated DB — never prod).
 */
export const COLUMN_BACKED_LIMITS = {
  // ── contexts ───────────────────────────────────────────────────────────────
  /**
   * The precedent that set the philosophy. Safe at the full ceiling because the
   * handler stores content in FULL but embeds only `content.substring(0, 1000)`
   * (handlers/context.ts), so the embedder's input limit is never reached no
   * matter how long the stored row is.
   */
  'contexts.content': textColumn(
    'contexts',
    'content',
    'Anti-abuse only, never a content cap: TEXT column, stored in full, embed path ' +
      'independently bounded to the first 1000 chars. The old .max(10000) rejected real ' +
      '~23k-char conversational turns (the LongMemEval pain) — that must not come back.'
  ),

  // ── tasks ──────────────────────────────────────────────────────────────────
  /**
   * THE HEADLINE FIX. Was .max(2000) against a TEXT column — the
   * cap that rejected a live incident record and forced a spec out of a task.
   */
  'tasks.description': textColumn(
    'tasks',
    'description',
    'A task description is the SPINE of a thread — it must hold a full spec, an incident ' +
      'record, or a repro without being forced into a context. TEXT column, not embedded, ' +
      'nothing downstream truncates it. Anti-abuse ceiling only.'
  ),
  /**
   * Was .max(255) against a varchar(500) column — 245 chars of the column were
   * simply unreachable through the tool for no stated reason.
   */
  'tasks.title': varcharColumn(
    'tasks',
    'title',
    500,
    'Use the whole column. A title is a short identifier, but the DB affords 500 and the ' +
      'validator has no business inventing a tighter limit the schema does not have.'
  ),
  /**
   * THE (b)-DIRECTION FIX: was an UNBOUNDED z.string(). A 201-char assignee passed
   * validation and hit Postgres as a raw 22001 → HTTP 500 instead of an actionable error.
   */
  'tasks.assigned_to': varcharColumn(
    'tasks',
    'assigned_to',
    200,
    'Free-form assignee string (NOT a uuid FK). Bounded to the column so an over-length ' +
      'assignee fails with an actionable zod message at the edge, never as a raw Postgres ' +
      '22001 "value too long" surfaced as a 500.'
  ),
  /** Same (b)-direction bug as assigned_to: unbounded validator over a varchar(200). */
  'tasks.created_by': varcharColumn(
    'tasks',
    'created_by',
    200,
    'Free-form "who/what created this task" string. Bounded to the column for the same ' +
      'reason as assigned_to — fail actionably at the edge, not with a driver error.'
  ),

  // ── projects ───────────────────────────────────────────────────────────────
  'projects.name': varcharColumn(
    'projects',
    'name',
    255,
    'Project display name. Cap is the column length.'
  ),
  'projects.description': textColumn(
    'projects',
    'description',
    'TEXT column, not embedded, nothing truncates it downstream. Was .max(2000) — an ' +
      'invented limit. Anti-abuse ceiling only.'
  ),

  // ── technical_decisions ────────────────────────────────────────────────────
  'technical_decisions.title': varcharColumn(
    'technical_decisions',
    'title',
    255,
    'Decision title. Cap is the column length (this one was already correct).'
  ),
  /**
   * The decision prose fields are all TEXT and all feed buildDecisionEmbeddingText.
   * That embed text is bounded at the call site (handlers/decisions.ts) to the
   * embedder's configured max, so a long decision degrades to a TRUNCATED embedding
   * rather than silently losing its embedding entirely. That bound is what makes the
   * full ceiling safe here.
   */
  'technical_decisions.description': textColumn(
    'technical_decisions',
    'description',
    'TEXT column. Was .max(5000). Embed path is bounded at the call site, so length here ' +
      'cannot cost the decision its embedding. Anti-abuse ceiling only.'
  ),
  'technical_decisions.rationale': textColumn(
    'technical_decisions',
    'rationale',
    'TEXT column. Was .max(2000) — the "why" behind a decision is exactly the prose we ' +
      'least want to truncate. Anti-abuse ceiling only.'
  ),
  'technical_decisions.problem_statement': textColumn(
    'technical_decisions',
    'problem_statement',
    'TEXT column. Was .max(2000). Anti-abuse ceiling only.'
  ),
  'technical_decisions.success_criteria': textColumn(
    'technical_decisions',
    'success_criteria',
    'TEXT column. Was .max(2000). The moat field for the GAP1 learning loop — record what ' +
      '"success" looks like in full. Anti-abuse ceiling only.'
  ),
  'technical_decisions.outcome_notes': textColumn(
    'technical_decisions',
    'outcome_notes',
    'TEXT column. Was .max(2000). Anti-abuse ceiling only.'
  ),
  'technical_decisions.lessons_learned': textColumn(
    'technical_decisions',
    'lessons_learned',
    'TEXT column. Was .max(2000). Lessons are the learning loop\'s payload — do not police them.'
  ),
  'technical_decisions.superseded_reason': textColumn(
    'technical_decisions',
    'superseded_reason',
    'TEXT column. Was .max(2000). Anti-abuse ceiling only.'
  ),
  // THE DECISION INBOX (migration 104).
  'technical_decisions.question': textColumn(
    'technical_decisions',
    'question',
    'TEXT column. The one-sentence thing being decided (required non-empty when ' +
      'answer_status=\'open\'). Anti-abuse ceiling only — the sentence itself is never ' +
      'meaningfully long, but nothing downstream truncates it, so it is not artificially capped.'
  ),
  'technical_decisions.answer_note': textColumn(
    'technical_decisions',
    'answer_note',
    'TEXT column. Carries decision_answer\'s note (folded into alternatives_considered) and ' +
      'decision_discuss\'s appended notes (a running log, not a replace). Anti-abuse ceiling only.'
  ),

  // ── sessions ───────────────────────────────────────────────────────────────
  'sessions.title': varcharColumn(
    'sessions',
    'title',
    255,
    'Session title. Cap is the column length (this one was already correct).'
  ),
  'sessions.session_goal': textColumn(
    'sessions',
    'session_goal',
    'TEXT column. Was .max(1000) (a bound copied from an older handler-side check, not from ' +
      'the schema). Anti-abuse ceiling only.'
  ),
  'sessions.actor': textColumn(
    'sessions',
    'actor',
    'TEXT column (migration 062). The stable principal that owns a session; used as a FILTER ' +
      'argument by session_list (Amp-orb eval W3). Anti-abuse ceiling only — ' +
      'an actor id can be an Amp thread id, which is long.'
  ),
} as const satisfies Record<string, ColumnBackedLimit>;

export type ColumnBackedLimitKey = keyof typeof COLUMN_BACKED_LIMITS;

/**
 * The cap for a column-backed field. USE THIS in validation.ts — never a literal.
 * Typed against the registry, so a typo'd key is a COMPILE error, not a runtime
 * `undefined` that would silently disable the cap.
 */
export function cap(key: ColumnBackedLimitKey): number {
  return COLUMN_BACKED_LIMITS[key].max;
}

/**
 * TRANSIENT LIMITS — caps on inputs that are NOT stored in a column.
 *
 * These are search queries, tool arguments, service paths, and filter values: they
 * are consumed in-request and never persisted, so there is NO column truth to derive
 * them from and the schema test cannot check them. That makes them the honest home
 * for a judgement call — but each one still has to SAY why it exists, and they live
 * here rather than as literals in the schemas. Kept separate from the registry above
 * precisely so "no column to check" is explicit rather than an unexamined gap.
 */
export const TRANSIENT_LIMITS = {
  /** Search/query strings (context_search, decision_search, smart_search). Never stored. */
  searchQuery: {
    max: 1000,
    why: 'A semantic query is embedded as a QUERY (not truncated like a document) and the ' +
      'embedder rejects >8000 chars. 1000 sits well under that and far above any real query.',
  },
  /** A tag element; contexts/tasks/decisions.tags are unbounded text[] — no column bound. */
  tagLength: {
    max: 50,
    why: 'Tags are handles, not prose. text[] column is unbounded, so this is a pure ' +
      'anti-abuse/legibility guard that keeps the tag grammar scannable.',
  },
  /** Max tags per record. */
  tagCount: {
    max: 20,
    why: 'Anti-abuse fan-out guard, well above the ~5-8 tags a real record carries.',
  },
  /** mandrel_ping message — echoed back, never stored. */
  pingMessage: {
    max: 500,
    why: 'Echoed diagnostic string, never persisted. Bounded so ping cannot be an echo amplifier.',
  },
  /** Tool name for mandrel_explain / mandrel_examples. */
  toolName: {
    max: 100,
    why: 'Looked up against the tool registry; the longest real tool name is ~25 chars.',
  },
  /** recall_thread anchor: a ref:<slug>, a uuid, or a short id. */
  threadAnchor: {
    max: 255,
    why: 'A ref:<slug> / uuid / short id — all far under this. Bounded, resolved in the engine.',
  },
  /** task_list `phase` filter — matched against the tags array as any separator/case spelling of `phase<sep><phase>` (config/phaseTagConfig.ts). */
  phaseFilter: {
    max: 50,
    why: 'Matched against a tag, so it inherits the tag length guard.',
  },
  /** get_recommendations `context` — an input prompt, never persisted. */
  recommendationContext: {
    max: 2000,
    why: 'Advisory input consumed in-request; bounded to keep the recommendation prompt sane.',
  },
  /** task_bulk_update `notes` — merged into the metadata JSONB blob, not a text column. */
  bulkUpdateNotes: {
    max: 2000,
    why: 'Merged into tasks.metadata (jsonb — no column length). A short annotation on a bulk ' +
      'sweep, not a spec; the spec belongs in tasks.description, which is now uncapped-but-guarded.',
  },
  /**
   * THE PUNCH LIST LANE (migration 101) — `punch.doneWhen` on
   * task_create / task_update / task_bulk_update. Shallow-merged into `tasks.metadata.punch`
   * (jsonb — no column length), so this is a policy bound, not a column one, matching
   * `bulkUpdateNotes` right above it.
   */
  punchDoneWhen: {
    max: 2000,
    why: 'Merged into tasks.metadata.punch (jsonb — no column length). The completion ' +
      'contract in the author\'s own words, not a spec — bounded the same as bulkUpdateNotes.',
  },
  /**
   * THE STRUCTURED PUNCH CONTRACT —
   * `punch.doneWhen[].proof`: the artifact the critic opens (a repo-relative path or a test
   * id), REQUIRED on a lane clause. Same policy-bound reasoning as `punchDoneWhen` above.
   */
  punchProof: {
    max: 500,
    why: 'A repo-relative path or a test id, not a spec. Merged into tasks.metadata.punch ' +
      '(jsonb — no column length); bounded the same as punchDoneWhen.',
  },
  /**
   * `punch.touches[]` — a repo-relative path/glob the change will edit.
   */
  punchTouches: {
    max: 255,
    why: 'A repo-relative path or glob, not prose. Merged into tasks.metadata.punch (jsonb ' +
      '— no column length); bounded well above any real path.',
  },
  /**
   * context_store `mode` — the HANDOFF CARRIED FIELD (P5.4). Stored into
   * contexts.metadata (jsonb — no column length), so this is a policy bound, not a
   * column one.
   *
   * TWO BOUNDS EXIST HERE ON PURPOSE, and they do different jobs:
   *   - THIS one is the ZOD boundary guard: pure anti-abuse, deliberately generous, and
   *     the ONLY one that can reject. It exists so a megabyte cannot be posted into a
   *     label field, nothing more.
   *   - handoffModeStored below is the SEMANTIC one, applied in the service, which
   *     TRUNCATES AND WARNS instead of rejecting. A handoff must never fail to store
   *     over its mode (services/handoffCarriedFields.ts).
   * Making the semantic bound the zod bound would turn "your mode is too wordy" into
   * "your handoff was not stored", which is the harm-ranking this feature is built on.
   */
  handoffMode: {
    max: 500,
    why: 'Anti-abuse boundary guard for a label field. The semantic bound that actually ' +
      'shapes the stored value is handoffModeStored, which truncates rather than rejects.',
  },
  /**
   * The length a `mode` is TRUNCATED to before storage. A mode is a label; a caller
   * pasting a description into it has misunderstood the field, and an unbounded string
   * here lands in the one briefing section the size cap cannot trim (the handoff is
   * cap-exempt). Truncated + warned, never rejected.
   */
  handoffModeStored: {
    max: 64,
    why: 'A mode is a label, not a description. Bounded because the handoff section of the ' +
      'briefing is EXEMPT from the size cap, so these chars cannot be trimmed downstream.',
  },
  /**
   * context_store `spine` — an id reference (id8 or full UUID) to the record the handoff
   * resumes. Anti-abuse only; the SHAPE check (is this even id-shaped) happens in the
   * service and warns rather than rejects.
   */
  handoffSpine: {
    max: 255,
    why: 'A uuid is 36 chars and an id8 is 8. Bounded well above both so the boundary guard ' +
      'never fights a legitimate reference; shape is validated in the service, warn-not-reject.',
  },
  // NOTE (MCP-2026 Phase 2 debt sweep): the `componentId` transient limit was removed — it
  // served the code_* tools, which no longer exist in the op registry, and `transientCap('componentId')`
  // had no callers left. Grep-confirmed dead before deletion (surface-don't-clobber).
} as const satisfies Record<string, { max: number; why: string }>;

export type TransientLimitKey = keyof typeof TRANSIENT_LIMITS;

/** The cap for a transient (non-column) input. Typo'd key = compile error. */
export function transientCap(key: TransientLimitKey): number {
  return TRANSIENT_LIMITS[key].max;
}
