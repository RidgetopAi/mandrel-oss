/**
 * Fail-loud startup guard for the remote Streamable HTTP MCP transport.
 *
 * WHY THIS EXISTS (a past incident — the Tailspin-class outage):
 *   The remote `/mcp` transport is FAIL-CLOSED: if `MCP_AUTH_TOKEN` is unset it
 *   returns 503 per-request, and if `MCP_ALLOWED_HOSTS` is unset the SDK's
 *   DNS-rebinding protection 403s the real public Host. On the Jun-13 deploy those
 *   vars were never provisioned in prod, so the server BOOTED HAPPILY into a broken
 *   fail-closed state and stayed silently down for ~2 days — discovered by the
 *   customer, not by us, because /health/the bridge stayed green.
 *
 *   A fail-closed feature is only HALF-deployed until its env/secrets exist in the
 *   target environment. So when the server is in a mode that actually SERVES remote
 *   HTTP MCP to network clients, it must REFUSE TO START (loud, named, non-zero
 *   exit) rather than boot broken.
 *
 * WHAT THIS DOES NOT DO:
 *   It must NOT break legitimate local/stdio/dev/test usage that never serves the
 *   public `/mcp` surface and legitimately has no token. The requirement is gated on
 *   `isRemoteMcpServingMode()` — see that predicate for the exact condition.
 *
 * This module is split into a PURE evaluator (`evaluateRemoteMcpEnv`) and a thin
 * process-killing wrapper (`assertRemoteMcpEnvOrExit`) so the decision logic is unit
 * testable without tearing down the test process.
 */

import { logger } from '../utils/logger.js';

/** Env vars the remote HTTP transport requires to serve correctly (not boot-broken). */
export const REQUIRED_REMOTE_MCP_VARS = [
  {
    name: 'MCP_AUTH_TOKEN',
    why: 'bearer token for /mcp; without it every request fail-closes with 503 ' +
      '("Remote MCP transport is not configured"). Mint one: openssl rand -hex 32',
  },
  {
    name: 'MCP_ALLOWED_HOSTS',
    why: 'comma-separated Host allowlist for DNS-rebinding protection; without it the ' +
      'public host is 403\'d ("Invalid Host header"). Set it to your public domain, ' +
      'e.g. MCP_ALLOWED_HOSTS=mandrel.example.com',
  },
] as const;

