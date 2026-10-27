import { projectHandler } from '../handlers/project.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import { recordUrl, isResolvableRecordType } from '../config/commandUrlConfig.js';
import type { RouteContext } from './index.js';
import {
  buildThread,
  AnchorUnresolvableError,
  type ThreadResult,
  type ThreadNode,
} from '../services/recallThread.js';
import {
  THREAD_DEFAULT_ALTITUDE,
  isProjectionAltitude,
  type ThreadAltitude,
} from '../config/threadConfig.js';
import { type TrustBand } from '../config/trustConfig.js';
import { REVIEW_OUTCOME_LABEL } from '../config/reviewOutcomeConfig.js';
import { GATE_RC_LABEL } from '../config/gateExitCodeConfig.js';
import { projectTrust } from '../services/altitudeProjection.js';
import { explainTrust } from '../services/trust.js';
import type { EdgeType } from '../config/edgeTypes.js';
import { buildCurrentState, type CurrentStateResult } from '../services/currentState.js';
import type { CurrentStateNode, CurrentStateSection } from '../services/currentStateCore.js';

/**
 * recall_thread route (Mandrel Core Redesign T3) — THE headline pull tool.
 *
 * "Read me in on the story of X, at altitude Y, and tell me what to trust." ONE call:
 * resolve the anchor → traverse the typed-edge graph (both directions, cycle-safe, capped)
 * → trust-annotate every node (the moat) → order causally+temporally → shape to altitude →
 * surface the abstain list. Returns BOTH a clean structuredContent thread AND a text
 * channel that reads top-to-bottom as the story (so a consuming agent can narrate it
 * directly). DETERMINISTIC — no server-side LLM (Mandrel runs in customer containers).
 *
 * Pattern matches the rest of the surface: zod strict → route → derived inputSchema →
 * structuredContent; actionable errors; project-scoped; parameterized SQL (in the service).
 */
class RecallRoutes {
  private async resolveProjectId(
    argsProjectId: string | undefined,
    context?: RouteContext
  ): Promise<string | undefined> {
    if (argsProjectId) return argsProjectId;
    const sessionId = context?.connectionId || 'default-session';
    await projectHandler.initializeSession(sessionId);
    // PROJECT-SCOPE: effective — a route's own project resolution. Under a binding this is
    // the bound project; unbound it is rung 3, exactly as before.
    const projectId = await projectHandler.getCurrentProjectId(sessionId);
    return projectId || undefined;
  }

  /**
   * recall_thread — the consolidated traverse + trust + narrate operation. One call; no
   * traverse-then-fetch dance. An unresolvable/ambiguous anchor is an ACTIONABLE error
   * (mutates nothing); an anchor with NO edges returns just the anchor node (not an error).
   */
  async handleRecallThread(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args.projectId, context);
      const altitude: ThreadAltitude = args.altitude ?? THREAD_DEFAULT_ALTITUDE;
      const gatherArgs = {
        anchor: args.anchor,
        edgeTypes: args.edgeTypes as EdgeType[] | undefined,
        depth: args.depth,
        maxNodes: args.maxNodes,
        minTrust: args.minTrust as TrustBand | number | undefined,
        projectId,
      };

