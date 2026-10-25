/**
 * Gateway surface metadata — MCP-2026 rebuild, PHASE 2.
 *
 * The op registry (config/opRegistry.ts) owns opId → { gateway, action, … }: the FOLDING of
 * the 58 ops into gateways. What it does NOT carry is the GATEWAY-LEVEL presentation: each
 * gateway tool's own one-line (search-optimized) description and the display order of the 10
 * advertised tools. That is content, not a tunable — but it belongs in ONE named config file
 * (configs-not-hardcoded / anti-drift), never as literals scattered across the dispatcher, the
 * discover handler, and the lazy-envelope builder.
 *
 * SOURCE: rebuild plan §1.1 "the 10 advertised tools" table (verbatim one-liners). The action
 * ENUMS are NOT here — those are DERIVED from OP_REGISTRY so a new op can never drift from its
 * advertised action list.
 *
 * The three deliberately-FLAT tools (recall_thread / smart_search / get_recommendations) are
 * NOT gateways — they advertise their own registry description + real input schema, so they are
 * absent from this map. FLAT_ADVERTISE_ORDER records where they sit in the advertised list.
 */
import { smartSearchSourcesProse } from './searchMergeConfig.js';

/** The 7 action-discriminated gateway tools, in advertised display order (plan §1.1). */
export const GATEWAY_ORDER = [
  'discover',
  'context',
  'task',
  'decision',
  'project',
  'session',
  'graph',
] as const;

export type GatewayName = (typeof GATEWAY_ORDER)[number];

/** Gateway-level one-line descriptions (search-optimized: noun+verb front-loaded, no filler). */
export const GATEWAY_DESCRIPTIONS: Record<GatewayName, string> = {
  discover:
    "Explore Mandrel's tools: catalog of capabilities, full per-action schemas and examples on demand, server health/status.",
  context:
    'Durable memory: store, search (semantic + tags), and curate development contexts, handoffs, and refs.',
  task:
    'Project tasks: create, list/filter, update status/priority/assignee, bulk ops, progress summary.',
  decision:
    'Technical decisions with rationale, alternatives, and the outcome learning loop (record → evaluate).',
  project:
    'Projects: create, list, switch the active project, info/health insights, current-state briefing, move a record into another project.',
  session:
    'Work sessions: start/end/status of your current session; pin the session your writes attach to.',
  graph:
    'Typed-edge knowledge graph: link/unlink records, read a record’s edges, manage your branch position (open/current/close) so writes auto-thread to the branch you stand on.',
};

/**
 * The advertised order of the FLAT headline tools relative to the gateways. They advertise
 * AFTER the 7 gateways (plan §1.1 rows 9–10 + the also-kept get_recommendations). Order within
 * the flat block is the registry order, resolved by the surface builder.
 */
export const FLAT_ADVERTISE_ORDER = [
  'recall_thread',
  'smart_search',
  'get_recommendations',
] as const;

/**
 * TRIMMED lazy-list descriptions for the FLAT headline tools (plan §1.1 rows 9–10 + §11). The
 * registry descriptions are rich (recall_thread's is the moat's full pitch — ~150 tokens with 6
 * verbose param docs); on the lazy list they are trimmed to ~2 sentences and the lazy list drops
 * the per-param prose (the full contract stays one call away via discover.explain). This is the
 * plan's explicit remedy for the budget — "trim its description first, never demote it into a
 * gateway" — so recall_thread STAYS a flat, directly tool-searchable tool, just leaner on the list.
 */
