/**
 * THREADING LENS AXES — the vocabulary contract.
 *
 * WHAT THIS GUARDS. `component:` / `actor:` / `batch:` were minted because 257 out-of-set
 * threading values on prod turned out to be RIGHT values on axes that did not exist. The
 * grammar module (`utils/threadingTags.ts`) already had contract tests; what it did not
 * have was anything asserting the VOCABULARY — which axes exist, what each accepts, and
 * that the closed sets stayed closed. That is what this file is.
 *
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3). Every assertion below is DERIVED from
 * `config/threadingVocabConfig.LENS_AXES` and iterated, never written out as a list of the
 * axes that happened to exist the day this was authored: a seventh axis added tomorrow is
 * covered by every test here without an edit, and an axis DELETED tomorrow makes the
 * non-empty traps fail rather than pass vacuously. The traps matter — a test that
 * enumerates a config and asserts a property of each member passes trivially when the
 * config is empty, which is the shape of false green this repo keeps closing.
 *
 * ═══ THE BATCH-6 REGRESSION THIS FILE IS WRITTEN AGAINST ═════════════════════════════
 * Quarantine made a private 8-hex id regex load-bearing, so `task:<full uuid>` — THE VERY
 * REMEDY the product's own error message hands the user — was quarantined and minted
 * nothing. The test of the day asserted the remedy MESSAGE existed. Nothing asserted that
 * FOLLOWING it worked.
 *
 * So the central test here is `following the quarantine warning WORKS`: it takes the
 * accepted values out of the warning text the product actually emits, feeds each one back
 * through the same validator, and asserts the result is not quarantined. If the message
 * ever advertises a value the grammar rejects, that test goes RED — which is the failure
 * mode a message-existence assertion cannot see.
 */

import { describe, expect, test } from 'vitest';

import {
  THREADING_QUARANTINE_PREFIX,
  isQuarantinedThreadingTag,
  isThreadingTag,
  validateAndNormalizeTags,
} from '../utils/threadingTags.js';
import {
  BATCH_LABEL_MAX_LENGTH,
  COMPONENT_VALUES,
  LENS_AXES,
  OWNER_VALUES,
  SCOPE_VALUES,
  TRANCHE_VALUES,
  type LensAxisSpec,
} from '../config/threadingVocabConfig.js';
import { ACTOR_PREFIX_RULES, BUILTIN_ACTOR_KINDS, classifyActor } from '../config/actorRegistry.js';
import { tagToEdgeIntent } from '../config/tagEdgeConfig.js';
import { EDGE_NODE_TYPES } from '../config/edgeTypes.js';
import { hasTrustThreadingTag } from '../services/links.js';

/** Validate ONE tag and return what the write boundary would actually store. */
function store(tag: string): { stored: string; warnings: string[] } {
  const { tags, warnings } = validateAndNormalizeTags([tag]);
  return { stored: tags[0], warnings };
}

/** A value guaranteed out-of-set on ANY axis: it is not a batch label and not a roster name. */
const DEFINITELY_OUT_OF_SET = 'definitely!!not@a@declared@value';

/** The axes added by an earlier decision — named so the widening itself is asserted. */
const NEW_AXIS_PREFIXES = ['component:', 'actor:', 'batch:'] as const;

/** The closed axes, i.e. the ones carrying an enumerable roster. */
const closedAxes: LensAxisSpec[] = LENS_AXES.filter(a => a.values !== null);

describe('threading lens axes — the vocabulary exists and is non-empty', () => {
  // NON-EMPTY TRAP. Every other test in this file iterates LENS_AXES; if that array were
  // ever empty (or the closed sets emptied), they would all pass while asserting nothing.
  test('LENS_AXES is populated and every axis is well-formed', () => {
    expect(LENS_AXES.length).toBeGreaterThanOrEqual(6);
    for (const axis of LENS_AXES) {
      expect(axis.prefix).toMatch(/^[a-z]+:$/);
      expect(axis.expects.length).toBeGreaterThan(0);
      if (axis.values) expect(axis.values.length).toBeGreaterThan(0);
    }
  });

  test('the three axes an earlier decision minted are present and recognized', () => {
    for (const prefix of NEW_AXIS_PREFIXES) {
      expect(LENS_AXES.map(a => a.prefix)).toContain(prefix);
    }
    expect(isThreadingTag('component:prod-mandrel')).toBe(true);
    expect(isThreadingTag('actor:builder')).toBe(true);
    expect(isThreadingTag('batch:p4')).toBe(true);
  });
});