      // ALTITUDE AXIS DISPATCH. `headline|summary|full` are ZOOM levels on
      // one ordered story; `current` is a PROJECTION — a different read model with a
      // different answer shape. Dispatching here (rather than letting a projection altitude
      // reach shapeNode) is why shapeNode can afford to throw on an off-axis value instead of
      // quietly defaulting to `summary`.
      if (isProjectionAltitude(altitude)) {
        let state: CurrentStateResult;
        try {
          state = await buildCurrentState(gatherArgs);
        } catch (e) {
          if (e instanceof AnchorUnresolvableError) {
            return {
              content: [{ type: 'text', text: `recall_thread: ${e.message}` }],
              isError: true,
              structuredContent: { ok: false, found: false },
            };
          }
          throw e;
        }
        return {
          content: [{ type: 'text', text: renderCurrentStateText(state) }],
          structuredContent: {
            ok: true,
            anchor: state.anchor,
            altitude,
            // THE SHAPE DISCRIMINATOR. This response has NO `nodes` key and
            // no `edges` key — it is the current-state projection, a different answer shape
            // reached through the same tool. It deliberately does NOT emit `nodes: []`: the
            // walk really did examine nodes (counts.examined), so an empty array would be a
            // LIE, and the harness that read `nodes.length` here and reported "0 nodes for
            // 16k chars" would have been confirmed in its error instead of corrected.
            shape: 'currentState',
            depthUsed: state.depthUsed,
            currentState: {
              root: state.root ? withUrl(state.root) : null,
              activeTasks: sectionWithUrls(state.activeTasks),
              blockers: sectionWithUrls(state.blockers),
              latestTrustedOutcomes: sectionWithUrls(state.latestTrustedOutcomes),
              // The recency door — non-trust-gated, on the structured
              // channel too, so a client that drops `content` still learns what just landed.
              recentContexts: sectionWithUrls(state.recentContexts),
              currentDecisions: sectionWithUrls(state.currentDecisions),
              // an earlier task — how many of those standing decisions were never built.
              halfExecutedDecisions: state.halfExecutedDecisions,
              artifactHead: state.artifactHead,
              artifactIssues: state.artifactIssues,
              nextAction: state.nextAction,
              omitted: state.omitted,
              counts: state.counts,
            },
            truncated: state.truncated,
            truncatedCount: state.truncatedCount,
            maxNodesUsed: state.maxNodesUsed,
            maxNodesRequested: state.maxNodesRequested,
            // The GATHER's drops — records this projection never saw, as opposed to the ones
            // it saw and chose not to list (currentState.omitted). Two subtractions, two
            // numbers.
            omissions: state.omissions,
            total: state.counts.listed,
          },
        };
      }

      let result: ThreadResult;
      try {
        // NO CAST (Reviewer N1): BuildThreadArgs.altitude is now typed
        // ThreadContentAltitude, and TS has already narrowed `altitude` to exactly that by
        // this line via the isProjectionAltitude early return above. The compiler enforces
        // the axis split; shapeNode's throw is the backstop for callers it cannot see.
        result = await buildThread({ ...gatherArgs, altitude });
      } catch (e) {
        if (e instanceof AnchorUnresolvableError) {
          return {
            content: [{ type: 'text', text: `recall_thread: ${e.message}` }],
            isError: true,
            structuredContent: { ok: false, found: false },
          };
        }
        throw e;
      }

