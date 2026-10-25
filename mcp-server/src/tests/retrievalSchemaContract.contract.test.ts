/**
 * Retrieval Schema-Drift Contract Test (the permanent class guard)
 *
 * THE BUG (3-layer schema drift):
 *   The model-facing MCP `inputSchema` in config/toolDefinitions.ts did NOT match
 *   the zod validators in middleware/validation.ts (the REAL gatekeeper). zod uses
 *   .parse() — not .strict() — so any param the model sent that the validator did
 *   not declare was SILENTLY DROPPED. Retrieval tools shipped near-empty declared
 *   schemas (e.g. context_search advertised only id+query) while the validator
 *   accepted type, tags, limit, minSimilarity, offset, projectId, sessionId. The
 *   model literally could not see params that worked, and saw none it could trust.
 *
 * THE FIX (class fix, not instance):
 *   toolDefinitions.ts now DERIVES each retrieval tool's inputSchema from that
 *   tool's zod schema via zod-to-json-schema. The two layers are generated from one
 *   source and cannot diverge again. Human descriptions are an OVERLAY ONLY — they
 *   can never add/rename a param zod doesn't define.
 *
 * WHAT THIS PROVES (no DB needed — pure schema comparison):
 *   For every retrieval tool, the DECLARED inputSchema.properties keyset is EXACTLY
 *   the zod schema's top-level keyset. If anyone later edits a zod schema (adds a
 *   filter) or hand-edits a declared schema, this test goes RED — the drift class
 *   is permanently guarded at the gate.
 */

import { describe, test, expect } from 'vitest';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';
import { validationSchemas } from '../middleware/validation.js';

