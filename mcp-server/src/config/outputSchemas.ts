/**
 * Mandrel Tool OUTPUT Schemas (dual-channel output)
 *
 * THE PROBLEM (markdown-in-values bug class, at the root):
 *   Every tool used to return ONLY a human-readable `content` text blob. Machines
 *   (the Command UI, other agents, downstream automation) had to REGEX-PARSE that
 *   prose to recover ids/names/statuses — fragile, and the source of the
 *   markdown-in-values class (a project name with `**bold**` in the DB leaked its
 *   markup into parsed "data" because the only data channel WAS the marked-up text).
 *
 * THE FIX (MCP spec dual-channel):
 *   A tool result carries BOTH:
 *     • `content`          — a SHORT human-readable summary (a glance), and
 *     • `structuredContent`— a clean JSON object with the RAW field values, which
 *   conforms to an `outputSchema` DECLARED on the tool definition.
 *   Machines read `structuredContent` (raw, never marked-up); humans read `content`.
 *
 * THIS MODULE is the SINGLE SOURCE OF TRUTH for the output side, mirroring exactly
 * how `toolDefinitions.buildInputSchema` is the single source for the input side:
 *   - output shapes are declared ONCE as zod schemas (a handful of SHARED shapes
 *     reused across tools of the same response kind — list/get/mutate/status), and
 *   - `buildOutputSchema(toolName)` converts the tool's zod output schema to the
 *     JSON Schema the MCP `outputSchema` field requires (same zodToJsonSchema path
 *     as the input side), so the two layers can never drift.
 *
 * Adding a tool? Give it an entry in `outputSchemas` below. A contract test
 * (dualChannelOutput.contract.test.ts) FAILS if any tool definition lacks an
 * outputSchema — "all tools, no tool left behind" is enforced, not hoped.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** JSON Schema shape the MCP SDK accepts for a tool's `outputSchema`. */
