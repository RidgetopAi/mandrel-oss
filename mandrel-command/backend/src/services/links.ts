/**
 * LinkService — the ONE canonical typed-edge (TreeWalker) resolver behind every
 * `GET /api/<record>/:id/links` endpoint (contexts, tasks, decisions).
 *
 * The `links` table (migration 049) stores the typed graph edges of the moat. A record's
 * "thread" is every edge touching its id in EITHER direction, resolved to the OTHER
 * endpoint's title + kind by joining that endpoint's own table (contexts /
 * technical_decisions / tasks). Because the query keys ONLY on the id (`from_id = $1 OR
 * to_id = $1`), the SAME query serves a context, a task, OR a decision id unchanged —
 * which is why this lives once here instead of being copy-pasted per record type (the SQL
 * was byte-identical across ContextService.getContextLinks and TaskService.getTaskLinks;
 * a third copy for decisions would have made three drifting copies).
 *
 * This is STRUCTURE (real `links` rows), NOT the semantic `related` list — never conflate
 * the two.
 */
import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import { contextTitle } from './recordTitle';

/**
 * One resolved typed graph edge touching a record. `direction: 'outgoing'` reads forward
 * from the subject record (subject → other); 'incoming' points at it (subject is the
 * edge's `to`). `otherKind` is the OTHER endpoint's kind for colour/label — a context's
 * `context_type` (milestone/handoff/…), or the literal 'decision' / 'task'.
 */
export interface RecordLink {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherType: 'context' | 'decision' | 'task';
  otherTitle: string;
  otherKind: string;
}

export class LinkService {
  /**
   * Return every typed `links`-table edge touching `recordId` (both directions),
   * resolved to each other endpoint's title + kind. Works unchanged for a context, task,
   * or decision id — the query keys only on the id.
   */
  static async getLinksForRecord(recordId: string): Promise<RecordLink[]> {
    try {
      // `other` = the endpoint that is NOT the subject. Computed once via CASE and reused
      // for the direction, the kind, and each endpoint-table join.
      const result = await pool.query(
        `
        WITH edges AS (
          SELECT
            l.edge_type,
            CASE WHEN l.from_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction,
            CASE WHEN l.from_id = $1 THEN l.to_id   ELSE l.from_id   END AS other_id,
            CASE WHEN l.from_id = $1 THEN l.to_type ELSE l.from_type END AS other_type,
            l.created_at
          FROM links l
          WHERE l.from_id = $1 OR l.to_id = $1
        )
        SELECT
          e.edge_type,
          e.direction,
          e.other_id,
          e.other_type,
          c.content        AS ctx_content,
          c.context_type   AS ctx_type,
          d.title          AS dec_title,
          t.title          AS task_title
        FROM edges e
        LEFT JOIN contexts            c ON e.other_type = 'context'  AND c.id = e.other_id
        LEFT JOIN technical_decisions d ON e.other_type = 'decision' AND d.id = e.other_id
        LEFT JOIN tasks               t ON e.other_type = 'task'     AND t.id = e.other_id
        ORDER BY e.created_at DESC
        `,
        [recordId]
      );

      return result.rows.map((row) => {
        const otherType = row.other_type as RecordLink['otherType'];
        let otherTitle: string;
        let otherKind: string;

        if (otherType === 'context') {
          // ONE headline rule for every surface (services/recordTitle.ts, mirroring
          // mcp-server/src/config/recordHeadlineConfig.ts). This block used to re-implement
          // the derivation AND re-declare its own copy of the 140-char constant.
          otherTitle = contextTitle(row.ctx_content);
          otherKind = row.ctx_type ?? 'context';
        } else if (otherType === 'decision') {
          otherTitle = row.dec_title ?? '(decision)';
          otherKind = 'decision';
        } else {
          otherTitle = row.task_title ?? '(task)';
          otherKind = 'task';
        }

        return {
          edgeType: row.edge_type as string,
          direction: row.direction as RecordLink['direction'],
          otherId: row.other_id as string,
          otherType,
          otherTitle,
          otherKind,
        };
      });
    } catch (error) {
      logger.error('Get record links error', { error, recordId });
      throw new Error('Failed to get record links');
    }
  }
}