export const FLAT_LAZY_DESCRIPTIONS: Record<string, string> = {
  recall_thread:
    'Read me in on the STORY of X and what to TRUST, in one call: resolve an anchor (ref:<slug> or a context/decision/task id), walk the typed-edge graph both ways, trust-rank the nodes, and return an ordered narrative — deterministic.',
  // DERIVED, not typed: the source list comes from SMART_SEARCH_DEFAULT_SOURCES so this
  // one-liner cannot go on advertising a source the handler no longer searches (it named
  // "code components" after that source was removed as dead).
  smart_search:
    `One search across ${smartSearchSourcesProse()} in the active project.`,
  get_recommendations:
    'AI-powered development recommendations (naming, implementation, architecture, testing) for the active project.',
};

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * LAZY+CORE classification (MCP-2026 rebuild Phase 3, the auditor recommendation).
 *
 * The plain lazy envelope advertises ONLY `{action:{enum}}`, which HIDES which params a WRITE
 * action requires + which closed enums are valid — so a model guessing the first call fails
 * deterministically exactly where the contract is un-guessable (measured: store's ContextType
 * enum, decision.record's 5 required params). "lazy+core" is a THIRD representation between lazy
 * and full: it lifts the REQUIRED-param hints (names + small closed enums) for un-guessable WRITE
 * actions into the lazy envelope, registry-derived (gatewaySurface.ts:liftCoreParams), so it can
 * never drift from the real per-branch contract. These two sets are the classification inputs.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/**
 * WRITE (state-mutating) action discriminators — gates which actions lazy+core considers.
 *
 * WHY A DOCUMENTED SET, NOT A REGISTRY FLAG: the op registry carries NO write/read signal today.
 * The only write-ish signal in-code is routes/index.ts `ACTION_TOOLS`, which is the narrow 3-op
 * session-attribution gate (context_store/task_create/decision_record) — not a general mutation
 * classifier. Rather than invent a per-op boolean (54 hand-maintained flags that would drift), we
 * classify by the ACTION VOCABULARY: an action whose verb mutates durable state. This is
 * O(vocabulary) not O(ops) — a new gateway op reusing one of these verbs is classified for free,
 * and the set is small + reviewable. Reads (search/list/get/recent/stats/details/info/insights/
 * status/catalog/explain/examples/progress/links/thread_current/graph/file/findings/ping/pin_get)
 * are DELIBERATELY excluded — lazy+core is about making un-guessable WRITE contracts guessable.
 */
export const WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'store', 'create', 'record', 'update', 'bulk_update', 'delete', 'restore', 'cancel',
  'switch', 'start', 'end', 'pin_set', 'pin_clear', 'link', 'unlink', 'thread_set',
  'thread_clear', 'scan',
  // Branch position (PHASE 1 positional membership): open/close mutate the
  // session's durable position row (branch_current stays a read, like thread_current).
  'branch_open', 'branch_close',
  // Mutable branch membership (P3): assign/unassign mutate the durable
  // branch_memberships row AND append to branch_membership_moves. branch_history stays a read.
  'branch_assign', 'branch_unassign',
  // Atomic task claim: acquire / extend / hand back exclusive ownership —
  // all three mutate durable state, so they classify as writes by the same verb rule.
  'claim', 'renew', 'release',
  // Reproject: `project.move` UPDATEs the record's project_id,
  // its followers' project_id and the stamps on its edges — a write by the same verb rule.
  // Its three required params are un-guessable as a SET (which record kind, which record,
  // which destination), so lifting them is what makes a first-call move possible.
  'move',
  // THE DECISION INBOX: `answer` UPDATEs
  // chosen/answered_at/answered_by/answer_status/alternatives_considered; `discuss` UPDATEs
  // answer_status/answer_note. Both mutate durable state by the same verb rule.
  'answer', 'discuss',
]);

/**
 * Identifier-like param names — a required param in this set is a GUESSABLE record handle / ref
 * (the model looks it up; the eval showed id-only writes already succeed first-call). An action
 * whose required params are ALL identifiers carries no un-guessable contract, so lazy+core does
 * NOT lift it (that keeps the budget on the params that actually move first-call success: content,
 * closed enums, multi-param record shapes). This set is used ONLY to decide whether an action is
 * worth lifting — once an action IS selected, ALL its required names are lifted (a complete
 * contract), identifiers included. Kept in sync with the ID_PARAM_ALIASES / $defs.Ref handle names.
 */
export const IDENTIFIER_PARAMS: ReadonlySet<string> = new Set([
  'id', 'ids', 'projectId', 'project', 'sessionId', 'taskId', 'decisionId', 'contextId',
  'task_ids', 'dependencies', 'supersededBy', 'jobId', 'scanId', 'from', 'to', 'anchor',
  // claimId is a RECORD HANDLE, not un-guessable content: the caller does
  // not invent it, it reads it back from the task claim response (exactly like sessionId /
  // jobId). Lifting it into the lazy envelope would spend budget teaching a model to copy a
  // value it was just handed.
  'claimId',
  // `spine` (branch_assign) is a RECORD HANDLE exactly like `id` — the caller
  // looks the branch up, it does not invent it. Without this, branch_assign's required
  // `spine` reads as un-guessable content and lazy+core lifts the whole action onto the
  // `graph` envelope, spending wire bytes on every tools/list to teach a model to pass an id.
  'spine',
]);

/**
 * READ action discriminators that carry an UN-GUESSABLE required param and are DELIBERATELY
 * not lifted into lazy+core — the acknowledged complement of WRITE_ACTIONS ( * A past incident). lazy+core lifts only WRITE contracts (the eval showed reads don't need it:
 * their un-guessable params are one discover.explain away, and a miss self-heals via the
 * strict-key error that names every required param — Change B). Same O(vocabulary) design as
 * WRITE_ACTIONS: classify the VERB, not per-op flags.
 *
 * WHY THIS SET EXISTS: the lazy+core COMPLETENESS guard (gatewaySurface.contract.test.ts §4c)
 * is deny-by-default — every gateway action whose required params include ≥1 un-guessable name
 * MUST be classified: in WRITE_ACTIONS (⇒ lifted, asserted on the advertised wire surface) or
 * in this set (⇒ excused, a read). A NOVEL verb (e.g. archive/publish) in neither set goes
 * RED, not silently unlifted — the fail-open hole this closes. The guard also REDs on a DEAD
 * excuse (an entry here matching no current registry action) and on any verb in BOTH sets, so
 * this list cannot rot into a stale allow-list.
 */
export const UNGUESSABLE_READ_ACTIONS: ReadonlySet<string> = new Set([
  'explain', 'examples',
]);
