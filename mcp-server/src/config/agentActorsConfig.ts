/**
 * agentActorsConfig — WHO COUNTS AS AN AGENT for the task_create fold-in gate.
 * (REALIGN step 5, an earlier decision.)
 *
 * ═══ THE DEFECT THIS ENCODES AGAINST ═══
 * MEASURED 2026-09-08: 39% of the 145 open tasks named an Reviewer / Builder / probe as
 * their origin, and every batch since 08-28 filed ~5 new tasks. The prose rule ("stay in
 * lane, file it") produced that backlog. The rule this config serves is the opposite one:
 * an agent that finds something FIXES IT IN ITS LANE or REPORTS IT TO COORDINATOR in its return.
 * It may create a task only when the item needs the operator's decision — and it says so with the
 * `needs-operator` tag. See services/agentFoldInGuard.ts for the check itself.
 *
 * ═══ THE LIST ═══
 * `MANDREL_AGENT_ACTORS` — a comma-separated list of caller actors (the same identity
 * `mandrel_ping` echoes as "caller actor", i.e. X-Actor-ID after `normalizeActor`).
 *
 * DEFAULT EMPTY, DELIBERATELY. An empty list means the gate matches NO ONE, so every tenant
 * that never sets the var is byte-for-byte unaffected. This is a house rule about how OUR
 * swarm files work, not a product default; prod's env names the roster
 * (`builder,reviewer,auditor,ops-bot,researcher`). Entries go through the ONE actor
 * normalizer so `Builder` and `builder` are the same member (the `coordinator`/`Coordinator` collision
 * taskAuthorStamp.ts documents is exactly what a raw string compare would reintroduce).
 *
 * READ PER CALL, NOT AT MODULE LOAD. The parse is a split of a short string; nothing in a
 * running server mutates its env after boot, so this is observably identical to a load-time
 * read in prod — and it is what lets ONE contract test drive the shipped route through
 * "env set" and "env unset" in the same process, instead of splitting the four assertions
 * across files whose module state cannot see each other.
 */

import { normalizeActor } from './actorRegistry.js';
import { DEPLOYMENT_VOCABULARY } from './deploymentVocabularyConfig.js';

/** The env name. Exported so tests and any declaration contract reference ONE string. */
export const AGENT_ACTORS_ENV = 'MANDREL_AGENT_ACTORS';

/**
 * The tag that marks a task as needing the human's decision (deployment-configured: config/deploymentVocabularyConfig.ts) — the ONE reason an agent may file
 * a task rather than fold the finding in or report it. Compared through `tagSpellingKey`
 * by the guard, so the known `needs:operator` spelling also satisfies it.
 */
export const AGENT_FOLD_IN_EXEMPT_TAG = DEPLOYMENT_VOCABULARY.needsHumanTag;

/**
 * Parse the roster. Missing / empty / whitespace-only → the empty set (the tenant-neutral
 * default). Entries are trimmed and normalized like every other actor; blanks are dropped.
 *
 * Exported with the env read as a DEFAULT ARGUMENT (the readProjectScopeGuardMode pattern)
 * so a unit test can exercise the parse without touching process.env at all.
 */
export function readAgentActors(
  raw: string | undefined = process.env[AGENT_ACTORS_ENV], // env-read: MANDREL_AGENT_ACTORS
): ReadonlySet<string> {
  const out = new Set<string>();
  if (raw === undefined) return out;
  for (const entry of raw.split(',')) {
    const actor = normalizeActor(entry);
    if (actor !== null) out.add(actor);
  }
  return out;
}
