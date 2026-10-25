/**
 * actorProjectStateConfig — the named config for ACTOR-KEYED CURRENT-PROJECT state
 * (an earlier decision — the permanent fix the caller-identity
 * guards point at: "the deletion of the Map and both literals is an earlier task").
 *
 * WHY IT EXISTS: "current project" is keyed on TRANSPORT identity (the connection id), with
 * every identity-less caller collapsed onto one shared literal — so the state is shared,
 * sticky, last-writer-wins, and lost on restart. The composite-actor work
 * shipped the durable identity primitive; THIS flag turns on the state that keys off it:
 * `project_switch` upserts `actor_project_defaults` (migration 073) for the caller's derived
 * actor, and project resolution consults it between the binding (rung 2) and the legacy
 * connection Map (rung 3).
 *
 * STANDING PRINCIPLE (the operator, configs-not-hardcoded): the kill switch and the env var NAME
 * live HERE — a named value with a documented default and an env override — never a literal
 * buried in handlers/project.ts. Mirrors config/actorIdentityConfig.ts (the sibling flag this
 * one composes with) including its CALL-TIME read discipline, so tests can flip modes without
 * a module reload and one tenant flip needs only a restart.
 *
 * SHIPPED DARK. Default FALSE: with the flag off, NOTHING reads or writes the
 * new table and project resolution is byte-identical to today — the fleet takes this code on
 * the next deploy safely. MERGE, DEPLOY and ENABLE stay three separate, reversible decisions.
 *
 * NOTE ON THE PAIRING: per-agent distinctness under ONE OAuth principal additionally needs
 * MANDREL_ACTOR_COMPOSITE_ENABLED=true (otherwise N agents under one sub still derive ONE
 * actor and therefore share one row here — by identity, not by transport). The two flags are
 * deliberately independent: composite-off + this flag on still fixes the header-less
 * static-bearer population (coordinator / tick / builder-<id8> are distinct actors already).
 */

/** The env var NAMES this feature reads (one source for provisioner/deploy notes/tests). */
export const ACTOR_PROJECT_STATE_ENV = {
  /**
   * THE KILL SWITCH. Default FALSE = today's connection-keyed behavior,
   * byte-for-byte. Truthy token (`1`/`true`/`yes`/`on`) enables actor-keyed current-project.
   */
  ENABLED: 'MANDREL_ACTOR_PROJECT_STATE_ENABLED',
} as const;

/** The shipped default: OFF (merging this code changes nothing at runtime). */
export const ACTOR_PROJECT_STATE_ENABLED_DEFAULT = false;

/**
 * Tolerant boolean-VALUE parse, same shape as actorIdentityConfig.parseEnvBool: a dark
 * feature flag parses symmetrically and falls back to OFF, so a typo leaves the shipped
 * default in place rather than half-enabling a state-model change.
 */
function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * actorProjectStateEnabled — the master switch for actor-keyed current-project.
 *
 * FALSE (default / unset / garbage): resolution and project_switch behave exactly as today;
 * `actor_project_defaults` is never touched.
 * TRUE: project_switch upserts the caller's actor default, and getCurrentProjectId consults
 * it after the binding and before the legacy connection Map.
 *
 * env: MANDREL_ACTOR_PROJECT_STATE_ENABLED
 */
export function actorProjectStateEnabled(): boolean {
  const raw = process.env[ACTOR_PROJECT_STATE_ENV.ENABLED]; // env-read: MANDREL_ACTOR_PROJECT_STATE_ENABLED
  return parseEnvBool(raw, ACTOR_PROJECT_STATE_ENABLED_DEFAULT);
}
