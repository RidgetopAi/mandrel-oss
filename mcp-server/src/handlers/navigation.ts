/**
 * Mandrel Navigation Handler - Phase 1 Navigation Enhancement
 *
 * Solves the Mandrel discoverability problem by providing:
 * 1. mandrel_help - Categorized tool listing
 * 2. mandrel_explain - Detailed tool documentation
 * 3. mandrel_examples - Usage examples and patterns
 *
 * This transforms Mandrel from a flat list of mysterious tools into a discoverable, learnable system.
 */

import {
  AIDIS_TOOL_DEFINITIONS,
  CATEGORY_ORDER,
  TOOL_CATEGORIES,
  categoryForTool,
} from '../config/toolDefinitions.js';
import {
  countAdvertisedSurface,
  describeAdvertisedSurface,
  listAdvertisedOperations,
} from '../config/advertisedSurface.js';
import { OP_BY_ID } from '../config/opRegistry.js';
import {
  CAPTURE_ABSENT_MEANING,
  CAPTURE_EVIDENCE_KEY,
  CAPTURE_METADATA_KEY,
  CAPTURE_RECORD_SHAPES,
  CAPTURE_STATUSES,
  CAPTURE_STATUS_KEY,
  CAPTURE_STATUS_MEANING,
  statusRequiresEvidence,
} from '../config/captureVocab.js';
// THE GATE SHAPE. The capture contract already tells agents to record "the
// gate and its exit code" (CAPTURE_RECORD_SHAPES, the REVIEW VERDICT shape) — and until this
// section existed it named the field without ever stating its shape, so an agent was told to
// write it, given nothing to write, and then refused by the write validator. Generated from
// config exactly like the vocabulary above: no hand-written copy to rot.
import {
  GATE_ABSENT_MEANING,
  GATE_CONTRACT_EXAMPLE,
  GATE_EXIT_CODE_ALIASES,
  GATE_FIELD_SPECS,
  GATE_METADATA_KEY,
  GATE_REF_ALIASES,
} from '../config/gateMetadataVocab.js';

class NavigationHandler {
  /**
   * Build the rendered catalog (category → [{name, description}]) DERIVED from the
   * single source of truth: AIDIS_TOOL_DEFINITIONS for the tool set + descriptions,
   * TOOL_CATEGORIES/CATEGORY_ORDER (config/toolDefinitions.ts) for the grouping + order.
   *
   * CATALOG-DRIFT CLASS FIX: there is no longer a second hand-maintained
   * `toolCatalog` here to drift from the definitions. Every tool that exists is rendered
   * (the import-time coverage guard in toolDefinitions.ts + the helpCatalog contract test
   * guarantee every tool is categorized exactly once), and the counts are computed from
   * this derived structure — never hardcoded.
   */
  private buildCatalog(): Array<{ category: string; tools: Array<{ name: string; description: string }> }> {
    const descByName = new Map(AIDIS_TOOL_DEFINITIONS.map((d) => [d.name, d.description]));
    return CATEGORY_ORDER.map((category) => ({
      category,
      tools: TOOL_CATEGORIES[category].map((name) => ({
        name,
        description: descByName.get(name) ?? '',
      })),
    }));
  }

  /**
   * The mandrel_help BODY on EVERY surface: each callable operation on the advertised surface,
   * grouped by the single-source categories (the reviewer follow-up).
   *
   * Derived from `listAdvertisedOperations()` — the SAME array whose length is the operation count
   * the header prints — so the body can never enumerate a different number of things than the
   * header claims. Each entry is labelled the way a caller on this surface actually invokes it
   * (`context({action:'store'})`), not by its flat op name, because on the gateway surface that is
   * the honest call form.
   *
   * EACH ENTRY ALSO CARRIES ITS FLAT OP ID, and the renderer prints it whenever it differs
   * from the label. WHY: the surface is a PROCESS-WIDE setting, but the flat
   * `/mcp/tools/{opId}` HTTP routes are live on every instance regardless of it. So on a
   * gateway-surface instance a curl/CI/cron caller was shown ONLY `discover({action:'contract'})`
   * — a call form its transport does not have — and the name it must actually POST,
   * `mandrel_contract`, appeared NOWHERE in the catalog. MEASURED on the ref deployed to all 8
   * instances (2026-08-27): rendering mandrel_help under MANDREL_TOOL_SURFACE=gateway,
   * `text.includes('mandrel_contract')` was FALSE while `text.includes('branch_assign')` was
   * TRUE — because `graph({action:'branch_assign'})` happens to contain its op id as a substring
   * and `discover({action:'contract'})` does not. A tool findable only by callers who already
   * know its name is the exact failure the contract action was built to remove.
   *
   * An op whose category cannot be resolved is grouped under an explicit bucket rather than
   * dropped: a silent drop would break the body-equals-header invariant invisibly, which is the
   * exact failure mode this method exists to prevent. (The import-time coverage guard in
   * toolDefinitions.ts makes this structurally unreachable — it is fail-VISIBLE, not dead code.)
   */
  private buildOperationCatalog(): Array<{
    category: string;
    entries: Array<{ label: string; opId: string; description: string }>;
  }> {
    const UNCATEGORIZED = 'Uncategorized';
    const grouped = new Map<string, Array<{ label: string; opId: string; description: string }>>();

    for (const op of listAdvertisedOperations()) {
      const category = categoryForTool(op.opId) ?? UNCATEGORIZED;
      const entries = grouped.get(category) ?? [];
      entries.push({ label: op.label, opId: op.opId, description: op.description });
      grouped.set(category, entries);
    }

    // CATEGORY_ORDER first (the single source's own ordering), then anything unresolved.
    const order: string[] = CATEGORY_ORDER.filter((c) => grouped.has(c));
    if (grouped.has(UNCATEGORIZED)) order.push(UNCATEGORIZED);
    return order.map((category) => ({ category, entries: grouped.get(category)! }));
  }

