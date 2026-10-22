/**
 * THREAD TERMINALITY — the STORAGE/WALK half (BRANCH-2).
 *
 * Binds the pure rule (threadTerminality.ts) to the materialised `declared_limbs` column
 * (BRANCH-1) for the duration of ONE recall_thread traversal. The rule itself is not here;
 * nothing in this file decides whether a node is terminal.
 *
 * WHY A PER-WALK OBJECT AND NOT A FREE FUNCTION: the anchor's cone is computed once, and
 * limb sets are fetched ONE BATCH PER BFS LEVEL rather than one query per node. A walk at
 * the default depth 2 therefore costs 3 extra queries total (anchor + two levels),
 * independent of how wide the graph fans out.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { loadDeclaredLimbs } from './declaredLimbsStore.js';
import type { LimbResolvableType } from './declaredLimbs.js';
import {
  THREAD_TERMINALITY_CONFIG,
  threadTerminalityFlagSummary,
  type ThreadTerminalityConfig,
} from '../config/threadTerminalityConfig.js';
import {
  buildAnchorCone,
  decideExpansion,
  newTerminalityTelemetry,
  recordTerminalityDecision,
  type DeclaredLimbs,
  type ExpandDecision,
  type TerminalityTelemetry,
} from './threadTerminality.js';

/** A frontier member as the traversal knows it. */
export interface WalkNode {
  id: string;
  type: LimbResolvableType;
}

export class TerminalityWalk {
  private readonly cone: ReadonlySet<string>;
  private readonly limbs = new Map<string, DeclaredLimbs>();
  readonly telemetry: TerminalityTelemetry;

  private constructor(
    private readonly anchorId: string,
    cone: ReadonlySet<string>,
    private readonly cfg: ThreadTerminalityConfig,
    private readonly pool: Pool
  ) {
    this.cone = cone;
    this.telemetry = newTerminalityTelemetry(cone.size);
  }

  /**
   * Open a walk: read the ANCHOR's own limb set and build the cone from it.
   *
   * An anchor whose column is NULL or empty yields the degenerate cone `{anchor}` — which
   * is correct and not a failure: a record that names nothing has named nothing, and every
   * node that declares limbs will then score overlap 0 and be terminal. The anchor itself
   * is always expandable, so the walk still reaches depth 1 in full.
   *
   * RETURNS NULL IF THE ANCHOR'S LIMBS CANNOT BE READ, and the caller then walks exactly as
   * it does with the flag off. This is the same degrade-OPEN posture as judgeLevel below,
   * and it is deliberately NOT the degenerate cone: a failed read is a COULD-NOT-MEASURE
   * (C1's third state), and folding it into "the anchor names nothing" would turn a
   * database hiccup into a maximally strict cone that makes every other node terminal —
   * degrading CLOSED, silently, on the widest possible blast radius. Nor may it throw: a
   * precision feature must not be able to fail a read the user asked for.
   */
  static async open(
    anchor: WalkNode,
    cfg: ThreadTerminalityConfig = THREAD_TERMINALITY_CONFIG,
    pool: Pool = db
  ): Promise<TerminalityWalk | null> {
    let loaded: Map<string, string[] | null>;
    try {
      loaded = await loadDeclaredLimbs([anchor], pool);
    } catch (error) {
      logger.error(
        `🌿 thread terminality: anchor limb read failed for ${anchor.type} ${anchor.id}; ` +
          'terminality is SKIPPED for this walk (it returns exactly what the flag-off walk returns)',
        error as Error
      );
      return null;
    }
    const anchorLimbs = loaded.has(anchor.id) ? (loaded.get(anchor.id) ?? null) : null;
    const walk = new TerminalityWalk(
      anchor.id,
      buildAnchorCone(anchor.id, anchorLimbs),
      cfg,
      pool
    );
    walk.limbs.set(anchor.id, anchorLimbs);
    return walk;
  }

  /**
   * Judge one BFS level. Returns the per-node verdict; the caller skips EXPANDING a node
   * whose `canExpand` is false and ADMITS it regardless (admit-but-do-not-transit).
   *
   * DEGRADES OPEN, LOUDLY. If the limb read fails, every node in the level is treated as
   * NOT-DERIVED and judged by the configured `notDerivedTerminal` posture (default:
   * expandable) rather than being silently pruned. A read-path feature must not turn a
   * database hiccup into a user's branch losing half its records — and the failure is
   * logged and counted rather than absorbed.
   */
  async judgeLevel(frontier: readonly WalkNode[]): Promise<Map<string, ExpandDecision>> {
    const unknown = frontier.filter((n) => !this.limbs.has(n.id));
    if (unknown.length > 0) {
      try {
        const loaded = await loadDeclaredLimbs(unknown, this.pool);
        for (const n of unknown) {
          this.limbs.set(n.id, loaded.has(n.id) ? (loaded.get(n.id) ?? null) : null);
        }
      } catch (error) {
        logger.error(
          `🌿 thread terminality: declared_limbs read failed for ${unknown.length} node(s); ` +
            'they are judged as NOT-DERIVED for this walk',
          error as Error
        );
        for (const n of unknown) this.limbs.set(n.id, null);
      }
    }

    const verdicts = new Map<string, ExpandDecision>();
    for (const n of frontier) {
      const limbs = this.limbs.get(n.id) ?? null;
      const decision = decideExpansion(n.id, this.anchorId, limbs, this.cone, this.cfg);
      recordTerminalityDecision(this.telemetry, n.id, limbs, decision);
      verdicts.set(n.id, decision);
    }
    return verdicts;
  }

  /**
   * TERMINALITY TELEMETRY (non-negotiable guard #3): why each node was
   * terminal, and the declared-limb coverage of the traversed set.
   *
   * This is also the STRANGER-CLIFF instrument. 57% of the live riverbend corpus carries
   * no limb signal, against a far better-tagged eval population, so live behaviour will
   * differ from the measured numbers — `coverage` is how that shows up as a number rather
   * than as a surprise. Emitted at info: one line per thread read, not per node.
   */
  logTelemetry(anchorType: string): void {
    const t = this.telemetry;
    const reasons = Object.entries(t.byReason)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${r}=${n}`)
      .join(' ');
    logger.info(
      `🌿 thread terminality: ${t.terminal}/${t.judged} node(s) terminal on ` +
        `${anchorType} ${this.anchorId.substring(0, 8)} — ${reasons}`,
      {
        component: 'RECALL_THREAD',
        operation: 'terminality',
        metadata: {
          anchorId: this.anchorId,
          anchorType,
          flag: threadTerminalityFlagSummary(this.cfg),
          coneSize: t.coneSize,
          judged: t.judged,
          expanded: t.expanded,
          terminal: t.terminal,
          byReason: t.byReason,
          declaredLimbCoverage: t.coverage,
          terminalNodes: t.terminalNodes.map((n) => ({
            id: n.id.substring(0, 8),
            reason: n.reason,
            overlap: n.overlap,
          })),
        },
      }
    );
  }
}
