/**
 * WHICH HANDOFF IS LIVE — the P5.2 acceptance contract (scope
 * riverbend/reports/artifacts/p5-briefing-parity/SCOPE.md §2 P5.2, §3.1, §3.2, §8.5).
 *
 * DRIVEN THROUGH THE SHIPPED COMPOSITION, not a hand-wired pipe (C3). Handoffs are stored
 * with the real `context_store` through validate → routeExecutor — the exact path the HTTP
 * bridge uses — so the declared `supersedes` chain and the `ref:resume` stamp are minted by
 * the product, not by the fixture. The assertions run against `gatherBriefingData` +
 * `renderBriefing`, the two functions the briefing route calls, so what is asserted is what
 * a customer is served.
 *
 * ONLY THE CORRUPTIONS ARE HAND-BUILT, and that is the point of them: a cross-project edge
 * row, an archived record that keeps its edges, a soft belief edge, a chain with a gap in
 * it. None can be produced through the public surface, which is precisely why the resolver
 * has to survive them.
 *
 * ── THE FROZEN PRE-FIX SUBJECT (test 1) ─────────────────────────────────────────────
 * Test 1 executes the LITERAL pre-P5.2 predicate against the same fixture and asserts it
 * selects the WRONG, three-generations-dead handoff. It is KEPT deliberately: the defect is
 * no longer in the tree, so this is the only thing that can regression-test it, and it makes
 * the reproduction a fact in CI rather than a sentence in a report.
 *
 * DB target: the disposable migrated ci_* DB — never production.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { resolveHandoffHead } from '../services/handoffHead.js';
import {
  gatherBriefingData,
  renderBriefing,
  briefingConfig,
} from '../services/projectBriefing.js';
import { RESUME_POINTER_TAG } from '../config/handoffResumePointerConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}

async function freshProject(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'P5.2 head fixture') RETURNING id`,
      [`p52-${label}-${STAMP}`],
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `p52-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** Store one handoff through the SHIPPED path; the chain edge + ref:resume are the product's. */
async function storeHandoff(conn: string, content: string): Promise<string> {
  const r = await viaTool('context_store', { content, type: 'handoff' }, conn);
  const id = r.structuredContent?.context?.id;
  expect(id, 'context_store(handoff) must return an id').toBeTruthy();
  return id as string;
}

/** Store a linear chain of `n` handoffs, oldest first. Returns ids in write order. */
async function storeChain(conn: string, prefix: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await storeHandoff(conn, `${prefix}-${i} first line\nbody`));
  return ids;
}

const dropEdge = (from: string, to: string) =>
  db.query(`DELETE FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='supersedes'`, [from, to]);

/** A DECLARED edge through the PUBLIC link tool (mint_via 'link-tool' => declared). */
const declareEdge = (conn: string, from: string, to: string, edgeType: string) =>
  viaTool('link', { from, to, fromType: 'context', toType: 'context', edgeType }, conn);
const declareSupersedes = (conn: string, from: string, to: string) =>
  declareEdge(conn, from, to, 'supersedes');

/**
 * A BACKWARDS edge, hand-built. `mint_via 'link-tool'` => provenance_class DECLARED, i.e.
 * byte-identical to what the `link` tool used to write here.
 *
 * WHY HAND-BUILT RATHER THAN THROUGH THE `link` TOOL (commit 6db3618):
 * `mintEdge` now checks CHRONOLOGY at the choke point and REFUSES a chronology-ordered edge
 * whose source is older than its target — `{created:false, refused:'direction_backwards_in_time'}`,
 * surfaced by the link tool as `ok:false, action:'rejected'` (routes/links.routes.ts). That
 * refusal is CORRECT and is not weakened here: a cycle and a backwards soft supersession are
 * precisely the claims a real caller must not be able to make. They are also exactly the rows
 * that already exist in the database from before the guard (measured on prod: 1 backwards
 * `supersedes`, 58 backwards `possibly_supersedes`), and the DB itself still accepts them —
 * chronology is enforced in the mint path, not by a constraint. So these belong with this
 * file's other hand-built CORRUPTIONS: the resolver's job is to survive data the product can
 * no longer create, and driving the fixture through the guarded mint path would delete the
 * corruption instead of testing the walk against it.
 *
 * The public path's refusal is asserted by its own guard, edgeChronologyGuard.contract.test.ts;
 * it is not restated here.
 */