// The retrieval tools this tranche guards, with the exact param set the task
// specified must be visible to the model (== what the zod validator accepts).
const EXPECTED_PARAMS: Record<string, string[]> = {
  // context_store (tool-native linking): previously hard-coded to only
  // content/type/tags, hiding `metadata` (the keystone for structured back-links) +
  // relevanceScore/projectId/sessionId. Now DERIVED from zod, so the declared schema
  // advertises exactly the validated/accepted field set — and `metadata` is visible.
  // T5a: `links` — the first-class explicit-edge write param (declared,
  // accepted, and minted post-persist; robust — a bad link warns, never breaks the store).
  // T5b: `noAutoThread` — per-call opt-out for the active-thread anchor's
  // automatic edges (config-named AUTO_THREAD_OPT_OUT_FLAG). Declared, accepted, honored.
  // P5.4: `mode` + `spine` — the HANDOFF CARRIED FIELDS. They move MODE/PATH off a regex
  // over free prose and onto contexts.metadata, which is the whole point: a customer never
  // writes `MODE:` in a sentence, so a parser cannot reach data that was never written. Both
  // are optional plain strings and NEITHER is a zod enum on purpose — an enum would REJECT an
  // unrecognised mode at the boundary, i.e. lose a handoff over a label. Recognition happens
  // in the service, which warns and stores (services/handoffCarriedFields.ts).
  context_store: ['content', 'type', 'tags', 'relevanceScore', 'metadata', 'links', 'noAutoThread', 'mode', 'spine', 'projectId', 'sessionId'],
  // includeArchived: soft-delete read filter — default excludes archived.
  // response_format (T1 item 1): concise|detailed payload control.
  // dateFrom/dateTo (search consolidation): additive created_at range
  // filter forwarded by the Command UI's canonical proxy (same additive pattern as type).
  // altitude (SEARCH P3): THE ONE volume vocabulary —
  // headline|summary|full, the same parameter with the same meaning on every read tool, and
  // it moves BOTH the text and structuredContent channels. `response_format` stays in this
  // list because it is still ACCEPTED (a deprecated alias, concise->summary/detailed->full,
  // for callers on shipped customer instances) — it is simply no longer DESCRIBED on the
  // advertised surface. Accepted and advertised are two different sets, and this guard is
  // about the accepted one.
  context_search: ['id', 'query', 'type', 'tags', 'limit', 'minSimilarity', 'offset', 'response_format', 'altitude', 'projectId', 'sessionId', 'includeArchived', 'dateFrom', 'dateTo'],
  // decision_search (learning-loop READ): `outcomeStatus` added — a
  // SEPARATE filter from `status` that filters the outcome_status column (how a
  // decision turned out), the moat-critical read for the GAP1 Evaluator.
  // an earlier task adds THREE more, all intentional surface additions:
  //   implementationStatus — the BUILD column (a THIRD status, distinct from both of the
  //     above): the filter that makes the half-executed-decision class enumerable.
  //   offset             — real pagination. `limit` caps at 100 and there was no offset, so a
  //     filter class larger than 100 was not enumerable through the tool at all.
  //   sortDirection      — newest|oldest over decision_date; the staleness question the
  //     implementationStatus filter exists to answer is inherently oldest-first.
  // answerStatus (THE DECISION INBOX): filters
  // on the third, orthogonal lifecycle lane — "has a human actually chosen an option yet?"
  decision_search: ['query', 'limit', 'offset', 'sortDirection', 'decisionType', 'status',
    'outcomeStatus', 'implementationStatus', 'impactLevel', 'component', 'tags', 'projectId',
    'includeOutcome', 'includeArchived', 'answerStatus'],
  // decision_get (learning-loop READ): single-decision direct lookup
  // by full UUID, mirroring context_search's `id` idiom.
  decision_get: ['decisionId', 'projectId'],
  // Learning-loop wiring: decision_record/decision_update now DERIVE
  // their model-facing inputSchema from the zod validator, so the params the model
  // sees == the params the validator accepts == the params the handler reads.
  // decision_record (A1): outcome fields (outcomeStatus/outcomeNotes/lessonsLearned)
  // are now settable up front and persisted on create (mirroring implementationStatus),
  // so they join the advertised+accepted set.
  // T5a: `links` — the first-class explicit-edge write param (declared,
  // accepted, minted post-persist; robust — a bad link warns, never breaks the record).
  // answerStatus/question/options/deadline (THE DECISION INBOX,   // an earlier task): answerStatus:'open' files the decision in the inbox — REFUSED (typed
  // error, nothing written) unless question is non-empty and options has >=2 well-formed
  // entries. Omitted, behaves exactly as before (answer_status defaults to 'decided').
  decision_record: ['decisionType', 'title', 'description', 'rationale', 'impactLevel',
    'alternativesConsidered', 'problemStatement', 'successCriteria', 'implementationStatus',
    'outcomeStatus', 'outcomeNotes', 'lessonsLearned',
    'affectedComponents', 'tags', 'links', 'projectId', 'metadata',
    'answerStatus', 'question', 'options', 'deadline'],
  // projectId: scopes the SHORT-ID resolution of decisionId to one
  // project (the resolver reads args.projectId via resolveProjectId). Declared so strict
  // mode accepts it; it is NOT an updatable field (excluded from the update .refine).
  // CURATE (T1 item 5/6): title/description/tags/metadata are now editable
  // (metadata is MERGED, not replaced). Added to the advertised+accepted set.
  // answerStatus/question/options/deadline (THE DECISION INBOX,   // an earlier task): setting answerStatus:'open' validates the MERGED row (this call's
  // question/options if supplied, else the existing row's) against the same invariant
  // decision_record enforces.
  decision_update: ['decisionId', 'status', 'outcomeStatus', 'outcomeNotes', 'lessonsLearned',
    'implementationStatus', 'successCriteria', 'problemStatement', 'supersededBy', 'supersededReason',
    'title', 'description', 'tags', 'metadata',
    'projectId', 'answerStatus', 'question', 'options', 'deadline'],
  // task_list (A7): `offset` added for pagination (rows beyond limit=100 were unreachable).
  // projectId (strict-mode safety): the handler (tasks.routes.handleList) reads
  // args.projectId via resolveProjectId to scope the list — a real accepted-and-used
  // param that was missing from the schema, so under strict mode a legitimate
  // project-scoped task_list call would have been wrongly rejected. Declared, not dropped.
  // DRIFT-CLEANUP: `statuses` (multi-status IN-filter) and `phase`
  // (phase tag filter, any separator spelling) are REAL filters the handler honors (listTasks) but were
  // read without being declared → rejected under strict mode. Now declared so the real
  // capability is reachable through MCP (advertised == accepted == handler-reads).
  // THE DEADLINE IS READABLE: `dueBefore` + `sort` make "what is due in the
  // next N days" a task_list call. `due_at` (migration 093) was WRITE-ONLY — settable by
  // task_create/task_update and consulted by exactly one surface (project_briefing's
  // "Waiting on a human", which selects blocked_on='human' first), so a deadline on a task
  // blocked on anything else was unanswerable without raw SQL. Both optional; `required`
  // stays empty, so no existing call shape changes.
  // THE FLOW FILTERS (gap 4): `createdAfter`/`createdBefore`/`closedAfter`.
  // `dueBefore` filters the DEADLINE only, so there was NO way to ask "what was filed this
  // week" or "what closed this week" — answering it cost a 1,212-row sweep plus 1,212
  // `task_details` calls. `closedAfter` and not `completedAfter` deliberately: a flow question
  // that counts only completions is the one that hid the 2026-08-19 cull of 107 CANCELLED
  // tasks, the largest outflow event in our history.
  task_list: ['status', 'statuses', 'priority', 'phase', 'assignedTo', 'type', 'tags', 'limit', 'offset', 'projectId', 'includeArchived', 'dueBefore', 'createdAfter', 'createdBefore', 'closedAfter', 'sort', 'stage'],
  // task_create: the model-facing schema previously advertised ONLY
  // `title`, hiding `type` (+ enum) and every other accepted field — so an agent
  // asked for a "bug" silently got a `general` task. Now DERIVED from zod, so the
  // declared schema advertises exactly the validated/accepted field set.
  // DRIFT-CLEANUP: `createdBy` is a real column the handler writes; it
  // was read (args.createdBy) but never declared → unreachable under strict mode. Declared.
  // T5a PARITY: `links` — the first-class explicit-edge write param that
  // context_store and decision_record already had. task_create lacking it was part of why
  // tasks were born graph leaves.
  // parentTaskId: the DECLARED structural parent — position no longer mints
  // subtask_of; only this explicit param does.
  // P5.5 (migration 093): + blockedOn, dueAt — "waiting on a human" becomes a FIELD, and a
  // column no tool can write is not a feature. Purely additive; nothing was renamed or removed.
  task_create: ['title', 'description', 'type', 'priority', 'status', 'assignedTo', 'createdBy', 'dependencies', 'links', 'tags', 'projectId', 'metadata', 'parentTaskId', 'blockedOn', 'dueAt', 'stage', 'punch'],
  // task_update (Guard 2 + A4/A5): now DERIVED from zod. Advertises priority/progress
  // (now real, written columns) + assignedTo. Old hand-written schema hid all but
  // taskId+status.
  // APPEND AFFORDANCE: `notes` is now PRESENT. This line used to read
  // "`notes` is intentionally ABSENT (no such column — A4)", and that absence is what
  // made `description` — a silent full replace — the only place a caller could put a
  // status note. There is still no `notes` COLUMN; it writes to the `metadata` jsonb,
  // exactly as task_bulk_update's `notes` has since an earlier change.
  // projectId: scopes the SHORT-ID resolution of taskId to one project
  // (resolved via resolveProjectId). Declared so strict mode accepts it; not updatable.
  // DRIFT-CLEANUP: `metadata` is a real column (tasks.metadata jsonb) the
  // handler writes; it was read (args.metadata) but never declared → unreachable. Declared.
  // CURATE (T1 item 5): title/description/tags now editable; metadata MERGED.
  // ATOMIC TASK CLAIM: `claimId` (the fencing token that lets a holder
  // write OWNERSHIP fields, implicitly renews the lease, and clears the claim on a terminal
  // status) + `force` (the audited human override of a live claim). Both are declared,
  // accepted, and honored — so they belong in the advertised set, not hidden behind it.
  // P5.5 (migration 093): + blockedOn, dueAt — the EDIT path must be able to express what
  // the create path can, or a value can be set and never changed or cleared.
  // BATCH-5 LANE K: + `type`, for that same reason and the one the P5.5 line states. It was
  // declared nowhere and had no SET clause either, so a task's KIND was write-once — and the
  // Command backend hid that only for as long as it wrote the column with its own raw SQL.
  // Same taskTypeEnum task_create declares, so the two ends cannot disagree about the set.
  // `dependencies`: the column was WRITE-ONCE AT CREATE — declared on
  // task_create, absent from task_update's schema AND from the handler's SET builder — so no
  // task could acquire a dependency after it was filed. That is why it is non-empty on zero
  // rows fleet-wide: emptied by unreachability, not disuse. A task becomes blocked LATER, so
  // the honest channel for "task X must land first" was missing exactly when it was needed.
  task_update: ['taskId', 'status', 'priority', 'type', 'assignedTo', 'progress', 'metadata', 'notes', 'title', 'description', 'tags', 'dependencies', 'projectId', 'claimId', 'force', 'blockedOn', 'dueAt', 'stage', 'punch'],
  // task_bulk_update (Guard 2): now DERIVED from zod — every honored field is advertised.
  // + `force`: a bulk write holds no claim, so live-claimed rows are SKIPPED
  // and reported; force:true is the audited override. No claimId — you cannot hold N claims.
  // `type` CLOSES the gap this comment used to record as open. It is the same
  // taskTypeEnum task_update declares, it has a `type = $n` SET clause in bulkUpdateTasks, and
  // it is in that handler's embedding-invalidation set — the third part being the one that
  // matters, since `type` feeds the embed text and a write without it would leave every
  // re-typed row retrievable under its OLD type forever. Guarded end-to-end, in both
  // directions, by src/tests/taskBulkUpdateType.contract.test.ts.
  // `blockedOn` (gap 2): a move to `blocked` must now NAME its blocker, and a
  // board sweep blocking N tasks behind one freeze is a real use of THIS tool — so without
  // this param the fail-closed rule would be unsatisfiable here, which is a rule that closes
  // the product rather than a hole. Same `taskBlockedOnEnum` as create/update.
  task_bulk_update: ['task_ids', 'status', 'assignedTo', 'priority', 'type', 'metadata', 'notes', 'projectId', 'force', 'blockedOn', 'stage', 'punch'],
  // project_* (A8): now DERIVED from zod so `metadata` (persisted by the handler) is
  // no longer hidden by a hand-written schema — boundary-drift class guard extended.
  project_create: ['name', 'description', 'status', 'gitRepoUrl', 'rootDirectory', 'metadata'],
  project_update: ['project', 'name', 'description', 'status', 'gitRepoUrl', 'rootDirectory', 'metadata'],
  project_delete: ['project', 'confirm'],
  project_switch: ['project'],
  // + `includeArchived`: contextCount counts LIVE contexts by default;
  // true counts archived too. Declared in zod AND in the model-facing schema.
  project_info: ['project', 'includeArchived'],
  // DRIFT-CLEANUP: `scope` was DEPRECATED (removed) — a redundant
  // duplicate of includeTypes that the handler never read and that named dropped sources
  // (naming/agents). includeTypes is the real, honored source filter.
  // altitude (SEARCH P3): the size dial smart_search never had. No
  // `response_format` here — it never shipped one, so there is no alias to keep.
  smart_search: ['query', 'projectId', 'includeTypes', 'limit', 'altitude'],
  // response_format (T1 item 1): concise|detailed payload control.
  // altitude (SEARCH P3): same enum, same semantics, same deprecated alias.
  context_get_recent: ['limit', 'response_format', 'altitude', 'projectId', 'includeArchived'],
  // CURATE (T1 item 4): context_update — edit content/tags/metadata/score.
  // metadata is MERGED (null deletes a key), not replaced.
  context_update: ['contextId', 'content', 'tags', 'metadata', 'relevanceScore', 'projectId'],
  get_recommendations: ['context', 'projectId', 'type'],
  task_details: ['taskId', 'projectId'],
  // Soft-delete / archive tools: id + optional project scope.
  context_delete: ['contextId', 'projectId'],
  context_restore: ['contextId', 'projectId'],
  decision_delete: ['decisionId', 'projectId'],
  decision_restore: ['decisionId', 'projectId'],
  // + `force`: archiving a live-claimed task is refused by default.
  task_delete: ['taskId', 'projectId', 'force'],
  task_restore: ['taskId', 'projectId'],
  // ATOMIC TASK CLAIM — the claim lifecycle joins this class guard from
  // birth, so its advertised schema can never drift from the validator that gates it.
  // cancel_task IS an ownership write (status='cancelled'), so it carries claimId/force too.
  cancel_task: ['taskId', 'projectId', 'claimId', 'force'],
  task_claim: ['taskId', 'actor', 'allowedStatuses', 'expectedVersion', 'leaseSeconds', 'claimId', 'projectId'],
  task_renew: ['taskId', 'claimId', 'leaseSeconds', 'projectId'],
  task_release: ['taskId', 'claimId', 'projectId'],
};

