/**
 * Decision Inbox configuration — the tunables for the inbox screen and the nav badge
 * (house rule: configs, not hardcoded literals). Mirrors `pages/decisions/config.ts`'s
 * shape for the sibling screen.
 */
export const DECISION_INBOX_CONFIG = {
  /**
   * Max rows pulled per answerStatus (the inbox issues one `decision_search` per status —
   * see hooks.ts for why the tool's `answerStatus` filter takes one value, not a list).
   * Matches the Decisions page's window (also the MCP `decision_search` tool's max limit).
   */
  listLimit: 100,
  /** react-query staleTime for the inbox list. */
  staleTimeMs: 1000 * 30,
  /** react-query staleTime + refetch interval for the nav badge's open count. */
  badgeStaleTimeMs: 1000 * 60,
  badgeRefetchIntervalMs: 1000 * 60,
} as const;
