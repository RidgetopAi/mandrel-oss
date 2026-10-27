/**
 * "WAITING ON A HUMAN" — the briefing section that selects by `WHERE`, not by convention.
 * P5.5 (SCOPE §2 P5.5, §3.3, §3.4, §8.6).
 *
 * ═══ THE DEFECT ═══
 * Our own boot package's most valuable section for a human operator selected tasks BY TAG,
 * from a four-tag vocabulary we invented. `grep -rn "blocked_on" mcp-server/src` at ea77f00
 * returned nothing: there was NO SERVER CONCEPT of "a person has to act next". And our
 * vocabulary is itself broken — `needs-operator` and `needs:operator` are one concept spelled two
 * ways, both live, so a consumer that picks one spelling sees a fraction of the truth.
 *
 * Migration 093 makes it a COLUMN. This module selects on that column, degrades honestly
 * when the column is not there, and reports the spelling defect rather than papering it.
 *
 * ═══ THE FOUR THINGS THIS MODULE REFUSES TO CONFLATE ═══
 * 1. `blocked_on='human'` (a fact the author stated) vs `status='blocked'` (a different
 *    question entirely — measured on the authors' own project: 1 of 13 blocked tasks was
 *    actually waiting on a human).
 * 2. The column being ABSENT (pre-093 database) vs UNKNOWN (the probe could not measure) vs
 *    PRESENT-BUT-UNPOPULATED (093 has run, nobody has set a value yet). Three different
 *    remedies, three different sentences, three different `source` values.
 * 3. A `due_at` DEADLINE (authoritative, and it SORTS) vs a date found in PROSE (a hint,
 *    rendered `due?`, explicitly stated as possibly not a deadline at all).
 * 4. Reporting the tag-spelling collision vs SILENTLY NORMALISING it. Surfacing is the
 *    feature; normalising would hide the defect one layer down and leave the stored rows
 *    still split.
 *
 * PURITY SPLIT, matching projectBriefing.ts: `gatherWaitingOnHuman` does the queries;
 * everything a test wants to attack directly (the prose-date scan, the collision fold, the
 * sort) is a pure exported function over plain data.
 */

import type { Pool } from 'pg';
import {
  BLOCKED_ON_HUMAN,
  READ_WAITING_MAX_RECORDS,
  READ_WAITING_FALLBACK_STATUSES,
  READ_TAG_COLLISION_FINDING_ENABLED,
  READ_TAG_COLLISION_MAX_GROUPS,
  tagSpellingKey,
  WAITING_DUE_HINT_RE,
} from '../config/blockedOnConfig.js';
import {
  readTaskBlockedOnCapability,
  type TaskBlockedOnCapability,
} from './taskBlockedOnCapability.js';

// ─────────────────────────────────────────────────────────────────────────────
// Data shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOW THE SECTION SELECTED — carried as a FIELD, because the four cases have four
 * different remedies and a reader who cannot tell them apart cannot act on any of them.
 */
export type WaitingSource =
  /** `WHERE blocked_on = 'human'`. The exact answer. No convention, no guessing. */
  | 'column'
  /** 093 has run and the column is populated, but nothing is waiting on a human. A REAL zero. */
  | 'column-empty'
  /** 093 has run and NOTHING anywhere carries a blocked_on value → the interim fallback. */
  | 'fallback-unpopulated'
  /** The columns are not in this database (pre-093) → the interim fallback. */
  | 'fallback-absent-column'
  /** The probe could not measure → the interim fallback. NOT the same as absent. */
  | 'fallback-unknown-column';

export interface WaitingTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  createdAt: Date;
  /** The column value, or null when unset / the column is not there. Never inferred. */
  blockedOn: string | null;
  /** THE DEADLINE — the structured `due_at` column. Authoritative. It sorts. */
  dueAt: Date | null;
  /**
   * THE HINT — an ISO date found in this task's own title/description. NOT a deadline
   * field, does not sort, and may not be a deadline at all. Rendered `due?`.
   */
  dueHint: string | null;
}

/** One group of tags that are the same concept spelled different ways. */
export interface TagSpellingCollision {
  /** The separator-folded key the spellings share (e.g. `needs-operator`). */
  key: string;
  /** The distinct RAW spellings actually stored, sorted for a deterministic render. */
  spellings: string[];
}

