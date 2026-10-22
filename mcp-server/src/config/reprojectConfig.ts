/**
 * REPROJECT — the declared answer to "when a record moves to another project, WHAT ELSE
 * carries a copy of its project id?"
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────────────────
 * `project_id` is DENORMALIZED across this schema. Moving a record is therefore not one
 * UPDATE: measured on a migrated DB (2026-08-27) there are 36 BASE TABLES carrying a
 * `project_id` column, and several of them are read with `... AND project_id = $2` as part
 * of the product's signature surface:
 *
 *   services/branchMembership.ts:228   `FROM links l ... AND l.project_id = $2`
 *   services/handoffHead.ts:235        `FROM links l ... AND l.project_id = $2`
 *
 * So a "move" that updates only `contexts.project_id` leaves the record's typed edges
 * stamped with the OLD project, and the moved record's branch history and handoff chain go
 * blind IN THE DESTINATION — silently, with no error and no missing row anywhere. That is
 * a worse outcome than refusing to move at all, because it looks like it worked.
 *
 * ── WHY A DECLARED REGISTRY AND NOT A DERIVATION ───────────────────────────────────────
 * services/projectCascade.ts derives the delete blast radius from `pg_constraint`, and that
 * is the right shape THERE: a row is destroyed by `DELETE FROM projects` if and only if a
 * cascading FK reaches it, so the FK IS the choke point and the catalog cannot be bypassed.
 *
 * There is no equivalent catalog fact here. The tables that must follow a record are tied
 * to it POLYMORPHICALLY — `links.from_id` / `links.to_id` / `branch_memberships.record_id`
 * hold a context, decision OR task id and carry NO foreign key at all (their endpoints span
 * three tables). Postgres does not know those columns point at a record, so no query of the
 * catalog can tell us. The relationship is a fact about the application, so it is declared
 * by the application — here, once.
 *
 * ── WHAT KEEPS THE DECLARATION FROM ROTTING ────────────────────────────────────────────
 * A hand-written allow-list is exactly the shape that silently under-covers after the next
 * migration. So the registry below is NOT an allow-list of the tables we move:
 * it is a CLASSIFICATION OF EVERY TABLE THAT HAS A `project_id` COLUMN, and
 * `src/tests/reprojectSatelliteCoverage.contract.test.ts` reads the live catalog and REDs
 * on any base table carrying `project_id` that nobody has classified here. A migration that
 * adds a project-scoped table cannot land without someone answering the question — the
 * failure mode is a RED test, not a silently half-moved record.
 *
 * DENY BY DEFAULT: unclassified is a FINDING, never a pass.
 *
 * configs-not-hardcoded: this module carries the table/column vocabulary. It is a static
 * mapping (no env, no tunables) — the same posture as config/opRegistry.ts.
 */

/** The record kinds a caller can move. These are the three `links` endpoint types. */
export const REPROJECT_RECORD_TYPES = ['context', 'decision', 'task'] as const;
export type ReprojectRecordType = (typeof REPROJECT_RECORD_TYPES)[number];

/** The table each record type lives in — the row whose `project_id` IS the membership. */
export const RECORD_TABLE: Readonly<Record<ReprojectRecordType, string>> = Object.freeze({
  context: 'contexts',
  decision: 'technical_decisions',
  task: 'tasks',
});

/**
 * The CREATION TIMESTAMP column for each record type — declared, because it is NOT the same
 * name on all three. `contexts` and `tasks` have `created_at`; `technical_decisions` has
 * `decision_date` and NO `created_at` column at all.
 *
 * This is here rather than inlined because assuming `created_at` is exactly the mistake the
 * first cut made: the move read `created_at FROM technical_decisions` and every decision move
 * died with an opaque datastore error. Caught by reproject.contract.test.ts C6, which is why
 * that case exercises a task AND a decision rather than trusting contexts to stand for all
 * three.
 */
export const RECORD_CREATED_AT_COLUMN: Readonly<Record<ReprojectRecordType, string>> =
  Object.freeze({
    context: 'created_at',
    decision: 'decision_date',
    task: 'created_at',
  });

