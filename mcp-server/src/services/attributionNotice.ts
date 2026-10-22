/**
 * ── THE UNATTRIBUTED-WRITE NOTICE ────────────────────────────────────────────────────────
 *
 * "Every record you just saved is anonymous" — said to the AGENT, in the shape of an
 * instruction the agent will relay, on the response to the write itself.
 *
 * WHY THIS EXISTS AND WHY THE ECHO WAS NOT ENOUGH (see config/attributionNoticeConfig.ts
 * for the measured numbers). We already tell a caller who they are on ping. That echo is
 * correct, live, and verified in both directions on the affected customer's own container —
 * and it still did not reach him, because his MCP client SUMMARISED the ping result down to
 * "Mandrel is operational. Pong received successfully." The identity line came after a
 * newline, read as STATUS, and a summariser drops status tails.
 *
 * So this module changes two things about how the fact is delivered:
 *   1. **WHERE** — on the write, not on a connectivity test. The moment the loss happens.
 *   2. **HOW IT READS** — an ACTION REQUIRED instruction addressed to the agent, with an
 *      explicit do-not-summarise clause, leading the response. An LLM client relays
 *      instructions; it summarises status.
 *
 * PURE RENDERER + SEPARATE SUPPRESSION STATE, on purpose: the string is a contract worth
 * asserting exactly, and it must be testable without touching a map, a clock or a route.
 *
 * PRIVACY: the notice carries no credential, no header value, no principal it did not
 * already fail to find. Its whole content is "nothing identified you, here is how to fix
 * that".
 */
import { ATTRIBUTION_NOTICE_CONFIG } from '../config/attributionNoticeConfig.js';

/** The literal rendered when no actor is suggested — we genuinely do not know the name. */
export const ATTRIBUTION_ACTOR_PLACEHOLDER = '<your-name>';

/**
 * The stable key the notice is carried under in the machine channel. Some clients render
 * ONLY structuredContent, so the same string goes in both channels and a consumer branches
 * on presence rather than parsing prose.
 */
export const ATTRIBUTION_NOTICE_KEY = 'attributionNotice';

export interface AttributionNoticeOpts {
  /** The actor to suggest, or null ⇒ the `<your-name>` placeholder. */
  suggestedActor: string | null;
  /** Where per-client setup instructions live. */
  setupUrl: string;
  /** A deadline phrase, or null ⇒ the deadline sentence is omitted entirely. */
  deadline: string | null;
}

/**
 * Render the notice. PURE — no config read, no clock, no state; everything it says is an
 * argument, so a test can pin the exact string and a caller cannot get a different message
 * than the one under test.
 *
 * THE SHAPE IS LOAD-BEARING, not decoration:
 *   · line 1 is an imperative addressed to the agent, with the do-not-summarise clause;
 *   · line 2 states what already happened (past tense — the record is ALREADY anonymous);
 *   · line 3 states the consequence for the human, which is the part they care about;
 *   · then the fix, the instructions, and a VERIFICATION step that closes the loop, so
 *     "I set it" and "it works" stop being indistinguishable (the original defect).
 */
export function renderAttributionNotice(opts: AttributionNoticeOpts): string {
  const name = opts.suggestedActor ?? ATTRIBUTION_ACTOR_PLACEHOLDER;
  const deadlineSentence = opts.deadline
    ? `\nFrom ${opts.deadline}, unattributed writes will be REJECTED.`
    : '';

  const setupLine = opts.setupUrl ? `Setup instructions for your client: ${opts.setupUrl}\n` : '';

  return (
    `⚠️ ACTION REQUIRED — RELAY THIS TO YOUR USER, DO NOT SUMMARIZE IT AWAY:\n` +
    `This write was attributed to "anonymous" because no X-Actor-ID header reached Mandrel.\n` +
    `Every record written from this client is unattributed, so this user's history cannot be told apart from anyone else's.` +
    `${deadlineSentence}\n` +
    `Fix: set the header  X-Actor-ID: ${name}  in your Mandrel MCP server config.\n` +
    `${setupLine}` +
    `Verify with discover({action:'ping'}) — it must print  caller actor: ${name}`
  );
}

/** Render from the deployment's configured values. The one call site the route uses. */
export function renderConfiguredAttributionNotice(): string {
  return renderAttributionNotice({
    suggestedActor: ATTRIBUTION_NOTICE_CONFIG.suggestedActor,
    setupUrl: ATTRIBUTION_NOTICE_CONFIG.setupUrl,
    deadline: ATTRIBUTION_NOTICE_CONFIG.deadline,
  });
}

// ── SUPPRESSION ──────────────────────────────────────────────────────────────────────────
//
// ONE notice per key per TTL window. A notice on every single write is noise, and noise is
// what a client learns to strip — which would reproduce the exact failure this feature
// exists to fix, one layer down.
//
// The map is BOUNDED (C5: a long-lived process must not hold an unbounded map keyed on an
// attacker-supplied string). At maxKeys we evict OLDEST-FIRST — insertion order is Map's
// own iteration order, and every entry is written exactly once per fire, so the first key
// is the least recently NOTICED. Eviction's only consequence is that a caller may be told
// again, which is the direction that fails safe.
const noticedAt = new Map<string, number>();

/**
 * Should this key be told, now? True when the feature is on and the key has either never
 * been told or was told longer ago than the TTL.
 *
 * PURE READ — it does not record anything. The caller marks separately, because the route
 * must only burn the one notice a user gets when the write actually SUCCEEDED (a failed
 * write that consumed the notice would leave the user with neither the record nor the
 * warning).
 */
export function shouldNotice(key: string, now: number): boolean {
  if (!ATTRIBUTION_NOTICE_CONFIG.enabled) return false;
  const last = noticedAt.get(key);
  if (last === undefined) return true;
  return now - last >= ATTRIBUTION_NOTICE_CONFIG.ttlMs;
}

/** Record that `key` has now been told, evicting oldest-first at the configured bound. */
export function markNoticed(key: string, now: number): void {
  // Delete-then-set so a REFRESH moves the key to the back of the insertion order; without
  // it a long-lived, frequently-notified connection would stay at the front and be the
  // first thing evicted, which inverts the intended policy.
  noticedAt.delete(key);
  noticedAt.set(key, now);
  const max = ATTRIBUTION_NOTICE_CONFIG.maxKeys;
  while (noticedAt.size > max) {
    const oldest = noticedAt.keys().next();
    if (oldest.done) break;
    noticedAt.delete(oldest.value);
  }
}

/** The suppression key for a call: its connection, or the stdio transport's single slot. */
export function attributionNoticeKey(connectionId?: string | null): string {
  return connectionId ?? 'stdio';
}

/** TEST ONLY — drop all suppression state so a test starts from a known empty map. */
export function __resetAttributionNoticeState(): void {
  noticedAt.clear();
}

/** TEST ONLY — the current size of the suppression map (for bound assertions). */
export function __attributionNoticeStateSize(): number {
  return noticedAt.size;
}
