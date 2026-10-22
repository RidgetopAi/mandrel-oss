/**
 * OP EFFECT CLASSIFICATION — the population the unidentified-caller guards defend.
 * an earlier task.
 *
 * =============================================================================
 * WHY THE TABLE BELOW RESTATES EVERY VALUE INSTEAD OF READING THE REGISTRY
 * =============================================================================
 * A guard that READS the product's constant cannot detect a change to that constant — it
 * widens in LOCKSTEP with the thing it is supposed to pin (a past incident #7, measured on the
 * test-filter instance). `expect(OP_REGISTRY.filter(e => e.effect === 'write')).toHaveLength(
 * OP_REGISTRY.filter(...).length)` is a tautology; so is any assertion that derives its
 * expectation from `effect`.
 *
 * So this file states the classification INDEPENDENTLY, opId by opId. The consequences are
 * exactly the ones we want:
 *   * a NEW op cannot be added without a decision — the compiler requires an `effect`
 *     (OpRegistryEntry.effect is not optional → TS2741) and this file requires a row, so
 *     "unclassified" is not a reachable state and there is no silent-pass default;
 *   * DOWNGRADING an op from 'write' to 'read' — the mutation that would silently remove it
 *     from G2's population — is a TWO-FILE diff that a reviewer sees as a decision rather
 *     than as drift.
 *
 * =============================================================================
 * THE CLASSIFICATION RULE (so a future row is decidable, not a coin flip)
 * =============================================================================
 * ANSWER IT BY TRACING THE HANDLER — transitively, into handlers/ and services/ — never from
 * the opId. The first version of this table classified a scan-status poller 'read' while its
 * handler called `persistScan()`, and its scan trigger 'write' while that one persisted
 * nothing. Exactly backwards on a pair is what classifying
 * by NAME looks like. Restating the values here does NOT protect against that: both files
 * carried the same wrong value and agreed (Reviewer B1).
 *
 *   'write'         some path from the op's route handler reaches an INSERT/UPDATE/DELETE
 *                   this op PRODUCES — creates, updates, soft-deletes or restores a row, or
 *                   drives a service that does. Includes ops that target a row by id: the
 *                   route still resolves a project to SCOPE that lookup.
 *   'read'          no such path. (`initializeSession`'s in-memory auto-select on a read path
 *                   does not count — that is rung-3 state, deliberately left alone by G3.)
 *   'scope-switch'  the op persists the caller's interactive project slot itself.
 *
 * TWO SHARED SIDE EFFECTS ARE EXCLUDED BY NAME — they are the SERVER's, not the op's, and
 * every call inherits them identically whether it reads or writes:
 *   E1  middleware/eventLogger.ts#logEvent → INSERT INTO analytics_events (best-effort
 *       telemetry; it swallows its own errors on purpose).
 *   E2  services/session/infra/db/SessionRepo.ts#reactivate → UPDATE sessions SET
 *       status='active' WHERE id = $1 (the resolver's re-attach, keyed by the caller's OWN
 *       session id — it resolves no project, so it cannot land in a project the caller did
 *       not choose).
 * The read-classified ops that reach them are NAMED in E1_TELEMETRY_READS / E2_REATTACH_READS
 * below and pinned, so the exclusion is an enumerated list rather than a standing excuse.
 * It is a JUDGMENT: calling those five 'write' would have G2 reject a header-less
 * `context_search`, i.e. change READ behaviour, which G3 says we deliberately do not do.
 */

import { describe, test, expect } from 'vitest';
import { OP_REGISTRY, ALL_OP_IDS, opEffect, type OpEffect } from '../config/opRegistry.js';
import { ACTION_TOOLS } from '../routes/index.js';

/**
 * THE PIN. Stated here, not derived. Order is irrelevant; membership and value are not.
 */
