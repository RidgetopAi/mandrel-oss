/**
 * threadingVocabConfig — the LENS AXES of the threading tag grammar, as named config.
 *
 * `utils/threadingTags.ts` owns the GRAMMAR (how a tag is parsed, normalized and
 * quarantined). This file owns the VOCABULARY (which axes exist and what values each one
 * accepts), for the same reason `config/tagEdgeConfig.ts` owns the tag→edge matrix rather
 * than the minting code: the rules people change are the values, and they should not have
 * to read a validator to change them. (the operator's standing rule, configs-not-hardcoded.)
 *
 * ═══ WHY THREE NEW AXES (the operator 2026-08-28) ════════════════════════
 * Measured on prod: 257 invalid threading-value instances across 197 records. Reading all
 * 65 distinct out-of-set values showed they are not wrong values on the right axis — they
 * are RIGHT values on axes that did not exist:
 *   - 47 out-of-set `scope:` values, overwhelmingly COMPONENTS/repos (mandrel 22,
 *     command-ui 17, infra 16, mandrel 12, runtime 11, …);
 *   -  5 out-of-set `owner:` values, ALL AGENT names (builder 43, coordinator 21, ops 8,
 *     reviewer 2, runtime 1);
 *   - 13 out-of-set `tranche:` values, ALL PHASE/BATCH labels (p4 16, p3, sprint0,
 *     batch-2) — tranche is out-of-set MORE often (37) than in-set (23).
 * So `scope:`/`owner:`/`tranche:` stay CLOSED — widening `scope:` to hold 47 component
 * names would destroy the only question it exists to answer (company work vs product
 * work) — and `component:` / `actor:` / `batch:` are minted instead. One genuine widening
 * inside an existing set: `ops` joins OWNER_VALUES, because it is a real function, not an
 * agent name (the agent is `ops-bot`, which is an ACTOR).
 *
 * ═══ WHY THESE SETS ARE NOT ENV-OVERRIDABLE ══════════════════════════════════════════
 * "Named config" here means one reviewable declaration, NOT an env knob. A vocabulary any
 * instance can widen from its environment is a vocabulary that means something different
 * per instance: the same tag would thread on one tenant and quarantine on the next, and
 * no cross-fleet query over these axes would be answerable. The one axis that IS
 * environment-extensible is `actor:`, and only because it delegates to the actor registry
 * which ALREADY carries `MANDREL_ACTOR_REGISTRY_EXTRA` as its documented extension point —
 * that is deriving from the single source, not adding a second knob.
 *
 * ═══ CLOSED SETS vs SHAPE ═════════════════════════════════════════════════════════════
 * An axis gets a CLOSED SET when its members are a fixed roster somebody maintains
 * (scope, owner, tranche, component, actor). `batch:` gets a SHAPE instead, deliberately:
 * batch/phase labels are MINTED CONTINUOUSLY (p3, p4, sprint0, batch-2, and there will be
 * a batch 8 next week). A closed set for `batch:` would guarantee the exact failure this
 * decision is repairing — the value people reach for being quarantined because nobody
 * redeployed the enum. The shape is still narrow enough to catch the values quarantine
 * exists for (empty, spaces, punctuation).
 */

import { DEPLOYMENT_VOCABULARY, type DeploymentVocabulary } from './deploymentVocabularyConfig.js';
import { ACTOR_PREFIX_RULES, isRegisteredActor, normalizeActor } from './actorRegistry.js';

/** Lens axis: WHOSE work is this — the company itself, or the product we sell. */
export const SCOPE_VALUES = ['company', 'product'] as const;

/**
 * Lens axis: which DEPARTMENT owns it. `ops` added by an earlier decision — it was written
 * 8 times as an out-of-set value and it is a function, not an agent (`ops-bot` is the
 * agent, and it belongs on the `actor:` axis).
 */
export const OWNER_VALUES = [
  'engineering',
  'product',
  'marketing',
  'rnd',
  'accounting',
  'ops',
] as const;

/** Build risk class (the deploy posture a change was built under). */
export const TRANCHE_VALUES = ['safe', 'measured'] as const;

/**
 * Lens axis: which COMPONENT of the system.
 *
 * DERIVED, NOT INVENTED — these are exactly the `components[].name` values of the
 * Riverbend company-map component registry snapshot
 * (generated 2026-08-28T16:15:04Z by control-host, 8 components). The registry generator
 * lives in the runtime repo, so this is a SNAPSHOT rather than an import: when the
 * registry gains or renames a component, refresh this list and say which snapshot it came
 * from. Do not add a component here that the registry does not know about — the point of
 * the axis is that `component:x` answers "which of the things we actually run".
 */