  /**
   * Usage examples and common patterns for tools
   */
  private readonly toolExamples = {
    // System Health
    'mandrel_ping': [
      {
        title: 'Test basic connectivity',
        example: `mandrel_ping()`
      },
      {
        title: 'Test with custom message',
        example: `mandrel_ping({
  message: "Health check from agent"
})`
      }
    ],
    'mandrel_status': [
      {
        title: 'Get server health report',
        example: `mandrel_status()`
      }
    ],

    // Context Management
    'context_store': [
      {
        title: 'Store a code solution',
        example: `context_store({
  content: "Fixed authentication bug by adding null check in validateToken()",
  type: "code",
  tags: ["bug-fix", "authentication", "security"],
  relevanceScore: 8
})`
      },
      {
        title: 'Record a technical decision',
        example: `context_store({
  content: "Decided to use Redis for caching instead of in-memory due to scalability",
  type: "decision", 
  tags: ["architecture", "caching", "scalability"],
  relevanceScore: 9
})`
      },
      {
        title: 'Store planning notes',
        example: `context_store({
  content: "Phase 2 will focus on user authentication and authorization",
  type: "planning",
  tags: ["roadmap", "authentication", "phase-2"]
})`
      }
    ],
    'context_search': [
      {
        title: 'Fetch specific context by ID',
        example: `context_search({
  id: "86df4635-8090-41ff-a4d4-ed77925dbf17"
})`
      },
      {
        title: 'Find authentication-related contexts',
        example: `context_search({
  query: "authentication login security",
  type: "code",
  limit: 5
})`
      },
      {
        title: 'Search for recent error solutions',
        example: `context_search({
  query: "error handling exception",
  type: "error",
  minSimilarity: 70
})`
      },
      {
        title: 'Find all planning discussions',
        example: `context_search({
  query: "architecture database design",
  type: "planning",
  tags: ["database"]
})`
      }
    ],
    'context_get_recent': [
      {
        title: 'Get last 5 contexts',
        example: `context_get_recent({
  limit: 5
})`
      },
      {
        title: 'Get recent contexts for specific project',
        example: `context_get_recent({
  limit: 10,
  projectId: "web-app-project"
})`
      }
    ],
    'context_stats': [
      {
        title: 'Get current project stats',
        example: `context_stats()`
      },
      {
        title: 'Get stats for specific project',
        example: `context_stats({
  projectId: "mobile-app"
})`
      }
    ],
    'context_delete': [
      {
        title: 'Soft-delete (archive) a context by short id',
        example: `context_delete({
  contextId: "a1b2c3d4"
})`
      }
    ],
    'context_restore': [
      {
        title: 'Restore a previously archived context',
        example: `context_restore({
  contextId: "a1b2c3d4"
})`
      },
      {
        title: 'See archived contexts first, then restore',
        example: `context_search({ query: "old note", includeArchived: true })
context_restore({ contextId: "a1b2c3d4" })`
      }
    ],

    // Project Management
    'project_list': [
      {
        title: 'List all projects with stats',
        example: `project_list()`
      },
      {
        title: 'List projects without statistics',
        example: `project_list({
  includeStats: false
})`
      }
    ],
    'project_create': [
      {
        title: 'Create a new web application project',
        example: `project_create({
  name: "my-web-app",
  description: "React/Node.js web application",
  status: "active",
  gitRepoUrl: "https://github.com/user/my-web-app",
  rootDirectory: "/home/user/projects/my-web-app"
})`
      },
      {
        title: 'Create minimal project',
        example: `project_create({
  name: "quick-prototype"
})`
      }
    ],
    'project_switch': [
      {
        title: 'Switch by project name',
        example: `project_switch({
  project: "my-web-app"
})`
      },
      {
        title: 'Switch by project ID',
        example: `project_switch({
  project: "proj_123456"
})`
      }
    ],
    'project_current': [
      {
        title: 'Get current active project',
        example: `project_current()`
      }
    ],
    'project_info': [
      {
        title: 'Get project details by name',
        example: `project_info({
  project: "my-web-app"
})`
      }
    ],
    'project_move_record': [
      {
        title: 'Move a misfiled context into the right project',
        example: `project_move_record({
  recordType: "context",
  recordId: "d1452e76",
  toProject: "riverbend"
})`
      },
      {
        title: 'Move a task a customer filed under the wrong project',
        example: `project_move_record({
  recordType: "task",
  recordId: "8ce3a9f7-9900-4f47-913f-414d5e66e652",
  toProject: "globex"
})`
      },
      {
        title: 'Undo a move — it is the same call in reverse',
        example: `project_move_record({
  recordType: "context",
  recordId: "d1452e76",
  toProject: "personal"
})`
      }
    ],
    'project_update': [
      {
        title: 'Update description and status',
        example: `project_update({
  project: "my-web-app",
  description: "Now in maintenance mode",
  status: "paused"
})`
      },
      {
        title: 'Rename a project (by id or name)',
        example: `project_update({
  project: "old-name",
  name: "new-name"
})`
      },
      {
        title: 'Archive a finished project',
        example: `project_update({
  project: "legacy-prototype",
  status: "archived"
})`
      }
    ],
    'project_delete': [
      {
        title: 'Delete an empty project',
        example: `project_delete({
  project: "throwaway-test"
})`
      },
      {
        title: 'Delete a non-empty project (must confirm cascade)',
        example: `project_delete({
  project: "old-project",
  confirm: true
})`
      }
    ],

    // Technical Decisions
    'decision_record': [
      {
        title: 'Record architecture decision',
        example: `decision_record({
  decisionType: "architecture",
  title: "Use microservices architecture",
  description: "Split monolith into focused microservices",
  rationale: "Better scalability and team independence",
  impactLevel: "high"
})`
      }
    ],
    'decision_search': [
      {
        title: 'Find database decisions',
        example: `decision_search({
  query: "database schema design",
  decisionType: "database"
})`
      },
      {
        title: 'Read back the failed decisions (learning loop)',
        example: `decision_search({
  outcomeStatus: "failed",
  includeOutcome: true
})`
      }
    ],
    'decision_get': [
      {
        title: 'Fetch one decision by id with full outcome detail',
        example: `decision_get({
  decisionId: "123e4567-e89b-12d3-a456-426614174000"
})`
      }
    ],
    'decision_delete': [
      {
        title: 'Soft-delete (archive) a decision by short id',
        example: `decision_delete({
  decisionId: "9f8e7d6c"
})`
      }
    ],
    'decision_restore': [
      {
        title: 'Restore a previously archived decision',
        example: `decision_restore({
  decisionId: "9f8e7d6c"
})`
      }
    ],

    // Task Management
    'task_create': [
      {
        title: 'Create implementation task',
        example: `task_create({
  title: "Implement user authentication",
  description: "Add JWT-based auth with login/logout",
  priority: "high",
  assignedTo: "CodeAgent"
})`
      },
      {
        title: 'Create bug fix task',
        example: `task_create({
  title: "Fix login redirect issue",
  description: "Users not redirected after successful login",
  type: "bugfix",
  priority: "urgent",
  assignedTo: "QaAgent",
  tags: ["bug", "authentication", "frontend"]
})`
      }
    ],
    'task_update': [
      {
        title: 'Mark task as completed',
        example: `task_update({
  taskId: "59823126-9442-45dd-87e7-3dfae691e41f",
  status: "completed"
})`
      },
      {
        title: 'Reassign task to different agent',
        example: `task_update({
  taskId: "59823126-9442-45dd-87e7-3dfae691e41f",
  status: "in_progress",
  assignedTo: "CodeReviewGuru"
})`
      }
    ],
    'task_details': [
      {
        title: 'Get full task details',
        example: `task_details({
  taskId: "59823126-9442-45dd-87e7-3dfae691e41f"
})`
      },
      {
        title: 'Get task details for specific project',
        example: `task_details({
  taskId: "59823126-9442-45dd-87e7-3dfae691e41f",
  projectId: "my-project-id"
})`
      }
    ],
    'task_delete': [
      {
        title: 'Soft-delete (archive) a task by short id',
        example: `task_delete({
  taskId: "59823126"
})`
      }
    ],
    'task_restore': [
      {
        title: 'Restore a previously archived task',
        example: `task_restore({
  taskId: "59823126"
})`
      },
      {
        title: 'See archived tasks, then restore one',
        example: `task_list({ includeArchived: true })
task_restore({ taskId: "59823126" })`
      }
    ],

    // ATOMIC TASK CLAIM — the multi-worker coordination primitive. The
    // examples deliberately show the WHOLE loop (claim → work → complete-with-token) and the
    // conflict shape, because the failure mode we are preventing is a worker that treats a
    // refusal as success.
    'task_claim': [
      {
        title: 'Claim a task before working it (the safe way to pick up work)',
        example: `task_claim({
  taskId: "59823126"
})
// -> { claimed: true, claimId: "3f0c…", version: 4, expiresAt: "…" }
// -> { claimed: false, reason: "held", currentActor: "builder-a1b2" }  // someone else has it`
      },
      {
        title: 'The full loop: claim, work, then complete WITH the token (clears the claim)',
        example: `const c = task_claim({ taskId: "59823126" });
// … do the work …
task_update({ taskId: "59823126", claimId: c.claimId, status: "completed" })`
      },
      {
        title: 'Claim with an optimistic-lock check and a custom lease',
        example: `task_claim({
  taskId: "59823126",
  expectedVersion: 4,      // fail with version-stale if it changed since you read it
  leaseSeconds: 3600       // hold it for an hour
})`
      },
      {
        title: 'Claim a BLOCKED task too (widen the status guard explicitly)',
        example: `task_claim({
  taskId: "59823126",
  allowedStatuses: ["todo", "blocked"]
})`
      }
    ],
    'task_renew': [
      {
        title: 'Heartbeat a long-running claim before the lease expires',
        example: `task_renew({
  taskId: "59823126",
  claimId: "3f0c1d2e-…"
})
// -> { claimed: false, reason: "claim-lost" }  // you no longer own it — re-claim`
      }
    ],
    'task_release': [
      {
        title: 'Hand a claim back when you stop work without completing',
        example: `task_release({
  taskId: "59823126",
  claimId: "3f0c1d2e-…"
})
// Release returns OWNERSHIP only — the status stays "in_progress" (claiming set it there;
// release does not guess a status to roll back to). So the NEXT worker must widen the guard:
//   task_claim({ taskId: "59823126", allowedStatuses: ["todo", "in_progress"] })
// …or put the status back yourself BEFORE releasing:
//   task_update({ taskId: "59823126", claimId: "3f0c1d2e-…", status: "todo" })`
      }
    ],

    // Linking & Graph (the typed-edge graph + auto-threading moat).
    // Guarded by helpCatalog.contract.test.ts G7: every tool in this category MUST have
    // curated examples (a new moat tool without examples fails the suite, not silently).
    'link': [
      {
        title: 'Link a context to the decision that drove it',
        example: `link({
  from: "a1b2c3d4",
  fromType: "context",
  to: "9f8e7d6c",
  toType: "decision",
  edgeType: "decided_by"
})`
      },
      {
        title: 'Mark a decision as superseding an older one',
        example: `link({
  from: "3c1f0e9a",
  fromType: "decision",
  to: "77aa02b4",
  toType: "decision",
  edgeType: "supersedes"
})`
      },
      {
        title: 'Repair the graph: attach an orphaned capture to its task, with a note',
        example: `link({
  from: "b71c22e0",
  fromType: "context",
  to: "59823126",
  toType: "task",
  edgeType: "informs",
  metadata: { reason: "capture predates thread_set — back-filled" }
})`
      }
    ],
    'unlink': [
      {
        title: 'Remove a wrong edge (curate/repair)',
        example: `unlink({
  from: "a1b2c3d4",
  to: "9f8e7d6c",
  edgeType: "related_to"
})`
      },
      {
        title: 'Retype an edge: remove the wrong type, then link the right one',
        example: `unlink({ from: "a1b2c3d4", to: "59823126", edgeType: "related_to" })
link({ from: "a1b2c3d4", fromType: "context", to: "59823126", toType: "task", edgeType: "informs" })`
      }
    ],
    'get_links': [
      {
        title: 'Read every edge on a record, both directions',
        example: `get_links({
  id: "a1b2c3d4"
})`
      },
      {
        title: 'Only outgoing decision edges (what did this record decide/inform?)',
        example: `get_links({
  id: "a1b2c3d4",
  direction: "out",
  edgeTypes: ["decided_by", "informs"]
})`
      },
      {
        title: 'Who points AT this decision? (incoming edges only)',
        example: `get_links({
  id: "9f8e7d6c",
  direction: "in"
})`
      }
    ],
    'recall_thread': [
      {
        title: 'Read me in on a named thread (ref tag) — the cold-start one-call',
        example: `recall_thread({
  anchor: "ref:auth-redesign"
})`
      },
      {
        title: 'Full story around a decision, three hops out, full content per node',
        example: `recall_thread({
  anchor: "9f8e7d6c",
  altitude: "full",
  depth: 3
})`
      },
      {
        title: 'Headline scan, trusted material only (hide anything below the "ok" band)', // trust-render-exempt: EXAMPLE TITLE prose in the help catalog; renders no verdict
        example: `recall_thread({
  anchor: "ref:resume",
  altitude: "headline",
  minTrust: "ok"
})`
      },
      {
        title: 'Walk only the causal/outcome edges of a task\'s thread',
        example: `recall_thread({
  anchor: "59823126",
  edgeTypes: ["caused", "produced_outcome", "supersedes"]
})`
      }
    ],
    'branch_open': [
      {
        title: 'Stand on a branch — every write now stamps a declared edge to its spine',
        example: `branch_open({
  id: "59823126"
})
// context_store / decision_record / task_create each mint informs → the spine`
      },
      {
        title: 'Interrupt: switch branches, work, then pop back',
        example: `branch_open({ id: "b2b2b2b2" })   // the interrupt
context_store({ content: "hotfix note", type: "error" })
branch_open({ id: "59823126" })   // back to the original branch`
      },
      {
        title: 'The full working loop: open, capture, verify, close',
        example: `branch_open({ id: "59823126" })
context_store({ content: "Root cause: pool exhausted on retry storm", type: "error" })
branch_current()
branch_close()`
      }
    ],
    'branch_current': [
      {
        title: 'Show the branch this session is standing on',
        example: `branch_current()`
      }
    ],
    'branch_close': [
      {
        title: 'Step off the branch (idempotent — safe to call when none is open)',
        example: `branch_close()`
      }
    ],
    'branch_history': [
      {
        title: 'Read a branch back — what was written on it, in write order',
        example: `branch_history({ id: "59823126" })`
      },
      {
        title: 'Works AFTER the branch is closed, from any session',
        example: `branch_close()
// the position row is gone; the history is not
branch_history({ id: "59823126" })   // same members, same order`
      },
      {
        title: 'A long branch: page it, and read `omitted` rather than assuming completeness',
        example: `branch_history({ id: "59823126", limit: 20 })
// -> { memberCount: 20, totalMembers: 137, omitted: 117, truncated: true }`
      }
    ],
    'branch_assign': [
      {
        title: 'The record was written on the wrong branch — put it where it belongs',
        example: `branch_assign({
  id: "7c1d9f04",      // the record
  spine: "59823126"    // the branch it actually belongs to
})
// -> { action: "moved", previousSpineId: "b2b2b2b2-...", spineSource: "assigned" }`
      },
      {
        title: 'Claim a record that was never on any branch (band 3, from branch_history)', // trust-render-exempt: EXAMPLE TITLE prose; "band 3" is branch_history's MEMBERSHIP band (tag-only, no recorded position), not a trust band — renders no verdict
        example: `branch_history({ id: "59823126" })
// -> { tagOnlyNoPosition: 2, tagOnlyNoPositionIds: ["7c1d9f04-...", "aa31b0c2-..."] }
branch_assign({ id: "7c1d9f04", spine: "59823126" })
// -> { action: "assigned", previousSpineId: null }  — band 3 drains by one`
      },
      {
        title: 'Record WHY, so the audit row explains itself later',
        example: `branch_assign({
  id: "7c1d9f04",
  spine: "59823126",
  reason: "auto-opened onto the wrong task during a task_claim"
})`
      }
    ],
    'branch_unassign': [
      {
        title: 'An auto-opened position made this a member of something it is not',
        example: `branch_unassign({ id: "7c1d9f04" })
// -> { action: "unassigned", previousSpineId: "59823126-..." }
// the record and its edges are untouched; only the membership row goes`
      },
      {
        title: 'Idempotent — a record on no branch is not an error',
        example: `branch_unassign({ id: "7c1d9f04" })
// -> { action: "absent", previousSpineId: null }  (nothing removed, nothing logged)`
      }
    ],
    'thread_set': [
      {
        title: 'DEPRECATED — use branch_open (this alias warns and delegates)',
        example: `thread_set({ task: "59823126" })
// delegates to the replacement — call it directly instead:
branch_open({ id: "59823126" })`
      }
    ],
    'thread_current': [
      {
        title: 'DEPRECATED — use branch_current (this alias warns and delegates)',
        example: `thread_current()
// delegates to the replacement — call it directly instead:
branch_current()`
      }
    ],
    'thread_clear': [
      {
        title: 'DEPRECATED — use branch_close (this alias warns and delegates)',
        example: `thread_clear()
// delegates to the replacement — call it directly instead:
branch_close()`
      }
    ]

    // Session Management - DELETED (2025-10-24)
    // 5 session tools removed - sessions auto-manage via SessionTracker service
  };

