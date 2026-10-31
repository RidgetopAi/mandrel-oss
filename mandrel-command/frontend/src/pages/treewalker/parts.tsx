/**
 * Small shared TreeWalker building blocks — pure + unit-friendly, no data access. The id8
 * short-id and the title truncation.
 */
/** The short 8-char id used everywhere ids are surfaced. */
export function id8(id: string | undefined | null): string {
  return id ? id.replace(/-/g, '').slice(0, 8) : '';
}

/**
 * Truncate a string to `maxChars`, appending an ellipsis when it was cut. Used for an
 * unnamed drawer's spine title (BranchRail, P2 an earlier decision / an earlier task) — a
 * named branch's own name is shown in full and never runs through this.
 */
export function truncateTitle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}