/** The `resolveEntityId` entity name for each record type (short-id resolution). */
export const RECORD_ENTITY: Readonly<Record<ReprojectRecordType, 'context' | 'decision' | 'task'>> =
  Object.freeze({ context: 'context', decision: 'decision', task: 'task' });

/**
 * How a satellite table's rows are tied to ONE record.
 *
 * `columns` are OR-ed (`WHERE a = $1 OR b = $1`), which is what "this row is about that
 * record" means when a table can reference it from more than one column — the same OR the
 * cascade survey uses for multi-column FKs, and for the same reason: a row referenced twice
 * is still ONE row.
 *
 * `types` narrows the match to the record kinds a column can actually hold, so moving a
 * context never touches a table keyed by `decision_id`. Where a column is polymorphic
 * (`links.from_id`) it lists all three.
 */
export interface SatelliteMatch {
  /** Columns that hold the moved record's id. OR-ed together. */
  readonly columns: readonly string[];
  /** Record kinds those columns can hold. */
  readonly types: readonly ReprojectRecordType[];
}

/**
 * How a `project_id`-bearing table is treated by a move.
 *
 *  'record'   — the record row ITSELF (contexts / technical_decisions / tasks). Its
 *               project_id is the membership being changed.
 *  'follows'  — rows are ABOUT one record; their project_id is a denormalized copy of that
 *               record's membership and MUST follow it, or a project-scoped read of the
 *               destination cannot see them.
 *  'endpoints'— rows join TWO records (an edge, an adjudicated pair). project_id cannot
 *               simply follow one endpoint, because after the move the two endpoints may
 *               live in different projects. Handled by the explicit edge policy in
 *               services/reproject.ts — NOT by the generic follower loop.
 *  'caller-slot'
 *             — a per-CALLER cursor, keyed `(project_id, session_key)`. The row belongs to a
 *               session, not to the record it happens to point at, and its PK means moving it
 *               would COLLIDE with whatever slot that session already holds in the
 *               destination. A record move must not silently relocate someone else's cursor,
 *               so these are left alone and REPORTED — the move result names how many open
 *               positions were left standing on the record in the source project.
 *  'unrelated'— the project_id describes something that is not a single record (a session,
 *               a commit, a code scan, an actor default). A record moving between projects
 *               does not change what those rows are about, so they are deliberately left
 *               alone. The `reason` is the co-located justification.
 */
export type SatelliteClass = 'record' | 'follows' | 'endpoints' | 'caller-slot' | 'unrelated';

export interface SatelliteEntry {
  readonly table: string;
  readonly kind: SatelliteClass;
  /** REQUIRED for 'follows' — how rows are tied to the moved record. */
  readonly match?: SatelliteMatch;
  /** REQUIRED for every kind EXCEPT 'record' and 'follows' — why this table does not follow. */
  readonly reason?: string;
}

/**
 * EVERY base table that carries a `project_id` column, classified.
 *
 * The population was read off a migrated database, not remembered:
 *   SELECT t.table_name FROM information_schema.tables t
 *    WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
 *      AND EXISTS (SELECT 1 FROM information_schema.columns c
 *                   WHERE c.table_schema='public' AND c.table_name=t.table_name
 *                     AND c.column_name='project_id')
 * — which is the same query the coverage test re-runs, so this list is checked against the
 * live schema on every run rather than trusted.
 */