export const COMPONENT_VALUES = [
  'prod-mandrel',
  'mandrel-command',
  'cockpit',
  'coordinator-ui',
  'tenant-fleet',
  'mcp-bridge',
  'runtime',
] as const;

/**
 * Lens axis `batch:` — the SHAPE, not a set. See "CLOSED SETS vs SHAPE" above.
 *
 * Lowercase alphanumeric words joined by single hyphens: `p4`, `p3`, `sprint0`, `batch-2`,
 * `b7-l10` (every batch label measured on prod parses). Rejects the values quarantine
 * exists for: empty, whitespace, punctuation, a bare hyphen, a leading/trailing hyphen.
 * NOT case: the grammar lowercases before validating, so `batch:P4` normalizes to
 * `batch:p4` with a warning rather than quarantining.
 * Anchored, non-global (a /g regex carries lastIndex between calls and would answer
 * differently depending on call order).
 */
export const BATCH_LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Cap on a batch label's length, so a paragraph cannot pass as a label. */
export const BATCH_LABEL_MAX_LENGTH = 40;

export function isBatchLabel(value: string): boolean {
  return value.length <= BATCH_LABEL_MAX_LENGTH && BATCH_LABEL_RE.test(value);
}

/**
 * One lens axis. `values` is the closed set when the axis has one, and `null` for a
 * shape-validated axis — a consumer that wants to ENUMERATE the vocabulary (a retag
 * report, a docs page, a test that asserts every declared value is accepted) must be able
 * to tell "here is the roster" from "here is a pattern" without parsing prose.
 */
export interface LensAxisSpec {
  /** The tag prefix including the trailing colon, e.g. `scope:`. */
  prefix: string;
  /** Human description of the accepted value, used verbatim in the quarantine warning. */
  expects: string;
  /** True if the (already trimmed + lowercased) value is in the vocabulary. */
  isValid: (value: string) => boolean;
  /** The closed set, or null when the axis is validated by SHAPE. */
  values: readonly string[] | null;
  /**
   * A SHORT placeholder for a shape-validated axis, for the advertised tool description
   * (`actor:<registered actor>`). Required exactly when `values` is null — a shape axis
   * has no roster to print, and printing nothing would advertise the axis as taking no
   * value at all.
   */
  shapeHint?: string;
}

const closed = (prefix: string, values: readonly string[], noun: string): LensAxisSpec => ({
  prefix,
  expects: `one of {${values.join(', ')}} (${noun})`,
  isValid: (v: string) => values.includes(v),
  values,
});

/**
 * THE LENS AXES, in the order they are documented. `utils/threadingTags.ts` builds its
 * prefix table from THIS array, so adding an axis here is the whole change — there is no
 * second list to keep in step (a past incident / CLASSES.md C5: two copies of one list).
 *
 * All of these are LABELS: `config/tagEdgeConfig.ts` mints edges only for `task:` /
 * `decision:` / `context:`, so a lens tag threads nothing by design and — via
 * `hasTrustThreadingTag`, which derives from the edge matrix rather than from a second
 * list of prefixes — never suppresses the positional anchor either.
 */
/**
 * Lens axis: WHICH GUARD CLASS a task is an instance of.
 *
 * This array is the closed roster of guard-class ids. A class joins with its detector.
 *
 * Why a closed set and not a shape: until 2026-09-01 the axis was write-only — 28 tasks
 * carried the single value `guards-need-guarding` and were joined to each other by prose
 * pointers, so nothing could ask "does this class have a detector?" A task must now name a
 * registry entry; a value the registry does not know is quarantined like any other
 * out-of-set lens value, and the warning names the roster.
 */
export const GUARD_CLASS_VALUES = [
  'backwards-belief-edge',
  'fixture-reaches-real-binary',
  'fixture-vacuity',
  'fleet-drift-env-seam',
  'gate-ci-population-disjoint',
  'gate-reads-control-tree',
  'generator-omits-fleet-posture',
  'guard-not-fail-closed',
  'guard-reads-unexecuted-copy',
  'host-shape-in-suite',
  'ledger-trusted-over-object',
  'lint-population-one-dir-over',
  'paged-order-no-tiebreaker',
  'pipefail-boolean',
  'reaper-never-reaped',
  'regex-recognizer-unowned-parser',
  'renderer-drops-structured-fact',
  'secret-reading-command',
  'serializer-literal-recurs',
  'served-openapi-drift',
  'shared-namespace-enumeration',
  'secret-on-child-argv',
  'stale-file-bind-mount',
  'sweep-removes-without-detaching',
  'unguarded-pg-pool',
  'unpinned-instrument-verdict',
  'two-channel-answer-read-through-one',
  'unwired-suite',
  'verdict-from-uncontracted-status',
] as const;

