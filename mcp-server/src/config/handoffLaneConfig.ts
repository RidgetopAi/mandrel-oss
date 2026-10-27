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

/** Default lane name for a handoff carrying no lane tag; MANDREL_HANDOFF_DEFAULT_LANE names your runtime's own. */
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

/**
 * WRITE-SIDE PAIRING. The lane rule above is the READ rule — the boot hook
 * counts an untagged handoff as the default lane, and that stays. The WRITE side
 * (services/handoffSupersession.ts) no longer pairs on it: the timeline predecessor must carry
 * the EXACT same lane tag (untagged pairs only with untagged; `ws:x` only with `ws:x`), and an
 * explicitly named predecessor wins over the timeline altogether. This prefix marks that
 * explicit name: `supersedes:<id8|uuid>` on a handoff names the handoff it supersedes.
 * (The other explicit form, a single `context:<id>` tag, uses the threading-tag prefix owned
 * by config/tagEdgeConfig.ts — not re-literaled here.)
 */
export const DEFAULT_HANDOFF_SUPERSEDES_TAG_PREFIX = 'supersedes:';

/** Tag prefix naming an explicit handoff predecessor. Env: MANDREL_HANDOFF_SUPERSEDES_TAG_PREFIX. */
export const READ_HANDOFF_SUPERSEDES_TAG_PREFIX = (): string =>
  envNonEmpty('MANDREL_HANDOFF_SUPERSEDES_TAG_PREFIX', DEFAULT_HANDOFF_SUPERSEDES_TAG_PREFIX);
