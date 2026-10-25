/**
 * an earlier task — `DELETE /api/projects/:id` must not be a bare destroy.
 *
 * THE DEFECT. `ProjectService.deleteProject` was one line — `DELETE FROM projects
 * WHERE id = $1` — with no counts, no confirmation and no description of what was lost,
 * cascading into all twenty-four project-owned `ON DELETE CASCADE` tables. Measured
 * before the fix, on this same throwaway DB: a project owning a context + a task + a
 * decision went from `{project:1, contexts:1, tasks:1, decisions:1}` to all zeros on a
 * call with no confirmation argument (there was none to pass).
 *
 * ── WHY THIS TEST USES A REAL DATABASE ────────────────────────────────────────────────
 * The claim being guarded is a claim about DESTRUCTION, and the only honest observable
 * for "nothing was destroyed" is the rows still being there. A unit test with a mocked
 * pool could assert "we called the tool" and stay green while a raw `DELETE FROM
 * projects` sat right next to it — the exact shape of guard a past incident warns about
 * (a guard that agrees with the product without ever exercising it). So the assertion
 * here is a SIDE EFFECT read back out of Postgres, not a return value: a return value
 * can be right by luck, a surviving row cannot.
 *
 * ── THE HOSTILE CASE IS THE INTERESTING ONE ───────────────────────────────────────────
 * The strongest property this fix buys is not "it forwards `confirm`" — it is that this
 * service NO LONGER HAS THE POWER to destroy a project on its own. So the central case
 * drives the delete with the delegation FAILING (mcp-server unreachable, tool error) and
 * asserts the populated project and every child row are still present. If anyone ever
 * re-adds a local `pool.query('DELETE FROM projects …')` — as a "fallback" for exactly
 * this unreachable case, which is the plausible way this regresses — this test goes RED
 * on the rows, whatever the return value says.
 *
 * PROVISION FIRST (this creates + migrates the DB; --print-env alone does NOT migrate):
 *   bash scripts/provision-test-db.sh ci_projdel_accf37bb
 *   export $(bash scripts/provision-test-db.sh ci_projdel_accf37bb --print-env | grep ^DATABASE_)
 *   npm test -- projectDeleteDelegation
 *   bash scripts/provision-test-db.sh ci_projdel_accf37bb --drop
 *
 * Declared with `describeDb`, the ONE gate for a DB-backed suite: it
 * decides run-vs-skip AND injects the reachability assertion, so this suite cannot run
 * without a real Postgres and cannot pass by silently skipping. Adopted here on the merge
 * from main — this file originally hand-rolled the old skip idiom, which is now a RED.
 */

import { Pool } from 'pg';
import { v4 as uuid } from 'uuid';
import { ProjectService } from '../services/project';
import { McpService } from '../services/mcp';
import { describeDb, contractDbConfig } from './helpers/dbContractGate';

