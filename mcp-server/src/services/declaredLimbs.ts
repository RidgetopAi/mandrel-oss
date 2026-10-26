/**
 * DECLARED LIMBS — the RULE: what limbs a record declares.
 *
 * PURE ON PURPOSE — this module imports the config and nothing else. No database, no
 * clock, no logger. That is what lets `declaredLimbsGoldenParity.contract.test.ts` run the
 * PRODUCTION function over the eval's pinned population with an injected resolver, instead
 * of testing a lookalike. The database-backed half (resolution against the live corpus and
 * writing the column) lives in declaredLimbsStore.ts.
 *
 * BRANCH-1 (an earlier decision Phase 1): materialise, per record,
 * the set of limbs it DECLARES.
 *
 * A "limb" is a line of work identified by its root record — a task or a decision. A
 * record declares a limb two ways, and BOTH are required:
 *   1. a `task:<id8>` / `decision:<id8>` / `epic:<id8>` TAG, and
 *   2. an 8-hex id NAMED IN ITS PROSE that resolves to a task or a decision.
 * A large minority of the corpus declares its limb ONLY the second way, which is why the
 * tags-only shortcut was rejected on measurement rather than on argument. The counts and
 * the query that produced them live on an earlier task; they are deliberately not
 * restated here, because a number in a comment is a number that goes stale silently.
 *
 * ── THE RULE IS PINNED, NOT AUTHORED HERE ────────────────────────────────────────────
 * The precision this build rests on (P 0.756 / R 0.912) was measured with a PYTHON
 * derivation — `evals/branch-meter/hierarchy.py`, branch eval/branch-membership-meter. This
 * module reimplements that rule in TypeScript, and `declaredLimbsGoldenParity.contract.test.ts`
 * asserts the two produce BYTE-IDENTICAL limb sets over the 192 pinned labeled records.
 * Change the rule here and that test goes red — deliberately. A rule that drifts from the
 * one that was measured makes every shipped number describe something nobody evaluated.
 *
 * ── AMBIGUITY IS DROPPED AND COUNTED, NEVER GUESSED ──────────────────────────────────
 * The eval resolved id8s against a pinned 192-record subgraph with zero collisions. Live
 * resolves against ~14,000 records across every project. An 8-hex prefix matching more
 * than one record resolves to NOTHING (guessing would invent a limb) and the drop is
 * COUNTED into `declared_limbs_ambiguous_drops` on the row, so the derivation's own error
 * rate is queryable instead of swallowed.
 *
 * ── THREE STATES, NOT TWO ────────────────────────────────────────────────────────────
 * `declared_limbs IS NULL`  → NOT DERIVED (written before this shipped, or written while
 *                             the kill switch was off, or the derivation errored).
 * `declared_limbs = '{}'`   → DERIVED, and this record declares nothing (unassignable).
 * These must never be conflated: the second is the MAJORITY of the corpus and is terminal
 * under Phase 2 (an expected population, not an error state), and the first is work the
 * backfill still owes. Measured proportions: an earlier task.
 */

import {
  LIMB_ID8_PATTERN,
  LIMB_TAG_PATTERN,
  LIMB_ROOT_TYPES,
  type LimbResolvableType,
} from '../config/declaredLimbsConfig.js';

/** Re-exported so consumers take the record-kind type from the module they already import. */
export type { LimbResolvableType };



export type Id8Resolution =
  | { kind: 'limbRoot'; id: string }
  /** Resolved to exactly one record, but one that cannot be a limb root (a context). */
  | { kind: 'notALimbRoot' }
  /** The 8-hex prefix matches more than one record — DROP, never guess. */
  | { kind: 'ambiguous' }
  /** The 8-hex prefix matches no record at all (a commit sha fragment, random hex, …). */
  | { kind: 'unresolved' };

export interface Id8Resolver {
  resolve(id8: string): Id8Resolution;
}

/** The columns the derivation reads from a record, whatever table it came from. */
export interface LimbSourceRecord {
  id: string;
  type: LimbResolvableType;
  /** The record's prose, composed by `composeLimbBody` — never a truncated title. */
  body: string;
  tags: readonly string[];
}

export interface DerivedLimbs {
  /** The limb roots this record declares, as full uuids, sorted for a stable stored value. */
  limbs: string[];
  /** How many id8 mentions were dropped because the prefix was ambiguous. */
  ambiguousDrops: number;
}

// ── Body composition ───────────────────────────────────────────────────────────────────

/**
 * Compose the prose an id8 may be named in, per record kind.
 *
 * These expressions MIRROR the ones the eval pinned its bodies with, because the golden fixture's `body` strings were
 * produced by them: a context is its `content`, a task is `title\ndescription`, a decision
 * is `concat_ws('\n', title, description, rationale, problem_statement, outcome_notes)`.
 * Postgres `concat_ws` SKIPS NULL arguments but keeps empty strings, and `coalesce(x,'')`
 * turns a NULL into an empty segment that still contributes its separator — the two behave
 * differently, so they are reproduced separately rather than unified into something tidier.
 * `declaredLimbsRederive.contract.test.ts` asserts this TypeScript equals the SQL for the
 * NULL and empty-string cases, against the live database, rather than asserting it in prose.
 */