const EXPECTED: Readonly<Record<string, OpEffect>> = Object.freeze({
  // System Health / Navigation — pure reads.
  mandrel_ping: 'read',
  mandrel_status: 'read',
  mandrel_help: 'read',
  mandrel_explain: 'read',
  mandrel_examples: 'read',
  // P4 L1: renders the capture contract from OP_REGISTRY + config/captureVocab.ts.
  // Traced: routes/index.ts 'mandrel_contract' → systemRoutes.handleCaptureContract →
  // navigationHandler.getCaptureContract, which is pure over two config modules and touches no DB.
  mandrel_contract: 'read',

  // Session Management.
  session_start: 'write', // mints/records a session row
  session_end: 'write', // finalizes a session row
  session_status: 'read',
  session_list: 'read',
  session_get: 'read',
  session_pin: 'write', // one op, three actions; pin_set/pin_clear persist

  // Context Management.
  context_store: 'write',
  context_search: 'read',
  context_get_recent: 'read',
  context_update: 'write',
  context_stats: 'read',
  context_artifact: 'read', // resolves WHERE an artifact lives; stores no bytes
  context_delete: 'write',
  context_restore: 'write',

  // Project Management.
  project_list: 'read',
  project_create: 'write',
  project_update: 'write',
  project_delete: 'write',
  project_switch: 'scope-switch', // THE op that moves the shared slot
  project_current: 'read',
  project_info: 'read',
  // TRACED (WS2 an earlier task): handleBriefing → buildProjectBriefing → gatherBriefingData
  // (SELECTs over contexts/tasks/technical_decisions/links) + trustForRecords (SELECTs).
  // No INSERT/UPDATE/DELETE produced on any path.
  project_briefing: 'read',
  // TRACED (reproject): handleMoveRecord → moveRecord, which runs
  // an UPDATE on the record row, an UPDATE per declared follower table, and two UPDATEs over
  // `links`, all inside one transaction. Unambiguously a write; it is NOT a 'scope-switch'
  // because it never touches the caller's interactive project slot — it moves a RECORD, not
  // the caller.
  project_move_record: 'write',

  // Technical Decisions.
  decision_record: 'write',
  decision_search: 'read',
  decision_get: 'read',
  decision_update: 'write',
  decision_stats: 'read',
  decision_delete: 'write',
  decision_restore: 'write',
  // The decision inbox: both mutate
  // technical_decisions (chosen/answered_at/answer_status, or answer_status/answer_note).
  decision_answer: 'write',
  decision_discuss: 'write',

  // Task Management.
  task_create: 'write',
  task_list: 'read',
  task_update: 'write',
  task_details: 'read',
  task_bulk_update: 'write',
  task_progress_summary: 'read',
  task_delete: 'write',
  task_restore: 'write',
  cancel_task: 'write',
  task_claim: 'write',
  task_renew: 'write',
  task_release: 'write',

  // Smart Search & AI — all read-only analysis.
  smart_search: 'read',
  get_recommendations: 'read',
  project_insights: 'read',
  project_tags: 'read',

  // Linking & Graph.
  link: 'write', // NOT in ACTION_TOOLS — the op that proved ACTION_TOOLS is the wrong anchor
  unlink: 'write',
  get_links: 'read',
  recall_thread: 'read',
  // Branch position (PHASE 1 positional membership).
  branch_open: 'write', // persists the session's branch position row
  branch_current: 'read',
  branch_close: 'write', // persists the position's ABSENCE
  branch_history: 'read', // pure read of the membership edges; takes no position at all
  // Mutable membership (P3). Both WRITE, and the classification is what puts
  // them under G2 of callerIdentityGuard: they mutate branch_memberships AND append to the
  // branch_membership_moves audit log. Both declare a scoped `projectId`, so an unidentified
  // caller can satisfy G2 per-call rather than being locked out with no remedy.
  branch_assign: 'write',
  branch_unassign: 'write',
  // Deprecated aliases — they delegate to branch_open/branch_close, so same effects.
  thread_set: 'write',
  thread_current: 'read',
  thread_clear: 'write',
});

/**
 * THE ADJUDICATED EXCLUSIONS, enumerated. Measured 2026-07-28 by a transitive call-graph
 * trace of all 60 route handlers (see the commit body for the command + its controls).
 *
 * WHAT THIS PINS, EXACTLY — and nothing wider. These lists do not re-run the trace, so they
 * CANNOT catch a NEW op that starts reaching logEvent/reactivate; only re-running the trace
 * does that. What they do catch: an op silently leaving the exclusion (flipped to 'write'
 * without removing it here), an op added to the exclusion that is not actually read-classified,
 * and the list quietly emptying — the zero-population failure that makes a loop pass over
 * nothing.
 */
const E1_TELEMETRY_READS = ['context_search', 'decision_search', 'smart_search', 'get_recommendations'] as const;
const E2_REATTACH_READS = ['session_status'] as const;

