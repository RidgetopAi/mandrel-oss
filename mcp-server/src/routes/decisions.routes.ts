import { decisionsHandler, normalizeOffset, DecisionOpenValidationError, DecisionInboxActionError } from '../handlers/decisions.js';
import { serializeDecision } from '../services/serializers/decisionSerializer.js';
import { projectHandler } from '../handlers/project.js';
import { formatRecordRef } from '../config/commandUrlConfig.js';
import { SessionTrackingMiddleware } from '../api/middleware/sessionTracking.js';
import { formatMcpError, rawValue } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { logger } from '../utils/logger.js';
import {
  resolveEntityId,
  isFullUuid,
  AmbiguousIdError,
  IdNotFoundError,
  ambiguousIdMessage,
  idErrorResponse,
  reservedArgPrefixInQuery,
  reservedArgPrefixMessage,
} from '../utils/idResolver.js';
import {
  autoMintFromTags,
  autoMintFromDecision,
  mintExplicitLinks,
  type LinkWarning,
  type ReportedMintedEdge,
} from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import {
  mintPositional,
  serializePositionalReport,
  composePositionalBody,
  positionalResponseLines,
} from '../services/positionalMint.js';
import { buildWriteEcho } from '../utils/projectEcho.js';
import { trustForRecords, explainTrust, type RecordRef, type Trust } from '../services/trust.js';
import { projectTrust } from '../services/altitudeProjection.js';

/**
 * Technical Decisions Routes
 * Handles: decision_record, decision_search, decision_update, decision_stats
 */
class DecisionsRoutes {
  /**
   * Resolve project ID using connection-scoped session state
   */
  private async resolveProjectId(argsProjectId: string | undefined, context?: RouteContext): Promise<string | undefined> {
    if (argsProjectId) return argsProjectId;
    const sessionId = context?.connectionId || 'default-session';
    await projectHandler.initializeSession(sessionId);
    // PROJECT-SCOPE: effective — a route's own project resolution. Under a binding this is
    // the bound project; unbound it is rung 3, exactly as before.
    const projectId = await projectHandler.getCurrentProjectId(sessionId);
    return projectId || undefined;
  }
  /**
   * T5a: render explicit-link rejection WARNINGS as compact human lines for the text
   * channel — mirrors the context route's surfacing so both write paths read identically.
   */
  static linkWarningLines(warnings: LinkWarning[]): string[] {
    return warnings.map((w) => `${w.reason} (link: ${JSON.stringify(w.spec)})`);
  }

  /**
   * THE PER-WRITE EDGE LEDGER — one row per edge this write minted OR
   * deduped, each labeled with the path that produced it. This is the same shape
   * `context_store` returns (`ReportedMintedEdge`), built here from the
   * results the mint helpers already hand back, so the two write paths report identically
   * instead of growing a second vocabulary (no drifting twins).
   *
   * WHY A LEDGER AND NOT JUST A COUNT. `decision_record` already returned a correct TOTAL
   * — but a caller could see "4" and not see WHICH four, by what
   * provenance, or whether any of them were dedups rather than new rows. In a product whose
   * value is the graph, an unattributed number is not a report.
   *
   * COUNTED ON `created`, NOT ON ATTEMPTED. A dedup appears as a row with `created:false`
   * — visible, so a re-link reads as "already linked" instead of as nothing-happened — and
   * contributes ZERO to the total, so re-running a write cannot inflate it.
   *
   * THE ONE SOURCE THAT CANNOT BE ITEMIZED, AND WHERE IT GOES INSTEAD.
   * `autoMintFromDecision` (metadata evidence → `learned_from`, `superseded_by` →
   * `supersedes`) returns `{minted, attempted}` and no edge list, so its edges cannot
   * appear as ledger rows without changing `services/links.ts`. They are NOT dropped: they
   * are in `linksMinted` and in `mintedBySource.decision`. That remainder is not left as a
   * sentence — `decisionEdgeReporting.contract.test.ts` executes the identity
   * `edgesMinted.filter(created).length + mintedBySource.decision === linksMinted` on every
   * case in this file, so the accounting cannot silently stop closing.
   */
  static edgeLedger(sources: {
    tags?: { edges: Array<{ sourceTag: string } & Record<string, any>> };
    links?: { edges: Array<Record<string, any>> };
    positional?: { edges: Array<Record<string, any>> };
  }): ReportedMintedEdge[] {
    return [
      ...(sources.tags?.edges ?? []).map((e): ReportedMintedEdge => ({ via: EDGE_MINT_VIA.tag, ...(e as any) })),
      ...(sources.links?.edges ?? []).map((e): ReportedMintedEdge => ({ via: EDGE_MINT_VIA.linksParam, ...(e as any) })),
      ...(sources.positional?.edges ?? []).map((e): ReportedMintedEdge => ({
        via: e.via,
        edgeType: e.edgeType,
        toType: e.toType,
        toId: e.toId,
        created: e.created,
      })),
    ];
  }

  /**
   * TEXT-CHANNEL lines for the ledger's tag/links-param rows — success made as visible as
   * failure. Before this, those two paths surfaced ONLY their failures (skips/warnings) in
   * the prose, so a correctly-threaded decision read as an orphan at a glance. Mirrors
   * `context_store`'s `Linked:` block verbatim in shape. Positional rows are excluded here
   * because `positionalResponseLines` already renders them (one renderer per concern).
   */
  static ledgerLines(edges: ReportedMintedEdge[]): string[] {
    return edges
      .filter((e) => e.via === EDGE_MINT_VIA.tag || e.via === EDGE_MINT_VIA.linksParam)
      .map(
        (e) =>
          `${e.edgeType} → ${e.toType} ${e.toId}` +
          (e.created ? '' : ' (already linked)') +
          (e.via === EDGE_MINT_VIA.tag ? ` (via tag${e.sourceTag ? ` "${e.sourceTag}"` : ''})` : ' (via links)')
      );
  }