export interface JsonObjectSchema {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED building blocks — reused across many tools so we define a handful of
// shapes, not 29 bespoke ones.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every structuredContent object carries `ok` (the machine-readable success flag)
 * so a consumer never has to infer success from prose. `.passthrough()` is used on
 * the record shapes below so a tool can include extra raw fields without the schema
 * rejecting them (tolerant egress; the REQUIRED keys are the contract).
 *
 * THE REQUIRED-SET RULE (an earlier task — the customer outputSchema-rejection fix):
 *   A field may be `required` in an outputSchema ONLY if it is present on LITERALLY
 *   EVERY return path of that tool — success AND error AND not-found AND ambiguous
 *   AND empty. Structured output is a best-effort BONUS alongside the text channel:
 *   the schema documents the typical shape, but it must NEVER reject a legitimate
 *   response. A strict MCP client (e.g. Claude Code) validates structuredContent
 *   against the advertised outputSchema and DISCARDS any response that fails — so an
 *   over-strict `required` set silently breaks the customer surface.
 *
 *   In practice `ok` is the ONLY field guaranteed on every path: the dual-channel
 *   SEAM (routes/index.ts ensureStructuredContent) stamps `ok` on EVERY response
 *   (including bare error returns from formatMcpError, which carry no other fields).
 *   So `ok` stays required; ALL descriptive fields are `.optional()` (they still
 *   appear in `properties`, documenting the shape, just not in `required`).
 */
const ok = z.boolean();

/**
 * TRUST ON THE WIRE (Mandrel Core Redesign T2b — THE MOAT; reduced by SEARCH P3).
 * Surfaced DEFAULT-ON on every recalled record so the AI knows
 * whether to rely on it. TWO FIELDS, and nothing else:
 *   band  — trusted | ok | unproven | stale | superseded | contradicted (the headline verdict)
 *   score — the blended 0–1 confidence, rounded to TRUST_WIRE_SCORE_PRECISION decimal places
 *           (null only at cold-start, when there is no outcome evidence yet)
 *
 * WHAT WAS DROPPED, AND WHY. Until this task a record shipped outcome{}, freshness,
 * superseded, softSuperseded, abstain, supersession, reason and promotionRequirement on every
 * row. MEASURED at recall_thread `headline` over 43 nodes on prod: 14,391 chars of trust
 * against 4,156 chars of the titles it decorates — 3.5x the information it annotates. Every
 * dropped field is derivable, null, or a restatement (`reason:"trusted"` restates `band`),
 * and `score:0.9948746744592272` was sixteen digits of false precision on a blended heuristic.
 *
 * THE COUNTER-ARGUMENT, ANSWERED: a consumer that genuinely needs supersession or abstain
 * fetches the record BY ID, which still returns full detail. Search and recall are surfaces
 * for DECIDING WHAT TO OPEN, and band+score is sufficient for that decision — the same
 * altitude logic these tools apply to bodies, applied to metadata.
 *
 * ★ TWO SHAPES SHIP, ON PURPOSE — READ THIS BEFORE ASSUMING band+score IS ALL YOU GET.
 * The two fields above are what the LIST/RECALL surfaces emit (context_search's query and
 * tags branches, context_get_recent, smart_search, decision_search, recall_thread's nodes and
 * its current-state projection). A DIRECT LOOKUP BY ID emits the COMPLETE verdict instead —
 * every field named in the "what was dropped" paragraph above — because that is the escape
 * hatch this decision's own rationale promises ("consumers... fetching the record by id,
 * which returns full detail"), and for a CONTEXT it is the only place supersession/abstain
 * are machine-readable at all (contexts carry no supersession column; it is derived from
 * edges). See services/altitudeProjection.ts: projectTrust vs projectTrustDirect.
 *
 * This schema stays NARROW rather than declaring the wide shape as optional fields, and that
 * is a deliberate cost call, not an oversight: trustObject is embedded in most read tools'
 * outputSchema, so re-declaring the seven fields would put ~11,900 bytes back on every
 * tools/list to describe a shape ONE branch of ONE tool emits. The open shape below already
 * admits it — which is exactly what `.passthrough()` is for. The split is pinned executably
 * by altitudeVocabulary.contract.test.ts, which asserts the list shape is EXACTLY [band,
 * score] and the by-id shape carries the full set, so the two cannot silently converge.
 *
 * `.passthrough()` and `.nullable()` on score are unchanged: the shape stays permissive so a
 * structured-output validator can never REJECT a legitimate response (see the standing rule
 * above), and the cold-start `unproven` (null score) validates.
 */
const trustObject = z
  .object({
    band: z.string(), // trust-render-exempt: SCHEMA KEY (the advertised shape), not a rendered badge
    score: z.number().nullable(),
  })
  .passthrough();

/** A single context record (raw values — NEVER marked-up). */
const contextRecord = z
  .object({
    id: z.string(),
    contextType: z.string(),
    content: z.string(),
    tags: z.array(z.string()),
    relevanceScore: z.number().optional(),
    similarity: z.number().optional(),
    relevance: z.number().optional(),
    projectId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    metadata: z.record(z.any()).optional(),
    createdAt: z.string().optional(),
    // TRUST (T2b) — default-on on recall rows (context_search / context_get_recent).
    trust: trustObject.optional(),
  })
  .passthrough();

/** A single decision record (raw values). */
const decisionRecord = z
  .object({
    id: z.string(),
    title: z.string(),
    decisionType: z.string().optional(),
    impactLevel: z.string().optional(),
    status: z.string().optional(),
    rationale: z.string().optional(),
    outcomeStatus: z.string().nullable().optional(),
    // BUILD lifecycle. It was ALWAYS emitted by decisions.routes.handleSearch
    // and never declared here — so `.passthrough()` carried it through while the machine-
    // readable contract stayed silent about the one field this task makes queryable. Declared
    // now, so the advertised output matches what the route actually returns.
    implementationStatus: z.string().nullable().optional(),
    lessonsLearned: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    // TRUST (T2b) — default-on on decision_search result rows.
    trust: trustObject.optional(),
    // THE DECISION INBOX (migration 104). Declared here (rather
    // than left to `.passthrough()`) so the advertised output names the fields decision_answer/
    // decision_discuss/decision_search(answerStatus) actually return.
    answerStatus: z.string().optional(),
    question: z.string().nullable().optional(),
    options: z.array(z.record(z.any())).optional(),
    chosen: z.string().nullable().optional(),
  })
  .passthrough();

/** A single task record (raw values). */
const taskRecord = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    assignedTo: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    progress: z.number().nullable().optional(),
    /**
     * THE DECLARED BRANCH THIS TASK WAS WRITTEN ON — the
     * `branch_memberships` row, NOT the `branch:<slug>` tag in `tags`. Both carriers are
     * real and they disagree in both directions, so a consumer counting "branchless" tasks
     * must require BOTH to be empty. Populated by task_list, which joins it.
     *
     * OPTIONAL AND NULLABLE ARE DIFFERENT ANSWERS HERE, deliberately: an ABSENT key means
     * the read did not join membership and nobody measured; `null` means it did and this
     * task is a member of no branch. Declared rather than left to `.passthrough()` because
     * a field a consumer is expected to read is a contract, and an undeclared one is a
     * contract nobody can see.
     */
    branchMembership: z
      .object({
        spineId: z.string(),
        spineType: z.string(),
        source: z.string(),
      })
      .nullable()
      .optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

/**
 * THE RECORD-BEARING CONTRACT, BY IDENTITY. Exported so the serializer guard
 * can DERIVE "which ops return a task / context / decision" from the output schemas by object
 * identity (an op's schema embeds one of these three instances) rather than from a hand list
 * of op names. Add a fourth record type here and the guard's population grows on its own.
 */
export const RECORD_OUTPUT_SCHEMAS = Object.freeze({
  task: taskRecord,
  context: contextRecord,
  decision: decisionRecord,
});

/** A single project record (raw values). */
const projectRecord = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    status: z.string().optional(),
    contextCount: z.number().optional(),
    isActive: z.boolean().optional(),
    gitRepoUrl: z.string().nullable().optional(),
    rootDirectory: z.string().nullable().optional(),
    metadata: z.record(z.any()).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

/**
 * A single typed-edge result item (T2a) — the connected node hydrated for traversal.
 * Raw values; the consumer (T2b trust / T3 recall_thread) reads this, never SQL.
 */
const edgeRecord = z
  .object({
    edgeType: z.string(),
    direction: z.string(),
    connectedId: z.string(),
    connectedType: z.string(),
    connectedTitle: z.string().nullable().optional(),
    edgeId: z.string(),
    /**
     * SK8 — edge provenance, advertised in the CONTRACT. `mintVia` is the
     * `links.mint_via` column (SK4's normalized closed vocabulary); `provenanceClass` is the
     * generated declared|guessed|unclassified over it. Read from the column, never metadata.
     */
    mintVia: z.string().nullable().optional(),
    provenanceClass: z.string().nullable().optional(),
    metadata: z.record(z.any()).optional(),
  })
  .passthrough();

/**
 * recall_thread (T3) output shapes — the headline pull tool's consolidated thread.
 * A thread NODE carries the ordered record + its trust (default-on, the moat) + optional
 * content (present at summary/full, omitted at headline). A thread EDGE is the from→to×type
 * triple of the collected subgraph. Raw values; the consumer narrates, never re-parses SQL.
 */
const threadNode = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string().nullable().optional(),
    trust: trustObject,
    content: z.string().optional(),
  })
  .passthrough();

