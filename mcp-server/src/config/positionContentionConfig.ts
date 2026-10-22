/**
 * ONE SLOT CANNOT HOLD TWO LIVE CLAIMS — the named rule.
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. The rule lives here, as named
 * exports, beside the reason it exists.
 *
 * ── WHY A SEPARATE RULE FROM THE KEYING LADDER ───────────────────────────────────────
 * config/positionKeyConfig.ts separates agents that are DISTINGUISHABLE — by a declared
 * loop id, or by actor. It cannot separate agents that are not. Measured 2026-08-27 on
 * dev-host: eight the builder subagents share ONE bridge process (pid 2559015,
 * MANDREL_ACTOR=builder) and one inherited MANDREL_LOOP_ID, and the MCP protocol frame
 * carries nothing else about them —
 *
 *   {"method":"tools/call","params":{"name":"graph","arguments":{"action":"branch_current"},
 *    "_meta":{"claudecode/toolUseId":"toolu_012mwNTmLuCgFMiJeALgJFCW","progressToken":281}}}
 *
 * `claudecode/toolUseId` is unique per CALL (so it cannot key anything that must persist
 * across calls) and `progressToken` is a client-global counter. There is no agent identity
 * on the wire, and therefore no server-side rule and no bridge change can invent one.
 *
 * So the peer-to-peer case — which is the case the defect was actually filed on; all four
 * confirmations in an earlier task's noteLog are the builder↔the builder — has to be closed WITHOUT
 * identifying the agents. This rule does that by reading the SLOT'S OWN STATE instead.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────
 * A work-start byproduct (task_claim / task_update→in_progress) arriving on a slot that
 * ALREADY holds a byproduct position on a DIFFERENT spine is not a position move. It is
 * two live claims arriving at one slot, and one slot cannot represent both. The slot goes
 * to TRUNK — which already means, exactly and everywhere, "mints no membership and
 * auto-opens nothing until a DECLARED act" (R5) — and the caller is TOLD.
 *
 * The batch-2 incident, replayed against this rule: the builder 1 claims T1 (slot empty →
 * byproduct on T1). The builder 2 claims T2 (byproduct already on T1, different spine →
 * CONTESTED → trunk). Every write from that slot afterwards mints no DECLARED membership
 * at all, so the four cross-threaded memberships in the noteLog never come into existence.
 * Each builder's own explicit `task:` tag still threads exactly as it did — which is the
 * whole point: nothing correct is lost, only the unattributable edge is not added.
 *
 * ── THE PRICE, STATED RATHER THAN DISCOVERED ─────────────────────────────────────────
 * A LONE agent that claims task A and then claims task B without closing in between now
 * lands at trunk instead of on B, and must `branch_open` to take a position again. That is
 * a real cost and it is deliberate: it is the same shape config/positionalMembershipConfig
 * already describes as a defect in its BYPRODUCT-OPEN PRECEDENCE note — "a dispatcher
 * marked two tasks in_progress back to back and its position landed on whichever it
 * touched LAST — arbitrarily … any record written afterwards would have minted a DECLARED
 * via:position membership edge onto a spine nobody was working on. That is not a missing
 * edge, it is a CONFIDENTLY WRONG one." That note fixed the case where the OTHER position
 * was declared. This is the same argument for the case where it was not, and it is why the
 * answer is trunk rather than last-writer-wins: at trunk the caller is told and can act; on
 * a silently-moved slot nobody is told anything.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLOSE ────────────────────────────────────────────
 * Exactly ONE agent claiming, while a same-actor peer writes without claiming and without
 * naming anything, is indistinguishable from a lone agent working normally. That peer still
 * inherits the claimer's spine. It is the residual, it is pinned by an executed probe in
 * tests/positionSlotCrossTalk.contract.test.ts rather than left unstated, and closing it
 * needs a per-agent identity that does not exist on this transport.
 */

/**
 * The position origins that a second, different byproduct claim CONTESTS.
 *
 * Deliberately ONLY 'byproduct' — the narrowest population that contains the incident:
 *   • 'declared' is already handled, and better, by BYPRODUCT_YIELDS_TO_ORIGINS: a stated
 *     stance outranks a byproduct, so the claim yields and the position is KEPT.
 *   • 'auto' is excluded on purpose. An auto position is opened by a session's own first
 *     create, so "created a task, then claimed a different one" is an ordinary lone-agent
 *     sequence, not evidence of two agents. Including it would trunk that flow for no
 *     measured reason.
 *   • 'trunk' is not a position, so there is nothing to contest.
 */
export const BYPRODUCT_CONTESTED_BY_ORIGINS = ['byproduct'] as const;

/**
 * IS THE RULE IN FORCE? Default ON — a slot that cannot say whose it is must not mint a
 * trust-bearing edge, so the safe state is the enforcing one.
 *
 * The flag exists because the rule changes a behaviour a single agent can legitimately
 * reach (the two-claims-no-close sequence above), and one env var must be able to restore
 * the previous behaviour whole if that turns out to cost more than it saves.
 *
 * Read at CALL time, not at import time, so a probe can flip it without re-importing.
 */
export const POSITION_CONTENTION_ENV = 'MANDREL_POSITION_CONTENTION_TRUNKS';

export function positionContentionTrunks(): boolean {
  return (process.env[POSITION_CONTENTION_ENV] ?? 'true').toLowerCase() !== 'false'; // env-read: MANDREL_POSITION_CONTENTION_TRUNKS
}
