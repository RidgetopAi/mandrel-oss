/**
 * RECORD HEADLINE — the ONE definition of "a record rendered as a single line"
 *.
 *
 * THE DEFECT THIS FILE EXISTS TO CLOSE. A context has no title column, so every surface
 * that must show one line per record derives it from the body. Before this file there were
 * FIVE independent spellings of that derivation — `left(x.content, 60)` inside the lexical
 * SQL, `content.substring(0, 60)` in smart_search, an 80-char slice in recall_thread, a
 * 60-char slice in the branch-membership headline, and a 140-char `CONTEXT_TITLE_PREVIEW_CHARS`
 * duplicated across two mandrel-command services. Five numbers, none of them derived from
 * anything, and one of them living in SQL where nothing could compare it to the others.
 *
 * It mattered because our records LEAD WITH THEIR TYPE AND THEIR IDENTIFIERS and put the
 * substance after. A 60-char cut lands exactly where the substance starts, so the reader
 * gets the half that says WHICH record and loses the half that says WHAT HAPPENED:
 *
 *   ERROR: DEFECT CLASS: "authenticated" is not "authorized to change ident...
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * HOW `maxChars` WAS CHOSEN — MEASURED, not picked.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Instrument: prod `mandrel` DB, 2026-08-27, 10,999 live contexts (`archived_at IS NULL`).
 * For each record we took the HEADLINE UNIT — the rendered `TYPE: ` prefix plus the leading
 * text of the first content line up to its first sentence terminator — and asked what
 * fraction of records keep that whole unit under a given budget:
 *
 *     budget   60     80     120    140    160    180    200    240
 *     kept    36.1%  68.9%  89.9%  92.5%  94.2%  95.3%  96.1%  97.7%
 *
 * The two 60s were losing the first sentence of TWO RECORDS IN THREE. The curve's knee is
 * at ~160-180: each further 20 characters past 180 buys under one point. 180 also clears
 * the sibling measurement on an earlier task (real dead-end headlines run ~141 chars median)
 * with ~39 characters of margin, so a MEDIAN headline of the class this was reported
 * against now survives whole rather than being cut at its midpoint.
 *
 * Per context_type at 180 (same query, grouped): completion 96.7% · handoff 99.3% ·
 * error 98.2% · milestone 99.1% · reflections 97.5% · lessons 99.2% · code 100% ·
 * planning 89.6% · discussion 85.2%. The two laggards are long unpunctuated prose dumps,
 * which no flat budget fixes and which the word-boundary rule below at least keeps readable.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE CLIP IS CONTENT-AWARE AND NOT A FLAT `slice`.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * A flat slice cuts mid-word ~85% of the time and mid-sentence always. Two cheap rules
 * recover most of the loss: prefer to end on a SENTENCE terminator if one falls inside the
 * budget (the reader gets a complete thought), otherwise end on a WORD boundary. Both are
 * strictly inside the same budget, so this costs nothing in tokens.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO SQL COPY ANY MORE.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * The old lexical-search title was built in SQL, which made it the copy most likely to
 * drift silently — nothing in the TypeScript world could even read it. Rather than render
 * this algorithm into a second dialect and then guard the two against each other, the SQL
 * arm now emits NO title for contexts and `services/lexicalSearch.ts` derives it here, from
 * the `summary` column it was already selecting (`x.content`). Deleting a copy beats
 * reconciling one; there is no cross-dialect regex to keep honest and no extra bytes on the
 * wire.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE OTHER PACKAGE.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * `mandrel-command/backend` is a separate CommonJS service whose runtime image does not
 * contain `mcp-server/`, so it cannot import this module. It carries a MIRROR
 * (`services/recordTitle.ts`) pinned to this file by `recordHeadlineDrift.test.ts`, which
 * reads THIS file off disk — the same technique `actorRegistryDrift.test.ts` uses for the
 * actor taxonomy. One declaration, one guard, no second opinion.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * THE BUDGET, in characters, for a rendered one-line headline INCLUDING any type prefix
 * and including the ellipsis. See the measurement block above for how 180 was chosen.
 * env: MANDREL_RECORD_HEADLINE_MAX_CHARS
 */
const HEADLINE_MAX_CHARS_DEFAULT = 180;

/**
 * The floor below which a headline stops being a headline. Two jobs. (1) A caller passing a
 * prefix longer than the budget must not get a negative slice length — the budget clamps
 * here instead. (2) It bounds the env knob: a misconfigured `…MAX_CHARS=5` would silently
 * turn every search result into a stub, which reads as a data problem, not a config one.
 */
const HEADLINE_MIN_CHARS = 40;

const maxChars = envInt('MANDREL_RECORD_HEADLINE_MAX_CHARS', HEADLINE_MAX_CHARS_DEFAULT);

// GUARD THE GUARD (C3 / a past incident — a config knob is an attack surface on its own feature).
// Fail CLOSED at module load rather than at some future unreadable search result.
if (maxChars < HEADLINE_MIN_CHARS) {
  throw new Error(
    `MANDREL_RECORD_HEADLINE_MAX_CHARS=${maxChars} is below the floor ${HEADLINE_MIN_CHARS}. ` +
      'Below it a headline can no longer carry the "what happened" half it exists to carry. ' +
      'See config/recordHeadlineConfig.ts for the measurements behind the default.',
  );
}

/**
 * How much of a candidate line we normalise before clipping. Any comfortable multiple of the
 * budget works; the only requirement is that it exceed `maxChars` by enough that collapsing
 * runs of whitespace inside this window can never shorten a line to below the budget.
 */
