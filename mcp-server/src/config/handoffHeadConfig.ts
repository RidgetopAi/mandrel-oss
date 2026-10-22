/**
 * HANDOFF HEAD RESOLUTION config — P5.2 (Mandrel task P5.2; scope
 * riverbend/reports/artifacts/p5-briefing-parity/SCOPE.md §2 P5.2 + §8.5).
 *
 * THE DEFECT THIS CONFIGURES AGAINST. `projectBriefing.ts` used to pick the live handoff
 * with a ONE-HOP `NOT EXISTS (… edge_type='supersedes')`. That predicate answers "does
 * anything at all point a supersedes edge at this row" — it does not walk the chain, it
 * does not care whether the pointer came from a LIVE handoff of THIS project, and it has
 * no idea what to do when the answer is ambiguous. Measured consequence (an earlier note
 * , 2026-08-23): a handoff four generations deep in a declared supersession chain
 * was served as "the handoff", and the MODE/PATH trip-wire that exists to stop a session
 * inheriting a stale stance read a dead record.
 *
 * STANDING PRINCIPLE (the operator, configs-not-hardcoded): every tunable the resolver uses lives
 * HERE — a named value with a documented default — never a literal in the walk. Same
 * READ-AT-CALL-TIME shape as config/briefingConfig.ts: each env-backed knob is a `READ_*()`
 * function so a test can vary it without module surgery.
 *
 * WHAT IS DELIBERATELY *NOT* TUNABLE, AND WHY — the same refusal
 * config/handoffResumePointerConfig.ts makes. Two values below are plain constants with no
 * env read, because making them configurable would make the defect reachable as a
 * DEPLOYMENT SETTING while every response kept reporting success:
 *
 *   - HANDOFF_HEAD_EDGE_TYPE. `supersedes` EXCLUDES; `possibly_supersedes` ANNOTATES
 *     (migration 087's own words). An operator who widened this to admit the soft edge
 *     would let an LLM's opinion pick which handoff a customer boots from.
 *   - HANDOFF_HEAD_REQUIRED_PROVENANCE_CLASS. `declared` is the whole point: a guessed
 *     pointer may never justify a decision. Migration 087 makes a guessed `supersedes`
 *     unwritable at the DB layer, so this filter is defense in depth against a future
 *     relaxation of that constraint — a belt whose braces are a CHECK constraint. A knob
 *     here would be a knob that switches the belt off.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a STRING env var, falling back only when the variable is genuinely absent. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined ? fallback : raw;
}

/**
 * THE EDGE TYPE THAT ORDERS THE HANDOFF TIMELINE. Mirrors the one edge
 * services/handoffSupersession.ts mints. NOT an env knob — see the header.
 */
export const HANDOFF_HEAD_EDGE_TYPE = 'supersedes';

/**
 * THE PROVENANCE CLASS A SUPERSESSION POINTER MUST CARRY TO BE WALKED. Reads
 * `links.provenance_class`, the STORED GENERATED column from migration 085 — the single
 * source, never a re-spelled mint_via list. NOT an env knob — see the header.
 */
export const HANDOFF_HEAD_REQUIRED_PROVENANCE_CLASS = 'declared';

/**
 * HANDOFF_HEAD_MAX_HOPS — how many supersession hops one seed's walk may follow.
 *
 * A RUNAWAY BOUND, NOT A POLICY. Cycles are caught structurally (the walk carries its own
 * path and marks a revisit), so this knob exists only to bound cost on a pathological
 * graph. Exceeding it is a COULD-NOT-MEASURE that REFUSES — never a silent stop at the
 * last id seen, which would be the original defect wearing a bound.
 *
 * The default is generous on purpose: the chain length is the number of handoffs written
 * since the seeded one, and the whole point of the tag seed is that it can be many
 * generations behind. A stingy bound would turn an ordinary busy project into a permanent
 * refusal. (env: MANDREL_HANDOFF_HEAD_MAX_HOPS)
 */
export const READ_HANDOFF_HEAD_MAX_HOPS = (): number =>
  envInt('MANDREL_HANDOFF_HEAD_MAX_HOPS', 256);

/**
 * HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS — how much of a candidate handoff's first line the
 * REFUSAL render shows per candidate.
 *
 * WHY THERE IS A HEADLINE AT ALL (SCOPE §8.5): refusing to pick must not mean rendering
 * nothing. We measured a 40-minute broken boot from a resolver that refused a forked chain
 * and emitted an empty section. A customer has no operator to repair the graph, so the
 * refusal has to leave them able to act: id, timestamp, and enough of the record to tell
 * the two apart. (env: MANDREL_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS)
 */
export const READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS = (): number =>
  envInt('MANDREL_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS', 240);

/**
 * HANDOFF_HEAD_REFUSAL_REMEDY — the IN-BAND repair instruction rendered under an ambiguous
 * handoff chain.
 *
 * It names PUBLIC TOOL SURFACE actions only. A remedy a customer cannot perform is not a
 * remedy, and "ask your operator to fix the graph" is exactly the answer a single-tenant
 * customer does not have. `{newer}` / `{older}` are substituted with the two most recent
 * candidate ids so the sentence is copy-pasteable rather than a shape to fill in.
 * (env: MANDREL_HANDOFF_HEAD_REFUSAL_REMEDY)
 */
export const READ_HANDOFF_HEAD_REFUSAL_REMEDY = (): string =>
  envStr(
    'MANDREL_HANDOFF_HEAD_REFUSAL_REMEDY',
    'TO REPAIR (either is enough, both are ordinary tool calls): ' +
      'declare the order — graph({action:"link", fromType:"context", fromId:"{newer}", ' +
      'toType:"context", toId:"{older}", edgeType:"supersedes"}) — or retire the one that ' +
      'is not live — context({action:"delete", id:"{older}"}). Storing a NEW handoff does ' +
      'NOT clear this: the write-path mint picks its predecessor by timestamp adjacency, ' +
      'so a new handoff extends one arm of the fork and the chain stays ambiguous.',
  );

/**
 * WHY A REFUSAL HAPPENED, in one sentence per typed reason — the vocabulary and its prose
 * in ONE place, next to each other, so a new reason cannot be added without a sentence.
 *
 * These are DESCRIPTIONS, not tunables, and deliberately not env-backed: each one states
 * what was observed in the graph. An operator who could rewrite them could make a refusal
 * describe a condition that did not occur.
 *
 * Keyed by HandoffHeadRefusalReason (services/handoffHead.ts). The mapping is exhaustive by
 * construction — the renderer indexes it with the typed reason, so a missing key stops the
 * GREEN path compiling rather than rendering `undefined` at a customer.
 */
export const HANDOFF_HEAD_REFUSAL_EXPLANATION = {
  'seed-disagreement':
    'the two independent seeds walked to DIFFERENT chains — the newest handoff and the ' +
    'newest one tagged ref:resume do not belong to the same supersession chain, so the ' +
    'corpus has more than one live head',
  fork:
    'the chain BRANCHES — more than one handoff declares that it supersedes the same ' +
    'record, so there is no single newest end to walk to',
  cycle:
    'the chain LOOPS — following the declared supersedes edges returns to a record already ' +
    'walked, so no record in it is the end',
  'hop-bound':
    'the walk hit its runaway bound (MANDREL_HANDOFF_HEAD_MAX_HOPS) with the chain still ' +
    'running, so the end was never reached — this is a could-not-measure, not a verdict',
  unresolvable:
    'the walk returned a shape the resolver cannot account for; reported as a ' +
    'could-not-measure rather than absorbed into a diagnosis that was never observed',
} as const;