describeDb('ProjectService.deleteProject — the Command UI delete is gated, not bare', () => {
  let pool: Pool;
  let projectId: string;

  beforeAll(() => {
    // The SAME config the gate's reachability probe used — one source, so the suite
    // cannot end up asserting against a different database than the one it verified.
    pool = new Pool(contractDbConfig);
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * A POPULATED project — rows in three DIFFERENT cascading child tables, so an
   * accidental `DELETE FROM projects` is visible as data loss and not just a missing
   * parent row.
   */
  beforeEach(async () => {
    projectId = uuid();
    await pool.query(`INSERT INTO projects (id, name, description) VALUES ($1, $2, 'guard')`, [
      projectId,
      `accf37bb-victim-${projectId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO contexts (id, project_id, content, context_type)
       VALUES ($1, $2, 'guard context', 'code')`,
      [uuid(), projectId]
    );
    await pool.query(
      `INSERT INTO tasks (id, project_id, title, type, status, priority)
       VALUES ($1, $2, 'guard task', 'general', 'todo', 'medium')`,
      [uuid(), projectId]
    );
    await pool.query(
      `INSERT INTO technical_decisions
         (id, project_id, decision_type, title, description, rationale, impact_level)
       VALUES ($1, $2, 'architecture', 'guard decision', 'd', 'r', 'low')`,
      [uuid(), projectId]
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  /** What actually survives in the database — the only trustworthy observable here. */
  const survivors = async () => {
    const n = async (sql: string) => Number((await pool.query(sql, [projectId])).rows[0].n);
    return {
      project: await n('SELECT count(*)::int n FROM projects WHERE id = $1'),
      contexts: await n('SELECT count(*)::int n FROM contexts WHERE project_id = $1'),
      tasks: await n('SELECT count(*)::int n FROM tasks WHERE project_id = $1'),
      decisions: await n('SELECT count(*)::int n FROM technical_decisions WHERE project_id = $1'),
    };
  };

  it('POSITIVE CONTROL: the fixture really is populated (so a later "nothing destroyed" means something)', async () => {
    // Without this, every assertion below could pass against an empty project and the
    // suite would be vacuously green — the empty-population trap.
    expect(await survivors()).toEqual({ project: 1, contexts: 1, tasks: 1, decisions: 1 });
  });

  it('destroys NOTHING when the gate is unreachable — this service has no local delete left', async () => {
    // The plausible regression is a "fallback" raw DELETE for exactly this case. There
    // isn't one, and this is what proves it: the tool call fails, and the rows remain.
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: false, error: 'connect ECONNREFUSED 127.0.0.1:8080' }); // reserved-port-ok: error-message fixture, no connection is made

    await expect(ProjectService.deleteProject(projectId, true, 'coordinator')).rejects.toThrow(
      'Failed to delete project'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    // THE ASSERTION THAT MATTERS: a side effect that must NOT have happened.
    expect(await survivors()).toEqual({ project: 1, contexts: 1, tasks: 1, decisions: 1 });
  });

  it('destroys NOTHING on a refusal, and relays the gate\'s own counts + sentence', async () => {
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: {
        action: 'delete_refused',
        deleted: false,
        counts: { byTable: { contexts: 1, tasks: 1, technical_decisions: 1 }, total: 3, unmeasurable: [] },
        message:
          '⚠️  Refusing to delete project "victim" without confirmation.\n' +
          'Deleting it will CASCADE-DELETE 3 owned rows (1 contexts, 1 tasks, ' +
          '1 technical_decisions) across 24 project-owned cascading tables.',
      },
    });

    const outcome = await ProjectService.deleteProject(projectId, false, 'coordinator');

    expect(outcome.deleted).toBe(false);
    expect(outcome.impact).toEqual({
      byTable: { contexts: 1, tasks: 1, technical_decisions: 1 },
      total: 3,
      unmeasurable: [],
    });
    // The sentence is the GATE'S, relayed verbatim — not composed here from `impact`.
    // (A second renderer is the drift this whole fix exists to prevent.)
    expect(outcome.message).toContain('CASCADE-DELETE 3 owned rows');
    expect(await survivors()).toEqual({ project: 1, contexts: 1, tasks: 1, decisions: 1 });
  });

  it('relays the gate\'s refusal REASON, and whitelists it rather than passing it through', async () => {
    // The reason drives `requiresConfirmation` on the wire, so a value this client does not
    // understand must not flow into the response as if it did. Unknown → the retryable
    // reading, which is the conservative one (an un-actionable prompt beats a missing one).
    // DENY BY DEFAULT. Only a recognised reason is admitted; everything else becomes
    // 'unknown', which the controller reads as NOT retryable. The earlier version of this
    // whitelist fell back to 'needs_confirmation' and had a live victim: the
    // last-remaining-project refusal carried no reason, so it was reported as retryable
    // while `confirm=true` returned the identical refusal.
    const cases: Array<[unknown, string]> = [
      ['needs_confirmation', 'needs_confirmation'],
      ['active_project', 'active_project'],
      ['last_project', 'last_project'],
      [undefined, 'unknown'], // an older gate that sends none
      ['some_future_reason', 'unknown'], // a newer gate this client predates
      [{ nested: true }, 'unknown'], // not even a string
      ['', 'unknown'],
      [null, 'unknown'],
    ];

    for (const [sent, expected] of cases) {
      jest.spyOn(McpService, 'callTool').mockResolvedValue({
        success: true,
        data: {
          action: 'delete_refused',
          deleted: false,
          counts: { byTable: { contexts: 1 }, total: 1, unmeasurable: [] },
          message: 'refused',
          ...(sent === undefined ? {} : { reason: sent }),
        },
      });

      const outcome = await ProjectService.deleteProject(projectId, false, 'coordinator');
      expect(outcome.reason).toBe(expected);
      jest.restoreAllMocks();
    }

    expect(await survivors()).toEqual({ project: 1, contexts: 1, tasks: 1, decisions: 1 });
  });

  it('destroys NOTHING when the gate reports an UNMEASURABLE blast radius (fails closed)', async () => {
    // The zero/empty value that slips past a naive predicate: total 0 and an EMPTY
    // byTable, which a `total > 0` check would read as "nothing to lose, proceed".
    // The gate answers `delete_refused`, and this service must not second-guess it.
    jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: {
        action: 'delete_refused',
        deleted: false,
        counts: { byTable: {}, total: 0, unmeasurable: [] },
        message:
          '⚠️  Refusing to delete project "victim" without confirmation.\n' +
          'Deleting it will CASCADE-DELETE an UNKNOWN number of rows — no project-owned ' +
          'cascading table could be read from the schema, so what would be destroyed ' +
          'cannot be measured.',
      },
    });

    const outcome = await ProjectService.deleteProject(projectId, false, 'coordinator');

    expect(outcome.deleted).toBe(false);
    expect(outcome.message).toContain('UNKNOWN number of rows');
    expect(await survivors()).toEqual({ project: 1, contexts: 1, tasks: 1, decisions: 1 });
  });

  it('destroys NOTHING on an unrecognised payload — no confident outcome we cannot support', async () => {
    // e.g. the tool's "project not found" response, which carries only `{ok:true}`.
    jest.spyOn(McpService, 'callTool').mockResolvedValue({ success: true, data: { ok: true } });

    await expect(ProjectService.deleteProject(projectId, true, 'coordinator')).rejects.toThrow(
      'Failed to delete project'
    );
    expect(await survivors()).toEqual({ project: 1, contexts: 1, tasks: 1, decisions: 1 });
  });

  it('ANTI-VACUOUS: the rows are not simply undeletable — the same fixture CAN be destroyed', async () => {
    // Every case above asserts an absence of destruction. That family of assertions can be
    // satisfied for the wrong reason (a fixture in a rolled-back transaction, a
    // wrong-database pool, a project id that never existed), and would then stay green
    // even if the guard were gutted. This proves the observable can MOVE: the same rows,
    // read by the same helper, go to zero when something actually deletes them.
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    expect(await survivors()).toEqual({ project: 0, contexts: 0, tasks: 0, decisions: 0 });
  });

  it('forwards the caller\'s confirmation and actor to the gate, and never decides for itself', async () => {
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { action: 'deleted', deleted: true, project: { id: projectId } },
    });

    const outcome = await ProjectService.deleteProject(projectId, true, 'operator');

    expect(outcome.deleted).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, args, actor] = spy.mock.calls[0] as [string, any, string];
    expect(tool).toBe('project_delete');
    // `confirm` is RELAYED, never defaulted to true here — the caller's explicit intent is
    // the only thing that can confirm a destructive cascade.
    expect(args).toEqual({ project: projectId, confirm: true });
    expect(actor).toBe('operator');
  });

  it('relays an ABSENT confirmation as confirm:false — it never upgrades the caller\'s intent', async () => {
    const spy = jest.spyOn(McpService, 'callTool').mockResolvedValue({
      success: true,
      data: { action: 'delete_refused', deleted: false, counts: { byTable: {}, total: 0, unmeasurable: [] }, message: 'x' },
    });

    await ProjectService.deleteProject(projectId, false);

    const [, args, actor] = spy.mock.calls[0] as [string, any, string | undefined];
    expect(args).toEqual({ project: projectId, confirm: false });
    expect(actor).toBeUndefined();
  });
});
