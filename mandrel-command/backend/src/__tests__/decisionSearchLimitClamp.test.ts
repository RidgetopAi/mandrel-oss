/**
 * Guard test (blue-tape FIX #8): GET /api/decisions clamps the `limit` it forwards to
 * the MCP `decision_search` tool to the tool's max (100). The tool schema-validates
 * `limit` at max 100 and 500s the whole request on anything higher — the P2 Decisions
 * screen historically requested 150, which produced a 500 on the Decisions page.
 *
 * We spy on McpService.callTool (the single proxy seam) and assert the `limit` that
 * reaches decision_search is CLAMPED — never forwarded raw — for any over-limit client.
 * No DB / no live MCP required.
 */
import { DecisionController } from '../controllers/decision';
import { McpService } from '../services/mcp';
import { searchConfig } from '../config/search';
// The controller reads its project scope via getRequestProjectId, which THROWS when the
// middleware never ran — so even a scope-irrelevant fixture must carry one.
import { attachResolvedScope } from './helpers/projectScope';

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

describe('GET /api/decisions — limit clamped to the MCP decision_search cap', () => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards the tool max (100) — not the raw 150 — when a client over-requests', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { results: [], total: 0 } });

    const req: any = attachResolvedScope({ headers: {}, query: { limit: '150' } });
    const res = mockRes();

    await DecisionController.searchDecisions(req, res);

    // Never 500 — the request degrades gracefully instead of erroring.
    expect(res.statusCode).toBe(200);

    const call = spy.mock.calls.find(([tool]) => tool === 'decision_search');
    expect(call).toBeDefined();
    const forwarded = (call![1] as { limit: number }).limit;
    expect(forwarded).toBe(searchConfig.decisionSearchMaxLimit); // 100
    expect(forwarded).toBeLessThanOrEqual(100);
  });

  it('passes a below-cap limit through unchanged', async () => {
    const spy = jest
      .spyOn(McpService, 'callTool')
      .mockResolvedValue({ success: true, data: { results: [], total: 0 } });

    const req: any = attachResolvedScope({ headers: {}, query: { limit: '25' } });
    const res = mockRes();

    await DecisionController.searchDecisions(req, res);

    const call = spy.mock.calls.find(([tool]) => tool === 'decision_search');
    expect((call![1] as { limit: number }).limit).toBe(25);
  });
});
