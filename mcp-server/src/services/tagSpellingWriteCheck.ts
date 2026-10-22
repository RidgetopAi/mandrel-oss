/**
 * WRITE-TIME TAG SPELLING COLLISION CHECK.
 *
 * THE DEFECT. `needs-operator` and `needs:operator` are ONE concept with two live spellings, so
 * any consumer that filters on one silently sees a FRACTION of the queue and cannot tell:
 * the missing items look exactly like items that do not exist. Nothing anywhere knew. The
 * project_briefing finding (services/waitingOnHuman.ts) reports collisions that already
 * exist; this is the half that stops the next one being created silently.
 *
 * IT IS THE `invalid-scope:` CONTRACT, NOT A NEW ONE. That path is the same class handled
 * correctly and it is the shape this copies: the write SUCCEEDS, the tag is stored EXACTLY
 * as written, the problem is NAMED in the response, and the caller is told the form to use.
 * Nothing is rejected, nothing is dropped, nothing is silently normalised.
 *
 * ⚠️ IT DOES NOT NORMALISE, DELIBERATELY. Folding the spellings together at the write
 * boundary would hide the defect one layer down and leave every row already stored still
 * split — and it would silently rewrite a customer's tag, which is a different and worse
 * failure than the one being fixed. Surfacing IS the feature.
 *
 * ═══ WHY IT CARRIES NO VOCABULARY ════════════════════════════════════════════════════
 * The naive fix is a synonym table. That would put our own person's name in the product,
 * and — worse — it could only ever catch the spellings we already knew about, which is the
 * definition of a guard that has not fixed the class. So the rule is STRUCTURAL: two tags
 * collide when they differ ONLY in separators and case. `needs-operator`, `needs:operator`,
 * `needs_operator` and `Needs the operator` fold to one key; `needs-operator` and `needs-coordinator` do not.
 * A spelling nobody has invented yet is caught on the day it is invented.
 *
 * The SUGGESTED spelling is the one THIS PROJECT already uses most. That is a fact about
 * the caller's own data, not a house preference, so it works on a customer's tag set on day
 * one with no convention to adopt.
 *
 * ═══ THE POPULATION THIS GUARD ENUMERATES, AND WHY IT IS THE WHOLE ONE ═══════════════
 * The DISTINCT tags on the project's live (non-archived) tasks and decisions, PLUS THE TAGS
 * ON THE WRITE ITSELF.
 *
 * Those two write paths are the ones that stored tags unvalidated and unwarned, which is how
 * a project accumulates two spellings of one concept. Contexts are excluded because that
 * path has validated at its boundary since tool-native linking shipped. Archived rows are
 * excluded because a spelling nobody can reach is not a live collision — a deliberate
 * narrowing, stated here rather than left for a reader to discover.
 *
 * THE WRITE'S OWN TAGS WERE MISSING FROM THAT POPULATION AND IT WAS A REAL HOLE (the reviewer
 * N1). Measured: `findWriteTimeTagClashes(['foo-x','foo:x'], [])` returned `[]` — a single
 * write introducing BOTH spellings of a brand-new concept was silent, because neither
 * spelling existed in the project yet and each was only ever compared against the stored
 * rows. That is the CHEAPEST case to catch and the only one where nothing has been split
 * yet: the split is being created in the request you are holding. The header claimed a
 * spelling is "caught on the day it is invented", which was true only for a variant of an
 * ALREADY-STORED tag. Both are now caught, and the claim is true as written.
 *
 * Self-collision within one write is reported ONCE, on the non-dominant spelling, by the
 * same dominance rule used against stored tags — see the `dominant.tag === tag` clause.
 */

import type { Pool } from 'pg';
import {
  READ_TAG_COLLISION_WRITE_WARNING_ENABLED,
  READ_TAG_COLLISION_WRITE_MAX_WARNINGS,
  READ_TAG_COLLISION_WRITE_MAX_EXISTING,
  tagSpellingKey,
} from '../config/blockedOnConfig.js';

/** One incoming tag that collides with a spelling this project already uses. */
export interface TagSpellingClash {
  /** The tag exactly as the caller wrote it. Stored unchanged. */
  written: string;
  /** Existing spellings of the same concept, most-used first. */
  existing: { tag: string; count: number }[];
  /** The spelling this project already uses most. A fact about the data, not a preference. */
  suggested: string;
}

