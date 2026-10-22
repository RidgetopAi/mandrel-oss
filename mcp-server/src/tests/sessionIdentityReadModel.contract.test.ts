/**
 * SESSION IDENTITY read model — contract test (Amp-orb eval finding W3).
 *
 * WHAT THE EVAL ASKED FOR (report
 * `riverbend/docs/amp-orb-eval/mandrel-orb-orchestration-baseline-2026-07-24.md` lines
 * 413-456, Priority 1): the tools exposed only a session PREFIX, a project, and
 * active/inactive. They did not expose the resolved actor, the full session id, the creation
 * reason, connection lineage, or a project-level session list — so the evaluator could not
 * VERIFY which session produced which record and had to correlate screenshots with timestamps.
 *
 * ACCEPTANCE (report line 455, asserted verbatim in section A below):
 *   "an orb can call session.status after one write and verify its full session, actor,
 *    project, and creation reason"
 * …with ZERO SQL, through the PUBLIC tool contract only (memory `no-cheating-feel-the-pain`).
 *
 * HOW THIS TEST IS BUILT (a past incident — "your guard and your product agree, and you can weaken
 * one without the other noticing"):
 *   - Every assertion CALLS the product. The acceptance sections drive the real `routeExecutor`
 *     (the same entry point the MCP surface uses, action gate included) and the real
 *     `dispatchGateway`; the honesty sections call the real `buildSessionIdentity` /
 *     `renderSessionIdentity`. NOTHING here re-implements a rule the product owns — there is
 *     no copy of the renderer's format, the resolver's precedence, or the vocabulary.
 *   - The rendered-honesty guard iterates the PRODUCT's own `IDENTITY_FIELD_SPECS` and the
 *     PRODUCT's own `unresolved` list, and matches on the PRODUCT's own `NOT_RECORDED` token
 *     (imported, never spelled out) — so weakening the renderer moves the guard with it.
 *   - The "does the field table still cover what the eval requires" assertion anchors on the
 *     nine field names from the REPORT (an external spec), which is what stops the loop above
 *     from degrading into an allow-list.
 *
 * SQL is used ONLY for fixture setup/teardown (planting a legacy row that predates the columns
 * — there is no tool that can create one) and, in section A, for the STRICTLY NEGATIVE check
 * that the read path did not invent data. Every acceptance READ goes through the tool surface.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'crypto';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { dispatchGateway } from '../routes/gateway.js';
import { sessionRoutes } from '../routes/session.routes.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { SESSION_IDENTITY_CONFIG } from '../config/sessionIdentityConfig.js';
import { ACTOR_ANONYMOUS } from '../config/actorRegistry.js';
import {
  buildSessionIdentity,
  renderSessionIdentity,
  renderSessionIdentityLine,
  IDENTITY_FIELD_SPECS,
  NOT_RECORDED,
  type SessionIdentity,
  type SessionIdentityRow,
} from '../services/session/domain/identity/sessionIdentity.js';
import { bindConnectionToProject as bindProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
let projectId: string;
let projectName: string;
const createdSessionIds: string[] = [];
const createdTaskIds: string[] = [];
const createdActors: string[] = [];

function track(id: string): string {
  if (id && !createdSessionIds.includes(id)) createdSessionIds.push(id);
  return id;
}

/**
 * BIND a connection to THIS suite's project before it writes.
 *
 * The mechanism, the measurement and the reason `project_switch` is the right instrument now
 * live in ONE place — `helpers/projectBinding.ts` — because this file was the
 * first to hit the ambient-inheritance flake and three more sites were found afterwards. A
 * rule written per-file is a rule that can be weakened in one copy without the others
 * noticing (CLASSES.md C3).
 */
async function bindConnectionToProject(connectionId: string): Promise<void> {
  await bindProject(connectionId, projectName);
}

/** The text channel of an McpResponse (what a human/agent actually reads). */
function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode;
  ActiveSessionStore.clearAll();
});

