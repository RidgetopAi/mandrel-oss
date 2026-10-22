/**
 * EMBED-FAILURE RESILIENCE — the ONE shared degrade+alert helper called from ALL
 * embed-then-persist sites (a past incident — one mechanism, not N drifting
 * copies across the two tables).
 *
 * THE FOUR SITES that call onEmbedFailure() when embeddingService.generateEmbedding throws:
 *   A  handlers/decisions.ts  recordDecision  (CREATE) → persist with NULL embedding
 *   B  handlers/decisions.ts  updateDecision  (re-embed) → retain prior embedding
 *   C  handlers/context.ts    storeContext    (CREATE) → persist with NULL embedding  ← the
 *      critical data-loss fix: this site used to be UNWRAPPED, so the throw propagated past
 *      the INSERT and the whole capture was LOST.
 *   D  handlers/context.ts    updateContext   (re-embed) → retain prior embedding
 *   E  handlers/tasks.ts      createTask      (CREATE) → persist with NULL embedding
 *   F  handlers/tasks.ts      updateTaskStatus (re-embed) → persist NULL, self-heal re-embeds
 *      (task_bulk_update deliberately does NOT call this: it embeds nothing inline because it
 *       runs inside a BEGIN/COMMIT — it nulls the column in-transaction and lets the worker heal.)
 *
 * In every case the RECORD still persists (never lost); this helper makes the degradation
 * LOUD (structured log + a rate-limited chat alert) and NEVER silent. The self-heal
 * worker (services/reembedWorker.ts) later re-embeds the NULL-active-column rows it leaves.
 *
 * COLUMN-AGNOSTIC: the alert reports embeddingConfig.activeEmbeddingColumn() so an operator knows
 * WHICH plane degraded (prod=embedding_gemma, fleet=embedding). Nothing here hardcodes a column.
 *
 * FAIL-SAFE BY CONSTRUCTION: onEmbedFailure returns void, never throws, never blocks. A
 * missing notify script or absent chat creds (e.g. inside a tenant container) degrades
 * to a logged warning — it must not turn a degraded-but-persisted write into a failed one.
 */

import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { logger } from '../utils/logger.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { RESILIENCE_CONFIG } from '../config/resilienceConfig.js';

/**
 * The tables that carry an embedding column.
 *
 * ADDING A TABLE IS A TWO-PLACE EDIT, and the second place is the easy one to miss: this
 * union + TABLE_LABEL below, AND `lastAlertMsByTable` + `resetAlertDedupe` further down.
 * Both are `Record<EmbedTable, …>`, so TypeScript makes the omission a COMPILE ERROR rather
 * than a silent runtime `undefined` in the dedupe arithmetic — that is why they are typed
 * exhaustively instead of as partials.
 *
 * `tasks` joined in an earlier task (migration 088), when the task source was given
 * embeddings for smart_search.
 */
export type EmbedTable = 'contexts' | 'technical_decisions' | 'tasks';
/** create = a NULL-embedding persist (recoverable); update = a re-embed that retained prior. */
export type EmbedOp = 'create' | 'update';

export interface EmbedFailureContext {
  /** Which table the degraded write landed in. */
  table: EmbedTable;
  /** create (persist NULL) or update (retain prior). */
  op: EmbedOp;
  /** The affected row id, when known (updates always know it; creates may not yet). */
  recordId?: string;
  /** The error the embedder threw. */
  error: unknown;
}

/** Human label for the table in logs/alerts (keeps the chat message readable). */
const TABLE_LABEL: Record<EmbedTable, string> = {
  contexts: 'context',
  technical_decisions: 'decision',
  tasks: 'task',
};

