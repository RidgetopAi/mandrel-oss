/**
 * HANDOFF WORKSTREAM LANE config (found by the workstreams smoke test).
 *
 * THE DEFECT THIS CONFIGURES AGAINST. Runtime workstreams tag each handoff `ws:<name>`
 * (coordinator / research / proj-<name>) and the runtime treats an UNTAGGED handoff as workstream
 * `coordinator`. services/handoffSupersession.ts used to pick the predecessor as the newest handoff
 * in the whole PROJECT, so a `ws:research` handoff superseded the live `ws:coordinator` head and the
 * coordinator's boot retracted its MODE and PATH.
 *
 * THE RULE (single source — SQL function `mandrel_handoff_lane`, migration 105, takes these two
 * values as arguments; nothing else may re-literal them):
 *   lane(handoff) = the value after the prefix of its FIRST tag starting with the prefix;
 *                   no such tag (or an empty value) -> the DEFAULT lane.
 * Untagged and `ws:coordinator` handoffs therefore share a lane. A tenant that never uses `ws:` tags
 * sees everything in the default lane — no behavior change.
 *
 * Read-at-call-time, like config/handoffHeadConfig.ts.
 */

/** Default tag prefix that marks a workstream lane. */
export const DEFAULT_HANDOFF_LANE_TAG_PREFIX = 'ws:';

/** Default lane name for a handoff carrying no lane tag (matches runtime handoff-head.sh). */
export const DEFAULT_HANDOFF_DEFAULT_LANE = 'coordinator';

function envNonEmpty(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Tag prefix marking a lane. Env: MANDREL_HANDOFF_LANE_TAG_PREFIX. */
export const READ_HANDOFF_LANE_TAG_PREFIX = (): string =>
  envNonEmpty('MANDREL_HANDOFF_LANE_TAG_PREFIX', DEFAULT_HANDOFF_LANE_TAG_PREFIX);

/** Lane of an untagged handoff. Env: MANDREL_HANDOFF_DEFAULT_LANE. */
export const READ_HANDOFF_DEFAULT_LANE = (): string =>
  envNonEmpty('MANDREL_HANDOFF_DEFAULT_LANE', DEFAULT_HANDOFF_DEFAULT_LANE);