describe('threading lens axes — a declared value threads, an undeclared one quarantines', () => {
  test('every value of every CLOSED axis is stored verbatim with no warning', () => {
    let checked = 0;
    for (const axis of closedAxes) {
      for (const value of axis.values!) {
        const tag = `${axis.prefix}${value}`;
        const { stored, warnings } = store(tag);
        expect(stored).toBe(tag);
        expect(isQuarantinedThreadingTag(stored)).toBe(false);
        expect(warnings).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // non-empty trap
  });

  test('an out-of-set value on EVERY axis quarantines, keeping the value recoverable', () => {
    for (const axis of LENS_AXES) {
      const tag = `${axis.prefix}${DEFINITELY_OUT_OF_SET}`;
      const { stored, warnings } = store(tag);
      expect(stored).toBe(`${THREADING_QUARANTINE_PREFIX}${tag}`);
      expect(isQuarantinedThreadingTag(stored)).toBe(true);
      expect(warnings).toHaveLength(1);
      // The author's value survives after the marker — nothing is dropped.
      expect(stored.endsWith(DEFINITELY_OUT_OF_SET)).toBe(true);
    }
  });

  test('an EMPTY value on every axis quarantines (the value quarantine exists for)', () => {
    for (const axis of LENS_AXES) {
      const { stored } = store(axis.prefix);
      expect(stored).toBe(`${THREADING_QUARANTINE_PREFIX}${axis.prefix}`);
      expect(isQuarantinedThreadingTag(stored)).toBe(true);
    }
  });

  test('quarantine is idempotent — re-validating never double-prefixes', () => {
    for (const axis of LENS_AXES) {
      const once = store(`${axis.prefix}${DEFINITELY_OUT_OF_SET}`).stored;
      const twice = store(once).stored;
      expect(twice).toBe(once);
    }
  });

  test('case and whitespace are normalized on every axis, never rejected', () => {
    for (const axis of closedAxes) {
      const value = axis.values![0];
      const { stored } = store(`  ${axis.prefix.toUpperCase()}${value.toUpperCase()}  `);
      expect(stored).toBe(`${axis.prefix}${value}`);
    }
  });
});

describe('threading lens axes — FOLLOWING the quarantine warning actually works', () => {
  /**
   * The batch-6 lesson, executed. Not "the message mentions a remedy" — the values the
   * message ADVERTISES are extracted from the emitted text and fed back through the
   * validator. A message that names a value the grammar rejects turns this RED.
   */
  test('every value advertised in a closed axis’s warning validates when used', () => {
    let advertised = 0;
    for (const axis of closedAxes) {
      const { warnings } = store(`${axis.prefix}${DEFINITELY_OUT_OF_SET}`);
      const listed = warnings[0].match(/\{([^}]*)\}/);
      expect(listed, `warning for ${axis.prefix} advertises no value set: ${warnings[0]}`).not.toBeNull();
      const values = listed![1].split(',').map(v => v.trim()).filter(Boolean);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        const { stored } = store(`${axis.prefix}${value}`);
        expect(
          isQuarantinedThreadingTag(stored),
          `${axis.prefix} warning advertises "${value}" but using it quarantines`,
        ).toBe(false);
        advertised++;
      }
    }
    expect(advertised).toBeGreaterThan(0); // non-empty trap
  });

  test('the shape-validated axes advertise examples that also work', () => {
    // `actor:` and `batch:` carry no closed set, so their warnings advertise EXAMPLES in
    // parentheses instead. Same obligation: an advertised example must validate.
    for (const prefix of ['actor:', 'batch:'] as const) {
      const { warnings } = store(`${prefix}${DEFINITELY_OUT_OF_SET}`);
      // Take every parenthesised group in the emitted text and keep the tokens that are
      // shaped like a VALUE (so the prose around them, and the `…`, drop out).
      const examples = [...warnings[0].matchAll(/\(([^)]*)\)/g)]
        .flatMap(m => m[1].split(','))
        .map(v => v.trim())
        .filter(v => /^[a-z0-9][a-z0-9-]*$/.test(v));
      expect(examples.length, `no usable examples advertised for ${prefix}: ${warnings[0]}`)
        .toBeGreaterThan(1);
      for (const example of examples) {
        expect(
          isQuarantinedThreadingTag(store(`${prefix}${example}`).stored),
          `${prefix} warning advertises "${example}" but using it quarantines`,
        ).toBe(false);
      }
    }
  });
});