/**
 * Resolve operator-supplied notify script (MANDREL_EMBED_ALERT_NOTIFY_SCRIPT). The script
 * is a bash file that defines `notify TITLE BODY LEVEL EMOJI`; Mandrel sources it and calls
 * `notify`, so delivery (chat, email, pager) is entirely the operator's choice. Unset, or set
 * to a path that does not exist → null, and the alert is logged only.
 *
 * EXPORTED: the provenance alarm calls this at startup to FAIL LOUD when it is enabled but
 * cannot deliver.
 */
export function resolveNotifyScript(): string | null {
  const configured = RESILIENCE_CONFIG.alertNotifyScript;
  return configured && existsSync(configured) ? configured : null;
}

/**
 * An optional env var naming a credentials file the notify script reads (the SCRIPT's
 * contract, not a Mandrel config — named once here so callers never spell the literal).
 * When it is set, Mandrel checks the file is readable before dispatching.
 */
export const NOTIFY_CREDS_ENV_VAR = 'MANDREL_NOTIFY_CREDS_ENV';

/**
 * DELIVERY-READINESS CHECK (an earlier task round 3). "Script resolves" is not "delivery
 * works": measured on the real prod image, the container runs uid 1001 while the creds
 * file was root:600 (and any path under the image's drwx------ /root is unreachable
 * regardless of file perms) — the script resolved, spawned, hit its own
 * `[[ ! -r $MANDREL_NOTIFY_CREDS_ENV ]]` FATAL on stderr, and the detached stdio:'ignore'
 * child discarded it: a page that died silently at fire time. This checks every link a
 * caller can check synchronously: the script resolves, AND — when MANDREL_NOTIFY_CREDS_ENV is
 * set — the creds file is readable by THIS process's uid. When the var is unset the
 * script's internal default applies and is deliberately not re-spelled here.
 */
export function notifyDeliveryCheck(): { deliverable: boolean; reason: string | null } {
  const script = resolveNotifyScript();
  if (script === null) {
    return { deliverable: false, reason: 'notify script (MANDREL_EMBED_ALERT_NOTIFY_SCRIPT) is not set or does not exist' };
  }
  const credsPath = process.env[NOTIFY_CREDS_ENV_VAR]; // env-read: MANDREL_NOTIFY_CREDS_ENV
  if (credsPath) {
    try {
      accessSync(credsPath, fsConstants.R_OK);
    } catch {
      return {
        deliverable: false,
        reason: `chat creds unreadable at ${credsPath} (${NOTIFY_CREDS_ENV_VAR}) by uid ${process.getuid?.() ?? '?'}`,
      };
    }
  }
  return { deliverable: true, reason: null };
}

/**
 * The low-level alert SINK, isolated behind an object so tests can replace `.send` with a
 * spy WITHOUT shelling out (ESM live-binding-safe: onEmbedFailure calls alertSink.send(...),
 * so swapping the property intercepts it). Shells out to the operator's notify script — the ONE
 * notify mechanism (no divergent notifier in TS; any credential stays in the script's own
 * env file and is NEVER read or logged here). Fully detached + fail-safe.
 *
 * RETURNS whether the alert was DISPATCHED (an earlier task the reviewer ruling 4): true = the
 * notify script resolved and the detached child was launched; false = no script, or the
 * spawn threw synchronously. This is what a caller can know without blocking — an async
 * spawn failure after launch is logged but reports as dispatched (bounded, documented).
 * Callers that dedupe MUST consume this: an undelivered page must not eat a dedupe slot.
 */