  /**
   * Parse schema properties into RAW structured parameter records for the machine
   * channel (structuredContent). Same type/enum/array normalization the human
   * formatter uses, but returns data (no markdown) — the dual-channel contract
   *: the real params ride structuredContent, never only prose.
   */
  private parseSchemaParameters(
    inputSchema: any,
    requiredFields: string[] = []
  ): Array<{ name: string; type: string; required: boolean; description: string }> {
    if (!inputSchema?.properties || Object.keys(inputSchema.properties).length === 0) {
      return [];
    }

    const params: Array<{ name: string; type: string; required: boolean; description: string }> = [];
    for (const [propName, propSchema] of Object.entries<any>(inputSchema.properties)) {
      let typeDisplay = propSchema.type || 'any';
      if (typeDisplay === 'array' && propSchema.items?.type) {
        typeDisplay = `${propSchema.items.type}[]`;
      }
      if (propSchema.enum) {
        typeDisplay = propSchema.enum.map((v: any) => `"${v}"`).join(' | ');
      }
      params.push({
        name: propName,
        type: typeDisplay,
        required: requiredFields.includes(propName),
        description: propSchema.description || 'No description available',
      });
    }
    return params;
  }

  /**
   * Parse and format schema properties for display
   */
  private formatSchemaParameters(inputSchema: any, requiredFields: string[] = []): string {
    if (!inputSchema?.properties || Object.keys(inputSchema.properties).length === 0) {
      return '**Parameters:** None\n\n';
    }

    let output = '**Parameters:**\n';

    for (const [propName, propSchema] of Object.entries<any>(inputSchema.properties)) {
      const isRequired = requiredFields.includes(propName);
      const requiredLabel = isRequired ? ' *(required)*' : ' *(optional)*';

      // Format type nicely
      let typeDisplay = propSchema.type || 'any';

      // Handle arrays
      if (typeDisplay === 'array') {
        typeDisplay = 'array';
        if (propSchema.items?.type) {
          typeDisplay = `${propSchema.items.type}[]`;
        }
      }

      // Handle enums - show valid values
      if (propSchema.enum) {
        typeDisplay = propSchema.enum.map((v: any) => `"${v}"`).join(' | ');
      }

      // Handle description
      const description = propSchema.description || 'No description available';

      output += `• \`${propName}\` (${typeDisplay})${requiredLabel} - ${description}\n`;
    }

    output += '\n';
    return output;
  }

