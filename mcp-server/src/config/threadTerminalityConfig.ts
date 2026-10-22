/**
 * THREAD TERMINALITY — the named config for recall_thread's `can_expand` rule
 * (BRANCH-2, an earlier decision Phase 2; flag mechanism 3bcb2f1c).
 *
 * =============================================================================
 * WHAT THE RULE IS
 * =============================================================================
 * A record that belongs to many lines of work — a day's handoff, a plan covering five
 * sub-tasks — is a DESTINATION, NOT A CORRIDOR. You may arrive at it; you may not pass
 * through it. The walk stays admitted-but-not-expanded at such a node.
 *
 * ADMIT-BUT-DO-NOT-TRANSIT IS NOT EXCLUSION. Nothing is ever refused MEMBERSHIP by this
 * rule, which is why it can raise precision without costing recall on the population it
 * was measured against.
 *
 * =============================================================================
 * FLAG POLARITY: ABSENT **AND GARBAGE** MEAN OFF — AND THE REASON IS REPORTED
 * =============================================================================
 * The code default is OFF. That is the OPPOSITE polarity to callerIdentityConfig's
 * scope guard (absent means ENFORCE there), and the difference is deliberate: the scope
 * guard's unsafe direction is "not guarding", while this rule's unsafe direction is
 * "silently returning less than the user asked for". A read-path change that drops
 * records is user-visible on day one, so forgetting the flag must leave today's answers
 * untouched.
 *
 * An UNPARSEABLE value resolves to OFF *and says so*: `modeSource` distinguishes
 * 'absent' from 'unparseable', and `threadTerminalityFlagSummary()` renders the
 * difference. An operator who typed `MANDREL_THREAD_TERMINALITY=treu` mid-incident must
 * be able to see from the read-back that the flag was rejected rather than believe they
 * turned something on.
 *
 * =============================================================================
 * WHY NOT THE JSON FeatureFlagStore
 * =============================================================================
 * measured: `utils/featureFlags.ts` had zero behavioural consumers,
 * was broken fleet-wide, and its `refresh()` early-returned KEEPING the previous flags
 * on a failed read — so a revert through it could silently never apply. It has since
 * been DELETED; this file's env-var named config is the mechanism, and
 * it is the one proven enforcing on all 8 fleet instances.
 *
 * configs-not-hardcoded: the threshold and the two terminality floors live HERE, never
 * as literals at the rule site.
 */

import { parseBooleanFlag } from './declaredLimbsConfig.js';

/** The two postures. A string (not a bare boolean) because it is a READ-BACK surface. */
export type ThreadTerminalityMode = 'off' | 'on';

/** How the effective mode was arrived at — the honest three states (C1). */
export type ThreadTerminalityModeSource = 'absent' | 'unparseable' | 'explicit';

/**
 * Env names, exported as constants so a test and a compose declaration reference the ONE
 * string rather than re-typing it (a past incident #5).
 */
export const THREAD_TERMINALITY_ENV = 'MANDREL_THREAD_TERMINALITY';
export const THREAD_TERMINALITY_THETA_ENV = 'MANDREL_THREAD_TERMINALITY_TRANSIT_THETA';
export const THREAD_TERMINALITY_UNASSIGNABLE_ENV =
  'MANDREL_THREAD_TERMINALITY_UNASSIGNABLE_TERMINAL';
export const THREAD_TERMINALITY_NOT_DERIVED_ENV =
  'MANDREL_THREAD_TERMINALITY_NOT_DERIVED_TERMINAL';

/**
 * The mode that applies when the setting is ABSENT or UNPARSEABLE. Named (not inlined) so
 * the polarity is a reviewable constant: a diff that flips this is a one-line decision.
 */
export const THREAD_TERMINALITY_DEFAULT: ThreadTerminalityMode = 'off';

