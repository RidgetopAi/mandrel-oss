/**
 * ARCHIVE DISCLOSURE + TAG CENSUS registry.
 *
 * ONE source of the fact "which record tables carry a soft-delete column and a tags
 * column", read by BOTH the archive-disclosure service (which reports what a default read
 * excluded) and the tag-census service (which enumerates tag values). Two copies of that
 * fact is the drift LEXICAL_TABLES was written to avoid; this is the same move for the
 * same reason.
 *
 * === WHY DISCLOSURE RATHER THAN FLIPPING THE DEFAULT ===
 *
 * MEASURED 2026-09-04 on project `riverbend`: a default `decision_search` reports 183
 * decisions and the honest population is 612 — 429 archived rows, 70% of the table,
 * invisible. The same read on contexts is off by 61 and on tasks by 26.
 *
 * Flipping `includeArchived` to default TRUE was considered and REJECTED: it trades a
 * silent under-count for a silent over-count, and it surfaces deliberately-archived noise
 * in every board and UI that reads these ops. The caller who archived a row meant it.
 *
 * The actual defect is neither the value of the default nor the size of the hidden set: it
 * is that **the response gave the caller no way to tell the population had been narrowed
 * at all.** A number that discloses its own narrowing cannot be misread as clean, whatever
 * the default is. So the default STANDS and the narrowing becomes VISIBLE.
 *
 * === THE THREE STATES, AND WHY ZERO IS NOT ABSENCE ===
 *
 * The failure this must not reproduce is a zero that reads like a no-op. A response that
 * silently omits the block when nothing was archived is indistinguishable from a response
 * written before this feature existed, and from one where the disclosure failed to run.
 * So the block is ALWAYS present on an op that can narrow, and it carries a tri-state:
 *
 *   `excluded`      — default read, N archived rows were withheld from consideration.
 *   `none-archived` — default read, and the archived population was MEASURED at zero.
 *                     A measured zero, not a missing field.
 *   `included`      — the caller passed includeArchived:true; nothing was withheld.
 *
 * `none-archived` and `included` both carry excludedCount 0 and are NOT interchangeable:
 * the first says "the filter ran and found nothing to hide", the second says "the filter
 * did not apply". Collapsing them is precisely the bug.
 *
 * === WHAT excludedCount COUNTS, STATED NARROWLY ON PURPOSE ===
 *
 * It is the number of rows in this table, in this project, that carry `archived_at IS NOT
 * NULL` — the rows the archive predicate removed from CONSIDERATION before any other
 * filter, ranking, or limit ran.
 *
 * It is NOT "how many more results you would have received". For the aggregate ops
 * (context_stats, decision_stats, task_progress_summary, project_insights) those two
 * numbers are the same, because those ops count the whole project. For the ranked search
 * ops they are not: a search also applies a query, a similarity floor and a LIMIT, so the
 * number of archived rows that would have SURFACED is smaller and is not knowable without
 * running the search twice.
 *
 * This distinction is load-bearing and is why `scopeNote` ships next to the number rather
 * than living in a doc. A disclosure that overstated itself as "results you missed" would
 * be a new instrument that lies quietly — the same class of defect it exists to close.
 */

/** A record table that can be soft-deleted and carries tags. */
export interface DisclosableTable {
  /** The caller-facing entity word. This is the vocabulary in the rendered line. */
  readonly entity: 'context' | 'decision' | 'task';
  /** Physical table name. */
  readonly table: string;
  /** The project-scoping column. Disclosure is PER PROJECT, never per database. */
  readonly projectColumn: string;
  /** Soft-delete column. Every table in this registry has one today. */
  readonly archivedColumn: string;
  /** text[] column carrying the record's tags — the tag census reads this. */
  readonly tagsColumn: string;
  /** Plural noun for the rendered line ("429 archived decisions"). */
  readonly plural: string;
}

export const DISCLOSABLE_TABLES: readonly DisclosableTable[] = Object.freeze([
  Object.freeze({
    entity: 'context' as const,
    table: 'contexts',
    projectColumn: 'project_id',
    archivedColumn: 'archived_at',
    tagsColumn: 'tags',
    plural: 'contexts',
  }),
  Object.freeze({
    entity: 'decision' as const,
    table: 'technical_decisions',
    projectColumn: 'project_id',
    archivedColumn: 'archived_at',
    tagsColumn: 'tags',
    plural: 'decisions',
  }),
  Object.freeze({
    entity: 'task' as const,
    table: 'tasks',
    projectColumn: 'project_id',
    archivedColumn: 'archived_at',
    tagsColumn: 'tags',
    plural: 'tasks',
  }),
]);

export type DisclosableEntity = DisclosableTable['entity'];

/** Look a table up by its caller-facing entity word. Throws on an unknown entity. */
export function disclosableTable(entity: DisclosableEntity): DisclosableTable {
  const found = DISCLOSABLE_TABLES.find((t) => t.entity === entity);
  if (!found) {
    throw new Error(
      `[archiveDisclosure] no DISCLOSABLE_TABLES entry for entity "${entity}" — ` +
        `add it there, not at the call site.`
    );
  }
  return found;
}

/**
 * The tri-state. Exported as a frozen tuple so a guard can enumerate the vocabulary
 * rather than re-typing it (a hand-copied list of states is a second source).
 */
export const ARCHIVE_DISCLOSURE_STATES = Object.freeze([
  'excluded',
  'none-archived',
  'included',
] as const);

