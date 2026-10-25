/**
 * EMBED-FAILURE RESILIENCE CONFIG — the single source of truth for the tunables of the
 * unified embed-failure resilience mechanism (merges two earlier designs,
 * into ONE mechanism). The operator chose Option B: degrade + queue + alert
 * — never lose a record, never fail silently.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every knob the resilience path touches lives HERE — a named value with a doc comment +
 * an env override — never a literal buried in a handler or the worker. Mirrors
 * embeddingConfig.ts / sessionConfig.ts / trustConfig.ts.
 *
 * THREE MOVING PARTS this config governs:
 *   1. ALERT — when an embed-then-persist site degrades to a NULL embedding, fire a LOUD,
 *      rate-limited chat alert (the leading-indicator monitor the last incident lacked).
 *   2. WORKER — a scheduled, single-flight self-heal sweep that re-embeds rows whose ACTIVE
 *      embedding column is NULL (from a live failure OR the tenant backfill). A NULL on the
 *      active column (embeddingConfig.activeEmbeddingColumn()) IS the needs-reembed marker — there
 *      is deliberately NO redundant flag/column.
 *   3. Column-agnosticism is NOT configured here — it is inherited: the worker delegates to
 *      reembedBackfill, which already keys off activeEmbeddingColumn(). Nothing below names a column.
 */

/** Read a boolean env var ("true"/"1"/"yes"/"on" → true, "false"/"0"/"no"/"off" → false), else `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Read a positive-integer env var, else `fallback` (ignores zero/negative/garbage). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a non-empty string env var, else `fallback`. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * THE EMBED-RESILIENCE CONFIG. Read env at MODULE LOAD (like every sibling config), so a
 * fresh process picks up an operator's override at boot and the value is stable for the run.
 */
export interface ResilienceConfig {
  /**
   * ALERT master switch. When true, a degraded (NULL-embedding) persist fires a chat
   * alert via the operator's notify script (MANDREL_EMBED_ALERT_NOTIFY_SCRIPT). "Never silent" is the core ask — the last
   * incident had NO monitor. Fail-SAFE: if the notify script/creds are absent (e.g. inside
   * a tenant container), the send no-ops with a logged warning and NEVER throws into the
   * store path. env: MANDREL_EMBED_ALERT_ENABLED
   *
   * DEFAULT IS `NODE_ENV === 'production'`, NOT bare `true` (2026-08-12).
   *
   * WHY IT CHANGED, measured: a plain `true` default has no notion of WHICH instance is
   * alerting, so ANY process that can reach the notify script pages the same phone prod
   * does. A dev worktree qualifies — the dev tree has no @xenova model cached and
   * MANDREL_XENOVA_ALLOW_REMOTE=false, so every context a local test writes fails to embed
   * and alerts. On 2026-08-12 a builder's test runs paged the operator at his day job about NULL
   * embeddings in a disposable ci_* database. Nothing was wrong with prod: prod cut over to
   * `embedding_gemma` on 2026-07-05 and its coverage is 100% with ZERO gaps over 30 days.
   *
   * WHY THIS GATE AND NOT A LOUDER DEFAULT: alert fatigue is not a tidiness complaint, it
   * is how a real alert gets ignored. An alert channel that carries dev noise trains its
   * reader to swipe it away, which is the failure this monitor exists to prevent.
   *
   * VERIFIED BEFORE CHANGING THE DEFAULT — the fleet was measured, not assumed, because a
   * gate that stops firing where it matters is worse than the noise. ALL 8 mcp-server
   * containers: NODE_ENV=production, MANDREL_EMBED_ALERT_ENABLED unset. The sweep is in
   * `src/tests/embedAlertProductionOnly.contract.test.ts`'s header; run that rather than
   * trusting this sentence. (the coordinator's first draft of this comment listed THREE instances and
   * generalised to eight; the reviewer measured the other five. It happened to be true — but a
   * count written from a sample reads exactly like a count that was taken.)
   *
   * A FUTURE TENANT IS BORN ALERTING, from two independent layers, so this is not a fact that
   * decays as the fleet grows: `ENV NODE_ENV=production` is baked into the image every
   * instance runs, AND it is a LITERAL (not `${NODE_ENV:-…}`) in the single
   * tenant-parameterised compose template every tenant is rendered from.
   *
   * The env var still overrides in BOTH directions: `true` in a staging box you genuinely
   * want paging, `false` to mute a noisy production one.
   *
   * NOTE WHAT IS *NOT* GATED: the structured `logger.warn` and the degrade-and-persist
   * behaviour in embedResilience.ts are unconditional and stay that way. Dev loses the push
   * notification, never the diagnostic.
   */
  alertEnabled: boolean;
  /**
   * ALERT dedupe window (minutes), applied PER TABLE. A broken embedder would otherwise
   * fire one alert per failed write and spam the operator; within this window only the FIRST
   * failure per table alerts (all failures still log + still degrade+persist). DEFAULT 15.
   * env: MANDREL_EMBED_ALERT_DEDUPE_MINUTES
   */
  alertDedupeMinutes: number;
  /**
   * Absolute path to an operator-supplied bash file that defines `notify TITLE BODY LEVEL EMOJI`.
   * DEFAULT empty → no alert is dispatched; the degradation is logged only.
   * env: MANDREL_EMBED_ALERT_NOTIFY_SCRIPT
   */
  alertNotifyScript: string;