const backwardsDeclaredEdge = (from: string, to: string, edgeType: string, projectId: string) =>
  db.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
     VALUES ($1,'context',$2,'context',$3,$4,'link','link-tool')`,
    [from, to, edgeType, projectId],
  );

/** A SOFT belief edge — what the adjudicator mints. Hand-built: no public tool writes these. */
const softSupersedes = (from: string, to: string, projectId: string) =>
  db.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
     VALUES ($1,'context',$2,'context','possibly_supersedes',$3,'auto:belief-adjudicator','belief-adjudication')`,
    [from, to, projectId],
  );

/**
 * THE LITERAL PRE-P5.2 PREDICATE, frozen. Copied byte-for-byte from
 * projectBriefing.ts@6c42047 lines 455-466 so the reproduction cannot drift into agreeing
 * with the fix by accident.
 */
async function preFixOneHopPick(projectId: string): Promise<string | undefined> {
  return (
    await db.query(
      `SELECT id, content, created_at
         FROM contexts c
        WHERE c.project_id = $1 AND c.context_type = $2 AND c.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_id = c.id AND l.edge_type = 'supersedes')
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1`,
      [projectId, 'handoff'],
    )
  ).rows[0]?.id;
}

/** The `## Handoff` section of a rendered briefing — what a customer actually reads. */
async function handoffSection(projectId: string): Promise<string> {
  const data = await gatherBriefingData(projectId, 'p52', briefingConfig(), db, null);
  const md = renderBriefing(data, briefingConfig()).markdown;
  const start = md.indexOf('## Handoff');
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? md.slice(start) : md.slice(start, start + 1 + next);
}

