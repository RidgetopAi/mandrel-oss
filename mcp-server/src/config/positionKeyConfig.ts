/**
 * WHAT A BRANCH POSITION IS KEYED ON — the named rule.
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. The key COMPOSITION lives here, in
 * one place, as named exports, because `handlers/project.ts: resolvePositionKeys` is the
 * single choke point every position read and write goes through and the composition it
 * applies must be readable without reading that function.
 *
 * ── WHY THE KEY CHANGED ──────────────────────────────────────────────────────────────
 * Position used to be keyed on the CONNECTION identity alone. Measured 2026-08-27 on the
 * control box: ONE `claude` process hosts the coordinator and eight the builder subagents and
 * multiplexes all nine over THREE long-lived stdio bridge processes; every one of those
 * bridges declares the SAME `X-Connection-ID`, because the launcher exports
 * `MANDREL_LOOP_ID` into an environment every descendant inherits. So nine agents shared
 * ONE `branch_positions` row, last-writer-wins, and each agent's writes minted DECLARED,
 * trust-bearing `informs` membership onto whichever spine another agent had most recently
 * claimed. A CONNECTION is a transport. A LOOP is an agent. They were being conflated.
 *
 * ── THE LADDER, strongest first ──────────────────────────────────────────────────────
 *   1. A DECLARED LOOP ID (`X-Loop-ID`). An agent stating its own loop identity outranks
 *      everything the transport can infer, and is the ONLY discriminator that separates
 *      two agents which share both a connection and an actor.
 *   2. The connection identity SCOPED BY ACTOR. Distinct principals on one transport —
 *      `coordinator` vs `builder` vs `reviewer` vs `tick` — are already distinguishable today,
 *      with no client change at all, so this rung is what actually stops cross-talk on the
 *      deployed fleet.
 *   3. The bare connection identity, exactly as before, for any caller that declares no
 *      actor (in-process callers, tests, background jobs). Legacy == today for everything
 *      this change does not separate.
 *
 * ── WHERE RUNG 1 IS ACTUALLY REACHED FROM ────────────────────────────
 * A ladder rung is worth exactly as much as the transports that feed it, and for a while
 * this one was worth half. `LOOP_ID_HEADER` was read by `server/healthServer.ts` (the flat
 * `POST /mcp/tools/*` surface) and NOT by `server/remoteMcpTransport.ts` (the streamable
 * `POST /mcp` surface) — so the same client, declaring the same loop id, was isolated on
 * one endpoint and silently keyed as though it had declared nothing on the other. That is
 * the worst failure shape available here: the caller believes it is isolated, is not, and
 * is told nothing. Both request-bearing transports now read it, and
 * tests/remoteMcpTransport.integration.test.ts asserts the header crossing a real MCP
 * client rather than trusting that it does.
 *
 * The routeExecutor-level probes could not have caught that and did not: they hand `loopId`
 * straight to the executor, so they stayed GREEN through the entire period the streamable
 * surface was discarding it. Keying is proven at the choke point; DELIVERY has to be proven
 * at the wire.
 *
 * The stdio server (`server/MandrelMcpServer.ts`) deliberately reads NO loop id. One stdio
 * process serves exactly one client, so its connection identity is already per-agent and a
 * rung-1 declaration would add nothing. It is specifically NOT wired to an env var: on the
 * control box `MANDREL_LOOP_ID` is exported by the launcher and INHERITED by every
 * descendant, so reading it there would hand every agent the same "identity" — the exact
 * conflation this ladder exists to undo, re-introduced one rung higher.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ────────────────────────────────────────────
 * The residual is now narrower but it is not gone, and it is a CLIENT-side residual rather
 * than a server-side one: two agents that present the same connection id, the same actor
 * and NO loop id remain indistinguishable and still share a slot. Nothing in the request
 * separates them — measured on the wire 2026-08-27, the MCP frame carries only a per-CALL
 * `claudecode/toolUseId` and a client-global `progressToken` — so no server-side rule and
 * no amount of transport plumbing can invent one. What CAN close it is the client sending
 * `X-Loop-ID`, which every request-bearing transport now honours; until a given client
 * does, that population gets the weaker guarantee instead (the slot refuses to hold two
 * contested claims and mints nothing, config/positionContentionConfig.ts).
 *
 * Both halves are pinned by EXECUTED probes in tests/positionSlotCrossTalk.contract.test.ts
 * rather than left as prose: PROBE 7 asserts the weak guarantee (no WRONG edge), and
 * PROBE 8 is a `test.fails` pinning the positive guarantee as UNREACHABLE without a
 * declared loop id — so the day a client supplies one, that probe turns RED and forces this
 * paragraph to be rewritten instead of quietly going stale.
 */

