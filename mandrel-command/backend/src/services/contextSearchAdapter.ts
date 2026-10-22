/**
 * CONTEXT SEARCH ADAPTER (search consolidation).
 *
 * THE SEAM between the Command REST surface and the ONE matching engine
 * (mcp-server contextHandler.searchContext, reached via McpService.callTool
 * 'context_search'). This module is the ONLY place that translates a REST
 * ContextSearchParams into canonical `context_search` MCP arguments — the same
 * proxy pattern ContextController.createContext already uses for context_store.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SINGLE-ENGINE RULE: matching/ranking for contexts lives ONLY in          │
 * │   mcp-server. The Command backend may ONLY filter by structured columns   │
 * │   (browse mode) and must NEVER match text. A `query` ALWAYS routes here,   │
 * │   to the canonical engine — never to a backend ILIKE/predicate.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Pure functions (no I/O) so they are exhaustively unit-testable without a DB or
 * a live MCP server. The controller owns the network call + the project_name
 * enrichment; this owns the argument contract.
 */

import { looksLikeId } from '../utils/searchPredicates';
import { ALL_PROJECTS } from './projectListScope';
import type { ContextSearchParams } from './context';

/**
 * Thrown when a query-mode search reaches the adapter WITHOUT a projectId. This is
 * fail-closed on purpose: if we forwarded a query to the MCP route with no project,
 * the route would silently resolve the proxy CONNECTION's current project — i.e. a
 * different, wrong scope than the UI intends (a silent cross-project leak). The
 * controller maps this to an HTTP 400 (a caller error), never a 500.
 */
export class MissingProjectIdError extends Error {
  constructor() {
    super('projectId is required for context search (query mode) to scope the results');
    this.name = 'MissingProjectIdError';
  }
}

/** Canonical `context_search` MCP arguments (the subset this adapter emits). */
export interface ContextSearchMcpArgs {
  projectId: string;
  /** Present for a free-text semantic search; absent for a by-id direct lookup. */
  query?: string;
  /** Present ONLY for a by-id direct lookup (query looked like an id). */
  id?: string;
  type?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  /** Canonical scale is 0–100; the UI sends 0–1, so we ×100 here (the scale fix). */
  minSimilarity?: number;
  dateFrom?: string;
  dateTo?: string;
  /** The highlight/scroll-to-match feature needs full content, so always 'detailed'. */
  response_format: 'detailed';
}

/**
 * Build canonical `context_search` MCP args from REST search params.
 *
 * Rules (per the consolidation design):
 *   - projectId REQUIRED → throws MissingProjectIdError (→ 400) when absent.
 *   - looksLikeId(query)  → by-id direct lookup ({ id }), reusing the SAME id
 *     heuristic the old literal path used (searchPredicates.looksLikeId).
 *   - otherwise           → semantic search with the structured filters forwarded.
 *   - min_similarity (0–1 from the UI) → minSimilarity ×100 (canonical is 0–100).
 *   - response_format:'detailed' always (highlight needs full content).
 *   - sort_by/sort_order are BROWSE-only and intentionally dropped here: search is
 *     relevance-ordered by the engine.
 */
export function buildContextSearchArgs(params: ContextSearchParams): ContextSearchMcpArgs {
  const query = params.query?.trim();

  // ONE PROJECT OR NOTHING (an earlier task item 7). The canonical `context_search` tool
  // takes a single `projectId` and cannot express a SET, so a scope that is not exactly
  // one project has no faithful representation here. Every such scope — ALL_PROJECTS, the
  // caller's several grants, and the zero-grant empty set — throws the SAME
  // MissingProjectIdError the absent project always threw, i.e. a 400 telling the client
  // to name a project. The alternative (forward no project) is the ambient-resolution leak
  // this class of defect is about: the proxy would answer from whatever project its shared
  // connection last pointed at.
  const projectId =
    params.scope.mode !== ALL_PROJECTS && params.scope.projectIds.length === 1
      ? params.scope.projectIds[0]
      : undefined;

  if (!projectId) {
    throw new MissingProjectIdError();
  }

  // By-id direct lookup: a query that looks like a full UUID or a long-enough hex
  // prefix routes to the canonical by-id branch (bypasses semantic ranking).
  if (query && looksLikeId(query)) {
    return {
      projectId,
      id: query,
      response_format: 'detailed',
    };
  }

  const args: ContextSearchMcpArgs = {
    projectId,
    response_format: 'detailed',
  };

  if (query) args.query = query;
  if (params.type) args.type = params.type;
  if (params.tags && params.tags.length > 0) args.tags = params.tags;
  if (params.limit !== undefined) args.limit = params.limit;
  if (params.offset !== undefined) args.offset = params.offset;
  if (params.date_from) args.dateFrom = params.date_from;
  if (params.date_to) args.dateTo = params.date_to;
  // SCALE FIX: UI sends a 0–1 fraction, the canonical engine expects 0–100.
  if (params.min_similarity !== undefined && params.min_similarity !== null) {
    args.minSimilarity = params.min_similarity * 100;
  }

  return args;
}

/** A canonical `context_search` structuredContent row (the fields we consume). */
export interface CanonicalContextRow {
  id: string;
  contextType?: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  projectId?: string;
  sessionId?: string | null;
  relevance?: number;
  relevanceScore?: number;
  similarity?: number;
  createdAt?: string;
}

/** The REST Context shape the frontend consumes (mirrors services/context.ts Context). */
export interface RestContextRow {
  id: string;
  project_id?: string;
  project_name?: string;
  type?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  relevance_score?: number;
  session_id?: string | null;
  created_at?: string;
  updated_at?: string;
  /** The 0–100 relevance the row ranked on (search mode only) — for an optional badge. */
  relevance?: number;
}

/**
 * Map a canonical `context_search` structured row into the REST Context shape,
 * enriching with the project name resolved by the caller. Keeps the REST response
 * SHAPE identical to the browse path (so no OpenAPI regen).
 */
export function mapCanonicalRowToRest(
  row: CanonicalContextRow,
  projectName?: string,
): RestContextRow {
  return {
    id: row.id,
    project_id: row.projectId,
    project_name: projectName,
    type: row.contextType,
    content: row.content,
    metadata: row.metadata,
    tags: row.tags ?? [],
    relevance_score: row.relevanceScore,
    session_id: row.sessionId ?? undefined,
    created_at: row.createdAt,
    updated_at: row.createdAt,
    relevance: row.relevance,
  };
}
