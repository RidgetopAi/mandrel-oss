/**
 * SessionPinRepo — DB operations for session_pins (Sessions Foundation Phase 2a).
 *
 * The PIN is the user-controlled targeting primitive ("this is my session"). It is
 * DB-PERSISTED, not RAM (the auditor review §4.1 — the SR-1 RAM saga is exactly why: stale maps,
 * eviction bugs, restart wipes). One pin per actor (session_pins.actor PRIMARY KEY); setPin
 * upserts. The resolver re-validates openness at read time, so getPin returns whatever is
 * pinned and the caller decides whether the target is still usable.
 *
 * The actor key is stored ALREADY-NORMALIZED (callers pass a normalizeActor()'d value) so
 * equivalent actor strings collapse to a single pin. A blank/unnormalizable actor is not a
 * valid pin key and is rejected by the callers (the MCP tool) before reaching here.
 */

import { db } from '../../../../config/database.js';
import { logger } from '../../../../utils/logger.js';

export interface SessionPin {
  actor: string;
  sessionId: string;
  pinnedAt: Date;
}

export const SessionPinRepo = {
  /**
   * Read the actor's current pin (or null). Does NOT check whether the pinned session is
   * still open — the resolver re-validates existsActive() and ignores a stale pin. Fails
   * safe: returns null (never throws) on a DB error so a pin-read hiccup degrades to
   * "no pin" rather than breaking resolution.
   */
  async getPin(actor: string): Promise<SessionPin | null> {
    try {
      const result = await db.query(
        'SELECT actor, session_id, pinned_at FROM session_pins WHERE actor = $1',
        [actor]
      );
      const row = result.rows[0];
      if (!row) return null;
      return { actor: row.actor, sessionId: row.session_id, pinnedAt: row.pinned_at };
    } catch (error) {
      logger.error('Failed to get session pin', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionPinRepo',
        operation: 'getPin',
        metadata: { actor },
      });
      return null;
    }
  },

  /**
   * Upsert the actor's pin → sessionId (one pin per actor). Refreshes pinned_at on re-pin.
   * The FK guarantees sessionId references a real session row; ON DELETE CASCADE cleans the
   * pin if that session is later deleted. Throws on error (the tool surfaces it to the user —
   * a failed "pin my session" must not silently no-op).
   */
  async setPin(actor: string, sessionId: string): Promise<SessionPin> {
    const result = await db.query(
      `INSERT INTO session_pins (actor, session_id, pinned_at)
       VALUES ($1, $2, now())
       ON CONFLICT (actor) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             pinned_at = EXCLUDED.pinned_at
       RETURNING actor, session_id, pinned_at`,
      [actor, sessionId]
    );
    const row = result.rows[0];
    return { actor: row.actor, sessionId: row.session_id, pinnedAt: row.pinned_at };
  },

  /**
   * Remove the actor's pin. Returns true iff a pin existed and was removed (idempotent —
   * clearing a non-existent pin returns false, not an error).
   */
  async clearPin(actor: string): Promise<boolean> {
    const result = await db.query(
      'DELETE FROM session_pins WHERE actor = $1 RETURNING actor',
      [actor]
    );
    return result.rows.length > 0;
  },
};