/**
 * transit_overlap_threshold — a node may be TRANSITED when the fraction of the limbs it
 * declares that lie inside the anchor's cone is >= this.
 *
 *   overlap(r) = |limbs(r) ∩ cone(anchor)| / |limbs(r)|
 *
 * WHY 0.01 AND NOT 0.5. This is the value of the measured rule (`C4 terminal-only`,
 * P 0.756 / R 0.912 on the 14-anchor labeled set) and it is effectively "any overlap at
 * all". Higher thresholds were swept and scored — 0.3 / 0.5 / 0.7 all bought precision by
 * dropping BELOW the pre-registered recall floor of 0.90. The knob exists because the
 * threshold must not be a literal, NOT because the value is open: changing it runs a rule
 * nobody measured.
 * Env: MANDREL_THREAD_TERMINALITY_TRANSIT_THETA. Default 0.01.
 */
export const THREAD_TERMINALITY_THETA_DEFAULT = 0.01;

/**
 * unassignable_terminal — a record whose derived limb set is EMPTY (it was derived, and it
 * names nothing) cannot vouch for the walk continuing, so it is a destination too.
 *
 * This is the COVERAGE FLOOR, and it is the clause that does most of the work. Measured
 * cost of NOT having it: on anchor `20e71fca` the an earlier milestone names nothing
 * resolvable and is the single corridor through which all five sibling tasks of its epic
 * enter — 7 of that anchor's 8 false positives.
 * Env: MANDREL_THREAD_TERMINALITY_UNASSIGNABLE_TERMINAL. Default true.
 */
export const THREAD_TERMINALITY_UNASSIGNABLE_DEFAULT = true;

/**
 * not_derived_terminal — what to do with a record whose `declared_limbs` column is NULL.
 *
 * NULL IS THE THIRD STATE (C1), and it is NOT the same as the empty array. Empty means
 * "derived, declares nothing"; NULL means "never derived" — a row written while BRANCH-1's
 * write-time hook was off, or one the backfill has not reached. Treating a
 * could-not-measure as a measured "declares nothing" would prune a corridor on the
 * strength of a fact we do not have.
 *
 * DEFAULT FALSE = permissive: an undecidable node stays expandable, and every one is
 * COUNTED in the telemetry as `not-derived` so the population is observable rather than
 * assumed. After BRANCH-1's backfill this count should be ~0; if it is not, the telemetry
 * says so instead of the rule silently over-pruning.
 * Env: MANDREL_THREAD_TERMINALITY_NOT_DERIVED_TERMINAL. Default false.
 */
export const THREAD_TERMINALITY_NOT_DERIVED_DEFAULT = false;

/** The resolved flag plus HOW it resolved — both are read-back surface. */
export interface ThreadTerminalityFlag {
  mode: ThreadTerminalityMode;
  source: ThreadTerminalityModeSource;
  /** The trimmed value that was REJECTED. Present only when source === 'unparseable'. */
  rejectedValue?: string;
}

/**
 * Resolve the mode from a raw env value.
 *
 * The accepted spellings are NOT re-authored here. `parseBooleanFlag` (declaredLimbsConfig)
 * is the house tolerant reader — 1/true/yes/on and 0/false/no/off, case- and
 * whitespace-insensitive — and this calls it TWICE with opposite fallbacks purely to learn
 * whether it recognised the value at all: if the two answers disagree, the value fell
 * through to the fallback both times, i.e. it is unparseable. That keeps one definition of
 * "what spellings are accepted" in the codebase. BRANCH-1's kill switch shipped accepting
 * only exact lowercase `false` and was caught failing OPEN; a second private parser here
 * would be the same defect one module over.
 *
 * Exported so a test can exercise the parse without depending on module-load order (the
 * static-import-evaluates-before-the-stub trap, a past incident (b)).
 */
export function readThreadTerminalityFlag(
  raw: string | undefined = process.env[THREAD_TERMINALITY_ENV] // env-read: MANDREL_THREAD_TERMINALITY
): ThreadTerminalityFlag {
  if (raw === undefined || raw.trim() === '') {
    return { mode: THREAD_TERMINALITY_DEFAULT, source: 'absent' };
  }
  const asTrue = parseBooleanFlag(raw, true);
  const asFalse = parseBooleanFlag(raw, false);
  if (asTrue !== asFalse) {
    return {
      mode: THREAD_TERMINALITY_DEFAULT,
      source: 'unparseable',
      rejectedValue: raw.trim(),
    };
  }
  return { mode: asTrue ? 'on' : 'off', source: 'explicit' };
}

