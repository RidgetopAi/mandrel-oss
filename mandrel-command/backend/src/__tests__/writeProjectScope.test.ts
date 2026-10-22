/**
 * WRITE PROJECT SCOPE — the Command-backend half of an earlier task.
 * (Reviewer B2: acceptance criterion 2 shipped with ZERO tests. A repo-wide sweep for
 * `requireWriteProjectId|MissingWriteProjectScopeError|requestProjectScope` returned only
 * product code — and this change converts previously-SUCCEEDING user requests into 400s
 * whenever the SPA has no project selected. New user-visible behaviour, unverified.)
 *
 * THE DEFECT: `services/mcp.ts` sends `X-Actor-ID` but no `X-Connection-ID`, so every call
 * that names no project resolved through the MCP server's ONE shared, sticky,
 * last-writer-wins `http-default` slot. Three write sites named no project.
 *
 * WHAT IS ASSERTED, per write site, driving the controller directly with `McpService.callTool`
 * spied (no DB, no live MCP — the same seam decisionProjectScope.test.ts uses):
 *   1. header present            → the id is forwarded as the tool's `projectId` arg
 *   2. header absent             → 400 + MissingWriteProjectScopeError, and NO tool call
 *   3. body-only `projectId`     → honoured (the documented second source)
 *   4. empty / whitespace-only   → 400 — the value that slips through a truthiness check
 *                                  (`req.projectId || req.body.projectId` accepted '' as
 *                                  "absent" and then passed `undefined` on; `'   '` would
 *                                  have passed a bare `typeof === 'string'` check)
 *
 * Case 2 is the one that FAILS against the pre-fix controllers: they called the tool with
 * `projectId: undefined` and returned 201.
 *
 * ── UPDATED FOR an earlier TASK ────────────────────────────────────────────────────────
 * `requireWriteProjectId` no longer reads `req.body.projectId` itself — that raw read was
 * the un-authorized door. It now reads the scope that projectContextMiddleware resolved
 * AND AUTHORIZED (services/projectScopeResolver.ts). So these tests build their requests
 * through the REAL resolver (`resolveScopeForTest` below) instead of hand-setting
 * `req.projectId`; the precedence assertions are therefore assertions about the shipping
 * rule, not about a fixture. Project ids are now real uuids because the resolver rejects
 * anything else with a 400 — which is itself new, correct behaviour.
 */
import { DecisionController } from '../controllers/decision';
import { ContextController } from '../controllers/context';
import { McpService } from '../services/mcp';
import { MissingWriteProjectScopeError, requireWriteProjectId } from '../services/requestProjectScope';
import {
  extractProjectCandidates,
  ProjectScopeNotResolvedError,
} from '../services/projectScopeResolver';

const HEADER_PROJECT = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const BODY_PROJECT = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';

/**
 * Attach the scope the way projectContextMiddleware would, using the REAL extractor so
 * the source precedence under test is the shipping one. Authorization is deliberately not
 * exercised here — that is projectScopeEnforcement.test.ts's population.
 */
function resolveScopeForTest(req: any): any {
  const extracted = extractProjectCandidates(req);
  if (!extracted.ok) throw new Error('fixture produced a 400: ' + extracted.failure.message);
  const winner = extracted.candidates[0];
  req.projectScope = {
    projectId: winner && winner.kind === 'project' ? winner.value : undefined,
    explicitlyUnscoped: !!winner && winner.kind === 'unscoped',
    sourceKey: winner?.sourceKey,
    authorizedProjectIds: extracted.candidates
      .filter((c) => c.kind === 'project')
      .map((c) => c.value!),
  };
  req.projectId = req.projectScope.projectId;
  return req;
}

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

function spyCallTool() {
  return jest
    .spyOn(McpService, 'callTool')
    .mockResolvedValue({ success: true, data: {} } as any);
}

/**
 * The three guarded write sites, each with the minimum valid body its controller demands
 * (so a 400 we observe is the SCOPE guard, never a missing-field validation).
 */
const WRITE_SITES: ReadonlyArray<{
  tool: string;
  label: string;
  invoke: (req: any, res: any) => Promise<void>;
  baseReq: () => any;
}> = [
  {
    tool: 'decision_record',
    label: 'POST /api/decisions (controllers/decision.ts recordDecision)',
    invoke: (req, res) => DecisionController.recordDecision(req, res),
    baseReq: () => ({ body: { title: 't', problem: 'p', decision: 'd' }, params: {}, query: {}, headers: {} }),
  },
  {
    tool: 'decision_update',
    label: 'PUT /api/decisions/:id (controllers/decision.ts updateDecision)',
    invoke: (req, res) => DecisionController.updateDecision(req, res),
    baseReq: () => ({ body: { status: 'active' }, params: { id: 'dec-1' }, query: {}, headers: {} }),
  },
  {
    tool: 'context_store',
    label: 'POST /api/contexts (controllers/context.ts createContext)',
    invoke: (req, res) => ContextController.createContext(req, res),
    baseReq: () => ({ body: { content: 'hello' }, params: {}, query: {}, headers: {} }),
  },
];

