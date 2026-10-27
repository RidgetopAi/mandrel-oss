/**
 * SESSION IDENTITY read model — the config + the vocabulary (Amp-orb eval finding W3).
 *
 * WHAT THIS IS FOR: the eval could not VERIFY attribution. The session tools exposed a
 * truncated id, a project, and active/inactive — not the full session id, not the resolved
 * actor, not why the session existed. So an orchestrator had to correlate screenshots and
 * timestamps to answer "which session produced this record, and who held it?". This module
 * owns the vocabulary and the tunables for the read model that closes that gap
 * (`session_status` / `session_get` / `session_list`).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES. Every
 * knob the identity read model touches lives HERE — a named value with a documented default
 * and an env override. Mirrors sessionConfig.ts / currentStateConfig.ts exactly.
 *
 * TWO KINDS OF ENTRY, deliberately different:
 *   - The creation-reason VOCABULARY is a value policy, not a knob. It is a plain frozen
 *     constant with NO env override: it is the contract the DB CHECK constraint
 *     (migration 068) and the tool output both speak, and an operator must never be able to
 *     widen it from the environment. It is the SINGLE SOURCE — the migration's CHECK is held
 *     in lockstep by a test that parses the SQL and compares it to this array.
 *   - The list caps ARE knobs, so they are env-overridable ints.
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default). The read
 * is deliberately its OWN statement (see currentStateConfig.ts's note — folding the normalise
 * onto the same line breaks the deploy gate's env-accounting classifier).
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * THE CREATION-REASON VOCABULARY — the single source of truth.
 *
 * WHY each value exists, and what writes it:
 *   'explicit'        — a caller explicitly opened the session: the `session_start` MCP tool
 *                       (both surfaces) or the REST `/api/v2/sessions/start`.
 *   'automatic-write' — the lazy action gate minted it because a content-producing tool
 *                       (context_store / task_create / decision_record) needed a session.
 *                       This is the value that answers the eval's actual question: "did I
 *                       start this, or did my first write create it?"
 *   'reconnect'       — DECLARED BY THE CONTRACT (the eval report names it), NOT CURRENTLY
 *                       PRODUCED. Measured on this tree: every reconnect/reattach path
 *                       (SessionLifecycleService.getActiveSession step 2 → findReattachable,
 *                       and the actor-mode resolveSession pin/newest-open branches) RESUMES
 *                       an existing row and inserts nothing — so no row can honestly be born
 *                       'reconnect' today. It is admitted so a future resume-that-mints path
 *                       has a truthful value to write instead of inventing one, and so the
 *                       published vocabulary matches the contract the eval asked for.
 *
 * NOT a member: any notion of "unknown"/"unspecified". A row whose reason was never recorded
 * stores NULL, and the read model reports that as an EXPLICIT unresolved field with a reason
 * — it is never rendered as a plausible value. Keeping "unknown" out of the stored vocabulary
 * is what makes the DB CHECK a real deny-by-default gate.
 */
export const SESSION_CREATION_REASONS = ['explicit', 'automatic-write', 'reconnect'] as const;

export type SessionCreationReason = (typeof SESSION_CREATION_REASONS)[number];

/** Type guard: is `v` a value the contract (and the DB CHECK) admits? Deny-by-default. */
export function isSessionCreationReason(v: unknown): v is SessionCreationReason {
  return typeof v === 'string' && (SESSION_CREATION_REASONS as readonly string[]).includes(v);
}

/**
 * The states a session row can report. Mirrors the `sessions_status_check` CHECK constraint
 * (migration 065). Exported so the read model can DETECT a status the contract does not know
 * — an unrecognised status is surfaced as unresolved, never passed through as if understood
 * (unrecognised input → loud, not a silent pass).
 */
export const SESSION_STATES = [
  'active',
  'inactive',
  'disconnected',
  'interrupted',
  'ended',
  'dormant',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** Type guard for a contract-known session state. Deny-by-default. */
export function isSessionState(v: unknown): v is SessionState {
  return typeof v === 'string' && (SESSION_STATES as readonly string[]).includes(v);
}

/**
 * The states that mean the session is still OPEN (resumable / joinable). Kept in lockstep
 * with the canonical openness predicate the resolvers use (`ended_at IS NULL AND status IN
 * ('active','interrupted','dormant')` — SessionRepo.existsActive / findReattachable /
 * newestOpenForActor and the migration-065 partial-index predicates).
 */
export const SESSION_OPEN_STATES: readonly SessionState[] = ['active', 'interrupted', 'dormant'] as const;

export interface SessionIdentityConfig {
  /**
   * listDefaultLimit — how many sessions `session_list` returns when the caller names no
   * limit. Bounded by design: an orchestrator correlating attribution wants the recent
   * window, not the whole history. Env: MANDREL_SESSION_LIST_DEFAULT_LIMIT. Default 20.
   */
  listDefaultLimit: number;
  /**
   * listMaxLimit — the hard ceiling on `session_list`'s limit. A caller asking for more is
   * CLAMPED and TOLD (the response reports the clamp), never silently truncated.
   * Env: MANDREL_SESSION_LIST_MAX_LIMIT. Default 100.
   */
  listMaxLimit: number;
}

/** THE LIVE CONFIG — read once at module load. */
export const SESSION_IDENTITY_CONFIG: SessionIdentityConfig = {
  listDefaultLimit: envInt('MANDREL_SESSION_LIST_DEFAULT_LIMIT', 20),
  listMaxLimit: envInt('MANDREL_SESSION_LIST_MAX_LIMIT', 100),
};
