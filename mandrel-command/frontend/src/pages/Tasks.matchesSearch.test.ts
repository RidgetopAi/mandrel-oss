/**
 * Tasks search box — id matching
 *
 * The Tasks third of the id-search class-fix. Operator pasted an id8 into the Tasks search
 * box and got nothing: the haystack was title+description+assigned_to+tags, so the one
 * handle every Mandrel tool, link and handoff uses to refer to a task — its id — was the
 * one thing you could not search by.
 *
 * Tasks search is CLIENT-side over the already-fetched page and never reaches the server,
 * so the core MCP fix (context.ts / decisions.ts) cannot reach it. Hence a separate, much
 * simpler edit — and this test, which pins the behaviour directly on the exported pure
 * helper rather than through a page render (no DOM, no fetch: the logic under test IS the
 * predicate).
 *
 * NOTE ON THE CLASS: three search bars, three architectures (contexts = server-side
 * semantic, decisions = server-side semantic, tasks = client-side substring) is itself
 * drift. SURFACED, deliberately not refactored here (see the task record).
 */

import { describe, test, expect } from 'vitest';

import { matchesSearch } from './Tasks';
import type { Task } from '../types/task';

const TASK_ID = '709aca13-44db-4cb9-92ec-054dc1798544';
const OTHER_ID = 'f29bbd44-1111-2222-3333-444455556666';

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    project_id: 'proj-1',
    title: 'Port the buildSearchMatchPredicate class-fix',
    description: 'Contexts + Tasks id search',
    type: 'bug',
    status: 'todo',
    priority: 'high',
    assigned_to: 'builder',
    tags: ['repo:mandrel', 'search'],
    created_at: '2026-07-17T04:09:43.623Z',
    updated_at: '2026-07-17T04:09:43.623Z',
    ...over,
  } as Task;
}

describe('Tasks matchesSearch — id lookup', () => {
  // ── The fix ────────────────────────────────────────────────────────────────
  test('an id8 typed in the search box finds the task (the reported bug)', () => {
    // PRE-FIX: false — `id` was not in the haystack.
    expect(matchesSearch(makeTask(), '709aca13')).toBe(true);
  });

  test('a FULL uuid finds the task', () => {
    expect(matchesSearch(makeTask(), TASK_ID)).toBe(true);
  });

  test('a dashed PARTIAL uuid (a pasted prefix) finds the task', () => {
    expect(matchesSearch(makeTask(), '709aca13-44db')).toBe(true);
  });

  test('id matching is case-insensitive (an UPPER-CASE id8 still matches)', () => {
    expect(matchesSearch(makeTask(), '709ACA13')).toBe(true);
  });

  test("a DIFFERENT task's id does not match", () => {
    expect(matchesSearch(makeTask(), OTHER_ID.slice(0, 8))).toBe(false);
  });

  test('a task with no id is not matched by an id query (and does not throw)', () => {
    expect(matchesSearch(makeTask({ id: undefined as unknown as string }), '709aca13')).toBe(false);
  });

  // ── No regression: every pre-existing haystack field still matches ──────────
  test('no-regression: title, description, assigned_to and tags all still match', () => {
    const t = makeTask();
    expect(matchesSearch(t, 'buildSearchMatchPredicate')).toBe(true); // title
    expect(matchesSearch(t, 'id search')).toBe(true);                 // description
    expect(matchesSearch(t, 'builder')).toBe(true);                   // assigned_to
    expect(matchesSearch(t, 'repo:mandrel')).toBe(true);           // tags
  });

  test('no-regression: an empty query matches everything (the unfiltered list)', () => {
    expect(matchesSearch(makeTask(), '')).toBe(true);
  });

  test('no-regression: a query matching nothing still returns false', () => {
    expect(matchesSearch(makeTask(), 'zzqqnotpresent')).toBe(false);
  });

  test('no-regression: matching stays case-insensitive on prose', () => {
    expect(matchesSearch(makeTask(), 'PORT THE')).toBe(true);
  });

  test('no-regression: missing optional fields do not throw', () => {
    const sparse = makeTask({
      description: undefined,
      assigned_to: undefined,
      tags: undefined,
    });
    expect(matchesSearch(sparse, 'Port the')).toBe(true);
    expect(matchesSearch(sparse, '709aca13')).toBe(true);
  });
});

