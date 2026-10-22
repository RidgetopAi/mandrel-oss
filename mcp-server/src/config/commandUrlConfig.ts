/**
 * COMMAND UI record-permalink config + the single shared helper ( * an earlier decision).
 *
 * THE GOAL: every id-emitting MCP tool RESULT carries a plain, clickable permalink to the
 * record — `<this instance's Command UI>/r/<id8>` — so an id is clickable everywhere
 * (terminal, mobile Remote Control, copy-paste to X) WITHOUT depending on the calling model
 * remembering a convention. This is a SOURCE-layer guarantee: Mandrel annotates only its own
 * records, so there are zero false-positives on git short-shas (both are 8-hex).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES. The base
 * URL is resolved HERE, once — from config (COMMAND_BASE_URL) or, failing that, from this
 * instance's own host — never as a literal buried in a route/handler where it would silently
 * drift. Resolved at module load, like the other config modules (recallConfig:envInt, etc.).
 *
 * ONE SOURCE OF TRUTH: every place that renders a permalink calls `recordUrl()` /
 * `formatRecordRef()` here — the id8 shortening + the base URL live in exactly one place, so
 * the class of "scattered substring(0,8) + a per-site URL" can never form.
 *
 * RESOLVABILITY (grounded, not assumed): this set must be a SUBSET of what the Command UI
 * resolver can actually resolve, or we emit links that 404 — worse than no link.
 * The resolver's own enumeration is `RESOLVABLE_TYPES` in
 * mandrel-command/backend/src/utils/idResolver.ts. As of an earlier task that is
 * context / task / decision / session / project, and the list below matches it exactly.
 * `isResolvableRecordType()` gates the mixed-type surfaces (e.g. smart_search).
 *
 * ⚠️ THIS LIST CANNOT IMPORT THE RESOLVER'S LIST — the two live on opposite sides of a
 * tsconfig rootDir boundary (the same boundary documented at length in idResolver.ts and
 * searchPredicates.ts), so this is a deliberate mirror, not an accident. It is a genuine
 * second copy and it can drift silently: this file used to say "session/project would 404"
 * for the two weeks between the resolver shipping three types and this task adding two more.
 * The guard against that drift is the cross-boundary parity test in
 * mcp-server/src/tests/commandUrlConfig.unit.test.ts, which READS the backend file and fails
 * if the two enumerations diverge. If you change either list, that test is what catches you.
 */

/**
 * MULTI-TENANT CORRECTNESS — why there is no hardcoded default origin any more.
 *
 * This module used to default COMMAND_BASE_URL to the literal `https://command.example.com`.
 * On the single prod instance that was right; on the tenant fleet it was silently WRONG. Every
 * tenant mcp-server runs with COMMAND_BASE_URL unset, so all seven of them emitted permalinks
 * pointing at OUR Command UI instead of their own — a tenant clicking their own record id got
 * our login page, and the id would not have resolved there anyway (it lives in their database,
 * not ours). Reported by a customer, root-caused 2026-07-30.
 *
 * The defect class is "a default that names ONE specific deployment". A wrong-but-self-scoped
 * link is a bad link; a link into a DIFFERENT tenant's instance is a cross-tenant leak of the
 * worst kind — it teaches a customer that their data might live on someone else's box. So the
 * fallback below can never again name a foreign origin: absent explicit config we derive from
 * THIS instance's own advertised host, which is by construction the caller's own instance.
 *
 * Resolution order:
 *   1. COMMAND_BASE_URL — explicit, always wins. Every deployed instance SHOULD set this.
 *   2. First non-loopback entry of MCP_ALLOWED_HOSTS — this instance's own public host. Correct
 *      for the tenant fleet, where the Command UI and the MCP server share one hostname.
 *   3. Local dev only.
 *
 * ⚠️ Rung 2 is NOT correct for the prod systemd instance, where the MCP host
 * (`mandrel.example.com`) and the Command UI (`command.example.com`) are DIFFERENT hosts.
 * Prod therefore MUST set COMMAND_BASE_URL explicitly (it does: /etc/app/prod/mcp.env). If
 * that is ever dropped, prod degrades to a self-referential 404 — visibly broken, but still
 * never pointing at a customer.
 */

/** Loopback / wildcard authorities, with optional port — never a usable public origin. */
const LOOPBACK_AUTHORITY = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::\d+)?$/i;

