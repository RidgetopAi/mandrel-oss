/**
 * In-memory store for session token usage tracking
 * Accumulates token counts before flushing to database
 */

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

const sessionTokens: Map<string, TokenUsage> = new Map();

export const TokenStore = {
  record(sessionId: string, inputTokens: number, outputTokens: number): void {
    const existing = sessionTokens.get(sessionId) || { input: 0, output: 0, total: 0 };
    existing.input += inputTokens;
    existing.output += outputTokens;
    existing.total += (inputTokens + outputTokens);
    sessionTokens.set(sessionId, existing);
  },

  get(sessionId: string): TokenUsage {
    return sessionTokens.get(sessionId) || { input: 0, output: 0, total: 0 };
  },

  /**
   * GET-AND-DELETE for ONE session, atomically. See `ActivityCountStore.consume` for
   * the full rationale — the value here is likewise a DELTA ("tokens since the last
   * flush"), never a session total, so whoever persists it must own it exclusively.
   * No `await` may be introduced between the `get` and the `delete`.
   */
  consume(sessionId: string): TokenUsage {
    const usage = sessionTokens.get(sessionId);
    sessionTokens.delete(sessionId);
    return usage || { input: 0, output: 0, total: 0 };
  },

  /**
   * GET-AND-DELETE for EVERY session, atomically — the flush's entry point.
   * Closes the same lost-update hole described on `ActivityCountStore.consumeAll`.
   * `getAll`/`clearAll` were DELETED for the same reason given there.
   */
  consumeAll(): Map<string, TokenUsage> {
    const snapshot = new Map(sessionTokens);
    sessionTokens.clear();
    return snapshot;
  },

  /**
   * PUT BACK a delta that was consumed but could NOT be persisted. See
   * `ActivityCountStore.restore` for the full rationale. Tokens are the reason this
   * exists: they have NO child table, so a dropped token delta is unrecoverable —
   * there is nothing to recount it from.
   *
   * ADDS to whatever accumulated since; error path only.
   */
  restore(sessionId: string, usage: TokenUsage): void {
    const existing = sessionTokens.get(sessionId) || { input: 0, output: 0, total: 0 };
    existing.input += usage.input;
    existing.output += usage.output;
    existing.total += usage.total;
    sessionTokens.set(sessionId, existing);
  },

  clear(sessionId: string): void {
    sessionTokens.delete(sessionId);
  },

  has(sessionId: string): boolean {
    return sessionTokens.has(sessionId);
  },

  /**
   * Get all session IDs with token data
   */
  getSessionIds(): string[] {
    return Array.from(sessionTokens.keys());
  }
};
