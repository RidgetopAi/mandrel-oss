/**
 * mcpProxyBinding.test.ts — WIRE-LEVEL proof that the scope binding is real
 *. The route suites assert the binding at the McpProxyService seam
 * (a mock's 4th argument); a mock proves the ARGUMENT, not the REQUEST. This suite
 * runs the REAL McpProxyService.forwardToolCall against a live local capture server
 * and reads the headers the mcp-server would actually receive — the exact surface the
 * fix claims to change (C2: verify at the real surface).
 */
import http from 'http';
import { AddressInfo } from 'net';
import { McpProxyService } from '../services/mcpProxy';

interface Captured {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('McpProxyService.forwardToolCall — the outgoing request itself', () => {
  let server: http.Server;
  let captured: Captured;
  let priorUrl: string | undefined;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured = { method: req.method, url: req.url, headers: req.headers, body };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, result: { ok: true } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      priorUrl = process.env.MANDREL_MCP_URL;
      process.env.MANDREL_MCP_URL = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    if (priorUrl === undefined) delete process.env.MANDREL_MCP_URL;
    else process.env.MANDREL_MCP_URL = priorUrl;
    server.close(done);
  });

  it('a BOUND call carries X-Mandrel-Project with exactly the resolved project id', async () => {
    const out = await McpProxyService.forwardToolCall(
      'context_get_recent',
      { arguments: { limit: 2 } },
      'the-user',
      '11111111-2222-3333-4444-555555555555'
    );
    expect(out.status).toBe(200);
    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('/mcp/tools/context_get_recent');
    // THE claim under test: the binding is a real header on the wire, byte-exact.
    expect(captured.headers['x-mandrel-project']).toBe('11111111-2222-3333-4444-555555555555');
    expect(captured.headers['x-actor-id']).toBe('the-user');
    expect(JSON.parse(captured.body)).toEqual({ arguments: { limit: 2 } });
  });

  it('an UNBOUND call (global tool) sends NO X-Mandrel-Project header — absent, not blank', async () => {
    await McpProxyService.forwardToolCall('mandrel_ping', { arguments: {} }, 'the-user', undefined);
    expect('x-mandrel-project' in captured.headers).toBe(false);
  });

  it('a BLANK binding is treated as absent (the empty population never becomes a header)', async () => {
    await McpProxyService.forwardToolCall('mandrel_ping', { arguments: {} }, 'the-user', '   ');
    expect('x-mandrel-project' in captured.headers).toBe(false);
  });
});
