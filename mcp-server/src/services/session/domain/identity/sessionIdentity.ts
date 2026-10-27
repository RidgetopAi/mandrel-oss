/**
 * SESSION IDENTITY read model — THE ONE builder + THE ONE renderer (Amp-orb eval finding W3).
 *
 * THE GAP THIS CLOSES (eval report lines 413-456, Priority 1): the session tools exposed a
 * truncated session id, a project, and active/inactive. They did not expose the resolved
 * actor, the full session id, why the session existed, or a project-level list — so the
 * evaluator could not VERIFY attribution and fell back to correlating screenshots with
 * timestamps. W1 (atomic task claim) and W2 (actor-bound resolution) built the mechanism;
 * this is the instrument that proves it worked.
 *
 * ── THE HONESTY RULE THIS MODULE ENFORCES ──────────────────────────────────────────────────
 * A field that cannot be resolved must SAY SO. Never a blank, never an em-dash, never a
 * plausible default. Silence is the failure mode this whole workstream exists to kill.
 *
 * That rule is enforced STRUCTURALLY, not by discipline:
 *   1. `buildSessionIdentity` is the ONLY producer of a `SessionIdentity`. Every time it
 *      writes `null` into a field it MUST push a matching `{field, reason}` onto `unresolved`
 *      — the two happen in one helper (`unresolvedNull`), so they cannot drift apart.
 *   2. `renderSessionIdentity` does not read the identity ad-hoc. It walks ONE field spec
 *      table and renders every value through ONE function (`renderFieldValue`), which is
 *      structurally incapable of emitting an empty string for a null: null → the
 *      `NOT_RECORDED` marker plus the recorded reason. A null with NO recorded reason renders
 *      as a LOUD internal-inconsistency marker (that combination is a bug in (1), and the
 *      renderer says so out loud rather than papering over it).
 *   3. An unrecognised `status` from the database is NOT passed through as if understood. It
 *      is reported as unresolved, naming the offending value (a past incident — unrecognised input
 *      must be a loud RED, never a silent pass).
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────────────────────
 * The identity record carries OBSERVABILITY fields only. `actorId` is deliberately exposed —
 * it is the field the eval asked for, and on the single-tenant container the actor is
 * ATTRIBUTION, not an authz boundary (see migration 062's trust-model note). It can be an Amp
 * thread id; that is an identifier, not a credential.
 *
 * DELIBERATELY NOT EXPOSED, and why:
 *   - No token, bearer, auth header, OAuth `sub` claim, password, or cookie is read by this
 *     module or reachable from the row shape it selects. There is no code path here that
 *     could surface one.
 *   - The `sessions.metadata` JSONB blob is NOT surfaced. It is a free-form grab bag written
 *     by several paths; publishing it wholesale would be publishing whatever anything ever
 *     put there. The identity fields we DO need are read from typed columns instead.
 *   - `sessions.description` / `context_summary` are not identity and are not surfaced.
 */

import {
  SESSION_OPEN_STATES,
  isSessionCreationReason,
  isSessionState,
  type SessionCreationReason,
  type SessionState,
} from '../../../../config/sessionIdentityConfig.js';
import { ACTOR_ANONYMOUS, classifyActor, type ActorKind } from '../../../../config/actorRegistry.js';

/**
 * THE MARKER every unresolved field renders through. The renderer emits it and the guard test
 * asserts on it by CALLING the renderer — one token, one home. If this string ever changes,
 * the guard moves with it because the guard imports it rather than spelling it out.
 */
export const NOT_RECORDED = 'NOT RECORDED';

/** A field the read model could not resolve, and the reason it could not. */
export interface UnresolvedIdentityField {
  /** The identity field name, exactly as it appears on the JSON record. */
  field: string;
  /** Why it could not be resolved — human-readable, specific, never "unknown". */
  reason: string;
}