export type ArchiveDisclosureState = (typeof ARCHIVE_DISCLOSURE_STATES)[number];

/**
 * The structuredContent key the disclosure lands at. Referenced by the service, the output
 * schemas and the guard — never typed by hand at a third site.
 */
export const ARCHIVE_DISCLOSURE_KEY = 'archiveDisclosure';

/**
 * WHICH OPS DISCLOSE, AND OVER WHICH ENTITIES.
 *
 * Read by the ONE disclosure seam in routes/index.ts. An op listed here gets its archive
 * disclosure stamped automatically after the dual-channel seam has normalised its response;
 * nothing is wired per-handler.
 *
 * WHY THE SEAM IS AT routeExecutor AND NOT IN THE HANDLERS. Three reasons, all measured
 * while building this:
 *   1. The handlers use TWO response conventions — most set `structuredContent`, the
 *      decision routes set the legacy `data` — and `ensureStructuredContent` is what
 *      reconciles them. Stamping upstream of that meant guessing the channel; stamping
 *      downstream means there is only one.
 *   2. Wrapping each handler meant splitting it into `handleX` + `handleXInner`, which
 *      moved every `args.<param>` reference out of the function
 *      `routeContractDrift.contract.test.ts` reads — turning four route guards RED for a
 *      refactor that changed no behaviour. A guard's subject resolution is not something to
 *      bend around a new feature.
 *   3. Eight wiring sites is eight chances to forget the ninth. One site cannot be
 *      forgotten; the only thing that can be forgotten is an entry in THIS table, and the
 *      contract test derives its population from the zod schemas and fails on a missing one.
 *
 * COMPLETENESS IS NOT MAINTAINED BY HAND: archiveDisclosure.contract.test.ts enumerates
 * every op whose zod schema declares `includeArchived` and asserts each one discloses. An
 * op that gains the flag and not an entry here goes RED.
 */
/**
 * One op's disclosure declaration.
 *   entities    — which record populations the op narrows (one block PER entity).
 *   scope       — 'project': the op read ONE project (its `projectId`/`project` arg, else
 *                 the caller's current project); 'all-projects': the op's counts span every
 *                 project (project_list), so the archived population is measured fleet-wide
 *                 and the scopeNote says so. Never summed silently across a scope it did not read.
 *   appliesWhen — OPTIONAL predicate on the validated args. When it returns false the op
 *                 emitted no count on this call and there is nothing to disclose; stamping a
 *                 block anyway would describe a narrowing that did not happen. Absent = always.
 */
export interface ArchiveDisclosureOp {
  readonly entities: readonly DisclosableEntity[];
  readonly scope: 'project' | 'all-projects';
  readonly appliesWhen?: (args: any) => boolean;
}

export const ARCHIVE_DISCLOSURE_OPS: Readonly<Record<string, ArchiveDisclosureOp>> = Object.freeze({
  context_search: { entities: ['context'], scope: 'project' },
  context_get_recent: { entities: ['context'], scope: 'project' },
  context_stats: { entities: ['context'], scope: 'project' },
  decision_search: { entities: ['decision'], scope: 'project' },
  decision_stats: { entities: ['decision'], scope: 'project' },
  task_list: { entities: ['task'], scope: 'project' },
  task_progress_summary: { entities: ['task'], scope: 'project' },
  // Reports all three entity breakdowns, so it discloses all three — never one summed
  // number, which would belong to no population and reconcile with no other op.
  project_insights: { entities: ['context', 'decision', 'task'], scope: 'project' },
  project_tags: { entities: ['context', 'decision', 'task'], scope: 'project' },
  // an earlier task — the two per-PROJECT count-bearing ops that narrowed `contextCount` by
  // `archived_at IS NULL` with no flag. Both now accept includeArchived and disclose.
  // project_info reads the project named by its `project` arg (id or name).
  project_info: { entities: ['context'], scope: 'project' },
  // project_list's contextCount spans EVERY project, and exists only when includeStats is
  // on — without it the response carries no count, so there is nothing to disclose.
  project_list: {
    entities: ['context'],
    scope: 'all-projects',
    appliesWhen: (args) => args?.includeStats === true,
  },
});

/**
 * an earlier task — the count-bearing ops that narrow by `archived_at IS NULL` and DELIBERATELY
 * offer no includeArchived. Their counts are per-SESSION attribution ("what this session
 * produced that is still findable"): widening them would make a session's productivity count
 * records nobody can retrieve — the same call SessionRepo already makes for the score built
 * on these numbers ("a score over records nobody can retrieve is not a score of anything").
 * The narrowing is stated in each op's registry description (the contract), and
 * archiveDisclosure.contract.test.ts asserts BOTH that this is exactly the flagless
 * remainder of `reportsCount` and that every member's description says so. The archived
 * records themselves stay reachable: context_search / decision_search / task_list with
 * includeArchived:true and the session's id.
 */
export const ARCHIVE_UNNARROWABLE_OPS: readonly string[] = Object.freeze([
  'session_status',
  'session_list',
  'session_get',
]);

/** The phrase every un-narrowable op's description must carry, so the contract is checkable. */
export const ARCHIVE_UNNARROWABLE_CONTRACT_PHRASE = 'live (non-archived) records only';

/**
 * TAG CENSUS tunables. `configs-not-hardcoded`: these are the only numbers
 * in the feature and they live here.
 */
export const TAG_CENSUS_DEFAULT_LIMIT = 200;
export const TAG_CENSUS_MAX_LIMIT = 1000;
