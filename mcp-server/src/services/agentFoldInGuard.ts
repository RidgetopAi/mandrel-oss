/**
 * agentFoldInGuard — THE FOLD-IN RULE AS A GATE, NOT A PARAGRAPH.
 * (REALIGN step 5.)
 *
 * ═══ THE RULE ═══
 * An agent (the builder, the reviewer, the auditor, ops-bot, researcher — whoever config/agentActorsConfig
 * names) that finds something either FIXES IT IN ITS LANE or REPORTS IT TO COORDINATOR in its
 * return. It creates a Mandrel task only when the item needs the operator's decision, and it says so
 * by tagging the task `needs-operator`. Everything else is a task the coordinator did not ask for, and the
 * measured cost of that (39% of open tasks agent-originated, ~5 new per batch) is why this is
 * a refusal and not a warning.
 *
 * ═══ WHO IS UNTOUCHED ═══
 *   · a caller with NO resolvable actor (the flagged anonymous fallback) — not an agent
 *   · a caller whose actor is not on the list (`coordinator`, a human, a tenant's own tools)
 *   · every deployment where MANDREL_AGENT_ACTORS is unset — the list is empty, so nobody
 *     matches; tenants never see this
 *   · task_update / task_bulk_update / every read — this guards CREATION only, because the
 *     defect is the backlog growing, not agents moving work that already exists
 *
 * ═══ WHERE IT RUNS ═══
 * At the top of tasksRoutes.handleCreate — the ONE create path. Measured with
 * `/usr/bin/grep -rn "[c]reateTask(" src` and `"[I]NSERT INTO tasks"`: the handler's INSERT
 * has exactly one non-test caller, and both tool surfaces (flat `task_create` and the gateway
 * `task({action:'create'})`) reach it through routeExecutor. The Command UI's REST create
 * delegates to that same tool with the human's username as X-Actor-ID, so it passes through
 * here too and is unaffected unless that username is on the list.
 *
 * It runs BEFORE dependency / parent resolution and before the INSERT, so a refused create
 * writes nothing — the contract test asserts the row count.
 */

import { compositeActorEnabled } from '../config/actorIdentityConfig.js';
import { actorHandleSegment, normalizeActor } from '../config/actorRegistry.js';
import { tagSpellingKey } from '../config/blockedOnConfig.js';
import {
  AGENT_FOLD_IN_EXEMPT_TAG,
  AGENT_ACTORS_ENV,
  readAgentActors,
} from '../config/agentActorsConfig.js';
import { MandrelClassifiedError } from '../utils/mcpErrorStatus.js';

/** Stable machine code, mirroring CALLER_IDENTITY_ERROR_CODES' contract. */
export const AGENT_FOLD_IN_ERROR_CODE = 'TASK_CREATE_AGENT_FOLD_IN';

/**
 * The typed refusal. Same shape as CallerIdentityError: the message is PREFIXED with the
 * machine code and carries its own 💡 remedy, because formatMcpError appends a generic
 * "re-check your parameters" hint to any message without one — and the remedy here is not a
 * parameter, it is a different action.
 *
 * 403, for the same reason CallerIdentityError gives: the caller is authenticated and was
 * refused on POLICY. Not 401 (nothing to re-authenticate), not 200 (a refused write that
 * reports success is invisible to every status-code consumer).
 */
export class AgentFoldInError extends MandrelClassifiedError {
  readonly code = AGENT_FOLD_IN_ERROR_CODE;
  constructor(readonly actor: string) {
    super(
      `[${AGENT_FOLD_IN_ERROR_CODE}] task_create from agent actor '${actor}' refused: an agent ` +
        `does not file tasks. The fold-in rule: if you found this inside your lane, FIX IT ` +
        `in this lane now; if it is outside your lane, put it in your return under ` +
        `"FOUND, NOT FIXED" with file:line and a one-line fix shape — a human decides whether it ` +
        `becomes a task. Nothing was written.` +
        `\n\n💡 The ONE exception: an item that needs a human decision. Add the tag ` +
        `\`${AGENT_FOLD_IN_EXEMPT_TAG}\` (and \`from:<your role>\`) and re-send. ` +
        `Which actors this applies to is the ${AGENT_ACTORS_ENV} list on this deployment.`,
      403,
    );
    this.name = 'AgentFoldInError';
  }
}

export interface AgentFoldInInput {
  /** The actor derived at the request edge (RouteContext.actor) — the identity mandrel_ping echoes. */
  actor: string | null | undefined;
  /** The tags the caller sent, as validated (before or after tag normalization — both fold the same). */
  tags: readonly string[] | undefined;
  /** The roster. Defaults to the live env read; injectable so a unit test needs no env. */
  agentActors?: ReadonlySet<string>;
}

/** True iff the tag list carries the exemption, in any spelling `tagSpellingKey` folds together. */
export function hasFoldInExemptTag(tags: readonly string[] | undefined): boolean {
  if (!tags) return false;
  const want = tagSpellingKey(AGENT_FOLD_IN_EXEMPT_TAG);
  return tags.some((t) => typeof t === 'string' && tagSpellingKey(t) === want);
}

/**
 * Throw AgentFoldInError iff the caller is a listed agent AND the task is not marked for
 * The operator. Returns silently in every other case — including the empty-roster default.
 */
export function assertAgentMayCreateTask(input: AgentFoldInInput): void {
  const roster = input.agentActors ?? readAgentActors();
  if (roster.size === 0) return;
  const actor = normalizeActor(input.actor);
  if (actor === null) return;
  // Composite actors (`principal~builder`) classify by their handle segment everywhere
  // else (classifyActor); the guard must read the same segment or a listed agent walks past.
  const subject = compositeActorEnabled() ? actorHandleSegment(actor) : actor;
  if (!roster.has(subject)) return;
  if (hasFoldInExemptTag(input.tags)) return;
  throw new AgentFoldInError(actor);
}
