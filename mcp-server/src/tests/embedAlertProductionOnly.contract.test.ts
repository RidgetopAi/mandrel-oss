/**
 * EMBED ALERT IS PRODUCTION-ONLY BY DEFAULT. NO DB.
 *
 * WHAT THIS PINS. `RESILIENCE_CONFIG.alertEnabled` used to default to bare `true`, which has
 * no notion of WHICH instance is alerting — so any process that could reach the notify script
 * paged the same phone production does. A dev worktree qualifies: the dev tree has no @xenova
 * model cached and MANDREL_XENOVA_ALLOW_REMOTE=false, so every context a local test writes
 * fails to embed and alerted. On 2026-08-12 a Builder's test runs paged the operator at his day job
 * about NULL embeddings in a disposable ci_* database.
 *
 * WHY IT IS A CONTRACT TEST AND NOT A NIT. Alert fatigue is not a tidiness complaint — it is
 * how a real alert gets ignored. This monitor exists because a prior incident had NO monitor;
 * an alert channel that carries dev noise trains its reader to swipe it away, which recreates
 * that failure by a different route.
 *
 * THE RISK THIS TEST GUARDS AGAINST IS THE OPPOSITE ONE. Narrowing an alert's default can
 * silence it where it matters, which is worse than the noise. So the FIRST case below is the
 * one that must never break: production still alerts with NO configuration at all. That case
 * is not hypothetical — it is the shipped fleet's exact configuration. The sweep, rather than
 * a hand-copied list of instance names that will go stale:
 *
 *   ssh prod-host 'for c in $(docker ps --format "{{.Names}}" | grep -- -mcp-server); do
 *     printf "%-32s NODE_ENV=%s ALERT=%s\n" "$c" \
 *       "$(docker exec $c printenv NODE_ENV 2>/dev/null || echo UNSET)" \
 *       "$(docker exec $c printenv MANDREL_EMBED_ALERT_ENABLED 2>/dev/null || echo UNSET)"; done'
 *
 * 8/8 NODE_ENV=production, 8/8 flag UNSET (Reviewer, 2026-08-12). The coordinator's original note here
 * listed THREE instances and generalised to eight — true, as it turned out, but written from a
 * sample. A future tenant is also born alerting from two independent layers, so this is not a
 * fact that decays: `ENV NODE_ENV=production` is baked into the image (mcp-server/Dockerfile),
 * AND it is a literal (not `${NODE_ENV:-…}`) in the one tenant-parameterised compose template
 * every tenant is rendered from.
 *
 * The config reads env at module LOAD, so each case sets env then re-imports a fresh module
 * instance via vi.resetModules — the same technique the rest of the config suite uses.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['NODE_ENV', 'MANDREL_EMBED_ALERT_ENABLED'];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.resetModules();
});

async function loadAlertEnabled(env: Record<string, string | undefined>): Promise<boolean> {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  vi.resetModules();
  return (await import('../config/resilienceConfig.js')).RESILIENCE_CONFIG.alertEnabled;
}

describe('embed-failure alerting is production-only by default', () => {
  it('PRODUCTION STILL ALERTS with no configuration — the fleet\'s exact shipped state', async () => {
    // Every one of the 8 live instances is exactly this: NODE_ENV=production, flag UNSET.
    // If this assertion ever fails, the fleet has gone silent and the change must be reverted.
    expect(await loadAlertEnabled({ NODE_ENV: 'production' })).toBe(true);
  });

  it('a DEV/TEST process does NOT alert — this is the noise that reached Operator', async () => {
    expect(await loadAlertEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(await loadAlertEnabled({ NODE_ENV: 'test' })).toBe(false);
  });

  it('an ABSENT NODE_ENV does not alert — unknown provenance is treated as not-production', async () => {
    // A process that cannot say what it is must not be able to page a human.
    expect(await loadAlertEnabled({})).toBe(false);
  });

  it('the env var still overrides in BOTH directions', async () => {
    // Opt a staging box IN...
    expect(await loadAlertEnabled({ NODE_ENV: 'staging', MANDREL_EMBED_ALERT_ENABLED: 'true' })).toBe(true);
    // ...and mute a noisy production one.
    expect(
      await loadAlertEnabled({ NODE_ENV: 'production', MANDREL_EMBED_ALERT_ENABLED: 'false' }),
    ).toBe(false);
  });

  it('only the ALERT is gated — with alerting OFF the diagnostic log still fires', async () => {
    // Guards the actual regression risk of this change: that someone later "simplifies" the
    // gate upward in onEmbedFailure and silences the diagnostic along with the page.
    //
    // THE FIRST VERSION OF THIS ASSERTION WAS HOLLOW, and it is worth saying why so nobody
    // reintroduces it. It read the source and compared `src.indexOf('logger.warn')` against
    // `src.indexOf('RESILIENCE_CONFIG.alertEnabled')`, asserting the gate came later. But
    // indexOf returns the FIRST occurrence, and the first `logger.warn` in this file is at
    // line 86 inside `alertSink.send` — a different function, ~60 lines above the diagnostic
    // it meant to pin. It compared the gate to the wrong log call and passed for a reason
    // unrelated to its claim. Measured: hoisting the gate ABOVE the diagnostic — precisely
    // the regression named above — left it GREEN, 10/10.
    //
    // A textual scan cannot express "this call still happens when that flag is off". Only
    // running it can. So: turn alerting OFF, fire a real failure, and assert the log happened
    // and the page did not.
    const { onEmbedFailure, alertSink } = await import('../services/embedResilience.js');
    const { RESILIENCE_CONFIG } = await import('../config/resilienceConfig.js');
    const { logger } = await import('../utils/logger.js');

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // send() now reports dispatch success (an earlier task ruling 4); the spy models success.
    const sendSpy = vi.spyOn(alertSink, 'send').mockImplementation(() => true);
    const saved = RESILIENCE_CONFIG.alertEnabled;
    try {
      RESILIENCE_CONFIG.alertEnabled = false;
      onEmbedFailure({ table: 'contexts', op: 'create', error: new Error('embedder down') });

      expect(sendSpy, 'alerting is OFF, so nothing may be sent').not.toHaveBeenCalled();
      expect(warnSpy, 'the diagnostic log is NOT gated and must still fire').toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('Embed failure');
    } finally {
      RESILIENCE_CONFIG.alertEnabled = saved;
      warnSpy.mockRestore();
      sendSpy.mockRestore();
    }
  });
});