      // ONE rendering of the prose. It used to be reused as the evidence the `lean` structured
      // trim read to decide whether a body was already carried (an earlier task (b)); that trim
      // is deleted (an earlier task — the mode folded into `altitude`), so this is now simply
      // the response's text channel, rendered once.
      const prose = renderThreadText(result);
      return {
        content: [{ type: 'text', text: prose }],
        structuredContent: {
          ok: true,
          anchor: result.anchor,
          altitude: result.altitude,
          // TWO ANSWER SHAPES, ONE TOOL — say which one this is. `altitude`
          // was always the discriminator, but only implicitly: a consumer had to know the
          // altitude taxonomy to know whether to look for `nodes` or `currentState`. Our own
          // measuring harness did not, read `nodes.length` on a `current` response, and
          // reported 0 nodes for a walk that examined 49 — the instrument lied, not the
          // product. An explicit discriminator makes that mistake unmakeable.
          shape: 'thread',
          depthUsed: result.depthUsed,
          // STRUCTURED PERMALINK: attach each node's /r/<id8> link, mirroring
          // the text headline's ref. Gated on the resolvable set exactly as the text sweep
          // does — a future non-resolvable node type gets null, never a 404 link. Additive
          // (spreads the node, adds `url`); the pre-existing node fields are untouched.
          nodes: result.nodes.map((n) => shapeStructuredNode(n)),
          // EDGES ARE NEVER TRIMMED, in either mode. The prose channel prints no edge at
          // all, so this array is the ONLY place the graph exists — trimming it would not be
          // a trim, it would be a silent amputation of the thing the tool is for.
          edges: result.edges,
          abstain: result.abstain, // trust-render-exempt: passes the thread-level abstain LIST of ids through to structuredContent
          truncated: result.truncated,
          truncatedCount: result.truncatedCount,
          // The node cap actually applied — the number a caller needs to reason about a
          // truncated thread (and the honest report when their requested maxNodes was
          // clamped down to maxNodesCeiling).
          maxNodesUsed: result.maxNodesUsed,
          // The cap the caller ASKED for — the other half of the clamp story.
          maxNodesRequested: result.maxNodesRequested,
          // WHAT THIS WALK DROPPED, machine-readable: the same three subtractions the prose
          // `Omitted:` line states, plus the presentation-level clip count.
          omissions: { ...result.omissions, clippedNodes: result.clippedNodes },
          total: result.nodes.length,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'recall_thread');
    }
  }
}

/**
 * Render the thread as the ordered story (the text channel). Reads top-to-bottom: each node
 * is a numbered line with its type + trust band; at summary/full its content rides beneath.
 * An honest header carries the anchor, altitude, abstain count and truncation signal so the
 * agent narrating it has the whole frame.
 */
const STORY_BODY_INDENT = '   ';

/**
 * THE TRUNCATION NOTICE — three honest cases, and no fourth.
 *
 *   1. a resumption value EXISTS → name it, and say what it buys.
 *   2. the branch is bigger than any cap this server honours → say so, and name the two knobs
 *      that CAN shrink a walk. Naming a maxNodes here would be a lie by clamping: the server
 *      would cut it back down and truncate again.
 *   3. the count could not be finished (a read failed) → say the number is a lower bound.
 *
 * Cases 2 and 3 both refuse to print "re-call with maxNodes: N", which is the whole point:
 * the defect was not a wrong number, it was a number rendered where none was known. Each case
 * is driven by the engine's own account of how its counting walk ended, so the prose cannot
 * assert completeness the walk never had.
 */
export function truncationNotice(r: ThreadResult): string {
  if (!r.truncated) return '';
  if (r.resumeMaxNodes !== null) {
    return ` (truncated — ${r.truncatedCount} more reachable; re-call with maxNodes: ${r.resumeMaxNodes} for the whole branch, or narrow edgeTypes)`;
  }
  if (r.truncationCountStop === 'ceiling') {
    return ` (truncated — at least ${r.truncatedCount} more reachable; the branch is larger than this server's per-call node ceiling, so NO maxNodes returns it — narrow edgeTypes or lower depth)`;
  }
  return ` (truncated — at least ${r.truncatedCount} more reachable; a read failed mid-walk so that is a LOWER BOUND, not a count — re-call with a larger maxNodes, or narrow edgeTypes)`;
}