export const alertSink = {
  send(title: string, body: string): boolean {
    const script = resolveNotifyScript();
    if (!script) {
      logger.warn(
        '⚠️  Embed-failure alert NOT sent: notify script not configured on this ' +
        'host — degradation logged only. Set MANDREL_EMBED_ALERT_NOTIFY_SCRIPT to enable.',
      );
      return false;
    }
    try {
      // bash -c 'source <script>; notify "$1" "$2" "$3" "$4"' bash <title> <body> <level> <emoji>
      // level=high → LOUD (the operator gets it); emoji 🔴. Detached + stdio ignored → never blocks
      // or back-pressures the store path; errors are swallowed (best-effort by contract).
      const child = spawn(
        'bash',
        ['-c', 'source "$0"; notify "$1" "$2" "$3" "$4"', script, title, body, 'high', '🔴'],
        { detached: true, stdio: 'ignore' },
      );
      child.on('error', (err) => {
        logger.warn('⚠️  Embed-failure alert spawn failed (degradation still logged)', {
          metadata: { message: (err as Error)?.message },
        });
      });
      child.unref();
      return true;
    } catch (err) {
      logger.warn('⚠️  Embed-failure alert dispatch threw (swallowed; degradation still logged)', {
        metadata: { message: (err as Error)?.message },
      });
      return false;
    }
  },
};

/**
 * Per-table timestamp (ms) of the last chat alert, for the dedupe window. Module-level
 * so the rate-limit is process-wide (one embedder, one process). Reset by resetAlertDedupe()
 * for tests.
 */
const lastAlertMsByTable: Record<EmbedTable, number> = {
  contexts: 0,
  technical_decisions: 0,
  tasks: 0,
};

/** TEST HOOK: clear the dedupe state so a test's first failure always alerts. */
export function resetAlertDedupe(): void {
  lastAlertMsByTable.contexts = 0;
  lastAlertMsByTable.technical_decisions = 0;
  lastAlertMsByTable.tasks = 0;
}

/**
 * THE SHARED DEGRADE HANDLER — call from every inline embed site's catch block.
 *
 * Always: a structured WARN (so the degradation is in the logs even when alerting is off or
 * deduped). Then, if alerting is enabled and outside the per-table dedupe window, a LOUD
 * chat alert naming the table, op, active column, and error. NEVER throws — the caller
 * has already (or will immediately) persist the record; nothing here may endanger that.
 */
export function onEmbedFailure(ctx: EmbedFailureContext): void {
  const label = TABLE_LABEL[ctx.table];
  const message = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
  const idFragment = ctx.recordId ? ` ${String(ctx.recordId).slice(0, 8)}...` : '';
  const disposition =
    ctx.op === 'create'
      ? `stored with NULL ${activeEmbeddingColumn()} (recoverable — self-heal worker will re-embed)`
      : `prior ${activeEmbeddingColumn()} retained`;

  // Structured log — always, unconditionally.
  logger.warn(
    `⚠️  Embed failure on ${label} ${ctx.op}${idFragment}: ${disposition}. Reason: ${message}`,
    { metadata: { table: ctx.table, op: ctx.op, recordId: ctx.recordId, column: activeEmbeddingColumn(), message } },
  );

  if (!RESILIENCE_CONFIG.alertEnabled) return;

  // Per-table dedupe: only the first failure per table in the window alerts.
  const now = Date.now();
  const windowMs = RESILIENCE_CONFIG.alertDedupeMinutes * 60 * 1000;
  if (now - lastAlertMsByTable[ctx.table] < windowMs) return;
  lastAlertMsByTable[ctx.table] = now;

  const title = `Mandrel embed failure — ${label} ${ctx.op}`;
  const body =
    `A ${label} ${ctx.op} degraded: ${disposition}.\n` +
    `Active column: ${activeEmbeddingColumn()}\n` +
    (ctx.recordId ? `Record: ${ctx.recordId}\n` : '') +
    `Reason: ${message}\n` +
    `(Further ${label} embed failures are suppressed for ${RESILIENCE_CONFIG.alertDedupeMinutes} min.)`;
  // Guard-the-guard: even though alertSink.send is itself fail-safe, wrap the dispatch so
  // onEmbedFailure's never-throw contract holds no matter what a caller injects for the sink.
  try {
    alertSink.send(title, body);
  } catch (err) {
    logger.warn('⚠️  Embed-failure alert sink threw (swallowed; degradation still logged)', {
      metadata: { message: (err as Error)?.message },
    });
  }
}
