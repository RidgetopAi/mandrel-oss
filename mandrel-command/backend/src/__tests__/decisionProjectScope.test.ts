/**
 * Guard test: GET /api/decisions and /api/decisions/stats SCOPE by the
 * active project WITHOUT mutating shared MCP session state. This is the whole-class sibling
 * of the Contexts scope fix (commit 8fb17f2): the request's project scope is forwarded as
 * the MCP tool's camelCase `projectId` arg — NEVER via a project_switch side-effect on a GET.
 *
 * ── PRECEDENCE INVERTED BY an earlier TASK (a real, deliberate behaviour change) ────────
 * This suite used to pin "the X-Project-ID HEADER wins over the ?project_id query param",
 * which is what controllers/decision.ts implemented (`req.projectId || req.query.project_id`).
 * controllers/daySummary.ts and controllers/momentumSeries.ts implemented the OPPOSITE, and
 * the frontend documents THEIRS as load-bearing. It is: `src/services/api.ts:80` attaches
 * `X-Project-ID` from localStorage to any call that did not set it, so a Calendar request for
 * `?project=all` DOES carry a disagreeing header, and header-wins would silently re-scope it.
 * Two precedences in one codebase is the drift; the resolver picks ONE — QUERY BEATS HEADER,
 * documented in services/projectScopeResolver.ts — and this suite now pins that one.
 *
 * No live frontend call is affected: the only client that sends BOTH sends the same uuid in
 * each (frontend/src/api/domains/{daySummary,momentumSeries}.ts, dashboardApi.ts:102).
 *
 * We spy on McpService.callTool (the single proxy seam) and assert:
 *   1. searchDecisions forwards `projectId` into the decision_search args,
 *   2. searchDecisions NEVER calls project_switch (the deleted landmine),
 *   3. the query param wins over the header (the ONE documented precedence),
 *   4. getDecisionStats forwards the camelCase `projectId` (not the dead snake_case).
 * No DB / no live MCP required. These fail against the pre-fix controller (which
 * project_switch'd on a GET and dropped the id / used the wrong param name for stats).
 */
import { DecisionController } from '../controllers/decision';
import { McpService } from '../services/mcp';
import { attachResolvedScope, TEST_PROJECT_A, TEST_PROJECT_B } from './helpers/projectScope';

function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: unknown) => {
    res.body = payload;
    return res;
  });
  return res;
}

describe('GET /api/decisions — project scoping (no project_switch side-effect)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards req.projectId (from the X-Project-ID header) into the decision_search args', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { results: [], total: 0 } });

    const req: any = attachResolvedScope({ headers: { 'x-project-id': TEST_PROJECT_A }, query: {} });
    const res = mockRes();

    await DecisionController.searchDecisions(req, res);

    expect(res.statusCode).toBe(200);

    const searchCall = spy.mock.calls.find(([tool]) => tool === 'decision_search');
    expect(searchCall).toBeDefined();
    expect((searchCall![1] as { projectId?: string }).projectId).toBe(TEST_PROJECT_A);
  });

  it('NEVER issues a project_switch on a search (a GET must not mutate session state)', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { results: [], total: 0 } });

    const req: any = attachResolvedScope({
      headers: { 'x-project-id': TEST_PROJECT_A },
      query: { project_id: TEST_PROJECT_B },
    });
    const res = mockRes();

    await DecisionController.searchDecisions(req, res);

    const switchCall = spy.mock.calls.find(([tool]) => tool === 'project_switch');
    expect(switchCall).toBeUndefined();
  });

  it('lets the ?project_id query param win over the X-Project-ID header', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { results: [], total: 0 } });

    const req: any = attachResolvedScope({
      headers: { 'x-project-id': TEST_PROJECT_A },
      query: { project_id: TEST_PROJECT_B },
    });
    const res = mockRes();

    await DecisionController.searchDecisions(req, res);

    const searchCall = spy.mock.calls.find(([tool]) => tool === 'decision_search');
    expect((searchCall![1] as { projectId?: string }).projectId).toBe(TEST_PROJECT_B);
  });

  it('falls back to the ?project_id query param when no header is present', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { results: [], total: 0 } });

    const req: any = attachResolvedScope({ headers: {}, query: { project_id: TEST_PROJECT_B } });
    const res = mockRes();

    await DecisionController.searchDecisions(req, res);

    const searchCall = spy.mock.calls.find(([tool]) => tool === 'decision_search');
    expect((searchCall![1] as { projectId?: string }).projectId).toBe(TEST_PROJECT_B);
  });

  it('omits projectId entirely when neither header nor query scope is present (Mandrel-wide)', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { results: [], total: 0 } });

    const req: any = attachResolvedScope({ headers: {}, query: {} });
    const res = mockRes();

    await DecisionController.searchDecisions(req, res);

    const searchCall = spy.mock.calls.find(([tool]) => tool === 'decision_search');
    expect('projectId' in (searchCall![1] as object)).toBe(false);
  });
});

describe('GET /api/decisions/stats — project scoping (camelCase MCP param)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards req.projectId as the camelCase `projectId` decision_stats arg', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { total_decisions: 0 } });

    const req: any = attachResolvedScope({ headers: { 'x-project-id': TEST_PROJECT_A }, query: {} });
    const res = mockRes();

    await DecisionController.getDecisionStats(req, res);

    const statsCall = spy.mock.calls.find(([tool]) => tool === 'decision_stats');
    expect(statsCall).toBeDefined();
    const args = statsCall![1] as Record<string, unknown>;
    expect(args.projectId).toBe(TEST_PROJECT_A);
    // The dead snake_case param must NOT be sent (the tool never read it).
    expect('project_id' in args).toBe(false);
  });
});
