/**
 * Small shared project-detail helpers: relative-time + id8 (re-exported from the projects
 * module so both screens format identically), plus a compact number formatter and a
 * signed-churn formatter. Pure + unit-friendly; no data access here.
 */
export { formatRelative, id8 } from '../projects/parts';

/** Localised integer, or an em-dash when the value is missing (honest "not counted"). */
export function fmtCount(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString();
}

/** A signed churn string like "+1,204 / -318" from git insertions/deletions. */
export function fmtChurn(insertions?: number, deletions?: number): string {
  const ins = insertions ?? 0;
  const del = deletions ?? 0;
  return `+${ins.toLocaleString()} / -${del.toLocaleString()}`;
}

/**
 * A single-line, whitespace-collapsed preview of a commit message (first line only), so
 * a multi-paragraph body never blows out the row.
 */
export function commitSubject(message?: string | null): string {
  if (!message) return '';
  const firstLine = message.split('\n', 1)[0] ?? '';
  return firstLine.trim();
}
