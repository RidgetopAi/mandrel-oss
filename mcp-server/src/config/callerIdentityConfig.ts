/**
 * callerIdentityConfig — the posture knob for the UNIDENTIFIED-CALLER guards
 * ("project scope is global state on a shared MCP slot").
 *
 * =============================================================================
 * WHAT THE GUARDS DEFEND
 * =============================================================================
 * A caller that presents NO connection identity is collapsed by the transport onto ONE
 * shared, sticky, last-writer-wins project slot (`http-default`; see
 * server/healthServer.ts). Measured on prod 2026-07-27/28: ~13 header-less
 * `project_switch` calls between 21:06 and 01:58 cycled the SHARED slot
 * riverbend→personal→acme, and two real captures landed content in a project the
 * author had not chosen. Every header-less caller — ours and every customer's — shares
 * that one slot, so any one of them silently moves scope for all of them.
 *
 * The guards (services/callerIdentityGuard.ts) refuse the two operations that make the
 * shared slot dangerous:
 *   G1  an unidentified caller may not PERSIST scope    (`project_switch`)
 *   G2  an unidentified caller's AMBIENT write must carry an explicit project
 * Reads are deliberately untouched (G3) — re-keying reads would create empty slots and
 * hand 5 of 7 tenants (no primary project) a non-deterministic `projects[0]` auto-select.
 *
 * =============================================================================
 * FLAG POLARITY: ABSENT MEANS **ENFORCE** — THIS IS DELIBERATE
 * =============================================================================
 * The code default when `MANDREL_PROJECT_SCOPE_GUARD` is unset/garbage is `enforce`.
 *
 * That inverts our usual Lesson-025 "ships dark" posture ON PURPOSE, because the failure
 * mode of the usual posture is the one a past incident names: a guard that ships defaulted-off
 * ships DOING NOTHING, and every environment that forgets to set the flag silently keeps
 * the defect. Here, forgetting produces ENFORCEMENT — the safe direction for a data-scope
 * leak. The soak is bought by SETTING `shadow` explicitly (docker-compose.yml declares it
 * for the fleet); enforcing is achieved by REMOVING that setting, not by adding one.
 *
 * Reaching `enforce` therefore costs an operator nothing, and reaching `off` costs them a
 * deliberate, greppable, version-controlled act.
 *
 * MODES
 *   'enforce' (CODE DEFAULT) — the guards throw. A header-less `project_switch` and a
 *       header-less ambient write are rejected with a typed error naming the remedy.
 *   'shadow'  — compute the would-reject, LOG it and bump
 *       `project_scope_guard_shadow` (labeled by guard + op), then ACT AS TODAY (allow).
 *       The soak posture: gathers the real population of callers a flip would break,
 *       before it breaks them.
 *   'off'     — the guards are not evaluated at all. The escape hatch for an operator
 *       who hits an unforeseen break in the middle of the night; not a resting state.
 *
 * configs-not-hardcoded: the mode, its env name and its default live HERE, never as a
 * literal at a guard site. Same shape as sessionConfig.ts / projectBindingConfig.ts.
 */

/** The three postures. Ordered least→most enforcing for documentation only. */
export type ProjectScopeGuardMode = 'off' | 'shadow' | 'enforce';

export const PROJECT_SCOPE_GUARD_MODES: readonly ProjectScopeGuardMode[] = [
  'off',
  'shadow',
  'enforce',
] as const;

/**
 * The env name the mode is read from. Exported so tests and the compose-declaration
 * contract can reference the ONE string rather than re-typing it (a past incident #5).
 */
export const PROJECT_SCOPE_GUARD_ENV = 'MANDREL_PROJECT_SCOPE_GUARD';

/**
 * The value that applies when the setting is ABSENT or unrecognised. Named (not inlined)
 * so the polarity is a reviewable constant rather than a fifth argument somewhere: a diff
 * that flips this is a one-line decision, not a drift.
 */
export const PROJECT_SCOPE_GUARD_DEFAULT: ProjectScopeGuardMode = 'enforce';

/**
 * Read the mode from the environment. Case- and whitespace-insensitive; missing, empty or
 * UNRECOGNISED all resolve to PROJECT_SCOPE_GUARD_DEFAULT — i.e. a typo'd
 * `MANDREL_PROJECT_SCOPE_GUARD=shadwo` ENFORCES rather than silently disabling the guard
 * (unrecognised must never be the permissive branch).
 *
 * Exported (rather than only its memoized result) so a test can exercise the parse without
 * depending on module-load order — the static-import-evaluates-before-the-stub trap in
 * A past incident (b).
 */
export function readProjectScopeGuardMode(
  raw: string | undefined = process.env[PROJECT_SCOPE_GUARD_ENV] // env-read: MANDREL_PROJECT_SCOPE_GUARD
): ProjectScopeGuardMode {
  if (raw === undefined || raw.trim() === '') return PROJECT_SCOPE_GUARD_DEFAULT;
  const v = raw.trim().toLowerCase();
  return (PROJECT_SCOPE_GUARD_MODES as readonly string[]).includes(v)
    ? (v as ProjectScopeGuardMode)
    : PROJECT_SCOPE_GUARD_DEFAULT;
}

export interface CallerIdentityConfig {
  /**
   * unidentifiedGuardMode — off | shadow | enforce. See the polarity block above: ABSENT
   * MEANS ENFORCE. Env: MANDREL_PROJECT_SCOPE_GUARD. Code default: 'enforce'.
   */
  unidentifiedGuardMode: ProjectScopeGuardMode;
}

/** THE LIVE CONFIG — read once at module load, exactly like SESSION_CONFIG. */
export const CALLER_IDENTITY_CONFIG: CallerIdentityConfig = {
  unidentifiedGuardMode: readProjectScopeGuardMode(),
};