  /**
   * Generate categorized help listing of all AIDIS tools
   */
  async getHelp(): Promise<any> {
    // Catalog DERIVED from the single source (AIDIS_TOOL_DEFINITIONS + TOOL_CATEGORIES).
    const catalog = this.buildCatalog();
    // Counts are computed from the derived catalog — never hardcoded.
    const totalTools = catalog.reduce((sum, group) => sum + group.tools.length, 0);
    const totalCategories = catalog.length;

    // SURFACE-AWARE HEADER. Help used to announce the FLAT catalog size on every
    // surface, so an agent connected on the gateway surface — whose `tools/list` holds the gateway
    // envelopes, not the flat ops — was told it had ~60 "tools available" while it held ~11. Both
    // numbers below are MEASURED off the array `tools/list` actually serves
    // (config/advertisedSurface.ts) — never stated. See that module's header for the class.
    const surfaceCounts = countAdvertisedSurface();
    const isGateway = surfaceCounts.surface === 'gateway';

    // THE BODY IS THE HEADER'S OWN LIST (the reviewer finding on 22c79e9). The body must enumerate the
    // SAME operations the header counted, or the fix reintroduces the bug it was written to kill:
    // the first cut rendered the FLAT catalog under a gateway header, and the two disagreed by
    // exactly the `session_pin` fan-out (one flat entry, three gateway actions) — header 62, body
    // 60. `listAdvertisedOperations()` is the single walk; the header's operation count is that
    // array's LENGTH and this body renders that array, so they cannot diverge — they are not two
    // things being kept in sync.
    //
    // ONE builder for BOTH surfaces, deliberately: a surface-conditional body would be a second
    // derivation that agrees today and nothing keeps agreeing tomorrow. On LEGACY the
    // flat catalog IS the operation list one-for-one, so this renders the historical body BYTE-FOR-
    // BYTE — measured, not assumed (a mutation that forced the legacy branch to use this builder
    // produced identical output, which is what proved the branch was dead weight). Only the noun
    // stays surface-aware, because on legacy every tool is exactly one operation.
    const body = this.buildOperationCatalog();
    const unit = isGateway ? 'operations' : 'tools';

    let helpText = '🚀 **Mandrel**\n\n';
    if (isGateway) {
      // ONE renderer for this sentence (config/advertisedSurface.ts) — discover.catalog prints the
      // same one, so the two front doors cannot state different sizes for the same surface.
      helpText += `**${describeAdvertisedSurface(surfaceCounts)}:**\n\n`;
      helpText +=
        `_Your \`tools/list\` advertises ${surfaceCounts.tools} tools; every operation below is ` +
        `called on one of them, exactly as written. \`discover({action:'explain', tool:'…', ` +
        `op:'…'})\` gives any one its full contract._\n\n`;
    } else {
      helpText += `**${totalTools} Tools Available Across ${totalCategories} Categories:**\n\n`;
    }

    for (const { category, entries } of body) {
      helpText += `## ${category} (${entries.length} ${unit})\n`;

      for (const entry of entries) {
        // The flat op id is printed ONLY when the call form differs from it, so the LEGACY
        // rendering (where label === opId for every entry) is byte-identical to before.
        const flat = entry.label === entry.opId ? '' : ` \`${entry.opId}\``;
        helpText += `• **${entry.label}**${flat} - ${entry.description}\n`;
      }
      helpText += '\n';
    }

    helpText += '💡 **Quick Start:**\n';
    helpText += '• `mandrel_explain <toolname>` - Get detailed help for any tool\n';
    helpText += '• `mandrel_examples <toolname>` - See usage examples\n';
    helpText += '• `mandrel_ping` - Test connectivity\n';
    helpText += '• `project_current` - Check current project\n\n';
    
    helpText += '🎯 **Popular Workflows:**\n';
    helpText += '• Context: store → search → get_recent\n';
    helpText += '• Projects: create → switch → info\n';
    helpText += '• Decisions: record → search → update\n';

    return {
      content: [
        {
          type: 'text',
          text: helpText
        }
      ],
      // DUAL-CHANNEL: the catalog also rides the machine channel as RAW
      // values, so a client that surfaces structuredContent gets the real tool list — not
      // a bodiless `{ok:true}`.
      structuredContent: {
        ok: true,
        totalTools,
        totalCategories,
        // The MEASURED advertised surface the caller is actually holding, so a
        // machine-channel client gets the same honest numbers the header prints. `totalTools`
        // above stays the count of FLAT catalog entries (unchanged contract).
        surface: surfaceCounts.surface,
        advertisedTools: surfaceCounts.tools,
        advertisedOperations: surfaceCounts.operations,
        // The machine channel carries the SAME body the human channel renders (on legacy that is
        // the flat catalog, byte-identical to before; on gateway the operation list). `name` keeps
        // its key — on the gateway surface it holds the call form, which is what a client needs to
        // actually invoke the op.
        categories: body.map(({ category, entries }) => ({
          category,
          // `name` is the call form ON THIS SURFACE; `opId` is the flat tool name the
          // /mcp/tools/{opId} route serves. They are the same string on the legacy surface.
          tools: entries.map((e) => ({ name: e.label, opId: e.opId, description: e.description })),
        })),
      },
    };
  }

