/**
 * shadowResolver — the Phase 2a SHADOW-mode comparison (the auditor review §6 Phase 2).
 * ZERO behavior change: this is pure OBSERVATION.
 *
 * When SESSION_CONFIG.resolverMode === 'shadow', the action gate ACTS ON LEGACY (the real
 * getActiveSession → create path, untouched) and ALSO calls this to compute what the NEW
 * resolveSession() would target, compare the two, log agree/disagree, and increment the
 * shadow counters (sessions_resolver_shadow_agree / _disagree). This is how we gather
 * confidence on the test tenant BEFORE the 2b cutover — without changing a single write.
 *
 * SAFETY: everything here is READ-ONLY. The "legacy read-only mirror" replicates ONLY the
 * pure-SELECT steps of getActiveSession (RAM lookup validated by existsActive, then
 * findReattachable) — it deliberately does NOT reactivate, does NOT write the RAM cache, and
 * does NOT touch the global fallback (the action gate never opts into it). It therefore
 * matches the session id legacy WOULD resolve to, without any of legacy's side effects (those
 * happen in the real ensureActiveSession call the gate still makes). Wrapped so a comparison
 * failure can NEVER break the user's action — shadow is best-effort telemetry.
 */

import { ActiveSessionStore } from '../../state/index.js';
import { SessionRepo } from '../../infra/db/index.js';
import { SESSION_CONFIG } from '../../../../config/sessionConfig.js';
import { logger } from '../../../../utils/logger.js';
import { monitoring } from '../../../../utils/monitoring.js';
import {
  resolveSession,
  defaultResolveSessionPorts,
  type ResolveSessionPorts,
  type ResolveSessionResult,
} from './resolveSession.js';

/** What the legacy connection-keyed path resolved to (read-only), + how. */
type LegacyReadOnly = { sessionId: string | null; source: 'ram' | 'reattach' | 'none' };

export interface ShadowComparison {
  agree: boolean;
  legacy: LegacyReadOnly;
  next: ResolveSessionResult;
}

/**
 * READ-ONLY mirror of getActiveSession steps 1–2 (RAM hit validated as still-open, then
 * re-attach lookup). No reactivate, no cache write, no global fallback. Returns the id legacy
 * would resolve to (or null = legacy would lazily create).
 */
async function legacyResolveReadOnly(connectionId?: string): Promise<LegacyReadOnly> {
  const mem = ActiveSessionStore.get(connectionId);
  if (mem && (await SessionRepo.existsActive(mem))) {
    return { sessionId: mem, source: 'ram' };
  }
  if (connectionId) {
    const reattachId = await SessionRepo.findReattachable(connectionId, SESSION_CONFIG.reattachWindowSec);
    if (reattachId) return { sessionId: reattachId, source: 'reattach' };
  }
  return { sessionId: null, source: 'none' };
}

/**
 * Compute the legacy-vs-new comparison, emit the counters + a structured log line, and return
 * the result (returned so tests can assert; the gate ignores the return). NEVER throws.
 *
 * Agreement semantics:
 *   - both would target the SAME existing session id → agree;
 *   - both would LAZILY CREATE (legacy resolves to nothing AND new signals lazy-create) → agree;
 *   - anything else (different ids, or one creates while the other adopts) → DISAGREE.
 */
export async function shadowCompareResolution(
  params: { connectionId?: string; actor?: string; explicitSessionId?: string },
  ports: ResolveSessionPorts = defaultResolveSessionPorts()
): Promise<ShadowComparison | null> {
  try {
    const legacy = await legacyResolveReadOnly(params.connectionId);
    const next = await resolveSession(params.actor, params.explicitSessionId, ports);

    const agree =
      legacy.sessionId !== null
        ? next.sessionId === legacy.sessionId
        : next.source === 'lazy-create';

    monitoring.incrementCounter(
      agree ? 'sessions_resolver_shadow_agree' : 'sessions_resolver_shadow_disagree',
      { legacy_source: legacy.source, new_source: next.source }
    );

    const line =
      `🕶️  resolver shadow: ${agree ? 'AGREE' : 'DISAGREE'} ` +
      `legacy=${legacy.source}:${legacy.sessionId ? legacy.sessionId.substring(0, 8) : 'create'} ` +
      `new=${next.source}:${next.sessionId ? next.sessionId.substring(0, 8) : 'create'} ` +
      `(actor=${params.actor ?? 'none'}, connection=${params.connectionId ?? 'none'})`;
    if (agree) logger.info(line);
    else logger.warn(line, { metadata: { event: 'resolver_shadow_disagree', legacy, next, actor: params.actor ?? null } });

    return { agree, legacy, next };
  } catch (error) {
    // Shadow is telemetry — a failure here must never affect the action.
    logger.warn('⚠️  resolver shadow comparison failed (ignored — legacy path unaffected)', {
      metadata: { error: (error as Error)?.message },
    });
    return null;
  }
}