/**
 * The pure core: given what was written and what the project already has, find the
 * collisions. Exported so the guard can be driven with hand-built populations — including
 * the empty and single-member ones, which are the values that slip through.
 *
 * A tag does NOT clash with itself: only a DIFFERENT raw spelling under the same fold is a
 * finding, or every write would warn about the tag it is re-applying.
 */
export function findWriteTimeTagClashes(
  written: readonly string[],
  existing: readonly { tag: string; count: number }[],
): TagSpellingClash[] {
  // THE COMPARISON POPULATION IS THE STORED TAGS *PLUS THIS WRITE'S OWN* (the reviewer N1).
  // A tag the caller is writing right now is not yet in `existing`, so a write carrying two
  // spellings of a brand-new concept compared each of them against a population that
  // contained neither, and said nothing.
  //
  // A tag on the write counts as ONE occurrence. That is not a cosmetic choice: it keeps a
  // brand-new spelling strictly below any stored spelling of the same concept, so the
  // dominance rule still points the caller at what the project already uses rather than at
  // the tag they just typed. When BOTH spellings are new they tie at 1, and the tie is
  // broken alphabetically by `byUse` — deterministic, and honest, because with no usage
  // history there is no evidence for preferring either. The warning still names both.
  const population = new Map<string, { tag: string; count: number }>();
  for (const e of existing) {
    if (tagSpellingKey(e.tag) === '') continue;
    population.set(e.tag, { tag: e.tag, count: e.count });
  }
  for (const raw of written) {
    const tag = raw.trim();
    if (tag === '' || tagSpellingKey(tag) === '') continue;
    // Never overwrite a stored count with 1 — a tag that is BOTH stored and being
    // re-written keeps its real weight, or re-tagging would demote the dominant spelling.
    if (!population.has(tag)) population.set(tag, { tag, count: 1 });
  }

  const byKey = new Map<string, { tag: string; count: number }[]>();
  for (const e of population.values()) {
    const key = tagSpellingKey(e.tag);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(e);
  }

  const out: TagSpellingClash[] = [];
  const seen = new Set<string>();
  for (const raw of written) {
    const tag = raw.trim();
    if (tag === '') continue;
    const key = tagSpellingKey(tag);
    if (key === '' || seen.has(tag)) continue;
    const group = byKey.get(key) ?? [];
    const others = group.filter(e => e.tag !== tag);
    if (others.length === 0) continue;

    // Most-used first, then alphabetical so the output is deterministic for a
    // byte-comparing test. Ties must not depend on row order out of Postgres.
    const byUse = (a: { tag: string; count: number }, b: { tag: string; count: number }) =>
      b.count - a.count || a.tag.localeCompare(b.tag);
    const dominant = [...group].sort(byUse)[0];

    // ⚠️ ONLY WARN THE CALLER WHO CAN ACT. Caught by this guard's own test: without this
    // clause, writing `needs-operator` — the spelling 11 of 17 records already use — produced
    // a warning telling the author to re-tag to `needs:operator`, the MINORITY spelling. That
    // is worse than silence twice over: every task_update replays its tag set, so the
    // project's dominant spelling would warn on every single write, and the remedy it
    // offered pointed the wrong way and would have DEEPENED the split it was reporting.
    //
    // When the caller already used the dominant spelling there is nothing for them to
    // change — the split lives in the OTHER records, and project_briefing's read-time
    // finding is the surface that reports it. Write-time warnings must be actionable by
    // the person receiving them or they get tuned out, and a warning nobody reads is
    // indistinguishable from a warning that never fired.
    if (dominant.tag === tag) continue;

    seen.add(tag);
    const sorted = [...others].sort(byUse);
    out.push({
      written: tag,
      existing: sorted.slice(0, READ_TAG_COLLISION_WRITE_MAX_EXISTING()),
      suggested: dominant.tag,
    });
  }
  return out;
}