/** Truthiness for explicit boolean-ish env flags. */
function isTruthyFlag(v: string | undefined): boolean {
  if (v === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Explicit falsiness for an opt-out flag. */
function isFalsyFlag(v: string | undefined): boolean {
  if (v === undefined) return false;
  return ['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

/**
 * Is this process in a mode that actually SERVES remote HTTP MCP to network clients
 * (i.e. the mode where missing MCP_AUTH_TOKEN / MCP_ALLOWED_HOSTS = a silent outage)?
 *
 * Ground-truth reasoning (do not "simplify" without re-reading the deploy configs):
 *   - The `/mcp` route is mounted whenever the HealthServer has a RemoteMcpTransport,
 *     which is ALWAYS in this codebase — so "is the route mounted" cannot be the gate
 *     (it would break stdio/dev/test, which also bind the HTTP server but never expose
 *     /mcp to real remote clients).
 *   - The deployments that genuinely serve /mcp to the network — tenant docker,
 *     prod systemd, the staging canary — all run with NODE_ENV=production
 *     (docker-compose.yml: `NODE_ENV: production`; Dockerfile: `ENV NODE_ENV=production`).
 *   - CI/tests run NODE_ENV=test; migrations run NODE_ENV=development; local Claude-Code
 *     stdio runs development/unset. None of those serve the public surface.
 *
 * Therefore the gate is: production-like (NODE_ENV=production) OR an explicit opt-in,
 * with an explicit opt-out escape hatch. This protects prod/tenants automatically
 * (no NEW var to forget — which is the exact bug class we're killing) while leaving
 * dev/stdio/test untouched.
 */
export function isRemoteMcpServingMode(env: NodeJS.ProcessEnv = process.env): boolean { // env-read: object-passthrough(env alias -> reads MCP_REMOTE_ENABLED, NODE_ENV, and env[v] dynamically; all net-covered)
  const flag = env.MCP_REMOTE_ENABLED?.trim();

  // Explicit opt-out wins: an operator who knows this instance is stdio-only can
  // set MCP_REMOTE_ENABLED=false even under NODE_ENV=production.
  if (isFalsyFlag(flag)) return false;

  // Explicit opt-in.
  if (isTruthyFlag(flag)) return true;

  // Default: production deployments are remote-serving; everything else is not.
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

export interface RemoteMcpEnvResult {
  /** Whether the guard considered this a remote-serving mode at all. */
  serving: boolean;
  /** Required vars that are missing/empty in a serving mode (empty when ok). */
  missing: string[];
  /** True iff serving AND nothing missing — safe to start. */
  ok: boolean;
}

/**
 * PURE evaluation: decide serving-mode and which required vars are missing.
 * No process exit, no throw — callers decide what to do. Unit-testable.
 */
export function evaluateRemoteMcpEnv(
  env: NodeJS.ProcessEnv = process.env // env-read: object-passthrough(forwarded to isRemoteMcpServingMode; same env alias)
): RemoteMcpEnvResult {
  const serving = isRemoteMcpServingMode(env);
  if (!serving) {
    return { serving: false, missing: [], ok: true };
  }
  const missing = REQUIRED_REMOTE_MCP_VARS
    .filter(v => {
      const raw = env[v.name];
      return raw === undefined || raw.trim() === '';
    })
    .map(v => v.name);
  return { serving: true, missing, ok: missing.length === 0 };
}

/**
 * Build the human-facing FATAL message (named vars + how to fix). Exported so the
 * test can assert the exact wording without scraping process output.
 */
export function formatMissingEnvFatal(missing: string[]): string {
  const lines = [
    '❌ FATAL: remote MCP HTTP transport is enabled but required env var(s) are missing/empty.',
    '   The server is REFUSING TO START rather than boot into a broken fail-closed state',
    '   (would 503/403 every /mcp request — see a past incident, the Tailspin outage).',
    '',
    '   Missing:',
  ];
  for (const name of missing) {
    const meta = REQUIRED_REMOTE_MCP_VARS.find(v => v.name === name);
    lines.push(`     • ${name} — ${meta ? meta.why : 'required for remote MCP'}`);
  }
  lines.push('');
  lines.push('   Set the var(s) above in this environment, or set MCP_REMOTE_ENABLED=false');
  lines.push('   if this instance genuinely does NOT serve remote HTTP MCP (stdio-only).');
  return lines.join('\n');
}

/**
 * Enforce the guard at startup. In a remote-serving mode with any required var
 * missing: log a CLEAR FATAL error that NAMES the exact var(s), then exit non-zero.
 * Otherwise return quietly (logging a short confirmation when serving).
 *
 * `exit` is injectable so tests can assert the exit code without killing the runner.
 */
export function assertRemoteMcpEnvOrExit(
  env: NodeJS.ProcessEnv = process.env, // env-read: object-passthrough(forwarded to evaluateRemoteMcpEnv; same env alias)
  exit: (code: number) => never = (code) => process.exit(code) as never
): void {
  const result = evaluateRemoteMcpEnv(env);

  if (!result.serving) {
    // Local/stdio/dev/test path — nothing required, do not log noise.
    return;
  }

  if (result.ok) {
    logger.info(
      '✅ Remote MCP env guard: serving mode + required vars present ' +
      `(${REQUIRED_REMOTE_MCP_VARS.map(v => v.name).join(', ')}).`
    );
    return;
  }

  const fatal = formatMissingEnvFatal(result.missing);
  // Log via the structured logger AND stderr so the named vars are impossible to miss
  // regardless of log routing/level.
  logger.error(fatal);
  console.error(fatal);
  exit(1);
}
