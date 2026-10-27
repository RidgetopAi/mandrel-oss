import { smartSearchHandler, type SmartSearchResult } from '../handlers/smartSearch.js';
import { runTagCensus } from '../services/tagCensus.js';
import { db } from '../config/database.js';
import { buildHonestyHeader } from '../handlers/context.js';
import { vetoMessage } from '../services/absentTermVeto.js';
import { recordUrl, isResolvableRecordType } from '../config/commandUrlConfig.js';
import { projectHandler } from '../handlers/project.js';
import { formatMcpError, rawValue } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { trustForRecords, explainTrust, type RecordRef, type Trust } from '../services/trust.js';
import { reservedArgPrefixInQuery, reservedArgPrefixMessage } from '../utils/idResolver.js';
import { logger } from '../utils/logger.js';
import { HEALTH_LEVEL_NO_DATA } from '../config/insightsConfig.js';
import { COVERAGE_CONFIG } from '../config/coverageConfig.js';
import { SMART_SEARCH_DEFAULT_SOURCES } from '../config/searchMergeConfig.js';
import {
  SMART_SEARCH_CLIP_AFFORDANCE,
  SMART_SEARCH_DEFAULT_ALTITUDE,
  SMART_SEARCH_SNIPPET_MAXLEN,
  resolveAltitude,
} from '../config/altitudeConfig.js';

import { projectBody, projectTrust, type SnippetBudget } from '../services/altitudeProjection.js';
import type {
  CoverageRatio,
  CoverageRatios,
  ProjectCoverage,
} from '../services/projectCoverageCore.js';

/** How each coverage dimension is LABELLED in the human channel. One label per key of
 *  CoverageRatios, so a new dimension is a compile error here rather than a silent omission
 *  from the rendered answer (prefer the compiler to a test). */
const COVERAGE_DIMENSION_LABELS: Record<keyof CoverageRatios, string> = {
  activeTaskGrounding: 'Active tasks grounded in a plan/decision/outcome',
  completedTaskEvidence: 'Landed tasks backed by separate accepted evidence',
  branchConvergence: 'Records connected to the graph (branches that converge)',
  sessionAttribution: 'Records with session attribution',
  historicalTrust: 'Historical records that clear the trust floor',
};

/** Severity → the marker the text channel prints (WS1 plain words, no emoji). */
const COVERAGE_SEVERITY_MARK: Record<'attention' | 'note', string> = {
  attention: 'ATTENTION:',
  note: 'note:',
};

/** One ratio line: `covered/of (pct)`, or an explicit "nothing to measure" for an empty
 *  population. An absent denominator is NEVER printed as 100% — that is the "absent rendered
 *  as perfect" class an earlier task closed, and it would be just as much a fabrication here. */
function renderRatio(label: string, r: CoverageRatio): string {
  if (r.ratio === null) {
    return `   - ${label}: — (nothing to measure)`;
  }
  const mark = r.belowFloor ? 'BELOW FLOOR —' : '-';
  return `   ${mark} ${label}: ${Math.round(r.ratio * 100)}% (${r.covered}/${r.of})`;
}

/**
 * THE SINGLE COVERAGE RENDERER. Both project_insights channels are built
 * from this one function + the structuredContent block that carries the same objects, so the
 * human text and the machine payload cannot report different coverage.
 *
 * Renders three things and nothing else: WHERE THE PROJECT STANDS (part B's gate + next
 * action, never re-derived here), the coverage ratios, and the findings. It never advises
 * recording MORE of anything on the basis of how many records exist.
 */
