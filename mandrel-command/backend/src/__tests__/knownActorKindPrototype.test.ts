/**
 * knownActorKind — THE THIRD DOOR.
 *
 * `config/actorRegistry.ts` answered "is this a known actor" with a bare index read,
 * `BUILTIN_ACTOR_KINDS[key]`. That walks Object.prototype, and `actorMatchKey` is only
 * trim+lowercase, so every all-lowercase prototype key arrived as a candidate actor.
 * MEASURED before the fix (Reviewer):
 *   knownActorKind('constructor') -> typeof 'function'  ·  API JSON: {}
 *   knownActorKind('__proto__')   -> typeof 'object'    ·  API JSON: {"actor_kind":{}}
 *   knownActorKind('coordinator')       -> 'agent'            (control)
 * The declared return type is `ActorKind | null`, so both are outside it, and neither
 * survives JSON.stringify — a function serializes to NOTHING, so `actor_kind` disappeared
 * from the response body entirely. The input is user-controlled: sessionAnalytics.ts and
 * task.ts:209 reach this from a FREE-TEXT task assignee.
 *
 * ═══ WHY THIS FILE EXISTS AND THE DRIFT GUARD NEXT DOOR DOES NOT COVER IT ════════════
 * `actorRegistryDrift.test.ts` pins this mirror to the mcp-server declaration by parsing
 * the two literal BLOCKS off disk. It compares WHAT IS DECLARED. It cannot see HOW the
 * declaration is READ, so it was fully GREEN across this defect and would have stayed
 * green forever. Two guards, two different questions.
 *
 * ═══ WHERE THE POPULATION COMES FROM, AND WHY NOT FROM THE REGISTRY ══════════════════
 * The operative rule (the coordinator, 2026-08-28, after this class produced three doors in two
 * files): WHEN THE DEFECT CAN LIVE IN THE ACCESS PATH, THE GUARD MUST ENUMERATE FROM A
 * SOURCE THE IMPLEMENTATION'S PATH DOES NOT CONTROL. Deriving this population from
 * BUILTIN_ACTOR_KINDS — the obvious, "properly derived" choice — is exactly what cannot
 * work here: `Object.keys()` is own+enumerable and the defect lived in own-vs-inherited,
 * so the guard would enumerate precisely the set that never triggers it. So the source is
 * `Object.prototype` itself, and the disjointness is ASSERTED below rather than assumed.
 */

import {
  BUILTIN_ACTOR_KINDS,
  knownActorKind,
  actorMatchKey,
} from '../config/actorRegistry';

/**
 * The keys reachable through this API. `actorMatchKey` lowercases, so a mixed-case
 * prototype key (`toString`, `valueOf`, …) arrives lowercased and matches nothing — that
 * is DERIVED here, not asserted about in prose, by filtering on the same transform the
 * implementation applies.
 */
const REACHABLE_PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype).filter(
  (k) => actorMatchKey(k) === k
);

const ACTOR_KINDS = ['human', 'agent', 'automation'];

describe('knownActorKind: Object.prototype keys are not actors', () => {
  test('the population is non-empty and DISJOINT from the registry', () => {
    // The non-empty trap: an empty list would pass every assertion below while testing
    // nothing at all.
    expect(REACHABLE_PROTOTYPE_KEYS).toContain('constructor');
    expect(REACHABLE_PROTOTYPE_KEYS.length).toBeGreaterThan(1);

    // Disjointness is the POINT: it proves this population could not have been obtained
    // from the registry, i.e. that the guard enumerates from outside the access path it
    // is testing. If these ever intersect, the source below has stopped being adversarial.
    const registryKeys = new Set(Object.keys(BUILTIN_ACTOR_KINDS));
    expect(REACHABLE_PROTOTYPE_KEYS.filter((k) => registryKeys.has(k))).toEqual([]);
  });

  test('every reachable prototype key answers null, not an inherited value', () => {
    for (const key of REACHABLE_PROTOTYPE_KEYS) {
      expect(knownActorKind(key)).toBeNull();
    }
  });

  test('the mixed-case prototype keys are unreachable BECAUSE of the lowercase match key', () => {
    const mixedCase = Object.getOwnPropertyNames(Object.prototype).filter(
      (k) => actorMatchKey(k) !== k
    );
    expect(mixedCase.length).toBeGreaterThan(0); // non-empty trap
    for (const key of mixedCase) {
      // Both spellings: the raw key never matches, and neither does what it lowercases to.
      expect(knownActorKind(key)).toBeNull();
      expect(knownActorKind(actorMatchKey(key))).toBeNull();
    }
  });

  test('the answer always survives the wire — a function serialized to NOTHING', () => {
    // This is the user-visible half of the defect, asserted where the user met it:
    // `actor_kind` vanished from the response body. JSON.stringify drops a function
    // value, so the key itself disappeared rather than carrying a wrong value.
    for (const key of REACHABLE_PROTOTYPE_KEYS) {
      const body = JSON.stringify({ actor_kind: knownActorKind(key) });
      expect(body).toBe('{"actor_kind":null}');
    }
  });

  test('POSITIVE CONTROLS — the real registry still answers, so this is not a blanket null', () => {
    const registryKeys = Object.keys(BUILTIN_ACTOR_KINDS);
    expect(registryKeys.length).toBeGreaterThan(0); // non-empty trap
    for (const actor of registryKeys) {
      expect(ACTOR_KINDS).toContain(knownActorKind(actor));
    }
    // …and the prefix families, which resolve on a different branch entirely.
    expect(ACTOR_KINDS).toContain(knownActorKind('builder-0803f00d'));
  });
});
