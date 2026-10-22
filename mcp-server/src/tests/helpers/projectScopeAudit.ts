/**
 * THE PROJECT-SCOPE CALL-SITE AUDITOR — the deny-by-default accounting half of the guard for
 * an earlier task. Consumed by
 * `src/tests/projectScopeChokePoint.contract.test.ts`.
 *
 * =============================================================================
 * WHY THE PREVIOUS GUARD COULD NOT HAVE CAUGHT THE BUG
 * =============================================================================
 * `projectBindingRouteGate.contract.test.ts` sweeps "every tool where `projectScopeParam(tool)`
 * is defined". `project_current` declares NO project param, so it was excluded from that
 * guard's population BY CONSTRUCTION — the guard's set was definitionally the COMPLEMENT of
 * the bug. The sibling param-accounting tripwire has the same hole: its choke point is "a
 * declared param containing the token `project`", so a tool that resolves a project WHILE
 * DECLARING NONE passes through invisibly.
 *
 * Both guards anchored on the SHAPE the author had in mind (a declared parameter) rather than
 * on the CHOKE POINT every instance must pass through (recurrence rules 7-10).
 *
 * =============================================================================
 * WHAT THIS ANCHORS ON INSTEAD
 * =============================================================================
 * The accessors themselves. EVERY project resolution in the tree goes through one of:
 *
 *     getCurrentProjectId / getCurrentProject          — EFFECTIVE scope (binding-aware)
 *     getInteractiveProjectId / getInteractiveProject  — rung 3 ONLY (binding-blind)
 *
 * so the accessor NAME is the token every instance must pass through, and this module accounts
 * for every occurrence of it in `src/` (tests excluded). DENY BY DEFAULT: an occurrence with no
 * co-located classification is a VIOLATION, not a silent pass. That makes the two mutations in
 * the task's acceptance criteria RED by construction:
 *
 *   - a new, unclassified `getCurrentProjectId` call site         → unclassified violation
 *   - a call site quietly moved off the binding-aware accessor    → class/token mismatch
 *     (the marker still says `effective` while the token is now `getInteractiveProjectId`)
 *
 * =============================================================================
 * WHY THE CLASSIFICATION IS CO-LOCATED AND NOT A REGISTRY
 * =============================================================================
 * A central registry of "approved call sites" is a second copy of the truth that drifts from
 * the code it describes (a past incident #4). The marker lives ON the read, so forgetting it is a
 * visible RED rather than a silent hole, and choosing the binding-blind accessor
 * costs the author a written reason.
 *
 * The one thing that IS pinned literally is the set of rung-3 (binding-blind) call sites —
 * because that class is the ESCAPE from binding-awareness, and a guard that merely counted
 * them (`> 0`) would widen in lockstep with the thing it pins (a past incident #7). Pinning the
 * per-file map means adding a rung-3 read is a two-file diff: a decision, not a drift.
 *
 * =============================================================================
 * MUTATION-PROBED, INCLUDING ITS OWN SELF-CHECKS
 * =============================================================================
 * Every function here is PURE over an in-memory corpus (`Map<relativePath, source>`), so the
 * test file drives it with FABRICATED corpora — an unmarked site, a mismatched marker, an
 * ambiguous block, a corpus whose only occurrences are inside COMMENTS, and the EMPTY corpus —
 * and asserts each produces a violation. Zero/empty/absent are the values that slip through a
 * self-check (a past incident #6: mutation-probe the PROBE, not just the product), so "scanned
 * nothing" is itself an explicit violation rather than a vacuous pass.
 */

/** The classification a call site must carry. There is deliberately NO "ignore me" class. */
export type ScopeClass = 'effective' | 'rung3' | 'accessor-definition';

/** The binding-AWARE accessors: the default every project resolution should use. */
export const EFFECTIVE_ACCESSORS = ['getCurrentProjectId', 'getCurrentProject'] as const;

/** The binding-BLIND accessors: rung 3 (THE HUMAN PATH), opt-in only, with a written reason. */
export const RUNG3_ACCESSORS = ['getInteractiveProjectId', 'getInteractiveProject'] as const;

/** The ONE file allowed to contain `accessor-definition` occurrences. */
export const ACCESSOR_DEFINITION_FILE = 'handlers/project.ts';

/**
 * Longest-alternative-first so `getCurrentProjectId` never matches as `getCurrentProject`;
 * `\b` on both ends so a longer identifier that merely CONTAINS one of these is not a hit.
 */
const ACCESSOR_RE = new RegExp(
  `\\b(${[...EFFECTIVE_ACCESSORS, ...RUNG3_ACCESSORS]
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|')})\\b`,
  'g'
);

/**
 * The co-located marker. `—` (em dash) or `-`/`--` both accepted so the rule does not hinge on
 * a keystroke, and a REASON of real length is required: a bare class name is a label, not a
 * justification.
 */
