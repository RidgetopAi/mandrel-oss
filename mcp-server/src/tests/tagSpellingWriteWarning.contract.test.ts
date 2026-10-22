/**
 * WRITE-TIME TAG SPELLING COLLISION — contract test. an earlier task.
 *
 * THE DEFECT, measured on the live riverbend project 2026-08-31 by sweeping ALL 1152
 * tasks with NO tag filter (the population was swept, not queried for spellings someone
 * had already guessed — a hand-written list of spellings can only confirm the spellings
 * you thought of, which is the narrowing this repo keeps paying for):
 *
 *     1511 distinct tags, 7087 tag occurrences, 13 separator-only collision groups.
 *     needs-operator=11 / needs:operator=6  ·  phase-3=68 / phase:3=2  ·  CN1=6 / cn1=21  · …
 *
 * `needs-operator` was the reported case and NOT the worst one. `phase-N`/`phase:N` is five
 * groups and it breaks a SHIPPED FILTER: task_list's `phase` parameter matches only
 * `phase-<n>` (handlers/tasks.ts builds `phase-${phase}`), so 16 tasks carrying `phase:N`
 * are invisible to it. Verified against live prod: `task_list phase:"5"` returns 0 while a
 * task tagged `phase:5` exists. Zero reads as "no such phase" — the dangerous direction.
 *
 * WHAT IS ASSERTED HERE is the structural rule, not our vocabulary. The tests below use
 * our real tags because they are the measured case, but every assertion holds for a
 * spelling nobody has invented — which is the point, and which the THIRD-SPELLING test
 * exists to prove.
 */

import { describe, it, expect } from 'vitest';
import {
  findWriteTimeTagClashes,
  renderTagSpellingClash,
} from '../services/tagSpellingWriteCheck.js';

/** The measured live population, abbreviated. Counts are the real ones. */
const LIVE = [
  { tag: 'needs-operator', count: 11 },
  { tag: 'needs:operator', count: 6 },
  { tag: 'needs-coordinator', count: 4 },
  { tag: 'phase-3', count: 68 },
  { tag: 'phase:3', count: 2 },
  { tag: 'fleet', count: 15 },
];