function renderCoverage(coverage: ProjectCoverage): string {
  const { ratios, findings, scope, currentState, provenance } = coverage;

  // EDGE PROVENANCE: the declared/guessed split renders WHEREVER the
  // coverage number renders — a coverage figure without it read 97-98% for 15 days over a
  // dead declared-minting mechanism (graph an earlier audit), because a guess-edge and a
  // declared-edge count identically. Empty populations say so; they are never omitted and
  // never rendered as a percentage of nothing.
  const provenanceLine =
    provenance.total === 0
      ? '   - Edge provenance: — (no edges examined)'
      : `   - Edge provenance: ${provenance.declared} declared / ${provenance.guessed} guessed` +
        (provenance.unclassified > 0 ? ` / ${provenance.unclassified} UNCLASSIFIED` : '') +
        ` — declared share ${Math.round((provenance.declaredRatio ?? 0) * 100)}%`;

  const scopeNote = scope.truncated
    ? ` (most recent ${scope.recordsExamined} of ${scope.recordsInProject} records; ` +
      `raise MANDREL_INSIGHTS_MAX_NODES to widen)`
    : ` (all ${scope.recordsExamined} records)`;

  const dimensionLines = (Object.keys(COVERAGE_DIMENSION_LABELS) as Array<keyof CoverageRatios>)
    .map((key) => renderRatio(COVERAGE_DIMENSION_LABELS[key], ratios[key]))
    .join('\n');

  const shown = findings.slice(0, COVERAGE_CONFIG.maxRenderedFindings);
  const findingLines =
    findings.length === 0
      ? `   No coverage gaps found across ${scope.edgesExamined} edge(s).`
      : shown
          .map(
            (f) =>
              `   ${COVERAGE_SEVERITY_MARK[f.severity]} ${f.headline}\n` +
              `      → ${f.action}` +
              (f.sampleIds.length > 0
                ? `\n      ids: ${f.sampleIds.join(', ')}` +
                  (f.sampleOmitted > 0 ? ` (+${f.sampleOmitted} more)` : '')
                : '')
          )
          .join('\n');
  const findingOverflow =
    findings.length > shown.length
      ? `\n   … ${findings.length - shown.length} more finding(s) in structuredContent.coverage.findings`
      : '';

  return (
    `\n\nWhere it stands: ${currentState.nextAction.gate} — ${currentState.nextAction.gateReason}\n` +
    `   → ${currentState.nextAction.action}\n` +
    `   open: ${currentState.activeTasks.total} active task(s), ` +
    `${currentState.blockers.total} blocker/finding(s), ` +
    // HALF-EXECUTED DECISIONS: the standing-decision count alone cannot
    // distinguish 5 decisions that all shipped from 5 that were never built. Rendered only
    // when non-zero, so a project with nothing outstanding reads exactly as before.
    `${currentState.currentDecisions.total} standing decision(s)` +
    `${currentState.halfExecutedDecisions > 0 ? ` (${currentState.halfExecutedDecisions} not yet implemented)` : ''}, ` +
    `${currentState.latestTrustedOutcomes.total} trusted outcome(s); ` +
    `omitted: ${currentState.omitted.superseded.count} superseded, ` +
    `${currentState.omitted.historical.count} historical\n` +
    `\nGraph coverage${scopeNote}:\n${dimensionLines}\n${provenanceLine}\n` +
    `\nCoverage findings:\n${findingLines}${findingOverflow}`
  );
}

/**
 * Smart Search & AI Routes
 * Handles: smart_search, get_recommendations, project_insights
 */
// EXPORTED so the trust-band membership rule is assertable directly. The
// singleton below stays the way callers reach the routes; the class is exposed only so a
// guard can address TRUSTABLE_RESULT_TYPES / isTrustableResultType without re-declaring the
// list it is checking — a guard that hand-copies the set cannot detect the set being wrong.
export class SearchRoutes {
  /**
   * Resolve project ID using connection-scoped session state
   */
  private async resolveProjectId(argsProjectId: string | undefined, context?: RouteContext): Promise<string | null> {
    if (argsProjectId) {
      const project = await projectHandler.getProject(argsProjectId);
      if (!project) return null;
      return project.id;
    }
    const sessionId = context?.connectionId || 'default-session';
    await projectHandler.initializeSession(sessionId);
    // PROJECT-SCOPE: effective — a route's own project resolution. Under a binding this is
    // the bound project; unbound it is rung 3, exactly as before.
    return await projectHandler.getCurrentProjectId(sessionId);
  }

