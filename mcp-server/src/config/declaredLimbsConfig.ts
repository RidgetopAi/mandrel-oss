/**
 * DECLARED LIMBS — the named config for the limb materialisation (BRANCH-1,
 * an earlier decision Phase 1).
 *
 * STANDING PRINCIPLE (the operator, binds this and every build): NO HARDCODED VARIABLES. Every
 * knob the derivation touches lives HERE, with a doc line and an env override — never a
 * literal buried in the service. Mirrors threadConfig.ts / trustConfig.ts.
 *
 * WHAT IS *NOT* TUNABLE, AND WHY. The two patterns and the type list below are the RULE
 * ITSELF, not knobs. They were measured (P 0.756 / R 0.912 on 14 hand-labeled anchors) as a
 * fixed rule, and `declaredLimbsGoldenParity.contract.test.ts` asserts that what they
 * EXTRACT — per record, over the 192 pinned records — is what the eval's Python patterns
 * extract. Making them env-tunable would let a deployment silently run a rule nobody
 * measured, which is the exact failure that test exists to prevent. They live here as NAMED
 * EXPORTS (one home, read by the service) with no env read.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a boolean env var, falling back to `fallback` on missing/unknown. Accepts (case- and
 * whitespace-insensitive) 1/true/yes/on → true and 0/false/no/off → false; anything else
 * (incl. empty/missing) → `fallback`. Exported so the accepted spellings can be asserted
 * directly, without reloading modules. The same tolerant shape as claimConfig.envBool and
 * sessionConfig.envBool, deliberately — this reads a KILL SWITCH, and a strict
 * exact-lowercase-`false` reader silently ignores an operator who types `FALSE`, `0` or
 * `off` mid-incident. A switch you cannot reliably pull is not a switch.
 */
export function parseBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Read a boolean env var through `parseBooleanFlag`. */
function envBool(name: string, fallback: boolean): boolean {
  return parseBooleanFlag(process.env[name], fallback); // env-read: via-callers
}

/**
 * An 8-hex id token NAMED IN PROSE. Word-bounded so it cannot match inside a 40-char commit
 * sha; a 7-char short sha therefore never matches either. NOT a knob — see the header.
 *
 * SAME SOURCE TEXT as hierarchy.py's `_ID8`, but NOT identical semantics: JavaScript `\b` is
 * ASCII-only while Python 3 `\b` is Unicode-aware, so a hex run abutting a non-ASCII letter
 * (`Müdeadbeef`) is named here and not there. What the golden test asserts is therefore the
 * EXTRACTION over the pinned population, record by record — not an equivalence of the two
 * regex engines, which is not true in general and must not be claimed.
 */
export const LIMB_ID8_PATTERN = /\b[0-9a-f]{8}\b/g;

/**
 * A tag that NAMES another record. `task:`/`decision:` mean "this record belongs to that
 * limb"; `epic:` declares an ANCESTOR (a parent limb). Identical to hierarchy.py's
 * `_TAG_REF`. NOT a knob — see the header.
 *
 * PHASE 1 DOES NOT MATERIALISE THE PEER/ANCESTOR SPLIT, and that is not a shortcut: the
 * limb SET is the union of the two (hierarchy.py `limbs()` returns `declared | ancestors`
 * after subtracting one from the other), so the split cannot change a single stored value.
 * It becomes load-bearing only for Phase 3 nesting, which is not in this build; the tag
 * grammar is captured here so that phase reads one home rather than re-deriving it.
 */
export const LIMB_TAG_PATTERN = /^(task|decision|epic):([0-9a-f]{8})$/;

/**
 * The record types that can BE a limb root. A task or a decision is its own limb root; a
 * context never is (it is always a record ON a limb). An id8 that resolves to a context is
 * therefore dropped, exactly as hierarchy.py drops it. NOT a knob — see the header.
 */
export const LIMB_ROOT_TYPES = ['task', 'decision'] as const;
export type LimbRootType = (typeof LIMB_ROOT_TYPES)[number];

/** Every node type an id8 can resolve to in this schema. */
export const LIMB_RESOLVABLE_TYPES = ['task', 'decision', 'context'] as const;
export type LimbResolvableType = (typeof LIMB_RESOLVABLE_TYPES)[number];

export interface DeclaredLimbsConfig {
  /**
   * write_time_derivation_enabled — materialise limbs on every context/decision/task write.
   * Default ON. The kill switch exists because this adds two queries to the write path: if
   * it ever misbehaves in prod it can be turned OFF without a rollback, and the rows written
   * while it is off carry `declared_limbs = NULL` (NOT-YET-DERIVED, which is a DIFFERENT
   * state from the empty array meaning "derived, declares nothing" — see migration 078).
   * The backfill re-derives exactly those rows afterwards, so nothing is silently lost.
   * Env: MANDREL_LIMBS_WRITE_TIME_ENABLED. Default true.
   *
   * READ-BACK (required of a flag): the effective value is reported by `mandrel_status`
   * under `featureFlags.declaredLimbsWriteTime` and logged once at startup. Without a
   * process-level read-back the only probe is data-level — `declared_limbs IS NULL` on
   * recent rows — and that CANNOT tell "switched off" from "deriving and erroring",
   * because both leave NULL by design.
   */
  writeTimeDerivationEnabled: boolean;
  /**
   * backfill_batch_size — rows updated per statement by the backfill. Bounds the size of a
   * single UPDATE … FROM (VALUES …) and its transaction's lock footprint.
   * Env: MANDREL_LIMBS_BACKFILL_BATCH. Default 500.
   */
  backfillBatchSize: number;
}

/** THE LIVE CONFIG — read once at module load. */
export const DECLARED_LIMBS_CONFIG: DeclaredLimbsConfig = {
  writeTimeDerivationEnabled: envBool('MANDREL_LIMBS_WRITE_TIME_ENABLED', true),
  backfillBatchSize: envInt('MANDREL_LIMBS_BACKFILL_BATCH', 500),
};

/**
 * The read-back string, built in ONE place so the startup log and `mandrel_status` cannot
 * disagree about what the process is actually running.
 */
export function declaredLimbsFlagSummary(): string {
  return `declared-limbs write-time derivation: ${DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled ? 'ON' : 'OFF'} (MANDREL_LIMBS_WRITE_TIME_ENABLED)`;
}
