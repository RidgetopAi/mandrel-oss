/**
 * ── CALLER IDENTITY ECHO ─────────────────────────────────────────────────────────────────
 *
 * "Did my X-Actor-ID land?" answered in one field, by the server that would know.
 *
 * WHY IT IS ITS OWN MODULE (2026-09-07). This logic was written for the
 * Amp-orb eval (W3) and lived inside session.routes.ts, reachable only on
 * session-identity responses. Measured on a live CUSTOMER tenant the same day: contoso has
 * 454 writes attributed to the flagged `anonymous` fallback (last 2026-09-05, ongoing) and
 * exactly 3 that ever carried his actor — and he believes he is configured, because NOTHING
 * HE CAN REACH TELLS HIM OTHERWISE. He is on the gateway surface, where the tools are
 * `discover` + 7 gateways + 3 specials; `session_status`, which carries this echo, is behind
 * the `session` gateway and is not somewhere a confused user goes.
 *
 * So the echo moves here and `mandrel_ping` gains it — the first thing anyone calls, and
 * reachable on BOTH surfaces (gateway callers get it via `discover({action:'ping'})`, which
 * delegates to the same op with the same context).
 *
 * ONE DERIVATION, NOT TWO. session.routes.ts imports these rather than keeping its copy: a
 * second answer to "who is this caller" is precisely the drift this repo's libs exist to
 * prevent, and this one would have drifted across two surfaces.
 *
 * PRIVACY: this echoes the DERIVED principal only. It never carries the raw Authorization
 * header, a bearer token, an OAuth claim set, or a cookie — none of which are reachable from
 * `RouteContext` in the first place.
 */
import { normalizeActor } from '../config/actorRegistry.js';
import type { RouteContext } from '../routes/index.js';

export interface CallerEcho {
  actor: string | null;
  actorDeclared: boolean;
  connectionId: string | null;
}

/** The structured echo carried on identity-bearing responses. */
export function callerEcho(context?: RouteContext): CallerEcho {
  const actor = normalizeActor(context?.actor);
  return {
    actor,
    actorDeclared: actor !== null,
    connectionId: context?.connectionId ?? null,
  };
}

/**
 * The human line describing the caller — including the LOUD case where no actor was derivable
 * (the single most common reason an orb's attribution looks wrong).
 */
export function renderCallerEcho(caller: CallerEcho): string {
  if (!caller.actorDeclared) {
    return (
      `👤 caller actor: NOT DECLARED — no X-Actor-ID header and no authenticated principal ` +
      `reached this call, so anything created by it is attributed to the flagged anonymous ` +
      `fallback, not to you. Send X-Actor-ID to make your writes attributable.` +
      `\n🔌 caller connection: ${caller.connectionId ?? 'none (stdio / header-less transport)'}`
    );
  }
  return (
    `👤 caller actor: ${caller.actor}` +
    `\n🔌 caller connection: ${caller.connectionId ?? 'none (stdio / header-less transport)'}`
  );
}

/**
 * ORDER THE PING TEXT — the warning LEADS, or it does not arrive at all.
 *
 * MEASURED, 2026-09-09, on the customer this echo was built for. The echo works: verified
 * live on his own container, both directions. He still did not receive it, because his MCP
 * client SUMMARISED the tool result — it kept the headline ("Status: Operational") and
 * discarded everything after the newline. What he reported back was "Mandrel is
 * operational. Pong received successfully.", a string that exists nowhere in this codebase.
 *
 * So when the caller is NOT declared, the warning goes FIRST and the pong headline second.
 * A summariser keeps the head; putting a "your writes are anonymous" warning behind a
 * "Status: Operational" line is putting it exactly where the summariser drops it.
 *
 * WHEN THE CALLER **IS** DECLARED THE ORDER IS UNCHANGED — pong first, identity after. There
 * is no warning to lose in that branch, and reordering it would churn every consumer that
 * reads the pong headline for nothing.
 *
 * A pure function taking both halves, rather than a branch inside the route: the ordering IS
 * the contract here, so it is the thing a test can pin.
 */
export function orderPingText(pongLine: string, caller: CallerEcho): string {
  return caller.actorDeclared
    ? `${pongLine}\n${renderCallerEcho(caller)}`
    : `${renderCallerEcho(caller)}\n${pongLine}`;
}