describe('threading lens axes — the closed sets STAYED closed (we did not widen)', () => {
  test('scope: still answers only company-vs-product', () => {
    expect([...SCOPE_VALUES]).toEqual(['company', 'product']);
    // The most-written out-of-set scope values measured on prod. They are COMPONENTS, and
    // absorbing them into scope: is exactly what an earlier decision refused.
    for (const value of ['mandrel', 'command-ui', 'infra', 'mandrel', 'runtime']) {
      expect(isQuarantinedThreadingTag(store(`scope:${value}`).stored)).toBe(true);
    }
  });

  test('tranche: still answers only the build risk class', () => {
    expect([...TRANCHE_VALUES]).toEqual(['safe', 'measured']);
    for (const value of ['p3', 'p4', 'sprint0', 'batch-2']) {
      expect(isQuarantinedThreadingTag(store(`tranche:${value}`).stored)).toBe(true);
    }
  });

  test('owner: gained exactly ONE value — ops — and no agent names', () => {
    expect(OWNER_VALUES).toContain('ops');
    expect(isQuarantinedThreadingTag(store('owner:ops').stored)).toBe(false);
    // The department roster, unchanged apart from that one addition.
    expect([...OWNER_VALUES].sort()).toEqual(
      ['accounting', 'engineering', 'marketing', 'ops', 'product', 'rnd'].sort(),
    );
    // Agent names belong on actor:, so they must STILL quarantine on owner:.
    for (const value of ['builder', 'coordinator', 'reviewer']) {
      expect(isQuarantinedThreadingTag(store(`owner:${value}`).stored)).toBe(true);
      expect(isQuarantinedThreadingTag(store(`actor:${value}`).stored)).toBe(false);
    }
  });
});