/** Extract the top-level zod object key set (unwraps a ZodEffects/.refine wrapper). */
function zodKeys(schema: any): string[] {
  let s = schema;
  // ZodEffects (from .refine/.transform) holds the inner schema on _def.schema.
  while (s?._def?.schema) {
    s = s._def.schema;
  }
  const shape = s?.shape ?? s?._def?.shape?.();
  return shape ? Object.keys(shape) : [];
}

describe('retrieval schema-drift class guard (declared == zod)', () => {
  for (const [toolName, expected] of Object.entries(EXPECTED_PARAMS)) {
    test(`${toolName}: declared inputSchema == zod schema (and == spec)`, () => {
      const def = AIDIS_TOOL_DEFINITIONS.find(t => t.name === toolName);
      expect(def, `tool ${toolName} must be defined`).toBeDefined();

      const declaredKeys = Object.keys(def!.inputSchema.properties).sort();
      const zk = zodKeys((validationSchemas as any)[toolName]).sort();
      const exp = [...expected].sort();

      // 1. The zod schema must define exactly the spec param set.
      expect(zk, `zod keys for ${toolName}`).toEqual(exp);
      // 2. The declared (model-facing) schema must match the zod schema EXACTLY.
      //    This is the anti-drift assertion: generation keeps them identical.
      expect(declaredKeys, `declared keys for ${toolName}`).toEqual(zk);
    });
  }

  test('task_create now DECLARES the `type` param WITH its enum (the headline drift fix)', () => {
    const def = AIDIS_TOOL_DEFINITIONS.find(t => t.name === 'task_create')!;
    const props = def.inputSchema.properties as Record<string, any>;
    // The param the agent could not previously see.
    expect(Object.keys(props)).toContain('type');
    // The enum must be surfaced so the model knows 'bug' (etc.) is a legal value —
    // not just a free-form string it has to guess at.
    expect(props.type.enum).toEqual([
      'feature', 'bug', 'bugfix', 'refactor', 'test', 'review',
      'docs', 'documentation', 'devops', 'general',
    ]);
    // Only `title` is required; everything else (incl. type) is optional at the JSON layer.
    expect(def.inputSchema.required ?? []).toEqual(['title']);
  });

  test('context_store now DECLARES the `metadata` param (tool-native linking keystone)', () => {
    const def = AIDIS_TOOL_DEFINITIONS.find(t => t.name === 'context_store')!;
    const props = def.inputSchema.properties as Record<string, any>;
    // The param a context needed to carry STRUCTURED back-links (not just tags).
    expect(Object.keys(props)).toContain('metadata');
    // metadata is a jsonb object at the tool layer (zod z.record(z.any())).
    expect(props.metadata.type).toBe('object');
    // Only content+type are required; metadata (and the rest) stay optional.
    expect((def.inputSchema.required ?? []).sort()).toEqual(['content', 'type']);
  });

  test('context_search now DECLARES the `tags` param (the headline drift fix)', () => {
    const def = AIDIS_TOOL_DEFINITIONS.find(t => t.name === 'context_search')!;
    expect(Object.keys(def.inputSchema.properties)).toContain('tags');
    expect(def.inputSchema.properties.tags.type).toBe('array');
    // And no longer requires anything (id/query/tags are all optional at the JSON layer;
    // the "at least one of" rule lives in the zod .refine, exercised by the behavior test).
    expect(def.inputSchema.required ?? []).toEqual([]);
  });
});
