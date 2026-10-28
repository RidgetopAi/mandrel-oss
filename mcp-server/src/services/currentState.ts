/**
 * CURRENT-STATE read model — the DB-backed builder.
 *
 * `recall_thread(altitude:"current")` in one function: gather the subgraph exactly as the
 * story altitudes do, then project it into the deterministic current state.
 *
 * THIS IS THE PRIMITIVE, not a rendering special case. It lives in its own service (rather
 * than inside the route) precisely so part C — graph-aware project insights, an earlier task —
 * calls buildCurrentState() instead of growing its OWN current-state query. Two answers to
 * "where does this stand" that drift apart is the failure this shape prevents.
 *
 * DETERMINISTIC: gather (SQL, ordered) → project (pure). No model call in the path, and none
 * may ever be added — Mandrel runs inside customer containers with no LLM/API key.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  gatherThread,
  type GatherThreadArgs,
  type GatheredNode,
  type ThreadOmissions,
} from './recallThread.js';
import {
  projectCurrentState,
  type CurrentState,
  type CurrentStateInputNode,
} from './currentStateCore.js';
import { THREAD_CONFIG, type ThreadConfig } from '../config/threadConfig.js';
import {
  CURRENT_STATE_CONFIG,
  type CurrentStateConfig,
} from '../config/currentStateConfig.js';
import { ARTIFACT_REF_CONFIG, type ArtifactRefConfig } from '../config/artifactRefConfig.js';

/** The current-state answer plus the traversal honesty signals the gather produced. */
export interface CurrentStateResult extends CurrentState {
  /** True when the node cap was hit — MORE was reachable than this answer examined. */
  truncated: boolean;
  /** How many more distinct nodes were reachable but dropped by the traversal cap. */
  truncatedCount: number;
  /** The effective BFS depth actually walked. */
  depthUsed: number;
  /** The effective node cap actually applied (after clamping to maxNodesCeiling). */
  maxNodesUsed: number;
  /** The node cap the CALLER asked for, before the ceiling clamp. */
  maxNodesRequested: number;
  /**
   * What the GATHER dropped before the projection ever ran. The projection's
   * own `omitted` block accounts for superseded/historical records it CHOSE not to list; this
   * accounts for records it never saw, because the trust floor or a dangling referent removed
   * them upstream. Two different subtractions, so they are reported as two different numbers.
   */
  omissions: ThreadOmissions;
}

/** Map a gathered node onto the projector's input shape (a pure field rename, no logic). */
function toInputNode(n: GatheredNode): CurrentStateInputNode {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    content: n.content,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    status: n.status,
    outcomeStatus: n.outcomeStatus,
    // an earlier task — the BUILD lifecycle travels with the other two status fields, so
    // the projector can distinguish a half-executed decision from a fresh one.
    implementationStatus: n.implementationStatus,
    contextType: n.contextType,
    metadata: n.metadata,
    trust: n.trust,
  };
}

/**
 * Build the deterministic current state for an anchor.
 *
 * Throws AnchorUnresolvableError (from resolveAnchor) exactly like buildThread, so the route
 * handles the unresolvable-anchor path identically for every altitude.
 */
export async function buildCurrentState(
  args: GatherThreadArgs,
  threadConfig: ThreadConfig = THREAD_CONFIG,
  stateConfig: CurrentStateConfig = CURRENT_STATE_CONFIG,
  pool: Pool = db,
  artifactConfig: ArtifactRefConfig = ARTIFACT_REF_CONFIG
): Promise<CurrentStateResult> {
  const gathered = await gatherThread(args, threadConfig, pool);
  const state = projectCurrentState(
    gathered.nodes.map(toInputNode),
    gathered.anchorId,
    stateConfig,
    threadConfig,
    artifactConfig,
    gathered.edges
  );
  return {
    ...state,
    truncated: gathered.truncated,
    truncatedCount: gathered.truncatedCount,
    depthUsed: gathered.depthUsed,
    maxNodesUsed: gathered.maxNodesUsed,
    maxNodesRequested: gathered.maxNodesRequested,
    omissions: gathered.omissions,
  };
}