export interface WaitingFindings {
  /** Groups reported, capped by config. */
  collisions: TagSpellingCollision[];
  /** How many groups exist in total — so a capped list never reads as the whole truth. */
  collisionGroupsTotal: number;
  /**
   * WHICH TAGS WERE SCANNED, named rather than implied (CLASSES.md C3: state the
   * population your check enumerates). Null when the finding is switched off.
   */
  scannedPopulation: string | null;
}

/**
 * How precise the interim fallback is ON THIS READER'S OWN DATA — computed, not borrowed.
 * Null when it cannot be computed, which is exactly the case where the column is absent or
 * unknown (you cannot count `blocked_on='human'` in a database that has no such column).
 */
export interface WaitingFallbackPrecision {
  /** Rows the fallback predicate (`status='blocked'`) would return. */
  fallbackPopulation: number;
  /** How many of THOSE actually carry `blocked_on='human'`. */
  trulyHuman: number;
}

export interface BriefingWaiting {
  source: WaitingSource;
  /** Column presence, three-state, straight from the probe. Never collapsed to a boolean. */
  capability: TaskBlockedOnCapability;
  items: WaitingTask[];
  /** The query's population before any render budget — the section's own census input. */
  fetched: number;
  /** True iff the fetch stopped at the configured bound (population is then a FLOOR). */
  fetchBoundReached: boolean;
  /** The reader's OWN fallback precision, or null when it could not be computed. */
  precision: WaitingFallbackPrecision | null;
  findings: WaitingFindings;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — the parts a test attacks directly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The FIRST ISO calendar date in a task's own prose, or null.
 *
 * Scans title then description, in that order, so a title date wins — a title is the field
 * an author writes deliberately. What this MATCHES is `YYYY-MM-DD` and nothing else; see
 * WAITING_DUE_HINT_RE for why the narrowness is the design rather than a limitation, and
 * note the render states it in-band so the narrowness is not a secret.
 */
export function extractDueHint(title: string, description: string | null): string | null {
  for (const field of [title, description ?? '']) {
    const m = WAITING_DUE_HINT_RE.exec(field);
    if (m) return m[1];
  }
  return null;
}

/**
 * FOLD A TAG TO ITS SPELLING KEY: lowercase, then collapse every run of separator
 * characters to one. `needs-operator`, `needs:operator`, `needs_operator`, `Needs  Operator` → the same
 * key. `needs-operator` and `needs-coordinator` stay different.
 *
 * NOTE WHAT THIS IS NOT: it is not a normaliser the write path applies. Nothing calls it on
 * a stored value. It exists only to GROUP spellings so the difference can be REPORTED.
 */
// MOVED to config/blockedOnConfig.ts and re-exported here so every
// existing importer keeps working. It had to move because it is now used at the WRITE
// boundary too, and this module imports the database config transitively — a pure fold
// that drags a live pool into every consumer cannot be unit-tested without provisioning
// one, and a rule that is hard to test gets a second, divergent copy written instead.
// One definition, two importers. See TAG_COLLISION_NORMALIZE_RE for the rule itself.
export { tagSpellingKey };

/**
 * Group a project's distinct tags into the ones that are ONE CONCEPT SPELLED SEVERAL WAYS.
 *
 * Returns only groups with ≥2 distinct raw spellings — a tag spelled one way is not a
 * finding. Sorted by (group size DESC, key ASC) so the worst offender leads and the output
 * is deterministic for a byte-comparing test.
 */
export function findTagSpellingCollisions(tags: readonly string[]): TagSpellingCollision[] {
  const byKey = new Map<string, Set<string>>();
  for (const tag of tags) {
    const key = tagSpellingKey(tag);
    if (key === '') continue; // a whitespace-only tag folds to nothing and is not a concept
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(tag);
  }
  const out: TagSpellingCollision[] = [];
  for (const [key, spellings] of byKey) {
    if (spellings.size < 2) continue;
    out.push({ key, spellings: [...spellings].sort() });
  }
  out.sort((a, b) => b.spellings.length - a.spellings.length || a.key.localeCompare(b.key));
  return out;
}

/**
 * THE SORT — the structured deadline is the ONLY thing that orders this section.
 *
 * `due_at` ascending (soonest first); rows with no `due_at` follow, newest-created first.
 * A prose HINT deliberately does NOT participate: sorting by a date that might be a
 * filename would let a hint quietly acquire the authority the render spends two lines
 * denying it. That is the whole two-tier rule, expressed as code rather than as a comment.
 */
export function sortWaitingTasks(items: readonly WaitingTask[]): WaitingTask[] {
  return [...items].sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime() || cmpId(a, b);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return b.createdAt.getTime() - a.createdAt.getTime() || cmpId(a, b);
  });
}

