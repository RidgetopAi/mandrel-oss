/**
 * ARCHIVE DISCLOSURE + TAG CENSUS contract.
 *
 * Drives the REAL public tool path (zod validator → route handler → real migrated
 * Postgres, the disposable ci_* DB — never production), the same idiom as
 * softDeleteArchive.contract.test.ts.
 *
 * === THE GUARD'S OWN POPULATION, AND WHY IT IS THE WHOLE ONE ===
 *
 * G1 does not carry a hand-written list of ops. It DERIVES its population from
 * `validationSchemas` — every op whose zod schema declares an `includeArchived` key — and
 * asserts each one discloses. That is the whole set of ops where a caller has been handed a
 * flag and therefore has an expectation about the population, and it is the set that grows:
 * an op that gains the flag tomorrow joins this guard automatically and fails until it
 * discloses. A list typed here would not have done that.
 *
 * Deriving the population from zod is also the fix for how this guard was nearly written
 * wrong. A first pass at the enumeration read the schema shape one level deep and reported
 * SEVEN ops; `context_search`'s schema is wrapped in a ZodEffects, so its shape came back
 * undefined and the op fell through the `else` branch as "does not declare the flag". The
 * honest number is EIGHT. A could-not-resolve that lands in the "no" bucket is the C1 third
 * state, and here it would have silently excused the single most-used read op in the
 * product from its own guard. So `shapeOf()` unwraps, and G0 asserts the unresolved count
 * is ZERO rather than trusting that it is.
 *
 * === THE FLAGLESS REMAINDER ===
 *
 * Five count-bearing ops originally narrowed by `archived_at IS NULL` with no flag. Two of
 * them count a per-PROJECT context population and now take includeArchived + disclose
 * (project_info: G11; project_list: G12, fleet-wide scope, only when includeStats emits a
 * count). The other three count per-SESSION populations and are declared UN-NARROWABLE with
 * their reason in ARCHIVE_UNNARROWABLE_OPS; G6 asserts the flagless remainder of
 * `reportsCount` is exactly that set, and G6b asserts each one's contract says so.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { db } from '../config/database.js';
import { validationSchemas, validateToolArguments } from '../middleware/validation.js';
import { OP_REGISTRY } from '../config/opRegistry.js';
import { routeExecutor } from '../routes/index.js';
import {
  ARCHIVE_DISCLOSURE_STATES,
  ARCHIVE_DISCLOSURE_KEY,
  ARCHIVE_DISCLOSURE_OPS,
  ARCHIVE_UNNARROWABLE_OPS,
  ARCHIVE_UNNARROWABLE_CONTRACT_PHRASE,
} from '../config/archiveDisclosureConfig.js';
import { renderArchiveDisclosure } from '../services/archiveDisclosure.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const PROJ_NAME = `archive-disclosure-${STAMP}`;
const EMPTY_PROJ_NAME = `archive-disclosure-empty-${STAMP}`;

let projectId: string;
let emptyProjectId: string;
// ONE CONNECTION, BOUND TO THE FIXTURE PROJECT. project_list takes no project
// argument by design, so route entry would otherwise resolve `projects[0] ORDER BY updated_at
// DESC` — a coin flip on row ordering, which NODE_ENV=test refuses loudly. Every op here that
// DOES take a project still names it explicitly; the binding only settles the ones that cannot.
const CONN = `archive-disclosure-conn-${STAMP}`;

/** Unwrap ZodEffects/optional/default wrappers to reach the object shape. See the header. */
function shapeOf(s: any): Record<string, any> | null {
  let cur = s;
  let hops = 0;
  while (cur && hops++ < 10) {
    const sh = cur?._def?.shape?.() ?? (typeof cur?.shape === 'object' ? cur.shape : null);
    if (sh) return sh;
    cur = cur._def?.schema ?? cur._def?.innerType ?? null;
  }
  return null;
}

