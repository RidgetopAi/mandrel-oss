/**
 * Record title derivation for mandrel-command — shared by the TreeWalker thread service,
 * the tier resolvers and LinkService.
 *
 * ⚠️ THIS FILE IS A MIRROR. The ONE declaration of the record-headline rule — the budget,
 * the measurements behind it, the ellipsis, and the content-aware algorithm — lives in
 * `mcp-server/src/config/recordHeadlineConfig.ts`. READ THAT FILE for the why; this one
 * carries no independent opinion.
 *
 * WHY A MIRROR AND NOT AN IMPORT: two separate services. This backend is CommonJS with
 * `rootDir: ./src`, and its runtime image does not contain `mcp-server/` at all, so the
 * module is not reachable at build time or at run time. Same constraint, same remedy, as
 * `config/actorRegistry.ts`: mirror the declaration and PIN IT WITH A GUARD.
 *
 * THE GUARD: `__tests__/recordHeadlineDrift.test.ts` reads the mcp-server config off disk
 * and asserts (a) every tunable here equals the one over there and (b) the body of
 * `deriveRecordHeadline` is byte-identical after whitespace normalisation. A number changed
 * on one side and not the other is RED; an algorithm changed on one side and not the other
 * is RED. The guard throws rather than passing vacuously if the source file moves.
 *
 * WHAT THIS REPLACED: a bare `CONTEXT_TITLE_PREVIEW_CHARS = 140`, declared here AND a second
 * time in `services/links.ts`, applied as a flat mid-word `slice`. Two of the five spellings
 * of one decision that earlier task collapsed.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** MIRRORED — see mcp-server/src/config/recordHeadlineConfig.ts for the measurements. */
const HEADLINE_MAX_CHARS_DEFAULT = 180;

/** MIRRORED — the floor below which a headline stops being a headline. */
const HEADLINE_MIN_CHARS = 40;

const maxChars = envInt('MANDREL_RECORD_HEADLINE_MAX_CHARS', HEADLINE_MAX_CHARS_DEFAULT);

if (maxChars < HEADLINE_MIN_CHARS) {
  throw new Error(
    `MANDREL_RECORD_HEADLINE_MAX_CHARS=${maxChars} is below the floor ${HEADLINE_MIN_CHARS}. ` +
      'See mcp-server/src/config/recordHeadlineConfig.ts for the measurements behind the default.',
  );
}

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
 * The placeholder every mandrel-command surface has always shown for a context whose body
 * has no non-empty line. Kept as a mandrel-command-only concern: `deriveRecordHeadline`
 * returns `null` for that case on purpose (absence is its own value), and only the UI layer
 * has an opinion about what to draw instead.
 */
export const EMPTY_CONTEXT_TITLE = '(context)';

/**
 * BACK-COMPAT ALIAS. Callers (`treewalker.ts`, `treewalkerTiers.ts`) still ask for "the
 * clip length"; there is now one, and it is the shared budget. Exported so nothing has to
 * re-declare a number to answer that question.
 */
export const CONTEXT_TITLE_PREVIEW_CHARS = RECORD_HEADLINE_CONFIG.maxChars;

/** A context's display title: the shared headline, or the neutral placeholder. */
export function contextTitle(content: string | null | undefined): string {
  return deriveRecordHeadline(content) ?? EMPTY_CONTEXT_TITLE;
}