const SCAN_WINDOW_CHARS = maxChars * 8;

export const RECORD_HEADLINE_CONFIG = {
  /** See HEADLINE_MAX_CHARS_DEFAULT. Whole rendered line, prefix and ellipsis included. */
  maxChars,

  /** The floor the budget is clamped to, exported so the guards assert the same number. */
  minChars: HEADLINE_MIN_CHARS,

  /**
   * ONE ellipsis for every surface. The four pre-existing sites disagreed even here — two
   * wrote `'...'` (three characters) and two wrote `'…'` (one). The single character is
   * cheaper and is what the recall surfaces already used.
   */
  ellipsis: '…',

  /**
   * Characters that end a sentence. If one of these is followed by whitespace (or ends the
   * text) inside the budget, we cut there and the reader gets a complete thought.
   */
  sentenceTerminators: '.!?',

  /**
   * A sentence-boundary cut is only preferred when it keeps at least this fraction of the
   * budget. Without it, a headline that opens with an abbreviation ("v1.2 …", "e.g. …")
   * would be cut to four characters and call that a complete thought — which is the same
   * class of defect as the 60-char clip, arrived at from the other direction.
   */
  sentenceMinFraction: 0.5,

  /**
   * A word-boundary cut is only preferred when it keeps at least this fraction of the
   * budget. A single 200-character token (a URL, a base64 blob) has no interior boundary,
   * and backing off to character zero would be worse than a hard cut.
   */
  wordMinFraction: 0.6,

  /** Separator between a record's type prefix and its body, e.g. `ERROR: …`. */
  typePrefixSeparator: ': ',
} as const;

/**
 * THE ONE ALGORITHM. Every surface in this package calls this and nothing else.
 *
 * `prefix` is charged against the same budget, because the budget is a property of the LINE
 * the reader sees, not of the substring some particular call site happens to hold. A
 * surface that renders `ERROR: ` pays for those seven characters; one that renders nothing
 * gets them back as body.
 *
 * Returns `null` for content with no non-empty line — an ABSENT headline, which is a
 * different fact from an empty string and is what every caller's `| null` type already
 * meant. (C1: absence gets its own value, never folded into a "no".)
 *
 * INVARIANT, asserted in `src/tests/recordHeadline.contract.test.ts`: the returned string is
 * never longer than `RECORD_HEADLINE_CONFIG.maxChars`, given a prefix short enough to leave
 * a real headline behind it (`prefix.length + minChars <= maxChars`). Every context type we
 * have is far inside that; a longer prefix degrades to `minChars` of body rather than to a
 * negative slice, which is the safe direction
 */
export function deriveRecordHeadline(
  content: string | null | undefined,
  prefix = '',
): string | null {
  // Only the first `SCAN_WINDOW_CHARS` of any candidate line are normalised. `contexts.content`
  // is a TEXT column whose validator ceiling is in the millions of characters, and a
  // whitespace-collapsing regex over a multi-megabyte body — once per row, per search — is
  // work whose result we throw away past the budget by construction.
  const firstLine = (content ?? '')
    .split('\n')
    .map((s) => s.slice(0, SCAN_WINDOW_CHARS).replace(/\s+/g, ' ').trim())
    .find((s) => s.length > 0);
  if (!firstLine) return null;

  const { maxChars: max, minChars, ellipsis, sentenceTerminators } = RECORD_HEADLINE_CONFIG;

  // The prefix is charged against the line budget, clamped so an absurd prefix cannot
  // produce a negative or sub-headline body budget.
  const bodyBudget = Math.max(minChars, max - prefix.length);
  if (firstLine.length <= bodyBudget) return prefix + firstLine;

  // We ARE truncating, so the ellipsis has to fit inside the budget too.
  const cutBudget = Math.max(1, bodyBudget - ellipsis.length);

  // Prefer a complete sentence. Scan the widest window we may keep and take the LAST
  // terminator in it, which maximises surviving content.
  const window = firstLine.slice(0, cutBudget + 1);
  let cut = -1;
  for (let i = 0; i < window.length - 1; i++) {
    if (sentenceTerminators.includes(window[i]) && /\s/.test(window[i + 1])) cut = i + 1;
  }
  if (cut >= Math.floor(cutBudget * RECORD_HEADLINE_CONFIG.sentenceMinFraction)) {
    return prefix + window.slice(0, cut).trimEnd() + ellipsis;
  }

  // Otherwise fall back to the last word boundary inside the budget.
  const space = window.lastIndexOf(' ');
  if (space >= Math.floor(cutBudget * RECORD_HEADLINE_CONFIG.wordMinFraction)) {
    return prefix + window.slice(0, space).trimEnd() + ellipsis;
  }

  // One unbroken token wider than the budget. A hard cut is the honest answer.
  return prefix + firstLine.slice(0, cutBudget) + ellipsis;
}

/**
 * The type-prefixed form the search surfaces render (`ERROR: …`, `COMPLETION: …`).
 * Kept here rather than at each call site so the prefix, the separator and the budget
 * accounting are all one decision.
 */
export function deriveTypedRecordHeadline(
  contextType: string | null | undefined,
  content: string | null | undefined,
): string | null {
  const t = (contextType ?? '').trim();
  const prefix = t ? t.toUpperCase() + RECORD_HEADLINE_CONFIG.typePrefixSeparator : '';
  return deriveRecordHeadline(content, prefix);
}