const threadEdge = z
  .object({
    from: z.string(),
    to: z.string(),
    type: z.string(),
  })
  .passthrough();

/**
 * CURRENT-STATE altitude shapes. A SECTION is a capped list
 * that reports exactly what the cap dropped (never a silently short list).
 *
 * WHY THE ITEMS ARE `z.record` AND NOT THE FULL NODE SHAPE — a measured trade, not laziness.
 * A current-state node is a thread node plus a lifecycle stamp; spelling that out inline made
 * recall_thread's ADVERTISED entry grow 3967 → 13898 bytes (3.5x, +9% of the whole tools/list
 * surface), because the nested `trust` object then serializes FIVE times — once per section
 * plus the root. That is a direct tax on the MCP-2026 token-cut workstream
 * in exchange for validating a handful of optional strings that `.passthrough()` was going to
 * admit anyway. So the STRUCTURE that carries meaning is declared strictly below (the gate,
 * the accounting, and the omission counts — the honesty contract this read model turns on) and
 * the item lists stay open. The node fields are contract-tested at the route instead, where a
 * missing field actually fails something.
 */
const currentStateSection = z
  .object({
    items: z.array(z.record(z.any())),
    total: z.number(),
    omittedByCap: z.number(),
  })
  .passthrough();

/**
 * The current-state payload. `omitted` is REQUIRED inside it, not optional: the superseded
 * COUNT is the honesty signal this whole read model turns on, and a schema that lets it be
 * absent is a schema that permits the silent omission the model exists to prevent.
 */
// EXPLICIT ANNOTATION, not inference (TS7056): this shape is nested deeply enough that
// letting tsc infer it pushes the whole `outputZodSchemas` registry past the serializable
// type-length ceiling. The annotation changes nothing at runtime — the schema still validates
// exactly these fields — it just stops the compiler from expanding the literal type.
/** A counted-and-sampled omission bucket — one shape, three subtypes. */
const historicalBucketSchema = z
  .object({
    count: z.number(),
    byType: z.record(z.number()),
    sampleIds: z.array(z.string()),
    sampleOmitted: z.number(),
  })
  .passthrough();