  /**
   * SELF-HEAL WORKER master switch. When true, a scheduled single-flight sweep re-embeds
   * rows whose ACTIVE column is NULL (heals both live-failure NULLs and tenant-backfill
   * NULLs). DEFAULT true — matches the codebase precedent for a background feature
   * (belief hook ships default-on); it is idempotent, single-flight, and a pure no-op when
   * there are zero NULL rows (e.g. prod is 100% clean). Flip to false for a fully-dark
   * deploy. env: MANDREL_REEMBED_WORKER_ENABLED
   */
  workerEnabled: boolean;
  /**
   * Worker sweep interval (minutes). Each sweep runs one bounded batch per table. DEFAULT
   * 15. env: MANDREL_REEMBED_WORKER_INTERVAL_MINUTES
   */
  workerIntervalMinutes: number;
  /**
   * The batchSize passed to the re-embed engine. NOTE (accurate to the engine): in
   * reembedBackfill this is the PROGRESS-LOG cadence (`done % batchSize` → a progress line),
   * NOT a hard row cap — a sweep re-embeds ALL currently-NULL rows it finds, oldest-first.
   * Single-flight guarantees sweeps never overlap, so even a large heal runs to completion
   * once (then subsequent sweeps are no-ops). A transient still-failing row simply retries on
   * the next sweep. DEFAULT 100. env: MANDREL_REEMBED_WORKER_BATCH_SIZE
   */
  workerBatchSize: number;
}

export const RESILIENCE_CONFIG: ResilienceConfig = {
  // Default is production-only — see the interface doc above for the measurement that
  // justified narrowing it, and for why the log/persist halves stay unconditional.
  alertEnabled: envBool('MANDREL_EMBED_ALERT_ENABLED', process.env.NODE_ENV === 'production'),
  alertDedupeMinutes: envInt('MANDREL_EMBED_ALERT_DEDUPE_MINUTES', 15),
  alertNotifyScript: envStr('MANDREL_EMBED_ALERT_NOTIFY_SCRIPT', ''),

  workerEnabled: envBool('MANDREL_REEMBED_WORKER_ENABLED', true),
  workerIntervalMinutes: envInt('MANDREL_REEMBED_WORKER_INTERVAL_MINUTES', 15),
  workerBatchSize: envInt('MANDREL_REEMBED_WORKER_BATCH_SIZE', 100),
};
