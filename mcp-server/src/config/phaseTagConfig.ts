/**
 * THE `phase` TAG GRAMMAR — the ONE definition of what "phase N" is spelled like.
 *
 *
 * ═══ THE DEFECT ══════════════════════════════════════════════════════════════════════
 * `task_list`'s `phase` parameter built its lookup as the single literal `phase-${phase}`,
 * so a task tagged with ANY other spelling of the same phase could not be found by the
 * filter that exists to find it. Verified at the live tool surface before the fix:
 * `task_list(projectId:"riverbend", phase:"5")` returned `total: 0` while tasks tagged
 * `phase:5` and `phase5` were sitting in that project. `total: 0` does not look like a
 * bug — it looks like an empty result, which is why this survived shipped.
 *
 * ═══ WHAT THE POPULATION ACTUALLY CONTAINS ═══════════════════════════════════════════
 * Measured against prod (all projects, no tag filter, spellings DERIVED not listed):
 *
 *   SELECT tag, count(*) FROM (SELECT unnest(tags) AS tag FROM tasks) s
 *    WHERE tag ILIKE '%phase%' GROUP BY tag ORDER BY tag;
 *
 * THREE live boundary spellings, not two: `phase-N` (dash), `phase:N` (colon) and `phaseN`
 * (NO separator at all — phase1=12, phase2=11, phase3=8, phase4=25, phase5=1, phase6=5).
 * The original report named only the first two, because it was built from a hand-written
 * list of spellings someone had already thought of; a list can only confirm what is on it.
 * Deriving the vocabulary from the data is what found the third band, and it is why this
 * module states a GRAMMAR rather than an enumeration of known tags.
 *
 * ═══ WHY TOLERATE ON READ RATHER THAN CLOSE THE VOCABULARY ═══════════════════════════
 * Closing it — making only one spelling writable — is the stronger shape in the abstract
 * (it makes the bad state unreachable rather than tolerated), and it was rejected for
 * reasons that are facts about this system, not preferences:
 *
 *  1. It cannot reach the stored rows. 82 tasks on this database (43 of them in
 *     riverbend) carry at least one phase tag while NONE of their tags is in the `phase-`
 *     spelling — so the old filter could not return them for any value at all. Predicate,
 *     stated so the number is reproducible from it:
 *       EXISTS (a tag matching ^phase<sep>?<value>)  AND
 *       NOT EXISTS (a tag LIKE 'phase-%')
 *     Every tenant in the fleet has its own database and its own tag vocabulary we have
 *     never seen. A write-side closure fixes zero of these; the read path would keep
 *     answering confidently and wrongly about everything already written.
 *     (An earlier revision of this comment said 91/52. That was not backlog drift: the
 *     measuring query compared the RAW tag against a LOWERCASED value, so the 9 tasks whose
 *     only dash spelling has an uppercase value — `phase-A` and friends — never matched
 *     themselves and were counted unreachable when the old filter could in fact find them.
 *     The instrument was wrong, not the backlog. Recorded here because a plausible number
 *     from a subtly wrong query is the failure this whole module is about.)
 *  2. Migrating them means REWRITING A CUSTOMER'S TAGS. services/tagSpellingWriteCheck.ts
 *     refuses to do that at the write boundary on purpose ("a different and worse failure
 *     than the one being fixed"), and doing it in bulk in a migration is the same act with
 *     a larger blast radius and no author present to object.
 *  3. `phase` is one prefix out of 2651 distinct task tags. Closing one family by hand
 *     establishes a remedy that scales by hand, and leaves the class open.
 *
 * The half that DOES close the loop already ships: an earlier task warns at write time when
 * a new tag differs from an existing one only in separators and case. That is the coherent
 * pairing — the write boundary tells the author their spelling is splitting a queue, and
 * the read path does not lie in the meantime. The honest cost, stated rather than hidden:
 * both spellings stay writable, so the ambiguity remains live. This module does not fix
 * that; it stops the ambiguity from silently emptying a result set.
 *
 * ═══ WHY THIS DOES NOT REUSE `tagSpellingKey` ════════════════════════════════════════
 * blockedOnConfig.tagSpellingKey is the shared fold for collision REPORTING, and it
 * COLLAPSES separator runs to one `-` rather than deleting them — so `phase3` and
 * `phase-3` fold to DIFFERENT keys and it cannot see the no-separator band at all. It must
 * not be changed to delete separators either: `phase-1-1` and a future `phase-11` would
 * then collide falsely, and that fold feeds a fleet-wide briefing finding.
 *
 * This module can delete the separator safely for the one reason that fold cannot: it is
 * not comparing two arbitrary strings. It GENERATES candidates from a known prefix and a
 * caller-supplied value, so it knows exactly where the boundary is and never has to guess.
 */

