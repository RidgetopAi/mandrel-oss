/**
 * SPINE RESOLUTION — the ONE way an id becomes a branch spine (FIX A, an earlier task follow-on).
 *
 * WHY THIS FILE EXISTS. `branch_open` and `branch_history` already resolved a caller-supplied
 * id (full UUID or 8+-hex short id) to a REAL record across all three spine tables,
 * project-scoped, never first-match. `project_briefing` now accepts a spine argument too, and
 * a SECOND resolver would be a second set of rules to keep in step — which is the C5 drift
 * class: two paths doing the same job, one of them quietly weaker. So the logic moved here
 * and branch.routes.ts calls it, unchanged in behaviour.
 *
 * THE CONTRACT, in three parts, all of them load-bearing:
 *   1. PROJECT-SCOPED. `resolveMintEndpoint` is given the project id, so an id belonging to
 *      another project resolves to nothing. This is the layer that actually stops a
 *      cross-project spine from ever reaching a membership read.
 *   2. NEVER FIRST-MATCH (the E3 caveat). Every spine type is probed even
 *      after a hit; a short id that matches records of more than one TYPE is an explicit
 *      ambiguity, not a silent pick.
 *   3. TYPED REFUSAL, NOT A FALSY. Failure comes back as a discriminated `ok:false` with a
 *      REASON, so each caller can render it in its own shape (branch_* return an error
 *      response; project_briefing reports it in a field) without either of them having to
 *      re-derive what went wrong from a message string.
 *
 * `spineResolutionError()` carries the branch_* error responses verbatim so this extraction
 * changed no user-visible text.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import {
  resolveMintEndpoint,
  AmbiguousIdError,
  IdNotFoundError,
  ambiguousIdMessage,
} from '../utils/idResolver.js';
import { SPINE_TYPES, type SpineType } from './branchPosition.js';

/** Why a spine id could not be turned into exactly one record. */
export const SPINE_REFUSAL = {
  /** The id matches no context, decision, or task IN THIS PROJECT. */
  notFound: 'spine-not-found',
  /** The short id matches records of more than one spine TYPE. */
  ambiguousType: 'spine-ambiguous-type',
  /** The short id matches more than one record of the SAME type (idResolver's own verdict). */
  ambiguousId: 'spine-ambiguous-id',
} as const;

export type SpineRefusal = (typeof SPINE_REFUSAL)[keyof typeof SPINE_REFUSAL];

export type SpineResolution =
  | { ok: true; spineId: string; spineType: SpineType }
  | { ok: false; reason: typeof SPINE_REFUSAL.notFound; rawId: string }
  | {
      ok: false;
      reason: typeof SPINE_REFUSAL.ambiguousType;
      rawId: string;
      hits: Array<{ spineId: string; spineType: SpineType }>;
    }
  | { ok: false; reason: typeof SPINE_REFUSAL.ambiguousId; rawId: string; error: AmbiguousIdError };

/**
 * Resolve a spine id (full UUID or id8) against ALL THREE record tables, project-scoped.
 * Returns the resolved spine or a typed refusal — never throws for a bad id, and never
 * silently picks one of several candidates.
 */
export async function resolveSpineRecord(
  rawId: string,
  projectId: string | undefined,
): Promise<SpineResolution> {
  const hits: Array<{ spineId: string; spineType: SpineType }> = [];
  for (const type of SPINE_TYPES) {
    try {
      const id = await resolveMintEndpoint(type, rawId, projectId);
      hits.push({ spineId: id, spineType: type });
    } catch (e) {
      if (e instanceof AmbiguousIdError) {
        return { ok: false, reason: SPINE_REFUSAL.ambiguousId, rawId, error: e };
      }
      if (!(e instanceof IdNotFoundError)) throw e;
      // Not found in THIS table — keep probing the others (never first-match).
    }
  }
  if (hits.length === 0) return { ok: false, reason: SPINE_REFUSAL.notFound, rawId };
  if (hits.length > 1) return { ok: false, reason: SPINE_REFUSAL.ambiguousType, rawId, hits };
  return { ok: true, ...hits[0] };
}

/**
 * Render a refusal as the branch_* error response. Text preserved verbatim from
 * branch.routes.ts's former private resolveSpine so the extraction is behaviour-neutral.
 */
