/**
 * TASKS STOP BEING BORN GRAPH LEAVES — task_create/task_update edge minting.
 *
 * THE BUG THIS LOCKS. task_create minted NOTHING. Tasks carried `task:`/`decision:` threading
 * tags and had ZERO outbound edges — every edge on a task was INBOUND, from contexts that
 * tagged it. Our convention calls the task the SPINE of a thread, and the spine was the one
 * record type that could not point at anything. 706 tasks affected.
 *
 * The assertions below check the exact symptom that was verified live: after creating a task
 * with a threading tag, `get_links` on that task shows the edge with `direction: 'out'`.
 * Asserting the edge merely EXISTS would have passed before this work too (the inbound edges
 * were always there) — the DIRECTION is the whole point.
 *
 * PER-SURFACE, flat AND gateway. The gateway (`task({action:'create'})`) dispatches through
 * the same routes/index.ts -> handleCreate, so it SHOULD be covered by the flat test. "Should
 * be" is the reason to pin it: a future surface split would silently regress one of them.
 *
 * Driven through validate -> routeExecutor (the exact path the HTTP bridge uses); embeddings
 * mocked for determinism.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { execFileSync } from 'child_process';
import {
  TASK_EDGE_CREATED_BY,
  TASK_EDGE_MINT_ENV_FLAG,
  parseBooleanFlag,
  taskEdgeMintFlagSummary,
} from '../config/tagEdgeConfig.js';
import { dispatchGateway } from '../routes/gateway.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const CONN = `task-edges-conn-${STAMP}`;
const PROJ_NAME = `task-edges-P-${STAMP}`;

let projectId: string;

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** Create a task through the FLAT surface and return its id. */
async function createTask(args: any): Promise<{ id: string; resp: any }> {
  const resp = await viaTool('task_create', args);
  const id = resp?.structuredContent?.task?.id;
  expect(id, `task_create returned no id: ${JSON.stringify(resp).slice(0, 300)}`).toBeTruthy();
  return { id, resp };
}

/** The OUT edges of a record, straight from the DB (the fuse, independent of get_links). */
async function outEdges(id: string): Promise<Array<{ edge_type: string; to_id: string; created_by: string; mint_via: string; metadata: any }>> {
  const r = await db.query(
    `SELECT edge_type, to_id, created_by, mint_via, metadata FROM links WHERE from_id = $1 ORDER BY edge_type`,
    [id]
  );
  return r.rows;
}