/** Render one clash as the caller-facing warning. Same voice as the invalid-scope warning. */
export function renderTagSpellingClash(clash: TagSpellingClash): string {
  const others = clash.existing
    .map(e => `"${e.tag}" (${e.count} record${e.count === 1 ? '' : 's'})`)
    .join(', ');
  return (
    `Tag "${clash.written}" differs only in separators/case from ${others}, which this ` +
    `project already uses. Two spellings of one concept means any consumer that filters on ` +
    `one silently sees a FRACTION — and the missing items look exactly like items that do ` +
    `not exist. Nothing was rejected, dropped or rewritten: your tag is stored as you wrote ` +
    `it. Re-tag as "${clash.suggested}" if they are the same thing.`
  );
}

/**
 * THE PROJECT'S EXISTING TAG SPELLINGS, WITH COUNTS.
 *
 * One query, and it counts rather than merely listing, because "which spelling does this
 * project already use" is the whole basis for the suggestion and a DISTINCT list cannot
 * answer it.
 */
async function existingProjectTags(
  projectId: string,
  pool: Pool,
): Promise<{ tag: string; count: number }[]> {
  const { rows } = await pool.query(
    `SELECT tag, count(*)::int AS count FROM (
        SELECT unnest(tags) AS tag FROM tasks
         WHERE project_id = $1 AND archived_at IS NULL
        UNION ALL
        SELECT unnest(tags) AS tag FROM technical_decisions
         WHERE project_id = $1 AND archived_at IS NULL
     ) t
     GROUP BY tag`,
    [projectId],
  );
  return rows.map((r: { tag: string; count: number }) => ({ tag: r.tag, count: r.count }));
}

/**
 * The write-boundary entry point. Returns caller-facing warning lines, bounded.
 *
 * NEVER THROWS, AND THAT IS A DECISION WITH A REASON. This runs inside a write that has
 * already been accepted. A data-quality observation must not be able to fail a
 * task_create — a guard that can break the operation it advises on gets disabled the first
 * time it misfires, and then it protects nothing. A query failure yields no warnings and is
 * left to the surrounding error handling; it is explicitly NOT reported as "no collisions",
 * because an empty warning list from this function means "nothing to say", and a caller
 * cannot distinguish that from "I could not look" — which is why the enabled flag exists
 * and why this returns [] rather than a verdict object.
 */
export async function tagSpellingWriteWarnings(
  tags: readonly string[] | undefined,
  projectId: string,
  pool: Pool,
): Promise<string[]> {
  if (!READ_TAG_COLLISION_WRITE_WARNING_ENABLED()) return [];
  if (!tags || tags.length === 0) return [];
  let existing: { tag: string; count: number }[];
  try {
    existing = await existingProjectTags(projectId, pool);
  } catch {
    return [];
  }
  const clashes = findWriteTimeTagClashes(tags, existing);
  const max = READ_TAG_COLLISION_WRITE_MAX_WARNINGS();
  const lines = clashes.slice(0, max).map(renderTagSpellingClash);
  if (clashes.length > max) {
    lines.push(
      `${clashes.length - max} further tag(s) on this write also collide with an existing ` +
      `spelling; project_briefing's tag-spelling finding lists them all.`,
    );
  }
  return lines;
}

/**
 * The UPDATE-path entry point, keyed on the task instead of the project.
 *
 * `task_update` does not carry a project id — the task's project is a fact about the row,
 * not about the request — so the project is resolved from the row rather than making the
 * caller supply one it does not have. A task id that resolves to nothing yields no
 * warnings: the surrounding update is about to fail on its own, and inventing a
 * data-quality complaint about a task that does not exist would be noise on top of an error.
 */
export async function tagSpellingWriteWarningsForTask(
  tags: readonly string[] | undefined,
  taskId: string,
  pool: Pool,
): Promise<string[]> {
  if (!READ_TAG_COLLISION_WRITE_WARNING_ENABLED()) return [];
  if (!tags || tags.length === 0) return [];
  try {
    const { rows } = await pool.query(
      'SELECT project_id::text AS project_id FROM tasks WHERE id = $1',
      [taskId],
    );
    if (rows.length === 0) return [];
    return await tagSpellingWriteWarnings(tags, rows[0].project_id, pool);
  } catch {
    return [];
  }
}
