/**
 * THE EMPTY STATE (SEARCH P2b — BUILDS 3 and 4).
 *
 * ═══ WHAT THIS EXISTS TO FIX ═══
 * A vector search cannot return nothing, because something is always nearest. P1 measured
 * what that costs (reports/artifacts/7a02f00d-p1-question-set/RESULTS-P1.md): 17 of 17
 * known-negatives — questions about Kubernetes, SAML, PagerDuty, and pure gibberish, none of
 * which this corpus has ever contained — came back with confident-looking rows. And a
 * similarity FLOOR cannot fix it: 14 of the 16 correct answers on the control set score
 * BELOW the worst false positive, so any threshold that silences the negatives destroys the
 * real answers. There is no value that constant could take.
 *
 * The lexical layer has an empty state that is STRUCTURAL rather than thresholded: a term
 * either occurs in the corpus or it does not. This module turns that fact into the two
 * things search owes its caller.
 *
 * ═══ BUILD 3 — ALWAYS SAY WHAT YOU COULD NOT MATCH ═══
 * Every response reports the query terms that occur in ZERO records of this project. It has
 * no recall cost — it removes no row — and it is what makes the rest trustworthy: when rows
 * come back the caller learns which of their words we had no record of, and when nothing
 * comes back they learn why.
 *
 * ═══ BUILD 4 — VETO ON A WORD LIST, NOT A THRESHOLD ═══
 * Return EMPTY when an absent term is NOT an ordinary English word. MEASURED on the P1 sets
 * during the design spike:
 *     absent ALONE                       16/17 negatives caught, 6/33 real answers LOST
 *     absent AND not-an-English-word     12/17 negatives caught, 1/33 real answers lost
 * The difference is what the two populations MEAN. Kubernetes / Terraform / PagerDuty /
 * gibberish are NAMES OF THINGS WE DO NOT HAVE. encyclopedia / unsound / anybody are
 * ordinary English the asker chose instead of our words — that is a paraphrase, not an
 * unanswerable question, and the semantic channel exists for exactly it.
 *
 * ⚠️ THE ENGLISHNESS QUESTION IS ASKED OF THE SURFACE FORM, NEVER THE LEXEME. English stems
 * are mostly not English words ('database' → 'databas', 'favourite' → 'favourit', 'anybody'
 * → 'anybodi'; none are in the vendored list). Vetoing on the lexeme would empty a search for
 * the commonest word in this corpus. services/absentTerms.ts carries the surface forms for
 * this reason; see the comment on QueryTerm.surfaces.
 */

import { isEnglishWord } from './englishWords.js';
import type { AbsentTermsResult, QueryTerm } from './absentTerms.js';
import { HYBRID_SEARCH_CONFIG } from '../config/hybridSearchConfig.js';

/** One absent term, as a caller sees it. */
export interface AbsentTermReport {
  /** The word the CALLER typed (surface form), not the stemmed lexeme. */
  readonly term: string;
  readonly kind: QueryTerm['kind'];
  /** False when this term is not an ordinary English word — i.e. it can veto. */
  readonly english: boolean;
  /** The corpus word this term is a near-miss spelling of, when it is one (never vetoes). */
  readonly nearMissOf?: string;
}

export interface EmptyStateVerdict {
  /** Every absent term, English or not. Reported on EVERY response (BUILD 3). */
  readonly absentTerms: readonly AbsentTermReport[];
  /**
   * The terms that produced an empty result, or empty if nothing was vetoed. An empty
   * result MUST be distinguishable from a broken one, which means naming the WORD.
   */
  readonly vetoedBy: readonly string[];
  /** Did the veto fire? Always false when HYBRID_SEARCH_CONFIG.absentTermVeto is off. */
  readonly veto: boolean;
  /**
   * How many of the query's content terms occur in the corpus (terms minus absent). The
   * multi-word tolerance reads this; carried on the verdict so reconcile can re-decide.
   */
  readonly matchedTermCount: number;
}

/** digits + st/nd/rd/th: "7th", "22nd". */
const ORDINAL = /^\d+(st|nd|rd|th)$/i;
export const isOrdinal = (term: string): boolean => ORDINAL.test(term.trim());

