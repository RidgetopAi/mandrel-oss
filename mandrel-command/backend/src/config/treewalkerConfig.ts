/**
 * TreeWalker backend configuration — the SINGLE named home for every TreeWalker
 * thread-endpoint tunable (house rule configs-not-hardcoded; mirrors the mcp-server
 * trustConfig.ts / recallConfig.ts pattern). The traversal depth/caps, the resume-anchor
 * tag, the spine-ribbon vocabulary, the outcome-edge set, the story captions, and the
 * trust-derivation status buckets ALL live here — never a literal buried in the service.
 *
 * Numeric knobs read from env at module load with a safe fallback (bad/missing → default),
 * exactly like the mcp-server config modules, so an eval/tuning sweep needs no code edit.
 */

/** Read a positive-integer env var, else `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Story-step caption vocabulary: the fixed relation prefix + emphasised term per marker. */
export interface StoryCaption {
  relation: string;
  relationTerm: string;
}

export interface TreewalkerConfig {
  /** BFS max hop-depth from the anchor over the `links` graph (both directions). */
  maxDepth: number;
  /** Hard cap on the number of nodes a thread walk resolves (bounds a runaway traversal). */
  maxNodes: number;
  /** The tag that marks the live resume anchor context (newest wins) — the coordinator's boot ritual. */
  resumeTag: string;
  /**
   * The spine-ribbon (roots → tree → trunk → branch) DERIVATION knobs (PHASE 2).
   * Every tier label now RESOLVES FROM DATA; only the honest fallbacks (for a
   * project with no canonical doc / no handoffs / no spine) live here as strings.
   */
  spine: {
    /** Tags that mark a project's LOCKED root docs (the canonical / north-star records).
     *  The root tier resolves to the NEWEST live context carrying any of these. */
    rootTags: readonly string[];
    /** Honest fallback root label when no root-tagged doc exists (no id, no fake claim). */
    rootFallbackLabel: string;
    /** Honest trunk label when the project has no handoff contexts yet. */
    trunkEmptyLabel: string;
    /** Tag prefix that carries a branch's once-on-the-spine NAME (`branch:<name>` on the
     *  spine record). A spine with no name tag is labeled by its title (a4f8886d
     *  membership/identity split — the `branch:` TITLE-prefix hack is gone). */
    branchNameTagPrefix: string;
    /** The context-tag prefix that carries the real `tree:<x>` lineage tier. */
    treeTagPrefix: string;
    /** Fallback tree-tier label when the anchor carries no `tree:` tag and no project name. */
    treeFallbackLabel: string;
    /** Fallback branch label when no spine task resolves. */
    branchFallbackLabel: string;
    /** Max characters of a resolved root-doc title shown on the ribbon. */
    rootTitleMaxChars: number;
  };
  /** Hard cap on trunk-timeline entries returned by the trunk endpoint (bounded runtime;
   *  the count still reports the FULL total). */
  trunkMaxEntries: number;
  /** Hard cap on branch-list entries (newest-active first). Unchanged default (P1,
   *  an earlier decision deliberately does not touch it) — but the value
   *  actually applied is now ECHOED in the branches response as `cap`, alongside the
   *  full pre-cap `total`, so a caller can tell a truncated page from the whole set
   *  instead of inferring it from this env var. */
  branchListMax: number;
  /** The per-marker story captions (relation prefix + emphasised term). */
  captions: {
    decided: StoryCaption;
    spine: StoryCaption;
    informs: StoryCaption;
    now: StoryCaption;
    next: StoryCaption;
    /** Generic caption for a walked node with no special role (marker 'default'). */
    walk: StoryCaption;
  };
}

/** The LIVE config — read once at module load; numeric knobs env-overridable. */
export const TREEWALKER_CONFIG: TreewalkerConfig = {
  maxDepth: envInt('MANDREL_TW_MAX_DEPTH', 2),
  maxNodes: envInt('MANDREL_TW_MAX_NODES', 60),
  resumeTag: 'ref:resume',
  spine: {
    rootTags: ['ref:canonical', 'ref:north-star'],
    rootFallbackLabel: 'roots',
    trunkEmptyLabel: 'no handoffs yet',
    branchNameTagPrefix: 'branch:',
    treeTagPrefix: 'tree:',
    treeFallbackLabel: 'tree',
    branchFallbackLabel: 'thread',
    rootTitleMaxChars: 48,
  },
  trunkMaxEntries: envInt('MANDREL_TW_TRUNK_MAX_ENTRIES', 500),
  branchListMax: envInt('MANDREL_TW_BRANCH_LIST_MAX', 30),
  captions: {
    decided: { relation: 'the why · ', relationTerm: 'decided_by' },
    spine: { relation: 'the spine · ', relationTerm: 'task opened' },
    informs: { relation: 'informs → ', relationTerm: 'spine' },
    now: { relation: 'you are here · ', relationTerm: 'resume point' },
    next: { relation: 'next · ', relationTerm: 'informs → spine' },
    walk: { relation: 'on the thread · ', relationTerm: 'linked' },
  },
};
