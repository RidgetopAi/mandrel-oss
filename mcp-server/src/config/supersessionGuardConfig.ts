/**
 * BACKWARD-SOFT SUPERSESSION GUARD — the config (P5.3 half B).
 *
 * THE RULE THIS CONFIGURES, in one sentence:
 *
 *   > A GUESSED (`tier:soft`) supersession may not contradict a DECLARED chain running the
 *   > other way. A declaration outranks an opinion.
 *
 * WHY IT EXISTS — measured, from one rendered boot package on 2026-08-23 (prod, project
 * `riverbend`; the response is kept read-only at
 * runtime/lib/__fixtures__/boot-recall-collapse/walk-cycle-eb98f00d.json and is the fixture
 * the contract test runs on):
 *
 *   an earlier change  superseded_by an earlier change   tier:declared
 *   an earlier change  superseded_by an earlier change   tier:declared
 *   an earlier change  superseded_by an earlier change   tier:soft  conf:0.85     ← a cycle
 *
 * an earlier change was the LIVE handoff head. The belief adjudicator (a real LLM call, default ON,
 * `beliefConfig.ts`) minted an opinion saying it was superseded by a record it transitively
 * supersedes BY DECLARATION. The declared-edge resolver was right every time; the opinion was
 * the thing that was wrong. The consequence is not cosmetic — the soft edge halves the head's
 * trust score (`softSupersedeDemotion`), which is what put the live head under the fold.
 *
 * THREE KNOBS, and each of them exists because the alternative is a lie:
 *
 *  1. `enabled` — a kill switch. This guard SUPPRESSES data the adjudicator wrote; if it is
 *     ever wrong, an operator must be able to see the raw opinion again without a deploy.
 *  2. `maxHops` — the walk over the declared subgraph is BOUNDED. The data already contains a
 *     cycle (above), and handoff chains on a busy project run to hundreds of links. An
 *     unbounded walk is a hang; a silently-truncated one is a wrong answer.
 *  3. `undecidedPolicy` — what to DO when the walk could not decide (a cycle in the DECLARED
 *     subgraph, or the hop bound ran out with frontier left). This is C1's third state and it
 *     gets its own knob rather than being folded into either answer. The default is `honor`:
 *     SUPPRESSION REQUIRES POSITIVE PROOF OF CONTRADICTION, so absent that proof we leave the
 *     adjudicator's opinion standing — and COUNT it, loudly, in `trust.supersessionGuard`.
 *     Setting this to `suppress` is a deliberate, operator-owned change of that stance.
 *
 * Same env-read shape as trustConfig.ts (module-load read, garbage → the default).
 */

/** Read a boolean env var ('1'/'true'/'yes' = on, '0'/'false'/'no' = off), else `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Read a positive-integer env var, else `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** What to do with a soft edge whose backward-check came back UNDECIDED. */
export const UNDECIDED_POLICIES = ['honor', 'suppress'] as const;
export type UndecidedPolicy = (typeof UNDECIDED_POLICIES)[number];

function envUndecidedPolicy(name: string, fallback: UndecidedPolicy): UndecidedPolicy {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  return (UNDECIDED_POLICIES as readonly string[]).includes(v) ? (v as UndecidedPolicy) : fallback;
}

export interface SupersessionGuardConfig {
  /**
   * Whether the backward-soft guard runs at all. Env: MANDREL_BACKWARD_SOFT_GUARD.
   * Default true — the defect it fixes is LIVE on every instance today.
   */
  enabled: boolean;
  /**
   * The maximum number of DECLARED supersession hops the reachability walk will take before
   * it returns `undecided`. Env: MANDREL_BACKWARD_SOFT_MAX_HOPS. Default 25.
   *
   * WHY 25: the population is handoff chains, which `handoffSupersession.ts` extends by ONE
   * declared link per handoff write. A contradiction that matters is a recent one — the
   * measured prod case above is TWO hops. 25 buys a wide margin over the recent window while
   * keeping the recursive read bounded on a project with hundreds of handoffs. A chain longer
   * than this yields `undecided`, which is COUNTED and surfaced — never silently "no
   * contradiction".
   */
  maxHops: number;
  /**
   * What an UNDECIDED verdict does. Env: MANDREL_BACKWARD_SOFT_UNDECIDED_POLICY,
   * one of `honor` | `suppress`. Default `honor` (see the header).
   */
  undecidedPolicy: UndecidedPolicy;
}

/** THE LIVE CONFIG — read once at module load. */
export const SUPERSESSION_GUARD_CONFIG: SupersessionGuardConfig = {
  enabled: envBool('MANDREL_BACKWARD_SOFT_GUARD', true),
  maxHops: envInt('MANDREL_BACKWARD_SOFT_MAX_HOPS', 25),
  undecidedPolicy: envUndecidedPolicy('MANDREL_BACKWARD_SOFT_UNDECIDED_POLICY', 'honor'),
};