/** How a DECLARED loop id is rendered into a session key. Namespaced so a loop id can never
 *  collide with a connection id that happens to be spelled the same way. */
export const POSITION_KEY_LOOP_PREFIX = 'loop:';

/**
 * The request header an agent declares its own loop identity on. Lower-case because that is
 * how every transport in this server reads a header, and named here — beside the rule that
 * consumes it — so a transport can never invent a second spelling.
 */
export const LOOP_ID_HEADER = 'x-loop-id';

/** How the actor is appended when rung 2 applies. */
export const POSITION_KEY_ACTOR_SEPARATOR = '#actor:';

/**
 * IS RUNG 2 (actor scoping) IN FORCE? Default ON — it is the rung that fixes the deployed
 * fleet, so the safe state is the fixed one.
 *
 * IT IS A FLAG RATHER THAN A CONSTANT FOR ONE MEASURED REASON, and only one. Scoping by
 * actor RE-KEYS every caller that declares an actor, which means a caller that
 * deliberately BORROWS another principal's connection id in order to share its position
 * stops sharing it. Exactly one such caller exists that we know of: the Riverbend
 * SessionStart boot hook (`riverbend/.claude/hooks/coordinator-session-boot.sh`)
 * exports `MANDREL_CONNECTION_ID="$MANDREL_LOOP_ID"` so its `branch_open` lands
 * on the live session — but it leaves `MANDREL_ACTOR` at bridge-auth.sh's `coordinator-shell`
 * default while the session's own bridge declares `coordinator`. Under actor scoping those are
 * two loops, and the boot-side open stops landing until that hook also declares the
 * session's actor. That companion change lives in another repo and cannot be verified from
 * here, so this flag is the rollback: one env var restores the previous keying whole.
 *
 * Rung 1 is NOT flagged. A caller that declares a loop id is asking for exactly this
 * behaviour, and honouring an explicit declaration needs no escape hatch.
 */
export const POSITION_KEY_ACTOR_SCOPED_ENV = 'MANDREL_POSITION_KEY_ACTOR_SCOPED';

/** Read at CALL time, not at import time, so a probe can flip it without re-importing. */
export function positionKeyActorScoped(): boolean {
  return (process.env[POSITION_KEY_ACTOR_SCOPED_ENV] ?? 'true').toLowerCase() !== 'false'; // env-read: MANDREL_POSITION_KEY_ACTOR_SCOPED
}

/**
 * Compose the ONE session key for a position, given what this call declared about itself.
 * The whole ladder above, in one function, so a reader never has to reconstruct it from
 * call sites — and so a test can exercise the composition without a transport.
 */
export function composePositionKey(input: {
  connectionId: string;
  actor?: string;
  loopId?: string;
}): string {
  const loopId = input.loopId?.trim();
  if (loopId) return `${POSITION_KEY_LOOP_PREFIX}${loopId}`;
  const actor = input.actor?.trim();
  if (positionKeyActorScoped() && actor) {
    return `${input.connectionId}${POSITION_KEY_ACTOR_SEPARATOR}${actor}`;
  }
  return input.connectionId;
}
