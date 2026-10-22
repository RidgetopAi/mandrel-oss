import { contextHandler, buildHonestyHeader, mapContextRow } from '../handlers/context.js';
import { serializeContext } from '../services/serializers/contextSerializer.js';
import { projectHandler } from '../handlers/project.js';
import { formatRecordRef } from '../config/commandUrlConfig.js';
import { SessionTrackingMiddleware } from '../api/middleware/sessionTracking.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import {
  resolveEntityId,
  idErrorResponse,
  isFullUuid,
  reservedArgPrefixInQuery,
  reservedArgPrefixMessage,
} from '../utils/idResolver.js';
import { buildWriteEcho } from '../utils/projectEcho.js';
import {
  RECALL_DEFAULT_ALTITUDE,
  recallSnippetBudget,
} from '../config/recallConfig.js';
import { resolveAltitude } from '../config/altitudeConfig.js';
import { projectBody, projectTrust, projectTrustDirect } from '../services/altitudeProjection.js';
import {
  autoMintFromTags,
  mintExplicitLinks,
  hasTrustThreadingTag,
  type LinkWarning,
  type ReportedMintedEdge,
} from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { trustForRecords, explainTrust, type RecordRef, type Trust } from '../services/trust.js';
import { AUTO_THREAD_CONFIG } from '../config/autoThreadConfig.js';
import { RELIABLE_THREADING_CONFIG } from '../config/reliableThreadingConfig.js';
import {
  mintPositional,
  serializePositionalReport,
  composePositionalBody,
  membershipReasonLine,
  multiNameLine,
  positionAgeNoticeLine,
} from '../services/positionalMint.js';
import {
  mintHandoffSupersession,
  TRUNK_CONTEXT_TYPE,
  type HandoffSupersessionReport,
} from '../services/handoffSupersession.js';
import { inferAndMintRelatedTo, INFERENCE_EDGE_TYPE, type InferenceResult } from '../services/threadInference.js';

/**
 * ONE explicit threading reference that MINTED NOTHING — a `task:`/`decision:`
 * /`context:` tag or a `links` entry whose referent did not resolve.
 *
 * `code` is the machine-readable {@link MintSkipCode} when the tag path produced it, and null
 * for a `links` rejection (whose failure set is wider than resolution: a bad edgeType, a
 * malformed spec). A consumer that needs to branch reads `code`; `reason` is prose and is free
 * to be reworded, so nothing should substring-match it.
 */
export interface UnresolvedThreadRef {
  /**
   * WHICH intent channel produced the unresolved reference. Typed from the ONE edge-mint
   * vocabulary rather than a hand-spelled union — this field answers the
   * same "which path" question as {@link ReportedMintedEdge.via}, so it must answer it in
   * the same words. Narrowed here to the two channels that can carry explicit intent.
   */
  via: typeof EDGE_MINT_VIA.tag | typeof EDGE_MINT_VIA.linksParam;
  ref: string;
  reason: string;
  code: string | null;
}

/**
 * The heading the text channel uses for an unresolved threading reference. A LITERAL, stable
 * marker (not a sentence that will get reworded) so a model — and this route's contract test —
 * can key on it. Deliberately shouted: this is the one outcome where the writer stated an
 * intent, got a successful-looking store back, and did not get the thread they asked for.
 */
const UNRESOLVED_THREAD_HEADING = 'THREADING REFERENCE UNRESOLVED';

/**
 * Context Management Routes
 * Handles: context_store, context_search, context_get_recent, context_stats,
 *          context_delete, context_restore
 */
// EXPORTED so the pure static renderers — inferenceLineFor in particular —
// can be asserted directly. The sentence a caller reads IS the deliverable of the honest-miss
// work; a truthful reason rendered by a catch-all branch is still a lie at the surface, so
// the rendering needs its own test and therefore its own reachable name. The route itself is
// still consumed as the `contextRoutes` singleton below — nothing about wiring changes.
export class ContextRoutes {
  /**
   * Get session ID from context for connection-scoped isolation
   * Uses connectionId if available, otherwise falls back to default
   */
  private getSessionId(context?: RouteContext): string {
    return context?.connectionId || 'default-session';
  }

  /**
   * Resolve the project ID using connection-scoped session state
   * If args.projectId is explicit, use that. Otherwise resolve from switched project.
   */
  private async resolveProjectId(argsProjectId: string | undefined, context?: RouteContext): Promise<string | undefined> {
    if (argsProjectId) return argsProjectId;

    const sessionId = this.getSessionId(context);
    await projectHandler.initializeSession(sessionId);
    // PROJECT-SCOPE: effective — a route's own project resolution. Under a binding this is
    // the bound project; unbound it is rung 3, exactly as before.
    const projectId = await projectHandler.getCurrentProjectId(sessionId);
    return projectId || undefined;
  }
  /**
   * THE INFERENCE LINE (spec B3) — the human sentence a caller reads to learn whether their
   * capture threaded, and why not if it didn't.
   *
   * EXHAUSTIVE BY CONSTRUCTION. This used to be a ternary chain whose FINAL
   * branch was the catch-all "no neighbor ≥ threshold" — so every reason the chain did not
   * name explicitly was RENDERED AS A BELOW-THRESHOLD MISS, whether or not any comparison had
   * happened. That is how a capture whose own vector was uncomparable told its author "no
   * neighbour was close enough". A `switch` with a `never` default makes the same mistake a
   * COMPILE error: add an InferenceReason and this function stops building until someone
   * writes the true sentence for it.
   *
   * Static + pure so the wording is directly testable without driving a store.
   */
  static inferenceLineFor(inference: InferenceResult): string {
    const floor = RELIABLE_THREADING_CONFIG.inferenceThreshold;
    // Only ever rendered for a similarity we actually measured — the non-comparable branches
    // deliberately carry no `similarity`, so there is nothing here to print as a fake score.
    const sim = (label: string) =>
      inference.similarity !== undefined && Number.isFinite(inference.similarity)
        ? ` (${label} ${inference.similarity.toFixed(3)})`
        : '';
    switch (inference.reason) {
      case 'minted':
        return inference.candidateId
          ? `inferred related_to → context ${inference.candidateId}` +
              sim('sim') +
              (inference.minted ? '' : ' (already related)')
          : `unthreaded: a neighbor cleared threshold ${floor} but no candidate id was returned`;
      case 'no-neighbor-above-threshold':
        return `unthreaded: no neighbor ≥ threshold ${floor}` + sim('best sim');
      case 'no-candidates':
        return 'unthreaded: no candidate to compare against — this project has no other ' +
          'threaded, embedded context yet (nothing was measured against the threshold)';
      case 'source-has-no-embedding':
        return 'unthreaded: no embedding on this capture to infer from';
      case 'source-embedding-degenerate':
        return 'unthreaded: this capture\'s embedding is DEGENERATE (zero-norm) — it cannot be ' +
          'compared to any context and is invisible to semantic search. No threshold was ' +
          'applied. The re-embed self-heal worker will replace the vector.';
      case 'similarity-not-comparable':
        return 'unthreaded: the similarity could NOT be computed (non-finite) — a candidate ' +
          'embedding is degenerate. No threshold was applied.';
      case 'error':
        return 'unthreaded: inference failed (the capture was still saved) — see server logs';
      default: {
        const unhandled: never = inference.reason;
        return `unthreaded: unrecognised inference reason ${String(unhandled)}`;
      }
    }
  }

  /**
   * T5a: render explicit-link rejection WARNINGS as compact human lines for the text
   * channel — "<reason> (link: <spec>)". Shared shape with the decision route's surfacing
   * so the two write paths read identically. Static (pure) so it's reusable + testable.
   */
  static linkWarningLines(warnings: LinkWarning[]): string[] {
    return warnings.map((w) => `${w.reason} (link: ${JSON.stringify(w.spec)})`);
  }

