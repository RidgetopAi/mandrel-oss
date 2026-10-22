/**
 * Parses a freeform "one per line or comma-separated" textbox (the form's `touches` and
 * `dependencies` fields) into a clean, order-preserving list of non-empty strings.
 */
export function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
