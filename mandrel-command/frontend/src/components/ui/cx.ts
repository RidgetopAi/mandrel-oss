/**
 * cx — the one tiny class-name joiner for the primitive library (P0.3).
 *
 * WHY a local helper (not `clsx`/`classnames`): the primitives must add ZERO new
 * runtime styling deps (CSS-Modules-only, zero-runtime pattern). This filters out
 * falsy parts so conditional variant classes compose cleanly — and, importantly,
 * drops the `undefined` that CSS-Module class lookups become under the vitest
 * `css:false` config, so class strings never contain the literal "undefined".
 */
export type ClassValue = string | false | null | undefined;

export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ');
}
