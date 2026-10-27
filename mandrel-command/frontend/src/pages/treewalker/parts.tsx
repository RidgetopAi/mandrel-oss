/**
 * Small shared TreeWalker building blocks — pure + unit-friendly, no data access. The id8
 * short-id, the trust-count roll-up for the trust bar, and the spine-tier CSS-class map.
 */
import type { StoryStep, ThreadNode, TrustLevel } from '../../api/domains/treewalker';
import { TRUST_ORDER } from './config';

/** The short 8-char id used everywhere ids are surfaced. */
export function id8(id: string | undefined | null): string {
  return id ? id.replace(/-/g, '').slice(0, 8) : '';
}

/** A trust level → the count roll-up entry rendered in the trust bar / trust key. */
export interface TrustCount {
  trust: TrustLevel;
  count: number;
}

/**
 * Roll a thread's records up into per-trust counts, in the FIXED trust order, dropping any
 * level with a zero count (the trust bar only shows segments that exist). Reads the nodes
 * (the whole graph) so it matches the canvas, not just the story window.
 */
export function trustCounts(nodes: ThreadNode[] | undefined): TrustCount[] {
  const tally = new Map<TrustLevel, number>();
  for (const n of nodes ?? []) {
    tally.set(n.trust, (tally.get(n.trust) ?? 0) + 1);
  }
  return TRUST_ORDER.map((trust) => ({ trust, count: tally.get(trust) ?? 0 })).filter(
    (t) => t.count > 0,
  );
}

/** Total records carrying a trust read (the trust-bar denominator). */
export function trustTotal(counts: TrustCount[]): number {
  return counts.reduce((sum, c) => sum + c.count, 0);
}

/** A story step's spindle marker → the CSS-module class that paints its dot + relation term. */
export function stepMarkerClass(step: StoryStep): string {
  return step.marker;
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