  /**
   * THE TRUSTABLE RESULT KINDS — the smart_search result types trust can be computed for.
   *
   * It is exactly the set services/trust.ts's RecordRef accepts, which is why the type is
   * written as a narrowing of RecordRef['type'] rather than as its own list: the compiler
   * rejects a member trust cannot resolve, and `isTrustableResultType` below is a type
   * PREDICATE, so the call site gets a properly narrowed `r.type` for free instead of a cast.
   *
   * What is deliberately NOT here: `component` and `agent`. Neither has an outcome graph or a
   * row in a table fetchRecordMeta knows, so trust for them would be a freshness-only number
   * dressed as a verdict.
   */
  static readonly TRUSTABLE_RESULT_TYPES: readonly RecordRef['type'][] =
    Object.freeze(['context', 'decision', 'task'] as const);

  /** Type predicate: may trust be computed for this result kind? */
  static isTrustableResultType(t: SmartSearchResult['type']): t is RecordRef['type'] {
    return (SearchRoutes.TRUSTABLE_RESULT_TYPES as readonly string[]).includes(t);
  }

  /**
   * THE `summary` BODY BUDGET for a smart_search row — both channels, one source.
   *
   * Read from named config (SEARCH P3). The prose channel used to carry a
   * LITERAL `substring(0, 80)` here while structuredContent shipped the whole body; that is
   * how a tool ends up with a size dial that moves only the half nobody was paying for.
   */
  static snippetBudget(): SnippetBudget {
    return { maxlen: SMART_SEARCH_SNIPPET_MAXLEN, affordance: SMART_SEARCH_CLIP_AFFORDANCE };
  }

  /**
   * TRUST (T2b — THE MOAT): the one-line human hint for a smart-search row. Rendered by the
   * SINGLE explainTrust(). This copy is where the drift was worst — it had
   * degraded to a bare ", cold-start" with no explanation of what cold-start means.
   */
  static trustHint(trust: Trust): string {
    // WS1 (D2): the machine-lean signal (band/score + supersession flag),
    // not the prose `.line`. The WHY prose is not shipped at all — it USED to ride
    // structuredContent.trust, which stopped being true when trust on the wire became
    // {band, score}.
    return explainTrust(trust).signal;
  }

