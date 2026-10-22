/**
 * taskAuthorStamp — THE AUTHOR STAMP for `tasks.created_by`. (gap 3.)
 *
 * ═══ THE DEFECT THIS CLOSES ═══
 * MEASURED on prod 2026-09-05: `created_by` was NULL on 116 of 154 open tasks. Of the 61 open
 * tasks created in the last 30 days, exactly 3 carried a value — `tree-drift`, `curator`,
 * `corrector`, all machine writers that pass the field explicitly. Human- and agent-authored
 * tasks set it essentially never.
 *
 * Not because the information was missing. `X-Actor-ID` is REQUIRED on every prod write and
 * the derived actor was already being threaded into `createTask` as a separate `actor`
 * argument — it was sitting one parameter away from the column and was being DROPPED.
 *
 * The consequence is the question the operator actually asked: "where do new tasks come from?" could
 * not be answered from the field designed for it. The 77%-process-generated finding had to be
 * reconstructed entirely from TAGS (`found-during:` / `batch:` / `from:reviewer`), which is a
 * convention anyone can forget rather than a field.
 *
 * ═══ AND THE COLLISION ═══
 * The values that WERE populated carried two spellings of one actor: `coordinator` (24 rows) and
 * `the coordinator` (7). `GROUP BY created_by` reported one agent as two; `WHERE created_by='coordinator'`
 * silently dropped 7 rows. Same class as `needs-operator`/`needs:operator` and as commit 55411b9 —
 * a vocabulary collision needs the spellings COLLAPSED at the write boundary, not merely
 * documented.
 *
 * ═══ THE RULE ═══
 *   1. AN EXPLICIT `createdBy` ALWAYS WINS. A machine writer that says it is `tree-drift` is
 *      making a true statement the transport cannot make for it, and this must not overwrite
 *      it with the actor of whoever's process happened to run the write.
 *   2. OTHERWISE, THE DERIVED ACTOR. Already resolved at the request edge through the
 *      actorRegistry choke point, so this invents no second derivation (the same discipline
 *      config/assigneeStamp.ts follows — each surface passes the actor it already has).
 *   3. NORMALIZED, ALWAYS, THROUGH `normalizeActor`. Both branches, not just branch 2 — a
 *      caller typing `createdBy: 'the coordinator'` introduces the collision exactly as readily as a
 *      header does, and normalizing only the path that was REPORTED would fix one half and
 *      leave the other open (CLASSES.md C5).
 *   4. NOTHING RESOLVABLE ⇒ NOTHING WRITTEN. Not `unknown`, not `system`, and specifically
 *      not `anonymous` — see TASK_AUTHOR_STAMP_ALLOWS_ANONYMOUS in config/taskLifecycleConfig.ts
 *      for why the flagged fallback that is right for a SESSION is wrong for an AUTHOR. A
 *      blank is visibly missing; a plausible-looking default is silently believed, and a
 *      100%-populated column is the one nobody re-checks.
 *
 * ═══ WHY IT IS A FUNCTION AND NOT THREE LINES IN THE HANDLER ═══
 * Because the rule has to be identical on every path that can create a task, and "identical
 * by discipline across N call sites" is the thing this codebase has repeatedly measured
 * itself failing at (the completed_at twin sites, the assignee twin sites). One function, one
 * rule, and the tests attack the function directly rather than through four routes.
 */

import { normalizeActor, ACTOR_ANONYMOUS } from '../config/actorRegistry.js';
import { TASK_AUTHOR_STAMP_ALLOWS_ANONYMOUS } from '../config/taskLifecycleConfig.js';

/**
 * The value to store in `tasks.created_by`, or `undefined` for "write nothing".
 *
 * `undefined` rather than `null` deliberately: the INSERT binds it as SQL NULL either way,
 * but the type says "no author was resolvable", which is the fact, and it keeps this
 * function's contract readable next to the absent-when-absent rule the read path uses.
 *
 * @param explicit the caller's own `createdBy` argument, if any. Wins when present.
 * @param actor    the actor derived at the request edge, already through actorRegistry.
 */
export function resolveTaskAuthor(
  explicit?: string | null,
  actor?: string | null,
): string | undefined {
  // Rule 1 + Rule 3: explicit wins, and is normalized on the way through. `normalizeActor`
  // returns null for blank/whitespace-only input, so an empty string does NOT beat the
  // actor — an explicit blank is not an assertion of authorship.
  const fromExplicit = normalizeActor(explicit);
  const chosen = fromExplicit ?? normalizeActor(actor);

  // Rule 4. Two ways to have no author, and both land here: nothing was supplied at all, or
  // what was supplied normalizes to nothing. The `anonymous` check is separate and explicit
  // because that value is not blank — it is a real, deliberate token from the session layer
  // that would sail straight through a blankness test and land in the column looking like a
  // prolific author. This is the ABSENT direction the mutation probes are aimed at.
  if (!chosen) return undefined;
  if (!TASK_AUTHOR_STAMP_ALLOWS_ANONYMOUS && chosen === ACTOR_ANONYMOUS) return undefined;
  return chosen;
}