/** Where a developer's Command UI runs when nothing is configured (compose maps frontend 3000). */
const LOCAL_DEV_BASE_URL = 'http://localhost:3000';

/** Strip trailing slashes so `recordUrl` always joins with a single `/r/` (no `//r/`). */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * This instance's own public host: the first non-loopback entry of MCP_ALLOWED_HOSTS.
 *
 * We SCAN rather than take [0] because nothing orders this list public-first — it is free-form
 * operator config, and the loopback entries are conventionally written first (the staging
 * tenant's list is `127.0.0.1:18099,localhost:18099`). Taking [0] would yield a loopback origin
 * on any such list. Scanning costs nothing and cannot be wrong in a way [0] is not.
 *
 * ⚠️ HONEST STATUS: as of 2026-07-30 this rung is NOT exercised by any live deployment. All 7
 * tenants and prod set COMMAND_BASE_URL explicitly (rung 1), so derivation is a safety net for
 * a MISCONFIGURED or newly-provisioned instance, not a path the fleet runs on. Do not read the
 * fleet's correctness as evidence that this function works — the unit tests are its only proof.
 */
function ownPublicHost(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  for (const entry of raw.split(',')) {
    const host = entry.trim();
    if (host === '' || LOOPBACK_AUTHORITY.test(host)) continue;
    return host;
  }
  return undefined;
}

/**
 * The Command UI origin the `/r/<id8>` permalinks point at. See the multi-tenant note above for
 * the resolution order and why there is no hardcoded production default.
 */
function resolveCommandBaseUrl(): string {
  const explicit = process.env.COMMAND_BASE_URL;
  if (explicit !== undefined && explicit.trim() !== '') {
    return stripTrailingSlashes(explicit.trim());
  }

  const host = ownPublicHost(process.env.MCP_ALLOWED_HOSTS);
  if (host !== undefined) {
    return stripTrailingSlashes(`https://${host}`);
  }

  return LOCAL_DEV_BASE_URL;
}

export const COMMAND_BASE_URL = resolveCommandBaseUrl();

/**
 * The Mandrel record types the `/r/:id` navigation resolver can resolve (and therefore the
 * only types we may safely linkify). Kept as one named set so the mixed-type surfaces read
 * the SAME truth as the resolver — no drifting copies.
 */
export const RESOLVABLE_RECORD_TYPES = [
  'context',
  'task',
  'decision',
  'session',
  'project',
] as const;
export type ResolvableRecordType = (typeof RESOLVABLE_RECORD_TYPES)[number];

/** True if `type` is a record type the `/r/:id` resolver can resolve (safe to linkify). */
export function isResolvableRecordType(type: string | undefined | null): boolean {
  return typeof type === 'string' && (RESOLVABLE_RECORD_TYPES as readonly string[]).includes(type);
}

/**
 * The id8 form used in a permalink: the first 8 chars of a record UUID. The `/r/:id` resolver
 * accepts this short id (it prefix-matches on ≥8 hex, the short-id form every tool reference
 * uses). A full UUID's first 8 chars are always hex (the first dash is at index 8), so a plain
 * `slice(0, 8)` is correct; an already-short id passes through unchanged.
 */
export function recordId8(id: string): string {
  return id.slice(0, 8);
}

/**
 * THE shared helper: the clickable permalink for a Mandrel record id. Plain full https:// URL
 * (NOT markdown) so it auto-linkifies in terminals + mobile and survives copy-paste to X.
 * Only ever pass a REAL Mandrel record id (context/task/decision) — the caller knows the id is
 * a genuine record, so there is no ambiguity with a git sha.
 */
export function recordUrl(id: string): string {
  return `${COMMAND_BASE_URL}/r/${recordId8(id)}`;
}

/**
 * House-style permalink line for a record id: the full permalink URL (which carries the
 * id8), as a PLAIN line — the `🔗` marker was dropped in WS1 (D2): MCP tool
 * results go to machine readers, and a bare https:// URL auto-linkifies everywhere the
 * marker did. Appended after the `ID:` line at WRITE-ack render sites (a stored/created
 * record's one-line clickable ref); READ/list surfaces carry the permalink in
 * structuredContent.url instead of repeating a URL line per row. Returns just the line
 * (no leading/trailing newline) — the call site owns spacing/indentation.
 */
export function formatRecordRef(id: string): string {
  return recordUrl(id);
}