export const LENS_AXES: readonly LensAxisSpec[] = [
  closed('scope:', SCOPE_VALUES, 'company work vs product work'),
  closed('owner:', OWNER_VALUES, 'the department that owns it'),
  closed('tranche:', TRANCHE_VALUES, 'the build risk class'),
  closed('component:', COMPONENT_VALUES, 'a component of the company-map registry'),
  closed('class:', GUARD_CLASS_VALUES, 'a registered guard class'),
  {
    prefix: 'actor:',
    // The registry is the roster, so name it rather than reprinting it — a copy here would
    // drift the first time an actor is added, and the env extension would make the copy
    // wrong on any instance that uses it.
    expects:
      'a registered actor from config/actorRegistry.ts' +
      (DEPLOYMENT_VOCABULARY.actorNames.length > 0 ? ` (${DEPLOYMENT_VOCABULARY.actorNames.join(', ')}, …)` : '') +
      `, including the parametric families ${ACTOR_PREFIX_RULES.map(r => `${r.prefix}<id>`).join(', ')}`,
    // `normalizeActor(v) === v` FIRST, deliberately: the tag grammar only ever trims and
    // lowercases a value (it refuses to guess — see normalizeThreadingTag), while the actor
    // normalizer additionally folds whitespace and repeated hyphens. Without this clause a
    // tag could be judged valid under a normalization the STORED tag never received, so the
    // row would carry a value the roster does not actually contain.
    isValid: (v: string) => normalizeActor(v) === v && isRegisteredActor(v),
    values: null,
    shapeHint: 'a registered actor',
  },
  {
    prefix: 'batch:',
    expects:
      'a batch/phase label — lowercase alphanumerics joined by single hyphens, ' +
      `at most ${BATCH_LABEL_MAX_LENGTH} characters (p4, sprint0, batch-2, b7-l10)`,
    isValid: isBatchLabel,
    values: null,
    shapeHint: 'a batch label',
  },
];

// ── LOAD-TIME INTEGRITY ASSERTIONS (the tagEdgeConfig pattern: fail at import, never
//    advertise a broken vocabulary at runtime on a user's write) ──────────────────────
for (const axis of LENS_AXES) {
  if (!/^[a-z]+:$/.test(axis.prefix)) {
    throw new Error(`[threadingVocabConfig] axis prefix "${axis.prefix}" must be lowercase letters + ':'.`);
  }
  if (axis.values === null && !axis.shapeHint) {
    throw new Error(
      `[threadingVocabConfig] axis "${axis.prefix}" is shape-validated and carries no shapeHint. ` +
        'The tool surface would advertise it as taking no value; give it a short placeholder.',
    );
  }
  if (axis.values && axis.values.length === 0) {
    throw new Error(
      `[threadingVocabConfig] axis "${axis.prefix}" declares an EMPTY closed set, which quarantines ` +
        'every value anyone could write. Delete the axis or give it a roster.',
    );
  }
}

/**
 * The one-line vocabulary summary the TOOL SURFACE advertises (config/opRegistry.ts).
 *
 * DERIVED, so the advertised description and the enforced grammar cannot disagree. They
 * used to be two hand-maintained lists, and the tool description still named five owner
 * values and three axes after this file gained a sixth value and three more axes — which
 * is the drift class this repo keeps closing (CLASSES.md C5), and a nastier one than
 * usual: a user following an out-of-date description writes a tag the server quarantines.
 */
export function lensAxesSummary(vocab: DeploymentVocabulary = DEPLOYMENT_VOCABULARY): string {
  return LENS_AXES.map(a => {
    // The component roster and the guard-class registry are Riverbend's own names; they are
    // printed only where the deployment vocabulary opts in (config/deploymentVocabularyConfig.ts).
    // The VALIDATOR still enforces the full closed set either way.
    const hidden =
      (a.prefix === 'component:' && !vocab.listComponentValues) ||
      (a.prefix === 'class:' && !vocab.listGuardClassValues);
    if (hidden) return `\`${a.prefix}<${a.prefix.slice(0, -1) === 'class' ? 'guard class' : 'component'}>\``;
    return a.values ? `\`${a.prefix}${a.values.join('|')}\`` : `\`${a.prefix}<${a.shapeHint}>\``;
  }).join(' / ');
}

/** The lens axis a tag prefix belongs to, or null. Used by the retag tooling. */
export function lensAxisForPrefix(prefix: string): LensAxisSpec | null {
  return LENS_AXES.find(a => a.prefix === prefix) ?? null;
}
