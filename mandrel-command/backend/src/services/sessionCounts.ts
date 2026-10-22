/**
 * SESSION COUNT SQL — the single source of "how many contexts / tasks / decisions does
 * this session have", for every read path in mandrel-command's backend.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 * Six different backend queries each wrote their own version of this rule, and they had
 * drifted into four different answers:
 *   - sessionAnalytics.getSessionsList  → the denormalized s.contexts_created column
 *   - controllers/session.getCurrentSession → the column, plus a project-guarded subquery
 *   - controllers/session.fetchSessionSummary → `s.contexts_created AS context_count`
 *   - project.getRecentSessions → `s.contexts_created as context_count`
 * The last two are the nastiest shape: a POISONED ALIAS. A consumer writing the defensive
 * `contexts_created ?? context_count` gets the same broken number twice and cannot tell.
 *
 * The columns are broken because SessionRepo.finish() absolute-SET them from an in-memory
 * DELTA (see the autopsy on that function). The write path is fixed, but ~79 prod rows are
 * already destroyed, and the counts — unlike tokens — are recomputable. So every read
 * derives from the child tables, and it derives them THE SAME WAY, from here.
 *
 * ── THE TWO-RULE PROJECT SEMANTICS (do not "simplify" this away) ─────────────────────────
 * Already documented and deliberately chosen at sessionAnalytics.ts (getSessionAnalytics):
 *
 *   RULE 1 — UNFILTERED VIEW (no project filter, or a single session's own total):
 *     count EVERY context linked to the session by `session_id`. Do NOT additionally
 *     require `c.project_id = s.project_id`. Pre-SR-1 long-running sessions did
 *     mid-session `project_switch`es; correlating the context's project to the SESSION's
 *     project drops 1715 of 7271 legitimately session-linked contexts on prod (24%,
 *     measured 2026-07-26).
 *
 *   RULE 2 — PROJECT-FILTERED VIEW: a context counts for project P only if the CONTEXT
 *     itself belongs to P (`c.project_id = $P`). This is what preserves the cross-project
 *     isolation contract: a session bound to project A must not attribute its project-B
 *     contexts to A.
 *
 * The failure mode being guarded is the third, wrong thing that was actually in the code:
 * `c.project_id = s.project_id`, a correlation to the SESSION's project, which is neither
 * rule and under-reports under both.
 *
 * ── WHAT KEEPS THIS COPY HONEST ─────────────────────────────────────────────────────────
 * This is COPY 3 of a rule with three copies (COPY 1 = the `v_session_summaries` view,
 * migration 070; COPY 2 = mcp-server SessionRepo.IDENTITY_SELECT / getFinalCounts). They
 * cannot be merged into one accessor across a SQL view and two packages, so the guard is
 * `src/__tests__/sessionCountRule.contract.test.ts` (+ its mcp-server twin
 * `mcp-server/src/tests/sessionCountRule.contract.test.ts`): both EXECUTE their copies
 * against one cross-project fixture and compare the numbers to the same literals. Re-add
 * the project guard to the builder below and those suites go RED — measured, not assumed.
 *
 * ── TASK LINKAGE: t.session_id, NOT s.id::text = t.created_by ────────────────────────────
 * getSessionsList joined `LEFT JOIN tasks t ON s.project_id = t.project_id AND s.id::text =
 * t.created_by`. `tasks.created_by` holds an ACTOR NAME (coordinator / system / curator / Amp /
 * …), not a session uuid. Measured on prod 2026-07-26:
 *     tasks whose created_by is any session's uuid ...... 0 of 3195
 *     sessions with ≥1 task via created_by ............... 0 of 457
 *     sessions with ≥1 task via t.session_id ............ 205 of 457 (2731 tasks)
 * So the switch is strictly additive — the old linkage covered no session the new one
 * misses, because it covered none at all.
 *
 * ── CORRELATED SUBQUERIES, NOT JOINS ────────────────────────────────────────────────────
 * The old list query put two LEFT JOINs (contexts, tasks) under one GROUP BY and counted
 * with non-DISTINCT COUNT(c.id) / COUNT(t.id). That fans out cartesian-style: each count is
 * multiplied by the other's cardinality. It was dormant only because the tasks join matched
 * nothing (see above) — i.e. the bug that hid it was the bug next to it. Subqueries remove
 * the class rather than papering it with COUNT(DISTINCT …).
 *
 * Indexes: idx_contexts_session_id (migration 002), idx_tasks_session_id (021),
 * idx_technical_decisions_session_id (069).
 *
 * ── ARCHIVED CHILD ROWS ARE EXCLUDED ────────────────────────────────────
 * Every builder below carries `AND <alias>.archived_at IS NULL`, so a session's counts mean
 * "records this session produced that you can still find" — matching context_search /
 * decision_search / task_list, which have excluded archived rows by default since an earlier task
 * . Measured on live prod 2026-07-30 these counts were inflated by 18 archived
 * contexts, 429 archived decisions and 23 archived tasks.
 *
 * ALL THREE COPIES were changed together (COPY 1 = migration 074, COPY 2 = SessionRepo +
 * SessionManagementHandler + SessionStatsService). Changing fewer would have produced the
 * exact divergence this module exists to prevent — and the contract suites named above
 * would NOT have caught it, because their fixture archived nothing. That fixture now seeds
 * archived rows on all three child tables, so the archived axis is guarded from here on.
 *
 * ── TOKENS ARE NOT HERE ON PURPOSE ──────────────────────────────────────────────────────
 * `total_tokens` has no child table and is not recomputable: recordTokenUsage writes only to
 * the in-memory TokenStore, nothing on the tool-call path populates
 * analytics_events.prompt_tokens/completion_tokens, and the session_end event omits tokens.
 * The `sessions.total_tokens` column is the only durable record, so token reads keep using
 * it. For sessions zeroed by the pre-fix finish(), that history is LOST — there is no
 * backfill and none is possible.
 */

