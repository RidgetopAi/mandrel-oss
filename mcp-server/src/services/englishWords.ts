/**
 * ENGLISH WORD LIST — the discriminator behind the absent-term veto.
 *
 * WHAT IT IS FOR. Absent-term detection (services/absentTerms.ts) can tell you that a term
 * occurs in ZERO records of a project. On its own that is a blunt signal, because there are
 * two very different reasons a term is absent:
 *
 *   "you asked about a thing we do not have"  — Kubernetes, Terraform, PagerDuty, gRPC,
 *                                               gibberish. Not English words.
 *   "you phrased it your own way"             — encyclopedia, unsound, anybody. Ordinary
 *                                               English that simply is not in this corpus.
 *
 * MEASURED on the P1 question sets: absent-AND-not-an-English-word vetoes 12 of 17 negatives
 * while losing 1 of 33 real answers. Absent ALONE vetoes 16 of 17 but loses 6 of 33 — it
 * catches more and costs six times as much. The word list is what buys that trade. (The
 * single remaining loss was `favourite`, which is why the vendored list includes the BRITISH
 * spellings and not just the American ones.)
 *
 * P2a DOES NOT VETO ANYTHING. This module is a primitive; nothing in search calls it yet.
 * P2b decides what search does with it.
 */

import { readFileSync } from 'node:fs';
import { LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';

/**
 * Loaded ONCE, lazily, into a lowercase Set — ~104k entries, ~1MB of source text. Lazy
 * rather than at module load because this file is imported by config-adjacent code paths
 * that have no interest in the list, and a megabyte of synchronous file I/O at import time
 * is a cost every process pays whether or not it ever asks a question.
 */
let words: Set<string> | null = null;

/**
 * Force the list to load and return it. Throws if the vendored file is missing — LOUDLY, not
 * with an empty Set. An empty Set would make `isEnglishWord` return false for EVERY term,
 * which reads downstream as "every word in the language is unknown": a maximally confident
 * wrong answer that no caller can distinguish from a real one. A missing data file is a
 * build/packaging defect (see the Dockerfile's vendor/wordlists COPY) and must surface as
 * one.
 */
function load(): Set<string> {
  if (words !== null) return words;
  const path = LEXICAL_SEARCH_CONFIG.wordlistPath;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `[englishWords] cannot read the vendored word list at ${path}: ${(err as Error).message}. ` +
        `It ships in the repo at mcp-server/vendor/wordlists/english-words.txt (see the README ` +
        `there for provenance) and must be present in the runtime image.`,
    );
  }
  const set = new Set<string>();
  for (const line of raw.split('\n')) {
    const w = line.trim().toLowerCase();
    if (w !== '') set.add(w);
  }
  words = set;
  return set;
}

/** How many entries the loaded list has. Exposed so a guard can assert it is not empty. */
export function englishWordCount(): number {
  return load().size;
}

/**
 * Is `term` an ordinary English word?
 *
 * A term counts as known if it is in the list, OR if it is hyphenated and EVERY part is
 * ("well-known", "read-only"). The hyphen rule exists because compounds are productive:
 * English lets you coin them freely and no finite list can enumerate them, so treating an
 * unlisted compound of listed words as "not English" would veto perfectly ordinary phrasing.
 *
 * A term with a hyphen but an EMPTY part ('-foo', 'a--b') is NOT a word: the parts do not all
 * pass, because an empty string is not in the list. That is the intended answer, and it is
 * asserted in the tests rather than left to the reader to infer.
 */
export function isEnglishWord(term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t === '') return false;
  const list = load();
  if (list.has(t)) return true;
  const sep = LEXICAL_SEARCH_CONFIG.compoundSeparator;
  if (!t.includes(sep)) return false;
  const parts = t.split(sep);
  return parts.every((p) => list.has(p));
}