export function composeLimbBody(
  type: LimbResolvableType,
  row: Record<string, unknown>
): string {
  const s = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);
  switch (type) {
    case 'context':
      return s(row.content) ?? '';
    case 'task':
      // coalesce(title,'') || E'\n' || coalesce(description,'')
      return `${s(row.title) ?? ''}\n${s(row.description) ?? ''}`;
    case 'decision':
      // concat_ws(E'\n', title, description, rationale, problem_statement, outcome_notes)
      return [
        s(row.title),
        s(row.description),
        s(row.rationale),
        s(row.problem_statement),
        s(row.outcome_notes),
      ]
        .filter((v): v is string => v !== null)
        .join('\n');
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────────────────

/**
 * Build a resolver over an explicit population of records.
 *
 * ONE grouping rule, used by BOTH the write-time resolver (which loads only the id8s a
 * single record names) and the backfill resolver (which loads the whole node table once).
 * The two differ in WHICH rows they fetch and in nothing else, so they cannot drift into
 * disagreeing about ambiguity — the failure mode that would make a backfilled row differ
 * from the same row written today.
 */
export function buildId8Resolver(
  rows: ReadonlyArray<{ id: string; type: LimbResolvableType }>
): Id8Resolver {
  const byId8 = new Map<string, Array<{ id: string; type: LimbResolvableType }>>();
  for (const row of rows) {
    const key = row.id.slice(0, 8);
    const bucket = byId8.get(key);
    if (bucket) bucket.push(row);
    else byId8.set(key, [row]);
  }
  return {
    resolve(id8: string): Id8Resolution {
      const hits = byId8.get(id8);
      if (!hits || hits.length === 0) return { kind: 'unresolved' };
      if (hits.length > 1) return { kind: 'ambiguous' };
      return (LIMB_ROOT_TYPES as readonly string[]).includes(hits[0].type)
        ? { kind: 'limbRoot', id: hits[0].id }
        : { kind: 'notALimbRoot' };
    },
  };
}

/**
 * Every 8-hex id a record NAMES: the ids inside its limb tags (in tag order, duplicates
 * kept — each is an independent mention) and the DISTINCT ids in its body.
 *
 * Exported because both the derivation and the write-time resolver need exactly this set,
 * and computing it twice by two slightly different readings of the tag grammar is how the
 * two would drift.
 */
export function collectNamedId8s(rec: LimbSourceRecord): {
  tagId8s: string[];
  bodyId8s: string[];
} {
  const tagId8s: string[] = [];
  for (const tag of rec.tags ?? []) {
    const m = LIMB_TAG_PATTERN.exec(String(tag).trim());
    if (m) tagId8s.push(m[2]);
  }
  // A fresh matcher each call: LIMB_ID8_PATTERN is /g and therefore stateful.
  const bodyId8s = Array.from(
    new Set((rec.body ?? '').match(new RegExp(LIMB_ID8_PATTERN.source, 'g')) ?? [])
  );
  return { tagId8s, bodyId8s };
}

// ── The derivation ─────────────────────────────────────────────────────────────────────

/**
 * Derive the limb set a record declares. PURE: no I/O, no clock, no database — the resolver
 * is injected, which is what lets the golden test run the PRODUCTION function over the eval's
 * pinned population instead of a lookalike written for the test.
 *
 * Mirrors hierarchy.py `Hierarchy.refs()` + `limbs()`:
 *   - a task or decision IS its own limb root, so it declares itself;
 *   - each limb tag and each distinct body id8 resolves to a limb root or is dropped;
 *   - `limbs = declared ∪ ancestors`, which is why `epic:` needs no separate treatment here
 *     (see declaredLimbsConfig.LIMB_TAG_PATTERN).
 */
export function deriveDeclaredLimbs(
  rec: LimbSourceRecord,
  resolver: Id8Resolver
): DerivedLimbs {
  const limbs = new Set<string>();
  let ambiguousDrops = 0;

  if ((LIMB_ROOT_TYPES as readonly string[]).includes(rec.type)) {
    limbs.add(rec.id);
  }

  const { tagId8s, bodyId8s } = collectNamedId8s(rec);
  for (const id8 of [...tagId8s, ...bodyId8s]) {
    const res = resolver.resolve(id8);
    if (res.kind === 'limbRoot') limbs.add(res.id);
    else if (res.kind === 'ambiguous') ambiguousDrops++;
  }

  return { limbs: Array.from(limbs).sort(), ambiguousDrops };
}