describe('the E1/E2 side-effect exclusions are an enumerated list, not a standing excuse', () => {
  test('every excluded op is named here AND still classified read', () => {
    for (const op of [...E1_TELEMETRY_READS, ...E2_REATTACH_READS]) {
      expect(ALL_OP_IDS, `${op} must still be a real op`).toContain(op);
      expect(EXPECTED[op], `${op} is excluded as a shared side effect, so it must be 'read'`).toBe('read');
    }
  });

  test('the exclusion lists are NON-EMPTY and disjoint (an empty list excuses nothing quietly)', () => {
    expect(E1_TELEMETRY_READS.length).toBeGreaterThan(0);
    expect(E2_REATTACH_READS.length).toBeGreaterThan(0);
    const overlap = E1_TELEMETRY_READS.filter((o) => (E2_REATTACH_READS as readonly string[]).includes(o));
    expect(overlap).toEqual([]);
  });
});

describe('every op is classified, and the classification is the one stated here', () => {
  test('the registry and this pin cover EXACTLY the same opIds (no drift in either direction)', () => {
    const registry = [...ALL_OP_IDS].sort();
    const pinned = Object.keys(EXPECTED).sort();
    // Named, not counted: a count tells you something moved, the names tell you WHAT
    // (Lesson: a-count-carries-its-command).
    expect(registry.filter((o) => !(o in EXPECTED))).toEqual([]);
    expect(pinned.filter((o) => !ALL_OP_IDS.includes(o))).toEqual([]);
    expect(registry).toEqual(pinned);
  });

  test('every op carries the pinned effect, read through the registry entry', () => {
    for (const entry of OP_REGISTRY) {
      expect(entry.effect, `OP_REGISTRY['${entry.opId}'].effect`).toBe(EXPECTED[entry.opId]);
    }
  });

  test('opEffect() agrees with the registry for every op (the accessor is not a second rule)', () => {
    for (const opId of ALL_OP_IDS) {
      expect(opEffect(opId), `opEffect('${opId}')`).toBe(EXPECTED[opId]);
    }
  });

  test('the pin is NON-VACUOUS: it contains all three effects, in useful numbers', () => {
    const counts = Object.values(EXPECTED).reduce<Record<string, number>>((acc, e) => {
      acc[e] = (acc[e] ?? 0) + 1;
      return acc;
    }, {});
    // Zero/empty is the value that slips through a guard — an EXPECTED map that
    // silently emptied would make every loop above pass over nothing.
    expect(Object.keys(EXPECTED).length).toBeGreaterThan(50);
    expect(counts.read).toBeGreaterThan(10);
    expect(counts.write).toBeGreaterThan(10);
    expect(counts['scope-switch']).toBe(1);
  });
});

describe("the guarded population is not ACTION_TOOLS' population", () => {
  test('every ACTION tool is a write — the write set is a strict SUPERSET, never a subset', () => {
    for (const tool of ACTION_TOOLS) {
      expect(EXPECTED[tool], `ACTION tool '${tool}'`).toBe('write');
    }
    const writes = Object.entries(EXPECTED).filter(([, e]) => e === 'write').map(([o]) => o);
    expect(writes.length).toBeGreaterThan(ACTION_TOOLS.size);
  });

  test('`link` is a write and is NOT in ACTION_TOOLS — the concrete gap that killed that anchor', () => {
    expect(EXPECTED.link).toBe('write');
    expect(ACTION_TOOLS.has('link')).toBe(false);
  });
});

describe('opEffect() fails CLOSED on a name it does not recognise', () => {
  test('an unknown tool name is treated as a write, never as a read', () => {
    // Unrecognised must take the restrictive branch. These are the values that
    // historically slip through: empty, whitespace, a plausible-looking new name.
    for (const unknown of ['', '   ', 'context_storee', 'brand_new_tool_2027', 'DROP TABLE']) {
      expect(opEffect(unknown), `opEffect(${JSON.stringify(unknown)})`).toBe('write');
    }
  });

  test('the deprecated aidis_* aliases are classified explicitly, not by the fail-closed default', () => {
    for (const alias of ['aidis_ping', 'aidis_status', 'aidis_help', 'aidis_explain', 'aidis_examples']) {
      expect(opEffect(alias), alias).toBe('read');
    }
  });
});