describe('threading lens axes — component: is the registry, actor: is the roster', () => {
  test('COMPONENT_VALUES are registry-shaped names and each one threads', () => {
    expect(COMPONENT_VALUES.length).toBeGreaterThan(0);
    for (const name of COMPONENT_VALUES) {
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(isQuarantinedThreadingTag(store(`component:${name}`).stored)).toBe(false);
    }
    // A plausible-but-unregistered component must NOT sneak in. `mandrel` is the single
    // most-written out-of-set scope value on prod (22 instances) and is not a registry name.
    expect(isQuarantinedThreadingTag(store('component:mandrel').stored)).toBe(true);
  });

  test('actor: accepts exactly the actor registry, including the prefix families', () => {
    const names = Object.keys(BUILTIN_ACTOR_KINDS);
    expect(names.length).toBeGreaterThan(0); // non-empty trap
    for (const name of names) {
      expect(
        isQuarantinedThreadingTag(store(`actor:${name}`).stored),
        `actor:${name} is on the registry but quarantines`,
      ).toBe(false);
    }
    expect(ACTOR_PREFIX_RULES.length).toBeGreaterThan(0);
    for (const rule of ACTOR_PREFIX_RULES) {
      expect(isQuarantinedThreadingTag(store(`actor:${rule.prefix}0803a2d0`).stored)).toBe(false);
      // A BARE prefix names nobody and must not pass as a family member.
      expect(isQuarantinedThreadingTag(store(`actor:${rule.prefix}`).stored)).toBe(true);
    }
    // Not on the roster: quarantined. (classifyActor would call this an 'agent' — that is a
    // different question, and using it as a membership test is the bug this guards.)
    expect(isQuarantinedThreadingTag(store('actor:nobody-in-particular').stored)).toBe(true);
  });

  /**
   * PROTOTYPE KEYS ARE PART OF THE POPULATION. Added after this file shipped a false green:
   * `isRegisteredActor` asked `subject in resolveRegistry()`, and `in` walks
   * Object.prototype — so `actor:constructor` and `actor:__proto__` stored UNQUARANTINED,
   * with zero warnings, and threaded as valid actor tags. Every OTHER assertion in this
   * file derives its population from `Object.keys(BUILTIN_ACTOR_KINDS)`, which is OWN keys,
   * while the implementation was reading the prototype chain — the guard's population and
   * the implementation's were different sets, which is why nothing here could see it
   * (CLASSES.md C3). The population below is read off `Object.prototype` directly — the
   * one set no `Object.keys(BUILTIN_ACTOR_KINDS)` will ever hand this test.
   *
   * It is asserted at the WRITE BOUNDARY rather than against the predicate, because the
   * boundary is where the damage was: the tag reached a stored row looking authoritative.
   */
  test('Object.prototype keys are NOT actors — the membership read is own-keys only', () => {
    // DERIVED from Object.prototype itself, so a future engine key is covered without an
    // edit — and trapped as non-empty, because an empty list would pass every assertion
    // below while testing nothing.
    const INHERITED_KEYS = Object.getOwnPropertyNames(Object.prototype).filter(
      k => k === k.toLowerCase(),
    );
    expect(INHERITED_KEYS).toContain('constructor');
    expect(INHERITED_KEYS.length).toBeGreaterThan(1);

    // ONLY the all-lowercase Object.prototype keys are reachable here, and that is a
    // derived fact, not a shortlist: both this boundary and normalizeActor LOWERCASE
    // first, so `toString` arrives as `tostring`, which no prototype carries. Asserted
    // below rather than asserted about.
    for (const inherited of INHERITED_KEYS) {
      const { stored, warnings } = store(`actor:${inherited}`);
      expect(
        isQuarantinedThreadingTag(stored),
        `actor:${inherited} is an inherited Object key, not an actor, and it threaded`,
      ).toBe(true);
      expect(warnings).toHaveLength(1);
    }
    // The same door in classifyActor: it returned the Object CONSTRUCTOR FUNCTION typed as
    // an ActorKind. Assert the answer is inside the union the signature promises.
    for (const inherited of INHERITED_KEYS) {
      expect(['human', 'agent', 'automation']).toContain(classifyActor(inherited));
    }
  });
});

describe('threading lens axes — batch: is validated by SHAPE, on purpose', () => {
  test('every batch/phase label measured on prod is accepted', () => {
    // These are the real out-of-set `tranche:` values from the census in     // plus this batch's own lane label. A closed set would have quarantined all of them.
    for (const label of ['p3', 'p4', 'sprint0', 'batch-2', 'b7-l10']) {
      expect(
        isQuarantinedThreadingTag(store(`batch:${label}`).stored),
        `batch:${label} is a label people actually write and it quarantines`,
      ).toBe(false);
    }
  });

  test('the shapes quarantine exists for are still rejected', () => {
    for (const bad of ['-p4', 'p4-', 'p--4', 'p 4', 'p4!', '--', 'a'.repeat(BATCH_LABEL_MAX_LENGTH + 1)]) {
      expect(
        isQuarantinedThreadingTag(store(`batch:${bad}`).stored),
        `batch:${bad} should not be a usable label`,
      ).toBe(true);
    }
  });
});

describe('threading lens axes — a lens is a LABEL: it mints nothing and suppresses nothing', () => {
  test('no lens tag maps to an edge, from any source record type', () => {
    let checked = 0;
    for (const axis of LENS_AXES) {
      const value = axis.values?.[0] ?? (axis.prefix === 'actor:' ? 'coordinator' : 'p4');
      const tag = `${axis.prefix}${value}`;
      // Guard against asserting "mints nothing" about a tag that is itself invalid.
      expect(isQuarantinedThreadingTag(store(tag).stored)).toBe(false);
      for (const source of EDGE_NODE_TYPES) {
        expect(tagToEdgeIntent(source, tag), `${tag} minted an edge from ${source}`).toBeNull();
        expect(hasTrustThreadingTag([tag], source)).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // non-empty trap
  });
});