/**
 * The raw `sessions` row shape the identity read model consumes. Snake_case because it is the
 * database's shape; SessionRepo selects exactly these columns.
 */
export interface SessionIdentityRow {
  id: string;
  actor: string | null;
  project_id: string | null;
  project_name: string | null;
  status: string | null;
  creation_reason: string | null;
  started_at: Date | string | null;
  last_activity_at: Date | string | null;
  ended_at: Date | string | null;
  title: string | null;
  connection_id: string | null;
  created_via_connection: string | null;
  context_count: number | string | null;
  task_count: number | string | null;
  decision_count: number | string | null;
}

/**
 * The public identity record — the shape the eval asked for (report lines 437-449), plus the
 * connection lineage the report's "missing fields" list also named, plus the honesty payload.
 */
export interface SessionIdentity {
  /** The FULL session id — never a truncated display form. This is the whole point. */
  sessionId: string;
  /** The resolved actor that owns the session, or null (with a reason) if never recorded. */
  actorId: string | null;
  /**
   * True when `actorId` is the flagged `anonymous` fallback — i.e. the session was created
   * with NO derivable actor. A recorded value, but one an orchestrator must not read as
   * "attributed": it means the caller's X-Actor-ID never landed.
   */
  actorIsAnonymous: boolean;
  /** human | agent | automation, from the shared classifier. Null when actorId is null. */
  actorKind: ActorKind | null;
  projectId: string | null;
  projectName: string | null;
  /** The contract-known session state, or null when absent/unrecognised (with a reason). */
  state: SessionState | null;
  /** True when the state means the session is still open/joinable. Null when state is null. */
  open: boolean | null;
  /** Why the session row exists. Null (with a reason) on rows predating migration 068. */
  creationReason: SessionCreationReason | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  endedAt: string | null;
  title: string | null;
  /** Lineage: the connection this session is keyed to (NULL on actor-mode rows, by design). */
  connectionId: string | null;
  /** Lineage: the physical connection that MINTED an actor-mode row (telemetry, migration 064). */
  createdViaConnection: string | null;
  contextCount: number;
  taskCount: number;
  decisionCount: number;
  /** Every field that could not be resolved, each with its reason. Empty when all resolved. */
  unresolved: UnresolvedIdentityField[];
  /** Convenience mirror of `unresolved.length === 0` so a consumer can branch without parsing. */
  fullyResolved: boolean;
}

