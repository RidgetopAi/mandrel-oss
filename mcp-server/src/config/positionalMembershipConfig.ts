/**
 * POSITIONAL MEMBERSHIP — the named RULES (SK1, STRONG BONES).
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. What lives here are the rules the
 * membership computation applies, in ONE place, as named exports.
 *
 * WHAT IS *NOT* TUNABLE, AND WHY — the same refusal declaredLimbsConfig.ts makes. There is
 * no env read in this file on purpose. These are not knobs: they are the definition of what
 * a record's membership IS. An env-tunable membership rule would let one deployment mint a
 * different graph from another while both reported success, and the whole value of a
 * DECLARED edge is that it means the same thing everywhere it is read.
 */

/**
 * THE BODY-COMPOSITION RULE — which fields of each record kind are scanned for named ids.
 *
 * WHY IT LIVES HERE RATHER THAN AT THE CALL SITES. Before SK1 the three write handlers each
 * built this string inline: context.routes used `args.content`, tasks.routes used
 * `title + "\n" + description`, decisions.routes used title/description/rationale/
 * problemStatement joined. Three inline literals is not "one rule with three inputs" — it is
 * three rules that happen to agree today, and nothing anywhere asserted that they did. The
 * measured consequence is subtle and silent: an id named in a field that one path scans and
 * another does not produces a DIFFERENT membership classification for the same words, and
 * the writer is never told which fields count.
 *
 * The field lists are the rule as it was measured, unchanged — SK1 relocates it, it does not
 * redefine it. `composePositionalBody` is the only reader.
 *
 * DELIBERATE DIFFERENCE FROM declaredLimbs' `composeLimbBody`, stated rather than accidental:
 * that function additionally includes a decision's `outcome_notes`, because it is pinned
 * byte-for-byte to the Python eval the limb precision was measured with
 * (declaredLimbsGoldenParity.contract.test.ts). Outcome notes are written by
 * decision_update, never by decision_record, so the two rules cannot disagree about any
 * record at CREATE time — which is the only time this rule runs. Unifying them would mean
 * editing the pinned rule, which would invalidate a measured number; that is a worse trade
 * than two rules whose divergence is documented and untriggerable on this path.
 */
export const POSITIONAL_BODY_FIELDS = {
  context: ['content'],
  task: ['title', 'description'],
  decision: ['title', 'description', 'rationale', 'problemStatement'],
} as const satisfies Record<string, readonly string[]>;

/**
 * The separator joining the scanned fields. A newline, so two fields can never fuse their
 * edge characters into a token that neither field contains (`…dead` + `beef…` must not read
 * as one 8-hex word).
 */
export const POSITIONAL_BODY_SEPARATOR = '\n';

/**
 * BYPRODUCT-OPEN PRECEDENCE (SK1 item d): a BYPRODUCT position open — task_claim, or
 * task_update flipping status to in_progress — must NOT overwrite a position the session
 * opened DELIBERATELY (`origin = 'declared'`, i.e. branch_open).
 *
 * THE MEASURED SHAPE THIS FIXES (observed on prod 2026-08-15, the coordinator coordinating): a
 * dispatcher marked two tasks in_progress back to back and its position landed on whichever
 * it touched LAST — arbitrarily — because byproduct opens were last-write-wins. Any record
 * written afterwards would have minted a DECLARED `via:position` membership edge onto a
 * spine nobody was working on. That is not a missing edge, it is a CONFIDENTLY WRONG one,
 * and a wrong declared edge is worse than none: the point of SK1 is that a declared edge can
 * be walked without re-judging it.
 *
 * WHY YIELDING IS THE RIGHT DIRECTION, and not merely the cautious one. The two failure
 * directions are not symmetric:
 *   - yielding costs PRECISION: a session that explicitly opened a parent branch and then
 *     starts work on a task inside it keeps attaching to the parent. The membership is
 *     COARSER, and still TRUE — the writer did declare they were on that branch, and the
 *     task itself is a member of it, so recall still reaches the work.
 *   - not yielding costs CORRECTNESS: the dispatcher case attaches records to a spine the
 *     writer never stood on. Nothing downstream can tell that edge from an earned one.
 * Coarse-and-true beats precise-and-wrong. Recovery is also asymmetric: leaving the coarse
 * case takes ONE explicit act (`branch_open <task>`) that the response names outright, while
 * the wrong case is silent and therefore unlearnable.
 *
 * SCOPE, kept to one line of policy rather than a taxonomy: ONLY 'declared' is protected.
 * An 'auto' position is itself a byproduct (R1) and an in_progress flip is a strictly
 * stronger work-start signal than an auto-open, so byproducts still take each other's place;
 * a 'trunk' row is not a position at all. task_claim and task_update are treated
 * IDENTICALLY — both are byproducts by construction, and splitting them would be the start
 * of exactly the precedence taxonomy this build is refusing to grow.
 */
export const BYPRODUCT_YIELDS_TO_ORIGINS = ['declared'] as const;