/** The literal every phase tag starts with. */
export const PHASE_TAG_PREFIX = 'phase';

/**
 * The characters that may sit between the prefix and the value, PLUS the empty string.
 *
 * The empty member is not padding — it is the `phaseN` band, which is 62 stored
 * occurrences and the one the original hand-written list could not see. Ordered
 * dash-first only so generated candidate arrays read naturally in a query plan.
 */
export const PHASE_TAG_BOUNDARY_SEPARATORS = Object.freeze(
  ['-', ':', '_', '.', ' ', ''] as const,
);

/**
 * The same separator set as a SQL/JS bracket expression. `-` is first so it is a literal
 * rather than a range. Used to RECOGNISE a phase tag whose value is not known in advance
 * (the progress-summary grouping); the candidate list above is used to MATCH a value that
 * is known (the task_list filter), because generating exact strings needs no escaping of
 * caller input.
 */
export const PHASE_TAG_SEPARATOR_CLASS = '[-_:. ]';

/**
 * Every spelling of `phase <value>` this system will RECOGNISE, lowercased.
 *
 * Lowercased on both sides at the comparison, because case is a spelling difference like
 * any other — `phase-A` and `phase-a` are one phase — and tagSpellingKey already treats it
 * that way for the collision report.
 *
 * The value is matched LITERALLY after the boundary, which is what keeps `phase:"1.2"`
 * from also matching a `phase-12`: only the boundary separator is flexible, never the
 * value's own punctuation.
 */
/*
 * A NOTED AMBIGUITY, DELIBERATELY NOT DESIGNED AROUND: because the empty string is a member
 * of the separator set, `phase:"-5"` generates `phase--5` … and `phase-5`, so it matches a
 * `phase-5` task. That is harmless — a caller asking for phase "-5" almost certainly means
 * phase 5 — and closing it would mean special-casing the empty separator, which is the
 * member that exists to catch the `phaseN` band. Left as it is, said out loud.
 */
export function phaseTagCandidates(phase: string): string[] {
  const value = String(phase).trim().toLowerCase();
  if (value === '') return [];
  return PHASE_TAG_BOUNDARY_SEPARATORS.map(sep => `${PHASE_TAG_PREFIX}${sep}${value}`);
}

/**
 * SQL that folds ANY recognised phase tag to the canonical `phase-<value>` form, for use as
 * a GROUP BY key. `tagExpr` must be a SQL expression yielding one tag.
 *
 * This is a DISPLAY key, not a stored value — nothing writes its output. It exists so
 * `task_progress_summary(groupBy:'phase')` reports one row per phase instead of one row per
 * spelling of each phase.
 *
 * ⚠️ THE RECOGNISER IS DELIBERATELY PERMISSIVE, and the asymmetry is the reason. A tag it
 * over-matches (`phases` folds to `phase-s`) shows up as a visibly odd row in a summary a
 * human reads and can be corrected. A tag it under-matches vanishes from the summary with
 * no trace — which is the defect this whole module exists to close. Where the two errors
 * are not symmetric, prefer the visible one. The task_list FILTER has no such exposure
 * either way: it compares against exact strings generated from the caller's own value.
 *
 * ⚠️ IT LOWERCASES, AND THAT IS CUSTOMER-VISIBLE. A project tagged `phase-A` sees its
 * summary row RELABELLED `phase-a`. That is the price of folding case, and folding case is
 * what makes `phase-A` and a future `phase-a` ONE group instead of two — the same reason
 * the filter folds it. Named here rather than discovered later, and PINNED by an executable
 * assertion (phaseFilterSpellings.contract.test.ts, "THE CANONICAL KEY LOWERCASES"), so
 * changing it is a deliberate customer-visible relabel rather than an accident.
 *
 * A SECOND VISIBLE CONSEQUENCE, same asymmetry: tags the old `LIKE 'phase-%'` grouping
 * silently dropped now appear. `phase-4-v1` folds to `phase-4-v1`, which the summary's
 * numeric ORDER BY does not recognise, so it sorts into the ELSE 999 bucket at the end.
 * Visible and slightly untidy, versus invisible and absent. That trade is the whole point.
 */
export function phaseTagCanonicalSql(tagExpr: string): string {
  return `('${PHASE_TAG_PREFIX}-' || substring(lower(${tagExpr}) from ` +
         `'^${PHASE_TAG_PREFIX}${PHASE_TAG_SEPARATOR_CLASS}?(.+)$'))`;
}

/** SQL predicate: does `tagExpr` look like a phase tag with a non-empty value? */
export function phaseTagRecognizerSql(tagExpr: string): string {
  return `lower(${tagExpr}) ~ '^${PHASE_TAG_PREFIX}${PHASE_TAG_SEPARATOR_CLASS}?.'`;
}