// EXPORTED so the review-outcome contract test drives the SHIPPED
// renderer. The alternative in this repo — a test that re-composes the node line itself —
// is a test of a string its author typed, and would stay green over a deleted stamp.
export function renderThreadText(r: ThreadResult): string {
  const lines: string[] = [];
  lines.push(
    `Thread for ${r.anchor} — altitude:${r.altitude}, depth:${r.depthUsed}, ${r.nodes.length} node(s)` +
      // ACTIONABLE, IN-TOOL: the old hint named an ENV VAR, which a customer running Mandrel
      // in a per-tenant container cannot set. Name the argument and the exact value instead,
      // so a truncated thread is one re-call from complete.
      //
      // AND THE VALUE MUST BE ONE THAT WORKS. This used to render
      // `r.nodes.length + r.truncatedCount` — arithmetic the renderer performed on a number
      // that was a FLOOR (the walk stopped at the cap, so nothing reachable past the
      // overflowing level was ever counted) and a list length that is POST-filter. Following
      // it returned a still-truncated thread. The engine now decides whether a resumption
      // value exists at all; the renderer only reports what it decided, and when there is no
      // such value it says that plainly instead of naming a number that reads as sufficient.
      truncationNotice(r)
  );
  if (r.abstain.length > 0) { // trust-render-exempt: the thread-level abstain LIST count, not a per-record trust marker
    lines.push(`Do NOT rely on ${r.abstain.length} node(s): ${r.abstain.join(', ')}`); // trust-render-exempt: the thread-level 'do not rely on these N nodes' list, not a per-record marker
  }
  // THE CEILING CLAMP, IN PROSE: a caller asking maxNodes:900 gets 500. Until
  // now that was visible ONLY by comparing the argument you sent against `maxNodesUsed` in the
  // structured channel — which a reader of the text channel cannot do.
  if (r.maxNodesRequested > r.maxNodesUsed) {
    lines.push(
      `Requested maxNodes: ${r.maxNodesRequested} — CAPPED to ${r.maxNodesUsed} (server ceiling); ` +
        `narrow edgeTypes or lower depth to fit more of the branch under the cap`
    );
  }
  lines.push(threadOmittedLine(r));
  lines.push('');

  r.nodes.forEach((n, i) => {
    lines.push(`${i + 1}. ${nodeHeadline(n)}`);
    if (n.content) {
      // Indent the body so the story reads as a list with sub-content.
      for (const bodyLine of n.content.split('\n')) lines.push(`${STORY_BODY_INDENT}${bodyLine}`);
    }
  });

  return lines.join('\n');
}

/**
 * THE HONESTY LINE for the story path — what this walk threw away, and how
 * to get it back, naming ARGUMENTS (a container customer cannot set an env var).
 *
 * ALWAYS PRINTED, INCLUDING AT ZERO. That is the whole contract: a reader must be able to
 * tell "nothing was dropped" from "11 nodes were dropped", and an absent line is not an
 * answer — it is a line the reader has to notice is missing. This is the same rule the
 * current-state renderer already holds itself to, applied to the path where it was missing.
 *
 * THE RECONCILIATION IS PRINTED, not just the counts, because the counts alone cannot be
 * checked by the reader: `listed + trust-floor + dangling = examined` is what proves the
 * header's "N node(s)" is not silently conflating the cap with the trust floor — the exact
 * defect this line exists to end (14 listed, truncatedCount:25, 11 nodes gone unmentioned).
 */
function threadOmittedLine(r: ThreadResult): string {
  const o = r.omissions;
  const lines = [
    `Omitted: ${o.droppedByMinTrust} below the minTrust floor` +
      (o.droppedByMinTrust > 0 ? ' (re-call with a lower minTrust to include them)' : '') +
      `, ${o.droppedDangling} dangling referent(s)` +
      `, ${o.droppedEdges} edge(s) dropped with them` +
      `, ${r.clippedNodes} body(ies) clipped` +
      (r.clippedNodes > 0 ? ' (re-call with altitude: "full" for whole bodies)' : ''),
    `   accounted: ${r.nodes.length} listed + ${o.droppedByMinTrust} below trust floor + ` +
      `${o.droppedDangling} dangling = ${o.examined} examined`,
  ];
  return lines.join('\n');
}

