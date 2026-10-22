/**
 * The Sessions free-text filter — client-side, over the loaded page.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────
 * A row matches when EVERY term in the query is a WORD-PREFIX of some word in some
 * searched field. Terms and field text are split on the same non-alphanumeric
 * boundary, so both sides tokenize identically.
 *
 * What that matches:
 *   "sess"        → a session titled "Session rebuild"        (prefix of a word)
 *   "builder"     → actor "builder"                            (actor is searched)
 *   "live-01"     → display_id "live-01"                       (both terms, same field)
 *   "daisy coordinator" → terms may land in DIFFERENT fields          (AND across the row)
 *
 * What it deliberately does NOT match:
 *   "ui"   → "building" / "guide" / "require"  — a term must start a word, not sit
 *            inside one. This is the reported symptom: a two-letter query returned an
 *            unrelated session because the old filter was a bare substring test.
 *   a run that spans two fields — the old haystack was `${title} ${description}
 *            ${project_name}` joined into ONE string, so "daisy coordinator" could match the
 *            tail of one field plus the head of the next. Fields are matched separately
 *            here, so no match ever crosses a field boundary.
 *   a run that spans a word boundary inside one field — "sessionrebuild" does not match
 *            "session rebuild".
 *
 * It stays CLIENT-SIDE by decision: no request carries the term, so this refines the
 * already-loaded page and nothing here can hide a row the server did not send.
 */
import type { SessionListRow } from './hooks';

/** Word boundary for both the query and the field text (unicode letters + digits). */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function words(value: string): string[] {
  return value.toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/**
 * The searched fields of one row, as separate strings — never concatenated, so a term
 * can never match across the seam between two of them. Nullish/empty values drop out.
 */
export function searchFields(row: SessionListRow): string[] {
  const scalars = [
    row.title,
    row.description,
    row.project_name,
    row.actor,
    row.session_goal,
    row.display_id,
  ];
  const fields: string[] = [];
  for (const v of scalars) if (typeof v === 'string' && v.length > 0) fields.push(v);
  for (const tag of row.tags ?? []) if (typeof tag === 'string' && tag.length > 0) fields.push(tag);
  return fields;
}

/** Split a raw query box value into its search terms. Blank query → no terms. */
export function searchTerms(q: string): string[] {
  return words(q ?? '');
}

export function matchesSearch(row: SessionListRow, q: string): boolean {
  const terms = searchTerms(q);
  if (terms.length === 0) return true;
  const fieldWords = searchFields(row).map(words);
  return terms.every((term) =>
    fieldWords.some((ws) => ws.some((w) => w.startsWith(term))),
  );
}
