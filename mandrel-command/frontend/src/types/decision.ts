/**
 * The Decision read model — the REAL shape the Command backend serves for a technical
 * decision (via the MCP `decision_search` proxy). Grounded against a live record, NOT the
 * generated DecisionEntity (which is stale: it omits `decision_type`, `impact_level`,
 * `successCriteria`, `implementationStatus`, `affected_components`).
 *
 * Field notes (from live data):
 *   - `decision_type`  — architecture | ui_ux | deployment | pattern | process | testing | … (the "type" facet)
 *   - `impact_level`   — critical | high | medium | low
 *   - `status`         — active | under_review | superseded | deprecated (lifecycle)
 *   - `implementationStatus` — planned | in_progress | implemented | validated
 *   - `outcomeStatus`  — unknown | successful | failed | mixed | too_early (the learning loop)
 *   - `successCriteria`— free text (mostly populated); `alternatives` / `affected_components`
 *                        are string arrays that are frequently EMPTY (render honest empty).
 *   - `created_by`     — NOT currently serialised by the backend (always absent) → the "by X"
 *                        chip is omitted rather than faked (data-gap policy).
 */
export interface Decision {
  id: string;
  project_id?: string;
  project_name?: string;
  session_id?: string;
  title: string;
  problem?: string;
  decision?: string;
  rationale?: string;
  decision_type?: string;
  impact_level?: 'critical' | 'high' | 'medium' | 'low' | string;
  status?: 'active' | 'under_review' | 'superseded' | 'deprecated' | string;
  implementationStatus?: string;
  successCriteria?: string;
  outcomeStatus?: 'unknown' | 'successful' | 'failed' | 'mixed' | 'too_early' | string;
  outcomeNotes?: string | null;
  lessonsLearned?: string | null;
  supersededBy?: string | null;
  supersededReason?: string | null;
  alternatives?: string[];
  affected_components?: string[];
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  created_by?: string;
  updated_by?: string;

  // ── THE DECISION INBOX ──────────────────
  // Always camelCase on the wire — decisionSerializer.ts emits these fields identically
  // whether or not `legacyAliases` is on (no snake_case alias exists for them).
  /** open | discussing | decided. Absent on a pre-inbox record read through an old path. */
  answerStatus?: 'open' | 'discussing' | 'decided' | string;
  /** The one-sentence thing being decided. Non-null only when answerStatus='open'/'discussing'. */
  question?: string | null;
  /** >=2 entries when answerStatus='open', each with >=1 pro and >=1 con. */
  options?: DecisionOption[];
  /** The `options[].key` decision_answer selected. Null until answered. */
  chosen?: string | null;
  answeredAt?: string | null;
  answeredBy?: string | null;
  /** decision_discuss's running note log (appended, never replaced). */
  answerNote?: string | null;
  deadline?: string | null;
}

/** One choice in an open decision's `options` array (migration 104). */
export interface DecisionOption {
  key: string;
  label: string;
  pros: string[];
  cons: string[];
  recommended?: boolean;
}

/** The decision list read (GET /api/decisions → transformed { decisions, total, ... }). */
export interface DecisionSearchResult {
  decisions: Decision[];
  total: number;
  page?: number;
  limit?: number;
}

/**
 * The stats shape (GET /api/decisions/stats → MCP decision_stats). Facet counts are the
 * REAL full-corpus counts — never fabricated. `by_type` feeds the type facets.
 */
export interface DecisionStats {
  total_decisions?: number;
  recent_decisions?: number;
  total_projects?: number;
  by_status?: Record<string, number>;
  by_type?: Record<string, number>;
  by_impact?: Record<string, number>;
  by_project?: Record<string, number>;
}