beforeAll(async () => {
  projectName = `QA-SessionIdentity-${STAMP}`;
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [projectName, 'session identity read model contract'],
  );
  projectId = r.rows[0].id;
});

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
  }
  if (createdActors.length > 0) {
    await db.query('DELETE FROM session_pins WHERE actor = ANY($1::text[])', [createdActors]);
  }
  if (createdSessionIds.length > 0) {
    await db.query('DELETE FROM session_pins WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM analytics_events WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM contexts WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM tasks WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdSessionIds]);
  }
  await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// A. THE ACCEPTANCE (report line 455) — one write, then session_status verifies everything
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('A. ACCEPTANCE — after ONE write, session_status verifies session/actor/project/reason', () => {
  test('an orb with NO prior session_start sees creationReason "automatic-write" and its own actor', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `orb-accept-${STAMP}`;
    const connectionId = `accept-conn-${STAMP}`;
    createdActors.push(actor);
    await bindConnectionToProject(connectionId);

    // THE ONE WRITE — through the real public tool surface (routeExecutor runs the action gate
    // exactly as the MCP server does). No session_start; the gate must mint the session.
    const write = await routeExecutor(
      'task_create',
      { title: `identity-acceptance-${STAMP}`, projectId },
      { connectionId, actor },
    );
    expect(write.isError).not.toBe(true);
    const taskId = (write as any).structuredContent?.task?.id ?? (write as any).structuredContent?.id;
    if (taskId) createdTaskIds.push(taskId);

    // THE VERIFICATION — one tool call, zero SQL.
    const status = await routeExecutor('session_status', {}, { connectionId, actor });
    const sc: any = status.structuredContent;
    expect(sc.ok).toBe(true);
    expect(sc.active).toBe(true);

    const identity: SessionIdentity = sc.identity;
    track(identity.sessionId);

    // "verify its FULL SESSION" — a real UUID, not a truncated display form.
    expect(identity.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // "…its ACTOR"
    expect(identity.actorId).toBe(actor);
    expect(identity.actorIsAnonymous).toBe(false);
    // "…its PROJECT"
    expect(identity.projectId).toBe(projectId);
    expect(identity.projectName).toBe(projectName);
    // "…and CREATION REASON" — the write minted it, so this must say so.
    expect(identity.creationReason).toBe('automatic-write');
    // The remaining fields of the report's response shape (lines 437-449).
    expect(identity.state).toBe('active');
    expect(identity.open).toBe(true);
    expect(identity.createdAt).toBeTruthy();
    expect(identity.lastActivityAt).toBeTruthy();
    expect(identity.taskCount).toBe(1); // the ONE write
    expect(identity.contextCount).toBe(0);
    // Nothing about this freshly-created session should be unresolvable.
    expect(identity.unresolved).toEqual([]);
    expect(identity.fullyResolved).toBe(true);

    // The caller echo — how an orb confirms its X-Actor-ID actually landed.
    expect(sc.caller.actor).toBe(actor);
    expect(sc.caller.actorDeclared).toBe(true);

    // NEGATIVE CROSS-CHECK (the only read-side SQL in this file, and it is deliberately
    // adversarial): the tool must be REPORTING the row, not inventing a plausible one.
    const row = (
      await db.query('SELECT actor, creation_reason, project_id FROM sessions WHERE id = $1', [
        identity.sessionId,
      ])
    ).rows[0];
    expect(row.actor).toBe(actor);
    expect(row.creation_reason).toBe('automatic-write');
    expect(row.project_id).toBe(projectId);
  });

  test('an explicit session_start followed by a write reports creationReason "explicit"', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `orb-explicit-${STAMP}`;
    const connectionId = `explicit-conn-${STAMP}`;
    createdActors.push(actor);
    await bindConnectionToProject(connectionId);

    const started = await routeExecutor(
      'session_start',
      { title: 'explicit open', goal: 'prove the reason discriminates' },
      { connectionId, actor },
    );
    const sid = track((started as any).structuredContent.sessionId);

    await routeExecutor(
      'task_create',
      { title: `identity-explicit-${STAMP}`, projectId },
      { connectionId, actor },
    );

    const status = await routeExecutor('session_status', {}, { connectionId, actor });
    const identity: SessionIdentity = (status as any).structuredContent.identity;

    // Same session (W2's converge) AND the reason is the one that actually created it.
    expect(identity.sessionId).toBe(sid);
    expect(identity.creationReason).toBe('explicit');
    expect(identity.actorId).toBe(actor);
    // THE DISCRIMINATOR the eval asked for: explicit ≠ automatic-write.
    expect(identity.creationReason).not.toBe('automatic-write');
  });

  test('the GATEWAY surface (session{action:status}) returns the SAME identity — one handler', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `orb-gateway-${STAMP}`;
    const connectionId = `gw-conn-${STAMP}`;
    createdActors.push(actor);
    await bindConnectionToProject(connectionId);

    await routeExecutor('task_create', { title: `identity-gw-${STAMP}`, projectId }, { connectionId, actor });

    const flat = await routeExecutor('session_status', {}, { connectionId, actor });
    const gw = await dispatchGateway('session', { action: 'status' }, { connectionId, actor });
    track((flat as any).structuredContent.identity.sessionId);

    const flatIdentity = (flat as any).structuredContent.identity as SessionIdentity;
    const gwIdentity = (gw as any).structuredContent.identity as SessionIdentity;

    // `lastActivityAt` is the one field that legitimately differs between two calls made at
    // two different moments, and has been since EVERY tool call now advances
    // session liveness (services/session/activityTouch.ts), `session_status` included, and
    // the touch is dispatched without being awaited — so the second read can observe a value
    // the first read was issued too early to see. Pinning it byte-equal here would be
    // asserting that reading your own status is NOT activity, which is precisely the bug
    // that task closed. It is SPLIT OUT, not dropped: every other field stays pinned by the
    // deep-equal (the rest object is destructured, so a new field is covered automatically),
    // and the split-out field is asserted present and non-decreasing.
    const { lastActivityAt: flatSeen, ...flatRest } = flatIdentity;
    const { lastActivityAt: gwSeen, ...gwRest } = gwIdentity;

    expect(gwRest).toEqual(flatRest);
    expect(typeof flatSeen, 'a live session must report a lastActivityAt').toBe('string');
    expect(typeof gwSeen, 'a live session must report a lastActivityAt').toBe('string');
    expect(Date.parse(gwSeen as string)).toBeGreaterThanOrEqual(Date.parse(flatSeen as string));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// B. THE RESPONSE SHAPE the report specified (lines 437-449)
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('B. the identity record carries every field the eval report specified', () => {
  /**
   * The nine field names from the REPORT's response shape. This list is the EXTERNAL SPEC, not
   * a copy of product logic — it is exactly what makes the product-iterating loops elsewhere in
   * this file fail closed instead of degrading into an allow-list.
   */
  const REPORT_REQUIRED_FIELDS = [
    'sessionId',
    'actorId',
    'projectId',
    'state',
    'creationReason',
    'createdAt',
    'lastActivityAt',
    'contextCount',
    'taskCount',
  ] as const;

  test('session_status.identity declares all nine specified fields', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `orb-shape-${STAMP}`;
    const connectionId = `shape-conn-${STAMP}`;
    createdActors.push(actor);
    await bindConnectionToProject(connectionId);
    await routeExecutor('task_create', { title: `identity-shape-${STAMP}`, projectId }, { connectionId, actor });

    const status = await routeExecutor('session_status', {}, { connectionId, actor });
    const identity: SessionIdentity = (status as any).structuredContent.identity;
    track(identity.sessionId);

    for (const field of REPORT_REQUIRED_FIELDS) {
      expect(Object.keys(identity), `report field '${field}' missing from the identity record`).toContain(field);
    }
  });

  test("the renderer's field table still covers every field the report requires", () => {
    // Anchors on the EXTERNAL spec. Deleting an entry from IDENTITY_FIELD_SPECS (which the
    // honesty loops below iterate) makes THIS go RED, so those loops cannot silently shrink.
    const rendered = IDENTITY_FIELD_SPECS.map((s) => s.key);
    for (const field of REPORT_REQUIRED_FIELDS) {
      expect(rendered, `field '${field}' is in the report's shape but is never RENDERED`).toContain(field);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// C. THE HONESTY RULE — an unresolvable field SAYS SO; it never renders a plausible blank
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('C. a session whose identity cannot be resolved says so explicitly', () => {
  /**
   * Plant a LEGACY session row: no actor (predates migration 062), no creation reason
   * (predates 068), no project. There is no tool that can create one — a pre-migration row is
   * exactly the fixture this rule exists for — so this is fixture SQL, not a read-path shortcut.
   */
  async function plantLegacyRow(overrides: Record<string, any> = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, started_at, last_activity_at, status, actor, creation_reason)
       VALUES ($1, $2, 'AI Model', now(), now(), $3, $4, $5)`,
      [id, overrides.project_id ?? null, overrides.status ?? 'active', overrides.actor ?? null, overrides.creation_reason ?? null],
    );
    return track(id);
  }

  test('a legacy row reports NOT RECORDED with a REASON for every unresolved field — never a blank', async () => {
    const id = await plantLegacyRow();

    const resp = await routeExecutor('session_get', { sessionId: id }, {});
    const identity: SessionIdentity = (resp as any).structuredContent.identity;

    // The values are honestly null…
    expect(identity.actorId).toBeNull();
    expect(identity.creationReason).toBeNull();
    expect(identity.projectId).toBeNull();
    // …and every null is ACCOUNTED FOR with a reason. This is the invariant.
    const unresolvedFields = identity.unresolved.map((u) => u.field);
    expect(unresolvedFields).toContain('actorId');
    expect(unresolvedFields).toContain('creationReason');
    expect(unresolvedFields).toContain('projectId');
    expect(identity.fullyResolved).toBe(false);
    for (const u of identity.unresolved) {
      expect(u.reason.length, `field '${u.field}' is unresolved with an empty reason`).toBeGreaterThan(20);
    }

    // AND THE TEXT SAYS SO. This is the assertion that makes silence impossible: it iterates
    // the PRODUCT's own unresolved list and the PRODUCT's own NOT_RECORDED token, so weakening
    // the renderer to emit '' / '-' / 'unknown' turns this RED.
    const rendered = renderSessionIdentity(identity);
    const toolText = textOf(resp);
    for (const u of identity.unresolved) {
      const spec = IDENTITY_FIELD_SPECS.find((s) => s.key === u.field);
      if (!spec) continue; // not every unresolved field is in the rendered block (e.g. projectName)
      expect(rendered, `rendered text hides unresolved field '${u.field}'`).toContain(
        `${spec.label}: ${NOT_RECORDED}`,
      );
      expect(rendered, `rendered text omits the REASON for '${u.field}'`).toContain(u.reason);
      // …and the TOOL's own text channel carries the same thing (the renderer is actually wired).
      expect(toolText).toContain(`${spec.label}: ${NOT_RECORDED}`);
    }
  });

  test('an unrecognised status is reported as unresolved, naming the value — never passed through', async () => {
    // The DB CHECK forbids an unknown status, so exercise the BUILDER directly with a row the
    // contract does not recognise. Deny-by-default: unrecognised input must be loud.
    const row: SessionIdentityRow = {
      id: randomUUID(),
      actor: 'someone',
      project_id: projectId,
      project_name: projectName,
      status: 'quantum-superposition',
      creation_reason: 'explicit',
      started_at: new Date(),
      last_activity_at: new Date(),
      ended_at: null,
      title: null,
      connection_id: null,
      created_via_connection: null,
      context_count: 0,
      task_count: 0,
      decision_count: 0,
    };
    const identity = buildSessionIdentity(row);

    expect(identity.state).toBeNull();
    expect(identity.open).toBeNull();
    const stateReason = identity.unresolved.find((u) => u.field === 'state')?.reason;
    expect(stateReason).toBeTruthy();
    expect(stateReason).toContain('quantum-superposition'); // names the offending value
    expect(renderSessionIdentity(identity)).toContain(`state: ${NOT_RECORDED}`);
  });

  test('an unrecognised creation reason is reported as unresolved, naming the value', () => {
    const row: SessionIdentityRow = {
      id: randomUUID(),
      actor: 'someone',
      project_id: projectId,
      project_name: projectName,
      status: 'active',
      creation_reason: 'because-i-said-so',
      started_at: new Date(),
      last_activity_at: new Date(),
      ended_at: null,
      title: null,
      connection_id: null,
      created_via_connection: null,
      context_count: 0,
      task_count: 0,
      decision_count: 0,
    };
    const identity = buildSessionIdentity(row);
    expect(identity.creationReason).toBeNull();
    expect(identity.unresolved.find((u) => u.field === 'creationReason')?.reason).toContain(
      'because-i-said-so',
    );
  });

  test('a null field with NO recorded reason renders a LOUD internal-inconsistency marker, not a blank', () => {
    // GUARD THE GUARD. buildSessionIdentity pairs every null with a reason, so this state is
    // unreachable through the product — which is exactly why the renderer must still refuse to
    // go quiet if it ever happens. Hand-construct the impossible input and check it screams.
    const broken = {
      sessionId: randomUUID(),
      actorId: null,
      actorIsAnonymous: false,
      actorKind: null,
      projectId: null,
      projectName: null,
      state: null,
      open: null,
      creationReason: null,
      createdAt: null,
      lastActivityAt: null,
      endedAt: null,
      title: null,
      connectionId: null,
      createdViaConnection: null,
      contextCount: 0,
      taskCount: 0,
      decisionCount: 0,
      unresolved: [], // ← the lie: nulls with no reasons
      fullyResolved: true,
    } as unknown as SessionIdentity;

    const rendered = renderSessionIdentity(broken);
    expect(rendered).toContain(NOT_RECORDED);
    expect(rendered).toContain('INTERNAL INCONSISTENCY');
    // And it never degrades to a bare label with nothing after it.
    for (const spec of IDENTITY_FIELD_SPECS) {
      expect(rendered, `field '${String(spec.key)}' rendered as an empty value`).not.toContain(
        `${spec.label}: \n`,
      );
    }
    // The compact line renderer goes through the SAME choke point — verify it too, so the two
    // renderers cannot drift apart.
    expect(renderSessionIdentityLine(broken)).toContain(NOT_RECORDED);
  });

  test('the flagged anonymous actor is called out as NOT attributed, not shown as a normal actor', async () => {
    const id = await plantLegacyRow({ actor: ACTOR_ANONYMOUS, creation_reason: 'automatic-write', project_id: projectId });
    const resp = await routeExecutor('session_get', { sessionId: id }, {});
    const identity: SessionIdentity = (resp as any).structuredContent.identity;

    expect(identity.actorId).toBe(ACTOR_ANONYMOUS);
    expect(identity.actorIsAnonymous).toBe(true);
    // A recorded value — so NOT in `unresolved` — but the text must not let it read as attributed.
    expect(identity.unresolved.map((u) => u.field)).not.toContain('actorId');
    expect(textOf(resp)).toContain('NOT attributed');
  });

  test('session_get on an unknown id returns an EXPLICIT not-found naming the id, not an empty record', async () => {
    const ghost = randomUUID();
    const resp = await routeExecutor('session_get', { sessionId: ghost }, {});
    const sc: any = resp.structuredContent;

    expect(sc.found).toBe(false);
    expect(sc.identity).toBeNull();
    expect(sc.requestedId).toBe(ghost);
    const text = textOf(resp);
    expect(text).toContain('NOT FOUND');
    expect(text).toContain(ghost); // names the id it could not resolve
  });

  test('session_status with nothing resolvable states WHY and echoes the caller — never a bare "none"', async () => {
    // LEGACY mode + a brand-new connection id: resolution is connection-keyed, so a connection
    // that has never acted resolves to nothing DETERMINISTICALLY. (In actor mode an
    // actor-less caller normalises to the shared `anonymous` principal and can legitimately
    // resolve some OTHER anonymous session — measured: it did, picking up this file's own
    // anonymous fixture row. That is correct product behaviour, not the state under test.)
    SESSION_CONFIG.resolverMode = 'legacy';
    const resp = await routeExecutor('session_status', {}, { connectionId: `empty-conn-${STAMP}` });
    const sc: any = resp.structuredContent;

    expect(sc.active).toBe(false);
    expect(sc.identity).toBeNull();
    expect(typeof sc.unresolvedReason).toBe('string');
    expect(sc.unresolvedReason.length).toBeGreaterThan(20);

    // No actor was declared — the single most common cause of "my attribution looks wrong".
    expect(sc.caller.actorDeclared).toBe(false);
    expect(textOf(resp)).toContain('NOT DECLARED');
    expect(textOf(resp)).toContain('X-Actor-ID');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// D. session_list — the project-level enumeration the report asked for
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('D. session_list enumerates sessions for correlation', () => {
  test('lists this project\'s sessions with full identity, and filters by actor', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actorA = `list-a-${STAMP}`;
    const actorB = `list-b-${STAMP}`;
    createdActors.push(actorA, actorB);

    await bindConnectionToProject(`la-${STAMP}`);
    await bindConnectionToProject(`lb-${STAMP}`);
    await routeExecutor('task_create', { title: `list-a-${STAMP}`, projectId }, { connectionId: `la-${STAMP}`, actor: actorA });
    await routeExecutor('task_create', { title: `list-b-${STAMP}`, projectId }, { connectionId: `lb-${STAMP}`, actor: actorB });

    // GUARD THE FIXTURE BEFORE ASSERTING ON THE FEATURE.
    // Read each writer's OWN session back (session_status on its connection) and confirm it
    // actually landed in this suite's project. This has to be measured HERE, not inferred from
    // the list below: `session_list({project})` only ever returns sessions already IN that
    // project, so a post-filter check on its results is decorative — it can never fire. A
    // session that drifted elsewhere is simply ABSENT, which is precisely why the original
    // flake surfaced as the un-diagnosable "expected ['anonymous', …] to include 'list-a-…'"
    // and got read as a product bug rather than a fixture bug.
    for (const [conn, who] of [[`la-${STAMP}`, actorA], [`lb-${STAMP}`, actorB]] as const) {
      const st = await routeExecutor('session_status', {}, { connectionId: conn, actor: who });
      const mine: SessionIdentity = (st as any).structuredContent.identity;
      expect(mine, `no session resolved for connection '${conn}'`).toBeTruthy();
      track(mine.sessionId);
      expect(
        mine.projectId,
        `actor '${who}' wrote into project ${mine.projectId}, not this suite's ${projectId} — ` +
          `the connection→project binding did not hold, so this run's ambient database chose ` +
          `the project instead of the test. Fixture defect, NOT a session_list defect.`,
      ).toBe(projectId);
    }

    const all = await routeExecutor('session_list', { project: projectName }, {});
    const sessions: SessionIdentity[] = (all as any).structuredContent.sessions;
    sessions.forEach((s) => track(s.sessionId));

    const actors = sessions.map((s) => s.actorId);
    expect(actors).toContain(actorA);
    expect(actors).toContain(actorB);
    // Every listed row carries the SAME full identity shape as session_get (one builder).
    for (const s of sessions) {
      expect(s.sessionId).toMatch(/^[0-9a-f]{8}-/i);
      expect(Object.keys(s)).toContain('creationReason');
      expect(Object.keys(s)).toContain('unresolved');
    }

    const onlyA = await routeExecutor('session_list', { project: projectName, actor: actorA }, {});
    const aSessions: SessionIdentity[] = (onlyA as any).structuredContent.sessions;
    expect(aSessions.length).toBeGreaterThan(0);
    expect(aSessions.every((s) => s.actorId === actorA)).toBe(true);
  });

  test('a limit above the configured ceiling is CLAMPED and the clamp is REPORTED', async () => {
    // Calls the product's own configured ceiling — no literal copied into the test.
    const over = SESSION_IDENTITY_CONFIG.listMaxLimit + 5;
    const resp = await sessionRoutes.handleList({ project: projectName, limit: over }, {});
    const sc: any = resp.structuredContent;

    expect(sc.limit).toBe(SESSION_IDENTITY_CONFIG.listMaxLimit);
    expect(sc.requestedLimit).toBe(over);
    expect(sc.limitClamped).toBe(true);
    expect(textOf(resp)).toContain('clamped'); // the caller is TOLD, not silently truncated
  });

  test('an empty result says it is empty — it is not confusable with a lookup failure', async () => {
    const resp = await routeExecutor(
      'session_list',
      { project: projectName, actor: `nobody-${STAMP}` },
      {},
    );
    const sc: any = resp.structuredContent;
    expect(sc.ok).toBe(true);
    expect(sc.sessions).toEqual([]);
    expect(textOf(resp)).toContain('not a lookup failure');
  });

  test('with no project resolvable and no allProjects flag it REFUSES rather than listing everything', async () => {
    const resp = await sessionRoutes.handleList({}, { connectionId: `noproj-${STAMP}` });
    // Either the connection resolved a project (then it is a normal list) or it refused loudly.
    if ((resp as any).isError) {
      expect(textOf(resp)).toContain('project-scoped');
    } else {
      expect((resp as any).structuredContent.filters.projectId).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// E. CORRELATION + PASSIVITY — the two properties that make this an INSTRUMENT
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('E. the read model correlates records to sessions without perturbing them', () => {
  test('a context row\'s reported sessionId resolves through session_get to the writing actor', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `correlate-${STAMP}`;
    const connectionId = `corr-conn-${STAMP}`;
    createdActors.push(actor);
    await bindConnectionToProject(connectionId);

    // Write a CONTEXT (the record type the eval could not attribute), then walk
    // record → sessionId → session_get → actor, entirely through the tool surface.
    const stored = await routeExecutor(
      'context_store',
      { content: `identity correlation probe ${STAMP}`, type: 'completion', projectId },
      { connectionId, actor },
    );
    expect(stored.isError).not.toBe(true);
    const storedSessionId = (stored as any).structuredContent?.context?.sessionId
      ?? (stored as any).structuredContent?.sessionId;
    expect(storedSessionId, 'context_store did not report the session it attached to').toBeTruthy();
    track(storedSessionId);

    const got = await routeExecutor('session_get', { sessionId: storedSessionId }, { connectionId, actor });
    const identity: SessionIdentity = (got as any).structuredContent.identity;
    expect(identity.actorId).toBe(actor);
    expect(identity.creationReason).toBe('automatic-write');
    expect(identity.contextCount).toBeGreaterThanOrEqual(1);
  });

  test('session_get accepts the 8-hex SHORT id and resolves to the same identity', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `shortid-${STAMP}`;
    const connectionId = `sid-conn-${STAMP}`;
    createdActors.push(actor);
    await bindConnectionToProject(connectionId);
    await routeExecutor('task_create', { title: `shortid-${STAMP}`, projectId }, { connectionId, actor });
    const status = await routeExecutor('session_status', {}, { connectionId, actor });
    const full = (status as any).structuredContent.identity.sessionId as string;
    track(full);

    const short = full.slice(0, 8);
    const byShort = await routeExecutor('session_get', { sessionId: short }, { connectionId, actor });
    expect((byShort as any).structuredContent.found).toBe(true);
    expect((byShort as any).structuredContent.identity.sessionId).toBe(full);
  });

  test('session_list / session_get are PASSIVE — asking the question creates no session', async () => {
    // If a read tool minted a session, the answer would be an artifact of the question.
    const connectionId = `passive-conn-${STAMP}`;
    const actor = `passive-${STAMP}`;
    createdActors.push(actor);

    const before = (
      await db.query('SELECT count(*)::int AS n FROM sessions WHERE actor = $1', [actor])
    ).rows[0].n;

    await routeExecutor('session_list', { project: projectName }, { connectionId, actor });
    await routeExecutor('session_get', { sessionId: randomUUID() }, { connectionId, actor });
    await routeExecutor('session_status', {}, { connectionId, actor });

    const after = (
      await db.query('SELECT count(*)::int AS n FROM sessions WHERE actor = $1', [actor])
    ).rows[0].n;
    expect(after).toBe(before);
  });
});