/**
 * Contexts belonging to a session.
 *
 * @param sessionAlias  the `sessions` alias in the enclosing query (usually `s`)
 * @param projectParam  a bound-parameter reference (e.g. `'$2'`) when the caller is
 *                      rendering a PROJECT-FILTERED view — applies RULE 2, filtering on the
 *                      CONTEXT's own project. Omit for RULE 1 (unfiltered / a single
 *                      session's own total).
 *
 * Never pass `${sessionAlias}.project_id` here — that reconstructs the exact bug this
 * module exists to remove.
 */
export function contextCountSql(sessionAlias = 's', projectParam?: string): string {
  const projectFilter = projectParam ? ` AND c.project_id = ${projectParam}` : '';
  return `COALESCE((SELECT COUNT(*) FROM contexts c WHERE c.session_id = ${sessionAlias}.id AND c.archived_at IS NULL${projectFilter}), 0)`;
}

/** Tasks belonging to a session (RULE 2 filter applies to the TASK's own project). */
export function taskCountSql(sessionAlias = 's', projectParam?: string): string {
  const projectFilter = projectParam ? ` AND t.project_id = ${projectParam}` : '';
  return `COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = ${sessionAlias}.id AND t.archived_at IS NULL${projectFilter}), 0)`;
}

/** Completed tasks belonging to a session. */
export function completedTaskCountSql(sessionAlias = 's', projectParam?: string): string {
  const projectFilter = projectParam ? ` AND t.project_id = ${projectParam}` : '';
  return `COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = ${sessionAlias}.id AND t.archived_at IS NULL AND t.status = 'completed'${projectFilter}), 0)`;
}

/**
 * Decisions belonging to a session.
 *
 * `sessions.decisions_created` has NO runtime writer anywhere in the tree — the only
 * assignment is `SET decisions_created = 0` in migration 042 — so it is permanently 0 on
 * every prod row and any surface reading it renders a GUARANTEED zero. Always derive.
 */
export function decisionCountSql(sessionAlias = 's', projectParam?: string): string {
  const projectFilter = projectParam ? ` AND d.project_id = ${projectParam}` : '';
  return `COALESCE((SELECT COUNT(*) FROM technical_decisions d WHERE d.session_id = ${sessionAlias}.id AND d.archived_at IS NULL${projectFilter}), 0)`;
}

/**
 * Task completion RATE (0-100), derived from the same child-table counts so it can never
 * disagree with the two numbers next to it. Guards divide-by-zero.
 */
export function taskCompletionRateSql(sessionAlias = 's', projectParam?: string): string {
  const created = taskCountSql(sessionAlias, projectParam);
  const completed = completedTaskCountSql(sessionAlias, projectParam);
  return `CASE WHEN ${created} > 0 THEN ROUND((${completed}::numeric / ${created}::numeric) * 100, 2) ELSE 0 END`;
}