afterAll(async () => {
  for (const pid of projectIds) {
    await db.query(`DELETE FROM links WHERE project_id = $1`, [pid]);
    await db.query(`DELETE FROM links WHERE from_id IN (SELECT id FROM contexts WHERE project_id=$1)
                       OR to_id IN (SELECT id FROM contexts WHERE project_id=$1)`, [pid]);
    await db.query(`DELETE FROM contexts WHERE project_id = $1`, [pid]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  }
  await db.end?.();
});

describe('P5.2 — the handoff head is CHAIN-WALKED, and refuses rather than guessing', () => {
  /* ─────────────────────────────────────────────────────────────────────────────────
   * PROOF 1 — a 3-deep declared chain resolves to the TIP, and the PRE-FIX code does not.
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('1a. a clean 3-deep chain resolves to the tip, both seeds concurring', async () => {
    const { projectId, conn } = await freshProject('clean3');
    const [a, b, c, d] = await storeChain(conn, 'clean', 4);

    const head = await resolveHandoffHead(projectId, db);
    expect(head.status).toBe('resolved');
    expect(head.headId).toBe(d);
    expect(head.concurringSeeds.sort()).toEqual(['recency', 'tag']);
    // The lineage scan saw the whole 4-record chain and found no fork.
    expect(head.lineage).toEqual({ ancestorsScanned: 4, scanComplete: true });
    expect([a, b, c]).not.toContain(head.headId);

    // Served: the tip's body, under a header that says it was WALKED to.
    const section = await handoffSection(projectId);
    expect(section).toContain('clean-3 first line');
    expect(section).toContain('[head:chain-walk]');
  });

  test('1b. REPRODUCTION (frozen): a gap in the chain + a poisoned head makes the PRE-FIX one-hop predicate serve a 3-generations-dead handoff — the chain walk serves the live one', async () => {
    const { projectId, conn } = await freshProject('repro');
    const [a, b, c, d] = await storeChain(conn, 'repro', 4);

    // (i) A GAP. The oldest link is missing — a handoff written before the chain was minted
    //     at all, or a mint that failed. This is what leaves `a` with no inbound edge.
    await dropEdge(b, a);

    // (ii) A POISONED HEAD. Another project's handoff carries a declared supersedes edge at
    //      `d`. The edge row belongs to project Q; the pre-fix predicate scoped neither the
    //      edge nor the superseding record, so it accepted it.
    const other = await freshProject('repro-other');
    const z = await storeHandoff(other.conn, 'foreign handoff from an unrelated harness');
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
       VALUES ($1,'context',$2,'context','supersedes',$3,'link','link-tool')`,
      [z, d, other.projectId],
    );

    // THE PRE-FIX BEHAVIOUR — the defect, executed.
    expect(await preFixOneHopPick(projectId)).toBe(a);

    // THE FIX.
    const head = await resolveHandoffHead(projectId, db);
    expect(head.status).toBe('resolved');
    expect(head.headId).toBe(d);

    const section = await handoffSection(projectId);
    expect(section).toContain('repro-3 first line');
    expect(section).not.toContain('repro-0 first line');
    expect(c).toBeTruthy();
  });

  /* ─────────────────────────────────────────────────────────────────────────────────
   * PROOF 2 — a FORKED chain refuses AND RENDERS the fork (SCOPE §8.5).
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('2. a forked chain refuses to pick AND renders both candidates, the reason, and an actionable in-band remedy', async () => {
    const { projectId, conn } = await freshProject('fork');
    // THE FIRST LINE IS DELIBERATELY IDENTICAL ON ALL THREE. Real handoffs open with a
    // MODE line, and the first captured sample of this render showed two candidates as
    // `MODE: debug` / `MODE: build` — the excerpt meant to let a reader tell two records
    // apart was showing them the one line every handoff shares. The fixture reproduces
    // that shape so the assertion below cannot pass by having convenient fixtures.
    const x = await storeHandoff(conn, 'MODE: build\nfork-0 first line\nbody');
    const p = await storeHandoff(conn, 'MODE: build\nfork-1 first line\nbody');
    const q = await storeHandoff(conn, 'MODE: build\nfork-2 first line\nbody');
    // Re-point q from p to x: now BOTH p and q declare that they supersede x, and neither
    // supersedes the other. Two live heads, one chain.
    await dropEdge(q, p);
    await declareSupersedes(conn, q, x);

    const head = await resolveHandoffHead(projectId, db);
    expect(head.status).toBe('refused');
    expect(head.refusal).toBe('fork');
    expect(head.headId).toBeNull();
    expect(head.candidates.map((c) => c.id).sort()).toEqual([p, q].sort());

    const section = await handoffSection(projectId);
    // (a) it refuses, in a machine-readable marker;
    expect(section).toContain('[head:AMBIGUOUS]');
    expect(section).toContain('[reason:fork]');
    // (b) it is NOT empty and does NOT claim there is no handoff;
    expect(section).not.toContain('none recorded');
    expect(section.length).toBeGreaterThan(400);
    // (c) EVERY candidate is shown, with its id AND its timestamp AND its headline;
    for (const id of [p, q]) expect(section).toContain(`[id:${id.slice(0, 8)}]`);
    expect(section).toContain('fork-1 first line');
    expect(section).toContain('fork-2 first line');
    expect(section).toMatch(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/);
    // …and the two candidate LINES must actually differ once id and timestamp are stripped.
    // Without this, an excerpt that showed only the shared MODE line would satisfy every
    // assertion above while leaving the reader unable to tell the candidates apart — which
    // is what the first cut of this renderer did.
    const candidateLines = section
      .split('\n')
      .filter((l) => l.startsWith('- [id:'))
      .map((l) => l.replace(/^- \[id:[0-9a-f]{8}\] \[[^\]]+\] /, ''));
    expect(candidateLines.length).toBe(2);
    expect(candidateLines[0]).not.toBe(candidateLines[1]);
    // (d) it says WHY in plain language;
    expect(section).toContain('the chain BRANCHES');
    // (e) and it hands over a remedy the customer can perform, with FULL ids so it is
    //     copy-pasteable — a truncated id is not a command.
    expect(section).toContain('edgeType:"supersedes"');
    expect(section).toContain(q);
  });

  test('2b. storing a NEW handoff does NOT clear the fork — the remedy says so, and this asserts it rather than trusting the sentence', async () => {
    const { projectId, conn } = await freshProject('fork-persists');
    const [x, p, q] = await storeChain(conn, 'forkp', 3);
    expect(x).toBeTruthy();
    await dropEdge(q, p);
    await declareSupersedes(conn, q, x);
    expect((await resolveHandoffHead(projectId, db)).refusal).toBe('fork');

    // The write-path mint picks its predecessor by (created_at,id) adjacency, so the new
    // handoff extends ONE arm. The other arm is still a live head.
    await storeHandoff(conn, 'forkp-3 a new handoff written after the fork');
    const after = await resolveHandoffHead(projectId, db);
    expect(after.status).toBe('refused');
    expect(after.refusal).toBe('fork');
    expect(p).toBeTruthy();
  });

  /* ─────────────────────────────────────────────────────────────────────────────────
   * PROOF 3 — a CYCLE refuses, without hanging and without blowing the stack.
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('3. a cycle refuses, terminates fast, and still renders candidates', async () => {
    const { projectId, conn } = await freshProject('cycle');
    const [a, b, c] = await storeChain(conn, 'cycle', 3);
    // c → b → a already; close the loop with a declared a→c supersedes edge. Hand-built:
    // the loop-closing edge points BACKWARDS in time and the mint path now refuses it
    // (see backwardsDeclaredEdge above). The row is identical to the one the link tool
    // wrote before that guard existed — which is the row this walk must still survive.
    await backwardsDeclaredEdge(a, c, 'supersedes', projectId);

    const t0 = Date.now();
    const head = await resolveHandoffHead(projectId, db);
    const elapsed = Date.now() - t0;

    expect(head.status).toBe('refused');
    expect(head.refusal).toBe('cycle');
    // A runaway walk on a 3-cycle would either hang or return thousands of rows; the path
    // guard makes it terminate at the first revisit. 10s is a generous ceiling for a query
    // that should take single-digit milliseconds — it is a HANG detector, not a benchmark.
    expect(elapsed).toBeLessThan(10_000);
    expect(head.candidates.length).toBeGreaterThan(0);

    const section = await handoffSection(projectId);
    expect(section).toContain('[reason:cycle]');
    expect(section).toContain('the chain LOOPS');
    expect(section).not.toContain('none recorded');
    expect([a, b, c].length).toBe(3);
  });

  /* ─────────────────────────────────────────────────────────────────────────────────
   * PROOF 4 — a SOFT (belief-minted) edge is NEVER walked. Negative control.
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('4. neither a GUESSED nor a DECLARED soft edge is ever walked — and the DB itself refuses a guessed hard edge', async () => {
    const { projectId, conn } = await freshProject('soft');
    const [a, b, c] = await storeChain(conn, 'soft', 3);
    // The chain is c -> b -> a; the head is c.

    // TWO soft edges, and TWO is not belt-and-braces — it is what makes each of the walk's
    // two filters independently observable. MEASURED, not assumed: the first cut of this
    // test carried only the guessed edge, and the mutation probe then showed that deleting
    // the `edge_type='supersedes'` filter changed NOTHING, because `provenance_class` was
    // quietly carrying the whole assertion. A guard whose two halves cannot be told apart
    // is one guard wearing two names.
    //
    // (i) THE ADJUDICATOR'S OPINION — soft edge, GUESSED provenance. Blocked by either
    //     filter. If walked, c gains a successor and the chain closes into a cycle, so
    //     "still resolves to c" is a real observation rather than a tautology.
    await softSupersedes(a, c, projectId);
    const guessedSoft = await db.query(
      `SELECT provenance_class FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='possibly_supersedes'`,
      [a, c],
    );
    expect(guessedSoft.rows.length, 'the guessed soft edge fixture must actually exist').toBe(1);
    expect(guessedSoft.rows[0].provenance_class).toBe('guessed');

    // (ii) A HAND-DECLARED SOFT EDGE. The `link` tool will mint `possibly_supersedes` for
    //      anyone who asks, and it stamps mint_via 'link-tool' => DECLARED. So this is a
    //      soft CLAIM with declared PROVENANCE: the row that only the edge-type filter can
    //      stop. Also a cycle if walked (b -> c and c -> b).
    // Hand-built for the same reason as the cycle above: b is OLDER than c, so this is a
    // backwards soft supersession and mintEdge refuses it. `mint_via 'link-tool'` reproduces
    // the link tool's row exactly, including provenance_class='declared', which is the whole
    // point of this fixture — the row only the EDGE-TYPE filter can stop.
    await backwardsDeclaredEdge(b, c, 'possibly_supersedes', projectId);
    const declaredSoft = await db.query(
      `SELECT provenance_class FROM links WHERE from_id=$1 AND to_id=$2 AND edge_type='possibly_supersedes'`,
      [b, c],
    );
    expect(declaredSoft.rows.length, 'the declared soft edge fixture must actually exist').toBe(1);
    expect(
      declaredSoft.rows[0].provenance_class,
      'this fixture is only load-bearing if its provenance is DECLARED',
    ).toBe('declared');

    const head = await resolveHandoffHead(projectId, db);
    expect(head.status).toBe('resolved');
    expect(head.headId).toBe(c);

    // THE LOWEST RUNG (C1): `provenance_class='declared'` in the walk is DEFENSE IN DEPTH
    // over a DB CHECK constraint (migration 087), and it is honest to say so — a mutation
    // probe cannot make that filter go RED today, because the row it would admit CANNOT BE
    // WRITTEN. So the constraint is what is asserted, from OBSERVED VALUES rather than from
    // the migration file (a constraint someone dropped would still be in the file). Two
    // observations, because either alone is weak: the catalog says it exists AND IS
    // VALIDATED, and the write is actually refused while the declared control succeeds.
    const con = await db.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'links_supersedes_declared_only'`,
    );
    expect(con.rows.length, 'migration 087 constraint must exist').toBe(1);
    expect(con.rows[0].convalidated).toBe(true);

    await expect(
      db.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
         VALUES ($1,'context',$2,'context','supersedes',$3,'auto:belief-adjudicator','belief-adjudication')`,
        [a, c, projectId],
      ),
    ).rejects.toThrow();
    // THE CONTROL that makes the rejection mean what we say it means: the IDENTICAL row —
    // same endpoints, same edge type — with a DECLARED via is ACCEPTED. So the refusal is
    // about PROVENANCE and not about the row, the endpoints, or some unrelated constraint.
    // (Run last on purpose: it leaves this fixture project deliberately cyclic.)
    await expect(
      db.query(
        `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
         VALUES ($1,'context',$2,'context','supersedes',$3,'link','link-tool')`,
        [a, c, projectId],
      ),
    ).resolves.toBeTruthy();
  });

  /* ─────────────────────────────────────────────────────────────────────────────────
   * PROOF 5 — the READ path is TYPE-GATED (SCOPE §3.1).
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('5. a type:error record carrying ref:resume does not seed the resolver', async () => {
    const { projectId, conn } = await freshProject('typegate');
    const [a, b] = await storeChain(conn, 'tg', 2);

    // A caller-supplied ref:resume on a non-handoff type. The auto-STAMP is gated to
    // `handoff`; NOTHING rejects this on the write side, and a record exactly like it
    // seeded a resolver for real. The gate that matters is therefore on the READ.
    const err = await viaTool(
      'context_store',
      { content: 'a failure report that happens to be tagged', type: 'error', tags: [RESUME_POINTER_TAG] },
      conn,
    );
    const errId = err.structuredContent?.context?.id as string;
    expect(errId).toBeTruthy();
    // The fixture must be REAL: the tag is stored, on a non-handoff type, and it is NEWER
    // than the head — so an ungated tag seed would certainly pick it.
    const row = await db.query(`SELECT context_type, tags, created_at FROM contexts WHERE id=$1`, [errId]);
    expect(row.rows[0].context_type).toBe('error');
    expect(row.rows[0].tags).toContain(RESUME_POINTER_TAG);

    const head = await resolveHandoffHead(projectId, db);
    expect(head.status).toBe('resolved');
    expect(head.headId).toBe(b);
    const tagWalk = head.walks.find((w) => w.seed === 'tag')!;
    expect(tagWalk.seedId).toBe(b);
    expect(tagWalk.seedId).not.toBe(errId);
    expect(a).toBeTruthy();
  });

  /* ─────────────────────────────────────────────────────────────────────────────────
   * PROOF 6 — every step is PROJECT-SCOPED (SCOPE §3.2).
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('6. a handoff in another project can neither seed nor become this project\'s head', async () => {
    const p = await freshProject('scope-p');
    const q = await freshProject('scope-q');
    const [, pHead] = await storeChain(p.conn, 'sp', 2);
    // Written LAST, so it is the newest handoff row in the database by a clear margin: an
    // unscoped recency seed would pick it, and an unscoped tag seed would too.
    const qHead = await storeHandoff(q.conn, 'sq-0 the other project newest handoff');

    const headP = await resolveHandoffHead(p.projectId, db);
    expect(headP.status).toBe('resolved');
    expect(headP.headId).toBe(pHead);
    expect(headP.headId).not.toBe(qHead);
    for (const w of headP.walks) expect(w.seedId).not.toBe(qHead);

    // …and Q is unaffected: the scoping is symmetric, not a special case for P.
    const headQ = await resolveHandoffHead(q.projectId, db);
    expect(headQ.headId).toBe(qHead);

    // The served document agrees with the resolution.
    expect(await handoffSection(p.projectId)).not.toContain('sq-0 the other project');
  });

  /* ─────────────────────────────────────────────────────────────────────────────────
   * THE THIRD STATE — absence is not refusal.
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('7. a project with NO handoff is ABSENT, not refused — the two never share a branch', async () => {
    const { projectId } = await freshProject('absent');
    const head = await resolveHandoffHead(projectId, db);
    expect(head.status).toBe('absent');
    expect(head.refusal).toBeNull();
    expect(head.candidates).toEqual([]);
    expect(await handoffSection(projectId)).toContain('none recorded');
  });

  /* ─────────────────────────────────────────────────────────────────────────────────
   * THE HOP BOUND is a COULD-NOT-MEASURE, never a silent stop at the last id seen.
   * ───────────────────────────────────────────────────────────────────────────────── */
  test('8. the hop bound refuses instead of reporting the record it stopped on', async () => {
    const { projectId, conn } = await freshProject('hopbound');
    const ids = await storeChain(conn, 'hop', 4);
    // Bound of 1: the walk from the tag/recency seed is fine (0 hops), but the LINEAGE scan
    // is cut short — so this asserts the two bounds have DIFFERENT consequences, which is
    // the distinction the resolver claims to make.
    const bounded = await resolveHandoffHead(projectId, db, 1);
    expect(bounded.status).toBe('resolved');
    expect(bounded.headId).toBe(ids[3]);
    expect(bounded.lineage.scanComplete, 'a cut-short ancestor scan must SAY it was cut short').toBe(false);

    // Unbounded: same head, complete coverage. The control that makes the above meaningful.
    const full = await resolveHandoffHead(projectId, db);
    expect(full.headId).toBe(ids[3]);
    expect(full.lineage.scanComplete).toBe(true);
  });
});
