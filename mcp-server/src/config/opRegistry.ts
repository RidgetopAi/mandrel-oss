/**
 * Canonical Operation Registry — MCP-2026 rebuild, PHASE 1.
 *
 * ONE source of truth for every Mandrel operation: `opId → { gateway, action,
 * category, kind, description, humanDescriptions }`, plus the zod input/output schema
 * reachable by `opId` (the zod validators already live in middleware/validation.ts
 * (`validationSchemas[opId]`) and config/outputSchemas.ts (`outputZodSchemas[opId]`) —
 * this registry references them by opId rather than re-declaring them, so there is still
 * exactly ONE zod schema per op).
 *
 * WHY THIS EXISTS (the class fix): before Phase 1 the advertised tool surface
 * (AIDIS_TOOL_DEFINITIONS) and the category grouping (TOOL_CATEGORIES) were TWO
 * hand-maintained lists that had to be kept in lockstep by discipline. This registry
 * makes them DERIVED artifacts of a single ordered source (config/toolDefinitions.ts
 * maps over OP_REGISTRY) — they physically cannot drift again.
 *
 * `opId` == today's flat tool name (e.g. `context_store`), exactly as the rebuild plan
 * §1.4 specifies. Phases 2–4 derive the gateway dispatcher + `discover` + the lazy
 * envelopes from THIS registry; Phase 1 changes ZERO wire bytes (guarded by the
 * toolSurface.golden byte-identical snapshot test).
 *
 * ORDERING IS LOAD-BEARING: OP_REGISTRY is an ordered array whose sequence MUST equal
 * the historical AIDIS_TOOL_DEFINITIONS order — the derived definitions array (and its
 * serialized `tools/list`) is byte-identical to pre-refactor only because this order is
 * preserved. TOOL_CATEGORIES is grouped from this same order (per-category first-seen),
 * which reproduces the historical intra-category order.
 *
 * configs-not-hardcoded: this file carries no tunables (no env, no magic numbers except
 * the shared TASK_BULK_MAX_IDS import, itself config-sourced). It is a static mapping.
 */

import { TASK_BULK_MAX_IDS } from './taskConfig.js';
import { CONTEXT_TYPES_LIST, GENERIC_CONTEXT_TYPE } from './contextTypes.js';
// The advertised lens-axis vocabulary is DERIVED from the enforced one, never re-typed:
// this description tells a user which values will thread, and a stale copy of it sends
// them to write tags the write boundary quarantines.
import { lensAxesSummary } from './threadingVocabConfig.js';
// DERIVED PROSE: the model-facing help text for the learning-loop enums is
// GENERATED from the single-source vocabulary, so a value can never be advertised in one
// tool's description and forgotten in another's. Before this, the implementation-status list
// was hand-typed in decision_record's and decision_update's humanDescriptions independently.
import {
  IMPLEMENTATION_STATUSES,
  IMPLEMENTATION_STATUS_DEFAULT,
  OUTCOME_STATUSES,
  ANSWER_STATUSES,
  ANSWER_STATUS_DEFAULT,
  vocabList,
} from './decisionVocab.js';
// Same DERIVED-PROSE move for smart_search's advertised source list: `component` was a dead
// source (no embedding column, 14 rows fleet-wide, scored by code complexity) that stayed
// advertised here after the handler stopped searching it. The list is now rendered from
// SMART_SEARCH_DEFAULT_SOURCES so what we advertise cannot disagree with what we search.
import { smartSearchSourcesJson, smartSearchSourcesPlus } from './searchMergeConfig.js';
// the advertised resume-pointer guarantee is DERIVED from the rule the write
// path applies, so the tool contract cannot drift from the behaviour (see the `type` and
// `tags` descriptions on context_store).
import {
  RESUME_POINTER_CONTEXT_TYPE,
  RESUME_POINTER_TAG,
} from './handoffResumePointerConfig.js';
// P5.4: the advertised mode vocabulary and the metadata path the fields land at are
// DERIVED from the config the write path reads, for the same reason as above — a tool
// description that names a storage path or a vocabulary by hand is a second copy that
// drifts, and the drift is invisible until a customer follows the wrong one.
// the un-narrowable session counts state their population in the contract
// with the SAME phrase the guard checks for — one string, not a description and a regex.
import { ARCHIVE_UNNARROWABLE_CONTRACT_PHRASE } from './archiveDisclosureConfig.js';
import {
  CARRIED_FIELDS_METADATA_KEY,
  CARRIED_FIELDS_MODE_KEY,
  CARRIED_FIELDS_SPINE_KEY,
  HANDOFF_MODE_VOCABULARY_DEFAULT,
} from './handoffCarriedFieldsConfig.js';

/**
 * Display categories (single source of the category vocabulary + display order).
 * Moved here from toolDefinitions.ts so the registry owns opId→category and
 * toolDefinitions re-exports these for its existing consumers (navigation.ts etc.).
 */
/**
 * an earlier task — appended to the three session ops whose per-session counts narrow by
 * `archived_at IS NULL` with NO flag, on purpose (see ARCHIVE_UNNARROWABLE_OPS for the
 * reasoning). The contract carries the phrase the guard checks for.
 */
const UNNARROWABLE_COUNTS_NOTE =
  ` Counts are over ${ARCHIVE_UNNARROWABLE_CONTRACT_PHRASE} and this op deliberately has no ` +
  `includeArchived: a session's counts are attribution of what it produced that is still ` +
  `findable. To see a session's archived records, pass its id with includeArchived:true to ` +
  `context_search / decision_search / task_list.`;

export const CATEGORY_ORDER = [
  'System Health',
  'Navigation',
  'Session Management',
  'Context Management',
  'Project Management',
  'Technical Decisions',
  'Task Management',
  'Smart Search & AI',
  'Linking & Graph',
] as const;

export type ToolCategory = (typeof CATEGORY_ORDER)[number];

/** A registry entry is either a gateway op (folds under a gateway+action) or a flat tool. */
export type OpKind = 'gateway' | 'flat';

/**
 * WHAT AN OP DOES TO PERSISTENT STATE. The single source the
 * unidentified-caller guards derive their POPULATION from — see services/callerIdentityGuard.ts.
 *
 * WHY IT LIVES HERE AND NOT IN THE GUARD. The guard's first draft would have anchored on
 * `ACTION_TOOLS` (routes/index.ts) — a 3-item set built for LAZY SESSION CREATION, not for
 * "is this a write". `link` (routes/links.routes.ts) is a write that resolves an ambient
 * project and is not in it; anchoring there would have shipped a guard with a hole shaped
 * exactly like the author's mental model. OP_REGISTRY is the ONE list every
 * op must appear in to exist at all, so classifying HERE makes the population a property of
 * the surface rather than of a second list someone must remember to update.
 *
 * TOTALITY IS COMPILER-ENFORCED: `effect` is REQUIRED on OpRegistryEntry, so an op added
 * without one does not compile (TS2741). There is no "unrecognised → allowed" branch to
 * fall through, which is the allow-list disease a past incident describes. The literal
 * classification of every op is ALSO pinned, value-by-value, in
 * src/tests/opEffectClassification.contract.test.ts — a test that READS this field could not
 * detect a change to it (a past incident #7), so the test states the values independently and a
 * reclassification becomes a deliberate two-file diff.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * HOW A VALUE IS DERIVED — by TRACING THE HANDLER, never from the op's name
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * The mechanism above was right on its first pass and the VALUES were not.
 * a scan-status poller shipped as 'read' while its handler called `persistScan()`, and its
 * sibling scan trigger shipped as 'write' while persisting nothing (its own comment said
 * persisting was the poller's job). A pair that is exactly BACKWARDS is the signature of
 * classifying by NAME — the very thing this field exists to prevent. Because the pin states
 * its values independently, both files agreed on the same wrong value and review could not
 * see it; only reading the handler could.
 *
 * So the rule is a question you answer by TRACING, transitively, into handlers/ and
 * services/ — not by reading the route body and not by reading the opId:
 *
 *     Does any path from this op's route handler reach an INSERT/UPDATE/DELETE — or a
 *     `persist…` / `record…` / `store…` call that performs one — which this op PRODUCES?
 *
 * TWO SHARED SIDE EFFECTS ARE EXCLUDED, BY NAME — they belong to the SERVER, not to the op.
 * Every call inherits them identically whether it reads or writes, and neither is anything
 * the caller asked to create:
 *
 *   E1  middleware/eventLogger.ts#logEvent → `INSERT INTO analytics_events`.
 *       Best-effort telemetry that swallows its own errors on purpose ("Don't throw - we
 *       don't want logging failures to break functionality"). Reached today by exactly these
 *       read-classified ops: context_search, decision_search, smart_search,
 *       get_recommendations.
 *   E2  services/session/infra/db/SessionRepo.ts#reactivate →
 *       `UPDATE sessions SET status='active' … WHERE id = $1`.
 *       The session resolver's idempotent re-attach, keyed by the caller's OWN session id.
 *       It resolves NO project, so it cannot land in a project the caller did not choose —
 *       the harm G2 exists to prevent is not reachable through it. Reached today by exactly
 *       this read-classified op: session_status.
 *
 * That exclusion is a JUDGMENT, recorded as one rather than hidden. Classifying those five
 * as 'write' would make G2 reject a header-less `context_search` — i.e. it would change READ
 * behaviour, which G3 says we deliberately do not do. It is overturnable in a two-file diff,
 * which is exactly why the pin restates the values instead of reading them.
 *
 *   'read'          persists nothing of its own (E1/E2 above excepted, by name).
 *                   Deliberately UNGUARDED (G3): re-keying reads would
 *                   create empty per-caller slots, and 5 of 7 tenants have no primary
 *                   project, so their auto-select falls to `projects[0] ORDER BY
 *                   updated_at DESC` — non-deterministic drift dressed up as a fix.
 *   'write'         persists data. G2's guarded population.
 *
 *                   DELIBERATELY THE WHOLE PERSISTING SET, not just the ops measured to
 *                   consume a rung-3 ambient resolution. The precise subset is a two-part
 *                   judgment ("does it persist" AND "does it resolve ambiently") that a
 *                   future author gets to re-make per op, and getting it wrong in the
 *                   permissive direction is silent. "Does it persist" is one question with
 *                   one answer you can read off the handler. The cost of the superset is
 *                   bounded and visible: an over-covered op is still callable by any caller
 *                   that sends X-Connection-ID (both bridges, the streamable transport and
 *                   stdio all do) or an explicit project — and it fails LOUD, naming both.
 *   'scope-switch'  persists the caller's INTERACTIVE PROJECT SLOT itself — the rung-3
 *                   state every other unidentified caller then inherits. G1's population.
 *                   Exactly one op today (`project_switch`, the only caller of
 *                   projectHandler.setCurrentProject with manualOverride).
 */
export type OpEffect = 'read' | 'write' | 'scope-switch';

