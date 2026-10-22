/**
 * NAMED-ID FREE-TEXT SCAN — the ONE definition of "what an id looks like in prose".
 *
 * WHY THIS FILE EXISTS. Two features now read ids out of free text:
 *   1. the trunk-demotion rule (services/positionalMint.ts) — how many tasks does this
 *      record NAME? — which decides membership vs trunk material;
 *   2. the handoff staleness stamp (services/handoffStamp.ts) — which task ids in a frozen
 *      handoff still describe live work? — which annotates the render.
 * A second scanner that disagreed about what an id looks like would make those two features
 * disagree about the same sentence: a record could be demoted for naming two tasks while the
 * stamper stamped one of them, and nothing in either output would say why. That is the
 * no-second-catalog failure (C5 / a past incident), so the regexes and the tokenizer live here and
 * both consumers import them.
 *
 * SCOPE, STATED IN THE GUARD'S OWN FILE (C3): this module decides SHAPE ONLY — which
 * substrings could be an id. It does NO resolution, no project scoping, no ambiguity
 * handling, and it knows nothing about tasks. Those are the consumer's, because they differ:
 * positionalMint resolves for MINTING (resolveMintEndpoint, existence- and project-checked)
 * and the stamper resolves for DISPLAY. Shape is the part that must not drift; policy is the
 * part that legitimately differs.
 */

/**
 * Full canonical UUID, word-bounded.
 *
 * NEW RegExp PER CALL, not a shared module-level literal with /g. A /g regex carries
 * `lastIndex` mutable state across calls, so a single shared instance used by two consumers
 * (or by one consumer twice) silently skips matches depending on where the previous scan
 * stopped. Exposing these as FACTORIES makes that state unshareable by construction rather
 * than by everyone remembering to reset it.
 */
export const namedIdUuidRe = (): RegExp =>
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Bare 8-hex short id, word-bounded. `(?!-)` keeps the leading 8 of a FULL uuid from also
 * matching as an id8 (it is followed by '-'); the \b pair keeps an 8-hex WINDOW inside a
 * longer hex run (e.g. a 40-hex commit SHA) from matching — a longer run has no internal
 * word boundary, so only exactly-8-hex words qualify.
 */
export const namedIdShortRe = (): RegExp => /\b[0-9a-f]{8}\b(?!-)/gi;

/**
 * BOTH SHAPES, ONE PASS — and the ONE regex both consumers actually run.
 *
 * The alternation is UUID-FIRST so a full uuid is consumed whole rather than being split by
 * the id8 branch. (The id8 branch's `(?!-)` already refuses a uuid's leading octet, so the
 * order is belt-and-braces, not the load-bearing part.)
 *
 * WHY A COMBINED PASS RATHER THAN TWO. The stamper does not merely need the SET of tokens,
 * it needs to rewrite each occurrence IN PLACE — and a rewrite driven by a different pattern
 * than the scan is exactly how a token gets stamped that was never counted, or vice versa.
 * One regex, used by `scanNamedIdTokens` and by the rewrite, makes that class unreachable.
 */
export const namedIdCombinedRe = (): RegExp =>
  new RegExp(`${namedIdUuidRe().source}|${namedIdShortRe().source}`, 'gi');

/**
 * Every distinct id-SHAPED token in `text`, lower-cased.
 *
 * Distinct by value: a handoff that names the same task on three lines yields one candidate,
 * because the consumers resolve per candidate and a repeat costs a query without adding an
 * answer.
 */
export function scanNamedIdTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').match(namedIdCombinedRe()) ?? []) out.add(m.toLowerCase());
  return [...out];
}

/**
 * Upper bound on distinct candidate tokens RESOLVED per scan. Scanned text is untrusted
 * input; without a bound a pathologically hex-dense record would turn one write — or one
 * briefing render — into hundreds of resolver queries. 50 distinct candidates is far above
 * any observed real record (the multi-name records that motivated the trunk rule name a
 * handful of tasks; the handoffs that motivated the staleness stamp name under a dozen).
 *
 * IT LIVES HERE, WITH THE SHAPES, so both consumers inherit the same ceiling. A stamper that
 * bounded at 200 while the mint path bounded at 50 would stamp ids the graph never linked.
 */
export const MAX_NAMED_ID_CANDIDATES = 50;