describe.each(WRITE_SITES)('$tool — a write must name its project ($label)', ({ tool, invoke, baseReq }) => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards the X-Project-ID header as the tool `projectId` arg', async () => {
    const spy = spyCallTool();
    const base = baseReq();
    const req = resolveScopeForTest({ ...base, headers: { 'x-project-id': HEADER_PROJECT } });
    const res = mockRes();

    await invoke(req, res);

    const call = spy.mock.calls.find(([name]) => name === tool);
    expect(call).toBeDefined();
    expect((call![1] as { projectId?: string }).projectId).toBe(HEADER_PROJECT);
    expect(res.statusCode).toBeLessThan(400);
  });

  it('the header WINS over a body projectId (documented precedence)', async () => {
    const spy = spyCallTool();
    const base = baseReq();
    const req = resolveScopeForTest({
      ...base,
      headers: { 'x-project-id': HEADER_PROJECT },
      body: { ...base.body, projectId: BODY_PROJECT },
    });
    const res = mockRes();

    await invoke(req, res);

    const call = spy.mock.calls.find(([name]) => name === tool);
    expect((call![1] as { projectId?: string }).projectId).toBe(HEADER_PROJECT);
  });

  it('REFUSES with 400 when the request names no project — and calls no tool at all', async () => {
    const spy = spyCallTool();
    const req = resolveScopeForTest(baseReq()); // no projectId anywhere
    const res = mockRes();

    await invoke(req, res);

    expect(res.statusCode).toBe(400);
    // The message is the contract the SPA shows the user: it must name the remedy.
    expect(String(res.body?.message)).toContain('X-Project-ID');
    expect(res.body?.success).toBe(false);
    // The ambient write must not have happened at all — a 400 AFTER the tool call would
    // still have written into the shared slot.
    expect(spy.mock.calls.find(([name]) => name === tool)).toBeUndefined();
  });

  it('honours a body-only projectId (the documented second source)', async () => {
    const spy = spyCallTool();
    const base = baseReq();
    const req = resolveScopeForTest({ ...base, body: { ...base.body, projectId: BODY_PROJECT } });
    const res = mockRes();

    await invoke(req, res);

    const call = spy.mock.calls.find(([name]) => name === tool);
    expect(call).toBeDefined();
    expect((call![1] as { projectId?: string }).projectId).toBe(BODY_PROJECT);
  });

  it.each(['', '   ', '\t\n'])(
    'REFUSES with 400 on a present-but-empty projectId (%j) — the truthiness/typeof gap',
    async (blank) => {
      const spy = spyCallTool();
      const req = resolveScopeForTest({ ...baseReq(), headers: { 'x-project-id': blank } });
      const res = mockRes();

      await invoke(req, res);

      expect(res.statusCode).toBe(400);
      expect(spy.mock.calls.find(([name]) => name === tool)).toBeUndefined();
    }
  );
});

describe('requireWriteProjectId — reads the RESOLVED scope, never the raw request', () => {
  const scoped = (projectId?: string) => ({
    projectScope: {
      projectId,
      explicitlyUnscoped: projectId === undefined,
      authorizedProjectIds: projectId ? [projectId] : [],
    },
  });

  it('returns the authorized, resolved project', () => {
    expect(requireWriteProjectId(scoped(HEADER_PROJECT) as any, 'x')).toBe(HEADER_PROJECT);
  });

  it.each([
    ['resolved but unscoped', scoped(undefined)],
    ['empty string', { projectScope: { projectId: '', explicitlyUnscoped: false, authorizedProjectIds: [] } }],
    ['whitespace only', { projectScope: { projectId: '   ', explicitlyUnscoped: false, authorizedProjectIds: [] } }],
  ])('throws MissingWriteProjectScopeError — %s', (_label, req) => {
    expect(() => requireWriteProjectId(req as any, 'store a context')).toThrow(
      MissingWriteProjectScopeError
    );
  });

  it('THROWS LOUDLY (not "no project") when the middleware never ran', () => {
    // The regression this pins: if the scope is missing, the honest answer is a 500, not
    // `undefined` quietly read as "unscoped". A raw body read is what made that silent.
    expect(() => requireWriteProjectId({} as any, 'store a context')).toThrow(
      ProjectScopeNotResolvedError
    );
  });

  it('IGNORES a raw body projectId that never passed the resolver', () => {
    // The defect in one assertion: a body field alone must buy nothing.
    expect(() =>
      requireWriteProjectId({ projectScope: { explicitlyUnscoped: false, authorizedProjectIds: [] }, body: { projectId: BODY_PROJECT } } as any, 'x')
    ).toThrow(MissingWriteProjectScopeError);
  });

  it('names the operation in the message so the 400 is actionable', () => {
    try {
      requireWriteProjectId(scoped(undefined) as any, 'record a decision');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingWriteProjectScopeError);
      expect((e as Error).message).toContain('record a decision');
      expect((e as Error).message).toContain('X-Project-ID');
    }
  });
});
