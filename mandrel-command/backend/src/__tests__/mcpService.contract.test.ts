import http from 'http';
import { McpService } from '../services/mcp';

describe('McpService contract interaction', () => { // db-gate-exempt: contract-NAMED but not DB-backed — drives a stub HTTP server for McpService; opens no connection (0 occurrences of Pool/Client/.query)
  let server: http.Server;
  let port: number;
  // resolveMcpTarget()'s FULL input surface, saved and restored. Pinning only the
  // deprecated AIDIS_MCP_PORT let a gitignored backend/.env (dotenv-loaded at import
  // by config/environment.ts) steer every request in this suite to its MANDREL_MCP_URL
  // — 13/13 red on any ref, on any box carrying a dev .env (measured 2026-08-14).
  const TARGET_VARS = ['MANDREL_MCP_URL', 'AIDIS_MCP_URL', 'MANDREL_MCP_PORT', 'AIDIS_MCP_PORT', 'AIDIS_MCP_HOST_PORT'] as const;
  const originalTarget: Partial<Record<(typeof TARGET_VARS)[number], string | undefined>> = {};

  // Queue of response handlers to run sequentially for each incoming request
  const handlers: Array<(req: http.IncomingMessage, res: http.ServerResponse) => void> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const handler = handlers.shift();
      if (handler) {
        handler(req, res);
      } else {
        res.statusCode = 500;
        res.end('No handler registered');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });

    const address = server.address();
    if (address && typeof address === 'object') {
      port = address.port;
    } else {
      throw new Error('Failed to obtain stub server port');
    }

    for (const v of TARGET_VARS) {
      originalTarget[v] = process.env[v];
      delete process.env[v];
    }
    process.env.MANDREL_MCP_URL = `http://localhost:${port}`;
  });

  afterAll(async () => {
    for (const v of TARGET_VARS) {
      if (originalTarget[v] === undefined) delete process.env[v];
      else process.env[v] = originalTarget[v];
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    handlers.length = 0;
  });

  it('interprets success envelopes and returns parsed data', async () => {
    handlers.push((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        // Ensure request body contains MCP arguments envelope
        expect(JSON.parse(body)).toEqual({ arguments: { message: 'contract regression' } });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            result: {
              content: [
                {
                  type: 'text',
                  text: '🏓 AIDIS Pong! Message: "contract regression" | Time: 2025-09-16T00:00:00Z | Status: Operational',
                },
              ],
            },
          }),
        );
      });
    });

    const result = await McpService.callTool('aidis_ping', { message: 'contract regression' });
    expect(result.success).toBe(true);
    expect(result.data).toContain('AIDIS Pong! Message');
  });

  it('reads the canonical structuredContent channel for context_search', async () => {
    // The bridge guarantees structuredContent on every response. context_search sets
    // structuredContent (rows) but NO legacy `data` sibling; makeRequest must return
    // the STRUCTURED rows, not scrape the prose text channel (the old lying path).
    const rows = { results: [{ id: 'abc', contextType: 'planning', content: 'body' }], total: 1 };
    handlers.push((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          result: {
            content: [{ type: 'text', text: '🔍 Found 1 matching contexts for: "x"' }],
            structuredContent: rows,
          },
        }),
      );
    });

    const result = await McpService.callTool('context_search', { query: 'x', projectId: 'p' });
    expect(result.success).toBe(true);
    // Structured rows returned — NOT the prose text.
    expect(result.data).toEqual(rows);
    expect(typeof result.data).not.toBe('string');
  });

  it('still prefers the legacy data sibling for write tools (context_store unchanged)', async () => {
    const stored = { id: 'ctx-1', contextType: 'discussion' };
    handlers.push((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          result: { data: stored, structuredContent: { ok: true, ...stored } },
        }),
      );
    });

    const result = await McpService.callTool('context_store', { content: 'hi' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(stored); // data sibling wins → no shape change
  });

  it('reads structuredContent for the former TEXT_PARSE_TOOLS — no regex parser runs', async () => {
    // The six bespoke text parsers (naming_* / decision_search / decision_stats /
    // project_insights) are DELETED. A former prose tool whose response carries
    // structuredContent and no `data` sibling must resolve the STRUCTURED fields;
    // the numbers in the rendered text must never be re-derived by regex. The prose
    // here deliberately DISAGREES with the structured fields (42 vs 7) so a
    // resurrected parser would be caught by value, not just by shape.
    const structured = { ok: true, total_decisions: 7, by_type: { process: 7 } };
    handlers.push((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          result: {
            content: [{ type: 'text', text: '📈 Total Decisions: 42' }],
            structuredContent: structured,
          },
        }),
      );
    });

    const result = await McpService.callTool('decision_stats', {});
    expect(result.success).toBe(true);
    expect(result.data).toEqual(structured);
  });

  it('returns a text-only legacy response VERBATIM — as an opaque string, never parsed', async () => {
    // A pre-dual-channel server (no structuredContent, no data): the prose passes
    // through untouched. If any parser were re-wired, result.data would become an
    // object here instead of the exact source string.
    const prose = 'Total Names: 42\nConvention Compliance: 88%';
    handlers.push((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          result: { content: [{ type: 'text', text: prose }] },
        }),
      );
    });

    const result = await McpService.callTool('naming_stats', {});
    expect(result.success).toBe(true);
    expect(result.data).toBe(prose);
  });

  it('propagates MCP error envelopes as failures', async () => {
    handlers.push((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'MCP validation failed: test error' }));
    });

    const result = await McpService.callTool('mandrel_ping', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MCP validation failed/);
  });

  // ── PAYLOAD FIRST, TRANSPORT STATUS SECOND ────────────────────────────────────
  // The mcp-server classifies a CLIENT error (strict-mode param rejection, and the
  // caller-identity refusals this backend is inside the population of — it sends no
  // X-Connection-ID) as a 4xx instead of the 200 it historically returned. That
  // classification is correct: a retrying client must not read a permanent refusal as
  // 5xx. But the refusal still carries a real CallToolResult under `result`, and this
  // service used to gate ALL parsing on `statusCode === 200` — so the status change
  // alone would have turned the tool's own answer into `HTTP 4xx: {"success":false,…}`,
  // the raw envelope stringified into an error message. Both stdio bridges have always
  // checked `result !== undefined` BEFORE the status; these pin that this one does too.
  it('surfaces the tool answer carried by a 4xx, not `HTTP <n>: <raw body>`', async () => {
    const prose =
      '❌ Error: [PROJECT_SCOPE_SWITCH_UNIDENTIFIED] This client sends no X-Connection-ID. ' +
      'Send one, or name projectId on the call.';
    handlers.push((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        result: { content: [{ type: 'text', text: prose }], isError: true },
      }));
    });

    const result = await McpService.callTool('project_switch', { project: 'riverbend' });
    expect(result.success).toBe(true);
    expect(result.data).toBe(prose);
    // The specific regression: the raw envelope must NOT be what the caller reads.
    expect(result.error).toBeUndefined();
    expect(String(result.data)).not.toMatch(/HTTP 400/);
  });

  it('yields the IDENTICAL value for one envelope at 200 and at 400 (the status is not a parse gate)', async () => {
    // The shape prod actually emits for an in-band refusal: routes/index.ts
    // ensureStructuredContent stamps `{ok:false}` onto formatMcpError's prose result.
    const envelope = {
      success: false,
      result: {
        content: [{ type: 'text', text: '❌ Error: actor required for a write' }],
        isError: true,
        structuredContent: { ok: false },
      },
    };
    const serve = (status: number) => (_req: any, res: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope));
    };

    handlers.push(serve(200));
    const at200 = await McpService.callTool('context_store', { content: 'x' });
    handlers.push(serve(400));
    const at400 = await McpService.callTool('context_store', { content: 'x' });

    expect(at400).toEqual(at200);
    expect(at400.data).toEqual({ ok: false });
  });

  it('still rejects a genuine transport/auth failure — `error` and NO `result` (fail closed)', async () => {
    handlers.push((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    });

    const result = await McpService.callTool('mandrel_ping', {});
    expect(result.success).toBe(false);
    // The status is the only signal left when no tool answer is present, so it is reported.
    expect(result.error).toMatch(/HTTP 401/);
  });

  it('still rejects a non-200 whose body is not JSON at all (a proxy/gateway page)', async () => {
    handlers.push((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>Bad Gateway</html>');
    });

    const result = await McpService.callTool('mandrel_ping', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 502/);
    expect(result.error).toMatch(/Bad Gateway/);
  });

  it('propagates HTTP error responses', async () => {
    handlers.push((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'SERVER DOWN' }));
    });

    const result = await McpService.callTool('mandrel_ping', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });

  // Sessions Foundation — human attribution. The general tool proxy
  // must forward the logged-in principal as X-Actor-ID so the mcp-server bridge
  // attributes the session to the human (instead of the flagged `anonymous`). The
  // stub server captures the inbound header — we assert the transport, not the code
  // under test (no lying mock).
  it('forwards X-Actor-ID when an actor is supplied', async () => {
    let seenActor: string | undefined | string[] = 'UNSET';
    handlers.push((req, res) => {
      seenActor = req.headers['x-actor-id'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { data: { id: 'ctx-1' } } }));
    });

    const result = await McpService.callTool('context_store', { content: 'hi' }, 'operator');
    expect(result.success).toBe(true);
    expect(seenActor).toBe('operator');
  });

  it('trims the actor before forwarding it', async () => {
    let seenActor: string | undefined | string[] = 'UNSET';
    handlers.push((req, res) => {
      seenActor = req.headers['x-actor-id'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { data: { id: 'ctx-1' } } }));
    });

    await McpService.callTool('context_store', { content: 'hi' }, '  operator  ');
    expect(seenActor).toBe('operator');
  });

  it('omits X-Actor-ID when the actor is absent or blank (pure agent / no-user path unchanged)', async () => {
    // No actor arg — the header must NOT be present, so a header-less agent call
    // through the proxy stays byte-identical to the pre-attribution behavior.
    let hadHeaderNoActor = true;
    handlers.push((req, res) => {
      hadHeaderNoActor = 'x-actor-id' in req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { data: { ok: true } } }));
    });
    await McpService.callTool('context_search', { query: 'x' });
    expect(hadHeaderNoActor).toBe(false);

    // A whitespace-only actor is treated as absent (same trim guard as the wired seam).
    let hadHeaderBlankActor = true;
    handlers.push((req, res) => {
      hadHeaderBlankActor = 'x-actor-id' in req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { data: { ok: true } } }));
    });
    await McpService.callTool('context_search', { query: 'x' }, '   ');
    expect(hadHeaderBlankActor).toBe(false);
  });

  // callMcpEndpoint (the SECOND proxy seam — project_switch / set-primary) must forward the
  // actor with the SAME guard as callTool, so the attribution class is whole.
  it('callMcpEndpoint forwards X-Actor-ID when an actor is supplied', async () => {
    let seenActor: string | undefined | string[] = 'UNSET';
    handlers.push((req, res) => {
      seenActor = req.headers['x-actor-id'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: {} }));
    });

    await McpService.callMcpEndpoint('/mcp/tools/project_switch', 'POST', { arguments: {} }, 'operator');
    expect(seenActor).toBe('operator');
  });

  it('callMcpEndpoint trims the actor before forwarding it', async () => {
    let seenActor: string | undefined | string[] = 'UNSET';
    handlers.push((req, res) => {
      seenActor = req.headers['x-actor-id'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: {} }));
    });

    await McpService.callMcpEndpoint('/mcp/tools/project_switch', 'POST', { arguments: {} }, '  operator  ');
    expect(seenActor).toBe('operator');
  });

  it('callMcpEndpoint omits X-Actor-ID when the actor is absent or blank', async () => {
    let hadHeaderNoActor = true;
    handlers.push((req, res) => {
      hadHeaderNoActor = 'x-actor-id' in req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: {} }));
    });
    await McpService.callMcpEndpoint('/mcp/tools/project_switch', 'POST', { arguments: {} });
    expect(hadHeaderNoActor).toBe(false);

    let hadHeaderBlankActor = true;
    handlers.push((req, res) => {
      hadHeaderBlankActor = 'x-actor-id' in req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: {} }));
    });
    await McpService.callMcpEndpoint('/mcp/tools/project_switch', 'POST', { arguments: {} }, '   ');
    expect(hadHeaderBlankActor).toBe(false);
  });
});