/**
 * Shape ONE node for the structured channel: the node as the altitude already shaped it,
 * plus its permalink, with trust reduced to the wire shape.
 *
 * WHAT REPLACED THE SEPARATE `full|lean` STRUCTURED MODE (SEARCH P3).
 * recall_thread used to carry a SECOND size knob —
 * MANDREL_RECALL_STRUCTURED_MODE — whose whole job was to trim (a) node bodies the prose had
 * already printed and (b) the four trust fields the prose signal line reproduces. Both halves
 * are now structural rather than optional: the body is whatever `altitude` said it is (the
 * ONE dial, moving BOTH channels), and trust on the wire is band+score for every caller, so
 * there is nothing left for a mode to switch between. A second volume knob on one tool was
 * the fourth vocabulary this task exists to remove.
 *
 * WHY OMITTING FIELDS IS SAFE FOR CLIENTS: outputSchemas.ts documents the required-set rule —
 * `ok` is the only required key on the recall_thread shape, every descriptive field is
 * `.optional()`, and the shape is `.passthrough()`. Omitting a field cannot fail client-side
 * response validation; that was engineered in from the start.
 */
function shapeStructuredNode(n: ThreadNode) {
  const url = isResolvableRecordType(n.type) ? recordUrl(n.id) : null;
  return { ...n, trust: projectTrust(n.trust), url };
}

/**
 * THE GATE RUN STAMP — one spelling, called by BOTH line renderers, the same
 * single-renderer rule reviewOutcomeStamp and trust already live under here.
 *
 * ⚠️ THE LABEL IS `gate-rc`, NOT `gate`, AND THE COLLISION IS REAL, NOT HYPOTHETICAL:
 * renderCurrentStateText prints `GATE: <ladder-id> — <reason>` a few lines below, which
 * answers "what is this project waiting on" from an entirely different vocabulary
 * (currentStateConfig.ts CURRENT_STATE_GATE_IDS). Both render in the same document. Two
 * spellings is what keeps a reader from having to guess which gate a line means.
 *
 * Absent gate block renders NOTHING — see gateOutcomeOf's header for why a stamp on a record
 * that never claimed a gate would be the actual defect.
 */
function gateOutcomeStamp(n: { gateOutcome?: string }): string {
  return n.gateOutcome ? ` ${GATE_RC_LABEL}:${n.gateOutcome}` : '';
}

function reviewOutcomeStamp(n: { reviewOutcome?: string }): string {
  // ONE spelling of this stamp, called by BOTH line renderers below — the same
  // single-renderer rule trust already lives under here. Absent outcome renders NOTHING:
  // see reviewOutcomeOf's header for why an invented label would be the actual defect.
  return n.reviewOutcome ? ` ${REVIEW_OUTCOME_LABEL}:${n.reviewOutcome}` : '';
}

/**
 * The 1-liner for a node: title + type + the EXPLAINED trust verdict + permalink.
 *
 * TRUST EXPLAINABILITY: this headline used to print the band token and the
 * BL-5 receipt ONLY — no score, no reason — so recall_thread, the surface an orienting agent
 * actually reads, was the one that showed a bare, unexplained band. It now renders the SAME
 * single explainTrust() the other three surfaces call, in its COMPACT form (band + receipt +
 * score + why + evidence count + the abstain marker): a thread renders many nodes, so the
 * promotion requirement is left OFF each line rather than bloating it.
 *
 * ⚠️ AND IT IS NOT IN structuredContent EITHER (SEARCH P3).
 * This comment used to say the promotion requirement "stays in structuredContent
 * (trust.reason / trust.promotionRequirement, carried on every node)" — that was the stated
 * justification for keeping this line terse, and it is now FALSE: trust on the wire is
 * {band, score}. A reader acting on the old sentence would go looking for a field that is
 * not there. The promotion requirement is derivable from explainTrust() by any caller that
 * holds the record's Trust; on this surface it is simply not shipped.
 *
 * NOTHING about the trust verdict is formatted here (nit N2) — this route used to hand-roll
 * its own ' ⛔ABSTAIN' marker while the other three surfaces rendered ' · abstain'. That
 * second spelling is now gone: the marker comes from the single renderer, folded into
 * `.compact`.
 */