describe('write-time tag spelling collisions', () => {
  it('names the measured needs-operator / needs:operator collision and suggests the majority spelling', () => {
    const clashes = findWriteTimeTagClashes(['needs:operator'], LIVE);
    expect(clashes).toHaveLength(1);
    expect(clashes[0].written).toBe('needs:operator');
    expect(clashes[0].suggested).toBe('needs-operator');
    expect(clashes[0].existing.map(e => e.tag)).toEqual(['needs-operator']);
  });

  it('CATCHES A THIRD SPELLING NOBODY HAS INVENTED — the class, not the two cases', () => {
    // This is the mutation probe for the guard's whole reason to exist. A synonym table
    // would return nothing here, because nobody has ever written `needs_operator`.
    for (const invented of ['needs_operator', 'NEEDS:OPERATOR', 'Needs Operator', 'needs--operator', 'needs::operator']) {
      const clashes = findWriteTimeTagClashes([invented], LIVE);
      expect(clashes, `${invented} should collide`).toHaveLength(1);
      expect(clashes[0].suggested).toBe('needs-operator');
    }
  });

  it('catches the phase family, which breaks the shipped task_list `phase` filter', () => {
    const clashes = findWriteTimeTagClashes(['phase:3'], LIVE);
    expect(clashes[0].suggested).toBe('phase-3');
  });

  it('does NOT fire on two genuinely different concepts', () => {
    // needs-operator vs needs-coordinator differ in a WORD, not a separator. A guard that flagged
    // these would be deleted the first week for crying wolf, and then it protects nothing.
    expect(findWriteTimeTagClashes(['needs-coordinator'], LIVE)).toEqual([]);
    expect(findWriteTimeTagClashes(['fleet'], LIVE)).toEqual([]);
  });

  it('does NOT fire on the tag re-applying ITSELF', () => {
    // Every task_update replays the existing tag set. If a tag clashed with itself, every
    // update on every already-tagged task would warn, and the signal would be worthless.
    expect(findWriteTimeTagClashes(['needs-operator'], LIVE)).toEqual([]);
  });

  it('the EMPTY, ABSENT and WHITESPACE populations — the values that slip through', () => {
    expect(findWriteTimeTagClashes([], LIVE)).toEqual([]);
    expect(findWriteTimeTagClashes(['needs:operator'], [])).toEqual([]);
    // A whitespace-only tag folds to nothing and is not a concept, so it must not be
    // reported as colliding with every other whitespace-only tag in the project.
    expect(findWriteTimeTagClashes(['   '], [{ tag: '  ', count: 2 }, ...LIVE])).toEqual([]);
    // A separator-only tag folds to the separator itself; it must not match arbitrary tags.
    expect(findWriteTimeTagClashes(['needs:operator'], [{ tag: 'needs:operator', count: 6 }])).toEqual([]);
  });

  it('suggests the MOST-USED spelling, not the first row Postgres happened to return', () => {
    const clashes = findWriteTimeTagClashes(['cn-1'], [
      { tag: 'cn:1', count: 6 },
      { tag: 'cn_1', count: 21 },
      { tag: 'CN 1', count: 1 },
    ]);
    expect(clashes[0].suggested).toBe('cn_1');
    // Deterministic ordering: most-used first, then alphabetical. A byte-comparing reader
    // must not see a different order between two runs against the same data.
    expect(clashes[0].existing.map(e => e.tag)).toEqual(['cn_1', 'cn:1', 'CN 1']);
  });

  it('the warning ACCEPTS the write, states nothing changed, and names the canonical form', () => {
    // The `invalid-scope:` contract: accepted, stored verbatim, named, remedied. A message
    // that only said "these collide" would leave the caller with no action to take.
    const [clash] = findWriteTimeTagClashes(['needs:operator'], LIVE);
    const msg = renderTagSpellingClash(clash);
    expect(msg).toContain('needs:operator');
    expect(msg).toContain('needs-operator');
    expect(msg).toContain('11 records');
    expect(msg).toMatch(/Nothing was rejected, dropped or rewritten/);
    expect(msg).toMatch(/stored as you wrote it/);
  });

  it('N1 — ONE WRITE carrying BOTH spellings of a BRAND-NEW concept is caught', () => {
    // Reviewer N1. Measured on the first version: findWriteTimeTagClashes(['foo-x','foo:x'], [])
    // returned [] — neither spelling was stored yet, so each was compared against a
    // population containing neither and the write that CREATED the split was silent. This is
    // the cheapest case to catch: nothing has been split yet, the split is in the request.
    const clashes = findWriteTimeTagClashes(['foo-x', 'foo:x'], []);
    expect(clashes).toHaveLength(1);
    // Reported ONCE, on the non-dominant spelling. With no usage history the two tie at one
    // occurrence each and `byUse` breaks the tie alphabetically — deterministic, and honest,
    // because there is no evidence for preferring either.
    expect(clashes[0].written).toBe('foo:x');
    expect(clashes[0].suggested).toBe('foo-x');
    expect(renderTagSpellingClash(clashes[0])).toContain('foo-x');
  });

  it('N1 — a NEW spelling never outweighs a STORED one, and a re-tag never demotes it', () => {
    // The write's tags count as ONE occurrence, so a brand-new variant stays strictly below
    // any stored spelling and the suggestion still points at what the project uses.
    const clashes = findWriteTimeTagClashes(['needs_operator'], LIVE);
    expect(clashes[0].suggested).toBe('needs-operator');
    // And a tag that is BOTH stored and being re-written keeps its real weight — otherwise
    // re-tagging the dominant spelling would demote it to 1 and flip the suggestion.
    expect(findWriteTimeTagClashes(['needs-operator'], LIVE)).toEqual([]);
  });

  it('reports EVERY colliding tag on one write, deduplicated', () => {
    const clashes = findWriteTimeTagClashes(['needs:operator', 'phase:3', 'needs:operator', 'fleet'], LIVE);
    expect(clashes.map(c => c.written)).toEqual(['needs:operator', 'phase:3']);
  });
});