export interface OpRegistryEntry {
  /** Canonical op id == today's flat tool name (the key every layer keys on). */
  opId: string;
  /**
   * What this op does to persistent state — REQUIRED, so a new op cannot be added
   * unclassified. Drives the unidentified-caller guards. See the OpEffect doc above.
   */
  effect: OpEffect;
  /** 'gateway' → resolves via (gateway, action); 'flat' → advertised as its own top-level tool. */
  kind: OpKind;
  /**
   * For a gateway op: the gateway tool name it folds under (e.g. 'context').
   * For a flat op: its own tool name (== opId) — it is its own front door.
   */
  gateway: string;
  /**
   * For a gateway op: the action discriminator value (e.g. 'store').
   * For a flat op: null (no action discriminator).
   */
  action: string | null;
  /** Single-source display category (drives TOOL_CATEGORIES + mandrel_help/discover.catalog). */
  category: ToolCategory;
  /** Tool-level description — the exact string advertised on tools/list (verbatim, byte-guarded). */
  description: string;
  /**
   * Per-parameter human-friendly help text, overlaid onto the zod-derived inputSchema by
   * config/toolDefinitions.ts:buildInputSchema. OVERLAY ONLY — it can never add/rename a
   * param the zod schema doesn't declare, so it cannot reintroduce schema drift.
   */
  humanDescriptions: Record<string, string>;
  /**
   * session_pin ONLY: the one op whose gateway exposes MULTIPLE actions that all resolve
   * back to this single flat op, discriminated by the flat tool's own `action` param
   * (rebuild plan §1.1 "pin_* flattening"). Maps gateway-action → the flat `action` value.
   * Phase 2's gateway dispatcher consumes this; Phase 1 ignores it.
   */
  gatewayActions?: Record<string, string>;
  /**
   * DOES THIS OP REPORT A COUNT OF SOFT-DELETABLE RECORDS? (the reviewer F1.)
   *
   * DENY BY DEFAULT: absent/false means "this op reports no such count". Set it to `true` on
   * every op that returns a number derived from `contexts`, `technical_decisions`, or `tasks`
   * — a total, a per-bucket breakdown, a per-session tally, or a rate computed over one of
   * those denominators. It does NOT mean "returns any number" (a similarity score, a byte
   * size, and a duration are all irrelevant here).
   *
   * WHY A DECLARED FLAG AND NOT A NAME PATTERN. The guard that keeps stats surfaces
   * reconciled with their search surfaces (src/tests/statsSearchCountReconcile.contract.test.ts)
   * used to derive its population by matching opIds against /(_stats|_insights|_progress_summary)$/.
   * That reads like a derivation and is really a memory of the names we had already seen. An
   * The reviewer wired two schema-complete ops into this registry to test it: `naming_stats`
   * tripped the guard, and `session_record_counts` PASSED SILENTLY — an entire family of
   * count-reporting session tools (session_status / session_get / session_list) was invisible
   * to the guard for no reason other than what it is called. They were, in fact, counting
   * archived rows on prod at the time.
   *
   * A flag moves the decision to declaration time: a new count-reporting tool cannot ship
   * without someone answering this question, whatever it ends up being named. Adding a field
   * here is cheap; remembering to name your tool `*_stats` is not a mechanism.
   *
   * The guard asserts containment over `OP_REGISTRY.filter(o => o.reportsCount)`, so setting
   * this to true obliges you to add a RECONCILE_MATRIX entry (reconciling, or pinned with a
   * written reason). That is the intended friction.
   */
  reportsCount?: boolean;
}

/**
 * THE REGISTRY — every op, in historical AIDIS_TOOL_DEFINITIONS order. (No bare count here
 * either; the COUNT HISTORY below records each surface change with the change that caused it.)
 * gateway/action follow the rebuild plan §2 old→new mapping (test-guarded).
 *
 * COUNT HISTORY: 58 → 60 when the session identity read model (Amp-orb eval W3)
 * added session_list / session_get — the instrument that lets an orchestrator VERIFY
 * attribution (which session produced a record, and who held it) instead of assuming it.
 * 54 → 57 when the atomic task claim
 * added task_claim / task_renew / task_release. 57 → 58 when the first-class artifact
 * reference added context_artifact — resolve WHERE an
 * accepted EXTERNAL artifact lives, its expected identity, and its FAIL-CLOSED verification
 * contract (Mandrel still stores no artifact bytes). Each is a deliberate, reviewed surface
 * change, so the byte-identical golden fixture was regenerated with it (SPEC §10).
 */