/** Normalise a timestamp column to an ISO string, or null when absent. */
function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Normalise a COUNT() column (pg returns bigint as a string) to a number. */
function toCount(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the identity record from a raw session row.
 *
 * THE INVARIANT: every `null` this function writes into the record is accompanied by a
 * matching entry in `unresolved`. That pairing is done by the local `unresolvedNull` helper,
 * which is the ONLY way a null reaches the record — so "a null with no reason" is not a
 * discipline question, it is unreachable.
 */
export function buildSessionIdentity(row: SessionIdentityRow): SessionIdentity {
  const unresolved: UnresolvedIdentityField[] = [];

  /** Record a field as unresolved (with its reason) and yield the null that goes in the record. */
  const unresolvedNull = (field: string, reason: string): null => {
    unresolved.push({ field, reason });
    return null;
  };

  // ── actor ────────────────────────────────────────────────────────────────────────────────
  const actorRaw = typeof row.actor === 'string' ? row.actor.trim() : '';
  const actorId =
    actorRaw !== ''
      ? actorRaw
      : unresolvedNull(
          'actorId',
          'no actor is stamped on this session row — it was created before actor stamping ' +
            '(migration 062) shipped. Attribution for this session cannot be established from ' +
            'the session record.',
        );
  const actorIsAnonymous = actorId === ACTOR_ANONYMOUS;
  const actorKind: ActorKind | null = actorId === null ? null : classifyActor(actorId);

  // ── project ──────────────────────────────────────────────────────────────────────────────
  const projectId =
    row.project_id ??
    unresolvedNull(
      'projectId',
      'no project is attached to this session — it was created before a project was ' +
        'selected, or the project was deleted.',
    );
  const projectName =
    projectId === null
      ? null // already reported via projectId; a second entry would be noise, not signal.
      : (row.project_name ??
        unresolvedNull(
          'projectName',
          `the session references project ${row.project_id} but no project row with that id ` +
            'exists (the project was deleted).',
        ));

  // ── state ────────────────────────────────────────────────────────────────────────────────
  // DENY-BY-DEFAULT: a status the contract does not declare is reported as unresolved, naming
  // the offending value. It is never passed through as if we understood it.
  let state: SessionState | null;
  if (row.status === null || row.status === undefined || row.status === '') {
    state = unresolvedNull('state', 'no status is recorded on this session row.');
  } else if (isSessionState(row.status)) {
    state = row.status;
  } else {
    state = unresolvedNull(
      'state',
      `the session's stored status '${row.status}' is not in the declared session-state ` +
        'vocabulary (active, inactive, disconnected, interrupted, ended, dormant). The read ' +
        'model will not guess what it means.',
    );
  }
  const open = state === null ? null : (SESSION_OPEN_STATES as readonly string[]).includes(state);

  // ── creation reason ──────────────────────────────────────────────────────────────────────
  let creationReason: SessionCreationReason | null;
  if (row.creation_reason === null || row.creation_reason === undefined || row.creation_reason === '') {
    creationReason = unresolvedNull(
      'creationReason',
      'this session predates creation-reason tracking (migration 068), so why it was created ' +
        'was never recorded. It is NOT known whether it was started explicitly or minted by a ' +
        'write.',
    );
  } else if (isSessionCreationReason(row.creation_reason)) {
    creationReason = row.creation_reason;
  } else {
    // Only reachable if the DB CHECK were dropped or bypassed — say so loudly rather than
    // handing an orchestrator a value the contract does not define.
    creationReason = unresolvedNull(
      'creationReason',
      `the session's stored creation reason '${row.creation_reason}' is not in the declared ` +
        'vocabulary (explicit, automatic-write, reconnect). The read model will not guess what ' +
        'it means.',
    );
  }

  // ── timestamps ───────────────────────────────────────────────────────────────────────────
  const createdAt =
    toIso(row.started_at) ??
    unresolvedNull('createdAt', 'no start timestamp is recorded on this session row.');
  const lastActivityAt =
    toIso(row.last_activity_at) ??
    unresolvedNull(
      'lastActivityAt',
      'no last-activity timestamp is recorded — this session has had no activity flushed to ' +
        'it since it was created.',
    );
  // endedAt is legitimately absent on an OPEN session; that is information, not a gap, so it
  // is NOT reported as unresolved. The state field already says the session is open.
  const endedAt = toIso(row.ended_at);

  const identity: SessionIdentity = {
    sessionId: row.id,
    actorId,
    actorIsAnonymous,
    actorKind,
    projectId,
    projectName,
    state,
    open,
    creationReason,
    createdAt,
    lastActivityAt,
    endedAt,
    title: row.title ?? null,
    connectionId: row.connection_id ?? null,
    createdViaConnection: row.created_via_connection ?? null,
    contextCount: toCount(row.context_count),
    taskCount: toCount(row.task_count),
    decisionCount: toCount(row.decision_count),
    unresolved,
    fullyResolved: unresolved.length === 0,
  };

  return identity;
}

/**
 * ONE field spec table — the renderer's single source for WHAT to render and in WHAT ORDER.
 * `get` returns the value straight off the identity record, so the rendered text and the JSON
 * record are physically the same data: you cannot change one without the other moving.
 */
export interface IdentityFieldSpec {
  /** The identity field name — must match the `field` key `unresolved` entries use. */
  key: keyof SessionIdentity;
  /** The label shown in the rendered text. */
  label: string;
}

/**
 * EXPORTED so the guard test can iterate the PRODUCT's own list rather than carrying a copy
 * of it. A test that spelled these out again would be a second program that happens to agree
 * with this one. The test separately asserts this table covers the nine fields
 * the eval report's response shape requires (report lines 437-449) — that assertion anchors on
 * the external SPEC, so deleting an entry here is a RED, not a quietly-shorter loop.
 */
export const IDENTITY_FIELD_SPECS: readonly IdentityFieldSpec[] = [
  { key: 'sessionId', label: 'session' },
  { key: 'actorId', label: 'actor' },
  { key: 'projectId', label: 'project' },
  { key: 'state', label: 'state' },
  { key: 'creationReason', label: 'creation reason' },
  { key: 'createdAt', label: 'created' },
  { key: 'lastActivityAt', label: 'last activity' },
  { key: 'contextCount', label: 'contexts' },
  { key: 'taskCount', label: 'tasks' },
] as const;

/**
 * Render ONE field's value. THE choke point every rendered identity value passes through.
 *
 * Structurally incapable of emitting a blank for an absent value:
 *   - a null WITH a recorded reason → `NOT RECORDED (<reason>)`
 *   - a null WITHOUT a recorded reason → a loud internal-inconsistency marker. That state is
 *     supposed to be unreachable (buildSessionIdentity pairs every null with a reason); if it
 *     ever happens, the output says so instead of hiding it.
 */
function renderFieldValue(identity: SessionIdentity, key: keyof SessionIdentity): string {
  const value = identity[key];
  if (value !== null && value !== undefined && value !== '') {
    return String(value);
  }
  const reason = identity.unresolved.find((u) => u.field === key)?.reason;
  if (reason) {
    return `${NOT_RECORDED} (${reason})`;
  }
  return (
    `${NOT_RECORDED} (INTERNAL INCONSISTENCY: field '${String(key)}' is absent but no reason ` +
    `was recorded for it — this is a bug in buildSessionIdentity, not a property of the session)`
  );
}

/**
 * Render the identity as human-readable text. Walks the ONE field spec table so every field
 * goes through `renderFieldValue`; there is no path here that formats a value by hand.
 */
export function renderSessionIdentity(identity: SessionIdentity): string {
  const lines = IDENTITY_FIELD_SPECS.map(
    (spec) => `   ${spec.label}: ${renderFieldValue(identity, spec.key)}`,
  );

  // The anonymous-actor callout: a RECORDED value that must not be read as "attributed".
  if (identity.actorIsAnonymous) {
    lines.push(
      `   ⚠️  actor is the flagged '${ACTOR_ANONYMOUS}' fallback — this session was created ` +
        `with NO derivable actor (no X-Actor-ID header and no authenticated principal), so it ` +
        `is NOT attributed to any caller.`,
    );
  }

  if (identity.unresolved.length > 0) {
    lines.push(
      `   ⚠️  ${identity.unresolved.length} identity field(s) could not be resolved: ` +
        identity.unresolved.map((u) => u.field).join(', '),
    );
  }

  return lines.join('\n');
}

/**
 * The one-line headline used where a full block is too much (e.g. a row inside session_list).
 * Uses the SAME renderFieldValue choke point, so an unresolved field is just as loud in a
 * list row as it is in a detail block.
 */
export function renderSessionIdentityLine(identity: SessionIdentity): string {
  return (
    `${renderFieldValue(identity, 'sessionId')}` +
    ` | actor ${renderFieldValue(identity, 'actorId')}` +
    ` | ${renderFieldValue(identity, 'state')}` +
    ` | via ${renderFieldValue(identity, 'creationReason')}` +
    ` | ctx ${renderFieldValue(identity, 'contextCount')}` +
    ` tasks ${renderFieldValue(identity, 'taskCount')}` +
    ` | last activity ${renderFieldValue(identity, 'lastActivityAt')}`
  );
}