export const REPROJECT_SATELLITES: readonly SatelliteEntry[] = Object.freeze([
  // ── the record rows themselves ───────────────────────────────────────────────────────
  { table: 'contexts', kind: 'record' },
  { table: 'technical_decisions', kind: 'record' },
  { table: 'tasks', kind: 'record' },

  // ── rows ABOUT one record: project_id must follow it ─────────────────────────────────
  {
    table: 'branch_memberships',
    kind: 'follows',
    // A record's membership of a branch. Keyed by record_id (PK), and read via
    // `idx_branch_memberships_spine (project_id, spine_id, created_at)` — a membership left
    // in the source project is invisible to every branch read in the destination.
    match: { columns: ['record_id'], types: ['context', 'decision', 'task'] },
  },
  {
    table: 'branch_membership_moves',
    kind: 'follows',
    // The audit trail of branch reassignments FOR that record.
    match: { columns: ['record_id'], types: ['context', 'decision', 'task'] },
  },
  {
    table: 'decision_outcomes',
    kind: 'follows',
    match: { columns: ['decision_id'], types: ['decision'] },
  },
  {
    table: 'decision_retrospectives',
    kind: 'follows',
    match: { columns: ['decision_id'], types: ['decision'] },
  },
  {
    table: 'task_claim_events',
    kind: 'follows',
    match: { columns: ['task_id'], types: ['task'] },
  },
  {
    table: 'task_attachments',
    kind: 'follows',
    // A task's uploaded images (migration 102, Punch List). The Command backend authorizes
    // every attachment read/delete by THIS column (middleware/taskAttachmentAuthz.ts →
    // TaskAttachmentService.getOwningProjectId), so a copy left in the source project is a
    // stale grant for the old project's users and a 403 for the new project's.
    match: { columns: ['task_id'], types: ['task'] },
  },

  // ── a per-CALLER cursor that happens to point at the record ──────────────────────────
  {
    table: 'branch_positions',
    kind: 'caller-slot',
    match: { columns: ['spine_id'], types: ['context', 'decision', 'task'] },
    reason:
      'the LIVE branch pointer, PK (project_id, session_key) — one slot per session per ' +
      'project. It belongs to whoever opened it, not to the spine it points at, and moving ' +
      'it would collide with the slot that session already holds in the destination. Left ' +
      'in place and REPORTED as a stranded position.',
  },
  {
    table: 'active_thread_anchors',
    kind: 'caller-slot',
    match: { columns: ['task_id', 'decision_id'], types: ['decision', 'task'] },
    reason:
      'the RETIRED anchor (superseded by branch_positions; mints nothing on prod today). ' +
      'Same PK (project_id, session_key) and the same reason as branch_positions.',
  },

  // ── rows joining TWO records: the edge policy owns these ─────────────────────────────
  {
    table: 'links',
    kind: 'endpoints',
    match: { columns: ['from_id', 'to_id'], types: ['context', 'decision', 'task'] },
    reason:
      'a typed edge joins two records. After the move its endpoints may sit in different ' +
      'projects, so project_id cannot follow one of them unconditionally — see the EDGE ' +
      'POLICY in services/reproject.ts, which re-stamps an edge only when BOTH endpoints ' +
      'end up in the destination and otherwise leaves the writer-project stamp intact and ' +
      'marks the row cross-project. This is the ONLY endpoints table the policy runs over, ' +
      'because it is the only one read with `AND project_id = $n` on a product path.',
  },
  {
    table: 'decision_impact_analysis',
    kind: 'endpoints',
    match: { columns: ['source_decision_id', 'impacted_decision_id'], types: ['decision'] },
    reason:
      'an analysis OF A PAIR of decisions (source → impacted). Two endpoints, so project_id ' +
      'cannot follow one of them — and unlike `links` this row is not read on any ' +
      'project-scoped path (grep for the table name: no non-test reader exists in this ' +
      'tree), so there is nothing for a re-stamp to fix. Left intact; the analysis was ' +
      'performed in the project it says it was.',
  },
  {
    table: 'belief_adjudications',
    kind: 'endpoints',
    match: { columns: ['a_id', 'b_id'], types: ['context', 'decision', 'task'] },
    reason:
      'the adjudicated verdict on a PAIR (a_id vs b_id). Two endpoints, so the edge policy ' +
      'governs; and unlike a typed edge this row is a record of an adjudication that was ' +
      'PERFORMED in a project, which is a historical fact the move must not rewrite.',
  },

  // ── project_id that is not about a single record ─────────────────────────────────────
  {
    table: 'sessions',
    kind: 'unrelated',
    reason:
      'a session is a unit of WORK, not a record. Its project is where that work happened; ' +
      'moving one record it produced does not relocate the session. The moved record keeps ' +
      'its session_id (provenance is preserved, which is the whole point of a move).',
  },
  { table: 'sessions_shadow', kind: 'unrelated', reason: 'dual-write shadow of sessions; follows its source table, not a record.' },
  { table: 'contexts_shadow', kind: 'unrelated', reason: 'dual-write shadow of contexts — maintained by contexts_dual_write_trigger on the UPDATE this move performs, never written directly.' },
  { table: 'analytics_events_shadow', kind: 'unrelated', reason: 'dual-write shadow of analytics_events; maintained by its trigger, not written directly.' },
  {
    table: 'sessions_backup_52d295df_9b0d_4b13_812f_c7353b530d7b',
    kind: 'unrelated',
    reason: 'a frozen point-in-time BACKUP of sessions. A backup that changes is not a backup.',
  },
  {
    table: 'sessions_backup_64fbdb1e_d900_4b17_969c_2a34f53de6a3',
    kind: 'unrelated',
    reason: 'a frozen point-in-time BACKUP of sessions. A backup that changes is not a backup.',
  },
  { table: 'session_project_mappings', kind: 'unrelated', reason: 'which project a SESSION was mapped to; about a session, not a record.' },
  { table: 'actor_project_defaults', kind: 'unrelated', reason: 'an ACTOR\'s default project. About a caller, not a record.' },
  { table: 'user_project_access', kind: 'unrelated', reason: 'authorization: which users may reach a project. About people, not records.' },
  { table: 'event_log', kind: 'unrelated', reason: 'an append-only log of events that HAPPENED in a project. Rewriting history is not a move.' },
  { table: 'analytics_events', kind: 'unrelated', reason: 'an append-only analytics EVENT emitted while working in a project. Its context_id is a reference, not ownership — re-attributing historical events would corrupt every per-project analytic computed over them.' },
  { table: 'analysis_session_links', kind: 'unrelated', reason: 'a CORRELATION between an analysis session and a development session; its context_id/decision_id are correlation evidence, not ownership.' },
  { table: 'belief_adjudication_costs', kind: 'unrelated', reason: 'the token/dollar cost of an adjudication run, billed to the project it ran in. A spend record is a historical fact.' },
  { table: 'belief_adjudication_attempts', kind: 'unrelated', reason: 'one ATTEMPT the belief pipeline made while working in a project — completed or failed. Append-only telemetry of what the pipeline DID, exactly like the cost ledger beside it: the reliability rate of a past run is a historical fact, and re-stamping it would move failures out of the project that actually suffered them.' },
  { table: 'decision_learning_insights', kind: 'unrelated', reason: 'a pattern MINED ACROSS many decisions in a project (source_decisions is a set). Not about one record.' },
  { table: 'commit_session_links', kind: 'unrelated', reason: 'correlates a git commit with a session. Its context_ids/decision_ids are a correlation payload, not ownership.' },
  { table: 'git_commits', kind: 'unrelated', reason: 'a git commit in the project\'s repo. Not a Mandrel record.' },
  { table: 'git_branches', kind: 'unrelated', reason: 'a git branch in the project\'s repo. Not a Mandrel record.' },
  { table: 'git_file_changes', kind: 'unrelated', reason: 'a file change within a git commit. Not a Mandrel record.' },
  { table: 'code_analysis_sessions', kind: 'unrelated', reason: 'a code scan of the project\'s tree. Not a Mandrel record.' },
  { table: 'code_components', kind: 'unrelated', reason: 'a component discovered by a code scan. Not a Mandrel record.' },
  { table: 'code_dependencies', kind: 'unrelated', reason: 'a dependency edge between code components. Not a Mandrel record.' },
  { table: 'file_analysis_cache', kind: 'unrelated', reason: 'a cache of per-file analysis for the project\'s tree. Not a Mandrel record.' },
]);

/** Index by table name — one lookup, no repeated scans. */
export const SATELLITE_BY_TABLE: ReadonlyMap<string, SatelliteEntry> = new Map(
  REPROJECT_SATELLITES.map((s) => [s.table, s]),
);

/**
 * The tables whose project_id FOLLOWS a move of `type`, with the columns to match on.
 * This is what services/reproject.ts iterates — it never carries its own list.
 */
export function followersFor(type: ReprojectRecordType): SatelliteEntry[] {
  return REPROJECT_SATELLITES.filter(
    (s) => s.kind === 'follows' && s.match!.types.includes(type),
  );
}