export function spineResolutionError(
  refusal: Extract<SpineResolution, { ok: false }>,
  toolName: string,
): McpResponse {
  if (refusal.reason === SPINE_REFUSAL.ambiguousId) {
    return {
      content: [{ type: 'text', text: ambiguousIdMessage(refusal.error, toolName) }],
      isError: true,
      structuredContent: {
        ok: false,
        ambiguous: true,
        candidates: refusal.error.candidates.map((c) => c.id),
      },
    };
  }
  if (refusal.reason === SPINE_REFUSAL.ambiguousType) {
    return {
      content: [{
        type: 'text',
        text:
          `❌ ${toolName}: '${refusal.rawId}' matches records of MORE THAN ONE type — ` +
          refusal.hits.map((h) => `${h.spineType} ${h.spineId}`).join(', ') +
          `. Refusing to pick one (never first-match).\n\n` +
          `💡 Pass the full UUID of the record you mean.`,
      }],
      isError: true,
      structuredContent: {
        ok: false,
        ambiguous: true,
        candidates: refusal.hits.map((h) => h.spineId),
      },
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `❌ ${toolName}: '${refusal.rawId}' resolves to no context, decision, or task in this ` +
        `project — a branch must have a REAL spine record.\n\n` +
        `💡 Check the id (task_list / decision_search / context_search), or store the ` +
        `spine record first and open the branch on the id the write returns.`,
    }],
    isError: true,
    structuredContent: { ok: false, found: false },
  };
}

/**
 * The table each spine type lives in. TOTAL over SpineType by construction — the annotation,
 * not a reviewer, is what rejects a new type that nobody gave a table. Never interpolated
 * from caller input: the only values that can reach the SQL below are this object's own.
 */
const SPINE_TABLES: Record<SpineType, string> = {
  context: 'contexts',
  decision: 'technical_decisions',
  task: 'tasks',
};

/**
 * WHAT STATE IS THIS EXACT SPINE IN? — the read-time revalidation of the soft reference
 * (`branch_positions.spine_id`; rule + measurement in config/danglingSpineConfig.ts).
 *
 * TWO FACTS, NOT ONE, AND THEY ARE DIFFERENT DEFECTS. an earlier Task reported a position
 * citing an earlier task that `task({action:'details'})` answered `found:false` for, and read
 * that as a dangling pointer. Measured on prod 2026-09-05, it is not:
 *
 *   SELECT id, status, archived_at IS NOT NULL FROM tasks WHERE id::text LIKE '2b3c4d5e%';
 *   -> f50b8f30-... | todo | t   (archived_at 2026-09-02 00:58:52+00)
 *
 * The row EXISTS. `task details` could not see it because `includeArchived:false` is the
 * default on the read ops. So the observed shape had a different cause from the one the
 * report inferred, and a check that only asked "does the row exist" would have returned
 * TRUE for the very id the bug was filed on — a fix that looks right and changes nothing on
 * the case that produced it. `archived` is therefore reported ALONGSIDE `exists`, never
 * folded into it: an archived spine is a legitimate branch to be standing on and must keep
 * minting, while a deleted one must not.
 *
 * DELIBERATELY NOT `resolveSpineRecord`. That one answers a DIFFERENT question — "what
 * record does this caller-supplied id8 mean?" — and to do it, it probes all three tables,
 * scopes by project, and treats a cross-type match as an ambiguity. Here the (id, type)
 * pair is already resolved and STORED, so the only question left is state, and asking the
 * wider question would import two ways to be wrong that do not apply: an ambiguity refusal
 * (impossible for a full UUID) and a project scope (the position row carries its own
 * project_id, and a spine that moved project is not the same fact as one that is gone).
 *
 * ONE PRIMARY-KEY LOOKUP against the single table the stored spine_type names, via a TOTAL
 * MAP keyed by SpineType. `Record<SpineType, string>` is what makes that sentence true: add a
 * fourth spine type and this object stops compiling until it names a table. The first version
 * of this claimed exactly the same thing over a TERNARY CHAIN whose final arm was an unchecked
 * catch-all, so a new type would have silently queried `contexts` and reported confident,
 * bogus liveness for it (N1, reject round 1). That is worse than saying nothing: the sentence
 * is precisely what would stop the next author from checking.
 *
 * FAIL-CLOSED IS WRONG HERE AND THE THROW IS DELIBERATE. A query that could not run is C1's
 * third state, and neither "exists" (mints an edge to a maybe-dead record) nor "gone"
 * (silently stops threading a healthy branch) is an honest answer to it. Callers already sit
 * inside try/catch that surfaces the failure, so it is left to propagate rather than
 * flattened into a boolean that would make an outage look like a verdict.
 */
export async function spineLiveness(
  spineId: string,
  spineType: SpineType,
  pool: Pool = db,
): Promise<{ exists: boolean; archived: boolean }> {
  const r = await pool.query(
    `SELECT archived_at IS NOT NULL AS archived FROM ${SPINE_TABLES[spineType]} WHERE id = $1 LIMIT 1`,
    [spineId],
  );
  if (r.rows.length === 0) return { exists: false, archived: false };
  return { exists: true, archived: Boolean(r.rows[0].archived) };
}

/** Existence alone, for the write path — which cares only whether there is a record to be a member OF. */
export async function spineRecordExists(
  spineId: string,
  spineType: SpineType,
  pool: Pool = db,
): Promise<boolean> {
  return (await spineLiveness(spineId, spineType, pool)).exists;
}