  /**
   * THE LOUD LINE for an explicit threading reference that minted nothing.
   *
   * Why this exists as its own block when `Tag edges skipped:` / `Link notes:` already list
   * the same reasons: those two say a REFERENCE failed. This says what the writer actually
   * needs to know — that the THREAD THEY ASKED FOR DOES NOT EXIST, and what the write fell
   * back to. Before this, the failure and its consequence lived in different places and only
   * the failure was reported, so the consequence (an orphan) was inferable but never stated.
   *
   * `landed` distinguishes the two cases that must NOT read alike: some other reference did
   * thread the record (a partial miss), versus none did (this reference was the whole plan).
   *
   * Static + pure: the sentence is the deliverable, so it is directly testable.
   */
  static threadingIntentLines(
    unresolved: UnresolvedThreadRef[],
    landed: boolean,
    fallbackEngaged: boolean,
  ): string[] {
    if (unresolved.length === 0) return [];
    const head =
      `${UNRESOLVED_THREAD_HEADING} — ${unresolved.length} explicit threading reference` +
      `${unresolved.length === 1 ? '' : 's'} minted no edge:`;
    const items = unresolved.map((u) => `   - ${u.reason} (via ${u.via}: "${u.ref}")`);
    const tail = landed
      ? '   The record is still threaded by another reference; the one(s) above are not.'
      : fallbackEngaged
        ? '   Nothing you named threaded this record, so fallback threading was run instead ' +
          '(see the threading line below). Fix the reference to thread it deliberately.'
        : '   Nothing you named threaded this record.';
    return [head, ...items, tail];
  }