export const OP_REGISTRY: readonly OpRegistryEntry[] = [
  // ── System Health ────────────────────────────────────────────────────────────
  {
    opId: 'mandrel_ping',
    effect: 'read',
    kind: 'gateway', gateway: 'discover', action: 'ping',
    category: 'System Health',
    description: 'Test connectivity to Mandrel server',
    // STRICT-MODE: derive from zod so the schema is strict AND
    // surfaces the real `message` param the validator accepts (was hidden by a
    // hand-written empty `{}` — a drift the table-driven source now closes).
    humanDescriptions: {
      message: 'Optional message echoed back by the server (connectivity check)',
    },
  },
  {
    opId: 'mandrel_status',
    effect: 'read',
    kind: 'gateway', gateway: 'discover', action: 'status',
    category: 'System Health',
    description: 'Get Mandrel server status and health information',
    humanDescriptions: {},
  },

  // ── Navigation ───────────────────────────────────────────────────────────────
  {
    opId: 'mandrel_help',
    effect: 'read',
    kind: 'gateway', gateway: 'discover', action: 'catalog',
    category: 'Navigation',
    description: 'Display categorized list of all Mandrel tools',
    humanDescriptions: {},
  },
  {
    opId: 'mandrel_explain',
    effect: 'read',
    kind: 'gateway', gateway: 'discover', action: 'explain',
    category: 'Navigation',
    description: 'Get detailed help for a specific Mandrel tool',
    humanDescriptions: {
      toolName: 'Name of the tool to explain (e.g., "context_search", "project_list")',
    },
  },
  {
    opId: 'mandrel_examples',
    effect: 'read',
    kind: 'gateway', gateway: 'discover', action: 'examples',
    category: 'Navigation',
    description: 'Get usage examples and patterns for a specific Mandrel tool',
    humanDescriptions: {
      toolName: 'Name of the tool to get examples for (e.g., "context_search", "project_create")',
    },
  },
  {
    // THE AGENT CAPTURE CONTRACT (P4 L1). Answers the
    // question the P2 experiment measured agents getting wrong: not "should I write this
    // down" (11/11 did) but "what SHAPE does it go in" (5/13 got that). Its content is
    // GENERATED from this registry + config/captureVocab.ts, never hand-written — see
    // handlers/navigation.ts:getCaptureContract.
    opId: 'mandrel_contract',
    effect: 'read',
    kind: 'gateway', gateway: 'discover', action: 'contract',
    category: 'Navigation',
    description:
      'Get the agent CAPTURE CONTRACT: which records to write at which moment, the op that writes each, and the metadata.capture vocabulary (verified/believed/refuted — or absent, which is written by omitting the block) that makes them aggregatable. verified REQUIRES a sibling evidence citation.',
    humanDescriptions: {},
  },

  // ── Session Management ───────────────────────────────────────────────────────
  {
    opId: 'session_start',
    effect: 'write',
    kind: 'gateway', gateway: 'session', action: 'start',
    category: 'Session Management',
    description: 'Start a NEW work session for this connection. Finalizes the connection\'s current active session first (full productivity/analytics flush), then opens a fresh one. Optional title, goal, and project are stamped onto the session (the goal populates the Session View "Session Goal" field). Enforces one active session per connection.',
    humanDescriptions: {
      title: 'Optional short title for the new session',
      goal: 'Optional session goal (≤1000 chars) — populates the Session View "Session Goal" field',
      project: 'Optional. Project ID or name to attach the session to; defaults to the connection\'s current project',
    },
  },
  {
    opId: 'session_end',
    effect: 'write',
    kind: 'gateway', gateway: 'session', action: 'end',
    category: 'Session Management',
    description: 'End (finalize) this connection\'s current active session — runs the full close path (file sync, productivity, token/activity flush, analytics). Safe no-op if no session is active. The next content-producing action auto-starts a fresh session.',
    humanDescriptions: {},
  },
  {
    opId: 'session_status',
    // reportsCount: contextCount/taskCount/decisionCount on the identity record
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'session', action: 'status',
    category: 'Session Management',
    description: 'Show this connection\'s current active session (read-only): id, title, goal, project, counts, and duration. Returns a clean "no active session" state if none exists yet.' + UNNARROWABLE_COUNTS_NOTE,
    humanDescriptions: {},
  },
  {
    opId: 'session_list',
    // reportsCount: same identity record, per row
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'session', action: 'list',
    category: 'Session Management',
    description: 'List sessions for correlation (read-only): full session id, resolved actor, project, state, creation reason, timestamps, and context/task counts. Project-scoped by default (this connection\'s current project); filter by actor or open-only. Newest activity first. Use this to enumerate sessions and VERIFY which one produced a record — every context row reports its sessionId.' + UNNARROWABLE_COUNTS_NOTE,
    humanDescriptions: {
      project: 'Optional. Project ID or name to list. Defaults to this connection\'s current project.',
      allProjects: 'Optional. true = list across EVERY project instead of one (default false).',
      actor: 'Optional. Only sessions owned by this actor (the principal derived from X-Actor-ID / auth).',
      openOnly: 'Optional. true = only OPEN sessions (active, interrupted, or dormant — i.e. still resumable).',
      limit: 'Optional page size. Clamped to the configured ceiling; the response reports any clamp.',
      offset: 'Optional page offset (0-based).',
    },
  },
  {
    opId: 'session_get',
    // reportsCount: same identity record as session_status
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'session', action: 'get',
    category: 'Session Management',
    description: 'Get ONE session\'s full identity (read-only): full session id, resolved actor, project, state, creation reason (explicit | automatic-write), created/last-activity timestamps, and context/task/decision counts. Accepts a full UUID or an 8+-hex short id. A field that was never recorded is reported as NOT RECORDED with the reason — never a blank. An unknown id returns an explicit not-found, never an empty record.' + UNNARROWABLE_COUNTS_NOTE,
    humanDescriptions: {
      sessionId: 'The session to look up — full UUID or 8+-hex short id (e.g. the sessionId a context_search result reports).',
    },
  },
  {
    opId: 'session_pin',
    effect: 'write',
    kind: 'gateway', gateway: 'session', action: 'pin',
    // The one nested-action op: gateway actions pin_set/pin_get/pin_clear all resolve to
    // this flat op with the flat `action` param set accordingly (rebuild plan §1.1).
    gatewayActions: { pin_set: 'set', pin_get: 'get', pin_clear: 'clear' },
    category: 'Session Management',
    description: 'Pin "this is my session" for your actor (DB-persisted). action=set pins a session (sessionId, or your connection\'s current active session if omitted); action=get shows your current pin and whether it is still open; action=clear removes it. The pin is keyed to your derived actor (X-Actor-ID / authenticated user), so it survives client + server restarts. Note: in the current phase the pin is persisted but does not yet change which session your actions attach to.',
    humanDescriptions: {
      action: 'What to do: "set" (pin a session), "get" (read your current pin), or "clear" (remove it)',
      sessionId: 'For action=set: the session UUID to pin. Omit to pin your connection\'s current active session.',
    },
  },

  // ── Context Management ───────────────────────────────────────────────────────
  {
    opId: 'context_store',
    effect: 'write',
    kind: 'gateway', gateway: 'context', action: 'store',
    category: 'Context Management',
    description: 'Store development context with automatic embedding generation for semantic search',
    humanDescriptions: {
      content: 'The context content to store',
      type: `Context type: ${CONTEXT_TYPES_LIST}. \`${GENERIC_CONTEXT_TYPE}\` is the generic capture for anything that fits no other type — there is no "fact" type and it is not aliased. `
        + `SERVER-SIDE GUARANTEE: a \`${RESUME_POINTER_CONTEXT_TYPE}\` store ALWAYS ends up tagged \`${RESUME_POINTER_TAG}\` — `
        + `if you do not supply it, Mandrel APPENDS it (reported in the response as a tag note and as `
        + `structuredContent.context.resumePointer.added=true). Your other tags are never dropped or reordered, and `
        + `supplying it yourself changes nothing. This is what makes the NEWEST handoff resolvable by `
        + `context_search({tags:["${RESUME_POINTER_TAG}"]}), which is how boot/recall finds the live one.`,
      tags: 'Optional tags for categorization, filtering, and RECORD LINKING. Threading tags wire this context into the linked story: `task:<id8>` (belongs to a task thread), `decision:<id8>` (ladders to a decision), `context:<id8|uuid>`, plus lens axes ' + lensAxesSummary() + '. A `ref:<slug>` tag (`ref:[a-z0-9-]+`) is a memorable named pointer resolvable via context_search({tags:["ref:<slug>"]}). Malformed ref/threading tags are normalized on write and reported, never rejected; a threading value the grammar cannot use (e.g. `scope:mandrel`) is stored QUARANTINED as `invalid-<tag>` so it is never mistaken for a working threading tag. '
        + `A \`${RESUME_POINTER_CONTEXT_TYPE}\` additionally gets \`${RESUME_POINTER_TAG}\` appended by the server when absent (see \`type\`).`,
      relevanceScore: 'Optional importance score 0–10 (default 5) feeding the hierarchical-memory ranking',
      metadata: 'Optional structured metadata (jsonb object) stored on the context. The tool-native way to carry STRUCTURED back-links, e.g. {"parent_task":"<uuid>","parent_decision":"<uuid>","origin_context":"<uuid>"} — round-trips and is retrievable via context_search.',
      links: 'Optional array of typed edges to mint FROM this context to other records (first-class linking). Each item is EITHER explicit {"edgeType":"<one of the edge-type vocab>","to":"<id8|uuid>","toType":"task|decision|context"} OR shorthand {"task":"<ref>"} | {"decision":"<ref>"} | {"context":"<ref>"} (→ informs / decided_by / learned_from). Refs accept an id8 or full UUID, resolved in the current project. A bad/unresolvable link is reported as a warning (link notes) but NEVER blocks the store — the context + the good links still save.',
      mode: 'Optional, `handoff` only. The WORKING MODE this handoff hands forward — the '
        + 'single line a resuming session reads first ("what are we doing, and what should I '
        + `NOT do"). Suggested vocabulary: ${HANDOFF_MODE_VOCABULARY_DEFAULT.join(' | ')} `
        + '(override per deployment with MANDREL_HANDOFF_MODE_VOCABULARY). ANY string is '
        + 'ACCEPTED: an unrecognised mode is STORED and RENDERED with a note, never rejected — '
        + 'a handoff is never lost over its mode. Normalized (trimmed, lower-cased, '
        + `spaces/underscores to hyphens) and stored at metadata.${CARRIED_FIELDS_METADATA_KEY}.${CARRIED_FIELDS_MODE_KEY}; `
        + 'project_briefing renders it as the MODE line. Omit it and the line reads '
        + '"(none recorded)" — there is deliberately NO default mode, because a mode nobody '
        + 'chose is a fabricated instruction.',
      spine: 'Optional, `handoff` only. The RECORD THIS HANDOFF RESUMES — a task, decision OR '
        + 'context (id8 or full UUID); it is not restricted to tasks. This is the id a resuming '
        + `session runs \`branch_open <id8>\` on. Stored at metadata.${CARRIED_FIELDS_METADATA_KEY}.${CARRIED_FIELDS_SPINE_KEY}; `
        + 'project_briefing renders it as the SPINE line and resolves what it names AT READ '
        + 'TIME, so a renamed or archived spine reads as it is today rather than as its author '
        + 'left it. A reference that resolves to nothing is stored and labelled unresolved, '
        + 'never rejected.',
      noAutoThread: 'Optional. When true, SKIP the automatic active-thread edges for THIS store (the session has an active thread via thread_set, but this capture should not thread onto it). Auto-threading is also skipped automatically whenever you pass an explicit `links` arg.',
      projectId: 'Project ID or name to store under (defaults to current project)',
      sessionId: 'Session ID to attribute this context to (defaults to the active session)',
    },
  },
  {
    opId: 'context_search',
    // reportsCount: `total` — a COUNT over `contexts` on the search filter
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'context', action: 'search',
    category: 'Context Management',
    description: 'Search stored contexts using semantic similarity and filters, or fetch a specific context by ID. Provide at least one of: id, query, or a non-empty tags array (a tags-only call filters by tags).',
    humanDescriptions: {
      id: 'Context UUID or 8+-hex short id for direct lookup (bypasses semantic search; returns full content)',
      query: 'Free-text search query, matched by semantic similarity (optional if id or tags provided). There is NO key:value query syntax: "id:<uuid>", "type:<t>" and "tags:<t>" are rejected as errors — use the id / type / tags parameters instead.',
      type: `Filter by context type (${CONTEXT_TYPES_LIST})`,
      tags: 'Filter by tags (e.g., ["ref:cp-gaps"]); a non-empty tags array enables a tags-only search with no query',
      limit: 'Maximum number of results to return (default 10)',
      minSimilarity: 'Minimum similarity threshold (0-100) to include a result',
      offset: 'Number of leading results to skip (pagination)',
      // `response_format` is DELIBERATELY ABSENT from this map (SEARCH P3,       // an earlier decision). It is still ACCEPTED as a deprecated alias (concise->summary,
      // detailed->full) because it is shipped on customer instances we do not control, but
      // it is no longer ADVERTISED — `altitude` is the parameter, and a surface that
      // documents two names for one idea is how we got three.
      altitude: 'Volume: "headline" (id/type/title/url/trust — NO body key at all) | "summary" (+ the body clipped to the snippet budget, with a clipped-N-more affordance) | "full" (+ the whole body). ONE parameter with the same three values on every read tool, and it moves BOTH channels (the text and structuredContent). To fetch one whole record, set the id parameter (id="<id>") rather than putting it in query.',
      projectId: 'Project ID or name to scope the search (defaults to current project)',
      sessionId: 'Session ID to scope the search',
      dateFrom: 'Only include contexts created at/after this ISO timestamp (created_at >= dateFrom)',
      dateTo: 'Only include contexts created at/before this ISO timestamp (created_at <= dateTo)',
    },
  },
  {
    opId: 'context_get_recent',
    // reportsCount: `total` — the size of the returned window over `contexts`
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'context', action: 'recent',
    category: 'Context Management',
    description: 'Get recent contexts in chronological order (newest first)',
    humanDescriptions: {
      limit: 'Maximum number of recent contexts to return (default 5, max 20)',
      // `response_format` is DELIBERATELY ABSENT — deprecated alias, see context_search.
      altitude: 'Volume: "headline" (id/type/url/trust — NO body key at all) | "summary" (+ the body clipped to the snippet budget) | "full" (+ the whole body). ONE parameter with the same three values on every read tool, moving BOTH the text and structuredContent channels.',
      projectId: 'Project ID or name to scope the results (defaults to current project)',
    },
  },
  {
    opId: 'context_update',
    effect: 'write',
    kind: 'gateway', gateway: 'context', action: 'update',
    category: 'Context Management',
    description: 'Edit a stored context (content, tags/re-thread, metadata, relevanceScore). Provide at least one field. metadata is MERGED over the existing object (set a key to null to delete it) — it is NOT replaced wholesale. Accepts a full UUID or short id; project-scoped.',
    humanDescriptions: {
      contextId: 'Context UUID or 8+-hex short id to edit (project-scoped)',
      content: 'New full content (replaces the stored content; re-embeds for search)',
      tags: 'New tag set (REPLACES tags) — re-tag/re-thread, e.g. ["task:9e25dac7","scope:product"]. Malformed threading/ref tags are normalized + reported, never rejected; an unusable threading value is stored QUARANTINED as `invalid-<tag>`.',
      metadata: 'Structured metadata to MERGE over the existing object (shallow). Set a key to null to DELETE just that key; omitted keys are preserved (no silent data loss).',
      relevanceScore: 'New importance score 0–10',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'context_stats',
    // reportsCount: total/by-type/recent/embedded counts over `contexts`
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'context', action: 'stats',
    category: 'Context Management',
    description: 'Get context statistics for a project. Archived (soft-deleted) contexts are EXCLUDED from every count by default, so these numbers reconcile with context_search.',
    humanDescriptions: {
      projectId: 'Project ID or name to scope the stats (defaults to current project)',
      includeArchived: 'Include archived contexts in every count (default false — matches context_search so the two tools reconcile)',
    },
  },
  {
    opId: 'context_artifact',
    effect: 'read',
    kind: 'gateway', gateway: 'context', action: 'artifact',
    category: 'Context Management',
    description:
      'Resolve the EXTERNAL ARTIFACT a record points at: where it lives, what its expected identity is (hash / head / base), and the exact steps to retrieve and verify it. Mandrel never stores the artifact itself — this returns the retrieval + verification contract so a fresh agent can locate an accepted artifact deterministically instead of reading a handoff for clues. Pass observedSha256/observedHead to have the fetched artifact ADJUDICATED: verification is FAIL-CLOSED, so a mismatch is a hard error (never a warning) and a partial check is never an acceptance.',
    humanDescriptions: {
      id: 'Record UUID or 8+-hex short id whose metadata carries the artifact reference(s) — a context (e.g. a handoff), task, or decision',
      recordType: 'Optional record type to look in: context | task | decision. Omit to search all three (an id matching more than one is reported, never silently picked).',
      index: 'Which reference to adjudicate when observed* are supplied (default 0). Resolution always returns EVERY reference on the record.',
      observedSha256: 'The content hash you MEASURED on the artifact you fetched (e.g. `sha256sum <file>`). Supplying it requests an acceptance adjudication — a mismatch BLOCKS with an error.',
      observedHead: 'The git revision you MEASURED (e.g. `git bundle list-heads` / `git rev-parse`). An abbreviated expected head is confirmed by a full observed one; an observation shorter than the expectation can never confirm it.',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'context_delete',
    effect: 'write',
    kind: 'gateway', gateway: 'context', action: 'delete',
    category: 'Context Management',
    description: 'Soft-delete (archive) a context — hides it from default search/recent but does NOT permanently delete it (reversible via context_restore). Accepts a full UUID or short id; project-scoped.',
    humanDescriptions: {
      contextId: 'Context UUID or 8+-hex short id to archive (project-scoped)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'context_restore',
    effect: 'write',
    kind: 'gateway', gateway: 'context', action: 'restore',
    category: 'Context Management',
    description: 'Restore (un-archive) a previously soft-deleted context so it appears in default search/recent again. Accepts a full UUID or short id; project-scoped.',
    humanDescriptions: {
      contextId: 'Context UUID or 8+-hex short id to restore (project-scoped)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },

  // ── Project Management (note: project_insights is registered later, at its
  //    historical position after get_recommendations, but categorized here) ──────
  {
    opId: 'project_list',
    // reportsCount: contextCount per project when includeStats is set
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'project', action: 'list',
    category: 'Project Management',
    description: 'List all available projects with statistics',
    humanDescriptions: {
      includeStats: 'Include per-project statistics in the result (accepts true/false)',
      includeArchived: 'Optional. With includeStats, contextCount counts LIVE contexts by default (archived excluded, and the response discloses how many); true counts archived contexts too.',
      limit: 'Max projects to return per page (default 20, max 100). Truncation is reported as "showing N of M".',
      offset: 'Number of projects to skip for pagination (default 0). Page with limit+offset.',
    },
  },
  {
    opId: 'project_create',
    effect: 'write',
    kind: 'gateway', gateway: 'project', action: 'create',
    category: 'Project Management',
    description: 'Create a new project',
    humanDescriptions: {
      name: 'Unique project name',
      description: 'Optional human-readable description of the project',
      status: 'Optional initial status — one of: active, archived, completed, paused (default: active)',
      gitRepoUrl: 'Optional git repository URL',
      rootDirectory: 'Optional root directory path',
      metadata: 'Optional structured metadata (jsonb object) persisted on the project',
    },
  },
  {
    opId: 'project_update',
    effect: 'write',
    kind: 'gateway', gateway: 'project', action: 'update',
    category: 'Project Management',
    description: 'Update an existing project (name, description, status, and/or metadata) identified by id or name',
    humanDescriptions: {
      project: 'Project ID or name to update',
      name: 'New project name (must be unique)',
      description: 'New description (pass empty string to clear)',
      status: 'New status — one of: active, archived, completed, paused',
      gitRepoUrl: 'New git repository URL',
      rootDirectory: 'New root directory path',
      metadata: 'New structured metadata (jsonb object) to persist on the project',
    },
  },
  {
    opId: 'project_delete',
    effect: 'write',
    kind: 'gateway', gateway: 'project', action: 'delete',
    category: 'Project Management',
    description: 'Delete a project (by id or name). DESTRUCTIVE: cascade-deletes all owned contexts, decisions, tasks, and sessions. Refuses non-empty projects unless confirm:true.',
    humanDescriptions: {
      project: 'Project ID or name to delete',
      confirm: 'Must be true to delete a non-empty project (acknowledges cascade-deletion of all owned data). Default: false',
    },
  },
  {
    opId: 'project_switch',
    effect: 'scope-switch',
    kind: 'gateway', gateway: 'project', action: 'switch',
    category: 'Project Management',
    description: 'Switch to a different project (sets it as current active project)',
    humanDescriptions: {
      project: 'Project ID or name',
    },
  },
  {
    opId: 'project_current',
    effect: 'read',
    kind: 'gateway', gateway: 'project', action: 'current',
    category: 'Project Management',
    description: 'Get the currently active project information',
    humanDescriptions: {},
  },
  {
    opId: 'project_info',
    // reportsCount: contextCount — contexts joined per project
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'project', action: 'info',
    category: 'Project Management',
    description: 'Get detailed information about a specific project',
    humanDescriptions: {
      project: 'Project ID or name',
      includeArchived: 'Optional. contextCount counts LIVE contexts by default (archived excluded, and the response discloses how many); true counts archived contexts too.',
    },
  },
  {
    opId: 'project_briefing',
    // TRACED read: gatherBriefingData() runs SELECTs only (contexts/tasks/
    // technical_decisions/links); trustForRecords reads links + outcome tables. No
    // INSERT/UPDATE/DELETE on any path this op produces.
    effect: 'read',
    kind: 'gateway', gateway: 'project', action: 'briefing',
    category: 'Project Management',
    description:
      'Deterministic current-state briefing of a project as injection-ready markdown: the latest ' +
      'non-superseded handoff (full text), open tasks with full descriptions, live decisions with ' +
      'their rationale (grouped by decision type), convention/constraint contexts, and a dead-ends ' +
      'section of superseded records. Complete records only — the size cap drops whole records, ' +
      'least-protected first, never truncates. Trust annotations ride inline.',
    humanDescriptions: {
      project: 'Optional. Project ID or name (defaults to current project)',
      spine: 'Optional. Branch spine to scope the briefing to (context/decision/task id, ' +
        'full UUID or 8+-hex short id). Wins over the connection\'s open branch position. ' +
        'Requires MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED; refused (and reported in ' +
        'structuredContent.briefing.spineRefusal) when that flag is off.',
    },
  },
  {
    // REPROJECT. The ONE thing project membership could not do:
    // change. Every other mutating op resolves its record INSIDE one project and therefore
    // cannot cross the boundary, so a record misfiled by a project-slot bleed stayed
    // misfiled permanently. Implementation: services/reproject.ts (the edge policy) +
    // config/reprojectConfig.ts (which denormalized project_id columns follow a move).
    opId: 'project_move_record',
    effect: 'write',
    kind: 'gateway', gateway: 'project', action: 'move',
    category: 'Project Management',
    description:
      'MOVE a record (context, decision or task) into another project, preserving its id, its ' +
      'created_at, its session provenance and its typed edges — the same rows, refiled. Not a ' +
      'copy: nothing is re-created, so the /r/<id8> permalink and every inbound edge survive. ' +
      'Edges whose other endpoint stays behind are KEPT and marked cross-project; nothing is ' +
      'deleted, and moving the record back undoes it.',
    humanDescriptions: {
      recordType: 'Which kind of record to move: context, decision or task',
      recordId: 'The record\'s id (full UUID or 8+-hex short id). Resolved ACROSS projects — the record you are moving is, by definition, not in yours',
      toProject: 'Project ID or name to move the record INTO. REQUIRED — a move has no ambient default on either end',
    },
  },

  // ── Technical Decisions ──────────────────────────────────────────────────────
  {
    opId: 'decision_record',
    effect: 'write',
    kind: 'gateway', gateway: 'decision', action: 'record',
    category: 'Technical Decisions',
    description: 'Record a technical decision with full context and alternatives. Captures the learning loop: set success_criteria up front, then evaluate later via decision_update. Set answerStatus:"open" (with question + options) to file it in the DECISION INBOX instead of a fait accompli — see decision_answer/decision_discuss.',
    humanDescriptions: {
      decisionType: 'REQUIRED. One of EXACTLY these values: architecture, library, framework, pattern, api_design, database, deployment, security, performance, ui_ux, testing, tooling, process, naming_convention, code_style',
      title: 'REQUIRED. Short decision title',
      description: 'REQUIRED. What was decided (the decision itself)',
      rationale: 'REQUIRED. Why this decision was made (the reasoning/trade-offs)',
      impactLevel: 'REQUIRED. One of EXACTLY these values: low, medium, high, critical',
      alternativesConsidered: 'Optional. Array of { name, pros?, cons?, reasonRejected } alternatives that were rejected',
      problemStatement: 'Optional. The problem this decision solves',
      successCriteria: 'Optional but recommended. What "success" looks like — the measurable bar this decision will later be evaluated against (the learning loop starts here)',
      implementationStatus: `Optional. One of: ${vocabList(IMPLEMENTATION_STATUSES)} (defaults to "${IMPLEMENTATION_STATUS_DEFAULT}")`,
      affectedComponents: 'Optional. Array of component names this decision affects',
      tags: 'Optional. Array of tags for searchability',
      answerStatus: `THE DECISION INBOX. Optional. One of: ${vocabList(ANSWER_STATUSES)} (defaults to "${ANSWER_STATUS_DEFAULT}" — omit this and record behaves exactly as before). Setting "open" REQUIRES a non-empty \`question\` and >=2 \`options\`, each with >=1 pro and >=1 con — refused with a typed [DECISION_OPEN_INVALID:<field>] error naming exactly what's missing, and NOTHING is written, otherwise.`,
      question: 'Required when answerStatus:"open" (else optional/ignored). The one sentence being decided — what the operator is answering in seconds.',
      options: 'Required (>=2) when answerStatus:"open". Array of { key, label, pros: string[] (>=1), cons: string[] (>=1), recommended?: boolean }. `key` is what decision_answer selects on — must be unique.',
      deadline: 'Optional. ISO-8601 timestamp: when this decision needs an answer by. Purely informational — nothing auto-transitions on it.',
      links: 'Optional array of typed edges to mint FROM this decision to other records (first-class linking). Each item is EITHER explicit {"edgeType":"<one of the edge-type vocab>","to":"<id8|uuid>","toType":"task|decision|context"} OR shorthand {"task":"<ref>"} | {"decision":"<ref>"} | {"context":"<ref>"} (→ informs / decided_by / learned_from). Refs accept an id8 or full UUID, resolved in the current project. A bad/unresolvable link is reported as a warning (link notes) but NEVER blocks the record — the decision + the good links still save.',
      projectId: 'Optional. Project ID or name (defaults to current project)',
      metadata: 'Optional. Arbitrary metadata object',
    },
  },
  {
    opId: 'decision_search',
    // reportsCount: `total` — countDecisions() over `technical_decisions`
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'decision', action: 'search',
    category: 'Technical Decisions',
    description: 'Search technical decisions with various filters. answerStatus:"open" is the DECISION INBOX read — every decision waiting on a human.',
    humanDescriptions: {
      query: 'Free-text search query (optional; omit for pure filter-based search). There is NO key:value query syntax: "id:<uuid>", "type:<t>", "tags:<t>" and the other filter names are rejected as errors — use the matching parameter, or pass a BARE id token to look one up.',
      decisionType: 'Filter by decision type (architecture, library, framework, pattern, api_design, database, deployment, security, performance, ui_ux, testing, tooling, process, naming_convention, code_style)',
      status: 'Filter by LIFECYCLE status (active, deprecated, superseded, under_review). NOTE: this is NOT the outcome — use outcomeStatus to filter how a decision turned out.',
      outcomeStatus: `Filter by OUTCOME (how it turned out) — one of EXACTLY: ${vocabList(OUTCOME_STATUSES)}. This is the learning-loop result column (separate from status); use it to read back e.g. all the decisions that FAILED.`,
      implementationStatus: `Filter by BUILD lifecycle — one of EXACTLY: ${vocabList(IMPLEMENTATION_STATUSES)}. A THIRD column, separate from BOTH status (lifecycle) and outcomeStatus (result): it answers "was the thing we decided actually DONE?". This is how you list the HALF-EXECUTED decisions — implementationStatus:'${IMPLEMENTATION_STATUS_DEFAULT}' with status:'active' and sortDirection:'oldest' is the staleness list.`,
      answerStatus: `THE DECISION INBOX filter — one of EXACTLY: ${vocabList(ANSWER_STATUSES)}. A FOURTH column, separate from status/outcomeStatus/implementationStatus above: "has a human actually chosen an option yet?" answerStatus:'open' is the inbox — every decision carrying a question + options and waiting on decision_answer/decision_discuss.`,
      impactLevel: 'Filter by impact level (low, medium, high, critical)',
      component: 'Filter by affected component name',
      tags: 'Filter by tags',
      limit: 'Maximum number of results to return (default 10, max 100)',
      offset: 'Pagination window START (0-based, default 0). Combine with `limit` to enumerate a match set LARGER than the 100-row limit — the response reports total/returned/offset/hasMore so you know when you have them all.',
      sortDirection: 'Order by decision date: "newest" (default, DESC) or "oldest" (ASC). On a free-text query this is the tiebreaker AFTER relevance. Use "oldest" for staleness questions ("planned the longest").',
      projectId: 'Project ID or name to scope the search (defaults to current project)',
      includeOutcome: 'Include recorded outcome/lessons in results (accepts true/false)',
    },
  },
  {
    opId: 'decision_get',
    effect: 'read',
    kind: 'gateway', gateway: 'decision', action: 'get',
    category: 'Technical Decisions',
    description: 'Fetch a SINGLE technical decision by id with FULL detail — every field, including the learning-loop outcome (outcome_status, outcome notes, lessons learned). The precise by-id read for the learning loop; bypasses search. Accepts a full UUID or 8+-hex short id (copy the 🆔 ID from decision_search/decision_record).',
    humanDescriptions: {
      decisionId: 'REQUIRED. UUID or 8+-hex short id of the decision to fetch.',
      projectId: 'Optional. Project ID or name (informational scope; the decision resolves by id alone).',
    },
  },
  {
    opId: 'decision_update',
    effect: 'write',
    kind: 'gateway', gateway: 'decision', action: 'update',
    category: 'Technical Decisions',
    description: 'Update a decision after the fact — close the learning loop: set outcome_status + lessons_learned once you know how it turned out. Also edits status, implementation_status, supersession, and now title/description/tags/metadata. metadata is MERGED (set a key to null to delete it), not replaced.',
    humanDescriptions: {
      decisionId: 'REQUIRED. UUID or 8+-hex short id of the decision to update',
      status: 'Optional. One of: active, deprecated, superseded, under_review',
      outcomeStatus: `Optional. How the decision turned out — one of EXACTLY: ${vocabList(OUTCOME_STATUSES)}`,
      outcomeNotes: 'Optional. Free-text notes on the outcome',
      lessonsLearned: 'Optional. What was learned — the payoff of the learning loop',
      implementationStatus: `Optional. One of: ${vocabList(IMPLEMENTATION_STATUSES)}`,
      successCriteria: 'Optional. Set/revise the success criteria the outcome is judged against',
      problemStatement: 'Optional. Set/revise the problem this decision solves',
      supersededBy: 'Optional. UUID or 8+-hex short id of the decision that supersedes this one (also flips status to superseded)',
      supersededReason: 'Optional. Why this decision was superseded',
      title: 'Optional. New decision title (re-embeds for search)',
      description: 'Optional. New decision description (re-embeds for search)',
      tags: 'Optional. New tag set (REPLACES tags) for searchability / re-threading',
      metadata: 'Optional. Structured metadata to MERGE over the existing object (shallow). Set a key to null to DELETE it; omitted keys are preserved.',
      answerStatus: `THE DECISION INBOX. Optional. One of: ${vocabList(ANSWER_STATUSES)}. Setting "open" is validated against the MERGED row (this call's question/options if supplied, else the existing row's) — refused with a typed [DECISION_OPEN_INVALID:<field>] error if it wouldn't carry a non-empty question and >=2 well-formed options, and nothing is written. Prefer decision_answer/decision_discuss to ADVANCE an open decision — this is for editing the inbox fields directly.`,
      question: 'Optional. Set/revise the one-sentence question (see answerStatus).',
      options: 'Optional. REPLACES the options array (see answerStatus). Array of { key, label, pros: string[], cons: string[], recommended?: boolean }.',
      deadline: 'Optional. ISO-8601 timestamp, or null to clear it.',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'decision_answer',
    effect: 'write',
    kind: 'gateway', gateway: 'decision', action: 'answer',
    category: 'Technical Decisions',
    description: 'THE DECISION INBOX: answer an open/discussing decision by picking one of its options. Sets chosen/answered_at/answered_by, flips answer_status to "decided", and folds every NON-chosen option into alternatives_considered (so the learning loop keeps working). Refused — row unchanged — if the decision is already decided, or `option` is not one of its own option keys.',
    humanDescriptions: {
      decisionId: 'REQUIRED. UUID or 8+-hex short id of the decision to answer',
      option: "REQUIRED. The `options[].key` of the chosen option (from decision_get/decision_search's result).",
      note: 'Optional. Why this option was chosen. Folded into every NON-chosen option\'s alternatives_considered.reasonRejected (default "not chosen" when omitted).',
      projectId: 'Optional. Project ID or name to scope short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'decision_discuss',
    effect: 'write',
    kind: 'gateway', gateway: 'decision', action: 'discuss',
    category: 'Technical Decisions',
    description: 'THE DECISION INBOX escape hatch: kick an open decision back for more context instead of answering it. Sets answer_status="discussing" and APPENDS `note` to the decision\'s running note log. Refused — row unchanged — once the decision is already decided.',
    humanDescriptions: {
      decisionId: 'REQUIRED. UUID or 8+-hex short id of the decision to discuss',
      note: 'Optional. What needs more context, appended to the decision\'s note log.',
      projectId: 'Optional. Project ID or name to scope short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'decision_stats',
    // reportsCount: nine aggregates over `technical_decisions`, incl. outcome_success_rate
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'decision', action: 'stats',
    category: 'Technical Decisions',
    description: 'Get technical decision statistics and analysis. Archived (soft-deleted) decisions are EXCLUDED from every breakdown by default, so these counts reconcile with decision_search.',
    humanDescriptions: {
      projectId: 'Project ID or name to scope the stats (defaults to current project)',
      includeArchived: 'Include archived decisions in every count/breakdown (default false — matches decision_search so the two tools reconcile)',
    },
  },
  {
    opId: 'decision_delete',
    effect: 'write',
    kind: 'gateway', gateway: 'decision', action: 'delete',
    category: 'Technical Decisions',
    description: 'Soft-delete (archive) a technical decision — hides it from default decision_search but does NOT permanently delete it (reversible via decision_restore). Accepts a full UUID or short id; project-scoped.',
    humanDescriptions: {
      decisionId: 'Decision UUID or 8+-hex short id to archive (project-scoped)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'decision_restore',
    effect: 'write',
    kind: 'gateway', gateway: 'decision', action: 'restore',
    category: 'Technical Decisions',
    description: 'Restore (un-archive) a previously soft-deleted decision so it appears in default decision_search again. Accepts a full UUID or short id; project-scoped.',
    humanDescriptions: {
      decisionId: 'Decision UUID or 8+-hex short id to restore (project-scoped)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },

  // ── Task Management ──────────────────────────────────────────────────────────
  {
    opId: 'task_create',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'create',
    category: 'Task Management',
    description: 'Create a new task for agent coordination. Set `type` to the right kind (e.g. "bug", "feature") at creation time; task_update can re-classify it later. AGENTS: on deployments that list your actor in MANDREL_AGENT_ACTORS, a create is REFUSED with [TASK_CREATE_AGENT_FOLD_IN] unless tagged `needs-operator` — fold the finding into your lane or report it in your return; only an item needing a human decision becomes a task.',
    humanDescriptions: {
      title: 'Task title (required)',
      description: 'Longer task description / details',
      type: 'Task type — one of: feature, bug, bugfix, refactor, test, review, docs, documentation, devops, general (default: general). Pick the correct one at creation; type is immutable afterward.',
      priority: 'Priority — one of: low, medium, high, urgent (default: medium)',
      status: 'Initial status — one of: todo, in_progress, completed, blocked (default: todo)',
      assignedTo: 'Assignee identifier (free-form string, e.g. an agent name)',
      createdBy: 'Who/what created the task (free-form string, e.g. an agent or person name)',
      dependencies: 'Task IDs this task depends on — each a full UUID or an 8+-hex short id (the form shown in 🆔 ID output), resolved like every other id arg (max 10). Also mints a `depends_on` graph edge per dependency.',
      parentTaskId: 'The parent task this task is a subtask of — full UUID or 8+-hex short id. Mints the structural `subtask_of` edge to it. This param is the ONLY way to get a subtask_of edge: an open branch position mints membership (`informs`), never structural parenthood.',
      links: 'Explicit typed graph edges to create FROM this task — either {edgeType, to, toType} or the shorthand {task|decision|context: "<id>"}. Same parameter context_store/decision_record take.',
      tags: 'Tags for categorization and filtering (e.g., ["backend", "urgent"])',
      blockedOn: 'WHO must act next for this task to move — one of: human, agent, external. Omit (the default) for "not blocked on anyone in particular"; pass null to clear it. This is a FIELD, not a tag convention: project_briefing\'s "Waiting on a human" section selects on it with a WHERE clause, so no tag vocabulary has to be invented or applied. Orthogonal to `status`: an in_progress task can be waiting on a human, and a status=blocked task is usually waiting on another TASK.',
      dueAt: 'The task DEADLINE as an ISO-8601 datetime with offset (e.g. 2026-09-01T00:00:00Z). Authoritative and SORTABLE — the "Waiting on a human" section orders by it, soonest first. A date found in a task\'s prose is NOT this: the briefing labels those `due?`, states they may not be deadlines at all, and never sorts by them. Pass null to clear.',
      projectId: 'Project ID or name to create the task under (defaults to current project)',
      metadata: 'Arbitrary structured metadata to attach to the task',
      stage: 'The Punch List lane — one of: draft, ready, claimed, verifying, evidence, merged, deployed. SOURCE OF TRUTH over `status`, which is derived from it automatically. Setting stage:"ready" REQUIRES a non-empty title, a resolved project, punch.proofKind, and punch.doneWhen as a NON-EMPTY ARRAY of { text, owner: lane|human, proof? } clauses (owner required; proof required when owner is "lane") — refused with [PUNCH_INCOMPLETE] and a `missing` list naming the exact clause field (e.g. doneWhen[1].proof) otherwise, nothing written.',
      punch: 'The punch — { doneWhen, proofKind, source?, touches?, dependsOn? }. Shallow-merged into metadata.punch (fill it in progressively across calls without erasing earlier fields). doneWhen: an array of { text, owner: "lane"|"human", proof? } clauses — proof is REQUIRED when owner is "lane" (a repo-relative path or test id, the artifact the critic opens); the legacy bare-string shape is only accepted before stage:"ready". proofKind: how it will be proven — one of test, browser, look. source: where this came from — one of form, chat, machine. touches: repo-relative paths/globs this change will edit. dependsOn: SERVER-MIRRORED from the `dependencies` argument — set it here directly without `dependencies` in the same call and the write is refused with [PUNCH_DEPENDS_ON_DIRECT].',
    },
  },
  {
    opId: 'task_list',
    // reportsCount: `total` — the grand match COUNT over `tasks`
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'task', action: 'list',
    category: 'Task Management',
    description: 'List tasks with optional filtering. `dueBefore` + `sort:"dueAt"` answer "what is due in the next N days" directly — the structured deadline is readable here, and on every returned task, without the "Waiting on a human" section\'s blocked_on precondition.',
    humanDescriptions: {
      status: 'Filter by a single status (todo, in_progress, blocked, completed, cancelled)',
      statuses: 'Filter by MULTIPLE statuses (e.g. ["todo","in_progress"]) — takes precedence over `status` when set',
      priority: 'Filter by priority (low, medium, high, urgent)',
      phase: 'Filter to a single phase — matches EVERY spelling of that phase tag, differing only in the separator and case: phase:"3" matches phase-3, phase:3, phase_3, phase.3, "phase 3" and phase3 alike (an earlier task — it previously matched the dash spelling ALONE and answered total:0 for a phase that had tasks). The value after the separator is matched literally, so phase:"1.2" does not match phase-12.',
      assignedTo: 'Filter by assignee (matches the assigned_to value set via task_create/task_update)',
      type: 'Filter by task type (feature, bug, bugfix, refactor, test, review, docs, devops, general)',
      tags: 'Filter by tags — returns tasks matching ANY of the provided tags',
      limit: 'Maximum number of tasks to return (default 10)',
      offset: 'Number of leading results to skip (pagination)',
      projectId: 'Project ID or name to scope the list (defaults to current project)',
      dueBefore: 'Return only tasks whose DEADLINE (the `dueAt` field set by task_create/task_update) is at or before this ISO-8601 datetime with offset. Tasks with NO deadline are EXCLUDED — "not due before X" and "has no deadline recorded" are different answers. Combine with `sort:"dueAt"` for a deadline board. On a deployment predating migration 093 this is REFUSED with a typed error naming the migration, never silently ignored.',
      createdAfter: 'Return only tasks CREATED at or after this ISO-8601 datetime with offset. Pairs with `createdBefore` for a filing window — this is the inflow half of a flow report.',
      createdBefore: 'Return only tasks CREATED at or before this ISO-8601 datetime with offset. Pairs with `createdAfter`.',
      closedAfter: 'Return only tasks CLOSED at or after this ISO-8601 datetime with offset — the outflow half of a flow report. CLOSED means either terminal door, completed OR cancelled (the `closedAt` field, migration 098), which is why this is not named `completedAfter`: a flow number that counts only completions misses bulk cancellations entirely. Tasks that are still OPEN are EXCLUDED — "not closed after X" and "never closed" are different answers. On a deployment predating migration 098 this is REFUSED with a typed error naming the migration, never silently ignored.',
      sort: 'Ordering. "priority" (the default) is priority then newest-first. "dueAt" orders by the deadline soonest-first with undated tasks last, falling through to the priority order underneath so the result stays a total order under paging.',
      stage: 'Filter by the Punch List lane — a single value or an array (e.g. ["ready","claimed"]) — one of: draft, ready, claimed, verifying, evidence, merged, deployed. Rows with no stage recorded (cancelled, or a legacy row) never match.',
    },
  },
  {
    opId: 'task_update',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'update',
    category: 'Task Management',
    description: 'Update a task — change any of status, priority, type, progress, assignee, title, description, tags, or metadata, or APPEND a status note with `notes` (provide at least one). `notes` is the right way to record where a task now stands: it appends and cannot destroy anything. `description` REPLACES the task spec — the replaced text is preserved at metadata.descriptionHistory, but if you only mean to annotate, use `notes`. Status accepts: todo, in_progress, blocked, completed, cancelled. metadata is MERGED (set a key to null to delete it), not replaced. CLAIM-FENCED: while a task has a LIVE claim, EVERY update requires the matching claimId (or the audited force:true); a supplied claimId is validated on every update and an invalid one is a typed rejection (claim-mismatch / claim-expired / claim-lost) with nothing changed.',
    humanDescriptions: {
      taskId: 'Task ID (UUID or 8+-hex short id) — required',
      status: 'New status — one of: todo, in_progress, blocked, completed, cancelled',
      priority: 'New priority — one of: low, medium, high, urgent',
      type: 'Re-classify the task. The legal values ride this param\'s own enum in the schema (the SAME set task_create accepts — deliberately not restated here, so the two cannot drift). task_list filters on it.',
      assignedTo: 'New assignee (free-form string, e.g. an agent name)',
      progress: 'Completion percentage 0–100',
      title: 'New task title',
      description: 'New task description — a FULL REPLACE of the existing spec, not an append. The text you replace is preserved at metadata.descriptionHistory (last few only), so this is recoverable, but to add a status note use `notes` instead.',
      tags: 'New tag set (REPLACES tags) for categorization / re-threading',
      dependencies: 'New dependency set (REPLACES dependencies) — the tasks that must land before this one can move. FULL REPLACE, exactly like `tags`: to ADD a second dependency send BOTH ids, because sending only the new one ERASES the first. Each entry is a full UUID or 8+-hex short id, resolved like every other id arg. Also mints a `depends_on` edge per dependency. This is the channel to use when a TASK is what you are waiting on — prefer it over `blockedOn`, which names a PARTY (human/agent/external) and has no value meaning "another task"; picking one anyway would put a false entry in project_briefing\'s "Waiting on a human". Setting status=blocked requires one of the two channels, and a dependency naming no existing task does not count.',
      blockedOn: 'WHO must act next for this task to move — one of: human, agent, external. Omit (the default) for "not blocked on anyone in particular"; pass null to clear it. This is a FIELD, not a tag convention: project_briefing\'s "Waiting on a human" section selects on it with a WHERE clause, so no tag vocabulary has to be invented or applied. Orthogonal to `status`: an in_progress task can be waiting on a human, and a status=blocked task is usually waiting on another TASK.',
      dueAt: 'The task DEADLINE as an ISO-8601 datetime with offset (e.g. 2026-09-01T00:00:00Z). Authoritative and SORTABLE — the "Waiting on a human" section orders by it, soonest first. A date found in a task\'s prose is NOT this: the briefing labels those `due?`, states they may not be deadlines at all, and never sorts by them. Pass null to clear.',

      notes: 'APPEND a status note. Adds a timestamped, actor-attributed entry to metadata.noteLog and leaves `description` completely untouched — this is the affordance for "record where this task now stands". Appending cannot lose anything; older entries fall off only past the retention bound.',
      metadata: 'Structured metadata to MERGE over the existing object (shallow). Set a key to null to DELETE it; omitted keys are preserved (no silent data loss).',
      claimId: 'The claim token you hold (from task claim). Required for ANY update while a claim is LIVE; validated on every update regardless of fields — an invalid token is a typed rejection, never ignored. Presenting it also implicitly renews the lease, and a terminal status clears the claim.',
      force: 'Override a live claim held by someone else (audited as force_override). Default: false',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
      stage: 'The Punch List lane — one of: draft, ready, claimed, verifying, evidence, merged, deployed. SOURCE OF TRUTH over `status`, which is derived from it automatically (setting stage does not also require setting status). Setting stage:"ready" REQUIRES a non-empty title, a resolved project, punch.proofKind, and punch.doneWhen as a NON-EMPTY ARRAY of { text, owner: lane|human, proof? } clauses (owner required; proof required when owner is "lane"), evaluated against the MERGED (existing + this call\'s) state — refused with [PUNCH_INCOMPLETE] and a `missing` list naming the exact clause field (e.g. doneWhen[1].proof) otherwise, nothing written.',
      punch: 'The punch — { doneWhen, proofKind, source?, touches?, dependsOn? }. Shallow-merged into metadata.punch: an omitted field is left untouched, an explicit null deletes it. doneWhen is an array of { text, owner: "lane"|"human", proof? } clauses — proof is REQUIRED when owner is "lane"; the legacy bare-string shape is only accepted before stage:"ready". touches: repo-relative paths/globs this change will edit. dependsOn is SERVER-MIRRORED from the `dependencies` argument — set it here directly without `dependencies` in the same call and the write is refused with [PUNCH_DEPENDS_ON_DIRECT]. A `metadata:{punch:{...}}` argument on this same call is folded into this SAME punch merge (never a wholesale metadata.punch replace), so an unrelated note-only edit cannot delete sibling punch sub-keys like intake/walkthrough/merge. Fill it in progressively across calls, then set stage:"ready" once doneWhen/proofKind are in place.',
    },
  },
  {
    opId: 'task_details',
    effect: 'read',
    kind: 'gateway', gateway: 'task', action: 'details',
    category: 'Task Management',
    description: 'Get detailed information for a specific task',
    humanDescriptions: {
      taskId: 'Task ID (UUID)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'task_bulk_update',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'bulk_update',
    category: 'Task Management',
    description: 'Update multiple tasks atomically with the same changes. Rows under a LIVE claim are SKIPPED and reported in failed/errors — bulk carries no claim token; use task_update with the claimId (or an audited force:true) for a claimed row.',
    humanDescriptions: {
      task_ids: `Task IDs (full UUID or 8+-hex short id) to update (1–${TASK_BULK_MAX_IDS})`,
      status: 'New status for all — one of: todo, in_progress, blocked, completed, cancelled',
      assignedTo: 'New assignee for all (free-form string)',
      priority: 'New priority for all — one of: low, medium, high, urgent',
      metadata: 'Structured metadata (jsonb object) to set on all',
      notes: 'Notes to merge into each task\'s metadata',
      blockedOn: 'WHO must act next, applied to ALL the named tasks — one of: human, agent, external; pass null to clear. Same field task_update sets, offered here because a board sweep that blocks N tasks behind one freeze is a real use of this tool and setting status=blocked requires a named blocker. If a TASK is what they are waiting on, use task_update `dependencies` per task instead — this param names a PARTY and has no value meaning "another task".',
      projectId: 'Optional. Project ID or name to validate ownership against',
      stage: 'The Punch List lane, applied to ALL the named tasks — one of: draft, ready, claimed, verifying, evidence, merged, deployed. Setting stage:"ready" REQUIRES every targeted row to already carry (or acquire via this same call\'s `punch`) a non-empty title, punch.proofKind, and punch.doneWhen as a NON-EMPTY ARRAY of { text, owner: lane|human, proof? } clauses — if ANY row would end up incomplete the WHOLE call is refused with [PUNCH_INCOMPLETE] naming, per row, the exact clause field (e.g. doneWhen[1].proof), matching this tool\'s all-or-nothing contract; nothing is written.',
      punch: 'The punch — { doneWhen, proofKind, source?, touches? } — shallow-merged into EACH targeted task\'s metadata.punch (a `metadata:{punch:{...}}` argument is folded into this same merge, never a wholesale replace). This tool has no `dependencies` channel, so `punch.dependsOn` cannot be set here — it is always refused with [PUNCH_DEPENDS_ON_DIRECT].',
    },
  },
  {
    opId: 'task_progress_summary',
    // reportsCount: per-group + overall counts over `tasks`
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'task', action: 'progress',
    category: 'Task Management',
    description: 'Get task progress summary with grouping and completion percentages',
    humanDescriptions: {
      groupBy: 'Grouping for the summary — one of: phase, status, priority, type, assignedTo (default: phase)',
      projectId: 'Project ID or name to scope the summary (defaults to current project)',
      includeArchived: 'Include archived tasks in the counts (default false — matches task_list so the counts reconcile)',
    },
  },
  {
    opId: 'task_delete',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'delete',
    category: 'Task Management',
    description: 'Soft-delete (archive) a task — hides it from default task_list but does NOT permanently delete it (reversible via task_restore). Distinct from the cancelled status. Accepts a full UUID or short id; project-scoped.',
    humanDescriptions: {
      taskId: 'Task UUID or 8+-hex short id to archive (project-scoped)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'task_restore',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'restore',
    category: 'Task Management',
    description: 'Restore (un-archive) a previously soft-deleted task so it appears in default task_list again. Accepts a full UUID or short id; project-scoped.',
    humanDescriptions: {
      taskId: 'Task UUID or 8+-hex short id to restore (project-scoped)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'cancel_task',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'cancel',
    category: 'Task Management',
    description: 'Cancel a task — set its status to `cancelled` (a first-class lifecycle state that stays listed). Convenience for task_update(status="cancelled"). Distinct from task_delete, which archives/hides a task. Accepts a full UUID or short id; project-scoped; idempotent.',
    humanDescriptions: {
      taskId: 'Task UUID or 8+-hex short id to cancel (project-scoped)',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
      claimId: 'The claim token you hold on this task (required to cancel a task you have claimed)',
      force: 'Override a live claim held by someone else (audited). Default: false',
    },
  },

  // ── ATOMIC TASK CLAIM ────────────────────
  // The claim lifecycle, DELIBERATELY separate from ordinary editing: `task_update` must
  // never auto-acquire ownership (that is what made it an unconditional last-writer-wins
  // stomp in the first place). Registered at the END of the Task Management block so the
  // historical intra-category ordering of every pre-existing tool is preserved.
  {
    opId: 'task_claim',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'claim',
    category: 'Task Management',
    description: 'ATOMICALLY claim a task for exclusive work — a compare-and-swap acquire with a lease, so N workers racing the same task produce exactly ONE winner and N-1 typed conflicts (never two silent owners). Returns a server-minted claimId: the fencing token you must present on EVERY task_update while the claim is live (all fields, not just status/assignee), on renew, and on release. Refuses with a typed reason (held / wrong-status / archived / version-stale / not-found) instead of overwriting.',
    humanDescriptions: {
      taskId: 'Task UUID or 8+-hex short id to claim (project-scoped)',
      actor: 'OPTIONAL refinement of the attribution handle — ATTRIBUTION only, never the lock key. It does NOT set who you are: your identity is derived at the edge from your authenticated principal / X-Actor-ID, and that derived actor takes precedence. If you have one, this argument is IGNORED in the default mode, and (with composite actors enabled) replaces only the handle segment UNDER your own principal — you can name a different agent of YOURS, never someone else. It is used verbatim only when you have no derivable actor at all. Two callers sharing a name can NOT both hold the claim: exclusion is keyed on the server-minted claimId.',
      allowedStatuses: 'Statuses the task may be claimed FROM (default: todo). A completed/cancelled task is never re-opened by a claim.',
      expectedVersion: 'Optional optimistic-lock check: fail with version-stale unless the task is still at this version (from task_details).',
      leaseSeconds: 'How long the claim is held before it expires and becomes re-claimable (default from config; bounded server-side).',
      claimId: 'ONLY for an idempotent retry: the token you already hold. Re-affirms the SAME claim instead of minting a new one. Omit to acquire.',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'task_renew',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'renew',
    category: 'Task Management',
    description: 'Extend the lease on a task claim you hold (heartbeat for long-running work). Requires the matching claimId AND a still-live lease; returns a typed `claim-lost` if the claim expired, was released, or was taken over — which is how a mid-flight worker learns it no longer owns the task.',
    humanDescriptions: {
      taskId: 'Task UUID or 8+-hex short id (project-scoped)',
      claimId: 'REQUIRED. The claim token returned by task claim.',
      leaseSeconds: 'New lease length from now (default from config; bounded server-side).',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },
  {
    opId: 'task_release',
    effect: 'write',
    kind: 'gateway', gateway: 'task', action: 'release',
    category: 'Task Management',
    description: 'Release a task claim you hold so the next worker can take it (do this when you stop work without completing). Clears the claim; returns a typed `claim-lost` if the claim is no longer yours. Completing a task with its claimId clears the claim automatically — this is for the give-it-back case.',
    humanDescriptions: {
      taskId: 'Task UUID or 8+-hex short id (project-scoped)',
      claimId: 'REQUIRED. The claim token returned by task claim.',
      projectId: 'Project ID or name to scope the lookup (defaults to current project)',
    },
  },

  // ── Smart Search & AI (flat tools) ───────────────────────────────────────────
  {
    opId: 'smart_search',
    effect: 'read',
    kind: 'flat', gateway: 'smart_search', action: null,
    category: 'Smart Search & AI',
    description: 'Intelligent search across all project data sources',
    humanDescriptions: {
      query: 'Free-text search query. There is NO key:value query syntax: "id:<uuid>" and "type:<t>" are rejected as errors — pass a BARE id token to look one up, or use includeTypes to pick data sources.',
      includeTypes: `Limit the search to specific sources, e.g. ${smartSearchSourcesJson()} (the searched sources today). Omit to search ${smartSearchSourcesPlus()}.`,
      limit: 'Maximum number of results to return (default 10)',
      altitude: 'Volume: "headline" (id/type/title/url/trust — NO summary key at all) | "summary" (DEFAULT — + the body clipped to the snippet budget, with a clipped-N-more affordance) | "full" (+ the whole body). Moves BOTH channels. Re-call at full, or fetch the record by its id, for a whole body.',
      projectId: 'Project ID or name to scope the search (defaults to current project)',
    },
  },
  {
    opId: 'get_recommendations',
    effect: 'read',
    kind: 'flat', gateway: 'get_recommendations', action: null,
    category: 'Smart Search & AI',
    description: 'Get AI-powered recommendations for development',
    humanDescriptions: {
      context: 'What you are working on',
      type: 'Recommendation type (naming, implementation, architecture, testing)',
      projectId: 'Project ID or name to scope recommendations (defaults to current project)',
    },
  },

  // project_insights — historically registered HERE (after get_recommendations),
  // categorized under Project Management. Position preserved for byte-identical output.
  {
    opId: 'project_insights',
    // reportsCount: context/decision/task breakdowns + teamEfficiency completionRate
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'project', action: 'insights',
    category: 'Project Management',
    description: 'Get comprehensive project health and insights. Archived (soft-deleted) records are EXCLUDED from the context/decision/task breakdowns by default, so those totals reconcile with context_search / decision_search / task_list.',
    humanDescriptions: {
      projectId: 'Project ID or name to scope insights (defaults to current project)',
      includeArchived: 'Include archived records in the context/decision/task breakdowns (default false — matches the three search/list tools so the counts reconcile)',
    },
  },
  {
    opId: 'project_tags',
    // reportsCount: returns per-tag record counts and a matched total.
    reportsCount: true,
    effect: 'read',
    kind: 'gateway', gateway: 'project', action: 'tags',
    category: 'Project Management',
    description:
      'Census of the tag values that actually EXIST in this project, with the number of records carrying each and a per-entity split — the answer to "which tags begin with X" and "which values does the class: axis carry in the DATA (not which the config accepts)". Tag filtering elsewhere needs an EXACT value, so without this the only way to find a tag population is to fetch every record and scan client-side. Honours includeArchived with the same default and the same disclosure as context_search / decision_search / task_list, so its counts reconcile with theirs. A prefix that matches nothing returns matched:0 with evaluated:true — "no such tag" and "I did not look" are different answers here.',
    humanDescriptions: {
      projectId: 'Project ID or name to scope the census (defaults to current project)',
      prefix: 'Only tags STARTING with this literal (e.g. "invalid-", "ref:", "class:"). Matched literally — % and _ are data, not wildcards. Omit for every tag.',
      entities: 'Which record types to census: any of context, decision, task. Omit for all three.',
      includeArchived: 'Include archived records in the census (default false — matches the search/list tools so the counts reconcile)',
      limit: 'Max distinct tag values to return, most-used first. The response reports `omitted` so a truncated census never looks complete.',
    },
  },

  // ── Linking & Graph ──────────────────────────────────────────────────────────
  {
    opId: 'link',
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'link',
    category: 'Linking & Graph',
    description: 'Create a typed edge between two records (context/decision/task) — for edges that can\'t be inferred at write-time, and to REPAIR the graph. Edges carry STRUCTURE (tags carry labels). Edge type ∈ the v1 domain (decided_by, caused, built_by, supersedes, learned_from, proposed_by, informs, produced_outcome, related_to). Ids accept a full UUID or 8+-hex short id. Idempotent.',
    humanDescriptions: {
      from: 'Source record id (full UUID or 8+-hex short id) — the edge points FROM here',
      fromType: 'Kind of the source record: context | decision | task',
      to: 'Target record id (full UUID or 8+-hex short id) — the edge points TO here',
      toType: 'Kind of the target record: context | decision | task',
      edgeType: 'The typed edge (see the v1 domain). Stored from→to.',
      metadata: 'Optional structured annotations on the edge (jsonb)',
      projectId: 'Project ID or name to scope short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'unlink',
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'unlink',
    category: 'Linking & Graph',
    description: 'Remove a typed edge between two records (curate/repair). Idempotent — removing a non-existent edge is reported, not an error. Ids accept a full UUID or 8+-hex short id.',
    humanDescriptions: {
      from: 'Source record id (full UUID or 8+-hex short id)',
      to: 'Target record id (full UUID or 8+-hex short id)',
      edgeType: 'The typed edge to remove',
      projectId: 'Project ID or name to scope short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'get_links',
    effect: 'read',
    kind: 'gateway', gateway: 'graph', action: 'links',
    category: 'Linking & Graph',
    description: 'Read a record\'s typed edges in BOTH directions, each carrying the connected record\'s id/type/title — the traversal primitive for trust + recall_thread. Zero raw SQL for the consumer. Accepts a full UUID or 8+-hex short id.',
    humanDescriptions: {
      id: 'The record id to read edges for (full UUID or 8+-hex short id)',
      direction: 'Restrict to out (record is source), in (record is target), or both (default)',
      edgeTypes: 'Optional list of edge types to restrict the walk (default: all)',
      projectId: 'Project ID or name to scope short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'recall_thread',
    effect: 'read',
    kind: 'flat', gateway: 'recall_thread', action: null,
    category: 'Linking & Graph',
    description:
      'Read me in on the STORY of X, at altitude Y, and tell me what to TRUST — in ONE call. ' +
      'Resolves the anchor (a ref:<slug>, or a context/decision/task id — id8 ok), traverses the ' +
      'typed-edge graph BOTH directions (cycle-safe, capped), trust-annotates every node (the moat: ' +
      'band/score/abstain), orders the nodes causally+temporally so it reads top-to-bottom as the story, ' + // trust-render-exempt: TOOL DESCRIPTION prose (documents the shape; renders no verdict)
      'and surfaces an abstain list. Returns BOTH a clean structured thread AND a narratable text channel. ' + // trust-render-exempt: TOOL DESCRIPTION prose (documents the shape; renders no verdict)
      'Deterministic — no LLM. Altitude: headline (1-liner/node) | summary (default, +snippet) | full (+full content) | ' +
      'current (the CURRENT-STATE read model: root gate, active tasks, unresolved blockers/findings, latest trusted outcomes, ' + // trust-render-exempt: TOOL DESCRIPTION prose (names the altitude; renders no verdict)
      'standing decisions, artifact/release head, a recommended next action, and superseded nodes OMITTED BUT COUNTED — ' +
      'one bounded orientation instead of the whole history). ' +
      // THE ANSWER SHAPE SWITCHES, and this is the only place a caller can learn that before
      // calling. Our own harness read `nodes.length` on a `current` response,
      // found no `nodes` key, and reported "0 nodes" for a walk that examined 49 records.
      'TWO ANSWER SHAPES, one tool: the content altitudes return `nodes` + `edges` (shape:"thread"); ' +
      '`current` returns `currentState` INSTEAD and carries NO `nodes`/`edges` key at all ' +
      '(shape:"currentState" — read the `shape` field, or branch on `altitude`; an absent `nodes` ' +
      'is the projection shape, never an empty thread). Every response also reports what the walk ' +
      'dropped in `omissions` (trust floor, dangling referents, edges dropped with them) and states ' +
      'it in the text channel, at zero as well as non-zero.',
    humanDescriptions: {
      anchor: 'What to read in on: a ref:<slug> (e.g. ref:resume), or a context/decision/task id (full UUID or 8+-hex short id)',
      altitude: 'Zoom per node: headline (title+type+trust) | summary (default, +snippet) | full (+full content). Or the projection altitude `current` — where it stands NOW + the next action, in one bounded response (drill down by re-calling at summary/full).',
      edgeTypes: 'Optional list of edge types to restrict the walk (default: all v1 edge types)',
      depth: 'Optional BFS depth (hops from the anchor); clamped to the configured max. Default from config.',
      // NEVER PUT THE ARITHMETIC BACK (lane-6 an earlier task). This read "re-call with
      // nodes.length + truncatedCount to get the whole branch" — advice that does not work.
      // truncatedCount was a FLOOR, not a count: when the cap filled, the walk stopped
      // enqueueing, so anything reachable ONLY THROUGH a dropped node was never discovered.
      // Measured on a 19-node two-level fixture at cap 4, the sum came to 13 and the re-call
      // came back STILL TRUNCATED. And there is no formula to substitute: past the server's
      // per-call ceiling NO maxNodes a caller may pass returns the branch, so any number
      // printed there would be a lie by clamping. The schema therefore points at the
      // response, which knows which of those cases it is in; it does not teach a sum.
      maxNodes: 'Optional total-node cap for this call; clamped to the configured ceiling and reported back as maxNodesUsed. Do NOT compute a resumption cap yourself: when a response comes back truncated its own notice either NAMES the maxNodes to re-call with, or states that the branch is larger than this server\'s per-call ceiling so no maxNodes returns it (narrow edgeTypes or lower depth instead). Read the notice; there is no arithmetic that works in both cases.',
      minTrust: 'Optional trust floor — a band name (trusted|ok|unproven|stale|superseded|contradicted) OR a 0–1 score; nodes below it are hidden (the anchor never is)', // trust-render-exempt: PARAM DESCRIPTION prose for minTrust; renders no verdict
      projectId: 'Project ID or name to scope anchor/short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'branch_open',
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'branch_open',
    category: 'Linking & Graph',
    description:
      'Stand on a BRANCH (positional membership — the git model). `id` is the branch SPINE: any real record — context, decision, or task (full UUID or 8+-hex short id; resolved project-scoped across all three tables, never first-match). While the branch is open, a write (context_store, decision_record, task_create) stamps a DECLARED `informs` edge (provenance auto:positional) to the spine — standing there IS membership; no TTL, no similarity gate. ONE exception, decided by the record and not by you: a context of type `handoff` is always a TRUNK record and never a branch member, whatever branch is open. Re-opening onto a different spine MOVES the position (the interrupt/switch semantic) and reports what it replaced. task_claim and a task_update to in_progress open the branch on that task automatically (work-start is the byproduct signal).',
    humanDescriptions: {
      id: 'The spine record to stand on — a context, decision, or task (full UUID or 8+-hex short id)',
      projectId: 'Project ID or name to scope short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'branch_current',
    effect: 'read',
    kind: 'gateway', gateway: 'graph', action: 'branch_current',
    category: 'Linking & Graph',
    description:
      'Show the branch this session is standing on (the spine every write is stamping a declared edge onto, with its resolved title), or a clear "no branch open" message.',
    humanDescriptions: {
      projectId: 'Project ID or name to scope the position read (defaults to current project)',
    },
  },
  {
    opId: 'branch_close',
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'branch_close',
    category: 'Linking & Graph',
    description:
      'Step off the current branch — new writes no longer stamp positional edges (they get a `branch_open <id8>` offer naming their own id instead). Idempotent; names what was closed.',
    humanDescriptions: {
      projectId: 'Project ID or name to scope the position (defaults to current project)',
    },
  },
  {
    opId: 'branch_history',
    effect: 'read',
    kind: 'gateway', gateway: 'graph', action: 'branch_history',
    category: 'Linking & Graph',
    description:
      'Read a branch back: every record RECORDED as written on this spine, in the order they were written (SK2). WORKS ON A CLOSED BRANCH — branch_close hard-deletes the live position row, but membership is its own table (branch_memberships, migration 086), so a finished branch stays fully recoverable by any session, forever. `id` is the spine (context, decision, or task; full UUID or 8+-hex short id, resolved project-scoped across all three tables, never first-match). A record is a member iff a membership row names this spine as the branch it was written on — a record that merely tags or links the spine is NOT a member, and neither is a record written on a NESTED branch whose own spine happens to be a member of this one. A write made after the branch advanced its tip attaches to that tip rather than the root and is still returned, because the branch is stored rather than inferred from where the edge points. Reports `open` (is anyone standing here now), `totalMembers`, `omitted`, and THREE SEPARATE BANDS of certainty, never merged into one number: `approximateMembers` / `possiblyIncomplete` for writes that predate 086 (their branch was derived from where their edge attached, and is not recoverable), and `tagOnlyNoPosition` — records that tag this spine but carry no recorded position at all, which are NOT counted as members because whether they were written here is unknowable. `exact:true` means all three bands are empty, which is a forward-only claim: true for a branch written entirely after 086.',
    humanDescriptions: {
      id: 'The branch SPINE to read — a context, decision, or task (full UUID or 8+-hex short id). Does not need to be open.',
      projectId: 'Project ID or name to scope short-id resolution and the member walk (defaults to current project)',
      limit: 'Max members to return (default and ceiling from config; a request above the ceiling is clamped and says so). Members beyond it are counted in `omitted`, never dropped silently.',
    },
  },
  {
    opId: 'branch_assign',
    // WRITE, and NOT optional: `effect` is what puts this under G2 of
    // services/callerIdentityGuard.ts. Because it DECLARES a scoped `projectId` param it
    // lands in the bucket an unidentified caller can satisfy per-call; omit that param and
    // it becomes an op no unidentified caller could ever legally call.
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'branch_assign',
    category: 'Linking & Graph',
    description:
      'DECLARE which branch a record belongs to, after the fact (P3). `id` is the RECORD to place; `spine` is the BRANCH to place it on — each a context, decision, or task (full UUID or 8+-hex short id, resolved project-scoped across all three tables, never first-match). ONE upsert-shaped action covering BOTH cases: it ASSIGNS when the record was a member of nothing and MOVES when it was a member of something else, and the response says which (`action: assigned | moved | unchanged`) plus `previousSpineId`, so a move is visible and never silent. WHY IT EXISTS: membership was write-once — the first position won — and the system opens positions the author never asked for (auto/byproduct opens), so it could manufacture a membership nobody declared with no way to correct it. The assigned branch is stored as source `assigned`, which is a FACT and NOT an approximation: it does not raise `approximateMembers` and does not drop `exact` on branch_history. THIS IS THE FIRST TOOL THAT REWRITES A PREVIOUSLY IMMUTABLE HISTORICAL FACT — every change appends an audit row (branch_membership_moves) naming your actor id, the branch left, the branch joined and when. Any actor scoped to the project may reassign any record in it (no per-record ownership, consistent with link/unlink). Moving does NOT change the record\'s place in the branch\'s write order. To find candidates, read `tagOnlyNoPositionIds` from branch_history — the records that tag a spine but whose branch nobody has declared.',
    humanDescriptions: {
      id: 'The RECORD to place on a branch — a context, decision, or task (full UUID or 8+-hex short id)',
      spine: 'The BRANCH to place it on — the spine record (context, decision, or task; full UUID or 8+-hex short id)',
      reason: 'Optional free-text WHY, stored on the audit row (branch_membership_moves.reason)',
      projectId: 'Project ID or name to scope short-id resolution and the membership write (defaults to current project)',
    },
  },
  {
    opId: 'branch_unassign',
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'branch_unassign',
    category: 'Linking & Graph',
    description:
      'Remove a record\'s branch membership — it becomes a member of NO branch (P3). `id` is the record (context, decision, or task; full UUID or 8+-hex short id). The record itself and all of its edges are UNTOUCHED; only the membership row goes. NOT the same as reassigning: "this belongs on no branch" is frequently the true answer when an auto/byproduct position opened without the author asking, and without this the only correction available would be replacing one wrong fact with a different wrong fact. The removal is LOGGED (branch_membership_moves, `to_spine_id` NULL) with your actor id, so the branch it left stays recoverable after the membership row is gone. Idempotent: a record that was a member of nothing returns `action: absent` and logs nothing.',
    humanDescriptions: {
      id: 'The record whose branch membership to remove — a context, decision, or task (full UUID or 8+-hex short id)',
      reason: 'Optional free-text WHY, stored on the audit row (branch_membership_moves.reason)',
      projectId: 'Project ID or name to scope short-id resolution and the membership write (defaults to current project)',
    },
  },
  {
    opId: 'thread_set',
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'thread_set',
    category: 'Linking & Graph',
    description:
      'DEPRECATED — the active-thread anchor is retired (positional membership): use branch_open instead. This alias WARNS and delegates: thread_set({task}) → branch_open(task); thread_set({decision}) → branch_open(decision); both given → the branch opens on the TASK (a position is ONE spine) and the response says so. `replace` is accepted but inert.',
    humanDescriptions: {
      task: 'DEPRECATED alias input — delegates to branch_open on this task id',
      decision: 'DEPRECATED alias input — delegates to branch_open on this decision id (task wins when both are given)',
      replace: 'DEPRECATED and inert — a branch position is always a whole replacement',
      projectId: 'Project ID or name to scope short-id resolution (defaults to current project)',
    },
  },
  {
    opId: 'thread_current',
    effect: 'read',
    kind: 'gateway', gateway: 'graph', action: 'thread_current',
    category: 'Linking & Graph',
    description:
      'DEPRECATED — use branch_current. WARNS and delegates: shows the branch this session is standing on.',
    humanDescriptions: {},
  },
  {
    opId: 'thread_clear',
    effect: 'write',
    kind: 'gateway', gateway: 'graph', action: 'thread_clear',
    category: 'Linking & Graph',
    description:
      'DEPRECATED — use branch_close. WARNS and delegates: steps off the current branch. Idempotent.',
    humanDescriptions: {},
  },

];

/** Fast opId → entry lookup (derived; do not hand-maintain). */
export const OP_BY_ID: ReadonlyMap<string, OpRegistryEntry> = new Map(
  OP_REGISTRY.map((e) => [e.opId, e]),
);

/**
 * The closed set of EVERY canonical opId, in registry order.
 *
 * No count in this sentence, deliberately: it said "58" while OP_REGISTRY held 60 (the reviewer
 * N4). A hand-copied count reads as evidence of having counted and drifts on the next tool
 * (Lesson: a-count-carries-its-command). `ALL_OP_IDS.length` is the answer, and
 * opEffectClassification.contract.test.ts pins the membership by NAME.
 */
export const ALL_OP_IDS: readonly string[] = OP_REGISTRY.map((e) => e.opId);

/**
 * The persistence EFFECT of an op — the accessor the unidentified-caller guards call
 *. Derived from OP_REGISTRY; never a second list.
 *
 * FAIL CLOSED ON AN UNKNOWN NAME. A toolName that is not in the registry resolves to
 * 'write', not to 'read' and not to undefined. Every name that reaches routeExecutor
 * either IS a registry opId or is a deprecated `aidis_*` alias / an unknown tool that the
 * dispatcher rejects anyway — so the only thing this default can affect is a name we do
 * not recognise, and "unrecognised" must take the RESTRICTIVE branch. A guard
 * whose default is the permissive branch is the allow-list it was written to replace.
 *
 * The deprecated aliases are mapped explicitly rather than defaulted, so their effect is
 * stated rather than inherited from the fail-closed branch by accident.
 */
const DEPRECATED_ALIAS_EFFECTS: ReadonlyMap<string, OpEffect> = new Map([
  ['aidis_ping', 'read' as OpEffect],
  ['aidis_status', 'read' as OpEffect],
  ['aidis_help', 'read' as OpEffect],
  ['aidis_explain', 'read' as OpEffect],
  ['aidis_examples', 'read' as OpEffect],
]);

export function opEffect(toolName: string): OpEffect {
  const entry = OP_BY_ID.get(toolName);
  if (entry) return entry.effect;
  const alias = DEPRECATED_ALIAS_EFFECTS.get(toolName);
  if (alias) return alias;
  return 'write';
}