const currentStatePayload: z.ZodTypeAny = z
  .object({
    root: z.record(z.any()).nullable(),
    activeTasks: currentStateSection,
    blockers: currentStateSection,
    latestTrustedOutcomes: currentStateSection,
    // The recency door — same section shape, no trust gate.
    recentContexts: currentStateSection,
    currentDecisions: currentStateSection,
    artifactHead: z.record(z.any()).nullable(),
    artifactIssues: z.array(z.string()),
    nextAction: z
      .object({
        gate: z.string(),
        gateReason: z.string(),
        action: z.string(),
        targetId: z.string().nullable(),
        targetType: z.string().nullable(),
      })
      .passthrough(),
    omitted: z
      .object({
        superseded: z
          .object({
            count: z.number(),
            byType: z.record(z.number()),
            sampleIds: z.array(z.string()),
            sampleOmitted: z.number(),
          })
          .passthrough(),
        // The HISTORICAL SPLIT. `count`/`byType` are the unchanged umbrella;
        // the three subtype blocks are ADDITIVE and always present, and they sum to `count`.
        historical: z
          .object({
            count: z.number(),
            byType: z.record(z.number()),
            completed: historicalBucketSchema,
            abandoned: historicalBucketSchema,
            unknown: historicalBucketSchema,
          })
          .passthrough(),
      })
      .passthrough(),
    counts: z
      .object({
        examined: z.number(),
        listed: z.number(),
        superseded: z.number(),
        historical: z.number(),
        historicalCompleted: z.number(),
        historicalAbandoned: z.number(),
        historicalUnknown: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * The full recall_thread structuredContent contract (spec §4 Capability 2).
 * REQUIRED = `ok` ONLY: the unresolvable-anchor error path returns {ok:false,found:false}
 * (none of the thread fields), so every descriptive field is optional. `found` documents
 * the error-path discriminator. All present on the SUCCESS path; none guaranteed on error.
 *
 * TWO ANSWER SHAPES, one tool: a CONTENT altitude returns `nodes`+`edges`
 * (the ordered story); the `current` PROJECTION altitude returns `currentState` instead.
 * `altitude` is the discriminator, and it is always present on the success path.
 */
const recallThreadShape = z
  .object({
    ok,
    found: z.boolean().optional(),
    anchor: z.string().optional(),
    altitude: z.string().optional(),
    /**
     * THE EXPLICIT SHAPE DISCRIMINATOR: `thread` (nodes + edges) or
     * `currentState` (the projection). `altitude` always implied it; a consumer had to know
     * the altitude taxonomy to decode that, and ours did not — it read `nodes.length` on a
     * `current` response and reported 0 for a walk that examined 49 records. `currentState`
     * responses carry NO `nodes` key at all (never an empty array — that would be a lie).
     */
    shape: z.enum(['thread', 'currentState']).optional(),
    depthUsed: z.number().optional(),
    nodes: z.array(threadNode).optional(),
    edges: z.array(threadEdge).optional(),
    abstain: z.array(z.string()).optional(), // trust-render-exempt: SCHEMA KEY — the thread-level abstain LIST of ids, not a per-record marker
    currentState: currentStatePayload.optional(),
    truncated: z.boolean().optional(),
    truncatedCount: z.number().optional(),
    /** The node cap the caller ASKED for, before the server ceiling clamp. */
    maxNodesRequested: z.number().optional(),
    /**
     * WHAT THE WALK DROPPED — the trust floor, dangling referents, the edges
     * that went with them, and (story path only) the bodies clipped by the snippet budget.
     * Present on BOTH answer shapes; `clippedNodes` is a presentation count, so it rides only
     * on the content-altitude shape.
     */
    omissions: z
      .object({
        examined: z.number(),
        droppedDangling: z.number(),
        droppedByMinTrust: z.number(),
        droppedEdges: z.number(),
        clippedNodes: z.number().optional(),
      })
      .passthrough()
      .optional(),
    total: z.number().optional(),
  })
  .passthrough();

/**
 * One branch position (PHASE 1 positional membership): the spine record the
 * session is standing on. Nullable at the call sites: `position` is null when no branch is
 * open (branch_current with nothing open, after branch_close, or an error path).
 */
const branchPosition = z
  .object({
    spineId: z.string(),
    spineType: z.string(),
    spineTitle: z.string().nullable().optional(),
    spineUrl: z.string().nullable().optional(),
    openedAt: z.string().optional(),
  })
  .passthrough();

/**
 * The branch_open / branch_current / branch_close structuredContent contract. REQUIRED =
 * `ok` ONLY (same reasoning as threadAnchorShape: rejection paths return {ok:false,...}
 * with no position; a throw → formatMcpError → seam returns a bare {ok:false}).
 */
/**
 * branch_assign (P3) — the record's branch was DECLARED, and which of the
 * three things happened.
 *
 * REQUIRED = `ok` ONLY, same reasoning as the other branch shapes: an unresolvable record or
 * spine, a missing project, a self-membership refusal and a throw all return {ok:false} with
 * no member, and a required `member` would turn every honest refusal into a schema violation.
 *
 * `action` and `previousSpineId` are ADVERTISED because they are the pair that makes a MOVE
 * visible. `action:'moved'` with `previousSpineId` naming the branch that just lost the
 * record is the whole safety property of a tool that rewrites an immutable fact; a client
 * entitled to ignore them would render a silent move.
 */
const branchAssignShape = z
  .object({
    ok,
    /** 'assigned' (was on no branch) | 'moved' (was on another) | 'unchanged' | 'rejected'. */
    action: z.string().optional(),
    member: z
      .object({ id: z.string(), type: z.string(), url: z.string().nullable().optional() })
      .passthrough()
      .optional(),
    spine: z
      .object({
        id: z.string(),
        type: z.string(),
        title: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    /** The branch it left. NULL = it was a member of NOTHING, which is a different history. */
    previousSpineId: z.string().nullable().optional(),
    /** The stored MEMBERSHIP_SOURCE ('assigned'), or null when nothing was written. */
    spineSource: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * branch_unassign (P3) — the membership row is gone; the event is not.
 * `previousSpineId` is the branch it left, and it is the only thing in the response that
 * says the removal actually removed something (`action:'absent'` carries null).
 */
const branchUnassignShape = z
  .object({
    ok,
    /** 'unassigned' (a row was removed) | 'absent' (there was none) | 'rejected'. */
    action: z.string().optional(),
    member: z
      .object({ id: z.string(), type: z.string(), url: z.string().nullable().optional() })
      .passthrough()
      .optional(),
    previousSpineId: z.string().nullable().optional(),
  })
  .passthrough();

const branchPositionShape = z
  .object({
    ok,
    action: z.string().optional(),
    position: branchPosition.nullable().optional(),
    previousPosition: z.object({ spineId: z.string(), spineType: z.string() }).nullable().optional(),
    closedPosition: z.object({ spineId: z.string(), spineType: z.string() }).nullable().optional(),
  })
  .passthrough();

/**
 * branch_history (SK2) — the durable member list of a branch, open or closed.
 *
 * REQUIRED = `ok` ONLY, same reasoning as branchPositionShape: an unresolvable spine, a
 * missing project or a throw all return {ok:false} with no members, and a required `members`
 * would turn every one of those honest refusals into a schema violation.
 *
 * THE COMPLETENESS SIGNALS ARE ADVERTISED rather than left to ride the passthrough, because
 * a signal that is not in the contract is one a client is entitled to ignore — which turns a
 * short or approximate list back into one that reads as whole. They are:
 *   `omitted` / `truncated`                — this RESPONSE is short of the branch (paging).
 *   `approximateMembers`                   — rows that ARE here whose branch was inferred
 *                                            from a pre-086 write rather than recorded.
 *   `possiblyIncomplete`                   — a row that belongs here may be MISSING, same
 *                                            pre-086 cause.
 *   `tagOnlyNoPosition`                    — records that TAG this spine and carry no
 *                                            recorded position. NOT members; the seam left
 *                                            by the pre-086 edge dedup, surfaced separately
 *                                            so it can be neither merged in nor dropped.
 *   `exact`                                — none of the above; the answer is a fact, and a
 *                                            FORWARD-ONLY claim (true for post-086 branches).
 *
 * The advertised set MATCHES the response exactly (the reviewer F6): `depthLimitReached` and
 * `walkCapReached` are GONE, along with the walk that could produce them. A schema that
 * advertises a field nothing emits teaches a client to branch on a signal that never fires.
 */
const branchHistoryShape = z
  .object({
    ok,
    action: z.string().optional(),
    spine: z
      .object({
        id: z.string(),
        type: z.string(),
        title: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    members: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string(),
            title: z.string().nullable().optional(),
            url: z.string().nullable().optional(),
            /**
             * The surviving `informs` edge that renders this membership in the graph.
             * NULLABLE, and null is NOT "not a member": membership is its own row
             * (branch_memberships, migration 086) and the edge can be deduped into an earlier
             * tag mint or unlinked. mintVia is frequently 'tag' for that reason.
             */
            edgeType: z.string().nullable().optional(),
            mintVia: z.string().nullable().optional(),
            provenanceClass: z.string().nullable().optional(),
            createdAt: z.string().optional(),
            /** Where the edge attached (the spine, or an earlier member if the tip moved). */
            attachedToId: z.string().optional(),
            /** 'recorded' | 'legacy-approx' — MEMBERSHIP_SOURCE, migration 086. */
            spineSource: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
    memberCount: z.number().optional(),
    totalMembers: z.number().optional(),
    omitted: z.number().optional(),
    open: z.boolean().optional(),
    truncated: z.boolean().optional(),
    approximateMembers: z.number().optional(),
    possiblyIncomplete: z.boolean().optional(),
    /** BAND 3: records that tag this spine but carry no recorded position. NOT members. */
    tagOnlyNoPosition: z.number().optional(),
    /**
     * BAND 3'S IDS (P3) — the DISCOVERY SURFACE for branch_assign, bounded by
     * BRANCH_HISTORY_CONFIG.tagOnlyIdLimit. ADVERTISED rather than left to ride the
     * passthrough for the same reason the completeness signals are: a field a client is
     * entitled to ignore is one it will. `tagOnlyIdsTruncated` is the third state — the
     * count is complete, this list may not be, and a client must not infer completeness
     * from its length.
     */
    tagOnlyNoPositionIds: z.array(z.string()).optional(),
    tagOnlyIdsTruncated: z.boolean().optional(),
    exact: z.boolean().optional(),
  })
  .passthrough();

/** A single smart-search / recommendation result item. */
const searchResultItem = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    relevanceScore: z.number().optional(),
    source: z.string().optional(),
    // TRUST (T2b) — default-on on smart_search result rows (context/decision items).
    trust: trustObject.optional(),
  })
  .passthrough();

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SHAPES — list / get / mutate / status / stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LIST/SEARCH shape: a typed `results` array + pagination counters.
 * REQUIRED = `ok` ONLY. The happy + empty paths carry results+total, but an error path
 * (e.g. "no current project set" → formatMcpError → seam {ok:false}) carries neither, so
 * `results`/`total` are optional (the schema still documents them in `properties`).
 */
const listShape = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      ok,
      results: z.array(item).optional(),
      // GRAND TOTAL of all matching records — NOT the returned slice length.
      total: z.number().optional(),
      page: z.number().optional(),
      limit: z.number().nullable().optional(),
      // PAGINATION metadata (task_list): `returned` = this page's row count,
      // `offset` = window start, `hasMore` = more rows match beyond this window.
      returned: z.number().optional(),
      offset: z.number().optional(),
      hasMore: z.boolean().optional(),
    })
    .passthrough();

/**
 * GET/DETAIL shape: `found` + one optional record.
 * REQUIRED = `ok` ONLY. A throw → formatMcpError → seam returns a bare {ok:false}
 * with no `found`, so `found` is optional (present on the success + not-found paths).
 */
const getShape = <T extends z.ZodTypeAny>(recordKey: string, item: T) =>
  z
    .object({ ok, found: z.boolean().optional(), [recordKey]: item.optional() })
    .passthrough();

/**
 * MUTATE shape: the affected record + the action performed.
 * REQUIRED = `ok` ONLY. The error/ambiguous/not-found paths ({ok:false,found:false} /
 * {ok:false,ambiguous:true} / bare {ok:false}) omit `action`, so `action` is optional
 * (present on every SUCCESS path). This is the exact task_create-error break contoso hit.
 */
const mutateShape = <T extends z.ZodTypeAny>(recordKey: string, item: T) =>
  z
    .object({ ok, action: z.string().optional(), [recordKey]: item.optional() })
    .passthrough();

/** STATUS/STATS shape: free-form raw status payload (always has `ok`). */
const statusShape = z.object({ ok }).passthrough();

/**
 * CLAIM shape: the answer to "did I get exclusive ownership?".
 *
 * Deliberately NOT a task record — a claim verdict is a different thing from a task, and
 * pretending otherwise would push the caller back into guessing. `claimed:false` always
 * carries a typed `reason` so a loser can DECIDE (back off / re-read / re-claim) rather than
 * retry blindly. Every field but `ok` is optional because the granted and refused shapes are
 * disjoint (THE REQUIRED-SET RULE).
 */
const claimShape = z
  .object({
    ok,
    claimed: z.boolean().optional(),
    released: z.boolean().optional(),
    action: z.string().optional(),
    taskId: z.string().optional(),
    claimId: z.string().optional(),
    actor: z.string().nullable().optional(),
    version: z.number().nullable().optional(),
    status: z.string().nullable().optional(),
    expiresAt: z.string().nullable().optional(),
    leaseSeconds: z.number().optional(),
    reentered: z.boolean().optional(),
    reason: z.string().optional(),
    currentAssignee: z.string().nullable().optional(),
    currentActor: z.string().nullable().optional(),
    currentStatus: z.string().nullable().optional(),
    currentVersion: z.number().nullable().optional(),
  })
  .passthrough();

/**
 * ARTIFACT-RESOLUTION shape: the answer to "where is the
 * external artifact this record accepted, and is the one I fetched the right one?".
 *
 * Deliberately NOT a context/task/decision record — the record is just where the reference is
 * STORED; the answer is a retrieval + verification contract. `accepted` is the fail-closed
 * gate a consumer keys off: true ONLY when every declared identity field was observed AND
 * matched. REQUIRED = `ok` ONLY (the not-found / no-references / blocked paths omit the
 * descriptive fields — THE REQUIRED-SET RULE).
 */
const artifactShape = z
  .object({
    ok,
    recordId: z.string().optional(),
    recordType: z.string().optional(),
    /** Always false — Mandrel never stores the artifact bytes. Stated so the boundary travels. */
    storesArtifactBytes: z.boolean().optional(),
    count: z.number().optional(),
    /** True only when a verification was requested AND every declared identity matched. */
    accepted: z.boolean().optional(),
    /** 'verified' | 'unverified' | 'blocked' when a specific reference was adjudicated. */
    verificationStatus: z.string().optional(),
    reason: z.string().optional(),
    artifacts: z.array(z.record(z.any())).optional(),
    errors: z.array(z.string()).optional(),
  })
  .passthrough();

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION shapes (mandrel_help / mandrel_explain / mandrel_examples).
//
// BUG-FIX: these prose tools used to declare `statusShape` and emit
// an EMPTY `{ ok: true }` structuredContent — the actual help/params/examples lived
// ONLY in the human `content` text. A dual-channel MCP client (Claude Code) surfaces
// structuredContent and drops `content`, so the caller saw a bodiless `{ ok:true }`.
// The real help now rides the MACHINE channel too, as RAW values (no markdown), which
// is exactly what these shapes document. REQUIRED = `ok` ONLY (the not-found / no-
// examples paths omit the descriptive fields — THE REQUIRED-SET RULE), all descriptive
// fields `.optional()`, `.passthrough()` tolerant of extra raw fields.
// ─────────────────────────────────────────────────────────────────────────────
const explainShape = z
  .object({
    ok,
    tool: z.string().optional(),
    category: z.string().optional(),
    description: z.string().optional(),
    parameters: z
      .array(
        z
          .object({
            name: z.string(),
            type: z.string(),
            required: z.boolean(),
            description: z.string(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const examplesShape = z
  .object({
    ok,
    tool: z.string().optional(),
    examples: z
      .array(
        z.object({ title: z.string(), example: z.string() }).passthrough()
      )
      .optional(),
  })
  .passthrough();

/**
 * THE AGENT CAPTURE CONTRACT (P4 L1). The MACHINE channel matters more than
 * usual here: the whole point of the action is that a caller can read the shape it is
 * supposed to write, and a shape delivered only as markdown is a shape that has to be parsed
 * out of prose. Every field below is RENDERED FROM config/captureVocab.ts + OP_REGISTRY —
 * nothing in this schema is a place to hand-write a second copy of the contract.
 * REQUIRED = `ok` ONLY (THE REQUIRED-SET RULE), all descriptive fields optional, passthrough.
 */
const captureContractShape = z
  .object({
    ok,
    /** Where the block lives: `metadata.<metadataKey>` on any write that accepts metadata. */
    metadataKey: z.string().optional(),
    statusKey: z.string().optional(),
    evidenceKey: z.string().optional(),
    /** The DECLARED states, in vocabulary order. `absent` is deliberately NOT among them. */
    statuses: z
      .array(
        z
          .object({
            status: z.string(),
            meaning: z.string(),
            requiresEvidence: z.boolean(),
          })
          .passthrough()
      )
      .optional(),
    /** The fourth state, stated separately BECAUSE it has no value to enumerate. */
    absent: z.string().optional(),
    /** What to write, when, and the op that writes it — opIds resolved against OP_REGISTRY. */
    recordShapes: z
      .array(
        z
          .object({
            shape: z.string(),
            opId: z.string(),
            opDescription: z.string(),
            when: z.string(),
            why: z.string(),
          })
          .passthrough()
      )
      .optional(),
    /** A ready-to-send example of the block, generated from the vocabulary. */
    example: z.record(z.any()).optional(),
  })
  .passthrough();

const helpShape = z
  .object({
    ok,
    totalTools: z.number().optional(),
    totalCategories: z.number().optional(),
    categories: z
      .array(
        z
          .object({
            category: z.string(),
            tools: z
              .array(
                z
                  .object({ name: z.string(), description: z.string() })
                  .passthrough()
              ),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY — every public tool → its zod output schema.
// Tools of the same response kind REUSE the shared shapes above.
// ─────────────────────────────────────────────────────────────────────────────

export const outputZodSchemas = {
  // System & Navigation — status payloads.
  mandrel_ping: statusShape,
  mandrel_status: statusShape,
  // Navigation: the real help/params/examples ride the MACHINE channel
  // now (was an empty `{ok:true}` — see the NAVIGATION shapes above).
  mandrel_help: helpShape,
  mandrel_explain: explainShape,
  mandrel_examples: examplesShape,
  // THE AGENT CAPTURE CONTRACT (P4 L1) — discover({action:'contract'}).
  mandrel_contract: captureContractShape,

  // Session Lifecycle (session-rework SR-2) — status payloads carrying
  // ok + an action/active flag + the session summary record (free-form; statusShape's
  // passthrough keeps the rich session object without re-typing every field here).
  session_start: statusShape,
  session_end: statusShape,
  session_status: statusShape,
  // Sessions Foundation Phase 2a — pin get/set/clear returns ok + action + the pin record
  // (actor/sessionId/pinnedAt) or null; passthrough keeps the free-form pin object.
  session_pin: statusShape,
  // Amp-orb eval W3 — the session IDENTITY read model.
  // DELIBERATELY OPEN (statusShape's passthrough) rather than spelling the identity record
  // out field-by-field: the shape is owned by ONE builder (buildSessionIdentity) and asserted
  // by its contract test, and re-declaring 18 fields here would be a second copy of that shape
  // that can silently drift from the first — the exact class a past incident names. It would also
  // cost real wire bytes on every tools/list (measured on recall_thread: a fully-spelled nested
  // output schema cost +9.1% of the whole surface).
  session_list: statusShape,
  session_get: statusShape,

  // Context.
  context_store: mutateShape('context', contextRecord),
  context_search: listShape(contextRecord),
  context_get_recent: listShape(contextRecord),
  // CURATE (T1 item 4): context_update — mutate shape (the edited record).
  context_update: mutateShape('context', contextRecord),
  context_stats: statusShape,
  // ARTIFACT REFERENCES: resolve + fail-closed verify.
  context_artifact: artifactShape,
  // Soft-delete / archive — mutate shape (the archived/restored record).
  context_delete: mutateShape('context', contextRecord),
  context_restore: mutateShape('context', contextRecord),

  // Project.
  project_list: listShape(projectRecord),
  project_create: mutateShape('project', projectRecord),
  project_update: mutateShape('project', projectRecord),
  // REPROJECT — MOVE a record between projects. The machine
  // channel carries the whole verdict as RAW values: the UNCHANGED record id, both
  // projects, the preserved provenance, the per-table follower counts and the edge policy's
  // four numbers. A caller can VERIFY the move from this payload without a second read,
  // which is what "preserving id + timestamps + edges" has to mean to be checkable.
  // REQUIRED = `ok` ONLY (the required-set rule); passthrough tolerant of extra raw fields.
  project_move_record: statusShape,
  project_delete: mutateShape('project', projectRecord),
  project_switch: mutateShape('project', projectRecord),
  project_current: getShape('project', projectRecord),
  project_info: getShape('project', projectRecord),
  // WS2 living summary — DELIBERATELY the shared open statusShape (the
  // session_list precedent): the briefing payload's shape is owned by ONE builder
  // (services/projectBriefing.ts) and its contract test; re-declaring it here would be a
  // second copy that can drift, and would cost wire bytes on every tools/list.
  project_briefing: statusShape,

  // Decisions.
  decision_record: mutateShape('decision', decisionRecord),
  decision_search: listShape(decisionRecord),
  decision_get: getShape('decision', decisionRecord),
  decision_update: mutateShape('decision', decisionRecord),
  decision_stats: statusShape,
  // Soft-delete / archive.
  decision_delete: mutateShape('decision', decisionRecord),
  decision_restore: mutateShape('decision', decisionRecord),
  // THE DECISION INBOX.
  decision_answer: mutateShape('decision', decisionRecord),
  decision_discuss: mutateShape('decision', decisionRecord),

  // Tasks.
  task_create: mutateShape('task', taskRecord),
  task_list: listShape(taskRecord),
  task_update: mutateShape('task', taskRecord),
  task_details: getShape('task', taskRecord),
  task_bulk_update: statusShape,
  task_progress_summary: statusShape,
  // Soft-delete / archive.
  task_delete: mutateShape('task', taskRecord),
  task_restore: mutateShape('task', taskRecord),
  // Cancel convenience tool — sets status='cancelled'.
  cancel_task: mutateShape('task', taskRecord),
  // ATOMIC TASK CLAIM — a claim answer is NOT a task record: it is a
  // verdict. `ok` is always present; `claimed` says whether you won; a refusal carries the
  // TYPED `reason` + the current holder. THE REQUIRED-SET RULE: only `ok` is required,
  // because the won-shape and the refused-shape share no other field.
  task_claim: claimShape,
  task_renew: claimShape,
  task_release: claimShape,

  // Smart Search & AI.
  smart_search: listShape(searchResultItem),
  get_recommendations: listShape(searchResultItem),
  project_insights: statusShape,
  project_tags: statusShape,

  // Typed-edge graph (T2a). link/unlink are mutate-shaped (the affected edge + action);
  // get_links is list-shaped (the connected edges, both directions).
  link: mutateShape('edge', edgeRecord),
  unlink: mutateShape('edge', edgeRecord),
  get_links: listShape(edgeRecord),

  // recall_thread (T3) — the consolidated traversal-narrative thread (bespoke shape).
  recall_thread: recallThreadShape,

  // Branch position (PHASE 1 positional membership).
  branch_open: branchPositionShape,
  branch_current: branchPositionShape,
  branch_close: branchPositionShape,
  branch_history: branchHistoryShape,

  // Mutable branch membership (P3) — declare / remove a record's branch.
  branch_assign: branchAssignShape,
  branch_unassign: branchUnassignShape,

  // DEPRECATED anchor aliases — they delegate to branch_*, so their structured shape IS the
  // branch position shape (the deprecated/replacement fields ride the passthrough). The old
  // threadAnchorShape/activeThreadAnchor definitions were deleted with the anchor.
  thread_set: branchPositionShape,
  thread_current: branchPositionShape,
  thread_clear: branchPositionShape,
} as const;

export type OutputSchemaToolName = keyof typeof outputZodSchemas;

/**
 * Build the JSON Schema (MCP `outputSchema`) for a tool from its zod output schema.
 * Mirrors toolDefinitions.buildInputSchema EXACTLY (same zodToJsonSchema options),
 * so input and output schemas are produced by one consistent mechanism.
 */
export function buildOutputSchema(toolName: OutputSchemaToolName): JsonObjectSchema {
  const zodSchema = outputZodSchemas[toolName];
  const json = zodToJsonSchema(zodSchema as any, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as any;

  return {
    type: 'object',
    properties: { ...(json.properties ?? {}) },
    required: Array.isArray(json.required) ? json.required : [],
    // Tolerant egress: a tool may emit extra raw fields beyond the required contract.
    additionalProperties: true,
  };
}