function nodeHeadline(n: ThreadNode): string {
  // WS1 (D2): the machine-lean trust SIGNAL from the single renderer
  // (band/score + supersession flag + abstain). The WHY prose and the promotion requirement
  // are rendered NOWHERE on this surface — they used to be claimed as riding the structured
  // node's trust object, which stopped being true when trust on the wire became {band, score}
  //. No per-node permalink line either: the structured node carries `url`.
  const trustHint = explainTrust(n.trust).signal;
  const title = n.title ?? '(untitled)';
  // THE REVIEW CALL RIDES IN THE TYPE STAMP, not in the title. At this
  // altitude the title is a CLIP of the record's first line, so an outcome living in the
  // prose is an outcome the clip eats — measured on prod over an earlier spine, where 6 of 7
  // Reviewer verdict nodes rendered with no APPROVE/REJECT anywhere on their line. The
  // stamp is outside the clip, so it cannot be truncated away.
  // THE GATE RUN RIDES THE SAME STAMP, for the same reason and against the same measurement
  //: at this altitude the title is a CLIP of the record's first line, so a
  // gate result stated in the prose is a gate result the clip eats — MEASURED 2026-09-03,
  // records differing only in rc=1 (a MEASURED failure) and rc=2 (COULD NOT MEASURE) rendered
  // byte-identical lines here, and the ref the run executed on appeared on neither.
  return `[${n.type}${reviewOutcomeStamp(n)}${gateOutcomeStamp(n)}] ${title} — ${trustHint}  (${n.id})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CURRENT-STATE altitude rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Attach the /r/<id8> permalink, gated on the resolvable set exactly like the story path. */
function withUrl(n: CurrentStateNode) {
  // TRUST ON THE WIRE (an earlier decision Part 2): band + score, the SAME reduction the story
  // path applies. The current-state projection nests these nodes inside FIVE sections, so the
  // old trust blob serialized five times over — this altitude is the one where it cost most.
  return { ...n, trust: projectTrust(n.trust), url: isResolvableRecordType(n.type) ? recordUrl(n.id) : null };
}

/** The same treatment for a capped section, preserving its honest cap counters. */
function sectionWithUrls(s: CurrentStateSection) {
  return { ...s, items: s.items.map(withUrl) };
}

/**
 * The 1-liner for a current-state node: its LIFECYCLE stamp, the title, the EXPLAINED trust
 * verdict, and the permalink.
 *
 * Trust is rendered by the SINGLE explainTrust() renderer (part A) in its
 * compact form — this surface derives nothing about trust itself. The one thing it adds that
 * the story headline does not is the status stamp, because "where does this stand" is the
 * entire question this altitude answers.
 */
function currentStateLine(n: CurrentStateNode): string {
  const stamp = n.status ?? n.contextType ?? n.type;
  const outcome = n.outcomeStatus ? ` outcome:${n.outcomeStatus}` : '';
  // BUILD LIFECYCLE: rendered in the SAME stamp, right beside the outcome,
  // because "where does this stand" is not answerable without it — `active` + `unknown`
  // outcome reads identically for a decision built last week and one that has sat at `planned`
  // for 25 days. This is the surface where "people actually look", which is the whole point of
  // item D: an agent orienting via recall_thread/project_insights now SEES a half-executed
  // decision without having to know to go filter for it.
  const impl = n.implementationStatus ? ` impl:${n.implementationStatus}` : '';
  // The review call, in the SAME stamp as outcome:/impl: and for the same reason — "where
  // does this stand" is unanswerable for a review record whose call is not on the line
  //.
  const review = reviewOutcomeStamp(n);
  // The gate run, in the SAME stamp, for the same reason: "where does this
  // stand" is unanswerable for a build record whose gate exit code is not on the line — and
  // a two-state GREEN/RED reading of it cannot tell "it failed" from "we could not tell".
  const gate = gateOutcomeStamp(n);
  const title = n.title ?? '(untitled)';
  // WS1 (D2): terse trust signal; permalink rides the structured node's url.
  return `[${n.type}:${stamp}${outcome}${impl}${review}${gate}] ${title} — ${explainTrust(n.trust).signal}`;
}

/** Render one capped section, stating exactly what the cap dropped (never a silent short list). */
function renderSection(lines: string[], heading: string, s: CurrentStateSection): void {
  if (s.total === 0) return;
  lines.push(`${heading} (${s.total})`);
  for (const item of s.items) lines.push(`  - ${currentStateLine(item)}`);
  if (s.omittedByCap > 0) {
    lines.push(`  … ${s.omittedByCap} more not shown (per-section cap) — raise the cap or drill in`);
  }
  lines.push('');
}

/**
 * Render the current state as ONE bounded orientation briefing: the gate and the next action
 * first (that is what the reader came for), then the supporting sections, then the EXACT
 * accounting of what was left out.
 *
 * The omission counts are not a footnote — they are the honesty contract. A reader must be
 * able to tell "nothing was superseded" from "17 superseded records were left out", because a
 * bounded answer that hides its own boundary is worse than the unbounded one it replaced.
 */
// EXPORTED for the same reason as renderThreadText above.
export function renderCurrentStateText(s: CurrentStateResult): string {
  const lines: string[] = [];
  const rootLabel = s.root ? currentStateLine(s.root) : s.anchor;
  lines.push(`Current state of ${s.anchor} — depth:${s.depthUsed}, ${s.counts.examined} node(s) examined` +
    // ACTIONABLE, IN-TOOL (not an env var a container customer cannot set) — but it may not
    // name a number it does not have. It used to print
    // `counts.examined + truncatedCount` as the maxNodes to re-call with. `examined` is the
    // count of nodes that survived the gather's filters, so on any walk that dropped one the
    // advised cap was BELOW what the walk had already admitted, and the re-call truncated
    // again. The story path carries a `resumeMaxNodes` the engine derives from the traversal
    // set; the current-state projection does not carry it yet (services/currentState.ts owns
    // that plumbing), so this states the knob and refuses to guess the value.
    (s.truncated
      ? ` (truncated — ${s.truncatedCount} more reachable; raise maxNodes or narrow edgeTypes to widen the walk)`
      : ''));
  lines.push(`ROOT: ${rootLabel}`);
  lines.push(`GATE: ${s.nextAction.gate} — ${s.nextAction.gateReason}`);
  lines.push(`NEXT: ${s.nextAction.action}`);
  lines.push('');

  renderSection(lines, 'Unresolved blockers / findings', s.blockers);
  renderSection(lines, 'Active tasks', s.activeTasks);
  renderSection(lines, 'Latest trusted outcomes', s.latestTrustedOutcomes);
  // THE RECENCY DOOR. Rendered directly beneath the trusted outcomes because
  // it is the same question asked without the trust gate: "what has landed here lately".
  // Trust is still on every line (currentStateLine renders explainTrust().signal) — a LABEL,
  // not a filter. Heading says `unvouched` so the reader is never misled into reading these
  // as verified: they are recent, and that is all this door claims.
  renderSection(lines, 'Recent contexts (unvouched — recency, not trust)', s.recentContexts);
  renderSection(lines, 'Current decisions', s.currentDecisions);

  if (s.artifactHead) {
    const a = s.artifactHead;
    lines.push('Artifact / release head');
    lines.push(
      `  ${a.artifactType} @ ${a.provider}:${a.locator}` +
        (a.repository ? ` (repo ${a.repository})` : '') +
        (a.head ? ` head ${a.head}` : '') +
        (a.sha256 ? ` sha256 ${a.sha256}` : '')
    );
    lines.push(`  from ${a.recordType} ${a.recordId}`);
    if (a.writerObservedClaim) {
      lines.push(
        `  carries a WRITER observation claim (sha256:${a.writerObservedClaim.sha256 ?? '—'}, ` +
          `head:${a.writerObservedClaim.head ?? '—'}) — NOT a verification; verify with context_artifact`
      );
    }
    lines.push('');
  }
  if (s.artifactIssues.length > 0) {
    lines.push(`${s.artifactIssues.length} unreadable artifact reference(s) — this record does NOT`);
    lines.push('   carry "no artifact references"; it carries ones that could not be resolved:');
    for (const issue of s.artifactIssues) lines.push(`  - ${issue}`);
    lines.push('');
  }

  // THE HONESTY SIGNAL — always printed, including at zero, so "none" is a measured answer
  // rather than the absence of a line the reader has to notice is missing.
  const sup = s.omitted.superseded;
  lines.push(
    `Omitted: ${sup.count} superseded` +
      (sup.count > 0 ? ` [${formatTally(sup.byType)}]` : '') +
      `, ${s.omitted.historical.count} historical/closed` +
      (s.omitted.historical.count > 0 ? ` [${formatTally(s.omitted.historical.byType)}]` : '')
  );
  // THE HISTORICAL SPLIT. One word — "historical" — used to cover both "we
  // shipped it" and "we gave up on it", which are the two things a reader most needs told
  // apart: a delivered feature that reads as spent discussion invites someone to rebuild it.
  // Printed only when there is something to split, and the COMPLETED ids are echoed because
  // that is the half a reader must be able to go look at.
  const hist = s.omitted.historical;
  if (hist.count > 0) {
    lines.push(
      `   of those: ${hist.completed.count} completed (work was carried out), ` +
        `${hist.abandoned.count} abandoned (stopped without being carried out), ` +
        `${hist.unknown.count} unknown (record carries no signal either way)`
    );
    if (hist.completed.sampleIds.length > 0) {
      lines.push(
        `   completed ids (these EXIST — do not rebuild them): ` +
          `${hist.completed.sampleIds.join(', ')}` +
          (hist.completed.sampleOmitted > 0 ? ` (+${hist.completed.sampleOmitted} more)` : '')
      );
    }
  }
  if (sup.sampleIds.length > 0) {
    lines.push(
      `   superseded ids: ${sup.sampleIds.join(', ')}` +
        (sup.sampleOmitted > 0 ? ` (+${sup.sampleOmitted} more)` : '')
    );
  }
  lines.push(
    `   accounted: ${s.counts.listed} listed + ${s.counts.superseded} superseded + ` +
      `${s.counts.historical} historical = ${s.counts.examined} examined`
  );
  // THE GATHER'S OWN DROPS. The block above accounts for records this
  // projection SAW and chose not to list; this accounts for records it NEVER SAW because the
  // trust floor or a dangling referent removed them upstream. Printed at zero for the same
  // reason the block above is: "none" must be a measured answer, not a missing line.
  const g = s.omissions;
  lines.push(
    `Gather omitted (before this projection ran): ${g.droppedByMinTrust} below the minTrust floor` +
      (g.droppedByMinTrust > 0 ? ' (re-call with a lower minTrust to include them)' : '') +
      `, ${g.droppedDangling} dangling referent(s), ${g.droppedEdges} edge(s) dropped with them` +
      ` — ${g.examined} node(s) reached by the walk`
  );
  if (s.maxNodesRequested > s.maxNodesUsed) {
    lines.push(
      `   Requested maxNodes: ${s.maxNodesRequested} — CAPPED to ${s.maxNodesUsed} (server ceiling)`
    );
  }
  lines.push('   Drill down: re-run recall_thread on any id at altitude summary|full.');

  return lines.join('\n');
}

/** "context 3, task 1" — a stable, readable tally (keys already in a deterministic order). */
function formatTally(t: Record<string, number>): string {
  return Object.entries(t)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

export const recallRoutes = new RecallRoutes();