describe('task-source edge minting', () => {
  let anchorTask: string;
  let anchorDecision: string;
  let anchorContext: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'task edge minting') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    // Referents for the tags to point at.
    anchorTask = (await createTask({ title: 'the referenced task', type: 'feature' })).id;
    const dec = await viaTool('decision_record', {
      decisionType: 'pattern',
      title: 'the authorizing decision',
      description: 'd',
      rationale: 'r',
      impactLevel: 'medium',
    });
    anchorDecision = dec.structuredContent.decision.id;
    const ctx = await viaTool('context_store', {
      content: 'the source context for task edge tests',
      type: 'planning',
    });
    anchorContext = ctx.structuredContent.context.id;
  });
  // THIS SUITE RUNS UNPOSITIONED — restored explicitly, not assumed.
  // Auto-open means a task_create / decision_record in any earlier case leaves this shared
  // connection standing on a branch, so every later write in the file would pick up a
  // positional membership edge and the suite would be measuring task-source edge minting PLUS
  // positional membership. Each case here states its own precondition ("mints exactly
  // that edge", "an anchor with NO edges"), and this is what makes that precondition true
  // again rather than re-baselining every count around a second mechanism.
  // Auto-open's own behaviour is contracted in autoOpenPositions.contract.test.ts.
  beforeEach(async () => {
    await routeExecutor('branch_close', {}, { connectionId: CONN });
  });


  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── THE HEADLINE: an OUTBOUND edge, via get_links, on the FLAT surface ──────
  describe('flat surface (task_create)', () => {
    test('a decision: tag mints an OUTBOUND decided_by edge visible via get_links', async () => {
      const { id } = await createTask({
        title: 'task with a decision tag',
        type: 'feature',
        tags: [`decision:${id8(anchorDecision)}`],
      });

      const links = await viaTool('get_links', { id: id8(id) });
      const edges = links?.structuredContent?.results ?? [];
      const out = edges.filter((e: any) => e.direction === 'out');

      // THE EXACT SYMPTOM: before this work there were ZERO outbound edges here.
      expect(out.length, 'the task has at least one OUTBOUND edge').toBeGreaterThan(0);
      const decidedBy = out.find((e: any) => e.edgeType === 'decided_by');
      expect(decidedBy, 'a decided_by edge, pointing OUT').toBeDefined();
      expect(decidedBy.direction).toBe('out');
      expect(decidedBy.connectedId).toBe(anchorDecision);
      expect(decidedBy.connectedType).toBe('decision');
    });

    test('a task: tag on a TASK mints the WEAK related_to, not informs', async () => {
      const { id } = await createTask({
        title: 'task with a task tag',
        type: 'feature',
        tags: [`task:${id8(anchorTask)}`],
      });

      const rows = await outEdges(id);
      const edge = rows.find((r) => r.to_id === anchorTask);
      expect(edge, 'an edge to the referenced task exists').toBeDefined();
      // The contested cell. informs would make this task inherit the referenced task's
      // outcome as its own evidence — parent/child noise in the moat.
      expect(edge!.edge_type).toBe('related_to');
      expect(edge!.edge_type).not.toBe('informs');
      // The upgradeability markers: which tag produced it, and that it was EXPLICIT-weak
      // (a stated relation of unknown type) rather than an inferred similarity guess.
      expect(edge!.metadata?.source_tag).toBe(`task:${id8(anchorTask)}`);
    });

    test('a context: tag mints an OUTBOUND learned_from edge', async () => {
      const { id } = await createTask({
        title: 'task with a context tag',
        type: 'feature',
        tags: [`context:${id8(anchorContext)}`],
      });
      const rows = await outEdges(id);
      const edge = rows.find((r) => r.to_id === anchorContext);
      expect(edge?.edge_type).toBe('learned_from');
    });

    test('the `dependencies` column mirrors to depends_on edges with its own provenance', async () => {
      const depA = (await createTask({ title: 'dependency A', type: 'feature' })).id;
      const depB = (await createTask({ title: 'dependency B', type: 'feature' })).id;

      const { id, resp } = await createTask({
        title: 'task with dependencies',
        type: 'feature',
        dependencies: [id8(depA), id8(depB)],
      });

      const rows = await outEdges(id);
      const deps = rows.filter((r) => r.edge_type === 'depends_on');
      expect(deps.length, 'one depends_on edge per dependency').toBe(2);
      expect(deps.map((d) => d.to_id).sort()).toEqual([depA, depB].sort());
      // Distinct provenance stamp — this is what makes the backfill wholesale-reversible
      // and what a future reconciler keys on so it can never delete a human-curated edge.
      for (const d of deps) {
        expect(d.created_by).toBe(TASK_EDGE_CREATED_BY.taskDeps);
        // SK4: the "not a tag, the dependencies COLUMN" fact moved out of
        // metadata.source and into the mint_via column, which is the one normalized home.
        expect(d.mint_via).toBe(EDGE_MINT_VIA.taskDependencies);
      }
      // The COLUMN is kept (additive mirror, not a migration).
      expect(resp.structuredContent.task.dependencies?.length).toBe(2);
      expect(resp.structuredContent.task.mintedBySource.dependencies).toBe(2);
    });

    test('the explicit `links` param works on task_create (T5a parity)', async () => {
      const { id, resp } = await createTask({
        title: 'task with an explicit link',
        type: 'feature',
        links: [{ decision: id8(anchorDecision) }],
      });
      expect(resp.structuredContent.task.mintedBySource.links).toBe(1);
      const rows = await outEdges(id);
      expect(rows.some((r) => r.to_id === anchorDecision && r.edge_type === 'decided_by')).toBe(true);
    });

    test('minted edges are surfaced in BOTH channels', async () => {
      const { id, resp } = await createTask({
        title: 'task that reports its edges',
        type: 'feature',
        tags: [`decision:${id8(anchorDecision)}`],
      });
      expect(id).toBeTruthy();
      // Machine channel.
      expect(resp.structuredContent.task.edgesMinted).toBeGreaterThan(0);
      expect(resp.structuredContent.task.mintedBySource.tags).toBe(1);
      // Human channel.
      const text = resp.content.map((c: any) => c.text).join('\n');
      expect(text).toMatch(/Edges minted/i);
    });

    test('an unresolvable tag mints nothing, SURFACES the skip, and never breaks the write', async () => {
      const { id, resp } = await createTask({
        title: 'task with a bad tag',
        type: 'feature',
        tags: ['decision:ffffffff'],
      });
      // The task still exists — a bad tag must never break or roll back the write.
      const row = await db.query('SELECT id FROM tasks WHERE id = $1', [id]);
      expect(row.rows.length).toBe(1);
      expect(resp.isError).not.toBe(true);
      // ...and the skip is REPORTED, not swallowed.
      const skips = resp.structuredContent.task.edgeSkips ?? [];
      expect(skips.length).toBeGreaterThan(0);
      expect(resp.content.map((c: any) => c.text).join('\n')).toMatch(/Edges skipped/i);
    });

    test('lens/label tags mint nothing (deny-by-default reaches the route)', async () => {
      const { id } = await createTask({
        title: 'task with only label tags',
        type: 'feature',
        tags: ['ref:resume', 'scope:mcp', 'owner:coordinator', 'phase-3'],
      });
      expect(await outEdges(id)).toEqual([]);
    });
  });

  // ── THE GATEWAY SURFACE — same dispatch, pinned separately ─────────────────
  describe('gateway surface (task({action:"create"}))', () => {
    test('task({action:"create"}) mints the same OUTBOUND edge with direction "out"', async () => {
      // The gateway has its OWN dispatcher (routes/gateway.ts) — it does not go through the
      // flat validateToolArguments path, so it must be driven the way a protocol client
      // drives it. That difference is precisely why this is pinned separately.
      const resp = await dispatchGateway(
        'task',
        {
          action: 'create',
          title: 'gateway-created task',
          type: 'feature',
          tags: [`decision:${id8(anchorDecision)}`],
        },
        { connectionId: CONN },
      );
      const id = resp?.structuredContent?.task?.id;
      expect(id, `gateway create returned no id: ${JSON.stringify(resp).slice(0, 300)}`).toBeTruthy();

      const links = await viaTool('get_links', { id: id8(id) });
      const out = (links?.structuredContent?.results ?? []).filter((e: any) => e.direction === 'out');
      const decidedBy = out.find((e: any) => e.edgeType === 'decided_by');
      expect(decidedBy, 'the gateway surface mints the edge too').toBeDefined();
      expect(decidedBy.direction).toBe('out');
      expect(decidedBy.connectedId).toBe(anchorDecision);
    });
  });

  // ── THE KILL SWITCH ────────────────────────────────────────────────────────
  describe('MANDREL_TASK_EDGE_MINT_ENABLED kill switch', () => {
    test('OFF → the GATED task sources (tags, dependencies, links) mint nothing', async () => {
      // A surprise in prod must be a FLAG FLIP, not a rollback. Flipped on the live config
      // object rather than via process.env because the config is read once at module load —
      // stubbing env after import would be a NO-OP and this test would pass vacuously while
      // proving nothing (the trap a past incident names).
      //
      // SCOPE: the flag gates exactly the sources inside the
      // `TASK_EDGE_MINT_CONFIG.enabled` block in tasks.routes.ts — tag minting, the
      // dependencies mirror, and the `links` param. It does NOT gate positional membership
      // (mintPositional runs outside the block). The earlier form of this test asserted
      // `outEdges(id) == []` — a property the flag does not have, which held only because
      // this fixture runs unpositioned (a latent false green). The divergence case below
      // pins the other side.
      const cfg = await import('../config/tagEdgeConfig.js');
      const original = cfg.TASK_EDGE_MINT_CONFIG.enabled;
      expect(original, 'default is ON — the point of the work').toBe(true);
      try {
        (cfg.TASK_EDGE_MINT_CONFIG as { enabled: boolean }).enabled = false;

        const { id, resp } = await createTask({
          title: 'task created with minting DISABLED',
          type: 'feature',
          tags: [`decision:${id8(anchorDecision)}`],
          dependencies: [id8(anchorTask)],
          // All THREE gated sources must be fed, or their assertions below are vacuous —
          // without a links input, `mintedBySource.links === 0` proves nothing and a
          // narrowing that un-gates only mintExplicitLinks would slip past (Reviewer
          // round-1 nit on this test).
          links: [{ decision: id8(anchorDecision) }],
        });

        // The gated sources are silent — asserted per source, on the DB rows' provenance
        // stamps, not as "no edges at all".
        const rows = await outEdges(id);
        const gatedCreatedBy = [
          TASK_EDGE_CREATED_BY.taskTags,
          TASK_EDGE_CREATED_BY.taskDeps,
          'links:task_create',
        ];
        expect(
          rows.filter((r) => gatedCreatedBy.includes(r.created_by)),
          'kill switch OFF: no tag-minted, dependency-minted, or links-minted edges',
        ).toEqual([]);
        expect(resp.structuredContent.task.mintedBySource.tags).toBe(0);
        expect(resp.structuredContent.task.mintedBySource.dependencies).toBe(0);
        expect(resp.structuredContent.task.mintedBySource.links).toBe(0);
        // The write itself is completely unaffected: the task exists, with its column data.
        expect(resp.isError).not.toBe(true);
        expect(resp.structuredContent.task.dependencies?.length).toBe(1);
        // ...and the READ-BACK reports the effective value while it is flipped, so an
        // operator can tell "switched off" from "minting and erroring".
        const status = await viaTool('mandrel_status', {});
        expect(status.structuredContent.featureFlags.taskEdgeMint).toBe(false);
        expect(status.content.map((c: any) => c.text).join('\n')).toContain(
          `task-edge minting (tags/deps/links on task writes): OFF (${TASK_EDGE_MINT_ENV_FLAG})`,
        );
      } finally {
        (cfg.TASK_EDGE_MINT_CONFIG as { enabled: boolean }).enabled = original;
      }
    });

    test('OFF + positioned session → positional MEMBERSHIP still mints (the divergence the old title hid)', async () => {
      // The smallest input where "gates the task sources" and "mints NOTHING" diverge:
      // the flag OFF while the session stands on a branch. Position is a DECLARATION and
      // is deliberately outside the kill switch's blast radius — flipping the switch
      // mid-incident must not also sever positional membership.
      //
      // The spine is a DECISION on purpose: this test asserts on MEMBERSHIP (`informs`)
      // only, keeping it independent of task-spine structural behaviour. (Position no
      // longer mints `subtask_of` at all — ef51d3df; only the declared parentTaskId does.)
      const cfg = await import('../config/tagEdgeConfig.js');
      const original = cfg.TASK_EDGE_MINT_CONFIG.enabled;
      try {
        (cfg.TASK_EDGE_MINT_CONFIG as { enabled: boolean }).enabled = false;
        await viaTool('branch_open', { id: id8(anchorDecision) });

        const { id, resp } = await createTask({
          title: 'task created mid-branch with minting DISABLED',
          type: 'feature',
          tags: [`decision:${id8(anchorDecision)}`],
        });

        const rows = await outEdges(id);
        // The gated source stayed silent even though the tag names the very spine...
        expect(resp.structuredContent.task.mintedBySource.tags).toBe(0);
        expect(
          rows.filter((r) => r.created_by === TASK_EDGE_CREATED_BY.taskTags),
          'tag minting is OFF',
        ).toEqual([]);
        // ...and the positional membership edge minted anyway.
        const membership = rows.filter(
          (r) => r.created_by === 'auto:positional' && r.edge_type === 'informs' && r.to_id === anchorDecision,
        );
        expect(
          membership.length,
          'positional membership is NOT governed by the kill switch',
        ).toBeGreaterThan(0);
        expect(resp.structuredContent.task.mintedBySource.positional).toBeGreaterThan(0);
      } finally {
        (cfg.TASK_EDGE_MINT_CONFIG as { enabled: boolean }).enabled = original;
        await routeExecutor('branch_close', {}, { connectionId: CONN });
      }
    });

    test('the switch gates ONLY task sources — context_store still mints with it OFF', async () => {
      // A kill switch that also disabled pre-existing behaviour would be a footgun: flipping
      // it during an incident would silently turn off the graph everywhere else too.
      const cfg = await import('../config/tagEdgeConfig.js');
      const original = cfg.TASK_EDGE_MINT_CONFIG.enabled;
      try {
        (cfg.TASK_EDGE_MINT_CONFIG as { enabled: boolean }).enabled = false;
        const ctx = await viaTool('context_store', {
          content: 'context stored while task minting is disabled',
          type: 'planning',
          tags: [`decision:${id8(anchorDecision)}`],
        });
        const ctxId = ctx.structuredContent.context.id;
        const rows = await outEdges(ctxId);
        expect(
          rows.some((r) => r.to_id === anchorDecision && r.edge_type === 'decided_by'),
          'context_store minting is UNAFFECTED by the task kill switch',
        ).toBe(true);
      } finally {
        (cfg.TASK_EDGE_MINT_CONFIG as { enabled: boolean }).enabled = original;
      }
    });
  });

  // ── THE SWITCH CAN ACTUALLY BE PULLED, AND READS BACK ──────
  describe('the kill switch spelling matrix + read-back', () => {
    // Mirrors the declaredLimbs kill-switch suite: a switch is only a switch if the
    // spellings a human actually types mid-incident all pull it. Asserted against the
    // PARSER the config reads, not by reloading the config module (vi.resetModules()
    // breaks the shared fork's database pool — measured there, inherited here).
    test.each(['false', 'FALSE', 'False', '0', 'off', 'OFF', 'no', ' false '])(
      `${TASK_EDGE_MINT_ENV_FLAG}=%j turns it OFF`,
      (raw) => {
        expect(parseBooleanFlag(raw, true)).toBe(false);
      }
    );

    test.each(['true', 'TRUE', '1', 'on', 'yes', ' TRUE '])('%j turns it ON', (raw) => {
      expect(parseBooleanFlag(raw, false)).toBe(true);
    });

    test('unset, empty and garbage fall back to the default — in BOTH directions', () => {
      for (const raw of [undefined, '', 'maybe']) {
        expect(parseBooleanFlag(raw, true)).toBe(true);
        expect(parseBooleanFlag(raw, false)).toBe(false);
      }
    });

    test('the live flag IS the parser applied to the env var — no second reading', () => {
      // Same reasoning as the declaredLimbs original: the in-process compare is vacuous
      // when the var is unset (both sides collapse to the fallback), so the only honest
      // proof that the env var reaches the live config is a child process with it set.
      const read = (env: Record<string, string>): string =>
        execFileSync(
          process.execPath,
          ['--import', 'tsx', '-e',
           "import('./src/config/tagEdgeConfig.ts').then(m => " +
           'process.stdout.write(String(m.TASK_EDGE_MINT_CONFIG.enabled)))'],
          { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf-8' },
        ).trim();

      // An OFF spelling must actually reach the config — the leg that catches deleted or
      // hardcoded wiring, and it cannot pass by coincidence with the default (true).
      expect(read({ [TASK_EDGE_MINT_ENV_FLAG]: 'off' })).toBe('false');
      // ...and an ON spelling must too, so a config hardcoded to `false` fails as well.
      expect(read({ [TASK_EDGE_MINT_ENV_FLAG]: 'yes' })).toBe('true');
      // Garbage falls back to the documented default (true) rather than to `false`.
      expect(read({ [TASK_EDGE_MINT_ENV_FLAG]: 'maybe' })).toBe('true');
    });

    test('the read-back string states the EFFECTIVE value and names the env var', async () => {
      const cfg = await import('../config/tagEdgeConfig.js');
      expect(taskEdgeMintFlagSummary()).toContain(
        cfg.TASK_EDGE_MINT_CONFIG.enabled ? 'ON' : 'OFF'
      );
      expect(taskEdgeMintFlagSummary()).toContain(TASK_EDGE_MINT_ENV_FLAG);
    });

    test('mandrel_status carries the flag under featureFlags AND in the text block', async () => {
      const status = await viaTool('mandrel_status', {});
      const cfg = await import('../config/tagEdgeConfig.js');
      expect(status.structuredContent.featureFlags.taskEdgeMint).toBe(
        cfg.TASK_EDGE_MINT_CONFIG.enabled
      );
      expect(status.content.map((c: any) => c.text).join('\n')).toContain(
        taskEdgeMintFlagSummary()
      );
    });
  });

  // ── UPDATE: ADDITIVE re-mint; removal removes NOTHING ──────────────────────
  describe('task_update re-mints additively (tag removal removes no edges)', () => {
    test('adding a tag on update mints the new edge', async () => {
      const { id } = await createTask({ title: 'update: add a tag', type: 'feature' });
      expect(await outEdges(id)).toEqual([]);

      await viaTool('task_update', {
        taskId: id8(id),
        tags: [`decision:${id8(anchorDecision)}`],
      });

      const rows = await outEdges(id);
      expect(rows.some((r) => r.to_id === anchorDecision && r.edge_type === 'decided_by')).toBe(true);
    });

    test('REMOVING a tag removes ZERO edges (the graph is append-mostly history)', async () => {
      const { id } = await createTask({
        title: 'update: remove a tag',
        type: 'feature',
        tags: [`decision:${id8(anchorDecision)}`],
      });
      const before = await outEdges(id);
      expect(before.length).toBe(1);

      // Replace the tag set with one that no longer mentions the decision.
      await viaTool('task_update', { taskId: id8(id), tags: ['scope:mcp'] });

      const after = await outEdges(id);
      // Auto-delete is REJECTED by design: task_update REPLACES the tag set, so a partial
      // or typo'd edit would silently destroy graph history. Deeper: edges dedup on
      // (from,to,type) with a SINGLE-VALUED created_by, so one edge can be owed to a tag AND
      // a links param AND the anchor at once — on removal you cannot know it is not still
      // justified elsewhere. Attribution is structurally impossible under this schema, so
      // the honest behaviour is to keep the edge. Repair path is an explicit `unlink`.
      expect(after.length, 'tag removal removes no edges').toBe(1);
      expect(after[0].to_id).toBe(anchorDecision);
    });

    test('re-adding the same tag DEDUPS (no duplicate edge)', async () => {
      const { id } = await createTask({
        title: 'update: re-add the same tag',
        type: 'feature',
        tags: [`decision:${id8(anchorDecision)}`],
      });
      await viaTool('task_update', {
        taskId: id8(id),
        tags: [`decision:${id8(anchorDecision)}`],
      });
      const rows = await outEdges(id);
      expect(rows.filter((r) => r.edge_type === 'decided_by').length).toBe(1);
    });
  });
});