/**
 * Optimal-string-alignment (Damerau-Levenshtein) distance, early-exiting once it exceeds
 * `max`. Transposition counts as ONE edit, because "buisiness" for "business" is the typo
 * people actually make. Returns max+1 when the distance exceeds max.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2.length = 0;
    prev2.push(...prev);
    prev = cur;
  }
  return prev[b.length];
}

/** Split text into lowercase alphabetic words, for the near-miss vocabulary. */
export function vocabularyOf(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) out.add(w);
  }
  return out;
}

/** The vocabulary word `term` is a near-miss of, or undefined. Identifiers never near-miss. */
function findNearMiss(term: string, vocabulary: ReadonlySet<string>): string | undefined {
  const t = term.toLowerCase();
  const C = HYBRID_SEARCH_CONFIG;
  if (t.length < C.absentTermNearMissMinLength || !/^[a-z]+$/.test(t)) return undefined;
  const max = t.length >= C.absentTermNearMissLongLength
    ? C.absentTermNearMissLongDistance
    : C.absentTermNearMissShortDistance;
  let best: string | undefined;
  let bestD = max + 1;
  for (const w of vocabulary) {
    if (w === t) continue;
    const d = editDistance(t, w, max);
    if (d < bestD || (d === bestD && best !== undefined && w < best)) { best = w; bestD = d; }
  }
  return bestD <= max ? best : undefined;
}

/** Alphanumeric parts of a term: "SIAC_GEE" → ["siac", "gee"]. */
const partsOf = (t: string): string[] => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Which absent terms veto, after the ordinary-word, near-miss and multi-word exemptions. */
function vetoersOf(absentTerms: readonly AbsentTermReport[], matchedTermCount: number): string[] {
  const C = HYBRID_SEARCH_CONFIG;
  const vetoers = absentTerms.filter((a) => !a.english && a.nearMissOf === undefined
    && !(C.absentTermOrdinalsOrdinary && isOrdinal(a.term)));
  // One unfamiliar token is ONE unfamiliar token: the prose parts of an absent identifier
  // ("SIAC" of SIAC_GEE) are the same word counted again, not a further absent subject.
  const identifierParts = new Set(
    vetoers.filter((a) => a.kind === 'identifier').flatMap((a) => partsOf(a.term)),
  );
  const subjects = vetoers.filter((a) =>
    a.kind === 'identifier' || !partsOf(a.term).every((p) => identifierParts.has(p)));
  if (subjects.length > 0
      && subjects.length <= C.absentTermToleratedAbsent
      && matchedTermCount >= C.absentTermToleratedMinMatched) {
    return [];
  }
  return vetoers.map((a) => a.term);
}

/**
 * Pick the surface form to SHOW for an absent lexeme.
 *
 * A lexeme can come from several surfaces in one query ('database' and 'databases'). The
 * shortest is chosen because it is the closest thing to the dictionary form, and ties break
 * alphabetically so the same query always names the same word — a message that varies run to
 * run is a message no test can assert on and no reader can trust.
 */
function displaySurface(t: QueryTerm): string {
  const s = [...t.surfaces].filter((x) => x && x.trim() !== '');
  if (s.length === 0) return t.lexeme;
  s.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return s[0];
}

/**
 * Turn the raw absent-term probe into the response's empty-state verdict.
 *
 * A term counts as English if ANY of its surface forms is — one lexeme, several spellings,
 * and we should not veto on a query the caller half-spelled in a form the list happens to
 * lack when another form of the same word is right there.
 */
export function decideEmptyState(
  probe: AbsentTermsResult,
  vocabulary: ReadonlySet<string> = new Set(),
): EmptyStateVerdict {
  const absentTerms: AbsentTermReport[] = probe.absent.map((t) => {
    const term = displaySurface(t);
    const english = t.surfaces.some((s) => isEnglishWord(s));
    const nearMissOf = english || t.kind !== 'prose' ? undefined : findNearMiss(term, vocabulary);
    return nearMissOf === undefined
      ? { term, kind: t.kind, english }
      : { term, kind: t.kind, english, nearMissOf };
  });
  const matchedTermCount = Math.max(0, probe.terms.length - probe.absent.length);

  if (!HYBRID_SEARCH_CONFIG.absentTermVeto) {
    return { absentTerms, vetoedBy: [], veto: false, matchedTermCount };
  }
  const vetoedBy = vetoersOf(absentTerms, matchedTermCount);
  return { absentTerms, vetoedBy, veto: vetoedBy.length > 0, matchedTermCount };
}

