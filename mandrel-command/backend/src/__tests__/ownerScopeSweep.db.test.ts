/**
 * ownerScopeSweep — THE WHOLE-CLASS GUARD for OWNER/USER scoping.
 *
 * =============================================================================
 * THE GAP THIS CLOSES
 * =============================================================================
 * `unscopedListProjectScope.db.test.ts` is a real whole-class guard, but it can only ask
 * ONE question: does this route leak across PROJECTS. It plants project_id-bearing
 * fixtures and sweeps for them, so a table with NO project_id is invisible to it. The
 * `feedback` table has no project_id — so that guard passed `GET /api/feedback` trivially
 * while the route was returning EVERY user's free-text submissions to any authenticated
 * caller. We had automated whole-class coverage for project scoping and
 * ZERO for owner scoping. This file is the sibling that asks the other question.
 *
 * `feedbackOwnerScope.db.test.ts` closes that ONE route. Nothing swept the others. This
 * does.
 *
 * =============================================================================
 * THE SMALLEST INPUT WHERE "OWNER-SCOPED" AND "UNSCOPED" DIVERGE  (C3 subclass A)
 * =============================================================================
 * TWO USERS THAT ARE IDENTICAL IN EVERY OTHER SCOPING DIMENSION — same role (`user`,
 * non-admin), same project grants (both granted P_SHARED and nothing else), same
 * everything — whose ONLY difference is the rows they OWN.
 *
 * That pair is the whole point, and getting it wrong is how an owner guard passes for the
 * wrong reason:
 *   - If A and B held DIFFERENT project grants, every project-scoped route would differ
 *     between them and the difference would be attributable to project scoping. An
 *     owner-blind route that is also project-filtered would then have nothing of B's to
 *     leak into A's view, and would pass while being unscoped on the owner axis.
 *   - If A and B held the SAME grants but the guard only planted PROJECT-keyed rows, it
 *     would measure nothing at all — that is exactly the blindness described above.
 * So: identical grants, and the planted rows are OWNER-keyed (`feedback.user_id`,
 * `admin_users` identity). Project scoping cannot mask the answer and cannot supply it.
 * A/B is the pure pair; persona C exists only to carry one extra marker (below) and is
 * deliberately kept OUT of the ratchet population so it cannot pollute that purity.
 *
 * =============================================================================
 * THE ROUTE POPULATION, AND WHY IT IS THE WHOLE ONE (C3)
 * =============================================================================
 * EVERY GET route registered on the real Express `app` exported by `src/server.ts`, read
 * out of `app._router.stack` at runtime and walked recursively through every mounted
 * sub-router — the same derivation `unscopedListProjectScope.db.test.ts` and
 * `mutatingRouteAuthzCoverage.test.ts` use, and for the same reason: `server.ts` mounts
 * routers `routes/index.ts` never sees, so walking the aggregator measures a PROXY for
 * the served surface. There is NO hand-written list of "endpoints that return owner
 * rows": a NEW route enters this sweep by EXISTING, on the day it is added.
 *
 * =============================================================================
 * THE DATA POPULATION, AND WHY IT IS THE WHOLE ONE (C3)
 * =============================================================================
 * The ratchet below reads `information_schema` on the REAL MIGRATED SCHEMA and returns
 * every column with a FOREIGN KEY into an identity table (`admin_users`, `user`), plus the
 * identity tables themselves. That derived set is asserted EQUAL, IN BOTH DIRECTIONS, to a
 * frozen inventory in which every member states its scoping INTENT and the reason for it.
 * A new FK-KEYED owner column therefore FAILS this suite until someone declares what it
 * is, and a declaration cannot be silenced by deleting a line, because deletion fails the
 * other direction.
 *
 * THE FK DERIVATION IS ONE OF TWO HALVES. It reaches every column that POINTS AT an
 * identity row. This schema's other ownership idiom is a BARE STRING with no foreign key
 * — `sessions.actor`, `tasks.created_by`, `technical_decisions.decided_by` — and the FK
 * query cannot see it: measured by Reviewer on this branch, an
 * actor-only table plus an owner-blind route reading it passed 16/16 with no declaration
 * demanded. That half is now derived too, by STRING_OWNER_INTENT below,
 * whose population is the DUMB ENUMERATION of every text column in the schema rather than
 * a pattern's yield. The two inventories are disjoint by construction: a column declared
 * by the FK half is excluded from the string half, so no column carries two intents.
 *
 * =============================================================================
 * ASSERTIONS ARE ON SEEDED STRINGS, NEVER ON COUNTS
 * =============================================================================
 * A count assertion passes against an empty response and hides a broken fixture. Every
 * leak assertion here is anchored on a string this test WROTE, and every "sees nothing"
 * assertion is paired with a LANDED assertion proving the same string IS visible to the
 * persona entitled to it. If a fixture cannot be planted the suite FAILS LOUD — it never
 * skips and never passes vacuously.
 *
 * =============================================================================
 * WHAT THIS GUARD DOES NOT SEE — stated, not claimed closed
 * =============================================================================
 * (c) Routes are called BARE. A leak that requires an attacker-supplied parameter
 *     (`?userId=<someone else>`) is not in this population except on `/api/feedback`,
 *     where the parameter probe below tries the obvious widenings. The same limit applies
 *     to unscopedListProjectScope's sweep, for the same reason: a route with a `:param`
 *     cannot be called bare.
 * (d) Some swept routes return no data in this harness and are therefore swept VACUOUSLY:
 *     presence in the sweep is not by itself evidence that a route was exercised WITH data.
 * (a) and (b) are asserted in the RESIDUAL tests at the bottom of the file rather than
 *     described here, because a sentence cannot be measured.
 *
 * =============================================================================
 * LOCAL RUN
 * =============================================================================
 *   bash scripts/provision-test-db.sh ci_myownerscope
 *   eval "$(bash scripts/provision-test-db.sh ci_myownerscope --print-env)"
 *   cd mandrel-command/backend && npx jest src/__tests__/ownerScopeSweep.db.test.ts
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { backendPool } from '../database/poolManager';

/** Dedicated `0a` id prefix: this suite shares ONE database with ~75 others. */
const U_A = '0a000001-0000-4000-8000-0a000000000a';
const U_B = '0a000002-0000-4000-8000-0a000000000b';
const U_C = '0a000003-0000-4000-8000-0a000000000c';
const P_SHARED = '0a100001-0000-4000-8000-0a100000000a';
const P_C_ONLY = '0a100002-0000-4000-8000-0a100000000b';
const ALL_USERS = [U_A, U_B, U_C];
const ALL_PROJECTS = [P_SHARED, P_C_ONLY];

/**
 * LOWERCASE markers, compared case-insensitively. A renderer that upper/lower-cases a
 * username would otherwise silently defeat the account marker — the detector must not be
 * defeatable by a display transform.
 */
const MARK_B_FEEDBACK = 'osleakmarkerbfeedback';
const MARK_B_ACCOUNT = 'osleakmarkerbaccount';
const MARK_B_PERTURB = 'osleakmarkerbperturb';
const MARK_C_GRANT = 'osleakmarkercgrant';
const MARK_A_OWN = 'osownmarkerafeedback';
const MARK_SHARED = 'ossharedmarkerproject';

/** Every marker A must never see, and the persona each one belongs to. */
const FOREIGN_MARKERS: ReadonlyArray<{ marker: string; owner: string }> = [
  { marker: MARK_B_FEEDBACK, owner: "B's feedback row (feedback.user_id)" },
  { marker: MARK_B_ACCOUNT, owner: "B's account identity (admin_users)" },
  { marker: MARK_C_GRANT, owner: "C's private project (user_project_access)" },
];

const NAME_A = 'osprobealice';
const NAME_B = `osprobe${MARK_B_ACCOUNT}`;
const NAME_C = 'osprobecarol';

type Persona = 'a' | 'b' | 'c';

const TODAY = new Date().toISOString().slice(0, 10);