/**
 * WORD-PREFIX MATCHING — the same class already fixed on Sessions.
 *
 * The old predicate joined every field into one string and asked `includes()`. Each test
 * in this block is a query that the OLD implementation returned `true` for and the current
 * one returns `false` for; each comment records the specific fragment the old haystack
 * matched on. They are the mutation evidence: restore the bare-substring predicate and
 * every assertion in this block goes red.
 */
describe('Tasks matchesSearch — word-prefix, fields kept separate', () => {
  const midWord = makeTask({
    title: 'Rebuild the board',
    description: 'A building block',
    assigned_to: 'builder',
    tags: ['kanban'],
  });

  test('a term must START a word — it does not match the middle of one', () => {
    // OLD: true. 'ui' sits inside 'building' (b-U-I-l-d) in the joined haystack.
    expect(matchesSearch(midWord, 'ui')).toBe(false);
    // …and it still matches the standalone word, so this is narrowing, not deletion.
    expect(matchesSearch(midWord, 'UI')).toBe(false);
    expect(matchesSearch(makeTask({ title: 'UI polish' }), 'ui')).toBe(true);
  });

  test('a term does not match a suffix fragment of a word', () => {
    // OLD: true. 'oard' is the tail of 'board'.
    expect(matchesSearch(midWord, 'oard')).toBe(false);
    expect(matchesSearch(midWord, 'boar')).toBe(true);
  });

  test('a query cannot match across the seam between two fields', () => {
    // OLD: true. The joined haystack read '…rebuild the board a building block…', so
    // 'rd a' spanned the title/description seam (the tail of 'board' plus the head of
    // 'A building'). No single field contains that run.
    expect(matchesSearch(midWord, 'rd a')).toBe(false);
  });

  test('a query cannot match across the seam between two tags', () => {
    const t = makeTask({ title: 'x', description: '', assigned_to: '', tags: ['alpha', 'beta'] });
    // OLD: true. tags joined to 'alpha beta', so 'ha be' spanned the tag boundary.
    expect(matchesSearch(t, 'ha be')).toBe(false);
    expect(matchesSearch(t, 'alpha beta')).toBe(true);
  });

  test('a term cannot start mid-segment of the id (the id trade-off, stated)', () => {
    // OLD: true — '9aca13' is inside the first UUID segment. The word-prefix rule gives
    // this up on purpose; the forms people actually paste are covered above.
    expect(matchesSearch(makeTask(), '9aca13')).toBe(false);
  });

  test('terms may land in DIFFERENT fields (AND across the row, not a phrase)', () => {
    // Order and adjacency carry no meaning: 'builder' is the assignee, 'board' the title.
    expect(matchesSearch(midWord, 'builder board')).toBe(true);
    expect(matchesSearch(midWord, 'board builder')).toBe(true);
    // But every term must land somewhere.
    expect(matchesSearch(midWord, 'board nosuchterm')).toBe(false);
  });

  test('a whitespace-only query is treated as empty (matches everything)', () => {
    expect(matchesSearch(midWord, '   ')).toBe(true);
    expect(matchesSearch(midWord, '-')).toBe(true);
  });

  test('a task with NO searchable content anywhere is not matched by a real query', () => {
    const bare = {
      id: undefined,
      title: undefined,
      description: undefined,
      assigned_to: undefined,
      tags: [],
    } as unknown as Task;
    expect(matchesSearch(bare, 'anything')).toBe(false);
    // …and an empty query still matches it (the unfiltered list must show every row).
    expect(matchesSearch(bare, '')).toBe(true);
  });
});