function opsDeclaringIncludeArchived(): { ops: string[]; unresolved: string[] } {
  const ops: string[] = [];
  const unresolved: string[] = [];
  for (const [op, schema] of Object.entries(validationSchemas as Record<string, any>)) {
    const sh = shapeOf(schema);
    if (!sh) {
      unresolved.push(op);
      continue;
    }
    if ('includeArchived' in sh) ops.push(op);
  }
  return { ops, unresolved };
}

/**
 * Drive the op through the REAL consumer seam — `routeExecutor` — not the route method.
 *
 * This matters and was found the hard way. The route classes use TWO response conventions:
 * most set `structuredContent`, the decision routes still set the legacy `data`, and
 * `ensureStructuredContent` inside routeExecutor is what promotes one to the other. A test
 * that called `decisionsRoutes.handleStats()` directly would be reading a channel no client
 * ever sees, and would report a shape the wire does not carry.
 */
async function callOp(op: string, rawArgs: any): Promise<any> {
  return routeExecutor(op, validateToolArguments(op, rawArgs), { connectionId: CONN });
}

/**
 * The minimum arguments that make each flag-bearing op EMIT a count on the fixture project.
 * This is a DRIVER, not the population (G1 derives that): an op that needs nothing beyond
 * `projectId` gets exactly that.
 */
function argsFor(op: string): any {
  switch (op) {
    case 'context_search':
      return { projectId, query: 'disclosure' };
    // project_info names its subject `project` (id or name); it declares no projectId.
    case 'project_info':
      return { project: projectId };
    // project_list carries a count only with includeStats — without it there is nothing to
    // disclose, and the seam's appliesWhen says so (asserted in G12).
    case 'project_list':
      return { includeStats: true };
    default:
      return { projectId };
  }
}

/** The disclosure block, normalised: multi-entity ops carry an array. */
function disclosuresOf(resp: any): any[] {
  const d = resp?.structuredContent?.[ARCHIVE_DISCLOSURE_KEY];
  if (d === undefined) return [];
  return Array.isArray(d) ? d : [d];
}

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