/** GET routes that need query params before they return anything but a 400. */
const PARAMETERISED_QUERY: ReadonlyArray<{ path: string; qs: string }> = [
  { path: '/api/day-summary', qs: `?date=${TODAY}` },
  { path: '/api/momentum-series', qs: `?from=${TODAY}&to=${TODAY}` },
];

// ── the route derivation ──────────────────────────────────────────────────────────────
function mountPrefix(layer: any): string {
  if (typeof layer.path === 'string') return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

function discoverGetRoutes(): string[] {
  const out: string[] = [];
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const p = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        if (layer.route.methods.get) out.push(p || '/');
      } else if (typeof layer.handle === 'function' && Array.isArray((layer.handle as any).stack)) {
        walk((layer.handle as any).stack, prefix + mountPrefix(layer));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out;
}

const ALL_GET_ROUTES = discoverGetRoutes();
/** SSE endpoints never terminate; excluded by SHAPE, not by name. */
const SWEEPABLE = ALL_GET_ROUTES.filter(
  (p) => !p.includes(':') && !p.includes('*') && !p.startsWith('/api/events') && !p.includes('stream')
);

/**
 * THE DECLARED INSTRUMENT-NOISE SET — frozen, and asserted to be a SUPERSET of what any
 * single run measures. Two samples cannot classify a route whose output depends on how
 * many requests have been made or how long they took (`/api/monitoring/*` reports live
 * `responseTime` and request counters that this very sweep moves). Measured self-jitter
 * is checked to be a SUBSET of this list rather than used as the exclusion itself —
 * otherwise the exclusion is decided by sampling luck.
 *
 * These routes are excluded from the DIFF axis only. They are still swept for foreign
 * markers, and RESIDUAL (a) asserts that explicitly, so the exclusion never buys silence.
 *
 * This list is a second copy of the one in unscopedListProjectScope.db.test.ts on purpose
 * and not by accident: each guard's volatile set is its OWN measurement under its OWN
 * persona mix, and the subset assertion below is what keeps this copy honest rather than
 * inherited.
 */
const FROZEN_VOLATILE: readonly string[] = [
  '/',
  '/api/feature-flags',
  '/api/health',
  '/api/healthz',
  '/api/mcp/healthz',
  '/api/livez',
  '/api/readyz',
  '/api/db-status',
  '/api/version',
  '/api/openapi',
  '/api/openapi/openapi.json',
  '/api/openapi/postman.json',
  '/api/monitoring/health',
  '/api/monitoring/metrics',
  '/api/monitoring/trends',
  '/api/monitoring/services',
  '/api/monitoring/stats',
  '/api/monitoring/alerts',
  '/api/monitoring/alert-rules',
  '/api/monitoring/status',
  '/api/monitoring/dashboard',
  '/api/validation/schemas',
  '/api/validation/stats',
  '/api/validation/test/projects',
  '/api/validation/test/tasks',
  '/api/validation/health',
  '/api/type-safety/demo',
  '/api/type-safety/consistency',
  '/api/type-safety/schema-sync',
  '/api/type-safety/health',
];

/**
 * ── THE OWNER-KEYED DATA INVENTORY ───────────────────────────────────────────────────
 * The identity tables an "owner" can be. Declared (a schema cannot tell you which of its
 * tables means "a person"), but both are asserted to EXIST below, so a rename fails here
 * rather than silently emptying the derivation.
 */
const IDENTITY_TABLES = ['admin_users', 'user'] as const;

type Intent = 'PRIVATE_PLANTED' | 'PROJECT_SCOPED' | 'UNRENDERED' | 'FOREIGN_SURFACE';

/**
 * FROZEN, BOTH DIRECTIONS — over the FK-KEYED columns only. Every column in the live
 * schema carrying a FOREIGN KEY into an identity table must appear here with a stated
 * intent, and every entry here must still exist in the schema. A column that keys
 * ownership by a bare actor/username STRING with no FK is not derived HERE; it is derived
 * by STRING_OWNER_INTENT below, which owns that half of the schema.
 *
 *   PRIVATE_PLANTED  — must never cross users; this suite plants a marker in it and
 *                      sweeps the whole GET surface for that marker.
 *   PROJECT_SCOPED   — the owner column is PROVENANCE on a project-scoped resource;
 *                      visibility is decided by project grants, which is
 *                      unscopedListProjectScope.db.test.ts's question, not this one.
 *   UNRENDERED       — no route returns these rows' contents at all.
 *   FOREIGN_SURFACE  — better-auth / OAuth-provider tables owned by mcp-server, not by
 *                      this Express app. Stated as a RESIDUAL, not claimed as covered.
 */
const OWNER_KEYED_INTENT: Readonly<Record<string, { intent: Intent; why: string }>> = {
  'admin_users.id': {
    intent: 'PRIVATE_PLANTED',
    why: "the identity row itself — B's username/email carry MARK_B_ACCOUNT and A must never see them",
  },
  'feedback.user_id': {
    intent: 'PRIVATE_PLANTED',
    why: 'free-text submissions, own-rows-only (migration 077) — the original leak',
  },
  'user_project_access.user_id': {
    intent: 'PRIVATE_PLANTED',
    why: "another user's grants are private; planted as C's grant to a project named with MARK_C_GRANT",
  },
  'user_project_access.granted_by': {
    intent: 'PRIVATE_PLANTED',
    why: 'the same grant row as user_id above — planted non-NULL by the fixture and moved by the same perturbation',
  },
  'sessions.user_id': {
    intent: 'PROJECT_SCOPED',
    why: 'an agent session is a project resource; user_id is provenance. Visibility is by project grant, guarded by unscopedListProjectScope.db.test.ts',
  },
  'auth_tokens.user_id': {
    intent: 'UNRENDERED',
    why: 'token rows are never returned by any route; invalidation is guarded by revokeSessionsInvalidatesTokens.db.test.ts',
  },
  'user.id': { intent: 'FOREIGN_SURFACE', why: 'better-auth identity table, served by mcp-server not this app' },
  'account.userId': { intent: 'FOREIGN_SURFACE', why: 'better-auth credential linkage, served by mcp-server' },
  'session.userId': { intent: 'FOREIGN_SURFACE', why: 'better-auth session table, served by mcp-server' },
  'oauthClient.userId': { intent: 'FOREIGN_SURFACE', why: 'OAuth provider table, served by mcp-server' },
  'oauthConsent.userId': { intent: 'FOREIGN_SURFACE', why: 'OAuth provider table, served by mcp-server' },
  'oauthAccessToken.userId': { intent: 'FOREIGN_SURFACE', why: 'OAuth provider table, served by mcp-server' },
  'oauthRefreshToken.userId': { intent: 'FOREIGN_SURFACE', why: 'OAuth provider table, served by mcp-server' },
};

/** The tables the inventory calls PRIVATE_PLANTED, derived from it rather than restated. */
const PRIVATE_TABLES = [
  ...new Set(
    Object.entries(OWNER_KEYED_INTENT)
      .filter(([, v]) => v.intent === 'PRIVATE_PLANTED')
      .map(([k]) => k.split('.')[0])
  ),
];
type PrivateTable = string;

/**
 * ── THE SECOND OWNERSHIP IDIOM: BARE STRING IDENTITY COLUMNS ─────────────────────────
 * (an earlier task. Closes the gap the FK-only derivation above declares.)
 *
 * The FK derivation reaches every column that POINTS AT an identity row. This schema's
 * other way of saying "whose row is this" is a BARE STRING — `sessions.actor`,
 * `tasks.created_by`, `technical_decisions.decided_by` — with no foreign key at all.
 * Reviewer proved that idiom invisible to the FK ratchet: an
 * actor-only table plus an owner-blind route reading it passed 16/16 and no declaration
 * was demanded. This block is the derivation that demands one.
 *
 * IT IS A NAME-PATTERN MATCHER, AND THAT IS THE FAIL-OPEN RISK (C3 subclass B). A column
 * named by a convention nobody anticipated is invisible to a pattern, and a bespoke
 * matcher that cannot classify its input says nothing at all. So the pattern is NOT the
 * population. The population is the DUMB ENUMERATION — every text-typed column on every
 * base table in the live schema — partitioned into exactly two frozen halves:
 *
 *   MATCHED   -> STRING_OWNER_INTENT below, `table.column`, each with a stated intent
 *                whose claim is BACKED BY AN EXECUTED CHECK (see the backing tests).
 *   UNMATCHED -> NON_IDENTITY_COLUMN_NAMES below, the declared remainder.
 *
 * Neither half may grow silently. A text column that is in neither fails this suite, so
 * an unclassifiable column is a FINDING rather than a pass. That cross-check is not
 * ceremony: it is what caught this pattern's OWN first draft, which matched
 * `actor|created_by|assigned_to|username` and silently dropped `technical_decisions.
 * decided_by`, `decision_outcomes.measured_by`, `decision_retrospectives.facilitator`,
 * `decision_impact_analysis.discovered_by` and the `git_commits.committer_*` pair.
 *
 * THE REMAINDER IS KEYED BY COLUMN NAME, NOT BY `table.column`. A new table that reuses
 * an already-declared name (`title`, `status`, `content`) does not re-trigger this
 * ratchet; a new NAME does. That is the reach this half has, chosen so that ordinary
 * migrations stay green while a novel identity-ish name cannot enter the schema unseen.
 *
 * Columns already covered by the FK derivation are excluded from BOTH halves — they are
 * declared in OWNER_KEYED_INTENT and declaring them twice would let one copy drift.
 */

/**
 * Applied to a snake_cased form of the column name, so camelCase columns on the
 * better-auth tables (`userAgent`, `accountId`) are matched by the same rule as
 * `user_agent`. Deliberately WIDER than the columns that exist today: matching a column
 * that turns out not to be a person reference costs one `NOT_AN_OWNER` declaration, while
 * missing one costs silence.
 */
const STRING_IDENTITY_PATTERN =
  /(^|_)(actor|owner|author|committer|assignee|creator|facilitator|user|username|agent|person|member|account)(_|$)|_by$|(^|_)(email|handle|display_name|full_name|nickname|assigned_to)$/;

const snake = (col: string): string => col.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const isIdentityName = (column: string): boolean => STRING_IDENTITY_PATTERN.test(snake(column));

type StringIntent = Intent | 'NOT_AN_OWNER';

/**
 * FROZEN, BOTH DIRECTIONS. Intents carry the same meanings as OWNER_KEYED_INTENT, plus:
 *
 *   NOT_AN_OWNER — the pattern matched but the column does not name a person
 *                  (`sessions.user_agent` is a client string, `agent_type` is a category).
 *                  This is the one intent with no executed backing available, so it is
 *                  the one to read sceptically; it is frozen both directions like the
 *                  rest, so it cannot be used to make a column disappear quietly.
 *
 * Backing, all EXECUTED below rather than asserted in prose:
 *   PROJECT_SCOPED  -> the table really has a `project_id` column, so deferring to
 *                      unscopedListProjectScope.db.test.ts is a real deferral.
 *   UNRENDERED      -> the table name appears NOWHERE in the shipped backend source, so
 *                      the day someone writes a route against it this goes RED.
 *   PRIVATE_PLANTED -> the column really holds one of this suite's foreign markers, so
 *                      THE SWEEP can actually see it.
 *   FOREIGN_SURFACE -> the table is one the FK inventory already declares foreign.
 */
const STRING_OWNER_INTENT: Readonly<Record<string, { intent: StringIntent; why: string }>> = {
  // ── PRIVATE_PLANTED: string columns that carry an identity this suite plants a marker into
  'admin_users.username': {
    intent: 'PRIVATE_PLANTED',
    why: "B's username carries MARK_B_ACCOUNT and the whole GET surface is swept for it",
  },
  'admin_users.email': {
    intent: 'PRIVATE_PLANTED',
    why: "B's email carries MARK_B_ACCOUNT — a second rendered field on the same private identity row",
  },
  'feedback.username': {
    intent: 'PRIVATE_PLANTED',
    why: 'the denormalised author handle on the original leak table; B\'s value carries MARK_B_ACCOUNT',
  },

  // ── PROJECT_SCOPED: provenance on a resource whose visibility is decided by project grant
  'analytics_events.actor': {
    intent: 'PROJECT_SCOPED',
    why: 'who emitted a project-scoped analytics event; visibility follows the project grant',
  },
  'commit_session_links.created_by': {
    intent: 'PROJECT_SCOPED',
    why: 'provenance on a commit/session correlation row inside a project',
  },
  'git_commits.author_name': {
    intent: 'PROJECT_SCOPED',
    why: 'git authorship on a project-scoped commit row; it is the commit\'s own metadata, not an access key',
  },
  'git_commits.author_email': {
    intent: 'PROJECT_SCOPED',
    why: 'git authorship on a project-scoped commit row; it is the commit\'s own metadata, not an access key',
  },
  'git_commits.committer_name': {
    intent: 'PROJECT_SCOPED',
    why: 'git committer on a project-scoped commit row; the pattern\'s first draft missed this pair entirely',
  },
  'git_commits.committer_email': {
    intent: 'PROJECT_SCOPED',
    why: 'git committer on a project-scoped commit row; the pattern\'s first draft missed this pair entirely',
  },
  'git_commits.discovered_by': {
    intent: 'PROJECT_SCOPED',
    why: 'which collector found a project-scoped commit row; provenance, not an owner key',
  },
  'links.created_by': {
    intent: 'PROJECT_SCOPED',
    why: 'who minted a typed edge between two project-scoped records; the edge is visible with the project',
  },
  'sessions.actor': {
    intent: 'PROJECT_SCOPED',
    why: 'an agent session is a project resource and actor is provenance — the same deferral OWNER_KEYED_INTENT makes for sessions.user_id',
  },
  'sessions.agent_display_name': {
    intent: 'PROJECT_SCOPED',
    why: 'the display handle of the same session actor, on the same project-scoped row',
  },
  'task_attachments.created_by': {
    intent: 'PROJECT_SCOPED',
    why: 'attachment provenance (Lane B) — who filed a "before" screenshot or stored "evidence"; visible to everyone granted the owning task\'s project, matching tasks.created_by\'s reasoning one row up',
  },
  'tasks.created_by': {
    intent: 'PROJECT_SCOPED',
    why: 'task provenance; a task is visible to everyone granted its project, whoever filed it',
  },
  'tasks.assigned_to': {
    intent: 'PROJECT_SCOPED',
    why: 'assignment is a workflow field, not a visibility filter — every grantee of the project sees every task',
  },
  'tasks.claim_actor': {
    intent: 'PROJECT_SCOPED',
    why: 'who holds the lease on a project-scoped task; visible to the project, like the task itself',
  },
  'technical_decisions.decided_by': {
    intent: 'PROJECT_SCOPED',
    why: 'who made a project-scoped decision; provenance on the record, not an owner key',
  },
  // Mutation-probed: deleting this entry alone turns the RATCHET
  // test below RED with exactly one diff line, `technical_decisions.answered_by`,
  // appearing in `received` and missing from `expected` — see the commit body.
  'technical_decisions.answered_by': {
    intent: 'PROJECT_SCOPED',
    why: 'who called decision_answer on a project-scoped decision (migration 104); same scope semantics as technical_decisions.decided_by one row up — provenance on the record, not an owner key',
  },

  // ── UNRENDERED: the table name appears nowhere in the shipped backend source
  'actor_project_defaults.actor': {
    intent: 'UNRENDERED',
    why: 'per-actor default project, read by mcp-server only; no route in this app touches the table',
  },
  'analysis_session_links.created_by': {
    intent: 'UNRENDERED',
    why: 'analysis/session correlation rows are not returned by any route in this app',
  },
  'analytics_events_shadow.actor': {
    intent: 'UNRENDERED',
    why: 'shadow-write table for the analytics migration; no route reads it',
  },
  'branch_membership_moves.actor': {
    intent: 'UNRENDERED',
    why: 'branch-position audit trail consumed by mcp-server; no route in this app reads it',
  },
  'decision_impact_analysis.discovered_by': {
    intent: 'UNRENDERED',
    why: 'decision impact rows are not returned by any route in this app; missed entirely by the pattern\'s first draft',
  },
  'decision_outcomes.measured_by': {
    intent: 'UNRENDERED',
    why: 'decision outcome rows are not returned by any route in this app; missed entirely by the pattern\'s first draft',
  },
  'decision_retrospectives.facilitator': {
    intent: 'UNRENDERED',
    why: 'retrospective rows are not returned by any route in this app; missed entirely by the pattern\'s first draft',
  },
  'envelope_audit.actor': {
    intent: 'UNRENDERED',
    why: 'HTTP envelope audit trail; no route reads it',
  },
  'session_pins.actor': {
    intent: 'UNRENDERED',
    why: 'per-actor session pin, owned by mcp-server; no route in this app reads it, and it carries no project_id so PROJECT_SCOPED would be a false deferral',
  },
  'task_claim_events.actor': {
    intent: 'UNRENDERED',
    why: 'task claim/renew/release audit trail; no route reads it',
  },
  'traffic_routing_config.updated_by': {
    intent: 'UNRENDERED',
    why: 'operator config table; no route reads it, and it carries no project_id',
  },

  // ── FOREIGN_SURFACE: better-auth / OAuth tables owned by mcp-server, not by this app
  'user.email': { intent: 'FOREIGN_SURFACE', why: 'better-auth identity table, served by mcp-server not this app' },
  'account.accountId': { intent: 'FOREIGN_SURFACE', why: 'better-auth provider account id, served by mcp-server' },
  'session.userAgent': { intent: 'FOREIGN_SURFACE', why: 'better-auth session client string, served by mcp-server' },

  // ── NOT_AN_OWNER: the pattern matched, the column does not name a person
  'sessions.user_agent': {
    intent: 'NOT_AN_OWNER',
    why: 'the HTTP client string of the session, not the person; matched only because the pattern deliberately over-reaches',
  },
  'sessions.agent_type': {
    intent: 'NOT_AN_OWNER',
    why: 'a category of agent (claude-code, mcp-client), one value shared by many actors',
  },
  'sessions_shadow.agent_type': {
    intent: 'NOT_AN_OWNER',
    why: 'the same category column on the sessions shadow-write table',
  },
  'sessions_backup_52d295df_9b0d_4b13_812f_c7353b530d7b.agent_type': {
    intent: 'NOT_AN_OWNER',
    why: 'the same category column on a migration-era backup copy of sessions left in the schema',
  },
  'sessions_backup_64fbdb1e_d900_4b17_969c_2a34f53de6a3.agent_type': {
    intent: 'NOT_AN_OWNER',
    why: 'the same category column on a migration-era backup copy of sessions left in the schema',
  },
};

/**
 * THE DECLARED REMAINDER — every DISTINCT text-column NAME in the live schema that
 * STRING_IDENTITY_PATTERN does not match and the FK derivation does not already cover.
 * Frozen both directions: a new name fails this suite until a human says which half it
 * belongs in. This is the list that makes the pattern's blind spot LOUD instead of
 * silent, and it is the reason the pattern was widened before this file was committed.
 */
const NON_IDENTITY_COLUMN_NAMES: readonly string[] = [
  '_shadow_validation_hash', 'a_type', 'accessToken', 'action', 'active_branch', 'activity_type', 
  'adoption_challenges', 'ai_model', 'ai_model_used', 'analysis_context', 'analysis_method', 
  'analysis_scope', 'analyzer_name', 'analyzer_version', 'answer_note', 'answer_status',
  'attached_to_type', 'b_type',
  'base_branch', 'blocked_on', 'branch_name', 'branch_type', 'category',
  'change_management_lessons', 'change_type', 'checksum', 'chosen', 'clientId', 'clientSecret',
  'commit_context_type', 'commit_sha', 'commit_type', 'component_type', 'confidence_level', 
  'config_name', 'connection_id', 'content', 'content_hash', 
  'context_summary', 'context_type', 'created_via_connection', 'creation_commit', 
  'creation_reason', 'current_commit_sha', 'current_sha', 'decision_type', 'dependency_type', 
  'derived_action', 'description', 'direction', 'display_id', 'documentation', 'edge_type', 
  'enhancement_strategy', 'error_class', 'error_message', 'event_type', 'evidence_type', 
  'failed_stage', 'failed_tier', 'failure_reason', 
  'failure_stage', 'file_hash', 'file_path', 'file_type', 'filename', 'from_type', 
  'full_ref_name', 'git_repo_url', 'hash', 'health_status', 'icon', 'id', 'idToken', 
  'idempotency_key', 'identifier', 'image', 'impact_direction', 'impact_level', 
  'impact_strength', 'impact_type', 'implementation_status', 'import_alias', 'import_path', 
  'insight_type', 'ipAddress', 'kind', 'language', 'language_filter', 'last_modified_commit',
  'lessons_learned', 'link_type', 'mapping_method', 'matched_text', 'merge_strategy',
  'merge_target', 'message', 'mime', 'mint_via', 'mode', 'model', 'name', 'new_file_mode',
  'new_risks_discovered', 'no_edge_reason', 'notes', 'old_file_mode', 
  'old_file_path', 'old_status', 'op', 'operation', 'origin', 'outcome', 'outcome_notes', 
  'outcome_status', 'outcome_type', 'page', 'pair_key', 'password', 'password_hash', 
  'pattern_description', 'pattern_name', 'pattern_subtype', 'pattern_type', 'policy', 
  'prevention_strategy', 'priority', 'privateKey', 'problem_statement', 'process_improvements', 
  'processing_error', 'processing_status', 'project_path', 'provenance_class', 
  'provider', 'providerId', 'publicKey', 'question', 'rationale', 'reason', 'recommendation',
  'recommendations_for_similar_decisions', 'record_type', 'referenceId', 'refreshId', 
  'refreshToken', 'related_commit_sha', 'repository_url', 'retrospective_type', 
  'risk_mitigation_effectiveness', 'role', 'root_directory', 'scope', 'sessionId', 
  'session_goal', 'session_id', 'session_key', 'session_type', 'severity', 'short_sha', 
  'signature', 'softwareId', 'softwareStatement', 'softwareVersion', 'source', 
  'spine_type', 'stage', 'state', 'status', 'subject', 'subjectType',
  'success_criteria', 'superseded_reason', 'sync_mode', 
  'table_name', 'theme', 'thread', 'tier', 'tip_type', 'title', 'to_type', 'token', 
  'tokenEndpointAuthMethod', 'token_id', 'tools_or_resources_needed', 'tos', 'tree_sha', 
  'trigger_type', 'type', 'unforeseen_risks', 'upstream_branch', 'uri', 'validation_hash', 
  'validation_notes', 'value', 'verdict', 'version', 'what_we_learned', 
  'what_we_would_do_differently', 'what_went_poorly', 'what_went_well', 'working_commit_sha', 
  'working_directory', ];


describeDb('owner-scoped reads are confined to the caller\'s own rows', () => {
  /**
   * THE APP'S OWN POOL, not a second one — the same reason unscopedListProjectScope gives:
   * a private pool on top of the shared one doubles this process's client slots against a
   * throwaway role carrying a CONNECTION LIMIT, and `db` is what the routes under test
   * read, so fixtures are guaranteed visible to them.
   */
  const pool = db;
  const tokens: Record<Persona, string> = {} as never;

  const purge = async (): Promise<void> => {
    await pool.query('DELETE FROM feedback WHERE user_id = ANY($1::uuid[])', [ALL_USERS]);
    await pool.query('DELETE FROM feedback WHERE username = ANY($1::text[])', [[NAME_A, NAME_B, NAME_C]]);
    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [ALL_USERS]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [ALL_USERS]);
    for (const t of ['tasks', 'contexts', 'technical_decisions', 'sessions']) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [ALL_PROJECTS]);
    }
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ALL_PROJECTS]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [ALL_USERS]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await purge();

    await pool.query('INSERT INTO projects (id, name, description) VALUES ($1,$2,$3),($4,$5,$6)', [
      P_SHARED, `os-shared-${MARK_SHARED}`, `desc ${MARK_SHARED}`,
      P_C_ONLY, `os-carol-${MARK_C_GRANT}`, `desc ${MARK_C_GRANT}`,
    ]);

    // Rows in the SHARED project, visible to BOTH A and B by design. Their marker is the
    // NON-EMPTY TRAP: if A's sweep stopped returning data at all, every "A sees nothing
    // foreign" assertion below would pass for the wrong reason.
    await pool.query(
      `INSERT INTO tasks (project_id, title, type, status, priority)
       VALUES ($1,$2,'general','todo','medium')`,
      [P_SHARED, `shared task ${MARK_SHARED}`]
    );
    await pool.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'code',$2)`,
      [P_SHARED, `shared ctx ${MARK_SHARED}`]
    );

    // B's `theme` and `default_project_id` differ from A's defaults ON PURPOSE. They are
    // owner-keyed columns on `admin_users` and they are what makes
    // GET /api/users/preferences DIVERGE between two otherwise-identical users. Without a
    // divergent value that endpoint returns byte-identical bodies to A and B, and an
    // owner-scoping guard would classify a genuinely owner-scoped route as insensitive —
    // passing for the wrong reason. MEASURED: with both users on the defaults, the
    // sensitivity ratchet below reported /api/users/preferences ABSENT from the derived
    // set. The divergent input must be IN the population, not merely adjacent to it.
    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, theme, default_project_id) VALUES
        ($1,$4,$7,$10,'user',true,'light',NULL),
        ($2,$5,$8,$10,'user',true,'dark',$11),
        ($3,$6,$9,$10,'user',true,'light',NULL)`,
      [
        U_A, U_B, U_C,
        NAME_A, NAME_B, NAME_C,
        'osa@x.test', `${MARK_B_ACCOUNT}@x.test`, 'osc@x.test',
        '$2b$04$notarealhashnotarealhashno',
        P_SHARED,
      ]
    );

    // THE PURE PAIR: A and B hold IDENTICAL grants. C's grant is the one A must not see.
    await pool.query(
      `INSERT INTO user_project_access (user_id, project_id, granted_by) VALUES
        ($1,$3,$1),($2,$3,$2),($4,$5,$4)`,
      [U_A, U_B, P_SHARED, U_C, P_C_ONLY]
    );

    // ASYMMETRIC on purpose: A owns one feedback row, B owns two. Equal populations make
    // any accidental count-shaped check blind to the difference.
    await pool.query(
      `INSERT INTO feedback (user_id, username, type, severity, message, page) VALUES
        ($1,$3,'bug','high',$5,'/dashboard'),
        ($2,$4,'bug','high',$6,'/dashboard'),
        ($2,$4,'idea','low',$7,'/tasks')`,
      [
        U_A, U_B, NAME_A, NAME_B,
        `alice own ${MARK_A_OWN}`, `bob secret one ${MARK_B_FEEDBACK}`, `bob secret two ${MARK_B_FEEDBACK}`,
      ]
    );

    for (const [persona, id, username] of [
      ['a', U_A, NAME_A],
      ['b', U_B, NAME_B],
      ['c', U_C, NAME_C],
    ] as const) {
      const { tokenId } = await AuthService.createSession(id);
      tokens[persona] = AuthService.generateJWT(
        { id, username, email: `${username}@x.test`, role: 'user' } as never,
        tokenId
      );
    }
  }, 120000);

  afterAll(async () => {
    await purge();
    // CLOSE BOTH POOLS. jest gives each test FILE its own module registry, so `db` is
    // per-file; leaving the handle open makes jest never exit, which hung the clean gate
    // for 3h42m once already. `GET /api/healthz` is the only reachable constructor of the
    // lazy `backendPool` singleton, and this sweep hits it.
    await pool.end();
    await backendPool.close();
  });

  const hit = async (path: string, persona: Persona, qs = '') => {
    const res = await request(app)
      .get(path + qs)
      .set('Authorization', `Bearer ${tokens[persona]}`);
    const body = typeof res.text === 'string' && res.text ? res.text : JSON.stringify(res.body);
    return { status: res.status, body };
  };

  /** Case-insensitive on purpose: a display transform must not be able to hide a leak. */
  const contains = (body: string, marker: string): boolean =>
    body.toLowerCase().includes(marker.toLowerCase());

  const normalize = (body: string): string =>
    body
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>')
      .replace(/"(\w*[Dd]uration\w*)":\s*"?-?[\d.]+"?/g, '"$1":<elapsed>');

  const hitAll = async (persona: Persona): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const p of SWEEPABLE) out[p] = normalize((await hit(p, persona)).body);
    for (const { path, qs } of PARAMETERISED_QUERY) {
      out[path + qs] = normalize((await hit(path, persona, qs)).body);
    }
    return out;
  };

  const changedBetween = (a: Record<string, string>, b: Record<string, string>): string[] =>
    Object.keys(a).filter((k) => a[k] !== b[k]);

  // ── the populations are asserted, never assumed ────────────────────────────────────
  describe('the population', () => {
    it('the derived GET route set is non-empty and contains the known owner-scoped surfaces', () => {
      // NON-EMPTY TRAP: every sweep below is a for-each over this set.
      expect(SWEEPABLE.length).toBeGreaterThan(40);

      // A hand snapshot asserted AGAINST the derived set, never used in place of it. If
      // one of these disappears from the walk, the WALK is broken, not the list.
      for (const p of ['/api/feedback', '/api/users/preferences', '/api/auth/profile']) {
        expect(SWEEPABLE).toContain(p);
      }
      for (const { path } of PARAMETERISED_QUERY) expect(SWEEPABLE).toContain(path);
    });

    it('RATCHET: the owner-keyed columns in the LIVE schema equal the frozen intent inventory, both directions', async () => {
      const identities = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = ANY($1::text[])`,
        [[...IDENTITY_TABLES]]
      );
      // A renamed identity table must fail HERE, not silently empty the derivation below.
      expect(identities.rows.map((r) => r.table_name).sort()).toEqual([...IDENTITY_TABLES].sort());

      const { rows } = await pool.query(
        `SELECT tc.table_name AS t, kcu.column_name AS c
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND ccu.table_name = ANY($1::text[])`,
        [[...IDENTITY_TABLES]]
      );
      const derived = [
        ...IDENTITY_TABLES.map((t) => `${t}.id`),
        ...rows.map((r: any) => `${r.t}.${r.c}`),
      ];
      const unique = [...new Set(derived)].sort();

      // NON-EMPTY TRAP on the derivation itself.
      expect(unique.length).toBeGreaterThan(5);
      // BOTH DIRECTIONS, over FK-KEYED columns only: a new FK-keyed owner column fails
      // until its intent is declared, and a declaration cannot be silenced by deleting the
      // column it describes. Bare-string identity columns are the next ratchet's half.
      expect(unique).toEqual(Object.keys(OWNER_KEYED_INTENT).sort());
      // Every declaration carries a reason a human can act on.
      for (const [k, v] of Object.entries(OWNER_KEYED_INTENT)) {
        expect({ k, why: v.why.length > 20 }).toEqual({ k, why: true });
      }
      // And the PRIVATE members are the ones this suite actually plants into.
      expect(
        Object.entries(OWNER_KEYED_INTENT)
          .filter(([, v]) => v.intent === 'PRIVATE_PLANTED')
          .map(([k]) => k)
          .sort()
      ).toEqual([
        'admin_users.id',
        'feedback.user_id',
        'user_project_access.granted_by',
        'user_project_access.user_id',
      ]);
    });

    /**
     * ══ THE STRING-IDENTITY RATCHET ═════════════════════════════════
     * The FK ratchet above and this one partition the same schema between them. This one
     * starts from the DUMB ENUMERATION so that the pattern cannot fail open: every text
     * column lands in exactly one of two frozen halves, or the suite goes RED.
     */
    it('RATCHET: every text column is either a declared string-identity column or a declared non-identity name, both directions', async () => {
      const { rows: cols } = await pool.query<{ t: string; c: string }>(
        `SELECT c.table_name AS t, c.column_name AS c
           FROM information_schema.columns c
           JOIN information_schema.tables tb
             ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
            AND tb.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public'
            AND c.data_type IN ('text', 'character varying', 'character')`
      );
      // NON-EMPTY TRAP on the dumb enumeration itself: an empty schema read would make
      // both halves below pass vacuously.
      expect(cols.length).toBeGreaterThan(200);

      // Columns the FK derivation already declares are excluded from BOTH halves, so no
      // column carries two intents that can drift apart.
      const fkCovered = new Set(Object.keys(OWNER_KEYED_INTENT));
      const candidates = cols
        .map((r) => ({ key: `${r.t}.${r.c}`, name: r.c }))
        .filter((x: { key: string }) => !fkCovered.has(x.key));

      const matched = candidates
        .filter((x: { name: string }) => isIdentityName(x.name))
        .map((x: { key: string }) => x.key);
      const unmatchedNames = [
        ...new Set(
          candidates
            .filter((x: { name: string }) => !isIdentityName(x.name))
            .map((x: { name: string }) => x.name)
        ),
      ];

      // NON-EMPTY TRAPS on each half.
      expect(matched.length).toBeGreaterThan(20);
      expect(unmatchedNames.length).toBeGreaterThan(100);

      // HALF 1, both directions: a new bare-string actor/created_by column fails until
      // someone declares its intent, and a declaration cannot be silenced by dropping the
      // column it describes.
      expect([...new Set(matched)].sort()).toEqual(Object.keys(STRING_OWNER_INTENT).sort());
      // HALF 2, both directions: THE FAIL-OPEN CLOSURE. A column the pattern does not
      // recognise is a FINDING here, not a silent pass.
      expect(unmatchedNames.sort()).toEqual([...NON_IDENTITY_COLUMN_NAMES].sort());

      // Every declaration carries a reason a human can act on.
      for (const [k, v] of Object.entries(STRING_OWNER_INTENT)) {
        expect({ k, why: v.why.length > 20 }).toEqual({ k, why: true });
      }
    });

    it('BACKING: every PROJECT_SCOPED string column really sits on a project-keyed table', async () => {
      const tables = [
        ...new Set(
          Object.entries(STRING_OWNER_INTENT)
            .filter(([, v]) => v.intent === 'PROJECT_SCOPED')
            .map(([k]) => k.split('.')[0])
        ),
      ];
      expect(tables.length).toBeGreaterThan(0);
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'project_id' AND table_name = ANY($1::text[])`,
        [tables]
      );
      // A table with no project_id cannot defer to the project guard — that deferral would
      // be a claim nothing enforces. Named, not counted.
      const withoutProjectId = tables.filter((t) => !rows.some((r) => r.table_name === t));
      expect(withoutProjectId).toEqual([]);
    });

    it('BACKING: every UNRENDERED string column sits on a table the shipped backend source never names', () => {
      // The claim "no route returns these rows" is measured against the source this app
      // actually serves — src/ minus its own tests. The day a route is written against one
      // of these tables, this goes RED and the intent must be re-stated on purpose.
      const SRC = path.resolve(__dirname, '..');
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.ts')) files.push(full);
        }
      };
      walk(SRC);
      // NON-EMPTY TRAP: an empty file list would make every claim below pass vacuously,
      // which is exactly how a scanner fails open.
      expect(files.length).toBeGreaterThan(50);

      const tables = [
        ...new Set(
          Object.entries(STRING_OWNER_INTENT)
            .filter(([, v]) => v.intent === 'UNRENDERED')
            .map(([k]) => k.split('.')[0])
        ),
      ];
      expect(tables.length).toBeGreaterThan(0);

      const sources = files.map((f) => fs.readFileSync(f, 'utf8'));
      const referenced: string[] = [];
      for (const t of tables) {
        const re = new RegExp(`\\b${t}\\b`);
        if (sources.some((s) => re.test(s))) referenced.push(t);
      }
      expect(referenced).toEqual([]);
    });

    it('BACKING: every PRIVATE_PLANTED string column really holds a marker THE SWEEP looks for', async () => {
      // Without this, a column could be declared PRIVATE_PLANTED and be entirely outside
      // the marker sweep — a declaration that buys silence instead of coverage.
      const planted = Object.entries(STRING_OWNER_INTENT)
        .filter(([, v]) => v.intent === 'PRIVATE_PLANTED')
        .map(([k]) => k);
      expect(planted.length).toBeGreaterThan(0);

      const sweptMarkers = FOREIGN_MARKERS.map((m) => m.marker);
      const unwitnessed: string[] = [];
      for (const key of planted) {
        const [table, column] = key.split('.');
        // An identity table IS the user, so B's row is keyed by `id`; every other table
        // points at B by `user_id`. Derived from IDENTITY_TABLES rather than special-cased
        // by name, so a third identity table does not need this line edited.
        const keyColumn = (IDENTITY_TABLES as readonly string[]).includes(table) ? 'id' : 'user_id';
        const { rows } = await pool.query<{ v: string | null }>(
          `SELECT ${column} AS v FROM ${table} WHERE ${keyColumn} = $1`,
          [U_B]
        );
        const seen = rows.some(
          (r) => typeof r.v === 'string' && sweptMarkers.some((m) => contains(r.v as string, m))
        );
        if (!seen) unwitnessed.push(key);
      }
      expect(unwitnessed).toEqual([]);
    });

    it('BACKING: every FOREIGN_SURFACE string column sits on a table the FK inventory already declares foreign', () => {
      // Derived from OWNER_KEYED_INTENT rather than restated, so the two inventories
      // cannot disagree about which tables belong to mcp-server.
      const foreignTables = new Set(
        Object.entries(OWNER_KEYED_INTENT)
          .filter(([, v]) => v.intent === 'FOREIGN_SURFACE')
          .map(([k]) => k.split('.')[0])
      );
      expect(foreignTables.size).toBeGreaterThan(0);
      const claimed = Object.entries(STRING_OWNER_INTENT)
        .filter(([, v]) => v.intent === 'FOREIGN_SURFACE')
        .map(([k]) => k.split('.')[0]);
      expect(claimed.filter((t) => !foreignTables.has(t))).toEqual([]);
    });

    it('the string-identity pattern matches the idioms it claims to, on inputs it has never seen', () => {
      // A pattern asserted only against the schema it was written from is asserted against
      // its own answer key. These are synthetic names, none of which exist in the schema.
      for (const name of [
        'actor', 'claim_actor', 'created_by', 'updated_by', 'submitted_by', 'reviewed_by',
        'assigned_to', 'username', 'owner_handle', 'author_email', 'userId', 'accountId',
      ]) {
        expect({ name, matched: isIdentityName(name) }).toEqual({ name, matched: true });
      }
      // ...and does NOT match ordinary content columns, or it would drown the inventory.
      for (const name of ['title', 'content', 'status', 'description', 'commit_sha', 'file_path']) {
        expect({ name, matched: isIdentityName(name) }).toEqual({ name, matched: false });
      }
    });

    it('the fixtures really landed — a broken fixture must FAIL LOUD, never read as clean', async () => {
      const fb = await pool.query(
        'SELECT user_id, message FROM feedback WHERE user_id = ANY($1::uuid[]) ORDER BY message',
        [[U_A, U_B]]
      );
      expect(fb.rows.map((r) => r.user_id)).toEqual([U_A, U_B, U_B]);
      expect(fb.rows.filter((r) => contains(r.message, MARK_B_FEEDBACK))).toHaveLength(2);

      const acct = await pool.query(
        'SELECT username, email, theme, default_project_id FROM admin_users WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[U_A, U_B]]
      );
      expect(contains(acct.rows[1].username, MARK_B_ACCOUNT)).toBe(true);
      expect(contains(acct.rows[1].email, MARK_B_ACCOUNT)).toBe(true);
      // THE DIVERGENT INPUT for GET /api/users/preferences, asserted present rather than
      // assumed: A and B must hold DIFFERENT owner-keyed preference values, or that route
      // is insensitive to owner by fixture rather than by code.
      expect([acct.rows[0].theme, acct.rows[1].theme]).toEqual(['light', 'dark']);
      expect([acct.rows[0].default_project_id, acct.rows[1].default_project_id]).toEqual([null, P_SHARED]);

      const grant = await pool.query(
        `SELECT p.name FROM user_project_access a JOIN projects p ON p.id = a.project_id
          WHERE a.user_id = $1`,
        [U_C]
      );
      expect(grant.rows.map((r) => r.name)).toEqual([`os-carol-${MARK_C_GRANT}`]);

      // THE PURE PAIR, asserted rather than assumed: A and B differ ONLY in owned rows.
      const pair = await pool.query(
        `SELECT u.id, u.role, array_agg(a.project_id::text ORDER BY a.project_id) AS grants
           FROM admin_users u LEFT JOIN user_project_access a ON a.user_id = u.id
          WHERE u.id = ANY($1::uuid[]) GROUP BY u.id, u.role ORDER BY u.id`,
        [[U_A, U_B]]
      );
      expect(pair.rows.map((r) => r.role)).toEqual(['user', 'user']);
      expect(pair.rows[0].grants).toEqual(pair.rows[1].grants);
      expect(pair.rows[0].grants).toEqual([P_SHARED]);
    });
  });

  // ── the detector must be shown to WORK before any negative is trusted ──────────────
  it('LANDED: each foreign marker IS visible to the persona entitled to it', async () => {
    const bFeedback = await hit('/api/feedback', 'b');
    expect(bFeedback.status).toBe(200);
    expect(contains(bFeedback.body, MARK_B_FEEDBACK)).toBe(true);

    const bProfile = await hit('/api/auth/profile', 'b');
    expect(bProfile.status).toBe(200);
    expect(contains(bProfile.body, MARK_B_ACCOUNT)).toBe(true);

    const cProjects = await hit('/api/projects', 'c');
    expect(cProjects.status).toBe(200);
    expect(contains(cProjects.body, MARK_C_GRANT)).toBe(true);
    // If any of these were false, every "A sees nothing" assertion below would be
    // unfalsifiable — the marker would be undetectable ANYWHERE.
  }, 60000);

  it('the sweep is reading real data: A DOES see the rows it is entitled to', async () => {
    const own = await hit('/api/feedback', 'a');
    expect(own.status).toBe(200);
    expect(contains(own.body, MARK_A_OWN)).toBe(true);

    // ...and the shared project's rows, so "A sees nothing foreign" is not "A sees
    // nothing". A deny-everyone fix would fail here.
    const tasks = await hit('/api/tasks', 'a', `?project_id=${P_SHARED}`);
    expect(tasks.status).toBe(200);
    expect(contains(tasks.body, MARK_SHARED)).toBe(true);
  }, 60000);

  // ══ THE SWEEP ═════════════════════════════════════════════════════════════════════
  it('THE SWEEP: no GET route returns another user\'s owner-keyed row to A', async () => {
    const leaks: string[] = [];
    const check = (path: string, status: number, body: string) => {
      for (const { marker, owner } of FOREIGN_MARKERS) {
        if (contains(body, marker)) leaks.push(`${path} [${status}] leaked ${owner}`);
      }
    };
    for (const p of SWEEPABLE) {
      const res = await hit(p, 'a');
      check(p, res.status, res.body);
    }
    for (const { path, qs } of PARAMETERISED_QUERY) {
      const res = await hit(path, 'a', qs);
      check(path + qs, res.status, res.body);
    }
    // Named, not counted: the failure message says WHICH route leaked WHOSE row.
    expect(leaks).toEqual([]);
  }, 180000);

  it('THE SWEEP, MIRROR DIRECTION: no GET route returns A\'s owner-keyed row to B', async () => {
    // One-directional guards pass on a fix that simply denies the second user everything.
    const leaks: string[] = [];
    for (const p of SWEEPABLE) {
      const res = await hit(p, 'b');
      if (contains(res.body, MARK_A_OWN)) leaks.push(`${p} [${res.status}] leaked A's feedback row`);
    }
    expect(leaks).toEqual([]);
  }, 180000);

  it('THE SWEEP, ZERO POPULATION: a user who owns NOTHING does not fall through to everything', async () => {
    // The value that slips through (C3): an owner predicate that degrades to "no filter"
    // when the caller has no rows. C owns no feedback at all and holds no grant on the
    // shared project, so a route that answers "nothing of yours" with "everything" shows
    // up here and nowhere else.
    const leaks: string[] = [];
    for (const p of SWEEPABLE) {
      const res = await hit(p, 'c');
      for (const { marker, owner } of [
        ...FOREIGN_MARKERS.filter((m) => m.marker !== MARK_C_GRANT),
        { marker: MARK_A_OWN, owner: "A's feedback row (feedback.user_id)" },
      ]) {
        if (contains(res.body, marker)) leaks.push(`${p} [${res.status}] leaked ${owner}`);
      }
    }
    expect(leaks).toEqual([]);

    // ...and the empty answer is really EMPTY, not an error masquerading as safety.
    const own = await hit('/api/feedback', 'c');
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body).data.feedback).toEqual([]);
  }, 180000);

  it('the NORMALIZER cannot blind the detector: every marker and identifying value survives it', () => {
    // `normalize()` exists to remove wall-clock jitter from the DIFF axis. If it ever ate
    // a marker or an identifying field, the non-interference property and the sensitivity
    // ratchet would both go quietly insensitive while staying green.
    const sample = JSON.stringify({
      feedback: [
        {
          id: '11111111-2222-4333-8444-555555555555',
          username: NAME_B,
          message: `bob secret one ${MARK_B_FEEDBACK}`,
          duration_minutes: '180.0003815333333333',
          created_at: '2026-08-26T21:13:22.367Z',
        },
      ],
      total: 1,
    });
    const out = normalize(sample);
    expect(out).not.toContain('180.0003815333333333');
    expect(out).toContain('<elapsed>');
    expect(out).toContain('<ts>');
    for (const kept of [
      MARK_B_FEEDBACK,
      MARK_B_ACCOUNT,
      '11111111-2222-4333-8444-555555555555',
      '"total":1',
    ]) {
      expect({ kept, present: contains(out, kept) }).toEqual({ kept, present: true });
    }
  });

  it('a query parameter cannot widen the scope past the caller', async () => {
    // The parameters most likely to be plumbed into a WHERE clause.
    for (const qs of ['?limit=500', '?limit=500&offset=0', `?username=${NAME_B}`, `?user_id=${U_B}`]) {
      const res = await hit('/api/feedback', 'a', qs);
      expect({ qs, leaked: contains(res.body, MARK_B_FEEDBACK) }).toEqual({ qs, leaked: false });
    }
  }, 60000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════
   * THE NON-INTERFERENCE PROPERTY — perturb B's private rows, assert A's whole view does
   * not move. This is the axis that reaches COUNT-ONLY and AGGREGATE endpoints, where no
   * marker can appear because the endpoint never emits free text.
   *
   * The anchor is a row THIS TEST WROTE. A second request to the same code is not an
   * anchor and a population derived from the code's own responses is not an anchor — that
   * is the self-erasure defect documented at length in unscopedListProjectScope.
   * ══════════════════════════════════════════════════════════════════════════════════
   */
  describe('non-interference under perturbation of another user\'s private rows', () => {
    const excluded = (p: string) => FROZEN_VOLATILE.includes(p) || selfJitter.has(p);

    let baselineA1: Record<string, string>;
    let baselineA2: Record<string, string>;
    let afterA: Record<string, string>;
    let baselineB: Record<string, string>;
    let afterB: Record<string, string>;
    let cProjectsBefore: string;
    let cProjectsAfter: string;
    let perturbedTables: PrivateTable[];
    let selfJitter: Set<string>;

    beforeAll(async () => {
      baselineA1 = await hitAll('a');
      baselineB = await hitAll('b');
      baselineA2 = await hitAll('a');

      // VOLATILE = differs from ITSELF with no perturbation in between. Measured, never a
      // name pattern.
      selfJitter = new Set(changedBetween(baselineA1, baselineA2));

      cProjectsBefore = (await hit('/api/projects', 'c')).body;

      // ── THE PERTURBATION: one write per PRIVATE_PLANTED table, never just the one that
      // happens to carry free text. A marker can only live in a column wide enough to hold
      // it, so `admin_users.theme` (a CHECK-constrained enum) and
      // `admin_users.default_project_id` (a uuid) are UNMARKABLE and the marker sweep is
      // structurally blind to them. MEASURED by Reviewer on this branch (in review
      // in review): a /api/users/preferences that returned EVERY user's theme and default
      // project passed this suite 16/16 — the leak class this file was written for,
      // missed, because the only perturbed table was `feedback`. This axis needs no marker;
      // its anchor is the write itself, so it is what reaches an unmarkable column.
      //
      // Only OTHER USERS' private rows are touched, and no project row is touched, so
      // nothing written here is legitimately visible to A through any project grant.
      const PERTURB: ReadonlyArray<{ table: PrivateTable; apply: () => Promise<unknown> }> = [
        {
          table: 'feedback',
          apply: () =>
            pool.query(
              `INSERT INTO feedback (user_id, username, type, severity, message, page)
               VALUES ($1,$2,'bug','high',$3,'/dashboard')`,
              [U_B, NAME_B, `bob perturb ${MARK_B_PERTURB}`]
            ),
        },
        {
          table: 'admin_users',
          // The UNMARKABLE columns. B was seeded 'dark'; this moves it.
          apply: () => pool.query('UPDATE admin_users SET theme = $2 WHERE id = $1', [U_B, 'light']),
        },
        {
          table: 'user_project_access',
          // C's private grant set. Also unmarkable: the row is (uuid, uuid, uuid).
          apply: () =>
            pool.query(
              'INSERT INTO user_project_access (user_id, project_id, granted_by) VALUES ($1,$2,$1)',
              [U_C, P_SHARED]
            ),
        },
      ];
      // COVERAGE, EXECUTED: every PRIVATE_PLANTED table is perturbed. A table promoted to
      // PRIVATE_PLANTED with no perturbation fails RESIDUAL (b) below, so an unmarkable
      // column cannot enter the inventory and sit outside the only axis that can see it.
      perturbedTables = PERTURB.map((x) => x.table);
      for (const { apply } of PERTURB) await apply();

      afterA = await hitAll('a');
      afterB = await hitAll('b');
      cProjectsAfter = (await hit('/api/projects', 'c')).body;
    }, 300000);

    it('CONTROL: with NO perturbation, repeated sweeps are byte-stable outside the measured volatile set', () => {
      const unstable = changedBetween(baselineA1, baselineA2).filter((p) => !excluded(p));
      expect(unstable).toEqual([]);
      // NON-EMPTY TRAP on the comparison: if every route were volatile the property below
      // would be vacuous.
      const compared = SWEEPABLE.filter((p) => !excluded(p));
      expect(compared.length).toBeGreaterThan(20);
    });

    it('LANDED: every perturbation IS visible to its owner', () => {
      // Without this, "nothing moved for A" could mean the writes silently failed. One
      // owner-visible witness per perturbed table, including the two unmarkable ones.
      const movedForB = changedBetween(baselineB, afterB).filter((p) => !excluded(p));
      // feedback -> B's own list, and the marker really is in it.
      expect(movedForB).toContain('/api/feedback');
      expect(contains(afterB['/api/feedback'], MARK_B_PERTURB)).toBe(true);
      // admin_users.theme -> B's own preferences, with no marker available at all.
      expect(movedForB).toContain('/api/users/preferences');
      // user_project_access -> C's own project list.
      expect(cProjectsAfter).not.toEqual(cProjectsBefore);
      expect(contains(cProjectsAfter, MARK_SHARED)).toBe(true);
    });

    it('THE PROPERTY: A\'s entire GET surface does not move when B\'s private rows change', () => {
      const moved = changedBetween(baselineA2, afterA).filter((p) => !excluded(p));
      expect(moved).toEqual([]);
    });

    /**
     * RESIDUAL (a), ASSERTED. Routes excluded from the diff for self-jitter are invisible
     * to the property above — including, honestly, a volatile endpoint that leaks only a
     * COUNT, which the marker sweep cannot see either. The exclusion is therefore FROZEN
     * in one direction: a route that STARTS jittering fails here and forces a deliberate
     * decision instead of quietly dropping out of coverage. A route that STOPS jittering
     * simply gains coverage.
     */
    it('RESIDUAL (a): measured jitter stays inside the frozen exclusion, which carries no foreign rows', async () => {
      expect([...selfJitter].filter((p) => !FROZEN_VOLATILE.includes(p))).toEqual([]);

      for (const p of FROZEN_VOLATILE) {
        const res = await hit(p, 'a');
        const leaked = FOREIGN_MARKERS.filter((m) => contains(res.body, m.marker)).map((m) => m.owner);
        expect({ route: p, leaked }).toEqual({ route: p, leaked: [] });
      }
    }, 120000);

    it('RESIDUAL (b): the perturbation covers EVERY PRIVATE_PLANTED table, and each write landed', async () => {
      // The population of this axis is DERIVED from the intent inventory, not remembered.
      expect([...perturbedTables].sort()).toEqual([...PRIVATE_TABLES].sort());

      const fb = await pool.query(
        'SELECT COUNT(*)::int AS n FROM feedback WHERE user_id = $1 AND message LIKE $2',
        [U_B, `%${MARK_B_PERTURB}%`]
      );
      expect({ table: 'feedback', n: fb.rows[0].n }).toEqual({ table: 'feedback', n: 1 });

      const theme = await pool.query('SELECT theme FROM admin_users WHERE id = $1', [U_B]);
      expect({ table: 'admin_users', theme: theme.rows[0].theme }).toEqual({
        table: 'admin_users',
        theme: 'light',
      });

      const grants = await pool.query(
        'SELECT COUNT(*)::int AS n FROM user_project_access WHERE user_id = $1 AND granted_by = $1',
        [U_C]
      );
      expect({ table: 'user_project_access', n: grants.rows[0].n }).toEqual({
        table: 'user_project_access',
        n: 2,
      });
    });
  });

  /**
   * THE OWNER-SENSITIVITY RATCHET — a DRIFT ALARM, not the trust path (it cannot be the
   * trust path, for the self-erasure reason documented in unscopedListProjectScope: a
   * route that goes owner-BLIND makes A's and B's responses EQUAL and would drop itself
   * out of any derived population).
   *
   * Frozen equality in BOTH directions still catches both drifts:
   *   - a NEW owner-sensitive endpoint appears  → derived has a member frozen lacks;
   *   - an existing one goes owner-BLIND        → frozen has a member derived lacks.
   * Either way a human states the intent on purpose.
   *
   * A and B are the pure pair — same role, same grants — so a difference between their
   * responses can only be owner-keyed.
   */
  it('RATCHET: the owner-sensitive endpoint set equals its frozen snapshot, both directions', async () => {
    const derived: string[] = [];
    const candidates = [
      ...SWEEPABLE.filter((p) => !FROZEN_VOLATILE.includes(p)),
      ...PARAMETERISED_QUERY.map(({ path, qs }) => path + qs),
    ];
    for (const p of candidates) {
      // Two samples for A first: an unstable route cannot be classified and is skipped
      // rather than admitted on sampling luck.
      const a1 = await hit(p, 'a');
      const a2 = await hit(p, 'a');
      if (a1.status !== 200 || normalize(a1.body) !== normalize(a2.body)) continue;
      const b = await hit(p, 'b');
      if (b.status === 200 && normalize(a1.body) !== normalize(b.body)) derived.push(p);
    }

    const FROZEN_OWNER_SENSITIVE = [
      // Own-rows-only free text. THE ORIGINAL LEAK.
      '/api/feedback',
      // The caller's own account row.
      '/api/auth/profile',
      // The caller's own theme + default project (admin_users columns, an earlier task §A).
      '/api/users/preferences',
    ];
    expect([...derived].sort()).toEqual([...FROZEN_OWNER_SENSITIVE].sort());
  }, 240000);
});