/** Total order tiebreak — two rows with the same instant must still sort deterministically. */
function cmpId(a: WaitingTask, b: WaitingTask): number {
  return a.id.localeCompare(b.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// GATHER — the queries
// ─────────────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: Date;
  blocked_on?: string | null;
  due_at?: Date | null;
}

function toWaitingTask(r: TaskRow): WaitingTask {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    createdAt: r.created_at,
    // `?? null` and NOT `r.blocked_on ?? null` on a column that was never selected: an
    // absent key and a NULL value both land on null here, which is correct — in both cases
    // the row carries no such claim. The DIFFERENCE between "the column is missing" and
    // "the value is unset" is reported by `capability`/`source` at the section level, where
    // it belongs; putting it on every row would say it 25 times.
    blockedOn: r.blocked_on ?? null,
    dueAt: r.due_at ?? null,
    dueHint: extractDueHint(r.title, r.description),
  };
}

/**
 * Gather the "Waiting on a human" section for one project.
 *
 * NEVER THROWS ON A MISSING COLUMN — that is the entire point (SCOPE §8.6). The capability
 * probe decides which SQL is even built, so a pre-093 database never sees `blocked_on` in a
 * statement at all.
 *
 * @param openTaskStatuses the briefing's own open-task vocabulary, passed in rather than
 *   re-declared here: "which statuses are live work" is one question with one existing
 *   answer (config/briefingConfig.ts), and a second copy is a second thing to drift.
 */
export async function gatherWaitingOnHuman(
  projectId: string,
  openTaskStatuses: readonly string[],
  pool: Pool,
): Promise<BriefingWaiting> {
  const capability = await readTaskBlockedOnCapability(pool);
  const max = READ_WAITING_MAX_RECORDS();
  const fallbackStatuses = READ_WAITING_FALLBACK_STATUSES();
  const findings = await gatherTagFindings(projectId, pool);

  // ── THE COLUMN PATH ────────────────────────────────────────────────────────────────
  if (capability.blockedOn === 'present') {
    // `due_at` is asked for INDEPENDENTLY. The two columns arrive in one migration, so in
    // practice they are present together — but the probe reports them separately and this
    // path honors that rather than inferring one from the other. Inferring would be the
    // cheaper code and a claim the instrument did not make.
    const dueCol = capability.dueAt === 'present' ? ', due_at' : '';
    const rows: TaskRow[] = (
      await pool.query(
        `SELECT id, title, description, status, priority, created_at, blocked_on${dueCol}
           FROM tasks
          WHERE project_id = $1 AND archived_at IS NULL
            AND status = ANY($2)
            AND blocked_on = $3
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [projectId, openTaskStatuses as string[], BLOCKED_ON_HUMAN, max],
      )
    ).rows;

    if (rows.length > 0) {
      // No precision measurement on this path: the section is selecting EXACTLY, so how
      // well a fallback would have approximated it is a number nothing renders. A query
      // whose result nobody reads is cost, not rigor.
      return {
        source: 'column',
        capability,
        items: sortWaitingTasks(rows.map(toWaitingTask)),
        fetched: rows.length,
        fetchBoundReached: rows.length === max,
        precision: null,
        findings,
      };
    }

    // ZERO ROWS IS TWO DIFFERENT FACTS (CLASSES.md C1's third state, at the data layer):
    //   • the column is populated and genuinely nothing is waiting on a human → a REAL
    //     zero, and `none` is then an honest affirmative claim;
    //   • NOTHING in this project carries a blocked_on value at all → the question was
    //     never answered by anyone, and rendering `none` would manufacture "there is no
    //     waiting work" out of "nobody has told us".
    // These must not share a branch, so they are separated by a COUNT rather than assumed.
    const populated: number = (
      await pool.query(
        `SELECT count(*)::int AS n
           FROM tasks
          WHERE project_id = $1 AND archived_at IS NULL AND blocked_on IS NOT NULL`,
        [projectId],
      )
    ).rows[0].n;

    if (populated > 0) {
      return {
        source: 'column-empty',
        capability,
        items: [],
        fetched: 0,
        fetchBoundReached: false,
        precision: null,
        findings,
      };
    }
    // THE ONLY PATH THAT RENDERS A PRECISION NUMBER: 093 has run, so `blocked_on` is
    // countable, and the section is about to serve the low-precision fallback anyway. The
    // reader's OWN number replaces the authors' borrowed one (CLASSES.md C2).
    return fallback(
      'fallback-unpopulated',
      capability,
      await measureFallbackPrecision(projectId, openTaskStatuses, fallbackStatuses, pool),
    );
  }

  // ── THE FALLBACK PATHS ─────────────────────────────────────────────────────────────
  // `absent` and `unknown` get DIFFERENT source values and therefore different rendered
  // sentences: "this database has not had migration 093 applied" and "we could not
  // determine whether it has" send a reader to two different remedies.
  return fallback(
    capability.blockedOn === 'absent' ? 'fallback-absent-column' : 'fallback-unknown-column',
    capability,
    null,
  );

  async function fallback(
    source: WaitingSource,
    cap: TaskBlockedOnCapability,
    precision: WaitingFallbackPrecision | null,
  ): Promise<BriefingWaiting> {
    // NO `blocked_on` AND NO `due_at` IN THIS STATEMENT. On the absent/unknown paths those
    // identifiers must not reach Postgres at all — a probe that decided which SQL to build
    // and then built SQL naming the column anyway would be theatre.
    const rows: TaskRow[] = (
      await pool.query(
        `SELECT id, title, description, status, priority, created_at
           FROM tasks
          WHERE project_id = $1 AND archived_at IS NULL
            AND status = ANY($2)
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [projectId, fallbackStatuses as string[], max],
      )
    ).rows;
    return {
      source,
      capability: cap,
      items: sortWaitingTasks(rows.map(toWaitingTask)),
      fetched: rows.length,
      fetchBoundReached: rows.length === max,
      precision,
      findings,
    };
  }
}

