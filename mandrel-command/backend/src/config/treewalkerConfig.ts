/**
 * TreeWalker backend configuration — the SINGLE named home for every TreeWalker
 * thread-endpoint tunable (house rule configs-not-hardcoded; mirrors the mcp-server
 * trustConfig.ts / recallConfig.ts pattern). The branch-walk caps and vocabulary, the spine-ribbon vocabulary, the outcome-edge set, the story captions, and the
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
  /**
   * Hard cap on the MEMBERS of one branch a thread returns (thread v2). Over the cap the
   * NEWEST `maxMembers` are kept (the spine always among them) and the response reports the
   * true `memberTotal` with `truncated: true`.
   */
  maxMembers: number;
  /** Hard cap on GHOST causes (non-member records a member leans on) a thread returns. */
  maxGhosts: number;
  /**
   * The branch-walk vocabulary (thread v2): which declared edges make a record a member of a
   * spine's thread, which make a non-member a ghost cause, and what is kept out. Nothing here
   * is a literal inside the service.
   */
  branch: {
    /** `links.provenance_class` an edge must carry to count for membership, ghosts or edges. */
    declaredProvenance: string;
    /** Edge types that, pointing TO the spine from a record, make that record a member. */
    strongEdgeTypes: readonly string[];
    /** Edge types a member points OUT through to a ghost cause (context it leans on). */
    ghostEdgeTypes: readonly string[];
    /** `mint_via` values that never confer membership (trunk plumbing, not story). */
    excludedMintVia: readonly string[];
    /** Context types that are the trunk, not story members (handoffs). */
    excludedContextTypes: readonly string[];
    /** A context carrying any tag starting with this is vitals noise, not a member. */
    excludedTagPrefix: string;
  };
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
     *  spine record). A spine with no name tag is labeled by its title (an earlier change
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
   *  an earlier decision / an earlier task deliberately does not touch it) — but the value
   *  actually applied is now ECHOED in the branches response as `cap`, alongside the
   *  full pre-cap `total`, so a caller can tell a truncated page from the whole set
   *  instead of inferring it from this env var. */
  branchListMax: number;
  /**
   * The Map view's branch-list window + milestone stations + the unbranched share. The
   * window default lives here so a caller omitting `sinceDays` and a caller passing it
   * go through ONE named value, and the response always ECHOES the window it applied.
   */
  map: {
    /** Default `sinceDays` for GET /treewalker/branches: only branches whose newest
     *  member landed inside this many days are listed. Default 45. */
    sinceDaysDefault: number;
    /** Hard ceiling on a caller-supplied `sinceDays` (bad/oversized values are clamped). */
    sinceDaysMax: number;
    /** Most milestone stations returned PER branch (oldest first). Default 12. */
    milestonesMax: number;
    /** Window, in days, of the `unbranched` share over the project's non-archived
     *  contexts. Default 60. */
    unbranchedWindowDays: number;
  };
  /**
   * The Why view (GET /treewalker/record/:id/why) vocabulary + caps: which declared edges
   * count as a record's CAUSES, which of them spawns "one hop further" records, which guessed
   * edge makes a SERIES, and how many spawned / before records are listed.
   */
  why: {
    /** Outgoing edge types that are causes, in the order their groups are returned. */
    causeEdgeTypes: readonly string[];
    /** The cause edge type whose TARGET decision has spawned records pointing back at it. */
    spawnEdgeType: string;
    /** The guessed edge type that joins a record to its series (either direction). */
    seriesEdgeType: string;
    /** Most spawned records listed per decision cause (newest first); the count is the true total. */
    spawnedMax: number;
    /** Most "just before" branch members listed (by createdAt, not by edge). */
    beforeMax: number;
  };
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
  maxMembers: envInt('MANDREL_TW_MAX_MEMBERS', 500),
  maxGhosts: envInt('MANDREL_TW_MAX_GHOSTS', 25),
  branch: {
    declaredProvenance: 'declared',
    strongEdgeTypes: [
      'informs',
      'decided_by',
      'built_by',
      'learned_from',
      'produced_outcome',
      'subtask_of',
      'depends_on',
    ],
    ghostEdgeTypes: ['decided_by', 'learned_from', 'depends_on'],
    excludedMintVia: ['trunk-ref', 'handoff-timeline'],
    excludedContextTypes: ['handoff'],
    excludedTagPrefix: 'alert',
  },
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
  map: {
    sinceDaysDefault: envInt('MANDREL_TW_BRANCH_SINCE_DAYS', 45),
    sinceDaysMax: envInt('MANDREL_TW_BRANCH_SINCE_DAYS_MAX', 3650),
    milestonesMax: envInt('MANDREL_TW_MAP_MILESTONES_MAX', 12),
    unbranchedWindowDays: envInt('MANDREL_TW_UNBRANCHED_WINDOW_DAYS', 60),
  },
  why: {
    causeEdgeTypes: ['decided_by', 'learned_from', 'depends_on', 'built_by', 'caused'],
    spawnEdgeType: 'decided_by',
    seriesEdgeType: 'possibly_supersedes',
    spawnedMax: envInt('MANDREL_TW_WHY_SPAWNED_MAX', 5),
    beforeMax: envInt('MANDREL_TW_WHY_BEFORE_MAX', 5),
  },
  captions: {
    decided: { relation: 'the why · ', relationTerm: 'decided_by' },
    spine: { relation: 'the spine · ', relationTerm: 'task opened' },
    informs: { relation: 'informs → ', relationTerm: 'spine' },
    now: { relation: 'you are here · ', relationTerm: 'resume point' },
    next: { relation: 'next · ', relationTerm: 'informs → spine' },
    walk: { relation: 'on the thread · ', relationTerm: 'linked' },
  },
};
