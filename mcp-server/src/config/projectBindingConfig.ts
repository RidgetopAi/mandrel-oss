/**
 * PROJECT BINDING config — the CLIENT-side half of Amp-orb eval finding W5
 * (report `docs/amp-orb-eval/…-2026-07-24.md` lines 497-520).
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * ---------------------------------
 * Every fresh autonomous orb auto-selected the WRONG project (`daily log`) even while
 * running in `amp-exp-1`, because a connection with no switched project falls through
 * `projectHandler.initializeSession()` to "Priority 4: first available project" — which
 * is ORDER-DEPENDENT (`projects ORDER BY updated_at DESC`). Every worker had to inspect,
 * switch and re-confirm before writing. It worked; ONE missed step writes durable data
 * into the wrong project, permanently and silently.
 *
 * A BINDING is an autonomous client DECLARING which project it is scoped to, up front,
 * as configuration. A bound client never auto-selects: it starts in its project and
 * STAYS there — and any call that names a DIFFERENT project fails LOUDLY rather than
 * silently winning or silently losing.
 *
 * CONFIGURATION SURFACES (a client configures ONE of these; both are optional)
 * ---------------------------------------------------------------------------
 *   1. `X-Mandrel-Project` request header  — PER-CONNECTION. The MCP-skill/orb surface:
 *      an autonomous client sets it once in its connection config. Most specific, so it
 *      WINS over the process env when both are present.
 *   2. `MANDREL_PROJECT_ID` env var        — PROCESS-WIDE. For a stdio client, a bridge
 *      process, or a single-purpose per-tenant container that only ever serves one
 *      project. Read at CALL TIME (never memoized at module load) so a test/host can
 *      change it without a poisoned cache — a past incident's static-import sub-trap.
 *
 * Either value may be a project UUID **or** a project NAME; both are resolved to a
 * canonical project id before any comparison (services/projectBinding.ts).
 *
 * DEFAULT = TODAY. With neither surface set there is NO binding, and every code path is
 * byte-identical to before this feature (the legacy behaviour is the default;
 * interactive `project_switch` for humans is completely untouched).
 *
 * This module is PURE (no DB, no handler imports) so it is trivially unit-testable; the
 * resolution + enforcement live in `services/projectBinding.ts`. Mirrors the config-driven
 * pattern in projectEchoConfig.ts / taskConfig.ts (configs-not-hardcoded).
 */

/**
 * The PER-CONNECTION binding header name. Lowercase because express `req.header()` is
 * case-insensitive and every other header constant in the transports is lowercase
 * (`x-connection-id`, `x-actor-id`).
 */
export const PROJECT_BINDING_HEADER = 'x-mandrel-project';

/**
 * The PROCESS-WIDE binding env var name. Named as a constant (not a literal at the read
 * site) so the name appears exactly once and the error messages, the docs and the read
 * can never drift apart.
 */
export const PROJECT_BINDING_ENV_VAR = 'MANDREL_PROJECT_ID';

/** Where a binding value came from — carried into audit lines and error messages. */
export type ProjectBindingOrigin = 'header' | 'env';

/** A configured binding: the raw identifier the client declared, plus where it came from. */
export interface ConfiguredBinding {
  /** The raw declared identifier — a project UUID or a project NAME, as configured. */
  identifier: string;
  /** Which surface it came from (for the audit line and the error message). */
  origin: ProjectBindingOrigin;
  /** The human-facing name of that surface, e.g. `X-Mandrel-Project` header. */
  originLabel: string;
}

/** Trim + treat whitespace-only as absent. A blank header must not mean "bound to ''". */
function clean(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s === '' ? undefined : s;
}

/**
 * Read the PROCESS-WIDE binding from the environment. Read at CALL TIME on purpose —
 * see the module header. Returns undefined when unset/blank (the default: no binding).
 */
export function envBinding(): ConfiguredBinding | undefined {
  const raw = clean(process.env[PROJECT_BINDING_ENV_VAR]); // env-read: MANDREL_PROJECT_ID
  if (!raw) return undefined;
  return { identifier: raw, origin: 'env', originLabel: `${PROJECT_BINDING_ENV_VAR} env var` };
}

/**
 * THE BINDING LADDER, rung 2's internal order: per-connection header BEATS process env.
 * A header is the more specific declaration (this client, this connection) and the env is
 * the host-wide fallback — so a bound orb on a shared server is never overridden by the
 * host's default. Stated here, in one place, and exercised by
 * `src/tests/projectBinding.contract.test.ts` — "sub-ladder: the per-connection HEADER
 * beats the process-wide ENV", which sets the env to one project, passes the header for
 * another, and asserts the resolved binding is the HEADER's (it drives the real
 * `resolveProjectBinding`, which reaches this function). The file this comment used to
 * name, `projectBinding.unit.test.ts`, has never existed.
 *
 * @param headerValue the raw `X-Mandrel-Project` value the transport read off the request
 */
export function configuredBinding(headerValue?: string): ConfiguredBinding | undefined {
  const header = clean(headerValue);
  if (header) {
    return { identifier: header, origin: 'header', originLabel: `${PROJECT_BINDING_HEADER} header` };
  }
  return envBinding();
}
