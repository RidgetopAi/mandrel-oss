/**
 * mcpProxy — RAW passthrough transport for the authenticated /api/mcp route family
 * (the hosted UI's tool calls ride THROUGH this backend instead of
 * hitting the mcp-server's /mcp/tools/* surface from the browser).
 *
 * ── WHY A SEPARATE FILE FROM services/mcp.ts ─────────────────────────────────────────
 * Two reasons, both deliberate:
 *   1. DIFFERENT CONTRACT. McpService.callTool PARSES: it unwraps result/data/
 *      structuredContent and regex-parses legacy prose tools — the shape its REST
 *      controllers depend on. The passthrough must NOT parse: the browser client
 *      (mandrelApiClient.ts) consumes the mcp-server's envelope ({success, result})
 *      verbatim, so this transport forwards status + body byte-for-byte.
 *   2. MERGE SEAM. services/mcp.ts is concurrently owned by the structured-channel
 *      branch — this file introduces NO edit there. It reuses the PUBLIC
 *      McpService.authHeader() (one token source, no drifting copies) but re-derives
 *      the target host/port locally because resolveMcpTarget() is private.
 *      >>> SEAM FOR COORDINATOR AT MERGE: if the text-scrape removal makes resolveMcpTarget public,
 *      >>> delete resolveTarget() below and call it instead.
 *
 * ── WHAT IT ADDS TO EVERY FORWARDED REQUEST ──────────────────────────────────────────
 *   - Authorization: Bearer <MCP_AUTH_TOKEN>  (the INTERNAL service token — the browser
 *     never sees it; its own credential is the login JWT, spent at authenticateToken)
 *   - X-Actor-ID: <username>                  (attribution of the human who clicked)
 *   - X-Mandrel-Project: <projectId>          (an earlier task — the AUTHORIZED project
 *     scope the route resolved for this call; the mcp-server's rung-1 authoritative
 *     binding, so a ref-less tool call can no longer fall to the shared header-less
 *     connection slot. Omitted only for tools the route classified 'global'.)
 * It deliberately sends NO X-Connection-ID: the callerIdentityGuard's G3 is read-blind,
 * and the /api/mcp surface is restricted to registered READ tools (mcpReadAllowlist),
 * so no forwarded call is in the guard's rejectable population — and a BOUND call does
 * not consult the connection slot at all.
 */

import http from 'http';
import { logger } from '../config/logger';
import { McpService } from './mcp';

export interface RawMcpResponse {
  /** Upstream HTTP status, forwarded as-is. */
  status: number;
  /** Upstream body, forwarded verbatim (JSON text). */
  body: string;
  contentType: string;
}

const REQUEST_TIMEOUT = 30000;

/**
 * The upstream project-binding header name (mcp-server: config/projectBindingConfig.ts
 * PROJECT_BINDING_HEADER). Stated as a constant so the name exists exactly once here.
 */
const PROJECT_BINDING_HEADER = 'X-Mandrel-Project';

/**
 * Local copy of McpService's private target resolution (see SEAM note in the header).
 * Prefers MANDREL_MCP_URL (containerized deploys; sibling service name), falls back to
 * localhost:MANDREL_MCP_PORT.
 */
function resolveTarget(): { hostname: string; port: number } {
  const url = process.env.MANDREL_MCP_URL || process.env.AIDIS_MCP_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return { hostname: parsed.hostname, port: parseInt(parsed.port, 10) || 8080 };
    } catch {
      logger.warn(`[mcpProxy] Invalid MANDREL_MCP_URL "${url}", falling back to host:port`);
    }
  }
  const port = parseInt(
    (process.env.MANDREL_MCP_PORT || process.env.AIDIS_MCP_PORT || '8080') as string,
    10
  ) || 8080;
  return { hostname: 'localhost', port };
}

function forward(
  method: 'GET' | 'POST',
  path: string,
  payload: string | null,
  actor?: string,
  boundProjectId?: string
): Promise<RawMcpResponse> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = resolveTarget();

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      ...(payload !== null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...McpService.authHeader(),
    };
    if (actor && actor.trim() !== '') {
      headers['X-Actor-ID'] = actor.trim();
    }
    if (boundProjectId && boundProjectId.trim() !== '') {
      headers[PROJECT_BINDING_HEADER] = boundProjectId.trim();
    }

    const req = http.request({ hostname, port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 502,
          body: data,
          contentType: res.headers['content-type'] || 'application/json',
        });
      });
    });

    req.on('error', (error: NodeJS.ErrnoException) => {
      logger.error(`[mcpProxy] connection error to ${hostname}:${port}${path}`, {
        code: error.code,
        message: error.message,
      });
      reject(new Error(`MCP upstream unreachable: ${error.code || error.message}`));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('MCP upstream timeout'));
    });
    req.setTimeout(REQUEST_TIMEOUT);

    if (payload !== null) req.write(payload);
    req.end();
  });
}

export class McpProxyService {
  /**
   * POST /mcp/tools/:toolName — body already validated/authorized by the route.
   * `boundProjectId` is the AUTHORIZED project this call is scoped to —
   * sent upstream as X-Mandrel-Project; undefined only for 'global' tools.
   */
  static forwardToolCall(
    toolName: string,
    body: unknown,
    actor?: string,
    boundProjectId?: string
  ): Promise<RawMcpResponse> {
    return forward(
      'POST',
      `/mcp/tools/${encodeURIComponent(toolName)}`,
      JSON.stringify(body ?? {}),
      actor,
      boundProjectId
    );
  }

  /** GET /mcp/tools — the tool list. */
  static forwardToolList(actor?: string): Promise<RawMcpResponse> {
    return forward('GET', '/mcp/tools', null, actor);
  }

  /** GET /healthz — mcp-server liveness, for the UI health widget. */
  static forwardHealthz(): Promise<RawMcpResponse> {
    return forward('GET', '/healthz', null);
  }
}