const MARKER_RE = /PROJECT-SCOPE:\s*(effective|rung3|accessor-definition)\b\s*[—–-]+\s*(\S.{11,})/;

export interface ScopeCallSite {
  /** Path relative to `src/`, e.g. `routes/thread.routes.ts`. */
  file: string;
  /** 1-based line number of the occurrence in the ORIGINAL source. */
  line: number;
  /** The accessor token that occurred. */
  token: string;
  /** `effective` for the binding-aware accessors, `rung3` for the binding-blind ones. */
  family: 'effective' | 'rung3';
  /** The class declared by the co-located marker, or null when there is none. */
  declared: ScopeClass | null;
  /** True when the marker block declared two different classes (ambiguous → fail closed). */
  ambiguous: boolean;
  /** The original line's text, for a readable violation message. */
  text: string;
}

export interface ScopeAuditResult {
  sites: ScopeCallSite[];
  byClass: Record<ScopeClass, number>;
  /** Per-file counts of rung-3 (binding-blind) call sites, EXCLUDING accessor definitions. */
  rung3ByFile: Record<string, number>;
  violations: string[];
}

/**
 * Blank out comments while preserving the line/column structure, so a token that appears in
 * PROSE is not mistaken for a call site — and, more importantly, so a call site can never be
 * hidden from this scan by being described in a comment. String literals are tracked (with
 * backslash escapes) so a `//` inside a string does not swallow the rest of the line.
 *
 * Comment characters become spaces; newlines are preserved verbatim, so line numbers in the
 * blanked text are identical to the original.
 */
export function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') {
        state = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'code';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    // Inside a string literal: copy verbatim, honour escapes, end on the matching quote.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`')
    ) {
      state = 'code';
    }
    i++;
  }
  return out.join('');
}

/** A line that carries no code — blank, a `//` line, or a line inside a block comment. */
function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * The classification co-located with the occurrence on `lineIdx` (0-based): the marker on the
 * line ITSELF, or in the contiguous comment/blank block immediately above it. The walk stops at
 * the first line carrying code, so a marker can never be "inherited" across an unrelated
 * statement.
 */
function declaredClassFor(
  lines: string[],
  lineIdx: number
): { declared: ScopeClass | null; ambiguous: boolean } {
  const found = new Set<ScopeClass>();
  const consider = (l: string) => {
    const m = MARKER_RE.exec(l);
    if (m) found.add(m[1] as ScopeClass);
  };

  consider(lines[lineIdx]);
  for (let i = lineIdx - 1; i >= 0; i--) {
    if (!isCommentOrBlank(lines[i])) break;
    consider(lines[i]);
  }

  if (found.size === 0) return { declared: null, ambiguous: false };
  if (found.size > 1) return { declared: null, ambiguous: true };
  return { declared: [...found][0], ambiguous: false };
}

/** Every accessor occurrence in CODE across the corpus, with its co-located classification. */
export function findScopeCallSites(corpus: Map<string, string>): ScopeCallSite[] {
  const sites: ScopeCallSite[] = [];
  for (const [file, src] of corpus) {
    const lines = src.split('\n');
    const codeLines = blankComments(src).split('\n');
    for (let i = 0; i < codeLines.length; i++) {
      ACCESSOR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ACCESSOR_RE.exec(codeLines[i])) !== null) {
        const token = m[1];
        const { declared, ambiguous } = declaredClassFor(lines, i);
        sites.push({
          file,
          line: i + 1,
          token,
          family: (RUNG3_ACCESSORS as readonly string[]).includes(token) ? 'rung3' : 'effective',
          declared,
          ambiguous,
          text: (lines[i] ?? '').trim(),
        });
      }
    }
  }
  return sites;
}

/** Which declared classes are legal for a given accessor family. */
function allowedClasses(family: 'effective' | 'rung3'): ScopeClass[] {
  return family === 'effective'
    ? ['effective', 'accessor-definition']
    : ['rung3', 'accessor-definition'];
}

/**
 * THE AUDIT. Deny-by-default over every accessor occurrence, plus the self-checks that stop an
 * empty/broken scan from reporting GREEN.
 *
 * @param corpus         relativePath → source text (tests excluded by the caller)
 * @param rung3Pin       the LITERALLY PINNED per-file count of binding-blind call sites
 * @param expectedDefs   the LITERALLY PINNED number of accessor definitions
 * @param expectedTotal  the LITERALLY PINNED total number of accessor call sites in CODE.
 *                       This is the SCAN-INTEGRITY pin: if comment-stripping ever swallowed a
 *                       real line (a regex literal containing `//`, say), the count would drop
 *                       and this guard would silently start covering less. A number nothing
 *                       enforces is prose (the phantom-guard class this task also fixes in
 *                       projectBindingRouteGate), so it is asserted, and moving it is a
 *                       deliberate one-line edit that shows up in review.
 */
