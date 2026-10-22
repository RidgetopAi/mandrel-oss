/**
 * liveFeatureFlags.ts — the ONE structured read-back of every live feature flag.
 *
 * WHY THIS FILE EXISTS
 * ------------------------------------------------------
 * Until this change there were TWO things called "feature flags" in mcp-server and
 * only one of them was real:
 *
 *   * `utils/featureFlags.ts` (DELETED here) — a JSON `FeatureFlagStore` polling
 *     `<cwd>/../config/feature-flags.json`. That file was never shipped into the
 *     container image, so on prod the path resolved to `/config/feature-flags.json`,
 *     every read failed, and `getAllFlags()` returned `{}` forever. Measured on
 *     prod 2026-08-25: `docker logs mandrel-prod-mcp-server | grep -ci
 *     "FeatureFlags.*Unable to read config"` = 8500. It had ZERO behavioural
 *     consumers, so nine months of fleet-wide absence changed nothing — which is
 *     the empirical proof it was not load-bearing.
 *
 *   * the env-var named configs below — the mechanism actually proven on the fleet
 *     (the `MANDREL_PROJECT_SCOPE_GUARD` shape). Code default, compose-declared
 *     override, read back at boot and on `mandrel_status`.
 *
 * The deleted store's failure mode was the whole defect: a missing config resolved
 * to a SILENT empty map, so "flag off" and "flag subsystem broken" were the same
 * observation. The live configs cannot reproduce that, and this is why:
 *
 *   1. There is no external config FILE to be absent. Every value below resolves
 *      from an env var against a code default that ships in the binary, so the
 *      "config could not be read" state does not exist.
 *   2. Absent vs REJECTED is reported, not inferred: `threadTerminalitySource`
 *      distinguishes "off because unset" from "off because your value was
 *      rejected". An operator mid-revert can tell those apart without a data probe.
 *   3. The values are LOUD at two surfaces — one line per flag at startup
 *      (`main.ts`, the `*FlagSummary()` builders) and this object on
 *      `mandrel_status`. A flag whose OFF is indistinguishable from broken is not
 *      a flag.
 *
 * SINGLE SOURCE: `mandrel_status` (routes/system.routes.ts) and the
 * `aidis://status` MCP resource (server/MandrelMcpServer.ts getServerStatus) both
 * call THIS function. They previously disagreed by construction — status reported
 * the live configs while the resource reported the dead store's permanently-empty
 * map. Two surfaces answering "which flags are on?" differently is the reporting
 * half of the same defect.
 */
import { DECLARED_LIMBS_CONFIG } from './declaredLimbsConfig.js';
import { THREAD_TERMINALITY_CONFIG } from './threadTerminalityConfig.js';
import { TASK_EDGE_MINT_CONFIG } from './tagEdgeConfig.js';

export interface LiveFeatureFlags {
  declaredLimbsWriteTime: boolean;
  threadTerminality: string;
  threadTerminalitySource: string;
  taskEdgeMint: boolean;
}

/**
 * The EFFECTIVE value of every live flag, read from the same config objects the
 * write paths consult — never from a cached copy, so a read-back cannot claim a
 * state the product is not in.
 */
export function liveFeatureFlags(): LiveFeatureFlags {
  return {
    // declared_limbs stays NULL both when the derivation is switched off and when
    // it errors, so the data alone cannot answer "is it on?" — this can.
    declaredLimbsWriteTime: DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled,
    // BRANCH-2. The MODE is the read-back a revert is claimed from;
    // `modeSource` rides alongside because 'off because unset' and 'off because your
    // value was rejected' are different operational facts.
    threadTerminality: THREAD_TERMINALITY_CONFIG.mode,
    threadTerminalitySource: THREAD_TERMINALITY_CONFIG.modeSource,
    // the kill switch for task-source edge minting, read from the LIVE
    // config object (the value the write path consults), so "switched off" is
    // distinguishable from "minting and erroring".
    taskEdgeMint: TASK_EDGE_MINT_CONFIG.enabled,
  };
}
