/**
 * THE TASK EMBED TEXT — the single definition of what a `tasks` row means to the embedder.
 *
 * an earlier task (tranche B of the smart_search complete fix, parent 7b8a66f4).
 * Counterpart of buildContextEmbeddingText (handlers/context.ts) and
 * buildDecisionEmbeddingText (handlers/decisions.ts), and shaped deliberately like the
 * latter so all three tables present the same "labelled header lines, then free text" form
 * to one embedder.
 *
 * ONE DEFINITION, THREE CONSUMERS — this is the whole reason it is a module and not a
 * literal inside a handler. The WRITE path (handlers/tasks.ts createTask / updateTaskStatus),
 * the BACKFILL (services/reembedBackfill.ts) and the SELF-HEAL worker (which runs the
 * backfill engine) must produce byte-identical text for the same row, or a healed row lands
 * at a different point in vector space than a freshly-written one and recall silently depends
 * on which path last touched the record. Guard: taskEmbeddingText.unit.test.ts asserts the
 * write path and the backfill engine call THIS function.
 *
 * ── WHY `status` IS NOT IN HERE (deliberate; do not "fix" it) ────────────────────────────
 * Task status is a RANKING signal, not a semantic one, and the plan spends it in the unified
 * score's IMPORTANCE term. Carrying it here as well would DOUBLE-COUNT it: the same fact would
 * move the cosine term AND the importance term, and the two are summed — so a status change
 * would shift the score twice for one piece of information. That arithmetic is the whole
 * argument, and it is the one the build plan's amendment names.
 *
 * The compensating map is `taskImportance` / TASK_STATUS_IMPORTANCE_ENV in
 * config/searchMergeConfig.ts, consumed by the task source in
 * handlers/smartSearch.ts. Its defaults are all 1.0, so status moves nothing until tuned —
 * but the term that receives it now exists, which is what makes excluding it here a choice
 * rather than a hole.
 *
 * ── WHY IT MUST GO THROUGH boundEmbeddingText ───────────────────────────────────────────
 * services/embedding/validation.ts THROWS above EMBEDDING_MAX_TEXT_LENGTH (8000 chars) — it
 * does not truncate. The write path catches that throw and persists the row with a NULL
 * vector, so an over-long task would silently drop out of semantic recall entirely, forever
 * (the self-heal worker would re-attempt it and re-throw every sweep). Truncated-but-
 * searchable beats un-embedded-and-invisible. Two tasks on prod exceed the cap today.
 */

import { boundEmbeddingText } from '../../config/embeddingConfig.js';

export interface TaskEmbeddingTextParts {
  /** tasks.type — the task's own category ('general', 'feature', 'bugfix', …). */
  type?: string | null;
  /**
   * tasks.priority — low/medium/high/urgent.
   *
   * KEPT IN THE EMBED TEXT deliberately, and the reason is narrow: unlike status it is
   * double-counted in ZERO places today, so the arithmetic argument above does not reach it.
   * ⚠️ THAT IS A PROPERTY OF TODAY'S SCORER, NOT OF THE FIELD. Priority is the NATURAL
   * importance signal — if a later scoring pass adds a priority→weight map to the importance
   * term, priority becomes exactly the double-count that disqualified status, and by then the
   * vectors are already baked. Whoever adds that map owns removing this line and re-running
   * the backfill.
   */
  priority?: string | null;
  /**
   * tasks.tags — the linking-grammar tags, joined verbatim, exactly as contexts and decisions
   * embed theirs. They contribute topical vocabulary to the vector. NOTE they are NOT how a
   * `ref:`/`task:` HANDLE is resolved: handle lookup goes through the tag / `name:value` filter
   * path in the search config, not through this embedding.
   */
  tags?: string[] | null;
  /** tasks.title — the highest-signal field; a task's title is usually its whole meaning. */
  title?: string | null;
  /** tasks.description — free text, and the field that can blow the length cap. */
  description?: string | null;
}

/**
 * Build the embed text for a task row. Pure, total, and safe on empty/null everything:
 * a task with no title, no description, no tags and no type yields `''`.
 *
 * The EMPTY-STRING case is a real one and is handled by the CALLER, not here: the write path
 * skips the embedder entirely for empty text (an embedding of nothing is noise that would
 * still be a NOT-NULL vector, so it would look "embedded" to the backfill's NULL predicate
 * and never be revisited). See handlers/tasks.ts embedTaskInline().
 */
export function buildTaskEmbeddingText(parts: TaskEmbeddingTextParts): string {
  const text = [
    parts.type ? `Type: ${parts.type}` : '',
    parts.priority ? `Priority: ${parts.priority}` : '',
    parts.tags && parts.tags.length ? `Tags: ${parts.tags.join(', ')}` : '',
    parts.title || '',
    parts.description || '',
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('\n');

  return boundEmbeddingText(text);
}

/**
 * Adapter from a raw `tasks` DB row (snake_case, as SELECTed/RETURNed) to the embed text.
 * Exists so the write path and the backfill engine cannot drift on WHICH COLUMNS feed the
 * embedding — the field mapping is written once, here.
 */
export function buildTaskEmbeddingTextFromRow(row: {
  type?: string | null;
  priority?: string | null;
  tags?: string[] | null;
  title?: string | null;
  description?: string | null;
}): string {
  return buildTaskEmbeddingText({
    type: row.type,
    priority: row.priority,
    tags: row.tags,
    title: row.title,
    description: row.description,
  });
}