/**
 * ⚠️ A TERM THAT NAMES A RECORD IS NOT ABSENT, even when it appears in nobody's TEXT.
 *
 * THE DEFECT THIS EXISTS TO FIX, caught by an existing guard rather than by review
 * (src/tests/smartSearchTaskSource.contract.test.ts, "a bare id query returns that exact task
 * first"): services/absentTerms.ts asks whether a term occurs in any record's INDEXED TEXT. A
 * record's own UUID is not part of its text. So a bare-id lookup for a record nobody happens
 * to have mentioned in prose produced `absent: [<the id8>]` → not an English word → VETO →
 * EMPTY, for a record that exists and that the id path resolves at rank 1. A confident
 * "we have no record of that" about the exact record asked for is the worst answer this
 * feature can give, and it is precisely the failure the whole empty state is meant to avoid.
 *
 * So the absence claim is reconciled against what the search actually RESOLVED: a term that
 * occurs INSIDE a resolved record's id, or equals one of its tags, is removed from `absent`
 * entirely — it is not merely un-vetoed, because reporting "no record of X" beside record X
 * would be false in the other direction.
 *
 * INSIDE, not "is a prefix of" — measured. The identifier extractor splits a full UUID into
 * SEVERAL hex runs of 7-40 characters (the 8-hex head and the 12-hex tail; the 4-hex groups
 * are below the pattern's floor). Only the head is a prefix of the id, so a prefix test left
 * the tail flagged absent and the veto still fired on a bare full-uuid lookup. The hyphens are
 * stripped on both sides so a term spanning a group boundary is matched the same way.
 *
 * `resolvedIds` / `resolvedTags` come from rows that matched by their OWN id or tag (the
 * SEARCH_ID_MATCH_SCORE_BOOST path), not from every row returned — a row that merely ranked
 * well says nothing about whether the caller's word exists anywhere.
 */
export function reconcileWithResolvedRecords(
  verdict: EmptyStateVerdict,
  resolvedIds: readonly string[],
  resolvedTags: readonly string[],
): EmptyStateVerdict {
  if (verdict.absentTerms.length === 0) return verdict;
  const strip = (v: string) => v.toLowerCase().replace(/-/g, '');
  const ids = resolvedIds.map(strip);
  const tags = new Set(resolvedTags.map((t) => t.toLowerCase()));
  const namesARecord = (term: string): boolean => {
    const t = term.toLowerCase();
    if (tags.has(t)) return true;
    const bare = strip(term);
    return bare !== '' && ids.some((id) => id.includes(bare));
  };
  const absentTerms = verdict.absentTerms.filter((a) => !namesARecord(a.term));
  if (absentTerms.length === verdict.absentTerms.length) return verdict;
  // A term that named a record is matched, not absent: it now counts toward the tolerance.
  const matchedTermCount = verdict.matchedTermCount + (verdict.absentTerms.length - absentTerms.length);
  const vetoedBy = HYBRID_SEARCH_CONFIG.absentTermVeto ? vetoersOf(absentTerms, matchedTermCount) : [];
  return { absentTerms, vetoedBy, veto: vetoedBy.length > 0, matchedTermCount };
}

/**
 * The human sentence for a vetoed search. Named here, not built at the two render sites, so
 * the text channel and the structured channel cannot describe the same state differently —
 * which is the BUILD 5 defect one level down.
 */
export function vetoMessage(query: string, vetoedBy: readonly string[]): string {
  const list = vetoedBy.map((t) => `"${t}"`).join(', ');
  return (
    `No records mention ${list}.\n\n` +
    `This project has no record of ${vetoedBy.length === 1 ? 'that term' : 'those terms'}, ` +
    `so there is nothing to return for: "${query}"\n` +
    `This is an ANSWER, not a failure — the search ran and the corpus does not contain ` +
    `${vetoedBy.length === 1 ? 'it' : 'them'}.`
  );
}