  /**
   * Helper to format relative time
   */
  private getTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - new Date(date).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMins > 0) return `${diffMins}m ago`;
    return 'just now';
  }

  /**
   * TRUST (T2b — THE MOAT): the one-line human hint for a recall row. Rendered by the SINGLE
   * explainTrust() — band + BL-5 receipt + score + WHY that band + the
   * evidence count + what would promote it. This route used to hand-roll the hint, which is
   * how four copies drifted apart; there is no formatting logic left here on purpose.
   */
  private trustHint(trust: Trust): string {
    // WS1 (D2): the machine-lean signal (band/score + supersession flag),
    // not the prose `.line`. The WHY prose is not shipped at all — it USED to ride
    // structuredContent.trust, which stopped being true when trust on the wire became
    // {band, score}.
    return explainTrust(trust).signal;
  }

  /**
   * Compute trust for a page of context rows (DEFAULT-ON, T2b). Cheap — per returned row,
   * after existing ordering (trust is SURFACED, not yet a ranker). Never throws (the
   * service degrades to cold-start on a per-row error), so trust can't break recall.
   * `rows` carry id + created_at (the freshness input). Returns Trust[] in input order.
   */
  private async trustForContextRows(
    rows: Array<{ id: string; createdAt: Date | string }>
  ): Promise<Trust[]> {
    const refs: RecordRef[] = rows.map((r) => ({
      id: r.id,
      type: 'context',
      createdAt: r.createdAt,
    }));
    return trustForRecords(refs);
  }

  /**
   * Handle context storage requests
   */
  async handleStore(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const sessionId = this.getSessionId(context);
      const projectId = await this.resolveProjectId(args.projectId, context);
      logger.info(`📝 Context store request received (session: ${sessionId}, project: ${projectId?.substring(0, 8)}...)`);

      const result = await contextHandler.storeContext({
        content: args.content,
        type: args.type,
        tags: args.tags,
        relevanceScore: args.relevanceScore,
        metadata: args.metadata,
        // CARRIED FIELDS (P5.4): MODE and the branch SPINE as first-class args instead of
        // a convention scraped from prose. Handled entirely inside storeContext (the one
        // choke point every context write passes through); warnings ride the existing
        // `result.warnings` channel and are rendered under "Tag notes" below.
        mode: args.mode,
        spine: args.spine,
        projectId: projectId,
        sessionId: args.sessionId,
        connectionId: context?.connectionId
      });

      // Auto-track context_stored activity in session (connection-scoped)
      await SessionTrackingMiddleware.trackContextStored(
        result.id,
        result.contextType,
        result.tags,
        context?.connectionId
      );

      // AUTO-MINT TYPED EDGES (T2a Q3 — near-free, at write-time). The threading tags the
      // writer already provided (task:/decision:/context:) ALSO mint typed edges from this
      // context → the referent. Resolves id8→uuid project-scoped; a bad/unresolvable tag
      // is skipped silently (never throws) so a typo can't break the store. Uses the
      // NORMALIZED stored tags (result.tags) so a case-fixed tag still mints its edge.
      // DENY + SURFACE: a threading tag whose referent does not resolve
      // (nonexistent id, wrong project, ambiguous prefix) mints NOTHING and now RETURNS the
      // reason, which is surfaced in BOTH channels below. Previously this was swallowed at
      // debug level — which is precisely how the full-UUID hole stayed invisible: the write
      // succeeded, the caller saw success, and the edge silently did not exist (or worse,
      // pointed at a nonexistent node). The write is still never broken by a bad tag.
      const tagMintResult = await autoMintFromTags({
        fromId: result.id,
        fromType: 'context',
        tags: result.tags,
        projectId,
        createdBy: 'auto:context_store',
      });

      // FIRST-CLASS LINKS (T5a): the explicit `links` param. Unlike the
      // silent tag path, `links` is EXPLICIT user intent — so each REJECTED link (bad
      // edgeType / unresolvable ref / self-link) is surfaced as a WARNING in BOTH channels
      // (text + structuredContent.context.linkWarnings), while the record + every good
      // link still persist. mintExplicitLinks never throws (a bad link can't break store).
      const linkResult = await mintExplicitLinks({
        fromId: result.id,
        fromType: 'context',
        links: args.links,
        projectId,
        createdBy: 'links:context_store',
      });

      // POSITIONAL MEMBERSHIP (PHASE 1) — REPLACES the
      // retired active-thread anchor. The session's CURRENT BRANCH (branch_open /
      // branch_positions) is read per-session through the one strict-keying choke point,
      // and a DECLARED `informs` edge (created_by 'auto:positional' — the 079 meter's
      // DECLARED bucket) is stamped from this capture to the spine. No TTL, no similarity
      // gate: standing there IS membership. The multi-name policy runs in the same call:
      // ≥2 task ids named in the body → TRUNK record (no membership, a declared weak
      // reference to EACH named task); exactly 1 foreign id while positioned → membership +
      // one weak reference. A write with NO branch open gets the `branch_open <id8>` offer
      // (its own id — D2: identifier ambient, copy free).
      //
      // PRECEDENCE CHANGE, deliberate (vs the anchor's ladder): explicit links/tags no
      // longer SUPPRESS the membership edge — naming ≠ membership, standing there =
      // membership, so both mint. The explicit opt-out flag (noAutoThread) still skips the
      // membership mint. mintPositional NEVER throws (the record is already persisted).
      const optedOut = args[AUTO_THREAD_CONFIG.optOutFlag] === true;
      const wasExplicit = Array.isArray(args.links) && args.links.length > 0;
      const hasExplicitTag = hasTrustThreadingTag(result.tags, 'context');

      // ── STATED INTENT vs LANDED INTENT ────────────────────────────────
      // Explicit intent suppresses the B1 INFERENCE fallback below, on the reasoning that a
      // deliberate writer needs no guess. That reasoning holds only if the writer's reference
      // ACTUALLY THREADED THE RECORD. It did not hold when the reference failed to resolve —
      // a typo, a wrong id8, a deleted record, a referent in another project. Then the tag
      // minted nothing, the fallback was suppressed anyway, and (with no branch open) the
      // write ended with NO EDGE FROM ANY PATH: a genuine orphan bought with one mistyped
      // character, by the person least likely to notice.
      //
      // So the gate is now LANDED, not STATED. `stated` is still computed, because the two
      // together are the honest report: stated && !landed is exactly the case that must be
      // said out loud (see threadingIntentLines below) — re-running the fallback is the floor,
      // not the fix. In the empty population (no candidate to infer from) the fallback mints
      // nothing and the SURFACED REASON is the entire guarantee.
      //
      // `landed` is derived from the SAME predicate that decided the tag was explicit in the
      // first place — hasTrustThreadingTag over the tags that actually MINTED an edge — so the
      // "did it count?" question can never drift from the "does it suppress?" question
      // (one definition, not two).
      const landedTrustTag = hasTrustThreadingTag(
        tagMintResult.edges.map((e) => e.sourceTag),
        'context',
      );
      const landedExplicitLink = wasExplicit && linkResult.edges.length > 0;
      const explicitThreadIntent = landedTrustTag || landedExplicitLink;
      const threadIntentStated = wasExplicit || hasExplicitTag;
      const threadIntentUnresolved = threadIntentStated && !explicitThreadIntent;
      // The per-reference reasons behind that verdict, from the two channels that carry
      // explicit intent. Reported ALWAYS (even when another reference landed), because a
      // half-broken threading intent is still a broken reference the writer must see.
      const unresolvedThreadRefs: UnresolvedThreadRef[] = [
        ...tagMintResult.skips.map((s) => ({ via: EDGE_MINT_VIA.tag, ref: s.ref, reason: s.reason, code: s.code })),
        ...linkResult.warnings.map((w) => ({
          via: EDGE_MINT_VIA.linksParam,
          ref: String(w.spec.task ?? w.spec.decision ?? w.spec.context ?? w.spec.to ?? ''),
          reason: w.reason,
          code: null,
        })),
      ];
      const reliableEnabled = RELIABLE_THREADING_CONFIG.enabled;

      const positional = await mintPositional({
        recordId: result.id,
        recordType: 'context',
        // ONE body-composition rule for all three write paths (SK1):
        // which fields are scanned lives in config/positionalMembershipConfig.ts, not here.
        body: composePositionalBody('context', { content: args.content }),
        projectId,
        sessionId,
        // P1: a `handoff` is TRUNK MATERIAL BY TYPE — the service decides
        // that from the type alone and never consults the branch position.
        contextType: result.contextType,
        optedOut,
      });

      // HANDOFF SUPERSESSION (PHASE 2 item g): a new handoff
      // deterministically supersedes the project's previous newest handoff — the trunk
      // timeline's own DECLARED corroboration feed (14.2% declared baseline measured on
      // the handoff chains). Deterministic created_at adjacency, one bounded query;
      // never recurses the supersedes graph and never throws (record already persisted).
      const handoffSup: HandoffSupersessionReport | null =
        result.contextType === TRUNK_CONTEXT_TYPE
          ? await mintHandoffSupersession({
              recordId: result.id,
              contextType: result.contextType,
              projectId,
            })
          : null;

      // B1 NO-ORPHAN FALLBACK (spec B1/B3) — unchanged in spirit, re-gated on the
      // positional layer: runs ONLY when reliable-threading is ON, the caller neither
      // opted out nor stated explicit intent, and the positional layer minted NOTHING
      // (no branch open and no named refs). Still mints ONLY a labeled weak `related_to`
      // (created_by 'auto:inference'); the record already persisted regardless.
      let inference: (InferenceResult & { ran: true }) | null = null;
      if (
        reliableEnabled &&
        !optedOut &&
        !explicitThreadIntent &&
        positional.edges.length === 0 &&
        // A handoff whose supersession edge minted is already threaded to the trunk
        // timeline — the no-orphan floor is met by a DECLARED edge; no guess needed.
        !(handoffSup && handoffSup.predecessorId !== null)
      ) {
        const inf = await inferAndMintRelatedTo(
          { fromId: result.id, projectId, createdBy: 'auto:inference' },
        );
        inference = { ...inf, ran: true };
      }

      // UNIFIED EDGE REPORT: EVERY edge this write minted-or-deduped,
      // whichever path minted it, each labeled with its provenance. The anchor's 'anchor'
      // label is replaced by the positional labels ('position' | 'named-ref' | 'trunk-ref').
      const edgesMinted: ReportedMintedEdge[] = [
        ...tagMintResult.edges.map((e): ReportedMintedEdge => ({ via: EDGE_MINT_VIA.tag, ...e })),
        ...linkResult.edges.map((e): ReportedMintedEdge => ({ via: EDGE_MINT_VIA.linksParam, ...e })),
        ...positional.edges.map((e): ReportedMintedEdge => ({
          via: e.via,
          edgeType: e.edgeType as ReportedMintedEdge['edgeType'],
          toType: e.toType,
          toId: e.toId,
          created: e.created,
        })),
        ...(inference && inference.reason === 'minted' && inference.candidateId
          ? [{
              via: 'inference' as const,
              edgeType: INFERENCE_EDGE_TYPE,
              toType: 'context' as const,
              toId: inference.candidateId,
              created: inference.minted,
            }]
          : []),
        // PHASE 2 item g: the handoff-timeline supersession edge (declared corroboration).
        ...(handoffSup && handoffSup.predecessorId !== null
          ? [{
              via: EDGE_MINT_VIA.handoffTimeline,
              edgeType: 'supersedes' as const,
              toType: 'context' as const,
              toId: handoffSup.predecessorId,
              created: handoffSup.created,
            }]
          : []),
      ];
      // The honest no-orphan number: NEW edge rows this write created, across ALL paths.
      const totalLinksMinted = edgesMinted.filter((e) => e.created).length;

      // TEXT-CHANNEL lines for the positional layer (mirrors how every other mint path
      // surfaces itself — an invisible mint is one nobody can notice going wrong).
      const positionalLines = positional.edges.map(
        (e) =>
          `${e.edgeType} → ${e.toType} ${e.toId}${e.created ? '' : ' (already linked)'} (via ${e.via})`
      );
      // ONE renderer for the multi-name policy's three states (SK1 fold-in) — a
      // deliberately-positioned record keeps its membership AND its trunk-refs.
      const trunkLine = multiNameLine(positional);
      // AUTO-OPEN R5: the session fanned out earlier and reverted to trunk,
      // so this capture minted no membership edge. Said out loud — a capture that silently
      // joins nothing is exactly the invisible failure this whole feature exists to end.
      // (A capture never auto-opens (R1 is creates-only) and never triggers the fan-out
      // revert (R2 is creates-only), so those two lines belong only to the create paths.)
      const atTrunkLine = positional.atTrunk
        ? 'At trunk — no membership edge minted. branch_open <id> to stand on a branch.'
        : null;
      // PHASE 2 item g: the handoff-timeline supersession, surfaced like every other mint
      // path (an invisible mint is one nobody can notice going wrong).
      const handoffSupLine =
        handoffSup && handoffSup.predecessorId !== null
          ? `supersedes → context ${handoffSup.predecessorId}` +
            `${handoffSup.created ? '' : ' (already linked)'} (declared handoff-timeline corroboration)`
          : handoffSup?.warning
          ? `handoff supersession: ${handoffSup.warning}`
          : null;
      const inferenceLine = inference ? ContextRoutes.inferenceLineFor(inference) : null;

      // 8a64c16e: the fallback ran BECAUSE the stated intent did not land. (It does not run
      // when the writer opted out, or when the positional layer already threaded the record —
      // in both of those the floor is met without a guess.)
      const threadFallbackEngaged = threadIntentUnresolved && inference !== null;
      const threadingIntentLines = ContextRoutes.threadingIntentLines(
        unresolvedThreadRefs,
        explicitThreadIntent,
        threadFallbackEngaged,
      );

      // PROJECT VISIBILITY: ONE line naming the RESOLVED target project.
      const projectEcho = await buildWriteEcho(projectId, sessionId, args.projectId != null);

      // LINKING-GRAMMAR warnings (tool-native linking) — unchanged.
      const linkWarningLines = ContextRoutes.linkWarningLines(linkResult.warnings);
      // TAG/LINKS-ARG edges for the TEXT channel: these two paths were
      // INVISIBLE on success (only their failures — skips/warnings — were surfaced), which
      // is exactly how a correctly-threaded write read as an orphan at a glance. The
      // anchor + inference paths keep their existing dedicated 🧵 lines below (they carry
      // extra signal: age/similarity), so this section lists only the other two paths.
      const linkedLines = edgesMinted
        .filter((e) => e.via === EDGE_MINT_VIA.tag || e.via === EDGE_MINT_VIA.linksParam)
        .map(
          (e) =>
            `${e.edgeType} → ${e.toType} ${e.toId}` +
            (e.created ? '' : ' (already linked)') +
            (e.via === EDGE_MINT_VIA.tag ? ` (via tag${e.sourceTag ? ` "${e.sourceTag}"` : ''})` : ' (via links)')
        );

      return {
        content: [{
          type: 'text',
          // DUAL-CHANNEL: lean machine text; the full report rides structuredContent.
          // Keeps the stable `ID:` marker so id-parsing consumers/tests still work.
          // WS1 (D2): emoji markers dropped — MCP text goes to machine readers.
          text: `Context stored (${result.contextType})\nID: ${result.id}\n${formatRecordRef(result.id)}` +
                (result.warnings && result.warnings.length > 0
                  ? `\nTag notes:\n` + result.warnings.map(w => `   - ${w}`).join('\n')
                  : '') +
                (linkWarningLines.length > 0
                  ? `\nLink notes:\n` + linkWarningLines.map(w => `   - ${w}`).join('\n')
                  : '') +
                // 86d56b8c: threading tags that resolved to nothing → no edge, said out loud.
                (tagMintResult.skips.length > 0
                  ? `\nTag edges skipped:\n` +
                    tagMintResult.skips.map(s => `   - ${s.reason}`).join('\n')
                  : '') +
                // 8fc68175: tag/links-param edges that DID mint, said out loud too — success
                // must be as visible as failure or a threaded write reads as an orphan.
                (linkedLines.length > 0
                  ? `\nLinked:\n` + linkedLines.map(l => `   - ${l}`).join('\n')
                  : '') +
                // PHASE 1: the positional edges (membership / named refs / trunk refs),
                // surfaced like every other mint path.
                (positionalLines.length > 0
                  ? `\nPositional:\n` + positionalLines.map(l => `   - ${l}`).join('\n')
                  : '') +
                (trunkLine ? `\n${trunkLine}` : '') +
                (atTrunkLine ? `\n${atTrunkLine}` : '') +
                // SK1 item c: the no-mint outcomes that had no line of their own (opt-out,
                // record-is-spine). ONE shared sentence — see membershipReasonLine.
                (membershipReasonLine(positional) ? `\n${membershipReasonLine(positional)}` : '') +
                // stale-position visibility. ONE shared sentence, same as the
                // create paths render through positionalResponseLines.
                (positionAgeNoticeLine(positional) ? `\n${positionAgeNoticeLine(positional)}` : '') +
                (handoffSupLine ? `\n${handoffSupLine}` : '') +
                // Strict-keying refusal, said out loud (absent unless strict mode actually
                // refused the session key for this connection) — same honesty contract the
                // anchor's skip line carried.
                (positional.keyRefusal ? `\nPosition skipped: ${positional.keyRefusal}` : '') +
                // Multi-name matcher ambiguities + mint failures (never silent, never thrown).
                (positional.warnings.length > 0
                  ? `\nPositional notes:\n` + positional.warnings.map(w => `   - ${w}`).join('\n')
                  : '') +
                // THE OFFER (spec item b): a write with no branch open names its OWN id8 as a
                // ready-to-open spine. Literal `branch_open <id8>` — copyable as-is.
                (positional.offer
                  ? `\nNo branch open — to start one on this record: ${positional.offer}`
                  : '') +
                // 8a64c16e: an explicit threading reference that minted nothing, said out
                // loud with its CONSEQUENCE — placed immediately before the threading line
                // it explains.
                (threadingIntentLines.length > 0 ? `\n${threadingIntentLines.join('\n')}` : '') +
                (inferenceLine ? `\nthreading: ${inferenceLine}` : '') +
                // PROJECT VISIBILITY: appended LAST so the target project is
                // the final thing the model reads on a successful store.
                (projectEcho ? `\n${projectEcho}` : ''),
        }],
        structuredContent: {
          action: 'created',
          // ONE SERIALIZER: the record is `serializeContext`'s output (full
          // body — a write echo is not altitude-projected); the write report rides `extras`.
          context: serializeContext(result, {
            extras: {
              warnings: result.warnings ?? [],
              // T5a: structured per-link rejections (reason + the offending spec) so a
              // machine reader sees exactly which explicit links were dropped + why.
              linkWarnings: linkResult.warnings,
              // 8fc68175 — THE no-orphan honesty number: NEW edges this write created across
              // ALL mint paths (tag + links-param + positional + inference), NOT just the
              // explicit `links` param. Invariant, contract-tested per path
              // (storeEdgeReporting.contract.test.ts): equals what get_links reports.
              linksMinted: totalLinksMinted,
              // 8fc68175 — the unified per-edge ledger backing that number, each labeled with
              // its provenance (via: 'tag' | 'links-param' | 'anchor' | 'inference').
              edgesMinted,
              // 86d56b8c: COUNT of edges minted FROM THREADING TAGS + every tag that resolved
              // to nothing (with the reason). Subsumed by edgesMinted but kept — consumers read it.
              tagEdgesMinted: tagMintResult.minted,
              tagEdgeSkips: tagMintResult.skips,
              // 8a64c16e — WHAT HAPPENED TO THE THREADING THE WRITER ASKED FOR (stated /
              // landed / fallbackEngaged / unresolved). See the loud text line it mirrors.
              threadingIntent: {
                stated: threadIntentStated,
                landed: explicitThreadIntent,
                fallbackEngaged: threadFallbackEngaged,
                unresolved: unresolvedThreadRefs,
              },
              // PHASE 1: the positional layer's full, honest report.
              positional: serializePositionalReport(positional),
              // PHASE 2 item g: the handoff-timeline supersession report.
              handoffSupersession: handoffSup,
              // RESUME POINTER: what the resume-pointer layer did for this write.
              resumePointer: result.resumePointer ?? null,
              // CARRIED FIELDS (P5.4): what the mode/spine layer did; null when neither declared.
              carriedFields: result.carriedFields ?? null,
              // ST-5 (B1/B3 — DISPLAY-ONLY): the write-time inference outcome.
              inference,
            },
          }),
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_store');
    }
  }

  /**
   * Handle context search requests
   * Supports both semantic search (query) and direct ID lookup (id)
   */
  async handleSearch(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      // RECALL payload control (T1 item 1): default 'concise' (truncate each content +
      // affordance) unless the caller asks for 'detailed' (full body). Resolved once here
      // for the multi-row paths (tags-only + semantic). The by-id path defaults to
      // 'detailed' separately (it's the explicit zoom target).
      // THE ONE VOLUME DIAL (SEARCH P3). `altitude` is the advertised
      // parameter; `response_format` still works as a DEPRECATED ALIAS (concise->summary,
      // detailed->full) because it is shipped on customer instances. Resolved ONCE for the
      // multi-row paths (tags-only + semantic); the by-id path resolves its own default
      // separately, because it is the explicit zoom target.
      const altitude = resolveAltitude(
        // NAMED EXPLICITLY, not `args` wholesale: the route-drift guard reads the handler's
        // TEXT for `args.<param>`, and a param forwarded only by spreading the whole object
        // is invisible to it — which is the same blind spot as a param that is validated and
        // then genuinely dropped. Say both names out loud.
        { altitude: args.altitude, response_format: args.response_format },
        RECALL_DEFAULT_ALTITUDE,
        'context_search'
      );

      // Direct lookup by ID - bypasses semantic search entirely
      if (args.id) {
        logger.info(`🔍 Context direct lookup by ID: ${args.id}`);

        // SHORT-ID SYMMETRY (T1 item 2): accept a full UUID OR an 8+-hex short id. A full
        // UUID looks up directly (back-compat); a short id is resolved project-scoped via
        // the SAME parameterized, wildcard-rejecting resolver every other tool uses, so a
        // tool-only agent can context_search by the id8 it copied from a list. Ambiguous /
        // unknown short ids surface as actionable errors and read nothing.
        let resolvedId: string;
        if (isFullUuid(args.id)) {
          resolvedId = args.id;
        } else {
          const projectIdForResolve = await this.resolveProjectId(args.projectId, context);
          try {
            resolvedId = await resolveEntityId('context', args.id, projectIdForResolve);
          } catch (e) {
            const handled = idErrorResponse(e, 'context_search', 'context', args.id, 'context_get_recent');
            if (handled) return handled;
            throw e;
          }
        }

        const result = await db.query(
          `SELECT id, project_id, session_id, context_type, content,
                  created_at, relevance_score, tags, metadata
           FROM contexts WHERE id = $1`,
          [resolvedId]
        );

        if (result.rows.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `Context not found: ${args.id}\n\nUse context_get_recent to see recent context IDs`
            }],
            structuredContent: { ok: true, results: [], total: 0 },
          };
        }

        const ctx = result.rows[0];
        const tags = ctx.tags?.length > 0 ? `\nTags: [${ctx.tags.join(', ')}]` : '';
        // METADATA ROUND-TRIP (tool-native linking): surface the structured back-links
        // a context carries (stored via context_store's metadata param) so the thread
        // resolves end-to-end through the tools alone — no SQL needed to read a link.
        const meta = typeof ctx.metadata === 'string' ? JSON.parse(ctx.metadata) : (ctx.metadata ?? {});
        const metadataText = meta && Object.keys(meta).length > 0
          ? `\nMetadata: ${JSON.stringify(meta)}`
          : '';

        // RECALL payload control (T1 item 1): a by-id lookup is the explicit "zoom to this
        // one" target, so it DEFAULTS to detailed (full body); it still honors an explicit
        // response_format ('concise' truncates with the affordance) for consistency.
        // A BY-ID LOOKUP IS THE ZOOM TARGET, so it defaults to `full` (the whole body)
        // REGARDLESS of the server's list default — that is what makes "the full record is
        // always reachable by id" true rather than aspirational, and it is the affordance
        // every clipped snippet points at. An EXPLICIT altitude is still honoured (a caller
        // who asks for a headline of one record has asked a coherent question).
        const byIdAltitude = resolveAltitude(
          { altitude: args.altitude, response_format: args.response_format },
          'full',
          'context_search'
        );
        const byIdPayload = projectBody(ctx.content, byIdAltitude, recallSnippetBudget(ctx.id));

        // TRUST (T2b — default-on): compute for this one record too, so a by-id zoom
        // carries the same trust signal as a list row.
        const [byIdTrust] = await this.trustForContextRows([{ id: ctx.id, createdAt: ctx.created_at }]);

        return {
          content: [{
            type: 'text',
            // WS1 (D2): machine-lean detail block — no banner, no emoji, no
            // permalink line (the /r/ URL rides structuredContent.url), terse trust signal.
            text: `ID: ${ctx.id}\n` +
                  `Type: ${ctx.context_type}\n` +
                  `Created: ${new Date(ctx.created_at).toISOString()}${tags}${metadataText}\n` +
                  `Relevance: ${ctx.relevance_score}/10\n` +
                  `${this.trustHint(byIdTrust)}\n\n` +
                  `---\n\n${byIdPayload.text}`
          }],
          // SEARCH shape (a by-id lookup is a 1-result search) — RAW values. The machine
          // channel carries the SAME (truncated-or-full) value the text shows + a truncated flag.
          structuredContent: {
            // ONE SERIALIZER. THE DIRECT-LOOKUP SHAPE (an earlier task round 2)
            // carries the COMPLETE trust verdict (projectTrustDirect), not the list `{band,
            // score}` — the "fetch by id for full detail" escape hatch an earlier decision promises.
            results: [serializeContext(mapContextRow(ctx), { body: byIdPayload, trust: projectTrustDirect(byIdTrust) })],
            total: 1,
            // WHICH DIAL ANSWERED — the by-id path resolves its OWN default
            // (`full`, the zoom target), so echoing the LIST altitude here would be a lie.
            // This is byIdAltitude, the one that actually shaped this response.
            altitude: byIdAltitude,
          },
        };
      }

      // FAIL LOUD on a reserved arg-name prefix typed into `query`.
      //
      // `query: 'id:<uuid>'` used to degrade SILENTLY to semantic noise and hand back a
      // confident WRONG record — the worst failure shape we ship. It is checked HERE,
      // after the by-id branch (so a correct `id` call with a stray query still works) and
      // before every path that would search, so no reserved-prefix query can reach the
      // ranker on any branch. This ERRORS; it deliberately does NOT parse the value and
      // resolve it — there is no query DSL, by design (see config/searchConfig.ts).
      const reservedPrefix = reservedArgPrefixInQuery(args.query, 'context_search');
      if (reservedPrefix) {
        logger.info(`🚫 Context search rejected reserved-prefix query: "${args.query}"`);
        return {
          content: [{ type: 'text', text: reservedArgPrefixMessage(reservedPrefix, args.query, 'context_search') }],
          isError: true,
          structuredContent: {
            ok: false,
            error: 'reserved_query_prefix',
            reservedArg: reservedPrefix,
            query: args.query,
          },
        };
      }

      // TAGS-ONLY lookup: no id and no query, but a non-empty tags array. The
      // semantic searchContext() path REQUIRES a query (it embeds request.query),
      // so a tags-only request is answered here by the existing `tags && $1` GIN
      // filter directly — NO dummy query needed. This does NOT touch the semantic
      // ranking/scoring (the out-of-scope MEASURED tranche): it is a straight tag
      // filter ordered newest-first.
      //
      // NAMED-REF RESOLUTION (first-class): this is the canonical way to resolve a
      // `ref:<slug>` — `context_search({ tags: ["ref:<slug>"] })`. The
      // `ORDER BY created_at DESC` below is load-bearing for a MOVING ref: when
      // several contexts share the same slug (e.g. `ref:resume`, re-stamped on each
      // handoff), the NEWEST wins, so "read in on ref:resume" always lands on the
      // latest. A PINNED ref (one context) resolves to that single thread. This
      // ordering is contract-tested (namedRefs.contract.test.ts) — do not change it
      // to a score-ordered sort without updating that fuse.
      if (!args.query && Array.isArray(args.tags) && args.tags.length > 0) {
        const projectId = await this.resolveProjectId(args.projectId, context);
        logger.info(`🔍 Context tags-only search: [${args.tags.join(', ')}]`);

        // SINGLE SOURCE OF TRUTH for the tags-only filter set: build the
        // WHERE clause + its params ONCE and feed BOTH the page query (WHERE + ORDER +
        // LIMIT/OFFSET) and the COUNT (WHERE only, no LIMIT) so `total` can never drift
        // from the page's filter set. The old bug reported the LIMIT-capped
        // page length (`tagStructured.length`) as `total`.
        const whereParams: any[] = [args.tags];
        let whereSql = `WHERE tags && $1`;
        // SOFT-DELETE: exclude archived by default on the tags-only path too.
        if (!args.includeArchived) {
          whereSql += ` AND archived_at IS NULL`;
        }
        let pIdx = 2;
        if (projectId) {
          whereSql += ` AND project_id = $${pIdx}`;
          whereParams.push(projectId);
          pIdx++;
        }
        if (args.type) {
          whereSql += ` AND context_type = $${pIdx}`;
          whereParams.push(args.type);
          pIdx++;
        }
        // SESSION on the tags-only path. Same defect as the created_at range below and
        // found by sweeping context_search's DECLARED keyset against what this branch
        // actually reads: `sessionId` was validated, accepted, and never applied, so a
        // caller asking for one session's tagged records got every session's. Same
        // predicate as the semantic branch's buildContextSearchFilters
        // (`session_id = $n`). Fused by contextSearchTagsOnlyDateRange.contract.test.ts.
        if (args.sessionId) {
          whereSql += ` AND session_id = $${pIdx}`;
          whereParams.push(args.sessionId);
          pIdx++;
        }
        // CREATED_AT RANGE on the tags-only path. `dateFrom`/`dateTo` are DECLARED on
        // context_search and the tool runs STRICT (an undeclared key is rejected), so a
        // caller who passes them has every reason to believe they applied — but this
        // branch never read them, and returned a full page of rows outside the range.
        // Accepted-validated-and-inert is the worst shape we ship: the answer is
        // confident, plausible and wrong. Same predicates and same inclusive semantics as
        // the semantic branch's buildContextSearchFilters (`created_at >= dateFrom`,
        // `created_at <= dateTo`), so the documented contract means one thing on both
        // paths. Fused by contextSearchTagsOnlyDateRange.contract.test.ts.
        // Appended to `whereSql`, so the page AND the COUNT below share it — `total`
        // cannot drift from the page's filter set.
        if (args.dateFrom) {
          whereSql += ` AND created_at >= $${pIdx}`;
          whereParams.push(args.dateFrom);
          pIdx++;
        }
        if (args.dateTo) {
          whereSql += ` AND created_at <= $${pIdx}`;
          whereParams.push(args.dateTo);
          pIdx++;
        }

        // Page query: the shared WHERE + newest-first ordering + LIMIT/OFFSET. The page
        // and the COUNT below are drawn from the SAME `whereSql`/`whereParams`, so a
        // predicate added above (e.g. the created_at range) reaches both by construction.
        const params: any[] = [...whereParams];
        let sql = `SELECT id, project_id, session_id, context_type, content,
                          created_at, relevance_score, tags, metadata
                   FROM contexts
                   ${whereSql}`;
        // `id DESC` makes the sort TOTAL. `created_at` alone is a partial
        // order — several handoffs stamped in the same instant tie, and the OFFSET below
        // then pages over an undefined order and can repeat or drop a row. The PK is unique,
        // stable under edits, and already indexed.
        sql += ` ORDER BY created_at DESC, id DESC LIMIT $${pIdx}`;
        params.push(args.limit && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 10);
        pIdx++;
        if (args.offset && Number.isInteger(args.offset) && args.offset > 0) {
          sql += ` OFFSET $${pIdx}`;
          params.push(args.offset);
          pIdx++;
        }

        const tagResult = await db.query(sql, params);

        if (tagResult.rows.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No contexts found with tags: [${args.tags.join(', ')}]`
            }],
            structuredContent: { ok: true, results: [], total: 0 },
          };
        }

        const tagSummary = `Found ${tagResult.rows.length} contexts with tags [${args.tags.join(', ')}]\n\n`;
        // TRUST (T2b — default-on): computed per returned row, AFTER the existing
        // newest-first ordering (display-only; trust is not yet a ranker).
        const tagTrusts = await this.trustForContextRows(
          tagResult.rows.map((row) => ({ id: row.id, createdAt: row.created_at }))
        );
        // RAW structured rows for the machine channel (parsed metadata, no markup). RECALL
        // payload control (T1 item 1): carry the (truncated-or-full) content consistently
        // + a `truncated` flag, matching the text channel.
        // ONE SERIALIZER: rows map through mapContextRow, bodies through the
        // altitude dial (absent at `headline`), trust reduced to the list shape.
        const tagStructured = tagResult.rows.map((row, index) =>
          serializeContext(mapContextRow(row), {
            body: projectBody(row.content, altitude, recallSnippetBudget(row.id)),
            trust: projectTrust(tagTrusts[index]),
          })
        );
        const tagList = tagResult.rows.map((row, index) => {
          const timeAgo = this.getTimeAgo(row.created_at);
          // Surface each thread member's structured back-links (metadata) so a thread
          // fetched by its `task:`/`ref:` tag resolves end-to-end via tools alone.
          const meta = tagStructured[index].metadata as Record<string, unknown>;
          const metaLine = meta && Object.keys(meta).length > 0
            ? `\n   Metadata: ${JSON.stringify(meta)}`
            : '';
          // Same (truncated-or-full) content as the machine channel — ONE dial, BOTH channels.
          // At `headline` there is NO Content line at all. WS1 (D2): no bold
          // markup, no per-row permalink line (structuredContent.url carries it).
          const contentLine = tagStructured[index].content !== undefined
            ? `   Content: ${tagStructured[index].content}\n`
            : '';
          return `${index + 1}. ${row.context_type} (${timeAgo})\n` +
                 contentLine +
                 `   ${this.trustHint(tagTrusts[index])}\n` +
                 `   Tags: [${(row.tags || []).join(', ')}]${metaLine}\n` +
                 `   ID: ${row.id}`;
        }).join('\n\n');

        // REAL match count over the SAME WHERE (no LIMIT).
        // SOFT-DELETE-VIA: whereSql — the archived predicate is INSIDE it, appended above
        // when args.includeArchived is falsy. This count exists precisely to run the SAME
        // WHERE as the page with no LIMIT; duplicating the predicate here
        // would create the drift it was added to remove.
        const tagTotal = (await db.query(
          `SELECT COUNT(*)::int AS count FROM contexts ${whereSql}`,
          whereParams
        )).rows[0]?.count ?? 0;

        return {
          content: [{
            type: 'text',
            text: tagSummary + tagList
          }],
          structuredContent: { results: tagStructured, total: tagTotal, altitude },
        };
      }

      logger.info(`🔍 Context search request: "${args.query}"`);

      const projectId = await this.resolveProjectId(args.projectId, context);
      const results = await contextHandler.searchContext({
        query: args.query,
        type: args.type,
        tags: args.tags,
        limit: args.limit,
        offset: args.offset,
        minSimilarity: args.minSimilarity,
        projectId: projectId,
        includeArchived: args.includeArchived, // default exclude archived
        // ADDITIVE structured filters: forwarded to the one engine.
        sessionId: args.sessionId,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo
      });

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No contexts found matching: "${args.query}"\n\n` +
                  `Try:\n` +
                  `- Broader search terms\n` +
                  `- Different context types\n` +
                  `- Lower similarity threshold\n` +
                  `- Different tags`
          }],
          structuredContent: { ok: true, results: [], total: 0 },
        };
      }

      // DISPLAY CONSISTENCY: show `relevance` — the sort-key score
      // the row actually ranked on — NOT raw vector `similarity`, so the displayed
      // number agrees with the order (#1 is always the highest). `relevance` falls
      // back to `similarity` (baseline mode emits them equal).
      const relevanceOf = (r: typeof results[number]): number =>
        r.relevance !== undefined ? r.relevance
        : r.similarity !== undefined ? r.similarity
        : 0;

      // HONESTY FLOOR: if the BEST row is below the floor, prepend an
      // honest header instead of presenting low-relevance rows as confident. Uses the
      // SAME relevance number as the sort key, so the header agrees with row #1.
      const honestyHeader = buildHonestyHeader(relevanceOf(results[0]));

      const searchSummary = `Found ${results.length} matching contexts for: "${args.query}"\n\n`;
      // TRUST (T2b — default-on): computed per returned row, AFTER existing ranking
      // (display-only; trust is surfaced, not yet a ranker — order is unchanged).
      const searchTrusts = await this.trustForContextRows(
        results.map((r) => ({ id: r.id, createdAt: r.createdAt }))
      );
      // RECALL payload control (T1 item 1): truncate each content per the resolved format,
      // computed ONCE so the text + machine channels carry the SAME value + truncated flag.
      const payloads = results.map((result) =>
        projectBody(result.content, altitude, recallSnippetBudget(result.id))
      );
      const resultsList = results.map((result, index) => {
        const timeAgo = this.getTimeAgo(result.createdAt);
        const relevance = relevanceOf(result);
        // WS1 (D2): no bold markup, no per-row permalink line
        // (structuredContent.url carries it), terse trust signal.
        // THE SAME projected body the machine channel carries — ONE dial, BOTH channels.
        // At `headline` there is NO Content line at all: an empty one reads as "this record
        // has no content", which is a different and false claim.
        const contentLine = payloads[index].present ? `   Content: ${payloads[index].text}\n` : '';
        return `${index + 1}. ${result.contextType} (relevance: ${relevance.toFixed(1)}%, ${timeAgo})\n` +
               contentLine +
               `   ${this.trustHint(searchTrusts[index])}\n` +
               `   Tags: [${result.tags.join(', ')}]\n` +
               `   ID: ${result.id}`;
      }).join('\n\n');

      // REAL match count over the SAME hard-filter set: `total` must be
      // the count of ALL contexts matching the search filters, NOT the LIMIT-capped page.
      // The old bug returned `results.length` (the paginated page), so `total` silently
      // maxed out at `limit`. countContext() reuses the SAME filter builder searchContext
      // uses, so it can't drift from the page's filter set. It counts the
      // rankable candidate set (embedded rows passing the hard filters) — exactly the set
      // this offset-paginating tool pages through.
      const total = await contextHandler.countContext({
        // `query` is passed for the RETRIEVAL GATE only, never for ranking:
        // an id-shaped query relaxes the `embedding IS NOT NULL` gate to admit the
        // un-embedded row the user asked for by id, so the COUNT must apply the SAME gate
        // the page did or `total` would read 0 while the page shows the hit (a past incident —
        // the page and its count must never be two drifting copies).
        query: args.query,
        type: args.type,
        tags: args.tags,
        projectId,
        includeArchived: args.includeArchived,
        sessionId: args.sessionId,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      });

      return {
        content: [{
          type: 'text',
          text: (honestyHeader ? honestyHeader + '\n\n' : '') + searchSummary + resultsList
        }],
        // RAW structured rows (no markup, no honesty-header prose) — the machine channel.
        // METADATA SURFACE (T1 item 3): include `metadata` so written back-links are
        // readable from a semantic search (it was indexed + stored but never returned here).
        structuredContent: {
          // ONE SERIALIZER. Ranking numbers (relevance = the sort key the row
          // ranked on, similarity = raw vector component) ride only this branch.
          results: results.map((result, index) =>
            serializeContext(result, {
              body: payloads[index],
              ranking: { relevance: relevanceOf(result), similarity: result.similarity },
              trust: projectTrust(searchTrusts[index]),
            })
          ),
          total,
          // WHICH DIAL ANSWERED (SEARCH P3 follow-up). Without this a caller
          // reading a clipped record cannot tell a SHORT record from a CLIPPED one, and the
          // safe response to that ambiguity is to re-fetch — so an absent echo silently
          // teaches agents to double-fetch, which is the opposite of the point. smart_search
          // and recall_thread already echoed it; these two did not.
          altitude,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_search');
    }
  }

  /**
   * Handle context get recent requests
   */
  async handleGetRecent(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      logger.info(`📋 Context get recent request (limit: ${args.limit || 5}, project: ${projectId?.substring(0, 8)}...)`);

      // RECALL payload control (T1 item 1): the boot path. Default 'concise' (truncate) so
      // a fresh-session recall doesn't dump full bodies ×N into the model window.
      // THE ONE VOLUME DIAL (SEARCH P3) — same semantics as context_search,
      // same deprecated `response_format` alias, same config-derived default.
      const altitude = resolveAltitude(
        { altitude: args.altitude, response_format: args.response_format },
        RECALL_DEFAULT_ALTITUDE,
        'context_get_recent'
      );

      const results = await contextHandler.getRecentContext(projectId, args.limit, args.includeArchived);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No recent contexts found\n\n` +
                  `This usually means:\n` +
                  `- No contexts have been stored yet\n` +
                  `- Wrong project selected\n` +
                  `- Database connectivity issues`
          }],
          structuredContent: { ok: true, results: [], total: 0 },
        };
      }

      // RECALL payload control (T1 item 1): compute payloads ONCE so text + machine
      // channels agree (truncated value + flag).
      const payloads = results.map((ctx) => projectBody(ctx.content, altitude, recallSnippetBudget(ctx.id)));

      // TRUST (T2b — default-on): the BOOT path carries trust too, so a fresh-session
      // "read me in" knows which recalled records to lean on. Per-row, after ordering.
      const recentTrusts = await this.trustForContextRows(
        results.map((ctx) => ({ id: ctx.id, createdAt: ctx.createdAt }))
      );

      // Format results for display
      const contextList = results.map((ctx, index) => {
        const timeAgo = this.getTimeAgo(ctx.createdAt);

        // WS1 (D2): no bold markup, no per-row permalink line
        // (structuredContent.url carries it), terse trust signal.
        // THE SAME projected body the machine channel carries — ONE dial, BOTH channels.
        // At `headline` there is NO Content line at all: an empty one reads as "this record
        // has no content", which is a different and false claim.
        const contentLine = payloads[index].present ? `   Content: ${payloads[index].text}\n` : '';
        return `${index + 1}. ${ctx.contextType} (${timeAgo})\n` +
               contentLine +
               `   ${this.trustHint(recentTrusts[index])}\n` +
               `   Tags: [${ctx.tags.join(', ')}]\n` +
               `   ID: ${ctx.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Recent Contexts (${results.length} found)\n\n${contextList}`
        }],
        structuredContent: {
          // ONE SERIALIZER; body through the altitude dial.
          results: results.map((ctx, index) =>
            serializeContext(ctx, { body: payloads[index], trust: projectTrust(recentTrusts[index]) })
          ),
          // INTENTIONAL total == returned (an earlier task evaluation): context_get_recent is a
          // deliberately-capped "most recent N" window (getRecentContext → ORDER BY
          // created_at DESC LIMIT $2), NOT a filtered query the caller pages through. `total`
          // is the size of the recent window itself, so total == results.length is correct by
          // construction. "How many contexts exist in total" is a different question answered
          // by context_stats.totalContexts, not by this recent-window read.
          total: results.length,
          // WHICH DIAL ANSWERED (SEARCH P3 follow-up). Without this a caller
          // reading a clipped record cannot tell a SHORT record from a CLIPPED one, and the
          // safe response to that ambiguity is to re-fetch — so an absent echo silently
          // teaches agents to double-fetch, which is the opposite of the point. smart_search
          // and recall_thread already echoed it; these two did not.
          altitude,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_get_recent');
    }
  }

  /**
   * Handle context statistics requests
   */
  async handleStats(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      // SOFT-DELETE: archived contexts are EXCLUDED by default so these
      // counts reconcile with context_search. Same param name + meaning as context_search.
      const includeArchived = args.includeArchived === true;
      logger.info(`📊 Context stats request received (project: ${projectId?.substring(0, 8)}..., includeArchived: ${includeArchived})`);

      const stats = await contextHandler.getContextStats(projectId, includeArchived);

      const typeBreakdown = Object.entries(stats.contextsByType)
        .map(([type, count]) => `   ${type}: ${count}`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `Context Statistics\n\n` +
                (includeArchived
                  ? `Population: ALL contexts, INCLUDING archived (includeArchived: true)\n`
                  : `Population: live contexts (archived excluded — matches context_search)\n`) +
                `Total Contexts: ${stats.totalContexts}\n` +
                `With Embeddings: ${stats.embeddedContexts}\n` +
                `Recent (24h): ${stats.recentContexts}\n\n` +
                `By Type:\n${typeBreakdown || '   (no contexts yet)'}`
        }],
        structuredContent: {
          totalContexts: stats.totalContexts,
          embeddedContexts: stats.embeddedContexts,
          recentContexts: stats.recentContexts,
          contextsByType: stats.contextsByType,
          // an earlier task — declare which population these numbers describe, so a reader
          // never has to guess whether archived rows are in or out (the exact ambiguity
          // that made the decision_stats 556-vs-127 split unreadable).
          includeArchived,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_stats');
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
   * Handle context SOFT-DELETE (archive) requests — context_delete.
   *
   * Sets archived_at so the context disappears from default context_search /
   * context_get_recent while STILL EXISTING in the DB (reversible via context_restore).
   * Accepts a full UUID or 8+-hex short id, resolved project-scoped BEFORE the mutation;
   * ambiguous / unknown ids surface as actionable errors and mutate nothing. Idempotent.
   */
  async handleDelete(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.requireProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('context', args.contextId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'context_delete', 'context', args.contextId, 'context_get_recent');
        if (handled) return handled;
        throw e;
      }

      const result = await contextHandler.archiveContext(resolvedId, projectId);
      if (!result.found) {
        return {
          content: [{ type: 'text',
            text: `Context not found: ${args.contextId}\n\n` +
                  `Use context_get_recent to see this project's contexts and copy an ID.` }],
          isError: true,
          structuredContent: { ok: false, found: false },
        };
      }
      const verb = result.alreadyArchived ? 'was already archived' : 'archived';
      return {
        content: [{ type: 'text',
          text: `Context ${verb} (soft-delete) — ${result.id}\n` +
                `Hidden from search/recent but NOT deleted. Restore with: context_restore(contextId="${result.id}")` }],
        structuredContent: {
          action: 'archived',
          // ONE SERIALIZER: the archived record itself (archivedAt rides it),
          // not an `{id, archivedAt}` receipt the output schema never described.
          context: serializeContext((await contextHandler.getContextById(resolvedId, projectId))!),
          alreadyArchived: result.alreadyArchived === true,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_delete');
    }
  }

  /**
   * Handle context RESTORE (un-archive) requests — context_restore.
   * Clears archived_at so the context returns to default search/recent. Mirror of delete.
   */
  async handleRestore(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.requireProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('context', args.contextId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'context_restore', 'context', args.contextId, 'context_get_recent');
        if (handled) return handled;
        throw e;
      }

      const result = await contextHandler.restoreContext(resolvedId, projectId);
      if (!result.found) {
        return {
          content: [{ type: 'text',
            text: `Context not found: ${args.contextId}\n\n` +
                  `Use context_search(includeArchived:true) to see archived contexts and copy an ID.` }],
          isError: true,
          structuredContent: { ok: false, found: false },
        };
      }
      const verb = result.alreadyArchived ? 'was already live (not archived)' : 'restored';
      return {
        content: [{ type: 'text',
          text: `Context ${verb} — ${result.id}` }],
        structuredContent: {
          action: 'restored',
          context: serializeContext((await contextHandler.getContextById(resolvedId, projectId))!),
          alreadyArchived: result.alreadyArchived === true,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_restore');
    }
  }

  /**
   * Handle context UPDATE (edit) requests — context_update (CURATE, T1 item 4).
   *
   * Edits a stored context: content, tags (re-tag/re-thread), metadata (MERGE — null
   * deletes a key, T1 item 6), relevanceScore. Accepts a full UUID or 8+-hex short id,
   * resolved project-scoped BEFORE the mutation; ambiguous / unknown ids surface as
   * actionable errors and mutate nothing. The whole edit is project-scoped (never edits
   * another project's context). Tag-normalization warnings are surfaced (warn-only).
   */
  async handleUpdate(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.requireProjectId(args.projectId, context);
      let resolvedId: string;
      try {
        resolvedId = await resolveEntityId('context', args.contextId, projectId);
      } catch (e) {
        const handled = idErrorResponse(e, 'context_update', 'context', args.contextId, 'context_get_recent');
        if (handled) return handled;
        throw e;
      }

      const result = await contextHandler.updateContext({
        contextId: resolvedId,
        projectId,
        content: args.content,
        tags: args.tags,
        metadata: args.metadata,
        relevanceScore: args.relevanceScore,
      });

      if (!result.found || !result.context) {
        return {
          content: [{ type: 'text',
            text: `Context not found: ${args.contextId}\n\n` +
                  `Use context_get_recent to see this project's contexts and copy an ID.` }],
          isError: true,
          structuredContent: { ok: false, found: false },
        };
      }

      const ctx = result.context;
      // Report exactly which fields were edited (RAW). metadata shows the MERGED result.
      const applied: string[] = [];
      if (args.content !== undefined) applied.push('content');
      if (args.tags !== undefined) applied.push('tags');
      if (args.metadata !== undefined) applied.push('metadata');
      if (args.relevanceScore !== undefined) applied.push('relevanceScore');
      const warnText = result.warnings && result.warnings.length > 0
        ? `\nTag notes:\n` + result.warnings.map(w => `   - ${w}`).join('\n')
        : '';

      return {
        content: [{
          type: 'text',
          text: `Context updated — ${ctx.id}\n` +
                `Edited: ${applied.join(', ')}\n` +
                `Tags: [${ctx.tags.join(', ')}]` +
                (ctx.metadata && Object.keys(ctx.metadata).length > 0
                  ? `\nMetadata: ${JSON.stringify(ctx.metadata)}` : '') +
                warnText,
        }],
        structuredContent: {
          action: 'updated',
          // ONE SERIALIZER: the edited record, whole; metadata is the MERGED result.
          context: serializeContext(ctx, { extras: { warnings: result.warnings ?? [] } }),
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_update');
    }
  }
}

export const contextRoutes = new ContextRoutes();