/**
 * Read a fraction in [0,1] from the environment; missing / non-numeric / out-of-range all
 * fall back. Out-of-range is a fallback rather than a clamp on purpose: a `theta` of 5 is
 * a typo, and clamping it to 1 would silently run the strictest possible rule.
 */
export function readOverlapThreshold(
  raw: string | undefined = process.env[THREAD_TERMINALITY_THETA_ENV], // env-read: MANDREL_THREAD_TERMINALITY_TRANSIT_THETA
  fallback: number = THREAD_TERMINALITY_THETA_DEFAULT
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

/** Read a boolean env var through the house tolerant reader. */
function envBool(name: string, fallback: boolean): boolean {
  return parseBooleanFlag(process.env[name], fallback); // env-read: via-callers
}

export interface ThreadTerminalityConfig {
  /** off | on. See the polarity block. Env: MANDREL_THREAD_TERMINALITY. Default 'off'. */
  mode: ThreadTerminalityMode;
  /** How `mode` resolved — 'absent' | 'unparseable' | 'explicit'. Read-back only. */
  modeSource: ThreadTerminalityModeSource;
  /** The rejected raw value when modeSource === 'unparseable'. Read-back only. */
  rejectedValue?: string;
  /** overlap fraction at or above which a node may be TRANSITED. Default 0.01. */
  transitOverlapThreshold: number;
  /** derived-but-empty limb set ⇒ terminal. Default true. */
  unassignableTerminal: boolean;
  /** NULL (never-derived) limb column ⇒ terminal. Default false (permissive + counted). */
  notDerivedTerminal: boolean;
}

/** THE LIVE CONFIG — read once at module load, exactly like THREAD_CONFIG. */
const FLAG = readThreadTerminalityFlag();

export const THREAD_TERMINALITY_CONFIG: ThreadTerminalityConfig = {
  mode: FLAG.mode,
  modeSource: FLAG.source,
  ...(FLAG.rejectedValue === undefined ? {} : { rejectedValue: FLAG.rejectedValue }),
  transitOverlapThreshold: readOverlapThreshold(),
  unassignableTerminal: envBool(
    THREAD_TERMINALITY_UNASSIGNABLE_ENV,
    THREAD_TERMINALITY_UNASSIGNABLE_DEFAULT
  ),
  notDerivedTerminal: envBool(
    THREAD_TERMINALITY_NOT_DERIVED_ENV,
    THREAD_TERMINALITY_NOT_DERIVED_DEFAULT
  ),
};

/**
 * THE READ-BACK STRING, built in ONE place so the startup log and `mandrel_status` cannot
 * disagree about what the process is actually running (the BRANCH-1 pattern).
 *
 * A revert you cannot read back is a revert you cannot claim (an earlier decision §4).
 * Revert = flip the env, restart, READ THIS STRING.
 */
export function threadTerminalityFlagSummary(
  cfg: ThreadTerminalityConfig = THREAD_TERMINALITY_CONFIG
): string {
  const why =
    cfg.modeSource === 'unparseable'
      ? `unparseable value ${JSON.stringify(cfg.rejectedValue ?? '')} REJECTED → default`
      : cfg.modeSource === 'absent'
        ? 'unset → default'
        : 'set explicitly';
  return (
    `recall_thread terminality: ${cfg.mode.toUpperCase()} (${THREAD_TERMINALITY_ENV}, ${why})` +
    ` · transit-overlap>=${cfg.transitOverlapThreshold}` +
    ` · unassignable-terminal=${cfg.unassignableTerminal}` +
    ` · not-derived-terminal=${cfg.notDerivedTerminal}`
  );
}