export function auditProjectScope(
  corpus: Map<string, string>,
  rung3Pin: Readonly<Record<string, number>>,
  expectedDefs: number,
  expectedTotal: number
): ScopeAuditResult {
  const sites = findScopeCallSites(corpus);
  const violations: string[] = [];
  const byClass: Record<ScopeClass, number> = {
    effective: 0,
    rung3: 0,
    'accessor-definition': 0,
  };
  const rung3ByFile: Record<string, number> = {};

  for (const s of sites) {
    const where = `${s.file}:${s.line}  ${s.text}`;
    if (s.ambiguous) {
      violations.push(
        `AMBIGUOUS classification — the comment block above declares more than one ` +
          `PROJECT-SCOPE class, so nobody can say which applies: ${where}`
      );
      continue;
    }
    if (s.declared === null) {
      violations.push(
        `UNCLASSIFIED project-scope call site: ${where}\n` +
          `      → every use of ${s.token} must carry a co-located ` +
          `"// PROJECT-SCOPE: <effective|rung3|accessor-definition> — <reason>" comment. ` +
          `Use 'effective' (the binding-aware default) unless you are deliberately reading ` +
          `rung 3, and say why.`
      );
      continue;
    }
    if (!allowedClasses(s.family).includes(s.declared)) {
      violations.push(
        `CLASS/TOKEN MISMATCH — declared '${s.declared}' but the accessor is '${s.token}' ` +
          `(a ${s.family === 'rung3' ? 'binding-BLIND' : 'binding-AWARE'} accessor): ${where}\n` +
          `      → this is the exact shape of "a call site quietly moved off the ` +
          `binding-aware accessor". Change the accessor back, or change BOTH and justify it.`
      );
      continue;
    }
    if (s.declared === 'accessor-definition' && s.file !== ACCESSOR_DEFINITION_FILE) {
      violations.push(
        `ACCESSOR DEFINED OUTSIDE ${ACCESSOR_DEFINITION_FILE}: ${where}\n` +
          `      → there is exactly one home for the project-scope accessors; a second one is ` +
          `a second source of truth.`
      );
      continue;
    }
    byClass[s.declared]++;
    if (s.declared === 'rung3') {
      rung3ByFile[s.file] = (rung3ByFile[s.file] ?? 0) + 1;
    }
  }

  // ── SELF-CHECKS. Zero/empty/absent are the values that slip through a guard, so each is an
  //    explicit violation rather than a vacuously satisfied loop above.
  if (corpus.size === 0) {
    violations.push(
      'SELF-CHECK: the corpus is EMPTY — the file scan found nothing to audit, so this guard ' +
        'measured nothing. A guard that scans zero files passes every mutation.'
    );
  }
  if (sites.length === 0) {
    violations.push(
      'SELF-CHECK: ZERO project-scope call sites found. Either the accessors were renamed ' +
        '(update EFFECTIVE_ACCESSORS/RUNG3_ACCESSORS) or the scan is broken. Not a pass.'
    );
  }
  if (sites.length !== expectedTotal) {
    violations.push(
      `SELF-CHECK: expected exactly ${expectedTotal} project-scope call sites in code, found ` +
        `${sites.length}. Either you added/removed one (bump the pin in the same commit, so ` +
        `the change is a decision) or the SCAN itself changed what it can see — which is how ` +
        `a guard silently starts covering less than it claims.`
    );
  }
  if (byClass['accessor-definition'] !== expectedDefs) {
    violations.push(
      `SELF-CHECK: expected exactly ${expectedDefs} accessor definitions in ` +
        `${ACCESSOR_DEFINITION_FILE}, found ${byClass['accessor-definition']}. The accessor ` +
        `pair is the choke point; adding or removing one changes what this guard covers.`
    );
  }
  if (byClass.effective === 0) {
    violations.push(
      'SELF-CHECK: ZERO call sites classified `effective`. The binding-aware accessor is the ' +
        'default for the whole product — measuring none of them means the scan is not ' +
        'observing the product.'
    );
  }

  // ── THE rung-3 PIN. Literal per-file counts: a NEW binding-blind read anywhere is RED, and
  //    the fix is a deliberate edit here plus the call site (a past incident #7 — a guard that
  //    derives its expectation from the product widens in lockstep with it).
  const pinFiles = new Set([...Object.keys(rung3Pin), ...Object.keys(rung3ByFile)]);
  for (const f of [...pinFiles].sort()) {
    const expected = rung3Pin[f] ?? 0;
    const actual = rung3ByFile[f] ?? 0;
    if (expected !== actual) {
      violations.push(
        `rung-3 PIN BROKEN in ${f}: pinned ${expected} binding-blind call site(s), found ` +
          `${actual}.\n      → rung 3 is the ESCAPE from binding-awareness (an earlier decision ` +
          `makes the binding authoritative for what every tool REPORTS). If this change is ` +
          `intended, update RUNG3_CALL_SITE_PIN and say why in the commit body.`
      );
    }
  }

  return { sites, byClass, rung3ByFile, violations };
}
