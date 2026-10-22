/**
 * A fake Mandrel speaking MCP over streamable HTTP, built on the SDK's own server transport.
 * `fetch` serves it in-process (hand it to MandrelBoard / boardFromConfig); `listen()` also puts it
 * behind a real HTTP port for socket-level tests. It records every request, enforces the bearer
 * token like the real server, and can forget its sessions (a restart) or never answer a call.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** The tools a gateway-surface Mandrel lists. */
export const GATEWAY_SURFACE = ['discover', 'context', 'task', 'decision', 'project', 'session', 'graph', 'recall_thread', 'smart_search', 'get_recommendations'];

export const FAKE_TOKEN = ['fake', 'mandrel', 'token'].join('-');

export interface ToolReply {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  text?: string;
}

export interface SeenCall {
  tool: string;
  args: Record<string, unknown>;
  headers: Headers;
  sessionId: string | null;
}

export interface SeenRequest {
  url: string;
  method: string;
  /** JSON-RPC method of a POST (`initialize`, `tools/call`, ...); null for GET/DELETE. */
  rpc: string | null;
  headers: Headers;
  status: number;
}

export interface FakeMandrelOptions {
  token?: string;
  tools?: string[];
  /** Answers a tools/call; a promise that never settles makes the call hang. */
  handle?: (call: SeenCall) => ToolReply | Promise<ToolReply>;
  /** Replaces the whole HTTP answer (e.g. a proxy's 405). */
  intercept?: (req: Request, body: string) => Response | undefined;
}

const jsonRpcError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class FakeMandrel {
  readonly calls: SeenCall[] = [];
  readonly requests: SeenRequest[] = [];
  initializes = 0;
  /** Live sessions by id. */
  readonly sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  private http?: HttpServer;

  constructor(readonly opts: FakeMandrelOptions = {}) {}

  /** Drops every session, as a restarted server does; the next request with an old id gets 404. */
  forgetSessions(): void {
    this.sessions.clear();
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const text = req.method === 'POST' ? await req.clone().text() : '';
    const body = (() => {
      try {
        return JSON.parse(text) as { method?: string };
      } catch {
        return null;
      }
    })();
    const res = await this.serve(req, text);
    this.requests.push({ url: req.url, method: req.method, rpc: body?.method ?? null, headers: req.headers, status: res.status });
    return res;
  }) as typeof fetch;

  private async serve(req: Request, text: string): Promise<Response> {
    const intercepted = this.opts.intercept?.(req, text);
    if (intercepted) return intercepted;
    if (req.headers.get('authorization') !== `Bearer ${this.opts.token ?? FAKE_TOKEN}`) {
      return new Response(JSON.stringify({ error: 'unauthorized', error_description: 'Missing or invalid bearer token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (req.method === 'GET') return new Response(null, { status: 405 });
    const sid = req.headers.get('mcp-session-id');
    if (sid) {
      const t = this.sessions.get(sid);
      if (!t) return jsonRpcError(404, -32002, 'MCP session not found and could not be restored. Re-initialize the connection.');
      if (req.method === 'DELETE') this.sessions.delete(sid);
      return t.handleRequest(req);
    }
    const body = (await req.clone().json().catch(() => null)) as { method?: string } | null;
    if (body?.method !== 'initialize') return jsonRpcError(400, -32600, 'no session ID provided for a non-initialize request');
    return this.newSession(req);
  }

  private async newSession(req: Request): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport);
        this.initializes++;
      },
    });
    const server = new Server({ name: 'fake-mandrel', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (this.opts.tools ?? GATEWAY_SURFACE).map((name) => ({ name, inputSchema: { type: 'object' as const } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const headers = new Headers(extra.requestInfo?.headers as Record<string, string> | undefined);
      const call: SeenCall = {
        tool: request.params.name,
        args: (request.params.arguments ?? {}) as Record<string, unknown>,
        headers,
        sessionId: extra.sessionId ?? null,
      };
      this.calls.push(call);
      const reply = (await this.opts.handle?.(call)) ?? {};
      return {
        content: [{ type: 'text' as const, text: reply.text ?? (reply.isError ? 'tool reported an error' : 'ok') }],
        ...(reply.structuredContent ? { structuredContent: reply.structuredContent } : {}),
        ...(reply.isError ? { isError: true } : {}),
      };
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  /**
   * Serves the fake on a real port. `destroyIf(rpc)` sees each POST's JSON-RPC method and may have
   * the socket destroyed instead of answered (return true).
   */
  async listen(destroyIf?: (rpc: string | null) => boolean): Promise<string> {
    this.http = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const rpc = body ? ((JSON.parse(body.toString('utf8')) as { method?: string }).method ?? null) : null;
        if (req.method === 'POST' && destroyIf?.(rpc)) return void req.socket.destroy();
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const answer = await this.fetch(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
        res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
        res.end(Buffer.from(await answer.arrayBuffer()));
      });
    });
    await new Promise<void>((r) => this.http!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.http) return;
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http!.close(() => r()));
  }
}

/** The url the in-process fake is addressed by (any url works with its `fetch`). */
export const FAKE_URL = 'http://fake-mandrel.test';

/** Answers gateway calls from a FakeBoard, the way a real Mandrel answers them from its database. */
export function boardBackedHandler(board: import('../../src/board/fake.js').FakeBoard) {
  return async (c: SeenCall): Promise<ToolReply> => {
    const { action, taskId, claimId, ...rest } = c.args as Record<string, unknown> & { action: string; taskId: string; claimId: string };
    const refusal = (r: { ok: false; reason: string; message?: string }): ToolReply => ({ isError: true, text: r.reason, structuredContent: { reason: r.reason, message: r.message } });
    switch (`${c.tool}.${action}`) {
      case 'project.list':
        return { structuredContent: { results: await board.listProjects() } };
      case 'task.list':
        return { structuredContent: { results: await board.listStage(rest.stage as never), hasMore: false } };
      case 'task.details': {
        const task = await board.get(taskId);
        return { structuredContent: task ? { found: true, task } : { found: false } };
      }
      case 'task.claim':
      case 'task.renew': {
        const r = action === 'claim' ? await board.claim(taskId, rest.allowedStatuses as string[] | undefined) : await board.renew(taskId, claimId);
        return { structuredContent: r.ok ? { claimed: true, claimId: r.claimId, expiresAt: r.expiresAt } : { claimed: false, reason: r.reason } };
      }
      case 'task.release': {
        const r = await board.release(taskId, claimId);
        return { structuredContent: r.ok ? { released: true } : { released: false, reason: r.reason } };
      }
      case 'task.update': {
        const r = await board.update(taskId, rest as never, claimId);
        return r.ok ? { structuredContent: { task: r.task } } : refusal(r);
      }
      case 'task.create':
        return { structuredContent: { task: await board.create(rest as never) } };
      default:
        return { isError: true, text: `Unknown tool: ${c.tool}` };
    }
  };
}
