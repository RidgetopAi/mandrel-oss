/**
 * INPUT HYGIENE — the ONE centralized detector for boundary validation.
 *
 * A past incident (centralize the guard, don't drift N copies): every place that must decide
 * "is this value leaked tool-call XML?" or "is this a literal null/undefined identity?"
 * calls THESE functions — the zod boundary (middleware/validation.ts) AND the read-only
 * existing-data sweep script both reuse this exact logic, so a future write-path and the
 * detection script can never disagree about what "corrupted" means.
 *
 * The vocabulary (which signatures / which reserved strings) lives in
 * config/inputHygieneConfig.ts (configs-not-hardcoded); this module is the pure logic.
 */

import {
  TOOL_CALL_ARTIFACT_SIGNATURES,
  RESERVED_IDENTITY_STRINGS,
  METADATA_SCAN_MAX_DEPTH,
  METADATA_SCAN_MAX_NODES,
} from '../config/inputHygieneConfig.js';

/**
 * Remove code spans from `text` so a signature QUOTED as documentation is not matched:
 *   - fenced blocks: ```...``` and ~~~...~~~ (including the fence lines)
 *   - inline spans:  `...` (single or multiple backticks)
 *
 * WHY (a past incident pt 4 — a guard stricter than reality is a bug): a legitimate bug-report
 * task/context/decision quotes tool-call tags INSIDE backticks as documentation (this very
 * task's description does). Stripping code spans first means quoted docs pass while a RAW,
 * un-quoted structural leak (the incident's shape) still gets caught. Returns the prose
 * with every code span replaced by a single space (so adjacent words don't fuse).
 */