describe('archive disclosure + tag census', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'disclosure fixture') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    emptyProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'zero-archived fixture') RETURNING id`,
        [EMPTY_PROJ_NAME]
      )
    ).rows[0].id;

    await bindConnectionToProject(CONN, projectId);

    // MAIN project: LIVE rows + ARCHIVED rows of every entity, in known, unequal counts so
    // that a disclosure reporting the wrong table cannot accidentally report the right
    // number. 2 live / 3 archived contexts, 1 live / 4 archived decisions, 2 live /
    // 1 archived tasks.
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content, tags, archived_at)
         VALUES ($1, 'planning', $2, ARRAY['census-alpha','invalid-class:demo'], $3)`,
        [projectId, `disclosure ctx ${i}`, i < 2 ? null : new Date()]
      );
    }
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level, tags, archived_at)
         VALUES ($1, 'database', $2, 'd', 'r', 'medium', ARRAY['census-alpha'], $3)`,
        [projectId, `disclosure dec ${i}`, i < 1 ? null : new Date()]
      );
    }
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status, tags, archived_at)
         VALUES ($1, $2, 'general', 'medium', 'todo', ARRAY['census-beta'], $3)`,
        [projectId, `disclosure task ${i}`, i < 2 ? null : new Date()]
      );
    }

    // EMPTY project: live rows only, ZERO archived. This is the shape that makes the bug
    // invisible, and it is a first-class case here, not an afterthought.
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, tags)
       VALUES ($1, 'planning', 'nothing archived here', ARRAY['census-alpha'])`,
      [emptyProjectId]
    );
  });

  afterAll(async () => {
    for (const p of [projectId, emptyProjectId]) {
      if (!p) continue;
      for (const t of ['tasks', 'technical_decisions', 'contexts', 'sessions']) {
        try {
          await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [p]);
        } catch {
          /* ignore */
        }
      }
      try {
        await db.query('DELETE FROM projects WHERE id = $1', [p]);
      } catch {
        /* ignore */
      }
    }
    await db.end();
  });

  // ── G0: the enumeration itself resolved. A could-not-read must not become a "no". ──
  test('G0: every validationSchema shape RESOLVES — no op silently excused from G1', () => {
    const { ops, unresolved } = opsDeclaringIncludeArchived();
    expect(
      unresolved,
      'An op whose zod shape could not be read would fall through as "does not declare ' +
        'includeArchived" and be silently dropped from G1\'s population. That is how the ' +
        'first pass at this enumeration lost context_search.'
    ).toEqual([]);
    // context_search is the op the naive enumeration dropped; pin it by name so a
    // regression in shapeOf() is reported as itself rather than as a smaller number.
    expect(ops).toContain('context_search');
    expect(ops.length).toBeGreaterThanOrEqual(8);
  });

  // ── G1: THE COVERAGE ASSERTION. Derived population, executed, not enumerated in prose. ──
  test('G1: EVERY op declaring includeArchived discloses what it excluded', async () => {
    const { ops } = opsDeclaringIncludeArchived();
    const missing: string[] = [];

    for (const op of ops) {
      const resp = await callOp(op, argsFor(op));
      const ds = disclosuresOf(resp);
      if (ds.length === 0) {
        missing.push(`${op}: no ${ARCHIVE_DISCLOSURE_KEY} block`);
        continue;
      }
      for (const d of ds) {
        if (!ARCHIVE_DISCLOSURE_STATES.includes(d.state)) {
          missing.push(`${op}: state "${d.state}" not in the declared vocabulary`);
        }
        if (typeof d.excludedCount !== 'number') {
          missing.push(`${op}: excludedCount is not a number`);
        }
        // The number never travels without its units.
        if (!d.scopeNote || typeof d.scopeNote !== 'string') {
          missing.push(`${op}: excludedCount shipped with no scopeNote`);
        }
      }
      // BOTH CHANNELS. A JSON-only client and a text-only client must each be able to see
      // the narrowing; disclosing to one of them is disclosing to half the callers.
      if (!textOf(resp).includes('Archived')) {
        missing.push(`${op}: disclosure absent from the TEXT channel`);
      }
    }

    expect(
      missing,
      'These ops hand the caller an includeArchived flag but do not report what the ' +
        'default withheld. Add them to ARCHIVE_DISCLOSURE_OPS.'
    ).toEqual([]);

    // The declared table must COVER the derived population. This is the assertion that
    // makes ARCHIVE_DISCLOSURE_OPS safe to maintain by hand: forgetting an entry is not a
    // silent hole, it is a RED test naming the op.
    const undeclared = ops.filter((op) => !(op in ARCHIVE_DISCLOSURE_OPS));
    expect(undeclared, 'op declares includeArchived but has no ARCHIVE_DISCLOSURE_OPS entry')
      .toEqual([]);
  });

  // ── G2: the EXCLUDED state carries the real number, per entity. ──
  test('G2: a narrowed read reports the true archived count for its OWN entity', async () => {
    const dec = disclosuresOf(await callOp('decision_stats', { projectId }))[0];
    expect(dec.state).toBe('excluded');
    expect(dec.entity).toBe('decision');
    expect(dec.excludedCount).toBe(4); // 4 of 5 decisions archived in the fixture

    const ctx = disclosuresOf(await callOp('context_stats', { projectId }))[0];
    expect(ctx.state).toBe('excluded');
    expect(ctx.entity).toBe('context');
    expect(ctx.excludedCount).toBe(3);

    const tsk = disclosuresOf(await callOp('task_progress_summary', { projectId }))[0];
    expect(tsk.state).toBe('excluded');
    expect(tsk.entity).toBe('task');
    expect(tsk.excludedCount).toBe(1);

    // Cross-check against the DB directly: the disclosure must equal the real delta, which
    // is the whole claim. A disclosure that reported a plausible-but-wrong number would be
    // worse than none.
    const real = await db.query(
      `SELECT count(*)::int AS n FROM technical_decisions
        WHERE project_id = $1 AND archived_at IS NOT NULL`,
      [projectId]
    );
    expect(dec.excludedCount).toBe(real.rows[0].n);
  });

  // ── G3: THE ABSENT/ZERO DIRECTION. A measured zero is not the same as "flag off". ──
  test('G3: zero archived reads as none-archived — NOT the same shape as includeArchived:true', async () => {
    const zero = disclosuresOf(await callOp('context_stats', { projectId: emptyProjectId }))[0];
    expect(zero, 'the block must be PRESENT at zero, or zero is indistinguishable from an ' +
      'op that was never wired').toBeDefined();
    expect(zero.state).toBe('none-archived');
    expect(zero.excludedCount).toBe(0);
    expect(zero.includeArchived).toBe(false);

    const widened = disclosuresOf(
      await callOp('context_stats', { projectId: emptyProjectId, includeArchived: true })
    )[0];
    expect(widened.state).toBe('included');
    expect(widened.excludedCount).toBe(0);

    // THE POINT: both carry excludedCount 0, and they are still distinguishable — in the
    // structured block and in the rendered line. If these two ever collapse to one shape,
    // the feature has lost the thing it was built for.
    expect(zero.state).not.toBe(widened.state);
    expect(renderArchiveDisclosure(zero)).not.toBe(renderArchiveDisclosure(widened));

    // And a WIDENED read of the project that DOES have archived rows is 'included' too,
    // proving the state is decided by the flag and not by the count being zero.
    const widenedNonEmpty = disclosuresOf(
      await callOp('decision_stats', { projectId, includeArchived: true })
    )[0];
    expect(widenedNonEmpty.state).toBe('included');
  });

  // ── G4: THE DANGEROUS READ. Zero results + hidden rows must still disclose. ──
  test('G4: a read returning NO results still discloses the archived population', async () => {
    const resp = await callOp('context_search', {
      projectId,
      query: 'zzz-no-such-content-anywhere-qqq',
    });
    const d = disclosuresOf(resp)[0];
    expect(
      d,
      'An empty result set with archived rows behind it is the read that most looks clean ' +
        'and is not — this is the exit the per-return-stamping approach would have missed.'
    ).toBeDefined();
    expect(d.state).toBe('excluded');
    expect(d.excludedCount).toBe(3);
    expect(textOf(resp)).toContain('Archived contexts EXCLUDED');
  });

  // ── G5: SINGLE RENDERER. The sentence is composed in exactly one place. ──
  test('G5: the disclosure line is composed ONLY by renderArchiveDisclosure', () => {
    const root = join(process.cwd(), 'src');
    // POPULATION: every route source plus the seam itself. Stated here rather than left
    // implicit — this guard's own scope is the thing most likely to be wrong about it.
    const files = readdirSync(join(root, 'routes'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `routes/${f}`);
    expect(files.length, 'the routes directory scan returned nothing — the guard would ' +
      'pass vacuously').toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const f of files) {
      const body = readFileSync(join(root, f), 'utf8');
      // The rendered vocabulary must not be hand-typed outside the renderer. A second
      // composer is a second copy that drifts from the structured block beside it.
      if (/Archived (contexts|decisions|tasks) (EXCLUDED|INCLUDED)/.test(body)) {
        offenders.push(f);
      }
    }
    expect(
      offenders,
      'The disclosure sentence is hand-composed outside services/archiveDisclosure.ts. ' +
        'Call renderArchiveDisclosure() instead.'
    ).toEqual([]);
  });

  // ── G6: the UNCOVERED remainder is measured, not described — and it is exactly the
  //        declared un-narrowable set, each of which says so in its contract. ──
  test('G6: the flagless count-bearing ops are EXACTLY ARCHIVE_UNNARROWABLE_OPS', () => {
    const flagged = new Set(opsDeclaringIncludeArchived().ops);
    const countBearing = (OP_REGISTRY as any[]).filter((o) => o.reportsCount).map((o) => o.opId);
    const silent = countBearing.filter((op: string) => !flagged.has(op)).sort();
    expect(
      silent,
      'A count-bearing op that narrows its population and offers no includeArchived flag ' +
        'cannot be widened by any caller. The only ops allowed here are the ones declared ' +
        'un-narrowable WITH A REASON in ARCHIVE_UNNARROWABLE_OPS — a ninth ' +
        'silent count-bearing op must either take the flag + disclose, or be declared there.'
    ).toEqual([...ARCHIVE_UNNARROWABLE_OPS].sort());
    // The three named there ARE the session ops (pinned by name, so a reclassification of
    // project_info/project_list back to silent is reported as itself).
    expect([...ARCHIVE_UNNARROWABLE_OPS].sort()).toEqual(['session_get', 'session_list', 'session_status']);
  });

  test('G6b: every un-narrowable op STATES the narrowing in its advertised contract', () => {
    const missing = ARCHIVE_UNNARROWABLE_OPS.filter((op) => {
      const entry = (OP_REGISTRY as any[]).find((o) => o.opId === op);
      return !entry || !entry.description.includes(ARCHIVE_UNNARROWABLE_CONTRACT_PHRASE);
    });
    expect(
      missing,
      `these ops narrow by archived_at with no flag and their description does not say ` +
        `"${ARCHIVE_UNNARROWABLE_CONTRACT_PHRASE}" — a caller reading the contract cannot learn ` +
        `the count was narrowed.`
    ).toEqual([]);
  });

  // ── G11: project_info — default narrows + discloses; includeArchived widens; zero is measured. ──
  test('G11: project_info contextCount narrows to live rows by default and DISCLOSES; the flag widens', async () => {
    const narrowed = await callOp('project_info', { project: projectId });
    expect(narrowed.structuredContent.project.contextCount).toBe(2);
    const d = disclosuresOf(narrowed)[0];
    expect(d).toBeDefined();
    expect(d.entity).toBe('context');
    expect(d.state).toBe('excluded');
    expect(d.excludedCount).toBe(3);
    expect(textOf(narrowed)).toContain('Archived contexts EXCLUDED: 3');

    // By NAME too — the disclosure resolves the same subject the op did.
    const byName = await callOp('project_info', { project: PROJ_NAME });
    expect(disclosuresOf(byName)[0]?.excludedCount).toBe(3);

    const widened = await callOp('project_info', { project: projectId, includeArchived: true });
    expect(widened.structuredContent.project.contextCount).toBe(5);
    expect(disclosuresOf(widened)[0].state).toBe('included');

    // THE ZERO DIRECTION: a project with nothing archived reports a MEASURED zero, not the
    // 'included' shape and not an absent block.
    const zero = await callOp('project_info', { project: emptyProjectId });
    expect(zero.structuredContent.project.contextCount).toBe(1);
    expect(disclosuresOf(zero)[0].state).toBe('none-archived');
    expect(disclosuresOf(zero)[0].excludedCount).toBe(0);
  });

  // ── G12: project_list — fleet-wide scope, only when a count is actually emitted. ──
  test('G12: project_list discloses ACROSS ALL PROJECTS when includeStats is on, and not at all when it is off', async () => {
    const withStats = await callOp('project_list', { includeStats: true, limit: 100 });
    const row = withStats.structuredContent.results.find((r: any) => r.id === projectId);
    expect(row, 'fixture project not in the first 100 — raise the limit').toBeDefined();
    expect(row.contextCount).toBe(2);
    const d = disclosuresOf(withStats)[0];
    expect(d).toBeDefined();
    expect(d.state).toBe('excluded');
    expect(d.scopeNote).toContain('ALL projects');
    // The number is the FLEET-WIDE archived population, cross-checked in SQL — never the
    // caller's current project standing in for "all".
    const real = await db.query(`SELECT count(*)::int AS n FROM contexts WHERE archived_at IS NOT NULL`);
    expect(d.excludedCount).toBe(real.rows[0].n);
    expect(d.excludedCount).toBeGreaterThanOrEqual(3);

    const widened = await callOp('project_list', { includeStats: true, includeArchived: true, limit: 100 });
    expect(widened.structuredContent.results.find((r: any) => r.id === projectId).contextCount).toBe(5);
    expect(disclosuresOf(widened)[0].state).toBe('included');

    // NO COUNT, NO DISCLOSURE: without includeStats the response carries no contextCount,
    // so a block here would describe a narrowing that did not happen.
    const noStats = await callOp('project_list', { limit: 100 });
    expect(noStats.structuredContent.results[0]).not.toHaveProperty('contextCount', expect.any(Number));
    expect(disclosuresOf(noStats)).toEqual([]);
  });

  // ── G7: TAG CENSUS agrees with a full enumeration of the same population. ──
  test('G7: the census counts the SAME population the enumerating ops count', async () => {
    const resp = await callOp('project_tags', { projectId });
    const sc = resp.structuredContent;
    expect(sc.evaluated).toBe(true);

    const alpha = sc.tags.find((t: any) => t.tag === 'census-alpha');
    // DEFAULT (archived excluded): 2 live contexts + 1 live decision carry census-alpha.
    expect(alpha.count).toBe(3);
    expect(alpha.byEntity).toEqual({ context: 2, decision: 1 });

    // Cross-check against a FULL ENUMERATION done independently in SQL — a census that
    // disagreed with the population it claims to describe would be a new instrument that
    // lies quietly, which is the defect this op exists to remove.
    const enumerated = await db.query(
      `SELECT (SELECT count(*) FROM contexts
                WHERE project_id = $1 AND archived_at IS NULL AND 'census-alpha' = ANY(tags))
            + (SELECT count(*) FROM technical_decisions
                WHERE project_id = $1 AND archived_at IS NULL AND 'census-alpha' = ANY(tags))
            AS n`,
      [projectId]
    );
    expect(alpha.count).toBe(Number(enumerated.rows[0].n));

    // WIDENED: all 5 contexts + all 5 decisions carry it.
    const wide = await callOp('project_tags', { projectId, includeArchived: true });
    const alphaWide = wide.structuredContent.tags.find((t: any) => t.tag === 'census-alpha');
    expect(alphaWide.count).toBe(10);
    expect(alphaWide.byEntity).toEqual({ context: 5, decision: 5 });
  });

  // ── G8: the census answers the question it was built for, by PREFIX, in one call. ──
  test('G8: prefix filter finds the invalid-* population without a full-table walk', async () => {
    const resp = await callOp('project_tags', { projectId, prefix: 'invalid-' });
    const tags = resp.structuredContent.tags.map((t: any) => t.tag);
    expect(tags).toEqual(['invalid-class:demo']);
    expect(resp.structuredContent.matched).toBe(1);

    // Entity scoping narrows it, and the echo says what was searched.
    const scoped = await callOp('project_tags', {
      projectId,
      prefix: 'census-',
      entities: ['task'],
    });
    expect(scoped.structuredContent.tags.map((t: any) => t.tag)).toEqual(['census-beta']);
    expect(scoped.structuredContent.filter.entities).toEqual(['task']);
  });

  // ── G9: THE ABSENT DIRECTION for the census. "No match" ≠ "did not evaluate". ──
  test('G9: a prefix matching nothing is a MEASURED zero, distinguishable from a failure', async () => {
    const resp = await callOp('project_tags', { projectId, prefix: 'no-such-prefix-zzz' });
    const sc = resp.structuredContent;
    expect(sc.ok).toBe(true);
    expect(sc.matched).toBe(0);
    expect(sc.tags).toEqual([]);
    // The positive statement that the census RAN. Without this, an empty `tags` array is
    // the same response an unevaluated filter would produce.
    expect(sc.evaluated).toBe(true);
    expect(sc.filter.prefix).toBe('no-such-prefix-zzz');
    expect(textOf(resp)).toContain('evaluated: true');
  });

  // ── G10: prefix wildcards are DATA. A caller's % must not match everything. ──
  test('G10: LIKE metacharacters in the prefix are literal, not wildcards', async () => {
    const resp = await callOp('project_tags', { projectId, prefix: '%' });
    expect(
      resp.structuredContent.matched,
      'A bare "%" must match tags that literally START with a percent sign — none here. ' +
        'If this returns every tag, the prefix is being interpreted as LIKE syntax.'
    ).toBe(0);
  });
});
