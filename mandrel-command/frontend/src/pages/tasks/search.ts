/**
 * The Tasks free-text filter — client-side, over the already-fetched page.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────
 * A row matches when EVERY term in the query is a WORD-PREFIX of some word in some
 * searched field. Terms and field text are split on the same non-alphanumeric
 * boundary, so both sides tokenize identically.
 *
 * ── WHY THIS REPLACED A BARE SUBSTRING TEST ──────────────────────
 * The previous predicate joined id + title + description + assigned_to + tags into ONE
 * string and asked `includes()`. That has two failure modes, and both were reported:
 *   (a) a term matched the MIDDLE of a word — a two-letter query returned rows whose
 *       only connection was a fragment buried inside an unrelated word;
 *   (b) a run could span the SEAM between two joined fields, so the tail of one field
 *       plus the head of the next matched a query that exists in neither field.
 * Fields are kept separate here and terms must start a word, which closes both.
 *
 * ── WHY THE ID STILL WORKS ───────────────────────────────────────────────────────
 * A Mandrel id8 (`2b3c4d5e`) is how every tool, link and handoff REFERS to a task, so
 * pasting one into the box has to find it — that is why `id` is a searched field at all.
 * It needs no special case under this rule: the word boundary splits a UUID on its
 * dashes, so each dashed segment is its own word. An id8 is a prefix of the first
 * segment, and a dashed partial (`709aca13-44db`) is two terms that are prefixes of the
 * first two. What it deliberately gives up is matching from the MIDDLE of a segment,
 * which is the same trade the rule makes everywhere else.
 *
 * Terms may land in DIFFERENT fields (the match is AND across the row, not a phrase),
 * so ordering and adjacency carry no meaning — only "every term starts some word".
 *
 * It stays CLIENT-SIDE: this refines the already-loaded page and nothing here can hide
 * a row the server did send.
 */
import type { Task } from '../../types/task';

/** Word boundary for both the query and the field text (unicode letters + digits). */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function words(value: string): string[] {
  return value.toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/**
 * The searched fields of one task, as separate strings — never concatenated, so a term
 * can never match across the seam between two of them. Nullish/empty values drop out.
 */
export function searchFields(task: Task): string[] {
  const scalars = [task.id, task.title, task.description, task.assigned_to];
  const fields: string[] = [];
  for (const v of scalars) if (typeof v === 'string' && v.length > 0) fields.push(v);
  for (const tag of task.tags ?? []) if (typeof tag === 'string' && tag.length > 0) fields.push(tag);
  return fields;
}

/** Split a raw query box value into its search terms. Blank query → no terms. */
export function searchTerms(q: string): string[] {
  return words(q ?? '');
}

export function matchesSearch(task: Task, q: string): boolean {
  const terms = searchTerms(q);
  if (terms.length === 0) return true;
  const fieldWords = searchFields(task).map(words);
  return terms.every((term) => fieldWords.some((ws) => ws.some((w) => w.startsWith(term))));
}