export function stripCodeSpans(text: string): string {
  if (!text) return '';
  let out = text;
  // 1. BALANCED fenced blocks only (an opening fence up to its MATCHING closing fence),
  //    non-greedy, multiline. A CLOSED fence is a deliberate code region, so quoted docs
  //    inside it pass.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/~~~[\s\S]*?~~~/g, ' ');
  // 2. DANGLING (unterminated) fence handling — FAIL-SAFE (Reviewer finding /
  //    guards-need-guarding). Any triple-fence marker still present here was never closed,
  //    so it is NOT a trusted code region: its TAIL must stay SCANNABLE or a raw leak could
  //    hide behind a lone ``` (e.g. "text ```\n</description>..."). We therefore strip ONLY
  //    the 3-char marker itself (so it can't spuriously pair up in the inline-span pass
  //    below), leaving ALL surrounding text in place to be scanned. This is the opposite of
  //    stripping to end-of-string — an unclosed fence hides NOTHING.
  out = out.replace(/```|~~~/g, ' ');
  // 3. BALANCED inline code spans: a run of backticks up to the SAME run (handles
  //    ``code with ` inside`` too), non-greedy. It REQUIRES a matching close, so an
  //    UNMATCHED backtick run is left intact (scannable) — the same fail-safe as the fences.
  out = out.replace(/(`+)[\s\S]*?\1/g, ' ');
  return out;
}

/**
 * Return the list of tool-call-artifact signatures found as RAW (non-code-span) text in
 * `value`. Empty array → clean. Case-insensitive. This is the single predicate both the
 * boundary guard and the sweep script use.
 */
export function findArtifactSignatures(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const prose = stripCodeSpans(value).toLowerCase();
  const found: string[] = [];
  for (const sig of TOOL_CALL_ARTIFACT_SIGNATURES) {
    if (prose.includes(sig.toLowerCase())) found.push(sig);
  }
  return found;
}

/** True when `value` contains raw (non-code-span) tool-call-artifact XML. */
export function hasArtifactSignature(value: unknown): boolean {
  return findArtifactSignatures(value).length > 0;
}

/**
 * True when `value` is a literal reserved identity string ("null"/"undefined"/…): a
 * degraded client stringified a JS null/undefined into an identity field. Trimmed +
 * lowercased comparison. Non-strings and empty strings are NOT reserved (empty is handled
 * by the field's own min()/optional rules, not here).
 */
export function isReservedIdentityString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const norm = value.trim().toLowerCase();
  if (norm.length === 0) return false;
  return RESERVED_IDENTITY_STRINGS.includes(norm);
}

/** One offending string found inside a nested bag: WHERE it is, and WHAT was found there. */
export interface DeepArtifactFinding {
  /** JSON-ish path from the scanned root, e.g. `capture.evidence` or `artifacts[0].note`. */
  readonly path: string;
  /** The signatures found as RAW (non-code-span) text at that path. */
  readonly signatures: readonly string[];
}

/** The result of a bounded subtree scan. `truncated` is the THIRD state — see below. */
export interface DeepArtifactScan {
  readonly findings: readonly DeepArtifactFinding[];
  /**
   * True when the walk stopped early on METADATA_SCAN_MAX_DEPTH / METADATA_SCAN_MAX_NODES,
   * i.e. part of the bag was NEVER LOOKED AT. This is "could not measure", not "clean"
   * (CLASSES.md C1: an instrument has three states and the third must not share a value
   * with "no"). Callers must not read `findings.length === 0` as clean while this is true.
   */
  readonly truncated: boolean;
}

/**
 * Walk an arbitrary JSON-shaped value and return every STRING leaf that carries RAW
 * (non-code-span) tool-call-artifact XML, with the path it sits at.
 *
 * WHY A SUBTREE WALK RATHER THAN A NAMED-FIELD CHECK: the reported hole was
 * `metadata.capture.evidence`, but `metadata` is a free-form bag — enumerating the keys we
 * happen to know about is precisely the guard-written-against-remembered-shapes failure
 * (CLASSES.md C3). The population this guard enumerates is therefore EVERY string reachable
 * inside the value, at every depth, in objects and arrays alike, bounded only by the two
 * config limits — which is the whole population by construction, and the reason a metadata
 * key invented next quarter is covered without anyone editing this file.
 *
 * Non-strings (numbers, booleans, null) are not scanned because they cannot carry a
 * substring. Object KEYS are not scanned: a key is a structural identifier, not content,
 * and the leaked payloads land in values.
 *
 * Delegates per-string to `findArtifactSignatures`, so the code-span exemption is IDENTICAL
 * here and at the prose fields — one definition of "corrupted", as this module exists to
 * guarantee.
 */
export function findArtifactSignaturesDeep(root: unknown): DeepArtifactScan {
  const scan = scanStringsDeep(root, findArtifactSignatures);
  return {
    findings: scan.findings.map((f) => ({ path: f.path, signatures: f.matches })),
    truncated: scan.truncated,
  };
}

/** One offending string found by `scanStringsDeep`: WHERE it is, and WHAT the detector said. */
export interface DeepStringFinding {
  /** JSON-ish path from the scanned root, e.g. `capture.evidence` or `artifacts[0].note`. */
  readonly path: string;
  /** Whatever the per-string detector returned for that leaf (signatures, credential ids, …). */
  readonly matches: readonly string[];
}

/** The result of a bounded subtree scan. `truncated` is the THIRD state — see DeepArtifactScan. */
export interface DeepStringScan {
  readonly findings: readonly DeepStringFinding[];
  readonly truncated: boolean;
}

/**
 * THE ONE BOUNDED SUBTREE WALKER. Walks an arbitrary JSON-shaped value and applies `detect`
 * to every STRING leaf, recording the path of each leaf the detector reports on.
 *
 * WHY IT IS GENERIC (CLASSES.md C5 — two paths doing the same job drift): `metadata` is
 * scanned for TWO different things now — leaked tool-call XML and credentials
 * — and a second hand-written walker would be a second set of bounds, a second
 * truncation semantics, and a second place to forget that arrays exist. There is one traversal
 * and one definition of "part of the bag was never looked at"; only the per-string predicate
 * differs.
 *
 * Non-strings (numbers, booleans, null) are not scanned because they cannot carry a substring.
 * Object KEYS are not scanned: a key is a structural identifier, not content.
 */
export function scanStringsDeep(
  root: unknown,
  detect: (value: string) => readonly string[],
): DeepStringScan {
  const findings: DeepStringFinding[] = [];
  let visited = 0;
  let truncated = false;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (visited >= METADATA_SCAN_MAX_NODES) {
      truncated = true;
      return;
    }
    visited += 1;

    if (typeof node === 'string') {
      const matches = detect(node);
      if (matches.length > 0) findings.push({ path, matches });
      return;
    }
    if (node === null || typeof node !== 'object') return;

    // Depth bound. An EMPTY container at the limit hides nothing, so it is not truncation —
    // only an unwalked CHILD is. Getting this wrong would report "could not measure" on a
    // bag that was in fact fully measured.
    const isEmpty = Array.isArray(node)
      ? node.length === 0
      : Object.keys(node as Record<string, unknown>).length === 0;
    if (depth >= METADATA_SCAN_MAX_DEPTH) {
      if (!isEmpty) truncated = true;
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, path === '' ? key : `${path}.${key}`, depth + 1);
    }
  };

  walk(root, '', 0);
  return { findings, truncated };
}