  /**
   * Handle decision record requests
   */
  async handleRecord(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      logger.info(`📝 Decision record request: ${args.decisionType} (project: ${projectId?.substring(0, 8)}...)`);

      const decision = await decisionsHandler.recordDecision({
        decisionType: args.decisionType,
        title: args.title,
        description: args.description,
        rationale: args.rationale,
        impactLevel: args.impactLevel,
        alternativesConsidered: args.alternativesConsidered,
        problemStatement: args.problemStatement,
        successCriteria: args.successCriteria,
        implementationStatus: args.implementationStatus,
        // A1: forward the outcome fields so a decision recorded WITH a known outcome
        // (or lessons) keeps them instead of having them silently dropped at the route.
        outcomeStatus: args.outcomeStatus,
        outcomeNotes: args.outcomeNotes,
        lessonsLearned: args.lessonsLearned,
        affectedComponents: args.affectedComponents,
        tags: args.tags,
        // DRIFT-FIX: metadata was ADVERTISED in decisionSchemas.record
        // but never forwarded here AND had no backing column — so it was silently
        // dropped (advertised-but-not-persisted). Migration 047 adds technical_decisions.
        // metadata (jsonb); now forward it so it actually persists + reads back.
        metadata: args.metadata,
        // THE DECISION INBOX: forward answerStatus/question/
        // options/deadline — omitted, this is byte-identical to pre-inbox decision_record.
        answerStatus: args.answerStatus,
        question: args.question,
        options: args.options,
        deadline: args.deadline,
        projectId: projectId,
        connectionId: context?.connectionId
      });

      // Auto-track decision_recorded activity in session (connection-scoped)
      await SessionTrackingMiddleware.trackDecisionRecorded(
        decision.id,
        decision.decisionType,
        decision.impactLevel,
        context?.connectionId
      );

      // AUTO-MINT TYPED EDGES (T2a Q3 — near-free, at write-time). Two sources, both
      // robust (never throw; unresolvable refs skipped so a typo can't break the record):
      //   1. threading tags on the decision (task:/decision:/context:) → typed edges.
      //   2. decision evidence/parent ids in metadata → `learned_from` edges, and any
      //      supersededBy set at record time → a `supersedes` edge (mirrors the column).
      const tagMintResult = await autoMintFromTags({
        fromId: decision.id,
        fromType: 'decision',
        tags: decision.tags,
        projectId,
        createdBy: 'auto:decision_record',
      });
      const decisionMintResult = await autoMintFromDecision({
        decisionId: decision.id,
        metadata: decision.metadata,
        supersededBy: decision.supersededBy,
        projectId,
        createdBy: 'auto:decision_record',
      });

      // FIRST-CLASS LINKS (T5a): the explicit `links` param — EXPLICIT user
      // intent, so each REJECTED link is surfaced as a WARNING in BOTH channels (text +
      // structuredContent.decision.linkWarnings) while the decision + every good link still
      // persist. mintExplicitLinks never throws (a bad link can't break the record).
      const linkResult = await mintExplicitLinks({
        fromId: decision.id,
        fromType: 'decision',
        links: args.links,
        projectId,
        createdBy: 'links:decision_record',
      });
      const linkWarningLines = DecisionsRoutes.linkWarningLines(linkResult.warnings);

      // POSITIONAL MEMBERSHIP (PHASE 1) — closes the
      // write-path hole the audit (42dca388) measured: decision_record consulted threading
      // NOT AT ALL (born orphan unless a human tagged it), with no stated reason anywhere.
      // Now: standing on a branch → declared `informs` membership edge to the spine
      // (created_by 'auto:positional'); ≥2 task ids named in the body → TRUNK record
      // (reference edge to each, membership to none); no branch open → the
      // `branch_open <id8>` offer naming this decision's own id. Never throws.
      const positionalSessionId = context?.connectionId || 'default-session';
      const positional = await mintPositional({
        recordId: decision.id,
        recordType: 'decision',
        // ONE body-composition rule for all three write paths (SK1).
        body: composePositionalBody('decision', {
          title: args.title,
          description: args.description,
          rationale: args.rationale,
          problemStatement: args.problemStatement,
        }),
        projectId,
        sessionId: positionalSessionId,
      });
      const positionalText = positionalResponseLines(positional, decision.id);
      const positionalMintedCount = positional.edges.filter((e) => e.created).length;

      // THE LEDGER — see DecisionsRoutes.edgeLedger for why a count alone
      // was not a report, and for the one source that lands in the named remainder.
      const edgesMinted = DecisionsRoutes.edgeLedger({
        tags: tagMintResult,
        links: linkResult,
        positional,
      });
      const ledgerLines = DecisionsRoutes.ledgerLines(edgesMinted);

      // PROJECT VISIBILITY: ONE line naming the RESOLVED target project
      // (name + id8), with an extra hint when it's the DEFAULT (not switched this session).
      const sessionId = context?.connectionId || 'default-session';
      const projectEcho = await buildWriteEcho(projectId, sessionId, args.projectId != null);

      return {
        content: [{
          type: 'text',
          // VALUE-CLEANING: a decision TITLE is a short DB-sourced
          // identifier rendered inline → rawValue() so stored `**` never prints literal.
          // (description/rationale/problemStatement are long-form CONTENT — left as-is.)
          text: `Technical decision recorded! "${rawValue(decision.title)}"\n` +
                `Type: ${decision.decisionType} | Impact: ${decision.impactLevel}\n` +
                `ID: ${decision.id}\n${formatRecordRef(decision.id)}` +
                (linkWarningLines.length > 0
                  ? `\nLink notes:\n` + linkWarningLines.map(w => `   • ${w}`).join('\n')
                  : '') +
                // da9b6bcd: the tag/links-param edges this write minted, in the PROSE. These
                // two paths were invisible on success — only their failures were surfaced —
                // which is exactly how a correctly-threaded decision read as an orphan.
                (ledgerLines.length > 0
                  ? `\nLinked:\n` + ledgerLines.map(l => `   • ${l}`).join('\n')
                  : '') +
                // 86d56b8c: threading tags that resolved to nothing → no edge, said out loud.
                (tagMintResult.skips.length > 0
                  ? `\nTag edges skipped:\n` +
                    tagMintResult.skips.map(s => `   • ${s.reason}`).join('\n')
                  : '') +
                // SCOPE §3.3 — WARN AND STORE. Until P5.5 this path stored tags completely
                // raw. Every tag named here IS STORED; the note says a threading prefix will
                // probably not resolve. Distinct from "Tag edges skipped" above, which
                // reports an edge that did not mint.
                ((decision.tagWarnings?.length ?? 0) > 0
                  ? `\nTag notes (nothing was rejected or dropped):\n` +
                    decision.tagWarnings!.map(w => `   • ${w}`).join('\n')
                  : '') +
                // PHASE 1 + AUTO-OPEN: positional edges, trunk note, the R1 branch-opened
                // line / R2 revert line, and the no-branch offer — rendered by the ONE
                // shared renderer all three write paths use (positionalResponseLines).
                positionalText +
                (projectEcho ? `\n${projectEcho}` : ''),
        }],
        structuredContent: {
          action: 'created',
          // ONE SERIALIZER: the record is `serializeDecision`'s output; the
          // write report rides `extras`.
          decision: serializeDecision(decision, {
            extras: {
              // SCOPE §3.3: the normalization report. Always an array, never absent.
              tagWarnings: decision.tagWarnings ?? [],
              // T5a: structured per-link rejections.
              linkWarnings: linkResult.warnings,
              // UNDER-REPORT FIX (step 6): the TOTAL across all mint sources,
              // with the per-source breakdown alongside so nothing is aggregated away.
              linksMinted:
                linkResult.minted + tagMintResult.minted + decisionMintResult.minted + positionalMintedCount,
              // LEDGER: one row per edge minted-or-deduped. Always an array.
              edgesMinted,
              mintedBySource: {
                links: linkResult.minted,
                tags: tagMintResult.minted,
                decision: decisionMintResult.minted,
                // PHASE 1: NEW positional edges (membership / refs).
                positional: positionalMintedCount,
              },
              tagEdgeSkips: tagMintResult.skips,
              // PHASE 1: the positional layer's full report (same shape context_store carries).
              positional: serializePositionalReport(positional),
            },
          }),
        },
      };
    } catch (error) {
      // THE DECISION INBOX: carry the structured code + field
      // name on `structuredContent`, mirroring how task_create surfaces PunchIncompleteError.
      if (error instanceof DecisionOpenValidationError) {
        const resp = formatMcpError(error, 'decision_record');
        resp.structuredContent = { ok: false, code: error.code, field: error.field };
        return resp;
      }
      return formatMcpError(error as Error, 'decision_record');
    }
  }

  /**
   * Render the learning-loop OUTCOME fields as human-readable text lines.
   *
   * This is the part-2 fix made reusable: the outcome fields (outcome_status, outcome
   * notes, lessons learned, implementation status) must appear in the PROSE a tool-only
   * agent reads — they previously lived only in the structured `data` sibling, leaving
   * a text-reading agent blind to them (blocking the GAP1 Evaluator). Used by both
   * decision_search results and decision_get.
   *
   * `outcome_status` is ALWAYS shown (it's the moat field; even 'unknown' is signal).
   * Notes / lessons render only when present. `indent` prefixes each line so this can
   * nest inside a numbered search result or sit flush in a single-decision view.
   */
  static renderOutcomeText(
    decision: {
      outcomeStatus?: string | null;
      outcomeNotes?: string | null;
      lessonsLearned?: string | null;
      implementationStatus?: string | null;
    },
    indent = ''
  ): string {
    const lines: string[] = [];
    lines.push(`${indent}Outcome: ${decision.outcomeStatus || 'unknown'}`);
    if (decision.implementationStatus) {
      lines.push(`${indent}Implementation: ${decision.implementationStatus}`);
    }
    if (decision.outcomeNotes) {
      lines.push(`${indent}Outcome Notes: ${decision.outcomeNotes}`);
    }
    if (decision.lessonsLearned) {
      lines.push(`${indent}Lessons Learned: ${decision.lessonsLearned}`);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * TRUST (T2b — THE MOAT): the one-line human hint for a decision row. Same SINGLE
   * explainTrust() renderer as every other surface — only the leading
   * indent (this line nests under a numbered search result) belongs to this route.
   */
  static trustHint(trust: Trust): string {
    // WS1 (D2): the machine-lean signal (band/score + supersession flag),
    // not the prose `.line`. The WHY prose is not shipped at all — it USED to ride
    // structuredContent.trust, which stopped being true when trust on the wire became
    // {band, score}.
    return `   ${explainTrust(trust).signal}`;
  }

  /**
   * Handle decision search requests
   */
  async handleSearch(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // FAIL LOUD on a reserved arg-name prefix typed into `query` (an earlier task — the
      // SWEEP half). decision_search shares context_search's degradation: the id-prefix arm
      // (buildSearchMatchPredicate, handlers/decisions.ts) never fires on `id:<uuid>` because
      // the `:` fails the hex gate, so the call silently becomes semantic noise. Same shared
      // predicate, same config — but this tool has NO `id` parameter, so its remedy is the
      // BARE token, not "use the id parameter" (see config/searchConfig.ts).
      const reservedPrefix = reservedArgPrefixInQuery(args.query, 'decision_search');
      if (reservedPrefix) {
        logger.info(`🚫 Decision search rejected reserved-prefix query: "${args.query}"`);
        return {
          content: [{
            type: 'text',
            text: reservedArgPrefixMessage(reservedPrefix, args.query, 'decision_search'),
          }],
          isError: true,
          structuredContent: {
            ok: false,
            error: 'reserved_query_prefix',
            reservedArg: reservedPrefix,
            query: args.query,
          },
        };
      }

      const projectId = await this.resolveProjectId(args.projectId, context);
      logger.info(`🔍 Decision search request (project: ${projectId?.substring(0, 8)}...)`);

      // ONE request object drives BOTH the page (searchDecisions) and the real total
      // (countDecisions) so `total` is computed over the EXACT same filter set as the
      // page — never the page size.
      const searchRequest = {
        query: args.query,
        decisionType: args.decisionType,
        // A6: forward `status` (the handler filters on it — decisions.ts) and
        // `includeOutcome` (advertised in the zod schema); both were previously
        // dropped at the route, so a status-filtered search silently ignored the filter.
        status: args.status,
        // outcomeStatus filters the learning-loop RESULT column (outcome_status) — a
        // SEPARATE column from `status`. Forwarding it here closes the route-drop class
        // (declared in zod, accepted, AND forwarded to the handler that filters on it).
        outcomeStatus: args.outcomeStatus,
        // implementationStatus filters the BUILD column (implementation_status) — the THIRD
        // status column, distinct from `status` and `outcomeStatus`. Declared in zod, forwarded
        // HERE, and filtered in the shared builder: the same declared==forwarded==filtered
        // contract the A6 fix above established, because a param declared and silently dropped
        // at the route is the exact defect this route already carries two scars from
        //.
        implementationStatus: args.implementationStatus,
        // THE DECISION INBOX filter: open | discussing | decided.
        // "decision list --status open" and REST GET /api/decisions?answerStatus=open both
        // land here — a FOURTH status column, forwarded exactly like the three above it.
        answerStatus: args.answerStatus,
        impactLevel: args.impactLevel,
        component: args.component,
        tags: args.tags,
        limit: args.limit,
        // REAL PAGINATION: forward the window start + the sort direction.
        offset: args.offset,
        sortDirection: args.sortDirection,
        includeOutcome: args.includeOutcome,
        // SOFT-DELETE: forward includeArchived (default exclude archived).
        includeArchived: args.includeArchived,
        projectId: projectId
      };

      const decisions = await decisionsHandler.searchDecisions(searchRequest);

      // REAL PAGINATION. The output schema has ALWAYS declared `offset`,
      // `hasMore` and `returned`, and this route has NEVER returned any of them — it emitted
      // `page: 1` as a literal, so a caller reading the advertised contract was told
      // pagination existed, given a hardcoded page number, and had no way to learn that 900
      // more rows matched. The counters below are computed from the SAME normalizeOffset() the
      // SQL's OFFSET uses (one definition — a route that clamped differently from the query
      // would report a window the query never returned) and the SAME countDecisions() `total`,
      // over the SAME filter set.
      //
      // COMPUTED BEFORE the early-empty return on purpose: an empty PAGE is the single most
      // informative place for these counters (offset past the end), and it was previously the
      // one branch that hardcoded `total: 0` even when the filter matched thousands.
      const offset = normalizeOffset(args.offset);
      const total = await decisionsHandler.countDecisions(searchRequest);
      const returned = decisions.length;
      const hasMore = offset + returned < total;
      const effectiveLimit = args.limit || 20;
      // `page` is DERIVED from the window, not the literal 1 this route used to emit.
      const page = Math.floor(offset / effectiveLimit) + 1;
      const pagination = { total, page, limit: effectiveLimit, returned, offset, hasMore };

      if (decisions.length === 0) {
        return {
          content: [{
            type: 'text',
            // An empty page inside a non-empty match set is a DIFFERENT situation from "no
            // matches", and telling a caller to broaden a filter that already matches 900 rows
            // sends them the wrong way entirely.
            text: total > 0
              ? `No decisions in this window (offset ${offset}), but ${total} match this filter.\n\n` +
                `Lower the offset (or omit it) to see them.`
              : `No decisions found matching your criteria\n\n` +
                `Try:\n` +
                `- Broader search terms\n` +
                `- Different decision types or impact levels\n` +
                `- Removing some filters`
          }],
          data: { results: [], ...pagination }
        };
      }

      // A PARTIAL WINDOW MUST SAY SO IN THE PROSE, not only in `data`. A
      // tool-only agent reads the text; a bare `🔍 Found 100 technical decisions` on a 900-row
      // match set is how a capped page masquerades as the whole class — the same failure
      // `total` was added to fix, one channel over.
      //
      // LINE 1 reports the GRAND TOTAL rather than the page length. (STALE-COMMENT FIX,
      // WS1 this block used to claim mandrel-command's mcp.ts scrapes this
      // prose with /Found (\d+) technical decisions?:/ — that text-parse fallback was
      // DELETED in verified 2026-08-14 by grepping mandrel-command/backend
      // for the pattern: zero hits. No consumer parses this line any more; `data` is the
      // machine channel.)
      const windowLine = returned < total
        ? `Showing ${offset + 1}-${offset + returned}` +
          `${hasMore ? ` — ${total - (offset + returned)} more match: decision_search(offset=${offset + returned}, limit=${effectiveLimit})` : ''}\n`
        : '';
      const searchSummary = `Found ${total} technical decisions:\n${windowLine}\n`;

      // TRUST (T2b — default-on): computed per returned decision, AFTER the existing
      // ranking (semantic / newest-first). Each decision folds in its OWN outcome_status
      // (direct loop ground-truth) plus any downstream-inherited outcomes via edges, and
      // honors its own superseded_by column. Display-only; order unchanged.
      const decisionRefs: RecordRef[] = decisions.map((d) => ({
        id: d.id,
        type: 'decision',
        createdAt: d.decisionDate,
        supersededBy: d.supersededBy,
        ownOutcomeStatus: d.outcomeStatus,
      }));
      const decisionTrusts = await trustForRecords(decisionRefs);

      const resultDetails = decisions.map((decision, index) => {
        const alternatives = decision.alternativesConsidered.length > 0
          ? ` (${decision.alternativesConsidered.length} alternatives considered)`
          : '';

        // WS1 (D2): plain terse rows — emoji field markers, bold markup,
        // and the per-row permalink line dropped (the structured channel's url carries it).
        return `${index + 1}. ${decision.decisionType.toUpperCase()} - ${decision.impactLevel} impact\n` +
               `   Title: ${rawValue(decision.title)}\n` +
               `   Rationale: ${decision.rationale.substring(0, 100)}${decision.rationale.length > 100 ? '...' : ''}\n` +
               `   Date: ${decision.decisionDate.toISOString().split('T')[0]} | Status: ${decision.status}${alternatives}\n` +
               // LEARNING-LOOP READ (part 2): render the outcome fields INTO the human-
               // readable text, not just the structured `data` sibling. A tool-only agent
               // reads the prose, so without this it is blind to outcome_status / lessons —
               // exactly what blocks the GAP1 Evaluator. Indented so it reads as a sub-block.
               DecisionsRoutes.renderOutcomeText(decision, '   ') +
               DecisionsRoutes.trustHint(decisionTrusts[index]) + '\n' +
               `   Tags: [${decision.tags.join(', ')}]\n` +
               `   ID: ${decision.id}`;
      }).join('\n\n');

      // Map decisions to structured format with proper field names for frontend
      // ONE SERIALIZER. This route shipped snake_case aliases and NAME-only
      // `alternatives` for its frontend consumer; both are produced by the serializer under
      // `legacyAliases` so the spelling table lives in one place. Trust is the list shape.
      const structuredDecisions = decisions.map((decision, index) =>
        serializeDecision(decision, {
          legacyAliases: true,
          alternativesAs: 'names',
          trust: projectTrust(decisionTrusts[index]),
        })
      );

      // `total` + the full pagination counters were both
      // computed ABOVE, before the empty-page branch, from countDecisions() over the SAME
      // shared filter builder — so they can never drift from the page.
      return {
        content: [{
          type: 'text',
          text: searchSummary + resultDetails
        }],
        data: {
          results: structuredDecisions,
          ...pagination
        }
      };
    } catch (error) {
      return formatMcpError(error as Error, 'decision_search');
    }
  }

  /**
   * Handle decision GET (single-decision direct lookup by id).
   *
   * The moat-critical READ path: fetch ONE decision with FULL detail — every field,
   * including the learning-loop outcome fields — by its id, bypassing semantic search.
   * Mirrors context_search's `id` direct-lookup idiom. Full UUID is the floor (the zod
   * schema enforces .uuid()). Returns an ACTIONABLE not-found error (what went wrong +
   * that the id may be wrong or a short id) when no row matches, so a tool-only caller
   * isn't left guessing.
   */
  async handleGet(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // Resolve the connection's project for context (informational + reference for the
      // route-drift guard: args.projectId is forwarded, not silently dropped).
      const projectId = await this.resolveProjectId(args.projectId, context);
      logger.info(
        `Decision get request: ${String(args.decisionId).substring(0, 8)}... ` +
        `(project ctx: ${projectId?.substring(0, 8) ?? 'none'})`
      );

      // SHORT-ID RESOLUTION: accept a full UUID or an 8+-hex short id.
      // A full UUID resolves cross-project (back-compat: a valid id always resolves
      // regardless of the caller's current project). A SHORT id is resolved with a
      // parameterized prefix match SCOPED to the current project (when one is set) so a
      // prefix can't collide across projects; ambiguous / unknown short ids surface as
      // actionable errors below.
      let resolvedId: string;
      try {
        resolvedId = isFullUuid(args.decisionId)
          ? args.decisionId
          : await resolveEntityId('decision', args.decisionId, projectId);
      } catch (e) {
        if (e instanceof AmbiguousIdError) {
          return {
            content: [{ type: 'text', text: ambiguousIdMessage(e, 'decision_get') }],
            data: { found: false, ambiguous: true,
              candidates: e.candidates.map(c => c.id), decisionId: args.decisionId }
          };
        }
        if (e instanceof IdNotFoundError) {
          return {
            content: [{
              type: 'text',
              text: `Decision not found: ${args.decisionId}\n\n` +
                    `The id may be wrong (a mistyped short id, or a stale full UUID).\n` +
                    `   Use decision_search to find the decision and copy its ID.`
            }],
            data: { found: false, decisionId: args.decisionId }
          };
        }
        throw e;
      }

      // Look up by id alone (no project scope) so a valid id always resolves regardless
      // of the caller's current project — keeps the tool usable cross-project.
      const decision = await decisionsHandler.getDecisionById(resolvedId);

      if (!decision) {
        return {
          content: [{
            type: 'text',
            text: `Decision not found: ${args.decisionId}\n\n` +
                  `The id may be wrong (a mistyped short id, or a stale full UUID).\n` +
                  `   Use decision_search to find the decision and copy its ID.`
          }],
          data: { found: false, decisionId: args.decisionId }
        };
      }

      const alternativesText = decision.alternativesConsidered.length > 0
        ? `\nAlternatives Considered:\n` +
          decision.alternativesConsidered.map(alt =>
            // alt.name is a short identifier → clean; reasonRejected is prose → leave.
            `   • ${rawValue(alt.name)}: ${alt.reasonRejected}`
          ).join('\n')
        : '';

      // WS1 (D2): machine-lean detail block — no banner/emoji, no permalink
      // line (the structured channel's url carries it).
      const text =
        `ID: ${decision.id}\n` +
        `Type: ${decision.decisionType}\n` +
        // Title = short DB identifier → rawValue(). Description/Rationale/Problem/
        // SuccessCriteria below are long-form CONTENT (may legitimately be markdown)
        // → intentionally NOT stripped (clean values, not content).
        `Title: ${rawValue(decision.title)}\n` +
        `Impact: ${decision.impactLevel}\n` +
        `Date: ${decision.decisionDate.toISOString().split('T')[0]} | Status: ${decision.status}\n` +
        `Description: ${decision.description}\n` +
        `Rationale: ${decision.rationale}\n` +
        (decision.problemStatement ? `Problem: ${decision.problemStatement}\n` : '') +
        (decision.successCriteria ? `Success Criteria: ${decision.successCriteria}\n` : '') +
        // Learning-loop outcome block (part 2) — rendered in the prose, not data-only.
        DecisionsRoutes.renderOutcomeText(decision) +
        `Components: [${decision.affectedComponents.join(', ')}]\n` +
        `Tags: [${decision.tags.join(', ')}]` +
        alternativesText;

      return {
        content: [{ type: 'text', text }],
        data: {
          found: true,
          // ONE SERIALIZER: the FULL record (the moat-critical by-id read),
          // with the snake_case aliases this route has always carried and object-form
          // `alternatives`. metadata round-trips.
          decision: serializeDecision(decision, { legacyAliases: true, alternativesAs: 'objects' })
        }
      };
    } catch (error) {
      return formatMcpError(error as Error, 'decision_get');
    }
  }

  /**
   * Handle decision update requests
   */
  async handleUpdate(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      logger.info(`📝 Decision update request: ${args.decisionId.substring(0, 8)}...`);

      // SHORT-ID RESOLUTION: resolve a full UUID or 8+-hex short id →
      // full UUID BEFORE we mutate. A short id is resolved with a parameterized prefix
      // match scoped to the current project (when set). Ambiguous / unknown ids surface
      // as actionable errors and DO NOT mutate (resolution throws before the UPDATE).
      const projectId = await this.resolveProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = isFullUuid(args.decisionId)
          ? args.decisionId
          : await resolveEntityId('decision', args.decisionId, projectId);
      } catch (e) {
        if (e instanceof AmbiguousIdError) {
          return {
            content: [{ type: 'text', text: ambiguousIdMessage(e, 'decision_update') }],
            isError: true,
            structuredContent: { ok: false, ambiguous: true,
              candidates: e.candidates.map(c => c.id) },
          };
        }
        if (e instanceof IdNotFoundError) {
          return {
            content: [{
              type: 'text',
              text: `Decision not found: ${args.decisionId}\n\n` +
                    `The id may be wrong. Use decision_search to find the decision and copy its ID.`
            }],
            isError: true,
            structuredContent: { ok: false, found: false },
          };
        }
        throw e;
      }

      // CONTRACT SYMMETRY (follow-up to 1cca7644): supersededBy accepts a
      // full UUID OR an id8 short id, exactly like decisionId above — same shared resolver,
      // same project scoping, same actionable errors. Resolution happens BEFORE the UPDATE
      // so the `superseded_by` uuid column never sees a raw short id (which would leak a
      // Postgres cast error), and an ambiguous/unknown id DOES NOT mutate.
      let resolvedSupersededBy: string | undefined = args.supersededBy;
      if (args.supersededBy !== undefined && !isFullUuid(args.supersededBy)) {
        try {
          resolvedSupersededBy = await resolveEntityId('decision', args.supersededBy, projectId);
        } catch (e) {
          if (e instanceof AmbiguousIdError) {
            return {
              content: [{ type: 'text', text: ambiguousIdMessage(e, 'decision_update') }],
              isError: true,
              structuredContent: { ok: false, ambiguous: true,
                candidates: e.candidates.map(c => c.id) },
            };
          }
          if (e instanceof IdNotFoundError) {
            return {
              content: [{
                type: 'text',
                text: `supersededBy decision not found: ${args.supersededBy}\n\n` +
                      `The id may be wrong. Use decision_search to find the superseding ` +
                      `decision and copy its ID. Nothing was updated.`
              }],
              isError: true,
              structuredContent: { ok: false, found: false },
            };
          }
          throw e;
        }
      }

      const decision = await decisionsHandler.updateDecision({
        decisionId: resolvedId,
        status: args.status,
        outcomeStatus: args.outcomeStatus,
        outcomeNotes: args.outcomeNotes,
        lessonsLearned: args.lessonsLearned,
        implementationStatus: args.implementationStatus,
        successCriteria: args.successCriteria,
        problemStatement: args.problemStatement,
        supersededBy: resolvedSupersededBy,
        supersededReason: args.supersededReason,
        // CURATE (T1 item 5): edit title/description/tags. T1 item 6: metadata is MERGED
        // in the handler (null deletes a key). Forwarded raw — decision tags are not
        // threading-normalized on record either, so we keep that behavior on update.
        title: args.title,
        description: args.description,
        tags: args.tags,
        metadata: args.metadata,
        // THE DECISION INBOX: setting answerStatus='open' is
        // validated against the MERGED row in the handler; omitted, byte-identical to today.
        answerStatus: args.answerStatus,
        question: args.question,
        options: args.options,
        deadline: args.deadline,
      });

      // AUTO-MINT (T2a): supersession set on UPDATE mirrors a `supersedes` edge (the
      // common path — decision_update is how a decision gets retired). Also re-mint any
      // threading-tag edges if tags were edited. Robust: never throws (write already done).
      const updateProjectId = await this.resolveProjectId(args.projectId, context);
      // UNDER-REPORT FIX: BOTH of these results used to be DISCARDED — the
      // calls were bare `await`s and the response carried no edge field of any kind. So
      // retiring a decision via `supersededBy` minted the single most decision-relevant edge
      // in the product and the tool that minted it said nothing at all. Same disease as
      // 8fc68175 on the context side, in its most severe degree: not an under-count, a total
      // silence. Capture them; report them below exactly as decision_record does.
      const updateDecisionMint = await autoMintFromDecision({
        decisionId: decision.id,
        metadata: args.metadata,
        // The RESOLVED id — keeps the minted `supersedes` edge endpoint
        // identical to what the superseded_by column now holds.
        supersededBy: resolvedSupersededBy,
        projectId: updateProjectId,
        createdBy: 'auto:decision_update',
      });
      const updateTagMint =
        args.tags !== undefined
          ? await autoMintFromTags({
              fromId: decision.id,
              fromType: 'decision',
              tags: decision.tags,
              projectId: updateProjectId,
              createdBy: 'auto:decision_update',
            })
          : { minted: 0, attempted: 0, skips: [], edges: [] };

      // The ledger + total, built by the SAME helper decision_record uses so the two write
      // paths cannot report differently. decision_update has no `links` param and mints no
      // positional membership (it edits an existing record; it does not create one), so
      // `tags` is the only itemizable source here.
      const updateEdgesMinted = DecisionsRoutes.edgeLedger({ tags: updateTagMint });
      const updateLinksMinted = updateTagMint.minted + updateDecisionMint.minted;
      const updateLedgerLines = DecisionsRoutes.ledgerLines(updateEdgesMinted);

      return {
        content: [{
          type: 'text',
          text: `Decision updated successfully! "${rawValue(decision.title)}"\n` +
                `Status: ${decision.status} | Implementation: ${decision.implementationStatus}\n` +
                `Outcome: ${decision.outcomeStatus}` +
                // An invisible mint is one nobody can notice going wrong. The count is
                // printed whenever this update touched the graph; the itemized rows follow
                // for the source that can produce them.
                (updateLinksMinted > 0 ? `\nEdges minted: ${updateLinksMinted}` : '') +
                (updateLedgerLines.length > 0
                  ? `\nLinked:\n` + updateLedgerLines.map(l => `   • ${l}`).join('\n')
                  : '') +
                (updateTagMint.skips.length > 0
                  ? `\nTag edges skipped:\n` +
                    updateTagMint.skips.map(s => `   • ${s.reason}`).join('\n')
                  : ''),
        }],
        structuredContent: {
          action: 'updated',
          // ONE SERIALIZER: the whole edited record; the EDGE REPORT
          // rides `extras` in the same shape decision_record returns —
          // `mintedBySource.links`/`.positional` are structurally 0 here and emitted anyway.
          decision: serializeDecision(decision, {
            extras: {
              linksMinted: updateLinksMinted,
              edgesMinted: updateEdgesMinted,
              mintedBySource: {
                links: 0,
                tags: updateTagMint.minted,
                decision: updateDecisionMint.minted,
                positional: 0,
              },
              tagEdgeSkips: updateTagMint.skips,
            },
          }),
        },
      };
    } catch (error) {
      if (error instanceof DecisionOpenValidationError) {
        const resp = formatMcpError(error, 'decision_update');
        resp.structuredContent = { ok: false, code: error.code, field: error.field };
        return resp;
      }
      return formatMcpError(error as Error, 'decision_update');
    }
  }

  /**
   * decision_answer: pick an option on an open/discussing
   * decision. Short-id resolution mirrors handleUpdate (full UUID or 8+-hex, project-scoped
   * when a project is known); an unknown/ambiguous id refuses with the same actionable
   * errors and mutates nothing. `answeredBy` is the derived actor (X-Actor-ID) — never a
   * caller-supplied string, so it can't be spoofed by a request body field.
   */
  async handleAnswer(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // Project resolution is needed ONLY to scope a SHORT id — a full UUID resolves
      // cross-project (same contract as handleGet). Deferred behind the isFullUuid check
      // so a full-UUID caller (e.g. the REST /api/decisions/:id/answer endpoint, which has
      // no ambient connection/session to resolve a project from) never pays the ambient
      // project ladder for a lookup it doesn't need.
      let resolvedId: string;
      try {
        resolvedId = isFullUuid(args.decisionId)
          ? args.decisionId
          : await resolveEntityId('decision', args.decisionId, await this.resolveProjectId(args.projectId, context));
      } catch (e) {
        const handled = idErrorResponse(e, 'decision_answer', 'decision', args.decisionId, 'decision_search');
        if (handled) return handled;
        throw e;
      }

      const decision = await decisionsHandler.answerDecision(
        resolvedId, args.option, args.note, context?.actor,
      );

      const alternativesText = decision.alternativesConsidered.length > 0
        ? `\nNon-chosen options folded into alternatives_considered:\n` +
          decision.alternativesConsidered.map(alt => `   • ${rawValue(alt.name)}`).join('\n')
        : '';

      return {
        content: [{
          type: 'text',
          text: `Decision answered: "${rawValue(decision.title)}"\n` +
                `Chosen: ${decision.chosen}\n` +
                `Answer status: ${decision.answerStatus}` +
                alternativesText,
        }],
        structuredContent: {
          action: 'answered',
          decision: serializeDecision(decision),
        },
      };
    } catch (error) {
      if (error instanceof DecisionInboxActionError) {
        const resp = formatMcpError(error, 'decision_answer');
        resp.structuredContent = { ok: false, code: error.code };
        return resp;
      }
      return formatMcpError(error as Error, 'decision_answer');
    }
  }

  /**
   * decision_discuss: the escape hatch — kick an open decision
   * back to the coordinator with a reference instead of answering it. Same short-id resolution as
   * handleAnswer/handleUpdate.
   */
  async handleDiscuss(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // See handleAnswer's comment: project resolution deferred behind the isFullUuid check.
      let resolvedId: string;
      try {
        resolvedId = isFullUuid(args.decisionId)
          ? args.decisionId
          : await resolveEntityId('decision', args.decisionId, await this.resolveProjectId(args.projectId, context));
      } catch (e) {
        const handled = idErrorResponse(e, 'decision_discuss', 'decision', args.decisionId, 'decision_search');
        if (handled) return handled;
        throw e;
      }

      const decision = await decisionsHandler.discussDecision(resolvedId, args.note);

      return {
        content: [{
          type: 'text',
          text: `Decision "${rawValue(decision.title)}" sent back for discussion.\n` +
                `ID: ${decision.id}\n${formatRecordRef(decision.id)}`,
        }],
        structuredContent: {
          action: 'discussed',
          decision: serializeDecision(decision),
        },
      };
    } catch (error) {
      if (error instanceof DecisionInboxActionError) {
        const resp = formatMcpError(error, 'decision_discuss');
        resp.structuredContent = { ok: false, code: error.code };
        return resp;
      }
      return formatMcpError(error as Error, 'decision_discuss');
    }
  }

  /**
   * Handle decision stats requests
   */
  async handleStats(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      // SOFT-DELETE: archived rows are EXCLUDED by default so these counts
      // reconcile with decision_search. Same param name + meaning as decision_search.
      const includeArchived = args.includeArchived === true;
      logger.info(`📊 Decision stats request received (project: ${projectId?.substring(0, 8)}..., includeArchived: ${includeArchived})`);

      const stats = await decisionsHandler.getDecisionStats(projectId, includeArchived);

      const typeBreakdown = Object.entries(stats.decisionsByType)
        .map(([type, count]) => `   ${type}: ${count}`)
        .join('\n');

      const statusBreakdown = Object.entries(stats.decisionsByStatus)
        .map(([status, count]) => `   ${status}: ${count}`)
        .join('\n');

      const impactBreakdown = Object.entries(stats.decisionsByImpact)
        .map(([impact, count]) => `   ${impact}: ${count}`)
        .join('\n');

      // BUILD-LIFECYCLE breakdown — rendered with the SAME
      // `Object.entries(...) → "   key: count"` shape as the three breakdowns above, not a new
      // response shape. This is the aggregate view that did not exist: nothing read
      // implementation_status anywhere, so a project could carry dozens of decisions stuck at
      // `planned` and no surface would ever say so.
      const implementationBreakdown = Object.entries(stats.decisionsByImplementationStatus)
        .map(([implStatus, count]) => `   ${implStatus}: ${count}`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `Technical Decision Statistics\n\n` +
                (includeArchived
                  ? `Population: ALL decisions, INCLUDING archived (includeArchived: true)\n`
                  : `Population: live decisions (archived excluded — matches decision_search)\n`) +
                `Total Decisions: ${stats.totalDecisions}\n` +
                `Success Rate: ${stats.outcomeSuccess}%\n` +
                `Recent Activity: ${stats.recentActivity}\n` +
                `Projects with Decisions: ${stats.totalProjects}\n\n` +
                `By Type:\n${typeBreakdown || '   (no decisions yet)'}\n\n` +
                `By Status:\n${statusBreakdown || '   (no decisions yet)'}\n\n` +
                `By Impact:\n${impactBreakdown || '   (no decisions yet)'}\n\n` +
                `By Implementation Status:\n${implementationBreakdown || '   (no decisions yet)'}`
        }],
        // Structured data for frontend consumption (snake_case format)
        data: {
          total_decisions: stats.totalDecisions,
          recent_decisions: stats.recentActivity,
          total_projects: stats.totalProjects,
          by_status: stats.decisionsByStatus,
          by_type: stats.decisionsByType,
          by_impact: stats.decisionsByImpact,
          // an earlier task — snake_case sibling of by_status/by_impact, same map shape. These
          // counts SUM to total_decisions (no value is filtered out).
          by_implementation_status: stats.decisionsByImplementationStatus,
          by_project: stats.decisionsByProject,
          outcome_success_rate: stats.outcomeSuccess,
          // an earlier task — say which population these numbers describe. The 4.4x split
          // that motivated this fix was unreadable precisely because neither surface
          // declared whether archived rows were in or out.
          include_archived: includeArchived
        }
      };
    } catch (error) {
      return formatMcpError(error as Error, 'decision_stats');
    }
  }

  /**
   * Resolve the project id, REQUIRING one (delete/restore are project-scoped — we must
   * never archive across projects). Throws an actionable error if no project is active.
   */
  private async requireProjectId(argsProjectId: string | undefined, context?: RouteContext): Promise<string> {
    const projectId = await this.resolveProjectId(argsProjectId, context);
    if (!projectId) {
      throw new Error('No current project set. Use project_switch to set an active project (or pass projectId).');
    }
    return projectId;
  }

  /**
   * Handle decision SOFT-DELETE (archive) requests — decision_delete.
   *
   * Sets archived_at so the decision disappears from the DEFAULT decision_search while
   * STILL EXISTING in the DB (reversible via decision_restore). Accepts a full UUID or
   * 8+-hex short id, resolved project-scoped BEFORE the mutation; ambiguous / unknown
   * ids surface as actionable errors and mutate nothing. Idempotent.
   */
  async handleDelete(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.requireProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = isFullUuid(args.decisionId)
          ? args.decisionId
          : await resolveEntityId('decision', args.decisionId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'decision_delete', 'decision', args.decisionId, 'decision_search');
        if (handled) return handled;
        throw e;
      }

      const result = await decisionsHandler.archiveDecision(resolvedId, projectId);
      if (!result.found) {
        return {
          content: [{ type: 'text',
            text: `Decision not found: ${args.decisionId}\n\n` +
                  `Use decision_search to find the decision and copy its ID.` }],
          isError: true,
          structuredContent: { ok: false, found: false },
        };
      }
      const verb = result.alreadyArchived ? 'was already archived' : 'archived';
      return {
        content: [{ type: 'text',
          text: `Decision ${verb} (soft-delete) — ${result.id}\n` +
                `Hidden from decision_search but NOT deleted. Restore with: decision_restore(decisionId="${result.id}")` }],
        structuredContent: {
          action: 'archived',
          // ONE SERIALIZER: the archived record itself (archivedAt rides it).
          decision: serializeDecision((await decisionsHandler.getDecisionById(resolvedId))!),
          alreadyArchived: result.alreadyArchived === true,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'decision_delete');
    }
  }

  /**
   * Handle decision RESTORE (un-archive) requests — decision_restore.
   * Clears archived_at so the decision returns to default search. Mirror of handleDelete.
   */
  async handleRestore(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.requireProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = isFullUuid(args.decisionId)
          ? args.decisionId
          : await resolveEntityId('decision', args.decisionId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'decision_restore', 'decision', args.decisionId, 'decision_search');
        if (handled) return handled;
        throw e;
      }

      const result = await decisionsHandler.restoreDecision(resolvedId, projectId);
      if (!result.found) {
        return {
          content: [{ type: 'text',
            text: `Decision not found: ${args.decisionId}\n\n` +
                  `Use decision_search(includeArchived:true) to see archived decisions and copy an ID.` }],
          isError: true,
          structuredContent: { ok: false, found: false },
        };
      }
      const verb = result.alreadyArchived ? 'was already live (not archived)' : 'restored';
      return {
        content: [{ type: 'text',
          text: `Decision ${verb} — ${result.id}` }],
        structuredContent: {
          action: 'restored',
          decision: serializeDecision((await decisionsHandler.getDecisionById(resolvedId))!),
          alreadyArchived: result.alreadyArchived === true,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'decision_restore');
    }
  }
}

export const decisionsRoutes = new DecisionsRoutes();
