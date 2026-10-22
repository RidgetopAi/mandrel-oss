/**
 * Detach a timer from the event loop's ref count without changing its schedule.
 *
 * WHY THIS IS ONE FUNCTION AND NOT AN IDIOM COPIED PER SERVICE.
 * A ref'd interval is a vote to keep the process alive. A long-running server does not need
 * that vote — its listeners hold the loop open on their own — but every short-lived process
 * that reaches the same code inherits it, and then cannot exit at all: it is waiting on a
 * handle it does not own and cannot clear. That is how eval drivers came to sit overnight
 * holding database connections after `db.end()` had already returned.
 *
 * `.unref()` does not slow, delay, or cancel a timer. The callback still fires on schedule
 * for as long as something else keeps the loop alive. It only removes the vote.
 *
 * The capability is CHECKED rather than assumed because `setInterval` returns a Node
 * `Timeout` here but a plain `number` under DOM lib typings, and the shape has to survive
 * both. It covers only the owners that IMPORT it — several others unref inline, so a
 * mutation here does not reach them.
 */
export function unrefTimer<T>(timer: T): T {
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === 'function') {
    t.unref();
  }
  return timer;
}