  /**
   * Get detailed explanation for a specific tool
   */
  async explainTool(args: { toolName: string }): Promise<any> {
    const toolName = args.toolName.toLowerCase();

    // Resolve the tool from the SINGLE SOURCE (AIDIS_TOOL_DEFINITIONS) and its category
    // from the same single source (TOOL_CATEGORIES via categoryForTool) — no separate
    // catalog to disagree with what the MCP tools/list actually advertises.
    const toolDef = AIDIS_TOOL_DEFINITIONS.find(t => t.name === toolName);

    if (!toolDef) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Tool "${toolName}" not found.\n\nUse \`mandrel_help\` to see all available tools.`
          }
        ]
      };
    }

    const category = categoryForTool(toolName) ?? 'Uncategorized';
    const description = toolDef.description;
    const requiredFields = toolDef.inputSchema?.required || [];
    const parameters = this.parseSchemaParameters(toolDef.inputSchema, requiredFields);

    let explanation = `🔧 **${toolName}**\n\n`;
    explanation += `**Category:** ${category}\n`;
    explanation += `**Purpose:** ${description}\n\n`;

    if (toolDef.inputSchema) {
      // Parse and display parameters from schema
      explanation += this.formatSchemaParameters(toolDef.inputSchema, requiredFields);
    }

    explanation += `💡 **Quick Tip:** Use \`mandrel_examples ${toolName}\` to see usage examples.`;

    return {
      content: [
        {
          type: 'text',
          text: explanation
        }
      ],
      // DUAL-CHANNEL: the explanation also rides the machine channel as
      // RAW values (name/category/description/params) — a client surfacing structuredContent
      // now gets the real help instead of an empty `{ok:true}`.
      structuredContent: {
        ok: true,
        tool: toolName,
        category,
        description,
        parameters,
      },
    };
  }

  /**
   * Get usage examples for a specific tool
   */
  async getExamples(args: { toolName: string }): Promise<any> {
    const toolName = args.toolName.toLowerCase();

    // Existence is checked against the SINGLE SOURCE (AIDIS_TOOL_DEFINITIONS), so we
    // never tell a caller a real, registered tool "doesn't exist". The curated example
    // snippets below stay curated content, but a tool with no curated example degrades
    // gracefully (point to mandrel_explain) — it is never reported as missing.
    const toolExists = AIDIS_TOOL_DEFINITIONS.some(t => t.name === toolName);

    if (!toolExists) {
      // Build list of available tools from the single source for a helpful error.
      const allTools = AIDIS_TOOL_DEFINITIONS.map(t => t.name);

      return {
        content: [
          {
            type: 'text',
            text: `❌ Tool "${toolName}" not found.\n\n**Available tools:**\n${allTools.map(t => `• ${t}`).join('\n')}\n\nUse \`mandrel_help\` to see all tools organized by category.`
          }
        ]
      };
    }

    const examples = this.toolExamples[toolName as keyof typeof this.toolExamples];

    if (!examples || examples.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `📝 No examples available yet for "${toolName}".\n\nUse \`mandrel_explain ${toolName}\` for parameter documentation.`
          }
        ],
        // DUAL-CHANNEL: a real, registered tool with no curated example
        // still carries the machine channel (empty examples) — never a bodiless {ok:true}.
        structuredContent: { ok: true, tool: toolName, examples: [] },
      };
    }

    let exampleText = `📚 **Examples for ${toolName}**\n\n`;

    examples.forEach((example: any, index: number) => {
      exampleText += `### ${index + 1}. ${example.title}\n`;
      exampleText += '```javascript\n';
      exampleText += example.example;
      exampleText += '\n```\n\n';
    });

    exampleText += `💡 **Related Commands:**\n`;
    exampleText += `• \`mandrel_explain ${toolName}\` - Get detailed parameter documentation\n`;
    exampleText += `• \`mandrel_help\` - See all available tools by category`;

    return {
      content: [
        {
          type: 'text',
          text: exampleText
        }
      ],
      // DUAL-CHANNEL: the examples ride the machine channel as RAW values
      // (title + code snippet) — a client surfacing structuredContent gets the real
      // examples instead of an empty `{ok:true}`.
      structuredContent: {
        ok: true,
        tool: toolName,
        examples: examples.map((e: any) => ({ title: e.title, example: e.example })),
      },
    };
  }

  /**
   * THE AGENT CAPTURE CONTRACT — `discover({action:'contract'})` / `mandrel_contract`.
   * P4 L1 (spec an earlier decision).
   *
   * WHAT IT IS FOR: P2 measured that agents told to record their work DID (11/11 runs) and
   * expressed their confidence in prose rather than in a structured field (5/13 records).
   * The missing thing was not willingness, it was the SHAPE — which lived in prose at the
   * bottom of a long agent card, i.e. in exactly the medium the same experiment showed to be
   * weak. This action moves the shape to where an agent already looks for a contract.
   *
   * ★ EVERY LINE OF IT IS GENERATED. The vocabulary comes from config/captureVocab.ts and
   * each op's description is read live from OP_REGISTRY. Nothing here restates a tool's
   * contract, because a hand-written copy rots — this repo's own agent-facing doc advertised
   * a stale tool count and an unauthenticated curl for months while the code moved on.
   *
   * ONE RENDERER, TWO DOORS: the gateway action delegates to this same method through the
   * routeExecutor, so the gateway and flat surfaces cannot describe the contract differently.
   */
  async getCaptureContract(): Promise<any> {
    const statuses = CAPTURE_STATUSES.map((status) => ({
      status,
      meaning: CAPTURE_STATUS_MEANING[status],
      requiresEvidence: statusRequiresEvidence(status),
    }));

    const recordShapes = CAPTURE_RECORD_SHAPES.map((r) => ({
      shape: r.shape,
      opId: r.opId,
      // LIVE, not copied: if the op's advertised description changes, this changes with it.
      opDescription: OP_BY_ID.get(r.opId)?.description ?? '',
      contextType: r.contextType,
      when: r.when,
      why: r.why,
    }));

    const example = {
      [CAPTURE_METADATA_KEY]: {
        [CAPTURE_STATUS_KEY]: 'verified',
        // A CITATION IS A COMMAND AND ITS OUTPUT. Deliberately written as a placeholder
        // rather than a real-looking run: an example that reads like a measurement is a
        // measurement nobody made, which is the exact failure `verified` exists to prevent.
        [CAPTURE_EVIDENCE_KEY]: '<the command you ran> -> <its output, verbatim>',
      },
    };

    // LIVE, not copied — the same discipline as recordShapes above.
    const gateFields = GATE_FIELD_SPECS.map((f) => ({ key: f.key, type: f.type, meaning: f.meaning }));
    const gateRefusedAliases = [...GATE_EXIT_CODE_ALIASES, ...GATE_REF_ALIASES];

    let text = '📌 **The agent capture contract** — how to say WHAT you did and HOW YOU KNOW.\n\n';
    text += 'Your transcript is discarded. A record nobody can find did not happen, and a record ';
    text += 'whose confidence is buried in prose cannot be aggregated — "which classes recurred ';
    text += 'despite a fix?" is a query, not a grep.\n\n';

    text += `## 1. The block: \`metadata.${CAPTURE_METADATA_KEY}\`\n`;
    text += `Any write that accepts \`metadata\` accepts it. Two fields: \`${CAPTURE_STATUS_KEY}\` and \`${CAPTURE_EVIDENCE_KEY}\`.\n\n`;
    text += '```json\n' + JSON.stringify(example, null, 2) + '\n```\n\n';

    text += '## 2. The states\n';
    for (const s of statuses) {
      text += `• \`${s.status}\`${s.requiresEvidence ? ' ⚠️' : ''} — ${s.meaning}\n`;
    }
    text += `• *(absent)* — ${CAPTURE_ABSENT_MEANING}\n\n`;

    text += '## 3. What to write, and when\n';
    for (const r of recordShapes) {
      text += `• **${r.shape}**\n`;
      text += `  → \`${r.opId}\`${r.contextType ? ` (type: \`${r.contextType}\`)` : ''} — ${r.opDescription}\n`;
      text += `  WHEN: ${r.when}\n  WHY: ${r.why}\n`;
    }
    text += `\n## 4. Recording a GATE RUN: \`metadata.${GATE_METADATA_KEY}\`\n`;
    text += 'The REVIEW VERDICT shape above asks for "the gate and its exit code". This is that ';
    text += 'field, and it is VALIDATED on every write — a malformed block is rejected, not stored.\n\n';
    text += '```json\n' + JSON.stringify(GATE_CONTRACT_EXAMPLE, null, 2) + '\n```\n\n';
    for (const f of gateFields) {
      text += `• \`${f.key}\` (${f.type}) — ${f.meaning}\n`;
    }
    text += `• *(absent)* — ${GATE_ABSENT_MEANING}\n`;
    text += `\n⚠️ These keys have ONE spelling each. Refused on write: ${gateRefusedAliases
      .map((a) => `\`${a}\``)
      .join(', ')} — every extra spelling is one more thing every reader has to recognise. ` +
      'Any OTHER sub-key is free-form: `name`, `reason`, `stagesRan` and the like are yours.\n';

    text += `\n💡 Full parameter contract for any op above: \`discover({action:'explain', tool:'<tool>', op:'<action>'})\`.`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true,
        // The gate block is advertised on BOTH channels, structured and human, for the same
        // reason the capture block is: an agent that parses gets the shape, an agent that
        // reads gets the shape, and neither is a restatement of the other.
        gate: {
          metadataKey: GATE_METADATA_KEY,
          fields: gateFields,
          absent: GATE_ABSENT_MEANING,
          refusedAliases: gateRefusedAliases,
          example: GATE_CONTRACT_EXAMPLE,
        },
        metadataKey: CAPTURE_METADATA_KEY,
        statusKey: CAPTURE_STATUS_KEY,
        evidenceKey: CAPTURE_EVIDENCE_KEY,
        statuses,
        absent: CAPTURE_ABSENT_MEANING,
        recordShapes,
        example,
      },
    };
  }
}

// Export singleton instance
export const navigationHandler = new NavigationHandler();