/**
 * How well `status='blocked'` approximates `blocked_on='human'` FOR THIS READER. One query,
 * two counts, no borrowed numbers.
 */
async function measureFallbackPrecision(
  projectId: string,
  openTaskStatuses: readonly string[],
  fallbackStatuses: readonly string[],
  pool: Pool,
): Promise<WaitingFallbackPrecision> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS fallback_population,
            count(*) FILTER (WHERE blocked_on = $4)::int AS truly_human
       FROM tasks
      WHERE project_id = $1 AND archived_at IS NULL
        AND status = ANY($2) AND status = ANY($3)`,
    [projectId, openTaskStatuses as string[], fallbackStatuses as string[], BLOCKED_ON_HUMAN],
  );
  return {
    fallbackPopulation: rows[0].fallback_population,
    trulyHuman: rows[0].truly_human,
  };
}

/**
 * THE DATA-QUALITY FINDING. Scans the DISTINCT tags on this project's tasks and decisions —
 * the two write paths that, until P5.5 folded SCOPE §3.3 in, stored tags completely
 * unvalidated and unwarned, which is why a project accumulates two spellings of one concept
 * in the first place. Contexts are excluded: that path has validated at the write boundary
 * since tool-native linking shipped, and it is another Builder's file this round.
 */
async function gatherTagFindings(projectId: string, pool: Pool): Promise<WaitingFindings> {
  if (!READ_TAG_COLLISION_FINDING_ENABLED()) {
    return { collisions: [], collisionGroupsTotal: 0, scannedPopulation: null };
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT tag FROM (
        SELECT unnest(tags) AS tag FROM tasks
         WHERE project_id = $1 AND archived_at IS NULL
        UNION ALL
        SELECT unnest(tags) AS tag FROM technical_decisions
         WHERE project_id = $1 AND archived_at IS NULL
     ) t`,
    [projectId],
  );
  const all = findTagSpellingCollisions(rows.map((r: { tag: string }) => r.tag));
  return {
    collisions: all.slice(0, READ_TAG_COLLISION_MAX_GROUPS()),
    collisionGroupsTotal: all.length,
    scannedPopulation: 'the DISTINCT tags on this project\'s live tasks and decisions',
  };
}
