/**
 * Shared Project Types
 *
 * Extracted to break circular dependency between:
 * - handlers/project.ts
 * - services/projectSwitchValidator.ts
 */

export interface ProjectInfo {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  gitRepoUrl: string | null;
  rootDirectory: string | null;
  metadata: Record<string, any>;
  contextCount?: number;
  isActive?: boolean;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  status?: string;
  gitRepoUrl?: string;
  rootDirectory?: string;
  metadata?: Record<string, any>;
}

/**
 * BRAND — the reason a hand-written child-table list cannot reach the delete gate.
 *
 * `services/projectCascade.buildChildCounts()` is the only thing that can produce a
 * `ProjectChildCounts`, because nothing else can supply this key. A future caller that
 * tries to hand `deleteProject`'s gate a literal `{ contexts: 0, tasks: 0, total: 0 }`
 * — the shape that shipped the defect this brand exists to prevent — gets a COMPILE
 * ERROR at the call site rather than a second enumeration that silently drifts from the
 * schema. See the header of services/projectCascade.ts.
 */
declare const PROJECT_CHILD_COUNTS_BRAND: unique symbol;

/**
 * What a project delete would destroy, measured against the SCHEMA (every FK to
 * `projects` with ON DELETE CASCADE) rather than a hardcoded table list.
 *
 * `byTable` is the single source: the delete predicate (`isProjectEmpty`) and every
 * human-facing sentence (`describeProjectChildCounts`) are derived from it, and `total`
 * is computed from it inside the constructor. An EMPTY `byTable` means the schema probe
 * found nothing and the blast radius is UNKNOWN — which fails CLOSED (confirmation
 * required), never "empty".
 */
export interface ProjectChildCounts {
  /** Cascading child table name → rows this project owns in it. ONE entry per TABLE. */
  readonly byTable: Readonly<Record<string, number>>;
  /** Derived: the sum over `byTable`. Never supplied by a caller. */
  readonly total: number;
  /**
   * Cascading FK constraints that do NOT reach their child through `projects.id`, so their
   * rows cannot be counted from a project id. NON-EMPTY ⇒ the whole answer is UNKNOWN and
   * `isProjectEmpty` is false regardless of `byTable` — an unkeyable cascade must never be
   * reported as "nothing".
   */
  readonly unmeasurable: readonly string[];
  readonly [PROJECT_CHILD_COUNTS_BRAND]: 'derived-from-schema';
}

/**
 * WHY a delete was refused — and specifically, whether RETRYING CAN HELP.
 *
 * Exactly one of these is retryable: `needs_confirmation`. The other two are decided
 * BEFORE the confirm gate, so `confirm: true` returns the identical refusal — telling that
 * caller to confirm sends them round a loop that cannot terminate.
 *
 * This exists because a consumer outside MCP (the Command UI backend) has to
 * set a `requiresConfirmation` flag on the wire, and every refusal arrives under the same
 * `action: 'delete_refused'`. Without this field that consumer must GUESS, and the guess it
 * made was "always retryable" — a machine field that says "retry with X" when X changes
 * nothing, which is the same defect class as a delete reporting a blast radius it never
 * measured.
 */
export type DeleteRefusalReason =
  /** Non-empty (or unmeasurable) and `confirm` was not passed. Retrying WITH confirm works. */
  | 'needs_confirmation'
  /** It is the caller's active project. Retrying is futile; switch project first. */
  | 'active_project'
  /** It is the last remaining project. Retrying is futile; create another first. */
  | 'last_project';

export interface DeleteProjectResult {
  deleted: boolean;
  projectId?: string;
  projectName: string;
  counts: ProjectChildCounts;
  message: string;
  /**
   * Set on EVERY refusal (`deleted: false`). Absent on success. A refusal that omits it is
   * a bug: consumers must be able to tell a retryable refusal from a futile one without
   * parsing the prose.
   */
  reason?: DeleteRefusalReason;
}

export interface SessionState {
  currentProjectId: string | null;
  sessionId?: string;
  agentType?: string;
  manualOverride?: boolean;  // Track if user manually switched (vs auto-initialized)
}