  /**
   * Handle smart search requests
   */
  async handleSmartSearch(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // FAIL LOUD on a reserved arg-name prefix typed into `query` (an earlier task — the
      // SWEEP half). smart_search delegates the SAME query into contextHandler.searchContext
      // AND decisionsHandler.searchDecisions, so it inherits both engines' id-prefix gate —
      // and therefore the same silent degradation on `id:<uuid>`. It has no `id` parameter,
      // so the remedy is the BARE token (see config/searchConfig.ts).
      // THE ONE VOLUME DIAL (SEARCH P3). Resolved ONCE,
      // here, and used to project BOTH channels from the SAME per-row result below. An
      // off-axis value THROWS out of resolveAltitude and is reported as a tool error — it is
      // never defaulted.
      const altitude = resolveAltitude(
        // Named explicitly (see context.routes.ts) so the route-drift guard can SEE the
        // forwarding. smart_search never shipped `response_format`, so there is no alias.
        { altitude: args.altitude },
        SMART_SEARCH_DEFAULT_ALTITUDE,
        'smart_search'
      );

      const reservedPrefix = reservedArgPrefixInQuery(args.query, 'smart_search');
      if (reservedPrefix) {
        logger.info(`🚫 Smart search rejected reserved-prefix query: "${args.query}"`);
        return {
          content: [{
            type: 'text',
            text: reservedArgPrefixMessage(reservedPrefix, args.query, 'smart_search'),
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
      if (!projectId) {
        return {
          content: [{
            type: 'text',
            text: args.projectId
              ? `Project "${args.projectId}" not found\n\nUse project_list to see available projects`
              : `No current project set\n\nUse project_switch to set an active project`
          }]
        };
      }

      const { results, degradedSources, absentTerms, emptyReason, lexicalSkipped } =
        await smartSearchHandler.smartSearchDetailed(
          projectId,
          args.query,
          args.includeTypes,
          args.limit
        );

      // BUILD 3 — the terms we have NO RECORD OF, rendered for the text channel. Built once
      // and used by both the empty and the non-empty branch, because a fact that exists in
      // only one of them is a fact half the callers cannot see.
      const absentLine = (absentTerms && absentTerms.length > 0)
        ? `\n\nNo record of: ${absentTerms.map(a => `"${a.term}"`).join(', ')}`
        : '';
      const skippedLine = lexicalSkipped
        ? `\n\nKeyword matching was SKIPPED for this query (${lexicalSkipped.length} chars, ` +
          `cap ${lexicalSkipped.cap}) — these results are semantic-only.`
        : '';
      const structuredCommon = {
        // BUILD 3 — on EVERY response, empty or not. The surface form the caller typed, and
        // whether it is an ordinary English word (which is what decides the veto).
        absentTerms: absentTerms ?? null,
        lexicalSkipped,
      };

      if (results.length === 0) {
        // ═══ THREE EMPTY STATES, DISTINGUISHABLE IN BOTH CHANNELS (BUILD 5) ═══
        //
        // THE DEFECT THIS REPLACES: the text channel said "No results found... try broader
        // search terms" for ALL of them, including the case where every source THREW, while
        // only structuredContent carried the degradation. A caller reading the text channel
        // was told to rephrase a question that had never been asked of a working search.
        // "Empty because nothing matched", "empty because we have no record of X" and
        // "empty because everything broke" are three different facts, and telling a caller
        // to try broader terms is actively wrong advice for two of them.
        const kind = emptyReason?.kind ?? 'no_match';
        let text: string;
        if (kind === 'absent_terms') {
          text = vetoMessage(args.query, emptyReason!.vetoedBy);
        } else if (kind === 'all_degraded') {
          text = `Search FAILED for: "${args.query}"\n\n` +
                 `Every source could not be read: [${degradedSources.join(', ')}].\n` +
                 `This is NOT "nothing matched" — the search did not run. Do not rephrase; ` +
                 `retry, or check the server logs.`;
        } else {
          text = `No results found for: "${args.query}"\n\n` +
                 `Try broader search terms or different data sources` + absentLine;
        }
        return {
          content: [{ type: 'text', text: text + skippedLine }],
          // `ok` is FALSE for all_degraded. An exhausted search that returned nothing because
          // it could not run is not a successful empty result, and a machine caller keying on
          // `ok` must not read it as one.
          structuredContent: {
            ok: kind !== 'all_degraded',
            results: [], total: 0, degradedSources,
            // WHY there are no rows — the machine-readable half of the same three states.
            emptyReason: kind,
            vetoedBy: emptyReason?.vetoedBy ?? [],
            ...structuredCommon,
          },
        };
      }

      // HONESTY FLOOR: smart_search rows sort DESC by relevanceScore,
      // and the per-row display IS that score as a percentage — so it is already
      // display-consistent (an earlier task needs no number change here). Prepend an
      // honest header when the best row is below the floor. relevanceScore is a
      // fraction in [0,1]; the floor helper takes a 0–100 number.
      // HONESTY FLOOR, READ AGAINST THE QUANTITY IT WAS CALIBRATED ON.
      // Under rank fusion `relevanceScore` is a rescaled fused RANK, not the four-signal
      // blend the 35% floor was measured against, so the floor is given the top row's
      // SEMANTIC score instead. A top row with no semantic score at all got in on an exact
      // lexical match, which is the strongest evidence this engine has and the one case that
      // must never be labelled a weak match — hence the explicit NO_HONESTY_CONCERN rather
      // than a silent `?? 0`, which would have warned on every one of them.
      const NO_HONESTY_CONCERN = 100;
      const topSemantic = (results[0].metadata as Record<string, unknown> | undefined)?.semanticScore;
      const honestyHeader = buildHonestyHeader(
        typeof topSemantic === 'number' ? topSemantic * 100
          : results[0].source === 'lexical_search' ? NO_HONESTY_CONCERN
          : results[0].relevanceScore * 100);

      // TRUST (T2b — default-on): compute trust for the trustable result items. Indexed by
      // result position so it zips back onto the rows. trustForRecord self-fetches each
      // record's freshness date + (for decisions) its own outcome/supersession. Display-
      // only, computed AFTER the existing relevance sort — order is unchanged.
      //
      // `task` JOINED THIS SET with the task source. It is not a new
      // capability: services/trust.ts has carried `task` in RecordRef and resolved it to the
      // `tasks` table in fetchRecordMeta all along — this line was simply the one place that
      // never asked. Omitting it would have shipped a source whose every row rendered
      // without a trust hint while the machinery to compute one sat one call away, which
      // reads to a user as "tasks are untrustworthy" rather than "nobody wired it up".
      // TrustedResultType exists so the list is stated ONCE and the compiler checks the
      // membership test against it, instead of a chain of `||`s that a new source silently
      // falls off the end of.
      const trustByIndex = new Map<number, Trust>();
      const trustableIndexes: number[] = [];
      const trustableRefs: RecordRef[] = [];
      results.forEach((r, i) => {
        if (SearchRoutes.isTrustableResultType(r.type)) {
          trustableIndexes.push(i);
          trustableRefs.push({ id: r.id, type: r.type });
        }
      });
      if (trustableRefs.length > 0) {
        const trusts = await trustForRecords(trustableRefs);
        trustableIndexes.forEach((origIdx, k) => trustByIndex.set(origIdx, trusts[k]));
      }

      // ★ THE DIAL MOVES BOTH CHANNELS. `summary` here is the record BODY (SmartSearchResult
      // names it `summary`; recall_thread names the same thing `content`). Projected ONCE per
      // row, then rendered into the prose channel AND carried into structuredContent — so the
      // two can never disagree about how much of the record this call returned.
      const bodies = results.map((result) =>
        projectBody(result.summary, altitude, SearchRoutes.snippetBudget())
      );

      // WS1 (D2): plain terse rows — type icons, relevance bars, bold
      // markup, and the per-row permalink line dropped (structuredContent.url carries it).
      const resultsList = results.map((result, index) => {
        const sourceText = result.source ? ` (${result.source})` : '';
        const trust = trustByIndex.get(index);
        const trustLine = trust ? `\n      ${SearchRoutes.trustHint(trust)}` : '';
        // At `headline` there is NO body line at all — absent, not an empty one. A blank line
        // where a snippet used to be reads as "this record has no content", which is a
        // different (and false) claim than "this altitude does not carry bodies".
        const bodyLine = bodies[index].present ? `      ${bodies[index].text}\n` : '';

        return `   ${index + 1}. ${rawValue(result.title)} [${result.type}]\n` +
               bodyLine +
               `      Relevance: ${Math.round(result.relevanceScore * 100)}%${sourceText}${trustLine}\n` +
               `      ID: ${result.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: (honestyHeader ? honestyHeader + '\n\n' : '') +
                `Smart Search Results (${results.length})\n\n${resultsList}\n\n` +
                `Searched: [${args.includeTypes?.join(', ') || SMART_SEARCH_DEFAULT_SOURCES.join(', ')}]` +
                (degradedSources.length > 0
                  ? `\n\nCould not read: [${degradedSources.join(', ')}] — these results are incomplete.`
                  : '') + absentLine + skippedLine
        }],
        structuredContent: {
          results: results.map((result, index) => ({
            id: result.id,
            // STRUCTURED PERMALINK: the /r/<id8> link mirroring the text
            // block's refLine. Gated on the resolvable set exactly as the text sweep does —
            // the non-resolvable mixed types (component/naming/agent) get null, never a 404.
            url: isResolvableRecordType(result.type) ? recordUrl(result.id) : null,
            type: result.type,
            title: result.title,
            // THE SAME projected body the prose printed — never the raw one. At `headline`
            // the key is ABSENT (spread of an empty object), not present-and-empty.
            ...(bodies[index].present
              ? { summary: bodies[index].text, truncated: bodies[index].clipped }
              : {}),
            relevanceScore: result.relevanceScore,
            source: result.source,
            // TRUST ON THE WIRE (an earlier decision Part 2): band + score only. Present for
            // context/decision/task items; absent for record kinds with no outcome graph
            // (component/agent), which is why projectTrust is total over undefined.
            trust: projectTrust(trustByIndex.get(index)),
          })),
          // INTENTIONAL total == returned (an earlier task evaluation): smart_search is NOT a
          // single filtered query — it is a MERGED, RE-RANKED, capped aggregate. Each source
          // is OVER-fetched (SEARCH_MERGE_OVERFETCH_FACTOR × limit; the old per-source
          // quotas are gone), unioned, sorted by a SYNTHESIZED cross-source relevanceScore, then
          // sliced to `limit`. There is no coherent larger "match set" to COUNT: the context
          // contribution is a VECTOR RANKING (its candidate set is every embedded context in
          // the project, not a keyword filter), so a summed cross-source COUNT would be
          // dominated by "all embedded contexts" and report a misleading total (e.g. 350 when
          // 3 are relevant) — worse than total==returned. The tool also exposes NO offset, so
          // `total` is purely informational, not a pagination cursor. Unlike context_search
          // (a single paginated source where total = candidate count is honest + useful),
          // total==returned is the honest number here. Surfaced to the coordinator — a genuine
          // cross-source total would need a defined semantics + the countDecisions from the
          // an earlier change sibling (not in this tree), not a same-shape COUNT.
          total: results.length,
          // WHICH DIAL ANSWERED. A response that has clipped its bodies must SAY which
          // altitude did it, or a caller reading a truncated record cannot tell a short
          // record from a clipped one without diffing against a second call.
          altitude,
          ...structuredCommon,
          // Sources that THREW on this call. Empty on a healthy search. A partial answer
          // must be able to SAY it is partial — smart_search previously wrapped every
          // source in ONE try whose catch only logged, so a failure was indistinguishable
          // from "nothing matched".
          degradedSources,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'smart_search');
    }
  }

  /**
   * Handle recommendations requests
   */
  async handleRecommendations(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      if (!projectId) {
        return {
          content: [{
            type: 'text',
            text: args.projectId
              ? `Project "${args.projectId}" not found\n\nUse project_list to see available projects`
              : `No current project set\n\nUse project_switch to set an active project`
          }]
        };
      }

      const recommendations = await smartSearchHandler.getRecommendations(
        projectId,
        args.context,
        args.type
      );

      if (recommendations.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No specific recommendations for: "${args.context}"\n\n` +
                  `Try different context or recommendation type`
          }],
          structuredContent: { ok: true, results: [], total: 0 },
        };
      }

      // WS1 (D2): plain terse rows — icons and confidence bars dropped.
      const recList = recommendations.map((rec, index) => {
        const refsText = rec.references.length > 0 ? `\n      References: ${rec.references.length} items` : '';

        return `   ${index + 1}. ${rawValue(rec.title)} [${rec.type}] (${rec.actionable ? 'actionable' : 'informational'})\n` +
               `      ${rec.description}\n` +
               `      Confidence: ${Math.round(rec.confidence * 100)}%${refsText}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Recommendations (${recommendations.length})\n\n${recList}\n\n` +
                `Type: ${args.type} recommendations`
        }],
        structuredContent: {
          results: recommendations.map((rec) => ({
            type: rec.type,
            title: rec.title,
            summary: rec.description,
            confidence: rec.confidence,
            actionable: rec.actionable,
            references: rec.references,
          })),
          // INTENTIONAL total == returned (an earlier task evaluation): get_recommendations is
          // a GENERATED, ranked list — synthesized advice items (similar-implementation
          // patterns capped at 3, architecture decisions capped at 2, testing-task
          // suggestions capped at 3), sorted by confidence. It is NOT a filtered query over a
          // table with a meaningful larger total; there is no "page N of M" match set, so
          // total == the number of generated recommendations is correct by construction.
          total: recommendations.length,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'get_recommendations');
    }
  }

  /**
   * TAG CENSUS — "which tags exist, and how many records carry each".
   *
   * Declares `includeArchived`, so the routeExecutor disclosure seam stamps this op's
   * archive disclosure automatically (see ARCHIVE_DISCLOSURE_OPS). That coupling is the
   * point: this op's whole job is to be trusted as a population, and a population that
   * cannot state its own narrowing is the defect the sibling task documents.
   */
  async handleTagCensus(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      if (!projectId) {
        return formatMcpError(
          new Error('No project in scope — pass projectId or switch to a project first'),
          'project_tags'
        );
      }

      const result = await runTagCensus(
        (sql, params) => db.query(sql, params),
        {
          projectId,
          prefix: args.prefix ?? null,
          entities: args.entities,
          includeArchived: args.includeArchived === true,
          limit: args.limit,
        }
      );

      const scope = result.filter.entities.join(', ');
      const head = result.filter.prefix
        ? `Tag census — tags starting with "${result.filter.prefix}" (${scope})`
        : `Tag census — all tags (${scope})`;

      // THE ZERO CASE IS A SENTENCE, NOT AN EMPTY LIST. A caller reading "no tags" must be
      // able to tell it from a call that silently failed to evaluate the prefix.
      const body =
        result.matched === 0
          ? `\nNo tag matches this filter. The census RAN and found 0 distinct tag values ` +
            `(evaluated: true) — this is a measured absence, not a failed lookup.`
          : `\n` +
            result.tags
              .map((t) => {
                const split = Object.entries(t.byEntity)
                  .map(([e, n]) => `${e}:${n}`)
                  .join(' ');
                return `   ${t.tag} — ${t.count} (${split})`;
              })
              .join('\n') +
            (result.omitted > 0
              ? `\n\n   … ${result.omitted} more distinct tag(s) not shown (limit ${result.filter.limit})`
              : '');

      return {
        content: [
          {
            type: 'text',
            text:
              `${head}\n` +
              `Distinct tag values matching: ${result.matched}` +
              (result.omitted > 0 ? ` (showing ${result.tags.length})` : '') +
              `\n${body}`,
          },
        ],
        structuredContent: { ok: true, ...result },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_tags');
    }
  }

  /**
   * Handle project insights requests
   */
  async handleProjectInsights(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      if (!projectId) {
        return {
          content: [{
            type: 'text',
            text: args.projectId
              ? `Project "${args.projectId}" not found\n\nUse project_list to see available projects`
              : `No current project set\n\nUse project_switch to set an active project`
          }]
        };
      }

      // SOFT-DELETE: archived rows are EXCLUDED from all three entity
      // breakdowns by default so they reconcile with context_search / decision_search /
      // task_list. Same param name + meaning as those three tools.
      const includeArchived = args.includeArchived === true;
      const insights = await smartSearchHandler.getProjectInsights(projectId, includeArchived);

      // WS1 (D2): plain words, no traffic-light emoji.
      const healthLevelMap = {
        healthy: 'HEALTHY',
        moderate: 'MODERATE',
        needs_attention: 'NEEDS ATTENTION',
        [HEALTH_LEVEL_NO_DATA]: 'NO DATA'
      } as const;
      const healthLevel = healthLevelMap[insights.insights.codeHealth.level as keyof typeof healthLevelMap] || 'UNKNOWN';

      const efficiencyLevelMap = {
        efficient: 'EFFICIENT',
        moderate: 'MODERATE',
        needs_improvement: 'NEEDS IMPROVEMENT',
        [HEALTH_LEVEL_NO_DATA]: 'NO DATA'
      } as const;
      const efficiencyLevel = efficiencyLevelMap[insights.insights.teamEfficiency.level as keyof typeof efficiencyLevelMap] || 'UNKNOWN';

      // A `no_data` code health carries score === null: there is nothing
      // analyzed, so there is no score to show. Render the ABSENCE honestly rather than
      // interpolating a bare `null/100`. Only a real numeric score gets the `(n/100)` form.
      const codeHealthScore = insights.insights.codeHealth.score;
      const codeHealthScoreText =
        typeof codeHealthScore === 'number' ? `(${codeHealthScore}/100)` : '(not analyzed)';

      const issuesText = insights.insights.codeHealth.issues.length > 0
        ? `\nCode Issues:\n` + insights.insights.codeHealth.issues.map((issue: string) => `   - ${issue}`).join('\n')
        : '';

      // GRAPH COVERAGE — replaces the "Knowledge Gaps" block, which listed
      // count-threshold advice ("Few decisions documented — record more architectural
      // choices") the Amp-orb eval measured as wrong on a healthy project. Rendered through
      // ONE renderer (renderCoverage) so the text and machine channels cannot drift.
      const coverage: ProjectCoverage = insights.insights.coverage;
      const coverageText = renderCoverage(coverage);

      return {
        content: [{
          type: 'text',
          text: `Project Health Insights\n\n` +
                (includeArchived
                  ? `Population: ALL records, INCLUDING archived (includeArchived: true)\n`
                  : `Population: live records (archived excluded — matches context_search / decision_search / task_list)\n`) +
                `Code Health: ${healthLevel} ${codeHealthScoreText}\n` +
                `Team Efficiency: ${efficiencyLevel} (${Math.round((insights.insights.teamEfficiency.completionRate || 0) * 100)}%)\n` +
                `Components: ${insights.codeStats.totalComponents}\n` +
                `Contexts: ${Object.values(insights.contextStats).reduce((a: any, b: any) => a + (b.count || 0), 0)}\n` +
                `Decisions: ${insights.decisionStats.total}\n` +
                `Tasks: ${insights.taskStats.total}${issuesText}\n` +
                coverageText + `\n\n` +
                `Drill into any of these with: recall_thread(anchor=<id>, altitude="current")`
        }],
        structuredContent: {
          codeHealth: {
            level: insights.insights.codeHealth.level,
            score: insights.insights.codeHealth.score,
            issues: insights.insights.codeHealth.issues,
          },
          teamEfficiency: {
            level: insights.insights.teamEfficiency.level,
            completionRate: insights.insights.teamEfficiency.completionRate ?? 0,
          },
          // The MACHINE channel carries the coverage measurement in full: every ratio, every
          // finding (uncapped — the text channel caps what it PRINTS, never what it reports),
          // the scope, and the gate/next-action part B derived. A dual-channel client that
          // drops `content` still gets the whole answer.
          coverage: {
            ratios: coverage.ratios,
            findings: coverage.findings,
            scope: coverage.scope,
            // Declared/guessed split — same object the human channel
            // renders, so the two channels cannot disagree about provenance.
            provenance: coverage.provenance,
            gate: coverage.currentState.nextAction.gate,
            nextAction: coverage.currentState.nextAction.action,
            openWork: {
              activeTasks: coverage.currentState.activeTasks.total,
              blockers: coverage.currentState.blockers.total,
              standingDecisions: coverage.currentState.currentDecisions.total,
              // an earlier task — the same signal on the structured channel, so a
              // dual-channel client that drops `content` still learns it.
              halfExecutedDecisions: coverage.currentState.halfExecutedDecisions,
              trustedOutcomes: coverage.currentState.latestTrustedOutcomes.total,
            },
            omitted: coverage.currentState.omitted,
            artifactHead: coverage.currentState.artifactHead,
            artifactIssues: coverage.currentState.artifactIssues,
          },
          totalComponents: insights.codeStats.totalComponents,
          decisionsTotal: insights.decisionStats.total,
          tasksTotal: insights.taskStats.total,
          // an earlier task — declare which population the three entity totals describe.
          // These numbers now reconcile with decision_search / task_list / context_search
          // on the same filter; saying so on the wire is what stops the next reader
          // guessing (the ambiguity behind the 556-vs-127 split).
          includeArchived,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'project_insights');
    }
  }
}

export const searchRoutes = new SearchRoutes();
